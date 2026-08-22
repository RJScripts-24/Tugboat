import { MoneyValue, Section, StatusMark } from "@/components/dashboard/primitives";
import { formatSpan } from "@/lib/clock";
import { formatPercent } from "@/lib/money";
import { DIFFICULTY, type SavedRun } from "@/lib/simulation-data";

/**
 * Saved runs (PRD 6.3, page 6 - "run-history list enabling side-by-side reruns").
 *
 * The table exists so a claim can be checked against a rerun instead of taken
 * on trust, which means the interesting rows are the unflattering ones. Two of
 * these are the same seed under a harder and an easier persona mix, and they
 * are on the page because they are the honest answer to "does this only work
 * when your customers are nice". It works less well when they are not.
 *
 * The footer states what the spread actually shows rather than the tidier
 * thing it would be nice to claim: both the rate and the uplift move with the
 * personas, so neither number means anything without the arm and the
 * difficulty it was measured beside. That is the argument for reporting all
 * three columns together, not for reporting the uplift alone.
 *
 * The last row is an older policy version on a different seed. It is kept
 * because a run history in which every run is better than the last one is a
 * run history somebody has been editing.
 */
export function RunHistory({ runs }: { runs: SavedRun[] }) {
  const uplifts = runs.map((run) => (run.recoveryRate - run.baselineRate) * 100);
  const rates = runs.map((run) => run.recoveryRate * 100);
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

  return (
    <Section title="Run history" meta={`${runs.length} saved runs`}>
      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>Run</th>
              <th className="num">Seed</th>
              <th>Difficulty</th>
              <th className="num">Cases</th>
              <th>Policy</th>
              <th className="num">Recovered</th>
              <th className="num">Rate</th>
              <th className="num">Uplift</th>
              <th className="num">Diagnosis</th>
              <th className="num">Per ₹100</th>
              <th className="num">Ran</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const uplift = (run.recoveryRate - run.baselineRate) * 100;
              return (
                <tr key={run.id}>
                  <td>
                    <span className="mono text-txt">{run.id}</span>
                    {run.current ? (
                      <span className="ml-2.5 inline-flex translate-y-[1px]">
                        <StatusMark tone="waiting">on screen</StatusMark>
                      </span>
                    ) : null}
                  </td>
                  <td className="num mono text-txt-dim">{run.seed}</td>
                  <td className="text-txt-dim">
                    {DIFFICULTY[run.difficulty].label}
                    <span className="mono ml-2 text-[11px] text-txt-faint">
                      {(DIFFICULTY[run.difficulty].responseRate * 100).toFixed(0)}% respond
                    </span>
                  </td>
                  <td className="num mono text-txt-dim">{run.batchSize}</td>
                  <td className="mono text-txt-faint">{run.policyVersion}</td>
                  <td className="num">
                    <MoneyValue paise={run.recoveredPaise} className="text-recovered" />
                  </td>
                  <td className="num mono text-txt-dim">{formatPercent(run.recoveryRate)}</td>
                  <td className="num mono text-txt">+{uplift.toFixed(1)} pts</td>
                  <td className="num mono text-txt-dim">{formatPercent(run.accuracy)}</td>
                  <td className="num">
                    <MoneyValue paise={run.costPer100Paise} exact className="text-txt-dim" />
                  </td>
                  <td className="num mono text-txt-faint">{formatSpan(run.ranMinutesAgo)} ago</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <p className="max-w-[92ch] text-[12px] leading-[1.6] text-txt-dim">
          Same seed, same policy, three persona mixes: the recovery rate moves{" "}
          {spread(rates).toFixed(0)} points and the uplift moves{" "}
          {spread(uplifts).toFixed(0)}. Neither figure survives being quoted on its own — which is
          why the headline names the arm it beat and the difficulty it was run at, and why the
          hostile row is on this page rather than filed somewhere it would not be read.
        </p>
      </div>
    </Section>
  );
}
