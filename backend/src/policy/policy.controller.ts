import { Body, Controller, Get, Put } from "@nestjs/common";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { PolicyService } from "./policy.service";

@Controller("policies")
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  /** GET /policies — the pack in force, plus every revision that led to it. */
  @Get()
  async get(@CurrentMerchant() merchant: SessionClaims) {
    const [active, revisions] = await Promise.all([
      this.policy.getActive(merchant.sub),
      this.policy.revisions(merchant.sub),
    ]);

    return { version: active.version, pack: active.pack, revisions };
  }

  /**
   * PUT /policies — validate, diff, and cut a new version.
   *
   * The body is deliberately untyped for Nest's `ValidationPipe`: the pack is
   * validated by Zod inside the service, which is the same parser the whole
   * project uses for untrusted input and the only one that can express
   * "opt-out is the literal true".
   */
  @Put()
  async put(@CurrentMerchant() merchant: SessionClaims, @Body() body: unknown) {
    const result = await this.policy.save(merchant.sub, body, merchant.name);

    return {
      version: result.version,
      pack: result.pack,
      changes: result.changes,
      unchanged: result.unchanged,
      revisions: await this.policy.revisions(merchant.sub),
    };
  }
}
