
import { Queue, Worker, Job } from 'bullmq';
import logger from './logger';
import { initRedis } from './cache';
import Redis from 'ioredis';

let connection: Redis | null = null;

export const getQueueConnection = (): Redis | null => {
  if (connection) return connection;

  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set, BullMQ queues not initialized');
    return null;
  }

  connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  connection.on('connect', () => {
    logger.info('✅ Connected to Redis for BullMQ');
  });

  connection.on('error', (err) => {
    logger.error('❌ Redis connection error for BullMQ:', err);
  });

  return connection;
};

// Initialize Redis for queues
const connectionInstance = getQueueConnection();

// Define queues
export const transferQueue = connectionInstance ? new Queue('transfers', { connection: connectionInstance as any }) : null;
export const productDocQueue = connectionInstance ? new Queue('product-docs', { connection: connectionInstance as any }) : null;
export const scheduledQueue = connectionInstance ? new Queue('scheduled', { connection: connectionInstance as any }) : null;

// Job data types
export interface TransferJobData {
  businessId: string;
  transferId?: string;
}

export interface ProductDocJobData {
  limit?: number;
}

export interface ScheduledJobData {
  type: 'cleanup-logs' | 'renew-subscriptions' | 'update-overdue-tasks' | 'check-processing-transfers';
}

// Queue cleanup function to close connections
export const closeAllQueues = async () => {
  await Promise.all([
    transferQueue?.close(),
    productDocQueue?.close(),
    scheduledQueue?.close(),
    connection?.quit(),
  ]);
};
