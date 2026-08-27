/**
 * The three population presets, stated out loud.
 *
 * Mirrors `DIFFICULTY` in `frontend/src/lib/simulation-data.ts` field for
 * field, because the evidence report echoes the chosen preset back into its own
 * JSON (`run.difficultyAssumptions`). A response-rate assumption is the single
 * biggest lever on the headline number, so it travels *with* the headline
 * rather than living in a config file nobody reads.
 *
 * `hostile` exists so that the honest question — what happens when your
 * customers do not want to hear from you — has an answer on the page rather
 * than in the Q&A.
 */
export const DIFFICULTY_KEYS = ["easy", "realistic", "hostile"] as const;
export type DifficultyKey = (typeof DIFFICULTY_KEYS)[number];

export type DifficultyPreset = {
  label: string;
  caption: string;
  /** Share of the population that answers on some channel. Excludes opt-outs. */
  responseRate: number;
  optOutRate: number;
  /** Share that never answers and never pays, whatever is sent. */
  silentTail: number;
  /**
   * Share that would have paid with no contact at all.
   *
   * This is the baseline arm, and it is a property of the population rather
   * than of the agent: it is the money that was coming back anyway, and every
   * uplift figure in the report is measured against it.
   */
  selfRecoveryRate: number;
  /** Multiplies the generated deadlines. Hostile customers get half the runway. */
  deadlineScale: number;
};

export const DIFFICULTY: Record<DifficultyKey, DifficultyPreset> = {
  easy: {
    label: "Easy",
    caption: "62% answer on some channel · 1% opt out · no silent tail",
    responseRate: 0.62,
    optOutRate: 0.01,
    silentTail: 0,
    selfRecoveryRate: 0.204,
    deadlineScale: 1,
  },
  realistic: {
    label: "Realistic",
    caption: "38% answer · 2.8% opt out · 13% never respond on any channel",
    responseRate: 0.38,
    optOutRate: 0.028,
    silentTail: 0.13,
    selfRecoveryRate: 0.118,
    deadlineScale: 1,
  },
  hostile: {
    label: "Hostile",
    caption: "19% answer · 6% opt out · 28% never respond · deadlines halved",
    responseRate: 0.19,
    optOutRate: 0.06,
    silentTail: 0.28,
    selfRecoveryRate: 0.061,
    deadlineScale: 0.5,
  },
};

export function isDifficultyKey(value: string): value is DifficultyKey {
  return (DIFFICULTY_KEYS as readonly string[]).includes(value);
}
