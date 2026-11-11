import { openAiParamStyle } from "../../src/ai/groq/groq.client";

describe("OpenAI request compatibility", () => {
  it("keeps the original parameters for Groq and for classic OpenAI chat models", () => {
    expect(openAiParamStyle("https://api.groq.com/openai/v1", "openai/gpt-oss-20b", 0.2, 500)).toEqual({ temperature: 0.2, max_tokens: 500 });
    expect(openAiParamStyle("https://api.openai.com/v1", "gpt-4o-mini", 0.2, 500)).toEqual({ temperature: 0.2, max_tokens: 500 });
  });
  it("uses max_completion_tokens and no temperature for OpenAI reasoning-era models", () => {
    expect(openAiParamStyle("https://api.openai.com/v1", "gpt-5-mini", 0.2, 500)).toEqual({ max_completion_tokens: 500 });
    expect(openAiParamStyle("https://api.openai.com/v1", "o3-mini", 0.2, 500)).toEqual({ max_completion_tokens: 500 });
  });
});
