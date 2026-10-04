import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { comparePolicyFacts, extractPolicyFacts, extractionCoverage } from "./extraction/policy-extractor";

export interface ReconciliationResult {
  supported: boolean;
  fieldsExtracted: string[];
  created: number;
  updated: number;
  closed: number;
}

const NOT_SUPPORTED: ReconciliationResult = { supported: false, fieldsExtracted: [], created: 0, updated: 0, closed: 0 };

// Compares facts extracted from a linked document with the authoritative record and records
// any conflict as a DocumentDiscrepancy. It NEVER updates the policy (or any other record):
// OCR is fallible, so the database stays authoritative until the user decides.
//
// Idempotent: one discrepancy row per (document, entity, field). Re-running refreshes an OPEN
// row, leaves a row the user already resolved alone (unless the document value changed), and
// closes an OPEN row once the database and document agree.
@Injectable()
export class DocumentReconciliationService {
  private readonly logger = new Logger(DocumentReconciliationService.name);

  constructor(private prisma: PrismaService) {}

  async reconcile(userId: string, documentId: string, ocrConfidence?: number): Promise<ReconciliationResult> {
    const db = this.prisma.client;
    const doc = await db.document.findFirst({ where: { id: documentId, userId } });
    if (!doc) throw new NotFoundException("Document not found");

    // Only linked policy documents with extracted text are supported so far. Everything else
    // is reported as unsupported rather than silently ignored.
    if (doc.entityType !== "POLICY" || !doc.entityId || !doc.ocrText) return NOT_SUPPORTED;

    const policy = await db.insurancePolicy.findFirst({ where: { id: doc.entityId, userId } });
    if (!policy) return NOT_SUPPORTED; // link points at a record that no longer exists

    const facts = extractPolicyFacts(doc.ocrText);
    const coverage = extractionCoverage(facts);
    await db.document.update({
      where: { id: doc.id },
      data: {
        extractionConfidence: coverage.ratio,
        // No values here — only which fields were found and the OCR engine's own confidence.
        extractionMetadata: { extractor: "policy-v1", fieldsFound: coverage.found, ocrConfidence: ocrConfidence ?? null },
      },
    });

    const { discrepancies, matching } = comparePolicyFacts(facts, {
      premiumAmount: policy.premiumAmount.toString(),
      coverageAmount: policy.coverageAmount.toString(),
      renewalDate: policy.renewalDate,
    });

    const existing = await db.documentDiscrepancy.findMany({ where: { documentId: doc.id, entityType: "POLICY", entityId: policy.id } });
    const byField = new Map(existing.map((e) => [e.field, e]));
    let created = 0;
    let updated = 0;
    let closed = 0;

    for (const d of discrepancies) {
      const prev = byField.get(d.field);
      if (!prev) {
        await db.documentDiscrepancy.create({
          data: { userId, documentId: doc.id, entityType: "POLICY", entityId: policy.id, field: d.field, documentValue: d.documentValue, databaseValue: d.databaseValue },
        });
        created += 1;
      } else if (prev.documentValue !== d.documentValue || prev.databaseValue !== d.databaseValue) {
        // Something changed since it was recorded: refresh and reopen it for review.
        await db.documentDiscrepancy.update({
          where: { id: prev.id },
          data: { documentValue: d.documentValue, databaseValue: d.databaseValue, status: "OPEN", resolvedAt: null },
        });
        updated += 1;
      }
    }

    for (const field of matching) {
      const prev = byField.get(field);
      if (prev && prev.status === "OPEN") {
        await db.documentDiscrepancy.update({ where: { id: prev.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
        closed += 1;
      }
    }

    this.logger.log(`Reconciled document ${doc.id}: ${created} new, ${updated} updated, ${closed} closed`);
    return { supported: true, fieldsExtracted: coverage.found, created, updated, closed };
  }

  listOpen(userId: string) {
    return this.prisma.client.documentDiscrepancy.findMany({ where: { userId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
  }

  /** The user's decision on a discrepancy. Neither choice edits the underlying record. */
  async resolve(userId: string, id: string, resolution: "KEEP_DATABASE" | "DISMISS") {
    const res = await this.prisma.client.documentDiscrepancy.updateMany({
      where: { id, userId, status: "OPEN" }, // ownership + state enforced in the write itself
      data: { status: resolution === "KEEP_DATABASE" ? "KEPT_DATABASE" : "DISMISSED", resolvedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException("Open discrepancy not found");
    return { resolved: true };
  }
}
