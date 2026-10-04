import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { DocumentStorageAdapter } from "./document-storage.adapter";

// Files are written under STORAGE_ROOT with a random UUID filename — the original
// fileName is only ever stored as metadata in the Document row, never used as the
// on-disk path, so there's no path-traversal risk from a malicious upload name.
const STORAGE_ROOT = process.env.DOCUMENT_STORAGE_PATH ?? path.resolve(process.cwd(), "storage", "documents");

// Defence in depth: keys are generated server-side, but read/delete still refuse anything
// that resolves outside STORAGE_ROOT, so a corrupted or tampered key can never reach another
// file on disk.
function resolveInsideRoot(storageKey: string): string {
  const root = path.resolve(STORAGE_ROOT);
  const full = path.resolve(root, storageKey);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return full;
}

@Injectable()
export class LocalDiskStorageAdapter implements DocumentStorageAdapter {
  private readonly logger = new Logger("LocalDiskStorage");

  private async ensureRoot() {
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
  }

  async save(buffer: Buffer, suggestedFileName: string): Promise<string> {
    await this.ensureRoot();
    // Only a short, plain alphanumeric extension is ever kept (callers pass a type-derived name).
    const rawExt = path.extname(suggestedFileName);
    const ext = /^\.[a-z0-9]{1,8}$/i.test(rawExt) ? rawExt.toLowerCase() : "";
    const storageKey = `${randomUUID()}${ext}`;
    await fs.writeFile(resolveInsideRoot(storageKey), buffer, { mode: 0o600 });
    this.logger.log(`Stored document as ${storageKey}`);
    return storageKey;
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(resolveInsideRoot(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(resolveInsideRoot(storageKey), { force: true });
  }
}
