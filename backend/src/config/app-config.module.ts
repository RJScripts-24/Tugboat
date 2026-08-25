import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppConfigService } from "./app-config.service";
import { validateEnv } from "./env.validation";

/**
 * Global so no feature module has to import config to read it.
 *
 * `validate` returns the parsed object, which becomes ConfigService's source of
 * truth — that is what makes coerced types (PORT as a number) survive the trip.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env"],
      validate: validateEnv,
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
