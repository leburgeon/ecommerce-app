import express, { NextFunction } from 'express'
import { Response } from 'express'
import { authenticateUser, parseProductToBasket } from '../utils/middlewear'
import Basket from '../models/Basket'
import { AuthenticatedRequest } from '../types'
import Product from '../models/Product'

const basketRouter = express.Router()

// Route for getting the basket information of the user

basketRouter.post('/add', authenticateUser, parseProductToBasket, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const userDoc = req.user
  const productToAddId = req.body.productId
  const quantityToAdd = parseInt(req.body.quantity)

  // First ensures that the objectId corresponds to a valid product
  const productToAdd = await Product.findById(productToAddId)
  if (!productToAdd){
    
    const errorMessage = `Error finding the product with the id ${productToAddId}`
    res.status(404).json({error: errorMessage})

  } else {
    try {
      // Attempts to find the basket associated with the user
      let usersBasket = await Basket.findOne({user: userDoc?._id})
  
      // If no basket is found, a basket is created for that user with the item to add
      if (!usersBasket){
        usersBasket = new Basket({user: userDoc?._id})
        await usersBasket.save()
      }
  
      // Itterates over the array of products already in the basket
      let wasInBasket = false
      usersBasket.products.forEach(product => {

        // If the product exists in the basket already, increases the quantity by requested amount
        if (product.productId.toString() === productToAdd._id.toString()){
          product.quantity += quantityToAdd
          wasInBasket = true
        }
      })
      // If the product was not in the basket, adds a new product object to the array of products
      if (!wasInBasket){
        usersBasket.products.push({
          productId: productToAdd._id,
          quantity: quantityToAdd
        })
      }

      // Saves the basket after changes
      await usersBasket.save()

      const productsNowInBasket = usersBasket.products.length

      // Confirms the add to the frontend, with the amount of products now in the basket
      res.status(200).json({basketCount: productsNowInBasket})
    } catch (error) {
      console.error('Error adding product to basket', error)
      next(error)
    }
  }  
})

basketRouter.post('/reduce', authenticateUser, parseProductToBasket, async (req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
  const userDoc = req.user
  const productToReduceId = req.body.productId
  const quantityToRemove = parseInt(req.body.quantity)

  try {
    // First attempts to find the product
    const productToReduce = await Product.findById(productToReduceId)
    if (!productToReduce){
      // If not found, respond with 404 not found
      res.status(404).json({error: 'Product to reduce from basket not found'})
    } else {
      // Attempts to find the user basket
      const userBasket = await Basket.findOne({user: userDoc?._id})

      // If no basket exists, no need to remove item
      if (!userBasket){
        res.status(200)
      } else {
        
        // Uses a mongoDB query to update the product array 
        // Breakdown: the first object argument is the query selector, which is used to:
          // 1: Select the document 
          // 2: specify a condition on array elements which is utilised by the $ operator
        await Basket.updateOne({_id: userBasket._id, 'products.productId': productToReduce._id},
          // The second object argument is the update operation
          // In this example, the $inc update operator is used alongside the $ operator to affect only the first matching element
          // The '.' operator is subsequantly used to identify which field of the object to affect
          {
            $inc: {'products.$.quantity': - quantityToRemove},
            // The second field of this update operation is used to remove elements in the products array, whos condition is met
            $pull: { products: {quantity: {$lte: 1}}}
          }
        )
        const usersBasketAfter = await Basket.findById(userBasket._id)
        res.status(200).json({basketCount: usersBasketAfter?.products.length})
      }
    }
  } catch (error) {
    console.error('SOMTHING WRONG REDUCING FROM BASKET', error)
    res.status(500).json({
      error: 'There was an error removing this from the basket'
    })
  }
  
})

export default basketRouter