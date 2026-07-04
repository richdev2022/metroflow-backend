import Redis from "ioredis";
import logger from "./logger";

let redisClient: Redis | null = null;

export function initRedis(): void {
  if (!process.env.REDIS_URL) {
    logger.warn("REDIS_URL not set, caching disabled");
    return;
  }

  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    redisClient.on("connect", () => {
      logger.info("✅ Connected to Redis");
    });

    redisClient.on("error", (err) => {
      logger.error("❌ Redis connection error:", err);
    });
  } catch (error) {
    logger.error("Failed to initialize Redis:", error);
  }
}

export async function getCache<T>(key: string): Promise<T | null> {
  if (!redisClient) return null;

  try {
    const data = await redisClient.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (error) {
    logger.error("Cache get error:", error);
    return null;
  }
}

export async function setCache(
  key: string,
  value: any,
  ttlSeconds: number = 300,
): Promise<void> {
  if (!redisClient) return;

  try {
    await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    logger.error("Cache set error:", error);
  }
}

export async function deleteCache(key: string): Promise<void> {
  if (!redisClient) return;

  try {
    await redisClient.del(key);
  } catch (error) {
    logger.error("Cache delete error:", error);
  }
}
