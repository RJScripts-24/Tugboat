import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppConfigService } from "./app-config.service";
import { validateEnv } from "./env.validation";

/**
 * Global so no feature module has to import config to read it.
 *
 * `validate` returns the parsed object, which becomes ConfigService's source of
 * truth — that is what makes coerced types (PORT as a number) survive the trip.
 *
 * Under test the `.env` file is not read. The hermetic tiers set their own
 * placeholders and leave REDIS_URL unset on purpose; letting ConfigModule fill
 * the gap from a developer's `.env` had the e2e suite dialling the real broker
 * (B-54). The integration tier loads `.env` itself, before this module runs.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env"],
      ignoreEnvFile: process.env.NODE_ENV === "test",
      validate: validateEnv,
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
