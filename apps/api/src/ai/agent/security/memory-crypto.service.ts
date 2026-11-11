import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

// Field-level encryption for sensitive agent memory (AES-256-GCM, random 96-bit IV per value, authenticated).
//
// Key: AGENT_MEMORY_ENCRYPTION_KEY — 32 bytes, as 64 hex characters or base64. It is never logged and never stored in
// the database. Without a key:
//   * production  → sensitive memories are NOT stored (isAvailable() is false); the agent keeps working, it just
//     remembers less. Failing closed is deliberate: a financial memory must never be written in plaintext because an
//     environment variable was forgotten.
//   * non-production → plaintext is allowed so local development works without setup.
// Rotating the key makes old ciphertext unreadable (decrypt returns null and the memory is skipped), it never crashes.
@Injectable()
export class MemoryCryptoService {
  private readonly logger = new Logger(MemoryCryptoService.name);
  private readonly key: Buffer | null;
  private readonly production: boolean;

  constructor(config: ConfigService) {
    this.key = parseKey(config.get<string>("AGENT_MEMORY_ENCRYPTION_KEY") ?? process.env.AGENT_MEMORY_ENCRYPTION_KEY);
    this.production = (config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";
    if (!this.key) {
      this.logger.warn(
        this.production
          ? "AGENT_MEMORY_ENCRYPTION_KEY is not set: sensitive agent memories will not be stored."
          : "AGENT_MEMORY_ENCRYPTION_KEY is not set: sensitive agent memories are stored unencrypted (development only).",
      );
    }
  }

  /** Whether a sensitive value can be stored right now. */
  isAvailable(): boolean {
    return this.key !== null || !this.production;
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    if (!this.key) {
      if (this.production) throw new Error("Memory encryption key is not configured");
      return plain;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  /** Returns null when the value cannot be decrypted (wrong/rotated key, tampering). Never throws. */
  decrypt(stored: string): string | null {
    if (!stored.startsWith(PREFIX)) return stored;
    if (!this.key) return null;
    try {
      const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Keyed, per-user hash of normalised content: de-duplicates memories without comparing ciphertext, and without
   * letting the same text hash identically across users. */
  contentHash(userId: string, text: string): string {
    const secret = this.key ?? Buffer.from("wealthos-agent-memory-dev");
    return createHmac("sha256", secret).update(userId).update("\u0000").update(normalizeForHash(text)).digest("hex");
  }
}

export function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}₹.%]+/gu, " ").replace(/\s+/g, " ").trim();
}

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  try {
    const b = Buffer.from(v, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
