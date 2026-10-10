"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryDTO, ExpenseAnalyticsDTO, ExpenseDTO, ExpenseSummaryDTO, MoneyFlowDTO, ReceivableSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { QuickExpenseDialog } from "@/components/expenses/QuickExpenseDialog";
import { ExpenseSummaryCards } from "@/components/expenses/ExpenseSummaryCards";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import { SpendingTrendChart } from "@/components/expenses/SpendingTrendChart";
import { CategoryList, ChangeBadge } from "@/components/expenses/CategoryList";
import { CategoryDrillDown } from "@/components/expenses/CategoryDrillDown";
import { MakeRecurringDialog, RecurrenceRuleDialog } from "@/components/expenses/RecurringDialogs";
import { cadenceLabel, recurrenceRole } from "@/lib/recurrence";
import { OtherLedgerPanel, OtherLedgerType } from "@/components/expenses/OtherLedgerPanel";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import {
  DEFAULT_FILTERS,
  ExpenseFilterState,
  PAYMENT_METHOD_OPTIONS,
  filtersToAnalyticsParams,
  filtersToListParams,
  isCustomRangeIncomplete,
  isExpenseTableType,
  periodLabel,
} from "@/lib/expense-filters";
import { localDateString, formatDay } from "@/lib/dates";
import { formatINR } from "@/lib/format";

const PAGE_SIZE = 25;
const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export default function ExpensesPage() {
  // The user's LOCAL date, fixed for this visit: every "today / this week / this month" the server
  // resolves is relative to it, so a user in India at 1 AM still sees their own today.
  const today = useMemo(() => localDateString(), []);
  const version = useFinancialVersion();

  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [filters, setFilters] = useState<ExpenseFilterState>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<ExpenseDTO[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [summary, setSummary] = useState<ExpenseSummaryDTO | null>(null);
  const [moneyFlow, setMoneyFlow] = useState<MoneyFlowDTO | null>(null);
  const [receivables, setReceivables] = useState<ReceivableSummaryDTO | null>(null);
  const [analytics, setAnalytics] = useState<ExpenseAnalyticsDTO | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [quickOpen, setQuickOpen] = useState(false);
  const [drill, setDrill] = useState<{ id: string; name: string } | null>(null);
  // Editing a RECURRING row first asks which occurrences the edit applies to; `scopePromptId` is
  // that question, `editing` is the form once it has been answered.
  const [scopePromptId, setScopePromptId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; scope?: "THIS" | "FUTURE" } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [makeRecurring, setMakeRecurring] = useState<ExpenseDTO | null>(null);
  const [ruleFor, setRuleFor] = useState<ExpenseDTO | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const showExpenses = isExpenseTableType(filters.type);
  const incomplete = isCustomRangeIncomplete(filters);

  // Categories rarely change; load once.
  useEffect(() => {
    api.expenses.categories().then(setCategories).catch(() => setCategories([]));
  }, []);

  // Header numbers: spending totals, plus the money-flow figures that are NOT expenses. Refetched
  // whenever any financial change is announced (quick add, edit, delete, repayment …).
  useEffect(() => {
    let active = true;
    Promise.all([api.expenses.summary(today), api.financialCore.moneyFlow(), api.receivables.summary()])
      .then(([s, mf, r]) => {
        if (!active) return;
        setSummary(s);
        setMoneyFlow(mf);
        setReceivables(r);
      })
      .catch(() => {
        // The summary is supplementary: a failure leaves the cards on "—" instead of blocking the page.
      });
    return () => {
      active = false;
    };
  }, [today, version]);

  // Analytics for the selected period / category (aggregated on the server).
  useEffect(() => {
    if (!showExpenses || incomplete) return;
    let active = true;
    setAnalyticsError(null);
    api.expenses
      .analytics(filtersToAnalyticsParams(filters, today))
      .then((a) => active && setAnalytics(a))
      .catch((err) => active && setAnalyticsError(errorMessage(err, "Could not load spending analytics.")));
    return () => {
      active = false;
    };
  }, [filters, today, version, showExpenses, incomplete]);

  // The paginated transaction table.
  const loadList = useCallback(() => {
    if (!showExpenses || incomplete) return () => undefined;
    let active = true;
    setListLoading(true);
    setListError(null);
    api.expenses
      .listPaged(filtersToListParams(filters, today, page, PAGE_SIZE))
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      })
      .catch((err) => active && setListError(errorMessage(err, "Could not load expenses.")))
      .finally(() => active && setListLoading(false));
    return () => {
      active = false;
    };
  }, [filters, today, page, showExpenses, incomplete]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => loadList(), [loadList, version]);

  const changeFilters = (next: ExpenseFilterState) => {
    setFilters(next);
    setPage(1); // a different result set always starts on its first page
  };

  const afterWrite = () => emitFinancialChange("expense");

  const onDelete = async (id: string, mode?: "THIS" | "FUTURE") => {
    setActionError(null);
    try {
      // A plain delete keeps the original one-argument call; only recurring choices pass a mode.
      if (mode) await api.expenses.remove(id, mode);
      else await api.expenses.remove(id);
      setConfirmDeleteId(null);
      setNotice(mode === "FUTURE" ? "Deleted this occurrence and every later one. Earlier history and the repeat were kept." : "Expense deleted.");
      if (items.length === 1 && page > 1) setPage(page - 1);
      afterWrite();
    } catch (err) {
      setActionError(errorMessage(err, "Could not delete this expense."));
    }
  };

  // Stops future occurrences; nothing is deleted. Resuming picks up from the next due date.
  const onStopRepeat = async (item: ExpenseDTO) => {
    setActionError(null);
    try {
      await api.expenses.deactivateRecurrence(item.id);
      setConfirmDeleteId(null);
      setNotice("Stopped repeating. Everything already recorded was kept.");
      afterWrite();
    } catch (err) {
      setActionError(errorMessage(err, "Could not stop the repeat."));
    }
  };

  const onResumeRepeat = async (item: ExpenseDTO) => {
    setActionError(null);
    try {
      await api.expenses.activateRecurrence(item.id, item.recurrence ?? "MONTHLY");
      setNotice("Repeat resumed.");
      afterWrite();
    } catch (err) {
      setActionError(errorMessage(err, "Could not resume the repeat."));
    }
  };

  const onUpdate = async (id: string, scope: "THIS" | "FUTURE" | undefined, values: Record<string, string | boolean>) => {
    const payload = {
      categoryId: values.categoryId as string,
      merchant: (values.merchant as string) || undefined,
      amount: parseFloat(values.amount as string),
      paymentMethod: values.paymentMethod as string,
      // A date only ever changes for ONE occurrence — it is not offered when editing "this and future".
      ...(scope === "FUTURE" ? {} : { spentAt: new Date(values.spentAt as string).toISOString() }),
    };
    if (scope) await api.expenses.update(id, payload, scope);
    else await api.expenses.update(id, payload);
    setEditing(null);
    setNotice(scope === "FUTURE" ? "Updated this and all later occurrences. Earlier ones were not changed." : "Expense updated.");
    afterWrite();
  };

  const spendingCategories = categories.filter((c) => c.type !== "SAVINGS");
  const baseEditFields: EditField[] = [
    { key: "categoryId", label: "Category", type: "select", options: spendingCategories.map((c) => ({ value: c.id, label: c.name })) },
    { key: "merchant", label: "Merchant" },
    { key: "amount", label: "Amount (₹)", type: "number", money: true },
    { key: "paymentMethod", label: "Payment method", type: "select", options: PAYMENT_METHOD_OPTIONS.map((m) => ({ value: m.value, label: m.label })) },
    { key: "spentAt", label: "Date spent", type: "date" },
  ];
  const fieldsFor = (scope?: "THIS" | "FUTURE") => (scope === "FUTURE" ? baseEditFields.filter((f) => f.key !== "spentAt") : baseEditFields);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Expenses</h1>
          <p className="text-sm text-ink-soft">What you actually spent — kept separate from what you invested, saved or lent.</p>
        </div>
        {/* A floating button on phones (always within thumb reach), a normal header button from `sm` up. */}
        <Button
          onClick={() => setQuickOpen(true)}
          className="fixed bottom-5 right-5 z-40 rounded-full px-5 py-3 shadow-popover sm:static sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card"
        >
          + Quick expense
        </Button>
      </div>

      {notice && (
        <p role="status" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}

      <ExpenseSummaryCards summary={summary} analytics={analytics} moneyFlow={moneyFlow} receivables={receivables} />

      <Card title="Filters">
        <ExpenseFilters value={filters} onChange={changeFilters} categories={spendingCategories} />
      </Card>

      {!showExpenses ? (
        <OtherLedgerPanel type={filters.type as OtherLedgerType} />
      ) : incomplete ? (
        <Card>
          <p className="text-sm text-ink-faint">Choose both a start and an end date for the custom range.</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              eyebrow={periodLabel(filters.period)}
              title="Spending trend"
              action={analytics && <span className="money text-sm text-ink">{formatINR(analytics.totals.total)}</span>}
            >
              {analyticsError ? (
                <p role="alert" className="text-sm text-loss">
                  {analyticsError}
                </p>
              ) : !analytics ? (
                <p className="text-sm text-ink-faint">Loading…</p>
              ) : (
                <>
                  <p className="mb-3 flex flex-wrap items-center gap-x-2 text-xs text-ink-soft">
                    <span>vs previous period: {formatINR(analytics.comparison.total)}</span>
                    <ChangeBadge percent={analytics.comparison.changePercent} />
                  </p>
                  <SpendingTrendChart analytics={analytics} />
                  <dl className="mt-4 grid grid-cols-1 gap-2 text-xs text-ink-soft sm:grid-cols-3">
                    <div>
                      <dt className="stat-label">Highest spending day</dt>
                      <dd className="mt-0.5">{analytics.highestDay ? `${formatDay(analytics.highestDay.date)} · ${formatINR(analytics.highestDay.total)}` : "—"}</dd>
                    </div>
                    <div>
                      <dt className="stat-label">Largest transaction</dt>
                      <dd className="mt-0.5">
                        {analytics.totals.largest ? `${formatINR(analytics.totals.largest.amount)} · ${analytics.totals.largest.merchant ?? analytics.totals.largest.categoryName}` : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="stat-label">Top category</dt>
                      <dd className="mt-0.5">{analytics.categories[0] ? `${analytics.categories[0].name} · ${formatINR(analytics.categories[0].total)}` : "—"}</dd>
                    </div>
                  </dl>
                </>
              )}
            </Card>

            <Card eyebrow="By category" title="Where it went">
              {analyticsError ? (
                <p className="text-sm text-ink-faint">Unavailable.</p>
              ) : !analytics ? (
                <p className="text-sm text-ink-faint">Loading…</p>
              ) : (
                <CategoryList categories={analytics.categories} onSelect={(id, name) => setDrill({ id, name })} />
              )}
            </Card>
          </div>

          <Card title="Transactions" action={!listLoading && <span className="text-xs text-ink-faint">{total} found</span>}>
            {actionError && (
              <p role="alert" className="mb-3 text-sm text-loss">
                {actionError}
              </p>
            )}
            {listError ? (
              <div role="alert" className="text-sm text-loss">
                {listError}{" "}
                <button type="button" onClick={() => loadList()} className="underline">
                  Retry
                </button>
              </div>
            ) : listLoading ? (
              <p className="text-sm text-ink-faint">Loading…</p>
            ) : items.length === 0 ? (
              <div className="text-sm text-ink-faint">
                <p>No expenses match these filters.</p>
                <button type="button" onClick={() => changeFilters(DEFAULT_FILTERS)} className="mt-2 text-marigold-600 hover:underline">
                  Reset filters
                </button>
              </div>
            ) : (
              <>
                <ul>
                  {items.map((item, i) => (
                    <li key={item.id} className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                      {editing?.id === item.id ? (
                        <InlineEditForm
                          fields={fieldsFor(editing.scope)}
                          initialValues={{
                            categoryId: item.categoryId,
                            merchant: item.merchant ?? "",
                            amount: item.amount,
                            paymentMethod: item.paymentMethod,
                            spentAt: item.spentAt.slice(0, 10),
                          }}
                          onSave={(values) => onUpdate(item.id, editing.scope, values)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : scopePromptId === item.id ? (
                        <div role="group" aria-label="Apply this edit to" className="space-y-2">
                          <p className="text-sm text-ink">Apply your edit to…</p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setScopePromptId(null);
                                setEditing({ id: item.id, scope: "THIS" });
                              }}
                              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-muted"
                            >
                              This occurrence only
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setScopePromptId(null);
                                setEditing({ id: item.id, scope: "FUTURE" });
                              }}
                              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-muted"
                            >
                              This and future occurrences
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setScopePromptId(null);
                                setRuleFor(item);
                              }}
                              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-muted"
                            >
                              Change how it repeats
                            </button>
                            <button type="button" onClick={() => setScopePromptId(null)} className="px-2 py-1.5 text-xs text-ink-faint hover:underline">
                              Cancel
                            </button>
                          </div>
                          <p className="text-xs text-ink-faint">Earlier entries are never changed.</p>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-ink">
                              {item.merchant || item.category?.name}
                              {item.generatedFromRecurringId && <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">auto-generated</span>}
                              {recurrenceRole(item) === "TEMPLATE" && item.recurrenceActive && (
                                <span className="ml-2 text-[10px] uppercase tracking-wide text-marigold-600">repeats {cadenceLabel(item.recurrence).toLowerCase()}</span>
                              )}
                              {item.flowType === "OTHER_OUTFLOW" && (
                                <span className="ml-2 align-middle">
                                  <Badge tone="warning">Other outflow</Badge>
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-ink-faint">
                              {item.category?.name} · {item.paymentMethod.toLowerCase().replace("_", " ")} · {new Date(item.spentAt).toLocaleDateString("en-IN")}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="money text-loss">-{formatINR(item.amount)}</span>
                            {confirmDeleteId === item.id ? (
                              (() => {
                                const role = recurrenceRole(item);
                                if (role === "TEMPLATE" && item.recurrenceActive) {
                                  return (
                                    <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Delete options">
                                      <span className="text-ink-soft">This repeats automatically. Stop the repeat first (your history is kept), then you can delete it.</span>
                                      <button type="button" onClick={() => onStopRepeat(item)} className="font-medium text-marigold-600 hover:underline">
                                        Stop repeating
                                      </button>
                                      <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                                        Keep
                                      </button>
                                    </span>
                                  );
                                }
                                if (role === "OCCURRENCE") {
                                  return (
                                    <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Delete options">
                                      <span className="text-ink-soft">Delete…</span>
                                      <button type="button" onClick={() => onDelete(item.id, "THIS")} className="font-medium text-loss hover:underline">
                                        Only this entry
                                      </button>
                                      <button type="button" onClick={() => onDelete(item.id, "FUTURE")} className="font-medium text-loss hover:underline">
                                        This and all later entries
                                      </button>
                                      <button type="button" onClick={() => onStopRepeat({ ...item, id: item.generatedFromRecurringId as string })} className="text-marigold-600 hover:underline">
                                        Just stop repeating
                                      </button>
                                      <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                                        Keep
                                      </button>
                                    </span>
                                  );
                                }
                                return (
                                  <span className="flex items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                                    <span className="text-ink-soft">Delete this expense?</span>
                                    <button type="button" onClick={() => onDelete(item.id)} className="font-medium text-loss hover:underline">
                                      Delete
                                    </button>
                                    <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                                      Keep
                                    </button>
                                  </span>
                                );
                              })()
                            ) : (
                              <>
                                {recurrenceRole(item) === "TEMPLATE" && item.recurrenceActive && (
                                  <button
                                    type="button"
                                    onClick={() => onStopRepeat(item)}
                                    className="text-xs text-ink-faint hover:underline"
                                    title="This row automatically creates a new entry each period — click to stop (nothing is deleted)"
                                  >
                                    Auto-generating ✓
                                  </button>
                                )}
                                {recurrenceRole(item) === "TEMPLATE" && !item.recurrenceActive && (
                                  <button type="button" onClick={() => onResumeRepeat(item)} className="text-xs text-marigold-600 hover:underline" title="Start creating entries automatically again">
                                    Resume repeat
                                  </button>
                                )}
                                {recurrenceRole(item) === "NONE" && item.recurrence !== "ONE_TIME" && (
                                  <button
                                    type="button"
                                    onClick={() => setMakeRecurring(item)}
                                    className="text-xs text-marigold-600 hover:underline"
                                    title="Automatically create a new entry each period"
                                  >
                                    Make recurring
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => (recurrenceRole(item) === "NONE" ? setEditing({ id: item.id }) : setScopePromptId(item.id))}
                                  className="text-xs text-ink-faint hover:text-marigold-600"
                                >
                                  Edit
                                </button>
                                <button type="button" onClick={() => setConfirmDeleteId(item.id)} className="text-xs text-ink-faint hover:text-loss">
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex items-center justify-between text-xs text-ink-faint">
                  <span>
                    Page {page} of {totalPages} · {total} total
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPage(page - 1)}
                      disabled={page <= 1 || listLoading}
                      className="rounded-md border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage(page + 1)}
                      disabled={page >= totalPages || listLoading}
                      className="rounded-md border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </>
      )}

      <MakeRecurringDialog expense={makeRecurring} onClose={() => setMakeRecurring(null)} onSaved={(m) => { setNotice(m); }} />
      <RecurrenceRuleDialog expense={ruleFor} onClose={() => setRuleFor(null)} onSaved={(m) => { setNotice(m); }} />
      <QuickExpenseDialog open={quickOpen} onClose={() => setQuickOpen(false)} categories={categories} />
      <CategoryDrillDown categoryId={drill?.id ?? null} categoryName={drill?.name ?? ""} today={today} onClose={() => setDrill(null)} />
    </div>
  );
}
