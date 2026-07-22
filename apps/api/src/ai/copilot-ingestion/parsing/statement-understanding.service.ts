import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ParsedLine } from "./statement-parser";

const understandingSchema = z.object({
  transactions: z.array(
    z.object({
      rawLine: z.string(),
      date: z.string().describe("YYYY-MM-DD"),
      amount: z.number().positive(),
      merchantRaw: z.string(),
      isDebit: z.boolean().describe("false if this line is money coming in (a credit/refund), not an expense"),
    }),
  ),
});

// Called ONLY on the lines StatementParserService's deterministic pass couldn't
// confidently extract a date+amount from — this is "statement understanding" in the
// literal sense the roadmap asked for (handling messy/inconsistent real-world text),
// scoped narrowly to the leftover, genuinely ambiguous lines rather than replacing the
// deterministic parser for everything.
@Injectable()
export class StatementUnderstandingService {
  private readonly logger = new Logger(StatementUnderstandingService.name);

  constructor(private gateway: AiGatewayService) {}

  async parseLeftoverLines(userId: string, unparsedLines: string[]): Promise<ParsedLine[]> {
    if (unparsedLines.length === 0) return [];

    try {
      const result = await this.gateway.extract(
        `Statement lines that didn't parse cleanly (one per line):\n${unparsedLines.join("\n")}`,
        understandingSchema,
        { feature: "copilot_ingestion.statement_understanding", promptName: "copilot_ingestion.statement_understanding", userId, cacheable: false },
      );

      return result.data.transactions
        .filter((t) => t.isDebit)
        .map((t) => ({ rawLine: t.rawLine, date: new Date(t.date), amount: t.amount, merchantRaw: t.merchantRaw }))
        .filter((t) => !Number.isNaN(t.date.getTime()));
    } catch (err) {
      // The AI fallback failing just means these particular lines stay unparsed —
      // CopilotIngestionService surfaces them to the user as "couldn't parse" rather
      // than the whole ingestion failing.
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Statement understanding fallback unavailable: ${err.message}`);
        return [];
      }
      throw err;
    }
  }
}
