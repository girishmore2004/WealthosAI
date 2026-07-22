import { Injectable } from "@nestjs/common";

// Token estimation here is a documented approximation, not a real tokenizer. Groq
// serves multiple model families (Llama, etc.) each with their own tokenizer, and
// pulling in a real one (e.g. tiktoken) would only be accurate for OpenAI's own
// models — it would give a *false* sense of precision for the models we actually call.
// The ~4-chars-per-token heuristic is the same rule of thumb OpenAI's own docs quote
// for English text and is good enough for "should we trim this" budget decisions; it
// is not good enough for exact cost accounting.
const CHARS_PER_TOKEN_ESTIMATE = 4;

@Injectable()
export class TokenBudgetService {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /** Trims text to fit within maxTokens (estimated), keeping the head and tail and
   * dropping the middle — the head usually carries the question/instruction and the
   * tail often carries the most recent/relevant data, so a middle-out trim loses less
   * than a naive tail truncation for the kind of context this app assembles (e.g.
   * "here's the user's question, here's N retrieved snippets, here's the most recent
   * one"). Returns the input unchanged if it already fits. */
  trimToBudget(text: string, maxTokens: number): { text: string; wasTrimmed: boolean } {
    const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
    if (text.length <= maxChars) {
      return { text, wasTrimmed: false };
    }

    const marker = "\n...[trimmed to fit context budget]...\n";
    const remaining = maxChars - marker.length;
    const headChars = Math.ceil(remaining * 0.6);
    const tailChars = remaining - headChars;

    return {
      text: text.slice(0, headChars) + marker + text.slice(text.length - tailChars),
      wasTrimmed: true,
    };
  }
}
