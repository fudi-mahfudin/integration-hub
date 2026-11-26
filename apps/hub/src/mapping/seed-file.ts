import { readFile } from 'node:fs/promises';
import type { z } from 'zod';

/**
 * Reads and parses one of the operator's mapping seed files in the repo.
 * @throws Error naming the file when it is unreadable, not JSON, or does not match `schema`.
 */
export async function readSeedFile<T>(path: URL, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`mapping seed at "${path.pathname}" must be a readable JSON file`, { cause: err });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`mapping seed at "${path.pathname}" is invalid; ${problems.join('; ')}`);
  }
  return parsed.data;
}
