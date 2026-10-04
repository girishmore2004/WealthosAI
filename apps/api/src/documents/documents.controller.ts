import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import { DocumentsService, MAX_DOCUMENT_SIZE_BYTES } from "./documents.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";
import { UpdateDocumentDto } from "./dto/update-document.dto";
import { ResolveDiscrepancyDto } from "./dto/resolve-discrepancy.dto";
import { DocumentReconciliationService } from "./document-reconciliation.service";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("documents")
export class DocumentsController {
  constructor(
    private documentsService: DocumentsService,
    private reconciliation: DocumentReconciliationService,
  ) {}

  // Upload runs OCR inline (see DocumentsService/MockOcrAdapter) and writes to disk, so
  // it's the most expensive write in the app today — rate-limited to 30/hour/user to
  // absorb accidental retry storms or scripted abuse without needing a full global
  // throttle yet. See README "Rate limiting" for the broader rollout plan.
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit(30, 3600)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } }))
  upload(@CurrentUser() user: User, @UploadedFile() file: Express.Multer.File, @Body() dto: UploadDocumentDto) {
    return this.documentsService.upload(user.id, file, dto);
  }

  @Get()
  list(@CurrentUser() user: User, @Query("category") category?: string) {
    return this.documentsService.list(user.id, category);
  }

  // NEW: every document linked to one record (e.g. a policy's PDF and premium receipts).
  @Get("by-entity")
  byEntity(@CurrentUser() user: User, @Query("entityType") entityType: string, @Query("entityId") entityId: string) {
    return this.documentsService.listByEntity(user.id, entityType, entityId);
  }

  // NEW: open conflicts between document-extracted values and the database.
  @Get("discrepancies")
  discrepancies(@CurrentUser() user: User) {
    return this.reconciliation.listOpen(user.id);
  }

  @Post("discrepancies/:id/resolve")
  @UseGuards(RateLimitGuard)
  @RateLimit(60, 3600)
  resolveDiscrepancy(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: ResolveDiscrepancyDto) {
    return this.reconciliation.resolve(user.id, id, dto.resolution);
  }

  // Re-run the document-vs-database check, e.g. after correcting the policy.
  @Post(":id/reconcile")
  @UseGuards(RateLimitGuard)
  @RateLimit(30, 3600)
  reconcile(@CurrentUser() user: User, @Param("id") id: string) {
    return this.reconciliation.reconcile(user.id, id);
  }

  @Get("expiring")
  expiringSoon(@CurrentUser() user: User, @Query("withinDays") withinDays?: string) {
    return this.documentsService.expiringSoon(user.id, withinDays ? parseInt(withinDays, 10) : undefined);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateDocumentDto) {
    return this.documentsService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.documentsService.remove(user.id, id);
  }

  @Get(":id/download")
  async download(@CurrentUser() user: User, @Param("id") id: string, @Res() res: Response) {
    const { buffer, fileName, mimeType } = await this.documentsService.download(user.id, id);
    res.set({
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Content-Length": buffer.length,
    });
    res.send(buffer);
  }
}
