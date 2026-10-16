import "reflect-metadata";
import { compose } from "./infra/composition";
import { WagerConsumer } from "./infra/workers/WagerConsumer";
import { OutboxPublisher } from "./infra/workers/OutboxPublisher";
import { ReferenceWorker } from "./infra/workers/ReferenceWorker";
import { telemetry } from "./infra/observability/Telemetry";
const app = await compose();
const role = process.env.WORKER_ROLE ?? "all";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const health = Bun.serve({
  port: Number(process.env.METRICS_PORT ?? 9090),
  hostname: "0.0.0.0",
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/metrics")
      return new Response(await telemetry.registry.metrics(), {
        headers: { "Content-Type": telemetry.registry.contentType },
      });
    if (path === "/health/live")
      return Response.json({ status: stopping ? "stopping" : "up" });
    if (path === "/health/ready") {
      if (stopping)
        return Response.json({ status: "stopping" }, { status: 503 });
      try {
        await app.db.em.fork().execute("select 1");
        await app.broker.ready();
        return Response.json({ status: "ready" });
      } catch {
        return Response.json({ status: "not_ready" }, { status: 503 });
      }
    }
    return new Response(null, { status: 404 });
  },
});
async function loop(name: string, tick: () => Promise<number>, delay: number) {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      telemetry.log("worker_retry", {
        component: name,
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
    if (!stopping) await Bun.sleep(delay);
  }
}
const tasks: Promise<void>[] = [];
if (role === "all" || role === "consumer") {
  const worker = new WagerConsumer(app.broker, app.process, app.db);
  tasks.push(loop("consumer", () => worker.tick(), 25));
}
if (role === "all" || role === "publisher") {
  const worker = new OutboxPublisher(app.db, app.broker);
  tasks.push(loop("publisher", () => worker.tick(), 100));
}
if (role === "all" || role === "reference") {
  const worker = new ReferenceWorker(app.db, app.process);
  tasks.push(loop("reference", () => worker.tick(), 500));
}
telemetry.log("worker_started", { role });
await Promise.all(tasks);
await health.stop(true);
app.broker.close();
await app.db.close(true);
telemetry.log("worker_stopped");
