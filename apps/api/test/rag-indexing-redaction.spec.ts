import { RagIndexingService } from "../src/ai/rag/indexing/rag-indexing.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";

describe("RagIndexingService — sensitive identifiers never enter the index", () => {
  it("redacts PAN / account numbers from document OCR text and coach history before indexing", async () => {
    const prisma = {
      client: {
        document: { findMany: jest.fn().mockResolvedValue([{ id: "d1", summary: "PAN card", ocrText: "Name: A B. PAN ABCDE1234F. Account 123456789012345", fileName: "pan.png", category: "PAN", tags: [], createdAt: new Date() }]) },
        coachInteraction: { findMany: jest.fn().mockResolvedValue([{ id: "c1", question: "my policy no: LIC98765432 renew?", answer: "ok", matchedIntent: null, createdAt: new Date() }]) },
        alert: { findMany: jest.fn().mockResolvedValue([]) },
      },
    };
    const svc = new RagIndexingService(prisma as never, {} as never, {} as never, { registerHandler: jest.fn() } as never, {} as never, { getSummary: jest.fn().mockRejectedValue(new Error("x")) } as never, new RedactionService());

    const sources = await (svc as unknown as { gatherSources(u: string): Promise<Array<{ sourceType: string; text: string }>> }).gatherSources("user-1");

    const all = sources.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/ABCDE1234F|123456789012345|LIC98765432/);
    expect(all).toContain("[redacted-pan]");
    expect(sources.some((s) => s.sourceType === "DOCUMENT")).toBe(true);
  });
});
