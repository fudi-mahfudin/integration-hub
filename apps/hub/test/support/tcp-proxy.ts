import { createServer, connect, type Socket } from 'node:net';

/** A TCP proxy in front of a dependency, so a test can make it unreachable. */
export interface TcpProxy {
  /** `url` with its host and port replaced by the proxy's. */
  url: string;
  /** Stops listening and cuts every open connection: the proxy's port then refuses connections. */
  cut(): Promise<void>;
}

/**
 * Starts a proxy on local `port` (default: a random one) that forwards every
 * connection to the host and port of `url` (a Postgres or Redis URL).
 */
export async function startTcpProxy(url: string, port = 0): Promise<TcpProxy> {
  const target = new URL(url);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A cut connection errors on both ends; the test is what cut it.
    socket.on('error', () => socket.destroy());
  };
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    track(client);
    track(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`expected the proxy to listen on a TCP port, got ${JSON.stringify(address)}`);
  const proxied = new URL(url);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);
  return {
    url: proxied.toString(),
    cut: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
