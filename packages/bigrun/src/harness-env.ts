// Where the harnesses (`pnpm bigrun`, `pnpm loadtest`, `pnpm cacherun`) reach the stack, read
// from the environment once. The defaults are compose's published ports and
// the public development keys, so a clean clone needs no `.env`.
import { z } from 'zod';

/** The harnesses' environment, parsed; an invalid value fails naming its variable. */
export const harnessEnv = z
  .object({
    BIGRUN_HUB_URL: z.url().default('http://localhost:3000/'),
    BIGRUN_MOCK_URL: z.url().default('http://localhost:3001/'),
    BIGRUN_PROMETHEUS_URL: z.url().default('http://localhost:9090/'),
    // The workers' `/metrics`, comma-separated: the Cache run reads its cache counters there.
    BIGRUN_WORKER_URLS: z.string().default('http://localhost:3002/,http://localhost:3003/'),
    BIGRUN_SOURCE_API_KEY: z.string().min(1).default('dev-source-key'),
    BIGRUN_ADMIN_API_KEY: z.string().min(1).default('dev-admin-key'),
  })
  .parse(process.env);
