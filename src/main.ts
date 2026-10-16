import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { compose } from "./infra/composition";
import { ApiController } from "./infra/http/ApiController";
import { ApiExceptionFilter } from "./infra/http/ApiExceptionFilter";
import { telemetry } from "./infra/observability/Telemetry";
const application = await compose();
@Module({
  controllers: [ApiController],
  providers: [{ provide: "APPLICATION", useValue: application }],
})
class AppModule {}
const app = await NestFactory.create(AppModule, { logger: false });
app.useGlobalFilters(new ApiExceptionFilter());
await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
telemetry.log("api_started", { port: Number(process.env.PORT ?? 3000) });
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  application.broker.close();
  await application.db.close(true);
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
