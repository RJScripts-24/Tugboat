import { Global, Logger, Module } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { CasesModule } from "../cases/cases.module";
import { PolicyModule } from "../policy/policy.module";
import { FakeLlmDriver } from "./fake-llm.driver";
import { GeminiDriver } from "./gemini.driver";
import { GroqDriver } from "./groq.driver";
import { InboundService } from "./inbound.service";
import { LLM_DRIVER, type LlmDriver } from "./llm-driver.interface";
import { LlmService } from "./llm.service";
import { RoutedLlmDriver } from "./routed-llm.driver";

/**
 * Chooses the lane once, at boot, from config.
 *
 * `LLM_MODE=live` with no keys throws rather than silently falling back to the
 * fake driver: a run that believes it used a real model but did not would put
 * false numbers in the evidence report, which is the one failure this project
 * cannot afford.
 */
function buildDriver(config: AppConfigService, fake: FakeLlmDriver): LlmDriver {
  const logger = new Logger("LlmDriver");

  if (config.llmMode === "fake") {
    logger.log("LLM_MODE=fake — deterministic offline driver, no network calls");
    return fake;
  }

  const gemini = config.geminiApiKey
    ? new GeminiDriver(config.geminiApiKey, config.geminiModel)
    : null;
  const groq = config.groqApiKey ? new GroqDriver(config.groqApiKey, config.groqModel) : null;

  if (!gemini && !groq) {
    throw new Error(
      "LLM_MODE=live but neither GEMINI_API_KEY nor GROQ_API_KEY is set. " +
        "Set a key, or use LLM_MODE=fake.",
    );
  }

  // With only one provider configured, it takes both lanes — better than
  // failing, and the health endpoint reports which provider is actually in use.
  const reasoning = gemini ?? groq!;
  const fast = groq ?? gemini!;

  logger.log(`LLM_MODE=live — reasoning: ${reasoning.provider}, fast: ${fast.provider}`);
  return new RoutedLlmDriver(reasoning, fast);
}

@Global()
@Module({
  imports: [CasesModule, PolicyModule],
  providers: [
    FakeLlmDriver,
    {
      provide: LLM_DRIVER,
      inject: [AppConfigService, FakeLlmDriver],
      useFactory: buildDriver,
    },
    LlmService,
    InboundService,
  ],
  exports: [LlmService, LLM_DRIVER, FakeLlmDriver, InboundService],
})
export class ConversationModule {}
