import { RequestHandler } from "express";
import { query } from "../db";
import { Idea, CreateIdeaInput, UpdateIdeaStatusInput, ApiResponse } from "@shared/api";
import { AuthenticatedRequest } from "../middleware/auth";

export const getIdeas: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /ideas:
   *   get:
   *     summary: Get all ideas
   *     tags: [Ideas]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: List of ideas
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Idea'
   */
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const result = await query(
      `SELECT i.id, i.business_id as "businessId", i.user_id as "userId", 
              i.title, i.description, i.status, 
              i.created_at as "createdAt", i.updated_at as "updatedAt",
              u.name as "userName"
       FROM ideas i
       LEFT JOIN users u ON i.user_id = u.id
       WHERE i.business_id = $1
       ORDER BY i.created_at DESC`,
      [businessId]
    );

    const response: ApiResponse<Idea[]> = {
      success: true,
      data: result.rows,
    };
    res.json(response);
  } catch (error) {
    console.error("Get ideas error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch ideas" });
  }
};

export const createIdea: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /ideas:
   *   post:
   *     summary: Create a new idea
   *     tags: [Ideas]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - title
   *               - description
   *             properties:
   *               title:
   *                 type: string
   *               description:
   *                 type: string
   *     responses:
   *       201:
   *         description: Idea created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/Idea'
   *       400:
   *         description: Invalid input
   *       401:
   *         description: Unauthorized
   *       500:
   *         description: Server error
   */
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const input: CreateIdeaInput = req.body;

    if (!businessId || !userId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    if (!input.title || !input.description) {
      return res.status(400).json({ success: false, error: "Title and description are required" });
    }

    const result = await query(
      `INSERT INTO ideas (business_id, user_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, business_id as "businessId", user_id as "userId", 
                 title, description, status, 
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, userId, input.title, input.description]
    );

    const newIdea = result.rows[0];

    // Get user name
    const userResult = await query("SELECT name FROM users WHERE id = $1", [userId]);
    newIdea.userName = userResult.rows[0]?.name;

    const response: ApiResponse<Idea> = {
      success: true,
      data: newIdea,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Create idea error:", error);
    res.status(500).json({ success: false, error: "Failed to create idea" });
  }
};

export const updateIdeaStatus: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * /ideas/{id}/status:
 *   put:
 *     summary: Update idea status
 *     tags: [Ideas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [under_review, executed, rejected]
 *     responses:
 *       200:
 *         description: Status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       403:
 *         description: Forbidden (Admin/Manager only)
 *       404:
 *         description: Idea not found
 *       500:
 *         description: Server error
 */
  try {
    const { id } = req.params;
    const { status } = req.body as UpdateIdeaStatusInput;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    if (!["under_review", "executed", "rejected"].includes(status)) {
        return res.status(400).json({ success: false, error: "Invalid status" });
    }

    // Check user role
    const userCheck = await query("SELECT role FROM users WHERE id = $1", [userId]);
    const userRole = userCheck.rows[0]?.role;

    if (userRole !== "admin" && userRole !== "manager") {
      return res.status(403).json({ success: false, error: "Only admins and managers can update idea status" });
    }

    const result = await query(
      `UPDATE ideas
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND business_id = $3
       RETURNING id, business_id as "businessId", user_id as "userId", 
                 title, description, status, 
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [status, id, businessId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Idea not found" });
    }

    const updatedIdea = result.rows[0];
    
    // Get user name (creator)
    const creatorResult = await query("SELECT name FROM users WHERE id = $1", [updatedIdea.userId]);
    updatedIdea.userName = creatorResult.rows[0]?.name;

    const response: ApiResponse<Idea> = {
      success: true,
      data: updatedIdea,
    };
    res.json(response);
  } catch (error) {
    console.error("Update idea status error:", error);
    res.status(500).json({ success: false, error: "Failed to update idea status" });
  }
};
