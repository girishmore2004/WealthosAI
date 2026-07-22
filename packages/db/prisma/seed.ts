// Realistic Indian demo data so the product is usable without any live bank/broker integration.
import {
  PrismaClient,
  Role,
  TaxRegime,
  RiskProfile,
  CategoryType,
  IncomeSource,
  Recurrence,
  PaymentMethod,
  GoalType,
  InvestmentType,
  RiskLevel,
  Liquidity,
  LoanType,
  InsuranceType,
  TaxSection,
  PropertyType,
  BusinessTransactionType,
  BusinessEntityType,
  ObligationStatus,
  DocumentCategory,
} from "@prisma/client";

const prisma = new PrismaClient();

const SYSTEM_CATEGORIES: { name: string; type: CategoryType; icon: string }[] = [
  { name: "Groceries", type: CategoryType.NEED, icon: "shopping-cart" },
  { name: "Rent", type: CategoryType.NEED, icon: "home" },
  { name: "Utilities", type: CategoryType.NEED, icon: "zap" },
  { name: "EMI", type: CategoryType.NEED, icon: "credit-card" },
  { name: "Transport", type: CategoryType.NEED, icon: "car" },
  { name: "Healthcare", type: CategoryType.NEED, icon: "heart" },
  { name: "Dining Out", type: CategoryType.WANT, icon: "utensils" },
  { name: "Entertainment", type: CategoryType.WANT, icon: "film" },
  { name: "Shopping", type: CategoryType.WANT, icon: "bag" },
  { name: "Travel", type: CategoryType.WANT, icon: "plane" },
  { name: "SIP Investment", type: CategoryType.SAVINGS, icon: "trending-up" },
  { name: "Emergency Fund", type: CategoryType.SAVINGS, icon: "shield" },
];

async function main() {
  console.log("Seeding WealthOS AI demo data...");

  for (const cat of SYSTEM_CATEGORIES) {
    await prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: cat,
    });
  }

  const household = await prisma.household.upsert({
    where: { id: "demo-household-1" },
    update: {},
    create: {
      id: "demo-household-1",
      name: "Demo Household",
    },
  });

  const demoUser = await prisma.user.upsert({
    where: { email: "demo@wealthos.ai" },
    update: {},
    create: {
      email: "demo@wealthos.ai",
      name: "Aarav Sharma",
      phone: "+919876543210",
      dateOfBirth: new Date(1993, 5, 14),
      role: Role.OWNER,
      taxRegime: TaxRegime.NEW,
      riskProfile: RiskProfile.MODERATE,
      householdId: household.id,
    },
  });

  await prisma.dependent.upsert({
    where: { id: "demo-dependent-1" },
    update: {},
    create: {
      id: "demo-dependent-1",
      householdId: household.id,
      name: "Meera Sharma",
      relation: "Spouse",
    },
  });

  // Second household member — a working sibling sharing the household — so the
  // Household page's per-member breakdown and aggregation totals have genuinely
  // demoable multi-member data rather than a single-row household. Deliberately
  // kept lighter than the primary demo user's data (own login, but a smaller
  // financial footprint), consistent with the seed script's proportionate scope.
  const secondMember = await prisma.user.upsert({
    where: { email: "demo-member@wealthos.ai" },
    update: {},
    create: {
      email: "demo-member@wealthos.ai",
      name: "Rohan Sharma",
      phone: "+919876543211",
      dateOfBirth: new Date(1996, 2, 20),
      role: Role.MEMBER,
      taxRegime: TaxRegime.NEW,
      riskProfile: RiskProfile.CONSERVATIVE,
      householdId: household.id,
    },
  });

  const categories = await prisma.category.findMany();
  const byName = (name: string) => categories.find((c) => c.name === name)!.id;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  await prisma.income.createMany({
    data: [
      {
        userId: secondMember.id,
        source: IncomeSource.SALARY,
        label: "Monthly Salary",
        amount: 48000,
        recurrence: "MONTHLY",
        receivedAt: monthStart,
      },
    ],
    skipDuplicates: true,
  });

  await prisma.expense.createMany({
    data: [
      { userId: secondMember.id, categoryId: byName("Groceries"), merchant: "BigBasket", amount: 3200, spentAt: new Date(now.getFullYear(), now.getMonth(), 7), paymentMethod: PaymentMethod.UPI },
      { userId: secondMember.id, categoryId: byName("Entertainment"), merchant: "Netflix", amount: 649, spentAt: new Date(now.getFullYear(), now.getMonth(), 2), paymentMethod: PaymentMethod.CARD, isRecurring: true },
      { userId: secondMember.id, categoryId: byName("SIP Investment"), merchant: "Zerodha Coin", amount: 5000, spentAt: new Date(now.getFullYear(), now.getMonth(), 5), paymentMethod: PaymentMethod.BANK_TRANSFER, isRecurring: true },
    ],
    skipDuplicates: true,
  });

  await prisma.investment.upsert({
    where: { id: "demo-member-investment-1" },
    update: {},
    create: {
      id: "demo-member-investment-1",
      userId: secondMember.id,
      type: InvestmentType.MUTUAL_FUND,
      name: "UTI Nifty Index Fund",
      currentValue: 85000,
      costBasis: 70000,
      purchaseDate: new Date(2023, 3, 1),
      riskLevel: RiskLevel.MODERATE,
      liquidity: Liquidity.LIQUID,
    },
  });

  await prisma.income.createMany({
    data: [
      {
        userId: demoUser.id,
        source: IncomeSource.SALARY,
        label: "Monthly Salary",
        amount: 95000,
        recurrence: Recurrence.MONTHLY,
        receivedAt: monthStart,
      },
      {
        userId: demoUser.id,
        source: IncomeSource.FREELANCE,
        label: "Freelance UI project",
        amount: 12000,
        recurrence: Recurrence.ONE_TIME,
        receivedAt: new Date(now.getFullYear(), now.getMonth(), 5),
      },
    ],
    skipDuplicates: true,
  });

  await prisma.expense.createMany({
    data: [
      { userId: demoUser.id, categoryId: byName("Rent"), merchant: "Landlord", amount: 22000, spentAt: new Date(now.getFullYear(), now.getMonth(), 3), paymentMethod: PaymentMethod.BANK_TRANSFER, isRecurring: true },
      { userId: demoUser.id, categoryId: byName("Groceries"), merchant: "BigBasket", amount: 6200, spentAt: new Date(now.getFullYear(), now.getMonth(), 6), paymentMethod: PaymentMethod.UPI },
      { userId: demoUser.id, categoryId: byName("EMI"), merchant: "HDFC Home Loan", amount: 18500, spentAt: new Date(now.getFullYear(), now.getMonth(), 5), paymentMethod: PaymentMethod.BANK_TRANSFER, isRecurring: true },
      { userId: demoUser.id, categoryId: byName("Transport"), merchant: "Uber", amount: 2100, spentAt: new Date(now.getFullYear(), now.getMonth(), 8), paymentMethod: PaymentMethod.UPI },
      { userId: demoUser.id, categoryId: byName("Dining Out"), merchant: "Swiggy", amount: 3400, spentAt: new Date(now.getFullYear(), now.getMonth(), 9), paymentMethod: PaymentMethod.UPI },
      { userId: demoUser.id, categoryId: byName("SIP Investment"), merchant: "Zerodha Coin", amount: 15000, spentAt: new Date(now.getFullYear(), now.getMonth(), 5), paymentMethod: PaymentMethod.BANK_TRANSFER, isRecurring: true },
      { userId: demoUser.id, categoryId: byName("Entertainment"), merchant: "Netflix", amount: 649, spentAt: new Date(now.getFullYear(), now.getMonth(), 2), paymentMethod: PaymentMethod.CARD, isRecurring: true },
      { userId: demoUser.id, categoryId: byName("Utilities"), merchant: "MSEB Electricity", amount: 1850, spentAt: new Date(now.getFullYear(), now.getMonth(), 10), paymentMethod: PaymentMethod.UPI, isRecurring: true },
    ],
  });

  const emergencyGoal = await prisma.goal.upsert({
    where: { id: "demo-goal-emergency" },
    update: {},
    create: {
      id: "demo-goal-emergency",
      userId: demoUser.id,
      type: GoalType.EMERGENCY_FUND,
      name: "6-month emergency fund",
      targetAmount: 600000,
      targetDate: new Date(now.getFullYear() + 1, now.getMonth(), 1),
      currentAmount: 120000,
      monthlyContribution: 15000,
    },
  });

  await prisma.investment.createMany({
    data: [
      { userId: demoUser.id, type: InvestmentType.MUTUAL_FUND, name: "Nifty 50 Index Fund", currentValue: 185000, costBasis: 160000, purchaseDate: new Date(2023, 3, 10), riskLevel: RiskLevel.MODERATE, liquidity: Liquidity.LIQUID },
      { userId: demoUser.id, type: InvestmentType.EPF, name: "Employee Provident Fund", currentValue: 420000, costBasis: 380000, purchaseDate: new Date(2019, 5, 1), riskLevel: RiskLevel.LOW, liquidity: Liquidity.ILLIQUID },
      { userId: demoUser.id, type: InvestmentType.PPF, name: "Public Provident Fund", currentValue: 95000, costBasis: 85000, purchaseDate: new Date(2021, 0, 15), riskLevel: RiskLevel.LOW, liquidity: Liquidity.ILLIQUID },
      { userId: demoUser.id, type: InvestmentType.GOLD, name: "Sovereign Gold Bonds", currentValue: 62000, costBasis: 50000, purchaseDate: new Date(2022, 7, 20), riskLevel: RiskLevel.LOW, liquidity: Liquidity.SEMI_LIQUID },
      { userId: demoUser.id, type: InvestmentType.STOCK, name: "Direct equity portfolio", currentValue: 78000, costBasis: 90000, purchaseDate: new Date(2023, 9, 5), riskLevel: RiskLevel.HIGH, liquidity: Liquidity.LIQUID, goalId: emergencyGoal.id },
    ],
    skipDuplicates: true,
  });

  await prisma.loan.createMany({
    data: [
      { userId: demoUser.id, type: LoanType.HOME, lender: "HDFC Bank", principal: 3500000, outstandingPrincipal: 2950000, interestRateAnnual: 8.6, tenureMonths: 240, emiAmount: 18500, startDate: new Date(2021, 2, 1) },
      { userId: demoUser.id, type: LoanType.CAR, lender: "ICICI Bank", principal: 650000, outstandingPrincipal: 210000, interestRateAnnual: 9.2, tenureMonths: 60, emiAmount: 13600, startDate: new Date(2023, 1, 15) },
    ],
    skipDuplicates: true,
  });

  await prisma.insurancePolicy.createMany({
    data: [
      { userId: demoUser.id, type: InsuranceType.HEALTH, provider: "HDFC Ergo", premiumAmount: 18000, premiumFrequency: Recurrence.YEARLY, coverageAmount: 500000, renewalDate: new Date(now.getFullYear(), now.getMonth() + 2, 1), nomineeName: "Meera Sharma" },
      { userId: demoUser.id, type: InsuranceType.TERM, provider: "LIC", premiumAmount: 14000, premiumFrequency: Recurrence.YEARLY, coverageAmount: 5000000, renewalDate: new Date(now.getFullYear() + 1, 0, 1), nomineeName: "Meera Sharma" },
    ],
    skipDuplicates: true,
  });

  const currentFY = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-${String(
    ((now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + 1) % 100,
  ).padStart(2, "0")}`;

  await prisma.taxDeduction.createMany({
    data: [
      { userId: demoUser.id, section: TaxSection.SECTION_80C, description: "EPF + PPF contribution", amount: 105000, financialYear: currentFY },
      { userId: demoUser.id, section: TaxSection.SECTION_80D, description: "Health insurance premium (HDFC Ergo)", amount: 18000, financialYear: currentFY },
      { userId: demoUser.id, section: TaxSection.HOME_LOAN_INTEREST, description: "HDFC home loan interest", amount: 185000, financialYear: currentFY },
    ],
    skipDuplicates: true,
  });

  await prisma.retirementProfile.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: {
      userId: demoUser.id,
      targetRetirementAge: 58,
      desiredMonthlyIncomeToday: 60000,
      inflationRatePercent: 6,
      expectedReturnPreRetirementPercent: 11,
      expectedReturnPostRetirementPercent: 7,
    },
  });

  await prisma.userSettings.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: { userId: demoUser.id },
  });

  // --- Phase 4 demo data: Property, Business, Documents ---------------------------

  const homeLoan = await prisma.loan.findFirst({
    where: { userId: demoUser.id, lender: "HDFC Bank", type: LoanType.HOME },
  });

  await prisma.property.upsert({
    where: { id: "demo-property-1" },
    update: {},
    create: {
      id: "demo-property-1",
      userId: demoUser.id,
      type: PropertyType.APARTMENT,
      name: "Nandurbar 2BHK",
      address: "Nandurbar, Maharashtra",
      currentValue: 4800000,
      purchasePrice: 3800000,
      purchaseDate: new Date(2021, 2, 10),
      isRented: false,
      annualMaintenanceCost: 24000,
      annualPropertyTax: 12000,
      loanId: homeLoan?.id,
    },
  });

  await prisma.property.upsert({
    where: { id: "demo-property-2" },
    update: {},
    create: {
      id: "demo-property-2",
      userId: demoUser.id,
      type: PropertyType.COMMERCIAL,
      name: "Sunil Studio Shopfront",
      address: "Main Bazaar, Nandurbar",
      currentValue: 2200000,
      purchasePrice: 1600000,
      purchaseDate: new Date(2019, 6, 1),
      isRented: true,
      monthlyRentalIncome: 18000,
      annualMaintenanceCost: 9000,
      annualPropertyTax: 6000,
    },
  });

  const businesses = await Promise.all([
    prisma.business.upsert({
      where: { id: "demo-business-1" },
      update: {},
      create: {
        id: "demo-business-1",
        userId: demoUser.id,
        name: "Sunil Tailor & Jewellery",
        description: "Family tailoring and gold-plated jewellery business",
        entityType: BusinessEntityType.SOLE_PROPRIETORSHIP,
        currency: "INR",
        startedAt: new Date(2018, 3, 1),
        ownershipPercent: 100,
      },
    }),
    prisma.business.upsert({
      where: { id: "demo-business-2" },
      update: {},
      create: {
        id: "demo-business-2",
        userId: demoUser.id,
        name: "Girish Digital Services",
        description: "Freelance web/AI development on the side",
        entityType: BusinessEntityType.SOLE_PROPRIETORSHIP,
        currency: "INR",
        startedAt: new Date(2023, 0, 15),
        ownershipPercent: 100,
      },
    }),
  ]);

  // 6 months of revenue + expense transactions per business, so the P&L trend chart
  // and Reports' yearly rollup both have real data to show rather than one lonely month.
  const monthlyPattern: Record<string, { revenue: number; expense: number }> = {
    "demo-business-1": { revenue: 165000, expense: 58000 },
    "demo-business-2": { revenue: 42000, expense: 6000 },
  };

  for (const business of businesses) {
    const pattern = monthlyPattern[business.id];
    const rows = [];
    for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
      const occurredAt = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5);
      // Small deterministic variance so the trend isn't a perfectly flat line.
      const variance = 1 + ((monthsAgo % 3) - 1) * 0.08;
      rows.push(
        {
          businessId: business.id,
          type: BusinessTransactionType.REVENUE,
          category: business.id === "demo-business-1" ? "Tailoring & Jewellery" : "Client projects",
          amount: Math.round(pattern.revenue * variance),
          occurredAt,
        },
        {
          businessId: business.id,
          type: BusinessTransactionType.EXPENSE,
          category: business.id === "demo-business-1" ? "Materials & rent" : "Tools & hosting",
          amount: Math.round(pattern.expense * variance),
          occurredAt: new Date(occurredAt.getFullYear(), occurredAt.getMonth(), 8),
          isRecurring: true,
        },
      );
    }
    await prisma.businessTransaction.createMany({ data: rows, skipDuplicates: true });
  }

  await prisma.businessObligation.createMany({
    data: [
      {
        businessId: "demo-business-1",
        title: "GST filing (GSTR-3B)",
        dueDate: new Date(now.getFullYear(), now.getMonth(), 20),
        amount: 8500,
        recurrence: Recurrence.MONTHLY,
        vendor: "GSTN",
        status: ObligationStatus.PENDING,
      },
      {
        businessId: "demo-business-2",
        title: "Advance tax installment",
        dueDate: new Date(now.getFullYear(), now.getMonth() + 1, 15),
        amount: 12000,
        recurrence: Recurrence.QUARTERLY,
        vendor: "Income Tax Department",
        status: ObligationStatus.PENDING,
      },
    ],
    skipDuplicates: true,
  });

  // NOTE: seeded documents demonstrate the metadata/list/expiry-tracking UI, but their
  // storageKey doesn't point to a real file on disk (a seed script can't practically
  // ship binary assets) — downloading a seeded document returns a clean 404, not a
  // crash (see DocumentsService.download's NotFoundException mapping). Uploading a new
  // document through the UI works end to end with a real file. Known limitation.
  // Tags double as a lightweight, non-schema link to the related property/business
  // record (e.g. "property:demo-property-1") since Document has no polymorphic FK.
  await prisma.document.createMany({
    data: [
      {
        userId: demoUser.id,
        category: DocumentCategory.INSURANCE_POLICY,
        fileName: "HDFC-Ergo-Health-Policy.pdf",
        mimeType: "application/pdf",
        sizeBytes: 245000,
        storageKey: "seed/local/demo-doc-1.pdf",
        tags: ["insurance", "health"],
        expiryDate: new Date(now.getFullYear(), now.getMonth() + 2, 1),
        ocrStatus: "DONE",
        summary: "Insurance policy document — check coverage terms and renewal date.",
      },
      {
        userId: demoUser.id,
        category: DocumentCategory.FORM_16,
        fileName: "Form16-FY2025-26.pdf",
        mimeType: "application/pdf",
        sizeBytes: 180000,
        storageKey: "seed/local/demo-doc-2.pdf",
        tags: ["tax"],
        ocrStatus: "DONE",
        summary: "Form 16 — TDS certificate, needed for annual tax filing.",
      },
      {
        userId: demoUser.id,
        category: DocumentCategory.PROPERTY_PAPER,
        fileName: "Nandurbar-2BHK-Registration.pdf",
        mimeType: "application/pdf",
        sizeBytes: 512000,
        storageKey: "seed/local/demo-doc-3.pdf",
        tags: ["property", "property:demo-property-1"],
        ocrStatus: "DONE",
        summary: "Property ownership or registration document.",
      },
      {
        userId: demoUser.id,
        category: DocumentCategory.BUSINESS_DOCUMENT,
        fileName: "Sunil-Studio-GST-Certificate.pdf",
        mimeType: "application/pdf",
        sizeBytes: 96000,
        storageKey: "seed/local/demo-doc-4.pdf",
        tags: ["business", "business:demo-business-1", "gst"],
        ocrStatus: "DONE",
        summary: "Business-related document.",
      },
    ],
    skipDuplicates: true,
  });

  console.log("Seed complete. Demo login email: demo@wealthos.ai");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
