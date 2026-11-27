import { createServer } from 'node:http';
import type { Log } from './log.js';
import type { MetricsExposition } from './metrics.js';

/** A worker's HTTP server: `GET /metrics` only (#41); the worker has no other HTTP interface yet. */
export interface MetricsServer {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41235/`. */
  listen(): Promise<URL>;
  /** Stops listening and closes open connections. */
  close(): Promise<void>;
}

/** Builds a worker's metrics server on `host`:`port` (`0` picks a free port). Only the composition root calls this. */
export function createMetricsServer(deps: { metrics: MetricsExposition; host: string; port: number; log: Log }): MetricsServer {
  const { metrics, host, port, log } = deps;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.scrape().then(
      (text) => res.writeHead(200, { 'content-type': metrics.contentType }).end(text),
      (err: unknown) => {
        // This scrape fails; Prometheus marks the target down for it and scrapes again.
        log('error', 'reading the metrics failed', { error: err });
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
            reject(new Error(`expected the metrics server to listen on a TCP port, got address ${JSON.stringify(address)}`));
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
