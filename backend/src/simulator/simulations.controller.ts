import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { Public } from "../auth/public.decorator";
import type { ArmKey } from "./counterfactuals";
import { CreateSimulationDto } from "./dto/create-simulation.dto";
import { SimulationsService } from "./simulations.service";

@Controller("simulations")
export class SimulationsController {
  constructor(private readonly simulations: SimulationsService) {}

  /**
   * `GET /simulations/headline` — four numbers, without a session.
   *
   * The only public route on this controller, and the landing page is the
   * reason: it prints "44.7% of at-risk revenue recovered" above the fold, and
   * a marketing figure nobody can check is exactly the claim a payments panel
   * asks for the source of. These come from the promoted run's own report, so
   * the number on the front page and the number in the Evidence Report are one
   * number — and a visitor can rerun the seed and get it back (D-117).
   *
   * Deliberately four figures and no case data: a rate, an uplift, an accuracy
   * and a total at risk. Nothing here names a customer or a case.
   */
  @Public()
  @Get("headline")
  headline() {
    return this.simulations.publicHeadline();
  }

  /** `GET /simulations` — the run history the lab lists. */
  @Get()
  list(@CurrentMerchant() merchant: SessionClaims) {
    return this.simulations.list(merchant.sub);
  }

  /**
   * `POST /simulations` — starts a run and answers immediately.
   *
   * 202, not 201: what comes back is a run that has been accepted, not one that
   * has happened. Ten simulated days of policy take minutes of real time, and a
   * client that held the connection open for them would be timed out by the
   * first proxy in the way.
   */
  @Post()
  @HttpCode(202)
  async create(@CurrentMerchant() merchant: SessionClaims, @Body() dto: CreateSimulationDto) {
    const run = await this.simulations.create(merchant.sub, {
      batchSize: dto.batchSize,
      mix: dto.mix,
      difficulty: dto.difficulty,
      seed: dto.seed,
      arms: dto.arms as ArmKey[],
    });

    return { id: run.ref, status: run.status, progress: 0 };
  }

  @Get(":id")
  status(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    return this.simulations.status(merchant.sub, id);
  }

  /** `GET /simulations/:id/report` — the artifact, exactly as it was written. */
  @Get(":id/report")
  report(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    return this.simulations.reportFor(merchant.sub, id);
  }

  /**
   * `POST /simulations/:id/promote` — make this run the batch the Control
   * Tower narrates, and clear whatever it was showing before.
   *
   * Separate from running it, because it is destructive and a merchant should
   * have to mean it.
   */
  @Post(":id/promote")
  @HttpCode(200)
  promote(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    return this.simulations.promote(merchant.sub, id);
  }
}
