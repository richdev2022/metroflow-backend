import { query } from "../db";
import { getSocketServer } from "../lib/socket";

interface CreateNotificationOptions {
  businessId: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  actionUrl?: string;
  actionType?: string;
  metadata?: any;
  isActionable?: boolean;
  expiresInHours?: number; // defaults to 24 hours
}

export async function createNotification(options: CreateNotificationOptions) {
  const {
    businessId,
    userId,
    type,
    title,
    message,
    actionUrl,
    actionType,
    metadata,
    isActionable = false,
    expiresInHours = 24,
  } = options;

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiresInHours);

  const result = await query(
    `INSERT INTO notifications 
     (business_id, user_id, type, title, message, action_url, action_type, metadata, is_actionable, expires_at) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      businessId,
      userId,
      type,
      title,
      message,
      actionUrl || null,
      actionType || null,
      metadata ? JSON.stringify(metadata) : null,
      isActionable,
      expiresAt,
    ]
  );

  const notification = result.rows[0];

  // Emit socket event to notify the user in real-time
  const io = getSocketServer();
  if (io) {
    io.to(`user:${userId}`).emit("notification:new", notification);
  }

  return notification;
}
