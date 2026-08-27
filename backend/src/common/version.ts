import { version } from "../../package.json";

/**
 * The build that produced a report.
 *
 * Stamped into every evidence report, because "91% diagnosis accuracy" is a
 * claim about a specific pile of code and the natural next question is which
 * one. Read from `package.json` rather than repeated as a constant here: a
 * version number kept in two places is a version number that eventually lies
 * about the more important of the two.
 */
export const CODE_VERSION = `tugboat@${version}`;
