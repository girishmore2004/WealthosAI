// Verifies an uploaded file's real type from its leading bytes. The browser-declared
// Content-Type (multer's `mimetype`) and the filename are attacker-controlled, so trusting
// them lets a script or HTML payload be stored — and later served back — dressed as a PDF or
// image. The detected type must match the declared one.

export type DetectedType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "application/msword" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const startsWith = (b: Buffer, bytes: number[], offset = 0): boolean =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);

export function detectFileType(buffer: Buffer): DetectedType | null {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/msword"; // OLE2
  // .docx is a ZIP container; require the OOXML marker rather than accepting any zip.
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) && buffer.subarray(0, 4096).includes(Buffer.from("word/"))) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

const EXTENSION: Record<DetectedType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

/** The on-disk extension comes from the DETECTED type, never from the client's filename. */
export const extensionFor = (type: DetectedType): string => EXTENSION[type];
