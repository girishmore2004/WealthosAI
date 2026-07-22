import { AnomalyFlaggingService } from "../src/ai/copilot-ingestion/detection/anomaly-flagging.service";
import { AnomalyDetectionModel } from "../src/ai/ml-insights/models/anomaly-detection.model";
import { ExpenseTransactionPoint } from "../src/ai/ml-insights/features/feature-extraction.service";

describe("AnomalyFlaggingService", () => {
  const service = new AnomalyFlaggingService(new AnomalyDetectionModel());

  function makeHistory(categoryId: string, amounts: number[]): ExpenseTransactionPoint[] {
    return amounts.map((amount, i) => ({ id: `h${i}`, categoryId, categoryName: "Groceries", amount, spentAt: new Date() }));
  }

  it("flags a candidate amount far outside the category's typical range", () => {
    const history = makeHistory("groceries", [1200, 1100, 1300, 1250, 1150]);
    const result = service.check({ amount: 50000 }, "groceries", history);
    expect(result.isAnomalyCandidate).toBe(true);
    expect(result.anomalyZScore).not.toBeNull();
  });

  it("does not flag a candidate amount within the category's typical range", () => {
    const history = makeHistory("groceries", [1200, 1100, 1300, 1250, 1150]);
    const result = service.check({ amount: 1180 }, "groceries", history);
    expect(result.isAnomalyCandidate).toBe(false);
  });
});
