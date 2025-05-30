import express, { NextFunction, Response } from 'express'
import { validateBasketStock, authenticateUser, parseBasket } from '../utils/middlewear'
import { AuthenticatedRequest,  PopulatedBasket, ProcessedBasket, Basket } from '../types'
import Product from '../models/Product'
import mongoose from 'mongoose'
import Order from '../models/Order'
import paypalController from '../utils/paypalController'
import { processBasket, mapProcessedBasketItemsToOrderItems, validatePurchaseUnitsAgainstTempOrder, creatSessionAndHandleStockCleanup, createSessionAndReleaseStock, generateOrderNumber } from '../utils/helpers'
import TempOrder from '../models/TempOrder'
import BasketModel from '../models/Basket'
import { enqueueConfirmationEmail } from '../utils/taskQueues'

// Baseurl is /api/orders
const orderRouter = express.Router()

// Route for validating a basket for checkout, and re-calculating the total price
// Parses the basket to ensure each product exists and there are no duplicate items and then validates the stock
  // Validate stock middlewear returns the stock quantities that were invalid in error response
orderRouter.post('/checkout', parseBasket, validateBasketStock, async (req: AuthenticatedRequest<unknown, unknown, PopulatedBasket>, res: Response, _next: NextFunction) => {
  // Gets the parsed and populated basket from the request body
  const populatedBasket: PopulatedBasket = req.body

  let totalPrice = 0

  // for formatting the basket for the checkout
  const basketToReturn = populatedBasket.map(basketItem => {
    const { price, name, _id } = basketItem.product
    totalPrice += price * basketItem.quantity
    return {
      product: {
        price, name, id: _id
      },
      quantity: basketItem.quantity
    }
  })

  res.status(200).json({basket: basketToReturn, totalPrice})
})

// Called in the createOrder() callback of the paypal SDK
// Route for creating the paypal order and reserving the stock items in the basket in a tempOrder document
  // tempOrder created within a transaction alongside the stock reduction on the product documents
  // Ensures that tempOrder is a valid reservation of the stock
orderRouter.post('', authenticateUser, parseBasket, async (req: AuthenticatedRequest<unknown, unknown, Basket>, res: Response, _next: NextFunction) => {
  try {
    // Proccesses the basket for the paypal order
    // Throws an error if basket empty, any products not found, or if there is not enough stock on any of the product docs
    const processedBasket: ProcessedBasket = await processBasket(req.body)

    // Attempts to create the paypal order
    // Will throw error if failed to create order
    const { jsonResponse, httpStatusCode } = await paypalController.createOrder(processedBasket)
    const { id: paypalOrderId } = jsonResponse

    // Starts a session and transaction, within which to complete the stock updates and the processing order creation
    const session = await mongoose.startSession()
    session.startTransaction()
    
    // This try block is for performing the reservations and creating temporary order within a transaction
    try {
      // Operations to update the stock of the products
      const bulkOps = processedBasket.items.map(({ product, quantity }) => {
        return {
          updateOne: {
            filter: {_id : product.id, stock: {$gte: quantity}},
            update: {$inc: {stock: - quantity, reserved: quantity}}
          }
        }
      })

      // Writes the operations to mongodb within the transaction
      // ordered=true option inducates that the updates will operate in order, all terminate on the first error
      const bulkWriteOpResult = await Product.bulkWrite(bulkOps, {session: session, ordered: true})

      // Checks that all the updates occured before creating the temporder
      if (bulkWriteOpResult.modifiedCount !== processedBasket.items.length){
        throw new Error('Error reserving stock, not enough stock!')
      }
      
      // Creates an expiry time for the tempOrder (15 mins)
      // Ensures that if an error occurs, stock is not perminantly reserved
      const expiresAt = new Date(Date.now() - 1000 * 60 * 15)

      // Creates the temp order
      const tempOrder = new TempOrder({
        user: req.user?._id,
        items: mapProcessedBasketItemsToOrderItems(processedBasket),
        totalCost: {
          currencyCode: 'GBP',
          value: processedBasket.totalCost
        },
        paymentTransactionId: paypalOrderId,
        expiresAt  // Creates an expiry for 15 minutes time
      })

      await tempOrder.save({session})
      await session.commitTransaction()
      
      // Returns the jsonResponse, crucially including the orderNumber
      res.status(httpStatusCode).json({...jsonResponse, expiresAt})

    } catch (error){
      await session.abortTransaction()
      console.log('Transaction aborted')
      throw error
    } finally {
      await session.endSession()
    }

  } catch (error) {
    // Handles occurance of any errors throughout process
    let errorMessage = 'Error creating order: '
    if (error instanceof Error){
      errorMessage += error.message
    }
    console.error(errorMessage, error)
    res.status(500).json({error: errorMessage})
  }
})

// Route for creating the order, and if successful, capturing payment
// This route is called by the paypal SDK after the user has authorised payment
orderRouter.post('/capture/:orderID', authenticateUser, async (req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
  // This try block is responsible for validating order, capturing payment, and creating order
  try {
    // VALIDATES ORDER AGAINST TEMPORDER
    const { orderID } = req.params
    const tempOrder = await TempOrder.findOne({user: req.user?._id, paymentTransactionId: orderID})
    if (!tempOrder){
      throw new Error('No temp order data found')
    }
    const { purchaseUnits } = await paypalController.getOrder(orderID)
    if (!purchaseUnits){
      throw new Error('Purchase units on paypal order not found')
    } else if (purchaseUnits.length !== 1){
      throw new Error('Purchase units had multiple elements')
    }
    
    validatePurchaseUnitsAgainstTempOrder(purchaseUnits[0], tempOrder)

    // For attempting to capture the order, throws an error if failed
    const { jsonResponse, httpStatusCode } = await paypalController.captureOrder(orderID)
    const {status: paypalOrderStatus, id: paypalOrderId} = jsonResponse

    // Generates a user-friendly order number
    const orderNumber: string = await generateOrderNumber()

    // Creates new order
    const newOrder = new Order({
      user: req.user?._id,
      items: tempOrder.items,
      totalCost: tempOrder.totalCost,
      orderNumber,
      status: 'PAID',
      payment: {
        method: 'PAYPAL',
        status: paypalOrderStatus,
        transactionId: paypalOrderId
      }
    })
    await newOrder.save()

    // Adds sending a confirmation email to the task queue
    await enqueueConfirmationEmail(newOrder.orderNumber as string, req.user?.name as string, req.user?.email as string)

    // Returns the response to the client since payment captured and order created
    res.status(httpStatusCode).json({...jsonResponse, orderNumber})

    // Deletes all basket data associated with the user since order created
    await BasketModel.deleteMany({user: req.user?._id.toString()})

    // Handles updating the stock reservation and deleting the tempOrder in a session
    // Does not throw an error, future features will add failed reservation updates to a task queue!
    // Will move this job to a task queue later!
    const userId = (req.user as { _id: mongoose.Types.ObjectId })._id
    try {
      await creatSessionAndHandleStockCleanup(userId, tempOrder)
    } catch (error){
      console.error(' Error cleaning up basket and stock reservations ', error)
    }

  } catch (error){
    let errorMessage = 'Error capturing and creating order document: '
    if (error instanceof Error){
      errorMessage += error.message
    }
    console.error(error)
    res.status(500).json({error: errorMessage})
  }
})


// Route for releasing reserved stock from a tempOrder after a non-recoverable payment error
orderRouter.post('/release/:orderID', authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
  const { orderID } = req.params
  // Finds the tempOrder
  const tempOrderToRemove = await TempOrder.findOne({paymentTransactionId: orderID})
  // If the tempOrder still exists, then call the stock release handler
  if (tempOrderToRemove){
    createSessionAndReleaseStock(tempOrderToRemove)
  } 

  // Indicate that the tempOrder removed and the stock released
  res.status(201).json({data: 'TempOrder removal handled'})
})

// Route for retrieving a list of the users orders
orderRouter.get('', authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?._id.toString()

  const usersOrders = await Order.find({user: userId})

  res.status(200).json(usersOrders)
})

export default orderRouter