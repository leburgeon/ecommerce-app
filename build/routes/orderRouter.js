"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const middlewear_1 = require("../utils/middlewear");
const Product_1 = __importDefault(require("../models/Product"));
const mongoose_1 = __importDefault(require("mongoose"));
const Order_1 = __importDefault(require("../models/Order"));
// import paypalClient from '../utils/paypalClient'
// Baseurl is /api/orders
const orderRouter = express_1.default.Router();
// Route for creating a new order and reducing the stock count, 
orderRouter.post('/', middlewear_1.authenticateUser, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { products } = req.body;
    const { user } = req;
    // For starting a transaction session
    const session = yield mongoose_1.default.startSession();
    session.startTransaction();
    // Try block attempts to perform the database updates within the transaction
    // If an error thrown within try block, transaction aborted
    try {
        // For each of the products in the array, this block attempts to:
        // - Validate that the product exists, throwing an error if it is not found
        // - Asserts that there is sufficient stock for the quantity of the product
        // - Decrement the amount of stock from the stock reserve
        // - Save the stock updated document
        let totalCost = 0;
        const productDocsStockChanged = yield Promise.all(products.map((product) => __awaiter(void 0, void 0, void 0, function* () {
            const doc = yield Product_1.default.findById(product.id).session(session);
            // Asserts that the product with the id exists
            if (!doc) {
                throw new Error('Product not found!');
            }
            // Asserts that there is sufficient quantity in the reserved stock and throws error if not
            if (product.quantity > doc.stock.reserved) {
                throw new Error(`Insufficient stock for ${doc.name} x ${product.quantity}`);
            }
            // Updates the cost total 
            totalCost += (doc.price * product.quantity);
            // Decrements the stock reserve and returns the document (not saved)
            doc.stock.reserved -= product.quantity;
            // Then attempts to save the doc
            yield doc.save();
            return Object.assign(Object.assign({}, product), { doc });
        })));
        // Creates an array representing the list of products for the new order document
        const productsForNewOrder = productDocsStockChanged.map(product => {
            return { product: product.doc._id.toString(),
                quantity: product.quantity,
                price: product.doc.price
            };
        });
        // Creates the new order document
        const newOrder = new Order_1.default({
            products: productsForNewOrder,
            user: user === null || user === void 0 ? void 0 : user._id.toString(),
            total: totalCost,
            status: 'placed'
        });
        // Saves the new order
        yield newOrder.save();
        // Commits the transaction changes if this point is reached with no errors thrown
        yield session.commitTransaction();
        // Sends confirmation that the order has been created
        res.status(201).json({ orderId: newOrder._id.toString() });
        // TODO
        // Needs to delete the basket/cart if order placed successfully 
    }
    catch (error) {
        // If error is thrown, transaction aborted and changes rolled back
        yield session.abortTransaction();
        let errorMessage = `Error placing order:`;
        if (error instanceof Error) {
            errorMessage += error.message;
        }
        res.status(500).json({ error: errorMessage });
    }
    finally {
        // Ends the session
        yield session.endSession();
    }
}));
exports.default = orderRouter;
