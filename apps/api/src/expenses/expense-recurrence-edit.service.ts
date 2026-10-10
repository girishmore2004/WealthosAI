import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Expense, Prisma } from "@wealthos/db";
import { PrismaService } from "../prisma/prisma.service";
import { ExpensesService } from "./expenses.service";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { UpdateRecurrenceRuleDto } from "./dto/recurrence-edit.dto";
import { RULE_FIELDS, RuleChanges, applyRuleChanges, resolveExpenseRule, ruleFromRow, touchesRule } from "../common/recurrence/recurrence-template.util";

export type EditScope = "THIS" | "FUTURE";
export type DeleteMode = "THIS" | "FUTURE";

// A recurring expense is made of two kinds of rows:
//   TEMPLATE   — the row the recurrence was set up on. It is also the first real occurrence, and
//                its (optional) `recurrenceTemplate` snapshot is the RULE future rows are made from.
//   OCCURRENCE — a row the recurrence engine generated (generatedFromRecurringId points at the template).
//   NONE       — an ordinary expense; none of this applies and the plain ExpensesService path is used.
//
// EDIT SEMANTICS (spec Part 11) — historical transactions must never change silently:
//   THIS    only the row you edited. Editing the TEMPLATE row first freezes the current rule, so a
//           correction to that one historical record can't leak into future occurrences.
//   FUTURE  that row, every LATER already-generated occurrence, and the rule for the ones not yet
//           generated. Earlier occurrences are never touched.
//   RULE    updateRule(): only occurrences not yet generated (cadence, end date, amount …).
//
// DELETE SEMANTICS (Part 11 / 52):
//   THIS    one row. The ACTIVE template is refused — deleting it would silently end the recurrence;
//           stop the recurrence first. A deleted occurrence is NOT regenerated: its idempotency log
//           entry stays, so the engine treats that period as already handled.
//   FUTURE  that occurrence and every later generated one. The template and the rule survive.
//   "Stop repeating, keep history" is POST /expenses/:id/recurrence/deactivate (nothing deleted).
@Injectable()
export class ExpenseRecurrenceEditService {
  constructor(
    private prisma: PrismaService,
    private expenses: ExpensesService,
  ) {}

  private roleOf(row: Pick<Expense, "generatedFromRecurringId" | "recurrence">): "TEMPLATE" | "OCCURRENCE" | "NONE" {
    if (row.generatedFromRecurringId) return "OCCURRENCE";
    if (row.recurrence && row.recurrence !== "ONE_TIME") return "TEMPLATE";
    return "NONE";
  }

  private async load(userId: string, id: string): Promise<Expense> {
    // Ownership is part of the query: a foreign id and a missing id are the same 404.
    const row = await this.prisma.client.expense.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException("Expense not found");
    return row;
  }

  // Only the rule-bearing fields, shaped for a Prisma write (amount stays a number/Decimal).
  private ruleData(dto: UpdateExpenseDto): Prisma.ExpenseUncheckedUpdateManyInput {
    const out: Record<string, unknown> = {};
    for (const f of RULE_FIELDS) if ((dto as Record<string, unknown>)[f] !== undefined) out[f] = (dto as Record<string, unknown>)[f];
    return out as Prisma.ExpenseUncheckedUpdateManyInput;
  }

  async update(userId: string, id: string, dto: UpdateExpenseDto, scope?: EditScope) {
    const row = await this.load(userId, id);
    const role = this.roleOf(row);

    if (role === "NONE") {
      if (scope && scope !== "THIS") {
        throw new BadRequestException("This expense is not part of a recurrence, so there are no future occurrences to change.");
      }
      return this.expenses.update(userId, id, dto); // the original, unchanged path
    }

    const effective: EditScope = scope ?? "THIS";
    if (dto.categoryId !== undefined) await this.expenses.assertNotSavingsCategory(dto.categoryId);
    if (effective === "FUTURE" && dto.spentAt !== undefined) {
      throw new BadRequestException("A date can only be changed for this occurrence — apply the edit to “this occurrence only”.");
    }
    const touches = touchesRule(dto as Record<string, unknown>);
    const templateId = role === "TEMPLATE" ? row.id : (row.generatedFromRecurringId as string);

    await this.prisma.client.$transaction(async (tx) => {
      if (effective === "THIS") {
        // Editing the template row with no rule frozen yet: freeze the CURRENT rule first, so this
        // one-row correction does not become the value every future occurrence is created with.
        if (role === "TEMPLATE" && touches && !row.recurrenceTemplate) {
          await tx.expense.update({ where: { id: row.id }, data: { recurrenceTemplate: applyRuleChanges(ruleFromRow(row), {}) } });
        }
        await tx.expense.updateMany({
          where: { id, userId },
          data: { ...dto, spentAt: dto.spentAt ? new Date(dto.spentAt) : undefined },
        });
        return;
      }

      // FUTURE
      const template = role === "TEMPLATE" ? row : await tx.expense.findFirst({ where: { id: templateId, userId } });
      if (template && touches) {
        await tx.expense.update({
          where: { id: template.id },
          data: { recurrenceTemplate: applyRuleChanges(resolveExpenseRule(template), dto as RuleChanges) },
        });
      }
      // The edited row itself takes the whole edit…
      await tx.expense.updateMany({ where: { id, userId }, data: { ...dto, spentAt: undefined } });
      // …and every LATER generated occurrence takes the rule fields. `gte` is on the edited row's
      // own date, so nothing earlier can match.
      if (touches) {
        await tx.expense.updateMany({
          where: { userId, generatedFromRecurringId: templateId, spentAt: { gte: row.spentAt }, NOT: { id } },
          data: this.ruleData(dto),
        });
      }
    });

    return this.prisma.client.expense.findUnique({ where: { id }, include: { category: true } });
  }

  /** Edits the RULE. Never changes an existing expense, so history stays exactly as recorded. */
  async updateRule(userId: string, id: string, dto: UpdateRecurrenceRuleDto) {
    const row = await this.load(userId, id);
    // Accept an occurrence's id too and resolve it to its template: users edit "the repeat" from
    // whichever row they are looking at.
    let template = row;
    if (row.generatedFromRecurringId) {
      const t = await this.prisma.client.expense.findFirst({ where: { id: row.generatedFromRecurringId, userId } });
      if (!t) throw new BadRequestException("The recurring template for this expense no longer exists, so there is no rule to edit.");
      template = t;
    }
    if (!template.recurrence || template.recurrence === "ONE_TIME") {
      throw new BadRequestException("This expense does not repeat, so there is no recurrence rule to edit.");
    }
    if (dto.recurrence === "ONE_TIME") {
      throw new BadRequestException("Choose a repeating cadence, or stop the recurrence instead.");
    }
    if (dto.categoryId !== undefined) await this.expenses.assertNotSavingsCategory(dto.categoryId);

    const data: Prisma.ExpenseUncheckedUpdateInput = {};
    if (dto.recurrence) data.recurrence = dto.recurrence;
    if (dto.clearEndDate) data.recurrenceEndDate = null;
    else if (dto.endDate) {
      const end = new Date(dto.endDate);
      if (end.getTime() < template.spentAt.getTime()) throw new BadRequestException("The end date cannot be before the first expense date");
      data.recurrenceEndDate = end;
    }
    if (touchesRule(dto as Record<string, unknown>)) {
      data.recurrenceTemplate = applyRuleChanges(resolveExpenseRule(template), dto as RuleChanges);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("Nothing to change");

    await this.prisma.client.expense.updateMany({ where: { id: template.id, userId }, data: data as Prisma.ExpenseUncheckedUpdateManyInput });
    return this.prisma.client.expense.findUnique({ where: { id: template.id }, include: { category: true } });
  }

  async remove(userId: string, id: string, mode: DeleteMode = "THIS") {
    const row = await this.load(userId, id);
    const role = this.roleOf(row);

    if (mode === "FUTURE") {
      if (role !== "OCCURRENCE") {
        throw new BadRequestException(
          "Only an automatically created occurrence can be deleted together with the later ones. To stop a repeat, stop the recurrence instead.",
        );
      }
      const res = await this.prisma.client.expense.deleteMany({
        where: { userId, generatedFromRecurringId: row.generatedFromRecurringId, spentAt: { gte: row.spentAt } },
      });
      return { id, deleted: res.count };
    }

    if (role === "TEMPLATE" && row.recurrenceActive) {
      throw new BadRequestException(
        "This expense is the template of an active recurrence — deleting it would silently stop the repeat. Stop the recurrence first (your history is kept), then delete it if you still want to.",
      );
    }
    await this.expenses.remove(userId, id);
    return { id, deleted: 1 };
  }
}
