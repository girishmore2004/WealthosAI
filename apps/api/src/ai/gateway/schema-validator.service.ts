import { Injectable } from "@nestjs/common";
import { z } from "zod";

export interface ValidationAttempt<T> {
  ok: boolean;
  data?: T;
  /** Human-readable issue list, fed back to the model verbatim on the next attempt so
   * it can self-correct rather than just being asked to "try again". */
  issues?: string[];
}

// Pure, side-effect-free JSON parsing + zod validation. AiGatewayService owns the
// retry loop (it needs to re-call the model between attempts); this class only judges
// a single attempt and formats issues in a way that's useful to feed back to the model.
@Injectable()
export class SchemaValidatorService {
  parse<T extends z.ZodTypeAny>(schema: T, rawText: string): ValidationAttempt<z.infer<T>> {
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return { ok: false, issues: ["Response was not valid JSON."] };
    }

    const result = schema.safeParse(json);
    if (result.success) {
      return { ok: true, data: result.data };
    }

    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, issues };
  }

  /** Renders a zod schema's JSON Schema shape as plain-language field instructions for
   * the system prompt. Deliberately simple (not the full JSON Schema spec) — this is
   * read by an LLM, not a program, and a compact description beats a technically
   * complete but verbose one for getting compliant output. */
  describe<T extends z.ZodTypeAny>(schema: T): string {
    return describeZodType(schema);
  }
}

function describeZodType(schema: z.ZodTypeAny, depth = 0): string {
  const indent = "  ".repeat(depth);

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const lines = Object.entries(shape).map(
      ([key, value]) => `${indent}  "${key}": ${describeZodType(value, depth + 1)}`,
    );
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  if (schema instanceof z.ZodArray) {
    return `array of ${describeZodType(schema.element, depth)}`;
  }
  if (schema instanceof z.ZodEnum) {
    return `one of ${JSON.stringify(schema.options)}`;
  }
  if (schema instanceof z.ZodString) {
    return "string" + (schema.description ? ` (${schema.description})` : "");
  }
  if (schema instanceof z.ZodNumber) {
    return "number" + (schema.description ? ` (${schema.description})` : "");
  }
  if (schema instanceof z.ZodBoolean) {
    return "boolean";
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return `${describeZodType(schema.unwrap(), depth)} | null (optional)`;
  }
  return "any";
}
