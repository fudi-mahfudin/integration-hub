import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';

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

/**
 * A seed entry's source system id. The seed may name a source system this
 * deployment doesn't register (the simulator's seed ships everywhere): its
 * rows are loaded, and only that source's steps would ever read them.
 */
export function seedSource(source: string): SourceSystemId {
  // Checked non-empty by the seed schema; a seed is the operator's own data.
  return source as SourceSystemId;
}
