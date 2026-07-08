import { Queue } from "bullmq";
import Redis from "ioredis";
import { createRedisClient } from "./cache";
import logger from "./logger";

let connection: Redis | null = null;

export const getQueueConnection = (): Redis | null => {
  if (connection) return connection;

  connection = createRedisClient("BullMQ");
  if (!connection) {
    logger.warn("BullMQ queues not initialized");
    return null;
  }

  connection.on("connect", () => {
    logger.info("Connected to Redis for BullMQ");
  });

  return connection;
};

const connectionInstance = getQueueConnection();

export const transferQueue = connectionInstance
  ? new Queue("transfers", { connection: connectionInstance as any })
  : null;

export const productDocQueue = connectionInstance
  ? new Queue("product-docs", { connection: connectionInstance as any })
  : null;

export const scheduledQueue = connectionInstance
  ? new Queue("scheduled", { connection: connectionInstance as any })
  : null;

export interface TransferJobData {
  businessId: string;
  transferId?: string;
}

export interface ProductDocJobData {
  limit?: number;
}

export interface ScheduledJobData {
  type: "cleanup-logs" | "renew-subscriptions" | "update-overdue-tasks" | "check-processing-transfers";
}

export const closeAllQueues = async () => {
  await Promise.all([
    transferQueue?.close(),
    productDocQueue?.close(),
    scheduledQueue?.close(),
    connection?.quit(),
  ]);
};
