import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { DocumentStorageAdapter } from "./document-storage.adapter";

// Files are written under STORAGE_ROOT with a random UUID filename — the original
// fileName is only ever stored as metadata in the Document row, never used as the
// on-disk path, so there's no path-traversal risk from a malicious upload name.
const STORAGE_ROOT = process.env.DOCUMENT_STORAGE_PATH ?? path.resolve(process.cwd(), "storage", "documents");

@Injectable()
export class LocalDiskStorageAdapter implements DocumentStorageAdapter {
  private readonly logger = new Logger("LocalDiskStorage");

  private async ensureRoot() {
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
  }

  async save(buffer: Buffer, suggestedFileName: string): Promise<string> {
    await this.ensureRoot();
    const ext = path.extname(suggestedFileName).slice(0, 10); // cap a pathological extension length
    const storageKey = `${randomUUID()}${ext}`;
    await fs.writeFile(path.join(STORAGE_ROOT, storageKey), buffer);
    this.logger.log(`Stored document as ${storageKey}`);
    return storageKey;
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(path.join(STORAGE_ROOT, storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(path.join(STORAGE_ROOT, storageKey), { force: true });
  }
}
