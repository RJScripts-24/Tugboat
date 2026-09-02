import { ChalkNote } from "@/components/dashboard/chalk";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { formatPercent, formatRupeesCompact } from "@/lib/money";
import { ARM_META, type ArmResult } from "@/lib/simulation-data";

/**
 * Baseline vs naive vs TUGBOAT, on one seed (PRD 6.3, page 6 · PRD 8).
 *
 * The row that carries the argument is the middle one. Naive is not a strawman
 * that does nothing - it does *more* than TUGBOAT, on every channel, immediately
 * - and it still ends up with less money, more complaints, ten times the
 * opt-outs and a compliance column full of violations. Bounds are not a
 * concession made to the regulator at the cost of recovery; on this batch they
 * are the reason the recovery is higher.
 *
 * The three columns on the right are the ones a payments panel reads first, so
 * they are not buried: what it cost, what it cost per ₹100 recovered, and how
 * many of its sends were illegal.
 */
export function ArmTable({ arms }: { arms: ArmResult[] }) {
  const baseline = arms.find((arm) => arm.key === "baseline");
  const naive = arms.find((arm) => arm.key === "naive");
  const tugboat = arms.find((arm) => arm.key === "tugboat");

  const contactRatio =
    naive && tugboat && tugboat.contacts > 0 ? naive.contacts / tugboat.contacts : null;
  const shortfall = naive && tugboat ? tugboat.recoveredPaise - naive.recoveredPaise : null;

  return (
    <Section
      title="Policy arms"
      meta={`${arms.length} policies · one batch · one seed`}
      action={
        contactRatio && shortfall ? (
          // `shortfall` is signed, and on the committed seed-42 run it is
          // negative: the naive arm recovers more money. The note used to
          // hardcode the word "less" around it and printed "₹-62,066 less",
          // which is both wrong and the one comparison this page exists to make
          // honestly. Say which way it went and let the compliance columns
          // beside it carry the argument.
          <ChalkNote tone="gold" arrow>
            naive sent {contactRatio.toFixed(1)}× the contacts and recovered ₹
            {formatRupeesCompact(Math.abs(shortfall))} {shortfall < 0 ? "more" : "less"}
          </ChalkNote>
        ) : undefined
      }
    >
      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>Arm</th>
              <th className="num">Recovered</th>
              <th className="num">Rate</th>
              <th className="num">Cases</th>
              <th className="num">Contacts</th>
              <th className="num">Complaints</th>
              <th className="num">Opt-outs</th>
              <th className="num">Quiet-hour sends</th>
              <th className="num">Cost</th>
              <th className="num">Per ₹100</th>
            </tr>
          </thead>
          <tbody>
            {arms.map((arm) => {
              const winner = arm.key === "tugboat";
              return (
                <tr key={arm.key}>
                  <td>
                    <span className={winner ? "text-txt" : "text-txt-dim"}>
                      {ARM_META[arm.key].short}
                    </span>
                    {winner ? (
                      <span className="mono ml-2 text-[11px] text-txt-faint">under test</span>
                    ) : null}
                  </td>
                  <td className="num">
                    <MoneyValue
                      paise={arm.recoveredPaise}
                      className={winner ? "text-recovered" : "text-txt-dim"}
                    />
                  </td>
                  <td className={`num mono ${winner ? "text-txt" : "text-txt-dim"}`}>
                    {formatPercent(arm.recoveryRate)}
                  </td>
                  <td className="num mono text-txt-dim">{arm.recoveredCases}</td>
                  <td className="num mono text-txt-dim">
                    {arm.contacts.toLocaleString("en-IN")}
                  </td>
                  <td
                    className={`num mono ${arm.complaints > 10 ? "text-halted" : "text-txt-dim"}`}
                  >
                    {arm.complaints}
                  </td>
                  <td className={`num mono ${arm.optOuts > 10 ? "text-halted" : "text-txt-dim"}`}>
                    {arm.optOuts}
                  </td>
                  <td
                    className={`num mono ${
                      arm.quietHourSends > 0 ? "text-halted" : "text-txt-dim"
                    }`}
                  >
                    {arm.quietHourSends}
                  </td>
                  <td className="num mono text-txt-dim">
                    {arm.costPaise === 0 ? "—" : `₹${formatRupeesCompact(arm.costPaise)}`}
                  </td>
                  <td className="num">
                    {arm.costPer100Paise === null ? (
                      <span className="mono text-txt-faint">—</span>
                    ) : (
                      <MoneyValue
                        paise={Math.round(arm.costPer100Paise)}
                        exact
                        className={arm.costPer100Paise > 500 ? "text-halted" : "text-txt-dim"}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <p className="text-[12px] leading-[1.6] text-txt-dim">
          The baseline is the counterfactual, not a run: nothing is detected and nobody is
          contacted, so it recovers only what {baseline?.recoveredCases ?? 0} customers would have
          paid anyway. It is the arm the headline is measured against, and it is the only figure on
          this page that could not be produced by running something.
        </p>
      </div>
    </Section>
  );
}
