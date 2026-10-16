import { connect } from "node:net";
async function available(url: URL, defaultPort: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || defaultPort),
    });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("CONNECTION_TIMEOUT"));
    });
  });
}
try {
  await available(
    new URL(
      process.env.DATABASE_URL ??
        "postgresql://wager:wager@localhost:5432/wager",
    ),
    5432,
  );
  await available(
    new URL(process.env.SQS_ENDPOINT ?? "http://localhost:4566"),
    4566,
  );
} catch {
  console.error(
    "Integration prerequisites unavailable: start PostgreSQL and LocalStack with docker compose up -d postgres localstack. Tests were not executed.",
  );
  process.exit(1);
}
