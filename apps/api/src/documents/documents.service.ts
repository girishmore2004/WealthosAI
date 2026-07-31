import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { UpdateDocumentDto } from "./dto/update-document.dto";
import { DocumentStorageAdapter } from "./adapters/document-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { AiQueueService } from "../ai/ops/ai-queue.service";

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    @Inject(LocalDiskStorageAdapter) private storage: DocumentStorageAdapter,
    private aiQueue: AiQueueService,
  ) {}

  // OCR now runs OFF the request path — closes the previously-flagged gap: running it
  // inline was only viable because the mock adapter is instant; a real OCR engine
  // (now wired in — see DocumentOcrHandler / TesseractOcrAdapter) genuinely takes real
  // time and shouldn't hold the upload request open. This method now returns as soon
  // as the file is stored and the Document row exists (ocrStatus starts, and stays,
  // PENDING until the async job completes) — the client is expected to poll GET
  // /documents (or re-fetch this specific document) to observe the transition to
  // DONE/FAILED/NOT_APPLICABLE, exactly as the code's own prior comment already
  // anticipated ("a real adapter with network latency would instead enqueue this and
  // let the client poll ocrStatus").
  //
  // idempotencyKey: document.id — enqueue() itself already guards against creating a
  // duplicate AiJob for the same key (see AiQueueService), so even if this specific
  // enqueue call were somehow retried, only one OCR job is ever actually queued per
  // uploaded document.
  async upload(userId: string, file: Express.Multer.File, dto: UploadDocumentDto) {
    if (!file) throw new BadRequestException("No file was uploaded");
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB limit`);
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} is not supported`);
    }

    const storageKey = await this.storage.save(file.buffer, file.originalname);
    const tags = dto.tags
      ? dto.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const document = await this.prisma.client.document.create({
      data: {
        userId,
        category: dto.category,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        tags,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
        ocrStatus: "PENDING",
      },
    });

    await this.aiQueue.enqueue(
      "document.ocr",
      { documentId: document.id, userId, category: dto.category },
      { userId, idempotencyKey: document.id },
    );

    return document;
  }

  list(userId: string, category?: string) {
    return this.prisma.client.document.findMany({
      where: { userId, ...(category ? { category: category as never } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  async expiringSoon(userId: string, withinDays = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);
    return this.prisma.client.document.findMany({
      where: { userId, expiryDate: { not: null, lte: cutoff, gte: new Date() } },
      orderBy: { expiryDate: "asc" },
    });
  }

  async update(userId: string, id: string, dto: UpdateDocumentDto) {
    const doc = await this.assertOwnership(userId, id);
    return this.prisma.client.document.update({
      where: { id: doc.id },
      data: { ...dto, expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined },
    });
  }

  async download(userId: string, id: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const doc = await this.assertOwnership(userId, id);
    try {
      const buffer = await this.storage.read(doc.storageKey);
      return { buffer, fileName: doc.fileName, mimeType: doc.mimeType };
    } catch (err) {
      // Covers seeded demo rows whose storageKey has no real backing file, and any
      // out-of-band deletion of the underlying file — a missing file is a 404 on the
      // resource, not a server error.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new NotFoundException("This document's file could not be found in storage");
      }
      throw err;
    }
  }

  async remove(userId: string, id: string) {
    const doc = await this.assertOwnership(userId, id);
    await this.storage.delete(doc.storageKey);
    return this.prisma.client.document.delete({ where: { id: doc.id } });
  }

  // Unified to a single NotFoundException for both "doesn't exist" and "belongs to
  // someone else" — was previously NotFoundException/ForbiddenException, the same
  // existence-oracle leak already closed for every other feature hardened this
  // session. Left as a single ownership-check-then-act call (not converted to the
  // atomic updateMany/deleteMany pattern used elsewhere): update()/remove() both need
  // the fetched row's storageKey before their own next step (writing new fields;
  // deleting the on-disk file before the DB row), so a single preliminary read is the
  // natural shape here regardless.
  private async assertOwnership(userId: string, id: string) {
    const doc = await this.prisma.client.document.findUnique({ where: { id } });
    if (!doc || doc.userId !== userId) {
      throw new NotFoundException("Document not found");
    }
    return doc;
  }
}
