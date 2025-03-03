import mongoose from "mongoose";

const basketSchema = new mongoose.Schema({
  user: {
    type: mongoose.Types.ObjectId,
    required: true
  },
  products: [
    {
      _id: false,
      productId: {
        type: mongoose.Types.ObjectId,
        ref: 'Product',
        required: true
      },
      quantity: {
        type: Number,
        default: 1
      }
    }
  ]
})

export default mongoose.model('Basket', basketSchema)