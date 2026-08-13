import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { CoverageGapDTO, InsuranceType } from "@wealthos/types";

// Coverage rules of thumb used for gap analysis. These are common planning heuristics,
// not personalized advice — surfaced to the user with that framing, never as a guarantee.
const TERM_INCOME_MULTIPLE = 10;
const ACCIDENT_INCOME_MULTIPLE = 5;
const HEALTH_BASE_COVERAGE = 500000; // ₹5L floor, common baseline for a metro Indian family
const HEALTH_PER_DEPENDENT = 300000; // ₹3L per additional dependent
// Critical illness cover is commonly sized lower than term life — it's meant to cover
// treatment costs and income replacement during recovery, not full income replacement
// for dependents over a full working horizon. 50% of annual income is a widely-cited
// starting-point heuristic in Indian insurance planning content.
const CRITICAL_ILLNESS_INCOME_MULTIPLE = 0.5;

@Injectable()
export class InsuranceService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
  ) {}

  list(userId: string) {
    return this.prisma.client.insurancePolicy.findMany({
      where: { userId },
      orderBy: { renewalDate: "asc" },
    });
  }

  async create(userId: string, dto: CreatePolicyDto) {
    await this.assertDependentOwnership(userId, dto.nomineeDependentId);
    return this.prisma.client.insurancePolicy.create({
      data: { ...dto, userId, renewalDate: new Date(dto.renewalDate) },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to Income/Expenses/Investments/Loans: closes the TOCTOU
  // gap between "check ownership" and "perform the write," and collapses a cross-user
  // access attempt and a nonexistent id into the same 404 rather than leaking which
  // case occurred via a 403/404 split.
  async update(userId: string, id: string, dto: UpdatePolicyDto) {
    await this.assertDependentOwnership(userId, dto.nomineeDependentId);
    const result = await this.prisma.client.insurancePolicy.updateMany({
      where: { id, userId },
      data: { ...dto, renewalDate: dto.renewalDate ? new Date(dto.renewalDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Policy not found");
    }

    // updateMany() only returns a count; fetch the row to keep returning the updated
    // record, matching the original method's contract.
    return this.prisma.client.insurancePolicy.findUnique({ where: { id } });
  }

  // NEW (audit item #13): closes a real cross-tenant risk analogous to the one already
  // fixed for Investment.goalId (assertGoalOwnership) — without this check, a user
  // could link a policy's nominee to any guessable Dependent.id belonging to a
  // household they're not a member of. A Dependent belongs to a Household, not
  // directly to a User, so ownership here means "the dependent's household matches the
  // caller's own household" — a user with no household (householdId is nullable) can
  // never successfully link a nominee, which is the correct behavior since they have
  // no dependents to link to.
  private async assertDependentOwnership(userId: string, dependentId?: string): Promise<void> {
    if (!dependentId) return; // not linking a nominee — nothing to check

    const [user, dependent] = await Promise.all([
      this.prisma.client.user.findUnique({ where: { id: userId } }),
      this.prisma.client.dependent.findUnique({ where: { id: dependentId } }),
    ]);

    if (!dependent || !user?.householdId || dependent.householdId !== user.householdId) {
      throw new BadRequestException("nomineeDependentId does not refer to a dependent in your household.");
    }
  }

  // Same atomic-ownership approach, and a genuine round-trip reduction: one
  // deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's Protect
  // page (api.insurance.remove(id)'s response is never read; it always re-fetches the
  // list afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.insurancePolicy.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Policy not found");
    }

    return { id };
  }

  async upcomingRenewals(userId: string, withinDays = 60) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);
    return this.prisma.client.insurancePolicy.findMany({
      where: { userId, renewalDate: { lte: cutoff } },
      orderBy: { renewalDate: "asc" },
    });
  }

  // COVERAGE EXPANSION (closes the audit-flagged gap): previously benchmarked only 3 of
  // the 8 InsuranceType values (TERM, HEALTH, PERSONAL_ACCIDENT) — VEHICLE, HOME,
  // CRITICAL_ILLNESS, TRAVEL, and BUSINESS policies were fully trackable via CRUD but
  // never gap-analyzed at all. This adds two new *quantified* benchmarks
  // (CRITICAL_ILLNESS, HOME) and one *presence-only* flag (BUSINESS), each chosen only
  // where a genuinely defensible check exists — see the inline reasoning at each new
  // block below. VEHICLE and TRAVEL remain deliberately unbenchmarked; there is neither
  // a sensible universal ratio for either nor (unlike HOME/BUSINESS) any ownership
  // signal elsewhere in the app to know whether flagging them would even be relevant to
  // a given user.
  //
  // Return shape is unchanged (CoverageGapDTO[]) and still variable-length in principle
  // (TERM/HEALTH/PERSONAL_ACCIDENT/CRITICAL_ILLNESS are always present; HOME/BUSINESS
  // are conditionally present) — verified safe against every consumer: Coach's
  // answerInsurance() iterates the array generically (gaps.filter/map, no fixed-length
  // assumption), and the Protect page's gaps.map(...) does the same.
  async gapAnalysis(userId: string): Promise<CoverageGapDTO[]> {
    const [policies, monthlyIncome, user, properties, businesses] = await Promise.all([
      this.list(userId),
      this.incomeService.monthlyForecast(userId),
      this.prisma.client.user.findUnique({
        where: { id: userId },
        include: { household: { include: { dependents: true } } },
      }),
      // Read-only cross-table lookups (no PropertyService/BusinessService import) — the
      // exact same pattern this method already used for the household/dependents lookup
      // above, before this change.
      this.prisma.client.property.findMany({ where: { userId } }),
      this.prisma.client.business.findMany({ where: { userId } }),
    ]);
    const annualIncome = monthlyIncome * 12;
    const dependentCount = user?.household?.dependents.length ?? 0;

    const termCoverage = this.totalCoverageByType(policies, "TERM");
    const healthCoverage = this.totalCoverageByType(policies, "HEALTH");
    const accidentCoverage = this.totalCoverageByType(policies, "PERSONAL_ACCIDENT");
    const criticalIllnessCoverage = this.totalCoverageByType(policies, "CRITICAL_ILLNESS");
    const homeCoverage = this.totalCoverageByType(policies, "HOME");

    const recommendedTerm = annualIncome * TERM_INCOME_MULTIPLE;
    const recommendedHealth = HEALTH_BASE_COVERAGE + dependentCount * HEALTH_PER_DEPENDENT;
    const recommendedAccident = annualIncome * ACCIDENT_INCOME_MULTIPLE;
    const recommendedCriticalIllness = annualIncome * CRITICAL_ILLNESS_INCOME_MULTIPLE;

    const gaps: CoverageGapDTO[] = [
      this.buildGap("TERM", termCoverage, recommendedTerm, "Term life"),
      this.buildGap("HEALTH", healthCoverage, recommendedHealth, "Health"),
      this.buildGap("PERSONAL_ACCIDENT", accidentCoverage, recommendedAccident, "Personal accident"),
      // Always shown, like the three above — critical illness risk (unlike home/business
      // insurance needs) is an income-based exposure everyone has, not asset-ownership
      // dependent.
      this.buildGap("CRITICAL_ILLNESS", criticalIllnessCoverage, recommendedCriticalIllness, "Critical illness"),
    ];

    // HOME: a property-VALUE-based benchmark (standard homeowner's-insurance guidance —
    // insure at least the property's current value), not an income multiple, since a
    // home's insurable value has nothing to do with its owner's income. Only surfaced
    // for users who actually own real estate (per the Property tracker) — otherwise
    // this would be a false-positive nag for renters/non-owners.
    if (properties.length > 0) {
      const recommendedHome = properties.reduce((sum, p) => sum + Number(p.currentValue), 0);
      gaps.push(this.buildGap("HOME", homeCoverage, recommendedHome, "Home"));
    }

    // BUSINESS: presence-only, deliberately without a numeric benchmark. Unlike the four
    // income-based checks above or HOME's property-value check, there is no defensible
    // universal ratio for "enough" business insurance — needs vary enormously by
    // industry, headcount, and risk profile, and inventing a number here would be
    // actively misleading rather than merely approximate. Only flags whether a tracked
    // business owner (per the Business Tracker) has *any* BUSINESS-type policy on file.
    if (businesses.length > 0) {
      const hasBusinessPolicy = policies.some((p) => p.type === "BUSINESS");
      gaps.push(this.buildPresenceOnlyGap("BUSINESS", hasBusinessPolicy, "Business"));
    }

    return gaps;
  }

  private totalCoverageByType(policies: { type: string; coverageAmount: unknown }[], type: string): number {
    return policies
      .filter((p) => p.type === type)
      .reduce((sum, p) => sum + Number(p.coverageAmount), 0);
  }

  private buildGap(
    type: InsuranceType,
    current: number,
    recommended: number,
    label: string,
  ): CoverageGapDTO {
    const gap = Math.max(0, recommended - current);
    const hasCoverage = current > 0;
    const message =
      gap === 0
        ? `${label} coverage looks adequate against the rule-of-thumb benchmark.`
        : hasCoverage
          ? `${label} coverage is below the typical benchmark for this income/household by roughly this amount.`
          : `No ${label.toLowerCase()} policy found — this is a common and significant protection gap.`;

    return {
      type,
      hasCoverage,
      currentCoverage: current.toFixed(2),
      recommendedCoverage: recommended.toFixed(2),
      gap: gap.toFixed(2),
      message,
    };
  }

  // For coverage types with no defensible numeric benchmark (see BUSINESS above) —
  // reuses the exact same CoverageGapDTO shape as buildGap() (currentCoverage/
  // recommendedCoverage/gap all "0.00") so every existing consumer (Coach's
  // uncovered-gaps filter, the Protect page's rendering) handles it identically to a
  // normal entry with no code changes required on their side; `hasCoverage` alone
  // carries the signal.
  private buildPresenceOnlyGap(type: InsuranceType, hasCoverage: boolean, label: string): CoverageGapDTO {
    const message = hasCoverage
      ? `${label} insurance is on file — coverage amount depends heavily on your specific risk profile, so no benchmark is suggested.`
      : `No ${label.toLowerCase()} insurance policy found for a tracked business — coverage amount depends heavily on your specific risk profile, so no benchmark is suggested, but it's worth reviewing.`;

    return {
      type,
      hasCoverage,
      currentCoverage: "0.00",
      recommendedCoverage: "0.00",
      gap: "0.00",
      message,
    };
  }

  // Nominee tracking: a household-governance view of which policies have (or lack) a
  // nominee on file — useful for family financial hygiene, surfaced on the Protect page.
  //
  // Note (documented, not fixed here): the schema models a single `nomineeName` string
  // per policy, not a list of nominees with percentage shares — so "validate nominee
  // allocation percentages sum to 100%" (an idea raised in the platform audit) isn't
  // actually representable with the current data model. Supporting multiple nominees
  // per policy with percentage splits would need a new related model (e.g. a
  // PolicyNominee table), which is a schema/UX change beyond this hardening pass, not a
  // service-layer fix — left as an explicit, documented out-of-scope item rather than
  // attempting a partial fix that wouldn't actually solve the underlying limitation.
  async nomineeSummary(userId: string) {
    const policies = await this.list(userId);
    return {
      totalPolicies: policies.length,
      // A nominee is "on file" if EITHER the free-text name or the new structured
      // dependent link is set — a policy that's been fully migrated to the linked
      // form (nomineeDependentId set, nomineeName left blank) must still count as
      // having a nominee, not incorrectly show up as missing one.
      withNominee: policies.filter((p) => !!p.nomineeName || !!p.nomineeDependentId).length,
      missingNominee: policies
        .filter((p) => !p.nomineeName && !p.nomineeDependentId)
        .map((p) => ({ id: p.id, provider: p.provider, type: p.type })),
      // NEW (audit item #13): how many nominees are backed by a real household
      // Dependent record versus only ever having been entered as free text — a useful
      // "data quality" signal distinct from withNominee/missingNominee above.
      linkedToDependent: policies.filter((p) => !!p.nomineeDependentId).length,
    };
  }
}
