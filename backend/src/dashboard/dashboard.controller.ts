import { Controller, Get } from "@nestjs/common";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { DashboardService } from "./dashboard.service";

/**
 * Five reads, one per card on the Control Tower.
 *
 * Split rather than served as one blob because the page renders them
 * independently and a socket nudge refreshes them independently: `kpi.updated`
 * moves the strip without redrawing the gateway chart, and the funnel is
 * expensive enough (five aggregate queries) that bundling it into every KPI
 * refresh would make the cheap thing cost the price of the dear one.
 */
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("kpis")
  kpis(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.kpis(merchant.sub);
  }

  @Get("funnel")
  funnel(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.funnel(merchant.sub);
  }

  @Get("root-causes")
  rootCauses(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.rootCauses(merchant.sub);
  }

  @Get("success-rate-series")
  successRateSeries(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.successRateSeries(merchant.sub);
  }

  /** The feed's opening page; `activity.new` continues it over the socket. */
  @Get("activity")
  activity(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.activity(merchant.sub);
  }

  @Get("shell-status")
  shellStatus(@CurrentMerchant() merchant: SessionClaims) {
    return this.dashboard.shellStatus(merchant.sub);
  }
}
