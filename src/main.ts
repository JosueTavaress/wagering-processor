import { ListenHost, ProcessSignal } from "./infra/RecoveryConfig";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { compose, ApplicationToken } from "./infra/composition";
import { ApiController } from "./infra/http/ApiController";
import { ApiExceptionFilter } from "./infra/http/ApiExceptionFilter";
import { telemetry, LogEvent } from "./infra/observability/Telemetry";
const application = await compose();
@Module({
  controllers: [ApiController],
  providers: [{ provide: ApplicationToken, useValue: application }],
})
class AppModule {}
const app = await NestFactory.create(AppModule, { logger: false });
app.useGlobalFilters(new ApiExceptionFilter());
await app.listen(Number(process.env.PORT ?? 3000), ListenHost);
telemetry.log(LogEvent.ApiStarted, { port: Number(process.env.PORT ?? 3000) });
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  application.broker.close();
  await application.db.close(true);
  process.exit(0);
}
process.on(ProcessSignal.Terminate, () => void stop());
process.on(ProcessSignal.Interrupt, () => void stop());
