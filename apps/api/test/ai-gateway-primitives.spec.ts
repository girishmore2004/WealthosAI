import { RedactionService } from "../src/ai/gateway/redaction.service";
import { TokenBudgetService } from "../src/ai/gateway/token-budget.service";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { z } from "zod";

describe("RedactionService", () => {
  const service = new RedactionService();

  it("redacts an email address and reports the rule that fired", () => {
    const { text, redactedTypes } = service.redact("reach me at girissh@example.com anytime");
    expect(text).not.toContain("girissh@example.com");
    expect(text).toContain("[redacted-email]");
    expect(redactedTypes).toContain("email");
  });

  it("redacts a 10-digit Indian mobile number", () => {
    const { text, redactedTypes } = service.redact("call me on 9876543210 please");
    expect(text).toContain("[redacted-phone]");
    expect(redactedTypes).toContain("phone");
  });

  it("redacts a PAN-shaped string", () => {
    const { text, redactedTypes } = service.redact("my PAN is ABCDE1234F for the filing");
    expect(text).toContain("[redacted-pan]");
    expect(redactedTypes).toContain("pan");
  });

  it("leaves ordinary financial prose with no PII-shaped substrings untouched", () => {
    const input = "My monthly SIP is 15000 rupees and my goal is a house down payment.";
    const { text, redactedTypes } = service.redact(input);
    expect(text).toBe(input);
    expect(redactedTypes).toEqual([]);
  });
});

describe("TokenBudgetService", () => {
  const service = new TokenBudgetService();

  it("estimates roughly 4 characters per token", () => {
    expect(service.estimateTokens("a".repeat(400))).toBe(100);
  });

  it("returns text unchanged when it already fits the budget", () => {
    const { text, wasTrimmed } = service.trimToBudget("short text", 1000);
    expect(text).toBe("short text");
    expect(wasTrimmed).toBe(false);
  });

  it("trims from the middle, keeping head and tail, when over budget", () => {
    const long = "HEAD-" + "x".repeat(5000) + "-TAIL";
    const { text, wasTrimmed } = service.trimToBudget(long, 100);
    expect(wasTrimmed).toBe(true);
    expect(text.startsWith("HEAD-")).toBe(true);
    expect(text.endsWith("-TAIL")).toBe(true);
    expect(text.length).toBeLessThan(long.length);
  });
});

describe("SchemaValidatorService", () => {
  const service = new SchemaValidatorService();
  const schema = z.object({ result: z.object({ label: z.enum(["a", "b"]) }), confidence: z.number() });

  it("accepts well-formed JSON matching the schema", () => {
    const attempt = service.parse(schema, JSON.stringify({ result: { label: "a" }, confidence: 0.9 }));
    expect(attempt.ok).toBe(true);
    expect(attempt.data?.result.label).toBe("a");
  });

  it("rejects invalid JSON with a clear issue message", () => {
    const attempt = service.parse(schema, "not json at all");
    expect(attempt.ok).toBe(false);
    expect(attempt.issues?.[0]).toMatch(/not valid JSON/i);
  });

  it("rejects JSON that doesn't match the schema, with a path-qualified issue", () => {
    const attempt = service.parse(schema, JSON.stringify({ result: { label: "z" }, confidence: 0.9 }));
    expect(attempt.ok).toBe(false);
    expect(attempt.issues?.[0]).toContain("result.label");
  });

  it("describes an object schema in a readable form for the system prompt", () => {
    const description = service.describe(schema);
    expect(description).toContain('"label"');
    expect(description).toContain("confidence");
  });
});
