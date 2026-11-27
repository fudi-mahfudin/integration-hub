// The load test's k6 script (#46). `pnpm loadtest` writes the run directory
// and runs this in the compose service `k6` with LOADTEST_DIR pointing at it:
// `k6-config.json` holds the options (built from bigrun.commitments.json by
// src/loadtest/k6.ts) and where to send, `events.ndjson` the event file the
// source simulator planned, one request per arrival, replayed in order, and
// LOADTEST_API_KEY the source API key.
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const dir = __ENV.LOADTEST_DIR;
if (!dir) throw new Error('LOADTEST_DIR must name the run directory, got nothing');
const config = JSON.parse(open(`${dir}/k6-config.json`));
const apiKey = __ENV.LOADTEST_API_KEY;
if (!apiKey) throw new Error('LOADTEST_API_KEY must hold the source API key, got nothing');
const events = new SharedArray('events', () =>
  open(`${dir}/events.ndjson`)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line)),
);

export const options = config.options;

/** Answers outside 2xx: the committed non-2xx rate. */
const non2xx = new Rate('ingest_non_2xx');
/** Answers carrying `Idempotent-Replayed: true`: duplicates the hub recognised. */
const replayed = new Counter('ingest_replayed');
const url = `${config.hubUrl}v1/events`;
let logged = 0;

/** One arrival: the event file's next request. The warm-up sends the first ones, the measured phase those after. */
export function ingest() {
  const scenario = exec.scenario;
  const index = (scenario.name === 'load' ? config.warmUpRequests : 0) + scenario.iterationInTest;
  const event = events[index];
  if (event === undefined) throw new Error(`the event file has no request ${index}: it holds ${events.length}`);
  const res = http.post(url, event.body, {
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': event.idempotencyKey, 'content-type': 'application/json' },
    tags: { name: 'POST /v1/events' },
  });
  const outside2xx = res.status < 200 || res.status >= 300;
  non2xx.add(outside2xx);
  if (res.headers['Idempotent-Replayed'] === 'true') replayed.add(1);
  // A few per VU, so a failing hub shows why without flooding the log.
  if (outside2xx && logged++ < 3) console.warn(`POST /v1/events answered ${res.status} ${res.error ?? ''}: ${String(res.body).slice(0, 300)}`);
}

/** The end-of-test summary, written whole for the harness to judge. */
export function handleSummary(data) {
  return { [`${dir}/k6-summary.json`]: JSON.stringify(data, null, 2) };
}
