import { Request } from "express"
import { NewUserSchema, LoginCredentialsSchema, JwtUserPayloadSchema, NewProductSchema } from "./utils/validators"
import { z } from 'zod'
import mongoose from "mongoose"

// Type of a request body with the required field for a new user
export type NewUser = z.infer<typeof NewUserSchema>

// Type of a request body with credentials for loggin in a user
export type LoginCredentials = z.infer<typeof LoginCredentialsSchema>

// Type for a request body that includes the required fields for adding a new product
export type NewProduct = z.infer<typeof NewProductSchema>

// Interface for defining the type of an object that contains the exposable fields for a user
export interface ExposableUser {
  name: string,
  username: string,
  id: string
}

export interface UserDocument {
  name: string,
  username: string,
  _id: mongoose.Types.ObjectId,
  isAdmin: boolean,
  orders: mongoose.Types.ObjectId[]
}

// Type of a jwt payload with user info
export type JwtUserPayload = z.infer<typeof JwtUserPayloadSchema>

// Interface that extends the express request type but includes a field for the user after authenticatin
export interface AuthenticatedRequest extends Request {
  // must include optional parameter here otherwise overload not accepted
  user?: UserDocument
}

// Interface extending the express request, whos quiery attribute contains a page and a limit field
export interface PageQueriesRequest extends Request {
  query: {
    page: string,
    limit: string
  }
}