import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePropertyDto } from "./dto/create-property.dto";
import { UpdatePropertyDto } from "./dto/update-property.dto";
import { PropertyMetricsDTO, PropertyPortfolioSummaryDTO } from "@wealthos/types";

@Injectable()
export class PropertyService {
  constructor(private prisma: PrismaService) {}

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

  async update(userId: string, id: string, dto: UpdatePropertyDto) {
    await this.assertOwnership(userId, id);
    await this.assertLoanAndPolicyOwnership(userId, dto.loanId, dto.insurancePolicyId);
    return this.prisma.client.property.update({
      where: { id },
      data: { ...dto, purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.property.delete({ where: { id } });
  }

  async totalCurrentValue(userId: string): Promise<number> {
    const properties = await this.prisma.client.property.findMany({ where: { userId } });
    return properties.reduce((sum, p) => sum + Number(p.currentValue), 0);
  }

  // Per-property valuation metrics, computed rather than stored, so they're always
  // consistent with the linked loan's live outstanding balance.
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
      properties: withMetrics as PropertyPortfolioSummaryDTO["properties"],
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

  private async assertOwnership(userId: string, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({ where: { id: propertyId } });
    if (!property) throw new NotFoundException("Property not found");
    if (property.userId !== userId) throw new ForbiddenException();
  }
}
