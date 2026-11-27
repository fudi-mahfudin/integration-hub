import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { caseViewSchema, getCase, postEvent, prescriptionWritten, TEST_SOURCES, visitStarted } from './support/events.js';

const HOUR = 3_600_000;

describe('stalled cases: a waiting case past the threshold is flagged, and nothing about it changes (ADR 0007)', () => {
  let hub: BootedHub | undefined;
  let offsetMs = 0;
  /** The hub's clock, moved forward by `offsetMs`. */
  const clock = () => new Date(Date.now() + offsetMs);

  afterEach(async () => {
    await hub?.close();
    hub = undefined;
    offsetMs = 0;
  });

  async function waitingCaseOn(env: Record<string, string>) {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, ...env }, clock);
    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten() });
    const caseId = res.headers.get('location')?.split('/').at(-1) ?? '';
    const { baseUrl } = hub;
    const read = async () => caseViewSchema.parse(await (await getCase(baseUrl, caseId)).json());
    return { read };
  }

  it('flags a case that has waited longer than 24h by default, at query time, and leaves it waiting', async () => {
    const { read } = await waitingCaseOn({});
    const before = await read();
    expect(before).toMatchObject({ status: 'waiting', stalled: false });

    offsetMs = 24 * HOUR - 1_000;
    expect(await read()).toMatchObject({ stalled: false });
    offsetMs = 24 * HOUR + 1_000;
    const stalled = await read();
    expect(stalled).toMatchObject({ status: 'waiting', stalled: true, waitingFor: 'visit.started', waitingSince: before.waitingSince });
    expect(stalled.steps).toEqual(before.steps);
  });

  it('takes its threshold from STALLED_AFTER_MS', async () => {
    const { read } = await waitingCaseOn({ STALLED_AFTER_MS: String(HOUR) });
    offsetMs = HOUR + 1_000;
    expect(await read()).toMatchObject({ status: 'waiting', stalled: true });
  });

  it('never flags a case that is not waiting', async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES }, clock);
    const res = await postEvent(hub.baseUrl, { body: visitStarted() });
    const caseId = res.headers.get('location')?.split('/').at(-1) ?? '';
    offsetMs = 48 * HOUR;
    expect(caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json())).toMatchObject({ status: 'active', stalled: false });
  });
});
