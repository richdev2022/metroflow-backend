import { query } from "../db";
import crypto from "crypto";

export interface AuditLogOptions {
  businessId?: string;
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAuditEvent(options: AuditLogOptions) {
  await query(
    `INSERT INTO audit_logs
     (business_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      options.businessId || null,
      options.userId || null,
      options.action,
      options.entityType || null,
      options.entityId || null,
      options.oldValues ? JSON.stringify(options.oldValues) : null,
      options.newValues ? JSON.stringify(options.newValues) : null,
      options.ipAddress || null,
      options.userAgent || null,
    ]
  );
}

export function generateTransactionHash(
  reference: string, amount: string, recipientAccount: string, recipientBank: string): string {
  const data = `${reference}-${amount}-${recipientAccount}-${recipientBank}-${process.env.TRANSACTION_HASH_SECRET || 'default-secret-key'}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}
