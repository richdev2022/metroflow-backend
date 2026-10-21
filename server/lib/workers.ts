
import { Worker, Job } from 'bullmq';
import logger from './logger';
import {
  getQueueConnection,
  transferQueue,
  productDocQueue,
  scheduledQueue,
  TransferJobData,
  ProductDocJobData,
  ScheduledJobData,
} from './queues';
import { processAllPending, checkProcessingTransfers } from '../services/transfer';
import { processPendingProductDocJobs } from '../services/productDocJobs';
import { processSubscriptionRenewals } from '../services/subscription';
import { query } from '../db';

// Initialize connection
const connection = getQueueConnection();

// Worker for transfer processing
if (connection && transferQueue) {
  new Worker<TransferJobData>('transfers', async (job: Job<TransferJobData>) => {
    logger.info(`Processing transfer job ${job.id} for business ${job.data.businessId}`);
    
    try {
      await processAllPending(job.data.businessId);
      return { success: true, message: 'Transfers processed successfully' };
    } catch (error) {
      logger.error(`Error processing transfer job ${job.id}:`, error);
      throw error;
    }
  }, { connection: connection as any });

  logger.info('✅ Transfer queue worker started');
}

// Worker for product document jobs
if (connection && productDocQueue) {
  new Worker<ProductDocJobData>('product-docs', async (job: Job<ProductDocJobData>) => {
    logger.info(`Processing product doc job ${job.id}`);
    
    try {
      const count = await processPendingProductDocJobs(job.data.limit || 10);
      return { success: true, processed: count };
    } catch (error) {
      logger.error(`Error processing product doc job ${job.id}:`, error);
      throw error;
    }
  }, { connection: connection as any });

  logger.info('✅ Product docs queue worker started');
}

// Worker for scheduled tasks
if (connection && scheduledQueue) {
  new Worker<ScheduledJobData>('scheduled', async (job: Job<ScheduledJobData>) => {
    logger.info(`Processing scheduled job ${job.id}: ${job.data.type}`);
    
    try {
      switch (job.data.type) {
        case 'cleanup-logs':
          const threeDaysAgo = new Date();
          threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
          const result = await query(
            'DELETE FROM activity_logs WHERE created_at < $1',
            [threeDaysAgo]
          );
          logger.info(`Cleaned up ${result.rowCount} old activity logs`);
          return { success: true, cleanedLogs: result.rowCount };

        case 'renew-subscriptions':
          await processSubscriptionRenewals();
          return { success: true, message: 'Subscriptions renewed' };

        case 'update-overdue-tasks':
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          await query(
            `UPDATE tasks SET is_overdue = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE is_overdue = FALSE AND status != 'completed'
             AND ((due_date IS NOT NULL AND due_date < $1) OR (due_date IS NULL AND end_date < $1))`,
            [today.toISOString().split('T')[0]]
          );

          await query(
            `UPDATE tasks SET is_overdue = FALSE, updated_at = CURRENT_TIMESTAMP
             WHERE is_overdue = TRUE AND status != 'completed'
             AND ((due_date IS NOT NULL AND due_date >= $1) OR (due_date IS NULL AND end_date >= $1))`,
            [today.toISOString().split('T')[0]]
          );
          
          logger.info('Overdue tasks updated');
          return { success: true, message: 'Overdue tasks updated' };

        case 'check-processing-transfers':
          await checkProcessingTransfers();
          return { success: true, message: 'Processing transfers checked' };

        default:
          throw new Error(`Unknown job type: ${job.data.type}`);
      }
    } catch (error) {
      logger.error(`Error processing scheduled job ${job.id}:`, error);
      throw error;
    }
  }, { connection: connection as any });

  logger.info('✅ Scheduled queue worker started');
}
