import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { UpdateDocumentDto } from "./dto/update-document.dto";
import { DocumentStorageAdapter } from "./adapters/document-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { OcrAdapter } from "./adapters/ocr.adapter";
import { MockOcrAdapter } from "./adapters/mock-ocr.adapter";

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
    @Inject(MockOcrAdapter) private ocr: OcrAdapter,
  ) {}

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

    // Run OCR inline for the mock adapter (it's instant); a real adapter with network
    // latency would instead enqueue this and let the client poll ocrStatus.
    try {
      const result = await this.ocr.process(file.buffer, file.mimetype, dto.category);
      return this.prisma.client.document.update({
        where: { id: document.id },
        data: { ocrStatus: "DONE", ocrText: result.text, summary: result.summary },
      });
    } catch {
      return this.prisma.client.document.update({ where: { id: document.id }, data: { ocrStatus: "FAILED" } });
    }
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

  private async assertOwnership(userId: string, id: string) {
    const doc = await this.prisma.client.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
  }
}
