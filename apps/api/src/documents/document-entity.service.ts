import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const DOCUMENT_ENTITY_TYPES = ["POLICY", "INVESTMENT", "LOAN", "PROPERTY", "INCOME", "TAX", "BUSINESS"] as const;
export type DocumentEntityTypeName = (typeof DOCUMENT_ENTITY_TYPES)[number];

// The kinds of document the platform understands (spec §29). Stored as a plain string and
// checked here, so adding a kind never needs a database migration.
export const DOCUMENT_TYPES = [
  "POLICY_PDF", "PREMIUM_RECEIPT", "NOMINEE_PROOF", "CAS", "EPF_PASSBOOK", "NPS_STATEMENT",
  "LOAN_SANCTION_LETTER", "LOAN_SCHEDULE", "SALE_DEED", "TAX_RECEIPT", "RENT_AGREEMENT",
  "SALARY_SLIP", "FORM_16", "ITR", "PROOF_80C", "PROOF_80D", "GST_RETURN", "INVOICE", "OTHER",
] as const;
export type DocumentTypeName = (typeof DOCUMENT_TYPES)[number];

export interface EntityLink {
  entityType: DocumentEntityTypeName | null;
  entityId: string | null;
}

// Validates and authorizes document <-> entity links. The critical rule: a document can only
// be linked to a record that belongs to the SAME user. Without this check a user could attach
// their document to someone else's policy id (an IDOR) and, through RAG/discrepancy features,
// start to learn things about it.
@Injectable()
export class DocumentEntityService {
  constructor(private prisma: PrismaService) {}

  /** Both fields or neither; every non-null link must point at a record the user owns. */
  async validateLink(userId: string, entityType: string | null | undefined, entityId: string | null | undefined): Promise<EntityLink> {
    const hasType = entityType !== undefined && entityType !== null;
    const hasId = entityId !== undefined && entityId !== null && entityId !== "";
    if (!hasType && !hasId) return { entityType: null, entityId: null };
    if (hasType !== hasId) throw new BadRequestException("entityType and entityId must be provided together");
    if (!DOCUMENT_ENTITY_TYPES.includes(entityType as DocumentEntityTypeName)) {
      throw new BadRequestException("Unsupported entityType");
    }
    await this.assertOwned(userId, entityType as DocumentEntityTypeName, entityId as string);
    return { entityType: entityType as DocumentEntityTypeName, entityId: entityId as string };
  }

  validateDocumentType(documentType: string | null | undefined): string | null {
    if (documentType === undefined || documentType === null || documentType === "") return null;
    if (!DOCUMENT_TYPES.includes(documentType as DocumentTypeName)) {
      throw new BadRequestException("Unsupported documentType");
    }
    return documentType;
  }

  // One ownership lookup per type. The userId is part of every query, and a miss is reported as
  // NotFound whether the id doesn't exist or belongs to someone else, so ids can't be probed.
  async assertOwned(userId: string, type: DocumentEntityTypeName, id: string): Promise<void> {
    const c = this.prisma.client;
    const where = { id, userId };
    const select = { id: true };
    let found: { id: string } | null;
    switch (type) {
      case "POLICY": found = await c.insurancePolicy.findFirst({ where, select }); break;
      case "INVESTMENT": found = await c.investment.findFirst({ where, select }); break;
      case "LOAN": found = await c.loan.findFirst({ where, select }); break;
      case "PROPERTY": found = await c.property.findFirst({ where, select }); break;
      case "INCOME": found = await c.income.findFirst({ where, select }); break;
      case "TAX": found = await c.taxDeduction.findFirst({ where, select }); break;
      case "BUSINESS": found = await c.business.findFirst({ where, select }); break;
    }
    if (!found) throw new NotFoundException("The linked record was not found");
  }
}
