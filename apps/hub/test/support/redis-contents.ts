import { Redis } from 'ioredis';

/**
 * Every key in the Redis at `url`, and the value of every string key. Read
 * straight from Redis on purpose: what must be proven is what Redis holds,
 * whichever process wrote it (#47).
 */
export async function readRedis(url: string): Promise<{ keys: string[]; values: string[] }> {
  const redis = new Redis(url);
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'COUNT', 1000);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    const values = await Promise.all(keys.map(async (key) => ((await redis.type(key)) === 'string' ? ((await redis.get(key)) ?? '') : '')));
    return { keys, values };
  } finally {
    redis.disconnect();
  }
}
