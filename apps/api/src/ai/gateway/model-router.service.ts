import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiTaskType } from "./ai-gateway.types";

// Classification/extraction/ranking are "read the input, pick/pull/order something" —
// cheap, low-reasoning tasks well suited to a small fast model. Generation and
// summarization are asked to actually compose prose, which benefits more from a
// larger model's reasoning. This mapping is intentionally the only place task-type ->
// model lives, so changing it later is a one-line change, not a grep-and-replace.
const LARGE_MODEL_TASKS: ReadonlySet<AiTaskType> = new Set(["generation", "summarization"]);

// Deterministic-leaning tasks default to temperature 0 (same input should tend to give
// the same output — this also makes AiCacheService's cache meaningfully useful for
// them). Generation/summarization get a little room to vary since forcing temperature
// 0 on prose composition tends to produce noticeably flatter, more repetitive output.
const TASK_TEMPERATURE: Record<AiTaskType, number> = {
  classification: 0,
  extraction: 0,
  ranking: 0,
  summarization: 0.3,
  generation: 0.4,
};

@Injectable()
export class ModelRouterService {
  constructor(private config: ConfigService) {}

  modelFor(taskType: AiTaskType): string {
    return LARGE_MODEL_TASKS.has(taskType)
      ? this.config.get<string>("ai.largeModel")!
      : this.config.get<string>("ai.smallModel")!;
  }

  temperatureFor(taskType: AiTaskType): number {
    return TASK_TEMPERATURE[taskType];
  }
}
