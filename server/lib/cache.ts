import Redis from "ioredis";
import logger from "./logger";

let redisClient: Redis | null = null;

const isRedisDisabled = (): boolean =>
  ["true", "1", "yes"].includes((process.env.DISABLE_REDIS || "").toLowerCase());

/**
 * REDIS_URL must be a real connection endpoint:
 *   redis://[:password@]host:port   |   rediss://...   (TLS)
 * Upstash-style REST setups use REDIS_REST_URL + REDIS_REST_TOKEN instead and
 * are not supported by the ioredis client used here.
 * A bare token (e.g. "lc1_..." from a provider dashboard) has no host — the
 * client would crash-loop. We refuse it with an actionable message and run
 * without Redis (everything falls back: DB counters, in-memory rate limits,
 * socket.io without the redis adapter).
 */
const isValidRedisUrl = (url: string): boolean => /^rediss?:\/\//i.test(url);

const getRedisRetryLimit = (): number => {
  const retries = Number(process.env.REDIS_MAX_RETRIES ?? 1);
  return Number.isFinite(retries) && retries >= 0 ? retries : 1;
};

const getRedisConnectTimeout = (): number => {
  const timeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5000);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
};

export function createRedisClient(context: string): Redis | null {
  if (isRedisDisabled()) {
    logger.warn(`${context}: Redis disabled by DISABLE_REDIS=true`);
    return null;
  }

  const rawUrl = (process.env.REDIS_URL || "").trim();
  if (!rawUrl) {
    logger.warn(`${context}: REDIS_URL not set, Redis features disabled`);
    return null;
  }

  if (!isValidRedisUrl(rawUrl)) {
    logger.error(
      `${context}: REDIS_URL is not a redis:// or rediss:// connection URL — Redis disabled, running on fallbacks. ` +
        `Got: "${rawUrl.slice(0, 12)}…". A bare API token (like "lc1_…") is not a Redis endpoint: ` +
        `copy the connection string from your Redis provider (e.g. redis://default:PASSWORD@host:6379, ` +
        `or for Upstash use REDIS_URL=rediss://default:PASSWORD@host:6379). ` +
        `Everything works without Redis — you just lose cross-instance caching.`,
    );
    return null;
  }

  let loggedConnectionError = false;
  const retryLimit = getRedisRetryLimit();

  const client = new Redis(process.env.REDIS_URL, {
    connectTimeout: getRedisConnectTimeout(),
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      if (times > retryLimit) {
        logger.warn(`${context}: Redis reconnect disabled after ${retryLimit} retry attempt(s)`);
        return null;
      }

      return Math.min(times * 250, 1000);
    },
  });

  client.on("error", (err) => {
    if (!loggedConnectionError) {
      loggedConnectionError = true;
      logger.error(`${context}: Redis connection error:`, err);
    }
  });

  client.on("end", () => {
    logger.warn(`${context}: Redis connection closed`);
  });

  return client;
}

export function getRedisClient(): Redis | null {
  return redisClient;
}

export function initRedis(): void {
  try {
    redisClient = createRedisClient("Cache");
    if (!redisClient) return;

    redisClient.on("connect", () => {
      logger.info("Connected to Redis");
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
