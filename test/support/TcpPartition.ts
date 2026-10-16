import { createServer, createConnection, type Socket } from "node:net";

/** Test-only relay: real TCP traffic, with explicit connection cuts and restoration. */
export async function tcpPartition(host: string, port: number) {
  const sockets = new Set<Socket>();
  let blocked = false;
  let refusedConnections = 0;
  const server = createServer((incoming) => {
    if (blocked) {
      refusedConnections++;
      incoming.destroy();
      return;
    }
    const upstream = createConnection({ host, port });
    sockets.add(incoming);
    sockets.add(upstream);
    const close = () => {
      sockets.delete(incoming);
      sockets.delete(upstream);
      incoming.destroy();
      upstream.destroy();
    };
    incoming.on("error", close);
    upstream.on("error", close);
    incoming.on("close", close);
    upstream.on("close", close);
    incoming.pipe(upstream).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PROXY_PORT");
  return {
    port: address.port,
    get refusedConnections() {
      return refusedConnections;
    },
    disconnect() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      blocked = false;
    },
    async close() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
