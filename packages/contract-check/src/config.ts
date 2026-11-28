import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Subjects } from './target.js';

/** Thrown when the contract check must not run here, or is set up wrongly; `main` exits 2 without sending anything. */
export class ContractCheckRefused extends Error {
  override name = 'ContractCheckRefused';
}

/** The sandbox side of a contract check, read from the environment once. */
export interface ContractCheckConfig {
  authUrl: URL;
  fhirUrl: URL;
  kfaUrl: URL;
  clientId: string;
  clientSecret: string;
  organizationId: string;
  /** The git-ignored `live-seed.json` the wizard writes: our Location and the dummies and product to use. */
  liveSeedPath: string;
  /** The git-ignored directory raw recordings go to. */
  recordingsDir: string;
}

type Env = Record<string, string | undefined>;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Reads the sandbox's settings. Refuses when `CI` is set: the check talks to
 * the shared sandbox with the owner's credentials and is run by hand only
 * (#16). Unlike the hub's settings, the credentials and URLs have no
 * defaults: pointing at the sandbox must be deliberate (`.env.live`, from the
 * wizard). Throws naming the bad variable.
 */
export function loadContractCheckConfig(env: Env): ContractCheckConfig {
  if (env.CI !== undefined) throw new ContractCheckRefused('the contract check is local-only and refuses to run when CI is set');
  return {
    authUrl: baseUrl(env, 'SATUSEHAT_AUTH_URL'),
    fhirUrl: baseUrl(env, 'SATUSEHAT_FHIR_URL'),
    kfaUrl: baseUrl(env, 'SATUSEHAT_KFA_URL'),
    clientId: required(env, 'SATUSEHAT_CLIENT_ID'),
    clientSecret: required(env, 'SATUSEHAT_CLIENT_SECRET'),
    organizationId: required(env, 'SATUSEHAT_ORGANIZATION_ID'),
    liveSeedPath: `${REPO_ROOT}live-seed.json`,
    recordingsDir: env.CONTRACT_RECORDINGS_DIR ?? `${REPO_ROOT}.recordings/contract`,
  };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ContractCheckRefused(`${name} must be set (run the sandbox credential wizard to write .env.live), got nothing`);
  }
  return value;
}

function baseUrl(env: Env, name: string): URL {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new ContractCheckRefused(`${name} must be an absolute http(s) URL, got "${raw}"`, { cause: err });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ContractCheckRefused(`${name} must be an http(s) URL, got "${raw}"`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

const nik = z.string().regex(/^\d{16}$/, 'a 16-digit NIK');

/** `live-seed.json`: what the wizard recorded about the sandbox. Holds no credentials. */
const liveSeedSchema = z.object({
  locationId: z.string().min(1),
  patientNik: nik,
  practitionerNik: nik,
  pharmacistNik: nik,
  kfaProductCode: z.string().regex(/^93\d+$/, 'a KFA 93 (actual product) code'),
});

/** Reads and validates the live seed; throws naming the file and the bad fields. */
export async function loadLiveSeed(path: string): Promise<Subjects> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ContractCheckRefused(`the live seed at "${path}" must be a readable JSON file (the wizard writes it; see live-seed.example.json)`, { cause: err });
  }
  const parsed = liveSeedSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ContractCheckRefused(`the live seed at "${path}" is invalid; ${problems.join('; ')}`);
  }
  return parsed.data;
}
