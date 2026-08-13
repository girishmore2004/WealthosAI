import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LoansService } from "../loans/loans.service";
import { IncomeService } from "../income/income.service";
import { CreatePropertyDto } from "./dto/create-property.dto";
import { UpdatePropertyDto } from "./dto/update-property.dto";
import { PropertyMetricsDTO, PropertyPortfolioSummaryDTO } from "@wealthos/types";
import { currentFinancialYear, financialYearRange } from "../common/utils/financial-year.util";

// Section 24 of the Indian Income Tax Act only allows a home-loan-interest deduction
// against RESIDENTIAL property financed by a HOME-type loan — PLOT/LAND (undeveloped)
// and COMMERCIAL property are taxed differently and don't qualify under this specific
// provision, so estimateHomeLoanInterestDeduction() below deliberately excludes them.
const SECTION_24_ELIGIBLE_PROPERTY_TYPES = new Set(["HOUSE", "APARTMENT", "RENTAL"]);
// Commonly-cited self-occupied-property cap under Section 24. Let-out (rented) property
// interest is typically treated more favorably (often without this cap, subject to
// other rules) — the estimate below reports the raw figure and mentions this cap for
// context rather than silently applying it, since which treatment actually applies
// depends on occupancy status this app doesn't track precisely enough to assert.
const SECTION_24_SELF_OCCUPIED_CAP = 200000;

export interface HomeLoanInterestEstimateDTO {
  propertyId: string;
  loanId: string;
  financialYear: string;
  // Raw estimated interest for the financial year, uncapped — see `note` for why this
  // is an estimate, not a record of interest actually paid.
  estimatedInterestPayable: string;
  monthsIncluded: number;
  selfOccupiedCap: string;
  exceedsSelfOccupiedCap: boolean;
  note: string;
}

@Injectable()
export class PropertyService {
  constructor(
    private prisma: PrismaService,
    private loans: LoansService,
    private incomeService: IncomeService,
  ) {}

  list(userId: string) {
    return this.prisma.client.property.findMany({
      where: { userId },
      include: { loan: true },
      orderBy: { currentValue: "desc" },
    });
  }

  async create(userId: string, dto: CreatePropertyDto) {
    await this.assertLoanAndPolicyOwnership(userId, dto.loanId, dto.insurancePolicyId);
    return this.prisma.client.property.create({
      data: { ...dto, userId, purchaseDate: new Date(dto.purchaseDate) },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to Income/Expenses/Investments/Loans/Insurance: closes
  // the TOCTOU gap between "check ownership" and "perform the write," and collapses a
  // cross-user access attempt and a nonexistent id into the same 404 rather than
  // leaking which case occurred via a 403/404 split. The cross-feature
  // assertLoanAndPolicyOwnership() check below (already present, unchanged) still runs
  // first and independently — it's a different check (verifying a *linked* loan/policy
  // id belongs to this user, not the property being updated itself).
  async update(userId: string, id: string, dto: UpdatePropertyDto) {
    await this.assertLoanAndPolicyOwnership(userId, dto.loanId, dto.insurancePolicyId);

    const result = await this.prisma.client.property.updateMany({
      where: { id, userId },
      data: { ...dto, purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Property not found");
    }

    const updated = await this.prisma.client.property.findUnique({ where: { id } });

    // NEW (audit item #10 follow-through): if this property's rent is already synced
    // to an Income row and monthlyRentalIncome was part of this update, keep that
    // Income row's amount in sync rather than letting the two silently drift apart —
    // the whole point of syncing was "Dashboard/Reports reflect the real rent
    // figure," which would quietly stop being true the next time the rent changed
    // (rent renewal, tenant change) if this weren't kept aligned.
    if (updated?.rentSyncedIncomeId && dto.monthlyRentalIncome !== undefined) {
      await this.prisma.client.income.updateMany({
        where: { id: updated.rentSyncedIncomeId, userId },
        data: { amount: dto.monthlyRentalIncome },
      });
    }

    // updateMany() only returns a count; fetch the row to keep returning the updated
    // record, matching the original method's contract.
    return updated;
  }

  // Same atomic-ownership approach, and a genuine round-trip reduction: one
  // deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's property
  // page (api.property.remove(id)'s response is never read; it always re-fetches the
  // list afterward) before making this change.
  async remove(userId: string, id: string) {
    // Read first (not just deleteMany) specifically to know whether a linked
    // rentSyncedIncomeId needs cleaning up — deleting the property must not silently
    // orphan the Income row it was feeding.
    const property = await this.prisma.client.property.findUnique({ where: { id } });

    const result = await this.prisma.client.property.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Property not found");
    }

    if (property?.rentSyncedIncomeId) {
      await this.prisma.client.income.deleteMany({ where: { id: property.rentSyncedIncomeId, userId } });
    }

    return { id };
  }

  // NEW: closes the audit-flagged gap — "Property.monthlyRentalIncome never
  // auto-creates an Income row... the user must separately log rent in Income for it
  // to reach the dashboard/reports total." Deliberately an explicit, opt-in action
  // (not automatic when monthlyRentalIncome is set) — same reasoning as
  // BusinessService.syncDrawingToIncome(): silently auto-creating a recurring Income
  // row the moment a rent figure is entered could double-count for anyone who already
  // has the habit of logging rent manually. Creates a MONTHLY-recurrence Income row
  // (not ONE_TIME, unlike the drawing sync) since rent is inherently a recurring
  // figure, and update() above keeps its amount aligned if monthlyRentalIncome
  // changes later.
  async enableRentIncomeSync(userId: string, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({ where: { id: propertyId } });
    if (!property || property.userId !== userId) {
      throw new NotFoundException("Property not found");
    }
    if (!property.isRented || !property.monthlyRentalIncome || Number(property.monthlyRentalIncome) <= 0) {
      throw new BadRequestException("Property must be marked as rented with a positive monthlyRentalIncome to sync.");
    }
    if (property.rentSyncedIncomeId) {
      throw new BadRequestException("This property's rent is already synced to Income.");
    }

    const income = await this.incomeService.create(userId, {
      source: "RENT",
      label: `Rental income — ${property.name}`,
      amount: Number(property.monthlyRentalIncome),
      recurrence: "MONTHLY",
      receivedAt: new Date().toISOString(),
      notes: property.address ?? undefined,
    });

    await this.prisma.client.property.update({
      where: { id: propertyId },
      data: { rentSyncedIncomeId: income.id },
    });

    return { propertyId, income };
  }

  // Reverses enableRentIncomeSync() — deletes the linked recurring Income row and
  // clears the link. Same reversibility rationale as
  // BusinessService.unsyncDrawingFromIncome().
  async disableRentIncomeSync(userId: string, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({ where: { id: propertyId } });
    if (!property || property.userId !== userId) {
      throw new NotFoundException("Property not found");
    }
    if (!property.rentSyncedIncomeId) {
      throw new BadRequestException("This property's rent was never synced to Income.");
    }

    await this.prisma.client.income.deleteMany({ where: { id: property.rentSyncedIncomeId, userId } });

    return this.prisma.client.property.update({
      where: { id: propertyId },
      data: { rentSyncedIncomeId: null },
    });
  }

  // Left arithmetically unchanged from the original implementation — consumed directly
  // by Dashboard and Household, both of which assume today's exact numeric output.
  async totalCurrentValue(userId: string): Promise<number> {
    const properties = await this.prisma.client.property.findMany({ where: { userId } });
    return properties.reduce((sum, p) => sum + Number(p.currentValue), 0);
  }

  // Per-property valuation metrics, computed rather than stored, so they're always
  // consistent with the linked loan's live outstanding balance. Left arithmetically
  // unchanged — only consumed internally by portfolioSummary() below.
  private computeMetrics(property: {
    currentValue: unknown;
    purchasePrice: unknown;
    monthlyRentalIncome: unknown;
    annualMaintenanceCost: unknown;
    annualPropertyTax: unknown;
    loan: { outstandingPrincipal: unknown } | null;
  }): PropertyMetricsDTO {
    const currentValue = Number(property.currentValue);
    const purchasePrice = Number(property.purchasePrice);
    const appreciationPercent = purchasePrice > 0 ? ((currentValue - purchasePrice) / purchasePrice) * 100 : 0;

    const linkedLoanOutstanding = property.loan ? Number(property.loan.outstandingPrincipal) : null;
    const equity = currentValue - (linkedLoanOutstanding ?? 0);

    const annualRent = property.monthlyRentalIncome ? Number(property.monthlyRentalIncome) * 12 : 0;
    const rentalYieldPercent = property.monthlyRentalIncome && currentValue > 0 ? (annualRent / currentValue) * 100 : null;

    const netAnnualCarryCost =
      Number(property.annualMaintenanceCost) + Number(property.annualPropertyTax) - annualRent;

    return {
      currentValue: currentValue.toFixed(2),
      purchasePrice: purchasePrice.toFixed(2),
      appreciationPercent: Number(appreciationPercent.toFixed(2)),
      linkedLoanOutstanding: linkedLoanOutstanding !== null ? linkedLoanOutstanding.toFixed(2) : null,
      equity: equity.toFixed(2),
      rentalYieldPercent: rentalYieldPercent !== null ? Number(rentalYieldPercent.toFixed(2)) : null,
      netAnnualCarryCost: netAnnualCarryCost.toFixed(2),
    };
  }

  async portfolioSummary(userId: string): Promise<PropertyPortfolioSummaryDTO> {
    const properties = await this.list(userId);

    const withMetrics = properties.map((p) => ({ ...p, metrics: this.computeMetrics(p) }));
    const totalCurrentValue = withMetrics.reduce((sum, p) => sum + Number(p.metrics.currentValue), 0);
    const totalEquity = withMetrics.reduce((sum, p) => sum + Number(p.metrics.equity), 0);

    return {
      totalCurrentValue: totalCurrentValue.toFixed(2),
      totalEquity: totalEquity.toFixed(2),
      properties: withMetrics as unknown as PropertyPortfolioSummaryDTO["properties"],
    };
  }

  // NEW: closes the audit-flagged gap — "no property-tax-benefit integration with the
  // Tax module... auto-suggest a HOME_LOAN_INTEREST tax deduction entry from the linked
  // loan's amortization schedule interest paid in the FY." Deliberately a read-only
  // ESTIMATE, not an automatic write into TaxDeductions: this app has no historical loan
  // payment ledger (only current outstandingPrincipal/rate/EMI), so there is no way to
  // compute interest *actually already paid* in a past or partially-elapsed financial
  // year — see the `note` field for the honest framing of what this number actually is.
  // Reads LoansService's existing PUBLIC amortizationSchedule() method only — no Loans
  // feature file is modified to support this.
  async estimateHomeLoanInterestDeduction(
    userId: string,
    propertyId: string,
    financialYear?: string,
  ): Promise<HomeLoanInterestEstimateDTO | null> {
    const property = await this.getOwnedWithLoan(userId, propertyId);

    if (!property.loan || property.loan.type !== "HOME" || !SECTION_24_ELIGIBLE_PROPERTY_TYPES.has(property.type)) {
      return null;
    }

    const fy = financialYear ?? currentFinancialYear();
    const { fyStart, fyEnd } = financialYearRange(fy);

    const schedule = await this.loans.amortizationSchedule(userId, property.loan.id);

    // amortizationSchedule() numbers rows 1..N as months *from today*, not calendar
    // months — approximate each row's calendar month as "today + (row.month - 1)
    // months" (row 1 = the current month) to determine which rows fall inside the
    // target financial year window.
    const today = new Date();
    let interestInFy = 0;
    let monthsIncluded = 0;

    for (const row of schedule) {
      const approxDate = new Date(today.getFullYear(), today.getMonth() + (row.month - 1), 1);
      if (approxDate >= fyStart && approxDate <= fyEnd) {
        interestInFy += row.interest;
        monthsIncluded += 1;
      }
    }

    return {
      propertyId: property.id,
      loanId: property.loan.id,
      financialYear: fy,
      estimatedInterestPayable: interestInFy.toFixed(2),
      monthsIncluded,
      selfOccupiedCap: SECTION_24_SELF_OCCUPIED_CAP.toFixed(2),
      exceedsSelfOccupiedCap: interestInFy > SECTION_24_SELF_OCCUPIED_CAP,
      note:
        "Estimate based on this loan's current outstanding balance, rate, and EMI projected forward — not a record of interest actually paid, since WealthOS AI doesn't track historical loan payments. Self-occupied residential property interest is typically capped at ₹2,00,000/year under Section 24; let-out (rented) property may be treated differently. Verify against your lender's interest certificate before filing, and add the confirmed amount as a HOME_LOAN_INTEREST deduction under Tax.",
    };
  }

  private async assertLoanAndPolicyOwnership(userId: string, loanId?: string, insurancePolicyId?: string) {
    if (loanId) {
      const loan = await this.prisma.client.loan.findUnique({ where: { id: loanId } });
      if (!loan || loan.userId !== userId) throw new ForbiddenException("Loan does not belong to this user");
    }
    if (insurancePolicyId) {
      const policy = await this.prisma.client.insurancePolicy.findUnique({ where: { id: insurancePolicyId } });
      if (!policy || policy.userId !== userId) throw new ForbiddenException("Policy does not belong to this user");
    }
  }

  private async getOwnedWithLoan(userId: string, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({
      where: { id: propertyId },
      include: { loan: true },
    });
    if (!property || property.userId !== userId) {
      throw new NotFoundException("Property not found");
    }
    return property;
  }
}
