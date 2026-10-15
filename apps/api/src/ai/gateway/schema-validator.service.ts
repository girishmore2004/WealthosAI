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

    // Models sometimes wrap the one object they were asked for in a single-element array ("[{...}]"). That is
    // the same answer in a different envelope: unwrap it instead of failing the attempt, because a failed
    // attempt costs a whole extra model call (20s+ on a slow provider) and can exhaust the stage timeout.
    // Applies only to a one-element array, and only when the unwrapped element then passes the schema.
    if (Array.isArray(json) && json.length === 1) {
      const unwrapped = schema.safeParse(json[0]);
      if (unwrapped.success) return { ok: true, data: unwrapped.data };
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
    return describeString(schema, schema.description);
  }
  if (schema instanceof z.ZodNumber) {
    return "number" + (schema.description ? ` (${schema.description})` : "");
  }
  if (schema instanceof z.ZodBoolean) {
    return "boolean";
  }
  if (schema instanceof z.ZodNullable) {
    return `${describeZodType(schema.unwrap(), depth)} | null`;
  }
  if (schema instanceof z.ZodOptional) {
    return `${describeZodType(schema.unwrap(), depth)} | null (optional)`;
  }
  if (schema instanceof z.ZodEffects) {
    // preprocess/transform/refine wrappers: describe the inner shape the model must
    // produce, keeping a description set on the wrapper itself.
    const inner = schema.innerType() as z.ZodTypeAny;
    if (inner instanceof z.ZodString) {
      return describeString(inner, schema.description ?? inner.description);
    }
    return describeZodType(inner, depth);
  }
  if (schema instanceof z.ZodRecord) {
    return `object mapping string keys to ${describeZodType(schema.valueSchema, depth)}`;
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodTypeAny[];
    return options.map((option) => describeZodType(option, depth)).join(" | ");
  }
  return "any";
}

function describeString(schema: z.ZodString, description: string | undefined): string {
  const parts: string[] = [];
  if (description) parts.push(description);
  if (schema.maxLength !== null) parts.push(`at most ${schema.maxLength} characters`);
  return "string" + (parts.length > 0 ? ` (${parts.join("; ")})` : "");
}
