import { describe, expect, it } from 'vitest';
import { useMock, world } from './support/platform.js';

describe('token endpoint', () => {
  const ctx = useMock({ tokenExpiresInSeconds: 2, tokenThrottleWindowMs: 300 });

  it('issues a token for valid client credentials, expires_in as a string', async () => {
    const r = await ctx.platform.requestToken();
    expect(r.status).toBe(200);
    expect(typeof r.body.access_token).toBe('string');
    expect(r.body.expires_in).toBe('2');
  });

  it('rejects FHIR calls without a token or with an unknown token with 401', async () => {
    const path = `/Location?_id=${world.locations[0]!.id}`;
    expect((await ctx.platform.fhir('GET', path, undefined, null)).status).toBe(401);
    expect((await ctx.platform.fhir('GET', path, undefined, 'not-a-token')).status).toBe(401);
    expect((await ctx.platform.fhir('GET', path)).status).toBe(200);
  });

  it('rejects a token after it expires', async () => {
    const token = await ctx.platform.bearer();
    const path = `/Location?_id=${world.locations[0]!.id}`;
    expect((await ctx.platform.fhir('GET', path, undefined, token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await ctx.platform.fhir('GET', path, undefined, token)).status).toBe(401);
  });

  it('keeps older tokens valid when a new one is issued', async () => {
    const first = (await ctx.platform.requestToken()).body.access_token;
    await ctx.platform.requestToken();
    const path = `/Location?_id=${world.locations[0]!.id}`;
    expect((await ctx.platform.fhir('GET', path, undefined, first)).status).toBe(200);
  });

  it('invalidates every issued token on revoke', async () => {
    const token = await ctx.platform.bearer();
    await ctx.client.revokeTokens();
    const path = `/Location?_id=${world.locations[0]!.id}`;
    expect((await ctx.platform.fhir('GET', path, undefined, token)).status).toBe(401);
    expect((await ctx.platform.requestToken()).status).toBe(200);
  });

  it('throttles token requests within the window after a failed one, then recovers', async () => {
    expect((await ctx.platform.requestToken('mock-client-id', 'wrong')).status).toBe(401);
    expect((await ctx.platform.requestToken()).status).toBe(429);
    await new Promise((r) => setTimeout(r, 350));
    expect((await ctx.platform.requestToken()).status).toBe(200);
  });

  it('clears the throttle on reset', async () => {
    expect((await ctx.platform.requestToken('nobody', 'nothing')).status).toBe(401);
    await ctx.client.reset();
    expect((await ctx.platform.requestToken()).status).toBe(200);
  });

  it('rejects a grant type other than client_credentials', async () => {
    const res = await fetch(`${ctx.mock.baseUrl}/oauth2/v1/accesstoken?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
    });
    expect(res.status).toBe(400);
  });
});

describe('token defaults', () => {
  const ctx = useMock();

  it('defaults expires_in to 3599 seconds', async () => {
    expect((await ctx.platform.requestToken()).body.expires_in).toBe('3599');
  });
});
