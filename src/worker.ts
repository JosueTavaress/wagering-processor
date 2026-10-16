import { HealthStatus } from "./infra/http/HttpContract";
import "reflect-metadata";
import { WorkerRole, ProcessSignal, ListenHost } from "./infra/RecoveryConfig";
import { UnknownErrorCode } from "./infra/InfrastructureError";
import { compose } from "./infra/composition";
import { WagerConsumer } from "./infra/workers/WagerConsumer";
import { OutboxPublisher } from "./infra/workers/OutboxPublisher";
import { ReferenceWorker } from "./infra/workers/ReferenceWorker";
import { telemetry, LogEvent } from "./infra/observability/Telemetry";
const PollIntervalMs = {
  [WorkerRole.Consumer]: 25,
  [WorkerRole.Publisher]: 100,
  [WorkerRole.Reference]: 500,
} as const;

const app = await compose();
const role = process.env.WORKER_ROLE ?? WorkerRole.All;
let stopping = false;
process.on(ProcessSignal.Terminate, () => {
  stopping = true;
});
process.on(ProcessSignal.Interrupt, () => {
  stopping = true;
});
const health = Bun.serve({
  port: Number(process.env.METRICS_PORT ?? 9090),
  hostname: ListenHost,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/metrics")
      return new Response(await telemetry.registry.metrics(), {
        headers: { "Content-Type": telemetry.registry.contentType },
      });
    if (path === "/health/live")
      return Response.json({
        status: stopping ? HealthStatus.Stopping : HealthStatus.Up,
      });
    if (path === "/health/ready") {
      if (stopping)
        return Response.json(
          { status: HealthStatus.Stopping },
          { status: 503 },
        );
      try {
        await app.db.em.fork().execute("select 1");
        await app.broker.ready();
        return Response.json({ status: HealthStatus.Ready });
      } catch {
        return Response.json(
          { status: HealthStatus.NotReady },
          { status: 503 },
        );
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
      telemetry.log(LogEvent.WorkerRetry, {
        component: name,
        errorCode: error instanceof Error ? error.name : UnknownErrorCode,
      });
    }
    if (!stopping) await Bun.sleep(delay);
  }
}
const tasks: Promise<void>[] = [];
if (role === WorkerRole.All || role === WorkerRole.Consumer) {
  const worker = new WagerConsumer(app.broker, app.process, app.db);
  tasks.push(
    loop(
      WorkerRole.Consumer,
      () => worker.tick(),
      PollIntervalMs[WorkerRole.Consumer],
    ),
  );
}
if (role === WorkerRole.All || role === WorkerRole.Publisher) {
  const worker = new OutboxPublisher(app.db, app.broker);
  tasks.push(
    loop(
      WorkerRole.Publisher,
      () => worker.tick(),
      PollIntervalMs[WorkerRole.Publisher],
    ),
  );
}
if (role === WorkerRole.All || role === WorkerRole.Reference) {
  const worker = new ReferenceWorker(app.db, app.process);
  tasks.push(
    loop(
      WorkerRole.Reference,
      () => worker.tick(),
      PollIntervalMs[WorkerRole.Reference],
    ),
  );
}
telemetry.log(LogEvent.WorkerStarted, { role });
await Promise.all(tasks);
await health.stop(true);
app.broker.close();
await app.db.close(true);
telemetry.log(LogEvent.WorkerStopped);
