// WealthOS AI - load the 7-year demo life into ONE user's account.
//
//   npm run db:seed:demo -- --email you@example.com --confirm WIPE-AND-SEED
//
// What it does, in one transaction (all or nothing):
//   1. finds the user with that email (creates it if it does not exist yet),
//   2. DELETES that user's financial data: income, expenses, investments and their ledgers,
//      emergency fund, loans, property, insurance, business, goals, receivables, transfers,
//      tax entries, budgets, alerts, AI search index, coach plans and saved scenarios,
//   3. inserts the dataset from demo/demo-dataset.ts (7 years, month by month).
//
// It never touches other users, the user's login sessions, the shared category list (new
// categories are only added if missing), or anything outside this user's own rows.
//
// Options
//   --email <address>     required. The account you log in with.
//   --confirm WIPE-AND-SEED   required. Without it the script only prints what it would do.
//   --as-of <ISO date>    optional. Pretend today is this date (default: now).
//   --dry-run             build and summarise the data without touching the database.
//
// Use the DIRECT database URL (not the "-pooler" one) when you run this.

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { buildDemoDataset, DemoDataset } from "./demo/demo-dataset";

const prisma = new PrismaClient();

// ---- command line ----------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

// Tables that carry a userId but must survive: login, settings, audit trail, AI call logs.
const KEEP = new Set(["Session", "OtpCode", "UserSettings", "AuditLog", "AiInteractionLog", "AiJob"]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const inr = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

async function createChunked(model: any, rows: any[], size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    await model.createMany({ data: rows.slice(i, i + size) });
  }
}

/** Plain-number summary of what the dataset adds up to (same formulas as the app). */
function summarise(d: DemoDataset) {
  const income = sum(d.incomes.map((i) => i.amount));
  const spending = sum(d.expenses.filter((e) => e.flowType === "EXPENSE").map((e) => e.amount));
  const otherOut = sum(d.expenses.filter((e) => e.flowType === "OTHER_OUTFLOW").map((e) => e.amount));
  const contributed = sum(d.cashflows.filter((c) => c.type === "CONTRIBUTION").map((c) => c.amount));
  const withdrawn = sum(d.cashflows.filter((c) => c.type === "WITHDRAWAL").map((c) => c.amount));
  const allocated = sum(d.emergencyEntries.filter((e) => e.type === "ALLOCATE").map((e) => e.amount));
  const released = sum(d.emergencyEntries.filter((e) => e.type === "WITHDRAWAL").map((e) => e.amount));
  const lent = sum(d.receivables.map((r) => r.originalAmount));
  const back = sum(d.receivables.flatMap((r) => r.repayments.map((x) => x.amount)));
  const availableCash = income - spending - otherOut - contributed + withdrawn - allocated + released - lent + back;
  const reserve = allocated - released;
  const investments = sum(d.investments.map((i) => i.currentValue));
  const property = sum(d.properties.map((p) => p.currentValue));
  const loans = sum(d.loans.map((l) => l.outstandingPrincipal));
  const receivables = lent - back;
  return {
    availableCash,
    reserve,
    investments,
    property,
    receivables,
    loans,
    netWorth: availableCash + reserve + investments + property + receivables - loans,
    income,
    spending,
  };
}

function printSummary(d: DemoDataset) {
  const s = summarise(d);
  console.log(`\nDemo life: ${d.persona.name}, ${d.persona.city}. ${d.startMonth} to ${d.endMonth} (${d.facts.months} months)`);
  console.log(`  CTC now ${inr(d.facts.currentCtc)} a year, in-hand salary ${inr(d.facts.currentMonthlyNetSalary)} a month`);
  console.log(`  ${d.incomes.length} income rows, ${d.expenses.length} expenses, ${d.cashflows.length} investment entries, ${d.valuations.length} valuations`);
  console.log(`  ${d.loans.length} loans, ${d.properties.length} property, ${d.policies.length} policies, ${d.goals.length} goals, ${d.receivables.length} receivables`);
  console.log("  Position as of today (same formulas as the app):");
  console.log(`    Available cash      ${inr(s.availableCash)}`);
  console.log(`    Emergency reserve   ${inr(s.reserve)}`);
  console.log(`    Investments         ${inr(s.investments)}`);
  console.log(`    Property            ${inr(s.property)}`);
  console.log(`    Money lent out      ${inr(s.receivables)}`);
  console.log(`    Loans outstanding   ${inr(s.loans)}`);
  console.log(`    NET WORTH           ${inr(s.netWorth)}`);
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const asOf = arg("as-of") ? new Date(arg("as-of")!) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error("--as-of must be a valid date, for example 2026-10-11");

  const dataset = buildDemoDataset(asOf);

  if (flag("dry-run")) {
    printSummary(dataset);
    console.log("\nDry run: nothing was written.");
    return;
  }
  if (!email) throw new Error("Pass --email <the address you log in with>.");
  if (arg("confirm") !== "WIPE-AND-SEED") {
    printSummary(dataset);
    console.log(`\nNothing was changed. This would DELETE all financial data for ${email} and replace it with the demo life above.`);
    console.log("Run again with  --confirm WIPE-AND-SEED  to do it.");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL ?? "";
  if (/-pooler\./.test(url)) {
    console.warn("Warning: DATABASE_URL looks like a pooled connection. If this fails, use the direct URL (no '-pooler').");
  }

  await prisma.$transaction(
    async (tx: any) => {
      // ---- categories (only add the missing ones) ---------------------------------------------
      const categoryId = new Map<string, string>();
      for (const c of dataset.categories) {
        const row = await tx.category.upsert({ where: { name: c.name }, update: {}, create: { name: c.name, type: c.type, icon: c.icon } });
        categoryId.set(c.name, row.id);
      }

      // ---- user and household ------------------------------------------------------------------
      let user = await tx.user.findUnique({ where: { email } });
      let householdId: string | null = user?.householdId ?? null;
      if (!householdId) {
        householdId = (await tx.household.create({ data: { name: dataset.household.name } })).id;
      } else {
        await tx.household.update({ where: { id: householdId }, data: { name: dataset.household.name } });
      }
      if (user) {
        user = await tx.user.update({
          where: { id: user.id },
          data: { name: dataset.persona.name, dateOfBirth: dataset.persona.dateOfBirth, taxRegime: "NEW", riskProfile: "MODERATE", householdId },
        });
      } else {
        user = await tx.user.create({
          data: { email, name: dataset.persona.name, dateOfBirth: dataset.persona.dateOfBirth, role: "OWNER", taxRegime: "NEW", riskProfile: "MODERATE", householdId },
        });
      }
      const userId: string = user.id;

      // ---- wipe this user's financial data ------------------------------------------------------
      const models = Prisma.dmmf.datamodel.models
        .filter((m: any) => m.fields.some((f: any) => f.name === "userId" && f.kind === "scalar") && !KEEP.has(m.name))
        .map((m: any) => m.name as string)
        .sort((a: string, b: string) => (a === "ReceivableRepayment" ? -1 : b === "ReceivableRepayment" ? 1 : 0));
      for (const name of models) {
        const delegate = tx[lowerFirst(name)];
        if (delegate?.deleteMany) await delegate.deleteMany({ where: { userId } });
      }
      await tx.dependent.deleteMany({ where: { householdId } });

      // ---- dependents -----------------------------------------------------------------------------
      const dependentId = new Map<string, string>();
      for (const dep of dataset.dependents) {
        const row = await tx.dependent.create({ data: { householdId, name: dep.name, relation: dep.relation, dateOfBirth: dep.dateOfBirth } });
        dependentId.set(dep.name, row.id);
      }

      // ---- goals ---------------------------------------------------------------------------------
      const goalId = new Map<string, string>();
      const goalRows = dataset.goals.map((g) => {
        const id = randomUUID();
        goalId.set(g.key, id);
        return { id, userId, type: g.type, name: g.name, targetAmount: g.targetAmount, targetDate: g.targetDate, currentAmount: g.currentAmount, monthlyContribution: g.monthlyContribution, assumedAnnualReturnPercent: g.assumedAnnualReturnPercent };
      });
      await createChunked(tx.goal, goalRows);

      // ---- income (ids first so the business ledger can point at the rows it synced) ---------------
      const incomeId = new Map<string, string>();
      for (const i of dataset.incomes) incomeId.set(i.key, randomUUID());
      const syncedIncomeByTx = new Map<string, string>();
      for (const i of dataset.incomes) if (i.businessTransactionKey) syncedIncomeByTx.set(i.businessTransactionKey, incomeId.get(i.key)!);
      await createChunked(
        tx.income,
        dataset.incomes.map((i) => ({
          id: incomeId.get(i.key),
          userId,
          source: i.source,
          label: i.label,
          amount: i.amount,
          recurrence: i.recurrence,
          receivedAt: i.receivedAt,
          notes: i.notes,
          recurrenceActive: false,
          generatedFromRecurringId: i.templateKey ? incomeId.get(i.templateKey) : null,
        })),
      );

      // ---- expenses ---------------------------------------------------------------------------------
      await createChunked(
        tx.expense,
        dataset.expenses.map((e) => ({
          userId,
          categoryId: categoryId.get(e.categoryName),
          merchant: e.merchant,
          amount: e.amount,
          spentAt: e.spentAt,
          paymentMethod: e.paymentMethod,
          notes: e.notes,
          isRecurring: e.isRecurring,
          flowType: e.flowType,
        })),
      );

      // ---- investments, ledger and valuations -----------------------------------------------------
      const investmentId = new Map<string, string>();
      const investmentRows = dataset.investments.map((i) => {
        const id = randomUUID();
        investmentId.set(i.key, id);
        return {
          id,
          userId,
          type: i.type,
          name: i.name,
          currentValue: i.currentValue,
          costBasis: i.costBasis,
          purchaseDate: i.purchaseDate,
          riskLevel: i.riskLevel,
          liquidity: i.liquidity,
          goalId: i.goalKey ? goalId.get(i.goalKey) : null,
          notes: i.notes,
          sipActive: i.sipActive,
          monthlyContribution: i.monthlyContribution,
          contributionDay: i.contributionDay,
          contributionStartDate: i.contributionStartDate,
          contributionFrequency: "MONTHLY",
          expectedAnnualReturn: i.expectedAnnualReturn,
        };
      });
      await createChunked(tx.investment, investmentRows);
      await createChunked(
        tx.investmentCashflow,
        dataset.cashflows.map((c) => ({
          userId,
          investmentId: investmentId.get(c.investmentKey),
          type: c.type,
          amount: c.amount,
          occurredAt: c.occurredAt,
          periodKey: c.periodKey,
          origin: "DEMO_SEED",
          notes: c.notes,
        })),
      );
      await createChunked(
        tx.investmentValuation,
        dataset.valuations
          .filter((v) => investmentId.has(v.investmentKey))
          .map((v) => ({ userId, investmentId: investmentId.get(v.investmentKey), value: v.value, valuedAt: v.valuedAt, origin: "DEMO_SEED" })),
      );

      // ---- emergency fund ---------------------------------------------------------------------------
      await createChunked(
        tx.emergencyFundEntry,
        dataset.emergencyEntries.map((e) => ({ userId, type: e.type, amount: e.amount, occurredAt: e.occurredAt, origin: "DEMO_SEED", reason: e.reason, notes: e.notes })),
      );
      await tx.emergencyFundPlan.create({
        data: { userId, targetMonths: dataset.emergencyPlan.targetMonths, monthlyContribution: dataset.emergencyPlan.monthlyContribution, targetDate: dataset.emergencyPlan.targetDate },
      });

      // ---- loans, insurance, property ----------------------------------------------------------------
      const loanId = new Map<string, string>();
      await createChunked(
        tx.loan,
        dataset.loans.map((l) => {
          const id = randomUUID();
          loanId.set(l.key, id);
          return { id, userId, type: l.type, lender: l.lender, principal: l.principal, outstandingPrincipal: l.outstandingPrincipal, interestRateAnnual: l.interestRateAnnual, tenureMonths: l.tenureMonths, emiAmount: l.emiAmount, startDate: l.startDate, notes: l.notes };
        }),
      );
      const policyId = new Map<string, string>();
      await createChunked(
        tx.insurancePolicy,
        dataset.policies.map((p) => {
          const id = randomUUID();
          policyId.set(p.key, id);
          return {
            id,
            userId,
            type: p.type,
            provider: p.provider,
            policyNumber: p.policyNumber,
            premiumAmount: p.premiumAmount,
            premiumFrequency: p.premiumFrequency,
            coverageAmount: p.coverageAmount,
            renewalDate: p.renewalDate,
            nomineeName: p.nomineeName,
            nomineeDependentId: p.nomineeDependentName ? dependentId.get(p.nomineeDependentName) ?? null : null,
            notes: p.notes,
          };
        }),
      );
      await createChunked(
        tx.property,
        dataset.properties.map((p) => ({
          userId,
          type: p.type,
          name: p.name,
          address: p.address,
          currentValue: p.currentValue,
          purchasePrice: p.purchasePrice,
          purchaseDate: p.purchaseDate,
          isRented: false,
          annualMaintenanceCost: p.annualMaintenanceCost,
          annualPropertyTax: p.annualPropertyTax,
          loanId: loanId.get(p.loanKey),
          insurancePolicyId: policyId.get(p.policyKey),
          notes: p.notes,
        })),
      );

      // ---- business -------------------------------------------------------------------------------------
      const business = await tx.business.create({
        data: { userId, name: dataset.business.name, description: dataset.business.description, entityType: dataset.business.entityType, startedAt: dataset.business.startedAt, ownershipPercent: dataset.business.ownershipPercent },
      });
      await createChunked(
        tx.businessTransaction,
        dataset.businessTransactions.map((t) => ({
          businessId: business.id,
          type: t.type,
          category: t.category,
          amount: t.amount,
          occurredAt: t.occurredAt,
          description: t.description,
          isRecurring: t.isRecurring,
          syncedIncomeId: syncedIncomeByTx.get(t.key) ?? null,
        })),
      );
      await createChunked(
        tx.businessObligation,
        dataset.businessObligations.map((o) => ({ businessId: business.id, title: o.title, dueDate: o.dueDate, amount: o.amount, recurrence: o.recurrence, vendor: o.vendor, status: o.status, notes: o.notes })),
      );

      // ---- money lent, transfers ----------------------------------------------------------------------------
      for (const r of dataset.receivables) {
        const rec = await tx.receivable.create({
          data: { userId, person: r.person, purpose: r.purpose, originalAmount: r.originalAmount, givenAt: r.givenAt, expectedReturnAt: r.expectedReturnAt, status: r.status, paymentMethod: r.paymentMethod, notes: r.notes },
        });
        if (r.repayments.length) {
          await tx.receivableRepayment.createMany({
            data: r.repayments.map((p) => ({ userId, receivableId: rec.id, amount: p.amount, returnedAt: p.returnedAt, paymentMethod: r.paymentMethod, notes: p.notes })),
          });
        }
      }
      await createChunked(
        tx.accountTransfer,
        dataset.transfers.map((t) => ({ userId, fromAccount: t.fromAccount, toAccount: t.toAccount, amount: t.amount, transferredAt: t.transferredAt, notes: t.notes })),
      );

      // ---- tax, retirement, budgets -----------------------------------------------------------------------------
      await createChunked(tx.taxDeduction, dataset.taxDeductions.map((t) => ({ userId, section: t.section, description: t.description, amount: t.amount, financialYear: t.financialYear })));
      await tx.retirementProfile.create({ data: { userId, ...dataset.retirement } });
      await createChunked(
        tx.budget,
        dataset.budgets.map((b) => ({ userId, categoryId: categoryId.get(b.categoryName), monthlyAmount: b.monthlyAmount })),
      );
      await tx.userSettings.upsert({ where: { userId }, update: {}, create: { userId } });
    },
    { maxWait: 30_000, timeout: 240_000 },
  );

  printSummary(dataset);
  console.log(`\nDone. ${email} now has the demo life. Open the dashboard; the AI Search index was cleared, so press "Reindex" once on the AI Search page.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
