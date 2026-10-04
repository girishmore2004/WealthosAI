import { detectFileType, extensionFor } from "../src/documents/file-signature.util";
import { RedactionService } from "../src/ai/gateway/redaction.service";

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe("file signature detection", () => {
  it("recognizes real PDF / JPEG / PNG / WEBP / DOC / DOCX content", () => {
    expect(detectFileType(Buffer.from("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(detectFileType(buf(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectFileType(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectFileType(Buffer.concat([Buffer.from("RIFF"), buf(0, 0, 0, 0), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(detectFileType(buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe("application/msword");
    expect(detectFileType(Buffer.concat([buf(0x50, 0x4b, 0x03, 0x04), Buffer.from("....word/document.xml")]))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("rejects HTML/script/SVG payloads and arbitrary zips posing as documents", () => {
    expect(detectFileType(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectFileType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='x()'/>"))).toBeNull();
    expect(detectFileType(Buffer.concat([buf(0x50, 0x4b, 0x03, 0x04), Buffer.from("payload.exe")]))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });

  it("derives the stored extension from the detected type", () => {
    expect(extensionFor("application/pdf")).toBe(".pdf");
    expect(extensionFor("image/jpeg")).toBe(".jpg");
  });
});

describe("RedactionService — identifiers that must not reach the model", () => {
  const r = new RedactionService();
  const text = (s: string) => r.redact(s).text;

  it("still redacts the original categories", () => {
    expect(text("PAN ABCDE1234F")).toContain("[redacted-pan]");
    expect(text("reach me at a.b@example.com")).toContain("[redacted-email]");
  });
  it("redacts IFSC, GSTIN, UPI handles and bank account numbers", () => {
    expect(text("IFSC HDFC0001234")).toContain("[redacted-ifsc]");
    expect(text("GSTIN 27ABCDE1234F1Z5")).toContain("[redacted-gstin]");
    expect(text("paid to ramesh@okhdfc")).toContain("[redacted-upi]");
    expect(text("credited to 123456789012345")).not.toMatch(/123456789012345/);
  });
  it("redacts labelled policy / account / folio numbers but keeps the label readable", () => {
    const out = text("Policy no: LIC98765432 renews in March. Folio number 1234567/89.");
    expect(out).toContain("Policy no: [redacted-id]");
    expect(out).toContain("[redacted-id]");
    expect(out).not.toMatch(/LIC98765432|1234567\/89/);
  });
  it("leaves ordinary financial prose and amounts alone", () => {
    const s = "I invested 10000 rupees this month and my rent was 15000.";
    expect(text(s)).toBe(s);
  });
});
