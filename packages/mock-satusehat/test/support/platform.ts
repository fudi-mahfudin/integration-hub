import { afterAll, beforeAll, beforeEach } from 'vitest';
import { MockClient } from '../../src/index.js';
import { startMock, type MockOptions, type RunningMock } from '../../src/server.js';
import { loadWorld } from '../../src/world/world.js';

export const world = loadWorld();
export const NIK = 'https://fhir.kemkes.go.id/id/nik';
export const encounterSystem = (org = world.organization.id): string => `http://sys-ids.kemkes.go.id/encounter/${org}`;

/**
 * One mock per test file, reset before each test (#12). Tests talk to it only
 * as the hub would (token + FHIR over HTTP) and through the typed client.
 */
export function useMock(options: MockOptions = {}) {
  const ctx = {} as { mock: RunningMock; client: MockClient; platform: Platform };
  beforeAll(async () => {
    ctx.mock = await startMock(options);
    ctx.client = new MockClient(ctx.mock.baseUrl);
    ctx.platform = new Platform(ctx.mock.baseUrl);
  });
  beforeEach(async () => {
    await ctx.client.reset();
    ctx.platform.forgetToken();
  });
  afterAll(async () => {
    await ctx.mock?.close();
  });
  return ctx;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

/** Speaks the platform surface the way an adapter would. */
export class Platform {
  private token: string | undefined;
  constructor(readonly baseUrl: string) {}

  forgetToken(): void {
    this.token = undefined;
  }

  async requestToken(clientId = world.organization.clientId, clientSecret = world.organization.clientSecret): Promise<Reply> {
    const res = await fetch(`${this.baseUrl}/oauth2/v1/accesstoken?grant_type=client_credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
    });
    return toReply(res);
  }

  async bearer(): Promise<string> {
    if (!this.token) {
      const r = await this.requestToken();
      if (r.status !== 200) throw new Error(`token request failed: ${r.status}`);
      this.token = r.body.access_token as string;
    }
    return this.token;
  }

  /** `GET {base}/kfa-v2/products?{query}`, with the same bearer token as FHIR (#14). */
  async kfa(query: Record<string, string>, token?: string | null): Promise<Reply> {
    const auth = token === null ? undefined : (token ?? (await this.bearer()));
    const res = await fetch(`${this.baseUrl}/kfa-v2/products?${new URLSearchParams(query)}`, {
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    });
    return toReply(res);
  }

  async fhir(method: string, path: string, body?: unknown, token?: string | null): Promise<Reply> {
    const auth = token === null ? undefined : (token ?? (await this.bearer()));
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}/fhir-r4/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return toReply(res);
  }
}

async function toReply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, headers: res.headers, body };
}
