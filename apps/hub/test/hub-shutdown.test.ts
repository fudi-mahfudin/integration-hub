import { randomUUID } from 'node:crypto';
import { Agent, request, type ClientRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { caseViewSchema, getCase, newVisitId, prescriptionWritten, SOURCE_API_KEY, TEST_SOURCES, visitStarted } from './support/events.js';

/** Long enough to read `/readyz` while the hub still serves, short enough not to slow the test down. */
const SHUTDOWN_DELAY_MS = 400;

/** An answer read in full. */
interface Answer {
  status: number;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const answerOf = (req: ClientRequest) =>
  new Promise<Answer>((resolve, reject) => {
    req.once('error', reject);
    req.once('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text === '' ? null : JSON.parse(text) }));
    });
  });

/**
 * Starts `POST /v1/events` over `agent` (one keep-alive connection) and sends
 * all of the body but its last byte: the request is in flight until `finish()`.
 */
function startPost(baseUrl: URL, agent: Agent, body: unknown, idempotencyKey: string) {
  const text = JSON.stringify(body);
  const req = request(new URL('v1/events', baseUrl), {
    method: 'POST',
    agent,
    headers: {
      authorization: `Bearer ${SOURCE_API_KEY}`,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    },
  });
  const answered = answerOf(req);
  req.write(text.slice(0, -1));
  return {
    finish: () => {
      req.end(text.slice(-1));
      return answered;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('hub service graceful shutdown (#43)', () => {
  const hubs: BootedHub[] = [];
  const agents: Agent[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.destroy();
    await Promise.all(hubs.splice(0).map((h) => h.close()));
  });

  async function boot(): Promise<BootedHub> {
    const hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, SHUTDOWN_DELAY_MS: String(SHUTDOWN_DELAY_MS) });
    hubs.push(hub);
    return hub;
  }

  it('drains: readiness turns draining, the request in flight is accepted, the next on its connection gets 503 SERVICE_DRAINING; resent after a restart, it is accepted once', async () => {
    const hub = await boot();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    const visitId = newVisitId();
    const inFlight = startPost(hub.baseUrl, agent, visitStarted({ visitId }), randomUUID());
    // Let the request reach the hub before the shutdown starts.
    await sleep(50);

    const closed = hub.close();
    const readyz = await fetch(new URL('readyz', hub.baseUrl));
    expect(readyz.status).toBe(503);
    expect(await readyz.json()).toMatchObject({ status: 'draining' });
    await sleep(SHUTDOWN_DELAY_MS + 100);

    const accepted = await inFlight.finish();
    expect(accepted.status).toBe(202);
    const nextKey = randomUUID();
    const next = prescriptionWritten({ visitId });
    const refused = await startPost(hub.baseUrl, agent, next, nextKey).finish();
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(refused.headers.connection).toBe('close');
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(refused.body).toMatchObject({ status: 503, code: 'SERVICE_DRAINING' });
    await closed;

    const restarted = await boot();
    const resend = () => fetch(new URL('v1/events', restarted.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${SOURCE_API_KEY}`, 'idempotency-key': nextKey, 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    const first = await resend();
    const again = await resend();
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    const caseId = z.string().parse(accepted.headers.location).split('/').at(-1) ?? '';
    const view = caseViewSchema.parse(await (await getCase(restarted.baseUrl, caseId)).json());
    expect(view.events.map((e) => [e.type, e.duplicates])).toEqual([
      ['visit.started', 0],
      ['prescription.written', 1],
    ]);
  });
});
