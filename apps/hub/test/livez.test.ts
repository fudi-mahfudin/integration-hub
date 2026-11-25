import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';

describe('liveness', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('GET /livez answers 200 {"status":"ok"}', async () => {
    const res = await fetch(`${hub.baseUrl}/livez`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
