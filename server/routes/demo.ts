import { RequestHandler } from "express";
import { DemoResponse } from "@shared/api";

/**
 * @swagger
 * /demo:
 *   get:
 *     summary: Demo endpoint
 *     tags: [Demo]
 *     responses:
 *       200:
 *         description: Demo response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 */
export const handleDemo: RequestHandler = (req, res) => {
  const response: DemoResponse = {
    message: "Hello from Express server",
  };
  res.status(200).json(response);
};
