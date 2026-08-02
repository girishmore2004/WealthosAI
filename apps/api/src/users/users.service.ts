import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.client.user.update({
      where: { id: userId },
      data: dto,
    });
    await this.audit.log("profile_updated", userId, { fields: Object.keys(dto) });
    return user;
  }

  // GDPR-style "export everything WealthOS AI has about you." Deliberately covers every
  // user-owned table that represents the user's own financial data, account
  // configuration, or personal usage history of a feature — not just the original
  // user/incomes/expenses subset. Read as one Promise.all rather than a single
  // $transaction: this is a point-in-time export of read-mostly data (not a financial
  // calculation that needs snapshot isolation across tables), and Promise.all keeps
  // each query independently unit-testable against the existing per-model Prisma mock
  // pattern used throughout this test suite.
  //
  // Deliberately EXCLUDED, with reasons (not an oversight):
  //  - Session, OtpCode: these hold hashed authentication secrets (tokenHash/codeHash),
  //    not user-facing data. Exporting them would be a security liability for no real
  //    transparency benefit — the user already knows their own login history without a
  //    hash dump, and active sessions are manageable elsewhere (device/session list).
  //  - AiJob: internal job-queue bookkeeping (status/retries/idempotencyKey) for the AI
  //    task runner, not content the user produced or was shown.
  //  - AiEmbeddingChunk: the RAG index's internal vector representation of the user's
  //    OWN existing data (documents, coach interactions, alerts, etc.) — re-derived,
  //    redundant with the source rows already included below, and includes raw
  //    embedding vectors that add no transparency value to a human-readable export.
  //  - AiInteractionLog: internal Groq-gateway call telemetry (latency, retries, cache
  //    hits, redacted prompt/response snippets) for ops/debugging — the user-meaningful
  //    content of each AI feature is already captured in its own first-class history
  //    table below (CoachInteraction, AgenticCoachRun, ScenarioStudioRun, AiSearchLog,
  //    IngestionBatch), so this would only duplicate that content in a less readable,
  //    partially-redacted form.
  async exportData(userId: string) {
    const [
      user,
      incomes,
      expenses,
      goals,
      investments,
      loans,
      insurancePolicies,
      taxDeductions,
      retirementProfile,
      properties,
      businesses,
      documents,
      alerts,
      budgets,
      settings,
      auditLogs,
      coachInteractions,
      savedScenarios,
      agenticCoachRuns,
      scenarioStudioRuns,
      mlInsightRuns,
      ingestionBatches,
      aiSearchLogs,
    ] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        include: { household: { include: { dependents: true } } },
      }),
      this.prisma.client.income.findMany({ where: { userId } }),
      this.prisma.client.expense.findMany({ where: { userId } }),
      this.prisma.client.goal.findMany({ where: { userId } }),
      this.prisma.client.investment.findMany({ where: { userId } }),
      this.prisma.client.loan.findMany({ where: { userId } }),
      this.prisma.client.insurancePolicy.findMany({ where: { userId } }),
      this.prisma.client.taxDeduction.findMany({ where: { userId } }),
      this.prisma.client.retirementProfile.findUnique({ where: { userId } }),
      this.prisma.client.property.findMany({ where: { userId } }),
      this.prisma.client.business.findMany({ where: { userId }, include: { transactions: true, obligations: true } }),
      this.prisma.client.document.findMany({ where: { userId } }),
      this.prisma.client.alert.findMany({ where: { userId } }),
      this.prisma.client.budget.findMany({ where: { userId } }),
      this.prisma.client.userSettings.findUnique({ where: { userId } }),
      this.prisma.client.auditLog.findMany({ where: { userId } }),
      this.prisma.client.coachInteraction.findMany({ where: { userId } }),
      this.prisma.client.savedScenario.findMany({ where: { userId } }),
      this.prisma.client.agenticCoachRun.findMany({ where: { userId } }),
      this.prisma.client.scenarioStudioRun.findMany({ where: { userId } }),
      this.prisma.client.mlInsightRun.findMany({ where: { userId } }),
      this.prisma.client.ingestionBatch.findMany({ where: { userId }, include: { items: true } }),
      this.prisma.client.aiSearchLog.findMany({ where: { userId } }),
    ]);
    await this.audit.log("data_export_requested", userId);
    return {
      user,
      incomes,
      expenses,
      goals,
      investments,
      loans,
      insurancePolicies,
      taxDeductions,
      retirementProfile,
      properties,
      businesses,
      documents,
      alerts,
      budgets,
      settings,
      auditLogs,
      coachInteractions,
      savedScenarios,
      agenticCoachRuns,
      scenarioStudioRuns,
      mlInsightRuns,
      ingestionBatches,
      aiSearchLogs,
      exportedAt: new Date().toISOString(),
    };
  }

  async deleteAccount(userId: string) {
    // Cascades remove every user-owned table with onDelete: Cascade on its userId FK —
    // sessions, otp codes, incomes, expenses, goals, investments, loans, insurance
    // policies, tax deductions, retirement profile, properties, businesses (and their
    // transactions/obligations), documents, alerts, budgets, settings, audit logs,
    // coach interactions, saved scenarios, agentic coach runs, scenario studio runs, ML
    // insight runs, ingestion batches (and their review items), and AI search logs —
    // verified schema-wide against every `@relation(fields: [userId], ...)` off User as
    // of this pass (see schema.prisma). Two tables intentionally use onDelete: SetNull
    // instead of Cascade — AiInteractionLog and AiJob — so deleting a user anonymizes
    // (rather than deletes) internal AI-ops telemetry/job-queue rows that may still be
    // needed for aggregate operational metrics; this is a deliberate existing schema
    // choice, not a gap.
    await this.prisma.client.user.delete({ where: { id: userId } });
  }
}
