import { Injectable, OnModuleInit } from "@nestjs/common";
import { AiQueueService } from "./ai-queue.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";

// This is the one concrete "feature" Phase 10 ships end to end — not because a health
// probe is a real product feature, but because standing up the whole pipeline
// (queue -> worker -> gateway -> Groq -> validation -> logging -> job status) against
// something real, rather than leaving it entirely unexercised until RAG/Coach land in
// a later phase, is what keeps this from being an unverified pile of plumbing. See
// README "Phase 10" for why this couldn't be run against a live Groq endpoint from
// this build environment either way.
@Injectable()
export class HealthSelfTestHandler implements OnModuleInit {
  constructor(
    private queue: AiQueueService,
    private gateway: AiGatewayService,
  ) {}

  onModuleInit() {
    this.queue.registerHandler("ai.health.selfTest", async () => {
      const result = await this.gateway.classify("ping", ["ping", "other"], {
        feature: "ai.health",
        promptName: "ai.health.classify_ping",
        cacheable: false,
      });
      return { label: result.data.label, confidence: result.confidence, model: result.meta.model };
    });
  }
}
