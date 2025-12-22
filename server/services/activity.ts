import { query } from "../db";

export interface ActivityLogData {
  businessId: string;
  userId: string;
  action: string;
  actionType?: string;
  description?: string;
  taskId?: string;
  metadata?: Record<string, any>;
}

export async function logActivity(data: ActivityLogData) {
  try {
    await query(
      `INSERT INTO activity_logs (business_id, user_id, action, action_type, description, task_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        data.businessId,
        data.userId,
        data.action,
        data.actionType || null,
        data.description || null,
        data.taskId || null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ]
    );
  } catch (error) {
    console.error("Failed to log activity:", error);
    // Don't throw error to prevent disrupting main functionality
  }
}