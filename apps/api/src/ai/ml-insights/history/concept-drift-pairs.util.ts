import { MonthlyPoint } from "../features/feature-extraction.service";
import { ForecastActualPair } from "../models/concept-drift.model";

export interface HistoricalForecastSnapshot {
  /** When the forecast run happened — the target month is derived as "the month
   * after this", matching CashflowForecastModel's own "one step past the last
   * observed month" framing. */
  createdAt: Date;
  predictedNextMonthCashflow: number;
}

function targetMonthKey(createdAt: Date): string {
  const d = new Date(createdAt.getFullYear(), createdAt.getMonth() + 1, 1);
  return d.toISOString().slice(0, 7);
}

/** Pure pairing of past forecast snapshots (from MlInsightRun history) against the
 * now-known actual net cashflow for whichever target month has since passed — no
 * Prisma/I/O here, the orchestrator (MlInsightsService) is responsible for fetching
 * both inputs. A target month resolves only once monthlySeries shows real activity
 * for it (totalIncome/totalExpenses not both zero); unresolved (future or
 * not-yet-logged) target months are simply skipped rather than compared against a
 * false "actual" of 0. When multiple historical runs target the same month (e.g. the
 * dashboard was loaded more than once in the same month), only the first one
 * encountered (runs are expected caller-side to be sorted most-recent-first, so this
 * keeps the LATEST forecast made for that target month, which is the most honest
 * "prediction vs. outcome" comparison) is kept. Returned oldest-target-first, the
 * order ConceptDriftModel's windowed comparison expects. */
export function buildForecastActualPairs(
  runs: HistoricalForecastSnapshot[],
  monthlySeries: MonthlyPoint[],
): ForecastActualPair[] {
  const actualByMonth = new Map(monthlySeries.map((m) => [m.month, m]));
  const seenTargets = new Set<string>();
  const pairs: ForecastActualPair[] = [];

  for (const run of runs) {
    const targetMonth = targetMonthKey(run.createdAt);
    if (seenTargets.has(targetMonth)) continue;

    const actual = actualByMonth.get(targetMonth);
    if (!actual || (actual.totalIncome === 0 && actual.totalExpenses === 0)) continue;

    seenTargets.add(targetMonth);
    pairs.push({ targetMonth, predictedNetCashflow: run.predictedNextMonthCashflow, actualNetCashflow: actual.netCashflow });
  }

  return pairs.sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));
}
