import { createServer } from 'node:http';
import type { Log } from '../observability/log.js';
import type { BreakerState, LimiterMode, MetricsExposition } from '../observability/metrics.js';
import type { PlatformApi } from '../satusehat/circuit-breaker.js';
import { readinessHttpStatus, type ReadinessReport } from './readiness.js';

/**
 * A worker's `GET /readyz` body (#43): the readiness every process reports,
 * plus each platform API's breaker state and the rate limiter's mode. Both
 * are information only: an open breaker means SATUSEHAT is unhealthy, not the worker.
 */
export interface WorkerReadinessReport extends ReadinessReport {
  breakers: Record<PlatformApi, BreakerState>;
  limiter: { mode: LimiterMode };
}

/** A worker's HTTP server: `GET /livez`, `GET /readyz` (#43) and `GET /metrics` (#41); the worker has no other HTTP interface. */
export interface WorkerServer {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41235/`. */
  listen(): Promise<URL>;
  /** Stops listening and closes open connections. */
  close(): Promise<void>;
}

/** Builds a worker's HTTP server on `host`:`port` (`0` picks a free port). Only the composition root calls this. */
export function createWorkerServer(deps: {
  metrics: MetricsExposition;
  /** The worker's readiness now. */
  readiness: () => Promise<WorkerReadinessReport>;
  host: string;
  port: number;
  log: Log;
}): WorkerServer {
  const { metrics, readiness, host, port, log } = deps;
  const json = (status: number, body: unknown) => [status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(body)] as const;
  const routes: Record<string, () => Promise<readonly [number, Record<string, string>, string]>> = {
    '/livez': async () => json(200, { status: 'ok' }),
    '/readyz': async () => {
      const report = await readiness();
      return json(readinessHttpStatus(report), report);
    },
    '/metrics': async () => [200, { 'content-type': metrics.contentType }, await metrics.scrape()] as const,
  };
  const server = createServer((req, res) => {
    const route = req.method === 'GET' && req.url !== undefined ? routes[req.url] : undefined;
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route().then(
      ([status, headers, body]) => res.writeHead(status, headers).end(body),
      (err: unknown) => {
        // This request fails; Prometheus or the orchestrator asks again.
        log('error', 'answering a worker health or metrics request failed', { path: req.url, error: err });
        res.writeHead(500).end();
      },
    );
  });

  return {
    listen: () =>
      new Promise<URL>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error(`expected the worker server to listen on a TCP port, got address ${JSON.stringify(address)}`));
            return;
          }
          const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
          resolve(new URL(`http://${shownHost}:${address.port}/`));
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A server that never started listening is closed already.
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
