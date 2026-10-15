import { z } from "zod";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";

describe("SchemaValidatorService single-element array unwrap", () => {
  const validator = new SchemaValidatorService();
  const schema = z.object({ hasEvidence: z.boolean(), answer: z.string(), citedIndices: z.array(z.number()) });
  const obj = { hasEvidence: true, answer: "x", citedIndices: [0] };

  it("accepts the object as is", () => {
    expect(validator.parse(schema, JSON.stringify(obj)).ok).toBe(true);
  });

  it("unwraps an object the model wrapped in a one-element array", () => {
    const res = validator.parse(schema, JSON.stringify([obj]));
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(obj);
  });

  it("still rejects a multi-element array or a wrapped object that fails the schema", () => {
    expect(validator.parse(schema, JSON.stringify([obj, obj])).ok).toBe(false);
    expect(validator.parse(schema, JSON.stringify([{ foo: 1 }])).ok).toBe(false);
  });

  it("leaves schemas that expect an array alone", () => {
    expect(validator.parse(z.array(z.number()), "[1]").data).toEqual([1]);
  });
});
