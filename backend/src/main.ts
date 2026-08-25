import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";

async function bootstrap(): Promise<void> {
  // rawBody keeps the exact bytes of each request alongside the parsed body.
  // Razorpay's HMAC is computed over those bytes, and re-serialized JSON can
  // differ from them in key order or number formatting — which produces a
  // completely different digest and a signature that never verifies.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService);

  // Credentials are on because the session travels as an httpOnly cookie; a
  // wildcard origin is invalid in that mode, so the origin is pinned to config.
  app.enableCors({ origin: config.frontendOrigin, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // BullMQ workers and the Socket.IO gateway need an ordered teardown to avoid
  // dropping in-flight jobs when the process is asked to stop.
  app.enableShutdownHooks();

  await app.listen(config.port);

  const logger = new Logger("Bootstrap");
  logger.log(`Tugboat API listening on http://localhost:${config.port}`);
  logger.log(`Environment: ${config.nodeEnv} | LLM mode: ${config.llmMode}`);
  logger.log(`Channel modes: ${JSON.stringify(config.channelModes)}`);
}

void bootstrap();
