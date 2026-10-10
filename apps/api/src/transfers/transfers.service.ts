import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, AccountTransfer } from "@wealthos/db";
import type { AccountTransferDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { toMoneyString } from "../common/financial-facts/financial-formulas";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ListTransfersQueryDto } from "./dto/list-transfers-query.dto";

const DAY_MS = 86_400_000;
const LIST_LIMIT = 200;

// INTERNAL TRANSFER: money moving between the user's own accounts (Bank A -> Bank B,
// Bank -> Wallet). It is NOT income, NOT an expense and NOT an investment, so this table is
// deliberately never read by expense, savings-rate or net-cash-flow calculations — it only
// feeds the money-flow display ("where did my money go") through FinancialFactsService.
// Accounts are free-text labels for now; there are no balances to keep in sync.
@Injectable()
export class TransfersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private toDto(t: AccountTransfer): AccountTransferDTO {
    return {
      id: t.id,
      fromAccount: t.fromAccount,
      toAccount: t.toAccount,
      amount: toMoneyString(new Prisma.Decimal(t.amount)),
      currency: t.currency,
      transferredAt: t.transferredAt.toISOString(),
      notes: t.notes,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async create(userId: string, dto: CreateTransferDto): Promise<AccountTransferDTO> {
    const transferredAt = new Date(dto.transferredAt);
    if (Number.isNaN(transferredAt.getTime())) throw new BadRequestException("Invalid transferredAt date");
    if (transferredAt.getTime() > Date.now() + DAY_MS) throw new BadRequestException("transferredAt cannot be in the future");
    if (dto.fromAccount.trim().toLowerCase() === dto.toAccount.trim().toLowerCase()) {
      throw new BadRequestException("A transfer must move money between two different accounts");
    }

    const row = await this.prisma.client.accountTransfer.create({
      data: {
        userId,
        fromAccount: dto.fromAccount,
        toAccount: dto.toAccount,
        amount: dto.amount,
        transferredAt,
        notes: dto.notes,
      },
    });
    await this.audit.log("ACCOUNT_TRANSFER_CREATED", userId, { transferId: row.id, amount: toMoneyString(new Prisma.Decimal(dto.amount)) });
    return this.toDto(row);
  }

  async list(userId: string, query: ListTransfersQueryDto = {}): Promise<AccountTransferDTO[]> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      throw new BadRequestException("Invalid date filter");
    }
    const rows = await this.prisma.client.accountTransfer.findMany({
      where: { userId, ...(from || to ? { transferredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
      orderBy: [{ transferredAt: "desc" }, { createdAt: "desc" }],
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.toDto(r));
  }

  // Ownership is enforced in the write itself, so a foreign id and a missing id are the same 404.
  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const res = await this.prisma.client.accountTransfer.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw new NotFoundException("Transfer not found");
    await this.audit.log("ACCOUNT_TRANSFER_DELETED", userId, { transferId: id });
    return { deleted: true };
  }
}
