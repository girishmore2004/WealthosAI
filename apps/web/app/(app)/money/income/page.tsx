// "use client";

// import { useEffect, useState, FormEvent } from "react";
// import type { IncomeDTO, IncomeSource, Recurrence } from "@wealthos/types";
// import { api, ApiError } from "@/lib/api-client";
// import { Card } from "@/components/ui/Card";
// import { Button } from "@/components/ui/Button";
// import { Input } from "@/components/ui/Input";
// import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
// import { formatINR } from "@/lib/format";

// const SOURCES: IncomeSource[] = [
//   "SALARY",
//   "FREELANCE",
//   "BUSINESS",
//   "RENT",
//   "DIVIDEND",
//   "INTEREST",
//   "BONUS",
//   "PENSION",
//   "OTHER",
// ];
// const RECURRENCES: Recurrence[] = ["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"];

// const EDIT_FIELDS: EditField[] = [
//   { key: "source", label: "Source", type: "select", options: SOURCES.map((s) => ({ value: s, label: s })) },
//   { key: "label", label: "Label" },
//   { key: "amount", label: "Amount (₹)", type: "number", money: true },
//   { key: "recurrence", label: "Recurrence", type: "select", options: RECURRENCES.map((r) => ({ value: r, label: r })) },
//   { key: "receivedAt", label: "Date received", type: "date" },
// ];

// export default function IncomePage() {
//   const [items, setItems] = useState<IncomeDTO[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);

//   const [source, setSource] = useState<IncomeSource>("SALARY");
//   const [label, setLabel] = useState("");
//   const [amount, setAmount] = useState("");
//   const [recurrence, setRecurrence] = useState<Recurrence>("MONTHLY");
//   const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
//   const [submitting, setSubmitting] = useState(false);
//   const [editingId, setEditingId] = useState<string | null>(null);

//   const load = () => {
//     setLoading(true);
//     api.income
//       .list()
//       .then(setItems)
//       .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load income."))
//       .finally(() => setLoading(false));
//   };

//   useEffect(load, []);

//   const onSubmit = async (e: FormEvent) => {
//     e.preventDefault();
//     setSubmitting(true);
//     setError(null);
//     try {
//       await api.income.create({
//         source,
//         label,
//         amount: parseFloat(amount),
//         recurrence,
//         receivedAt: new Date(receivedAt).toISOString(),
//       });
//       setLabel("");
//       setAmount("");
//       load();
//     } catch (err) {
//       setError(err instanceof ApiError ? err.message : "Could not save this income entry.");
//     } finally {
//       setSubmitting(false);
//     }
//   };

//   const onDelete = async (id: string) => {
//     await api.income.remove(id);
//     load();
//   };

//   const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
//     await api.income.update(id, {
//       source: values.source as string,
//       label: values.label as string,
//       amount: parseFloat(values.amount as string),
//       recurrence: values.recurrence as string,
//       receivedAt: new Date(values.receivedAt as string).toISOString(),
//     });
//     setEditingId(null);
//     load();
//   };

//   return (
//     <div className="space-y-6">
//       <div>
//         <h1 className="font-display text-2xl text-ink">Income</h1>
//         <p className="text-sm text-ink-soft">Salary, freelance, business, rent, and everything else coming in.</p>
//       </div>

//       <Card title="Add income">
//         <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
//           <select
//             value={source}
//             onChange={(e) => setSource(e.target.value as IncomeSource)}
//             className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
//           >
//             {SOURCES.map((s) => (
//               <option key={s} value={s}>
//                 {s.charAt(0) + s.slice(1).toLowerCase()}
//               </option>
//             ))}
//           </select>
//           <Input placeholder="Label (e.g. Monthly salary)" value={label} onChange={(e) => setLabel(e.target.value)} required />
//           <Input
//             type="number"
//             min="0"
//             step="0.01"
//             placeholder="Amount (₹)"
//             value={amount}
//             onChange={(e) => setAmount(e.target.value)}
//             required
//             className="money"
//           />
//           <select
//             value={recurrence}
//             onChange={(e) => setRecurrence(e.target.value as Recurrence)}
//             className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
//           >
//             {RECURRENCES.map((r) => (
//               <option key={r} value={r}>
//                 {r.replace("_", " ").toLowerCase()}
//               </option>
//             ))}
//           </select>
//           <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} required />
//           <Button type="submit" disabled={submitting}>
//             {submitting ? "Saving…" : "Add income"}
//           </Button>
//         </form>
//         {error && <p className="mt-2 text-sm text-loss">{error}</p>}
//       </Card>

//       <Card title="All income">
//         {loading ? (
//           <p className="text-sm text-ink-faint">Loading…</p>
//         ) : items.length === 0 ? (
//           <p className="text-sm text-ink-faint">No income logged yet. Add your first entry above.</p>
//         ) : (
//           <ul>
//             {items.map((item, i) => (
//               <li
//                 key={item.id}
//                 className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}
//               >
//                 {editingId === item.id ? (
//                   <InlineEditForm
//                     fields={EDIT_FIELDS}
//                     initialValues={{
//                       source: item.source,
//                       label: item.label,
//                       amount: item.amount,
//                       recurrence: item.recurrence,
//                       receivedAt: item.receivedAt.slice(0, 10),
//                     }}
//                     onSave={(values) => onUpdate(item.id, values)}
//                     onCancel={() => setEditingId(null)}
//                   />
//                 ) : (
//                   <div className="flex items-center justify-between">
//                     <div>
//                       <p className="text-ink">{item.label}</p>
//                       <p className="text-xs text-ink-faint">
//                         {item.source.toLowerCase()} · {item.recurrence.toLowerCase()} ·{" "}
//                         {new Date(item.receivedAt).toLocaleDateString("en-IN")}
//                       </p>
//                     </div>
//                     <div className="flex items-center gap-3">
//                       <span className="money text-gain">{formatINR(item.amount)}</span>
//                       <button onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
//                         Edit
//                       </button>
//                       <button onClick={() => onDelete(item.id)} className="text-xs text-ink-faint hover:text-loss">
//                         Remove
//                       </button>
//                     </div>
//                   </div>
//                 )}
//               </li>
//             ))}
//           </ul>
//         )}
//       </Card>
//     </div>
//   );
// }


"use client";

import { useEffect, useState, FormEvent } from "react";
import type { IncomeDTO, IncomeSource, Recurrence, IncomeHistoryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const SOURCES: IncomeSource[] = [
  "SALARY",
  "FREELANCE",
  "BUSINESS",
  "RENT",
  "DIVIDEND",
  "INTEREST",
  "BONUS",
  "PENSION",
  "OTHER",
];
const RECURRENCES: Recurrence[] = ["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"];

const EDIT_FIELDS: EditField[] = [
  { key: "source", label: "Source", type: "select", options: SOURCES.map((s) => ({ value: s, label: s })) },
  { key: "label", label: "Label" },
  { key: "amount", label: "Amount (₹)", type: "number", money: true },
  { key: "recurrence", label: "Recurrence", type: "select", options: RECURRENCES.map((r) => ({ value: r, label: r })) },
  { key: "receivedAt", label: "Date received", type: "date" },
];

export default function IncomePage() {
  const [items, setItems] = useState<IncomeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // NEW (audit item #16): the page now fetches via the paginated endpoint instead of
  // the previously-unbounded list(), which returned every income row in one response
  // regardless of account age/history size. PAGE_SIZE chosen to keep a page's worth of
  // rows readable without excessive scrolling; page state resets to 1 after any
  // mutation below so a newly-added or edited row is always visible without the user
  // needing to navigate back manually.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [source, setSource] = useState<IncomeSource>("SALARY");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("MONTHLY");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // NEW (audit item #4): which row's history is currently expanded, and its fetched
  // entries. Null historyRows means "not yet fetched" — distinguishes from an
  // already-fetched empty array (a row with no logged amount changes).
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<IncomeHistoryDTO[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const onToggleHistory = async (id: string) => {
    if (historyOpenId === id) {
      setHistoryOpenId(null);
      return;
    }
    setHistoryOpenId(id);
    setHistoryRows(null);
    setHistoryLoading(true);
    try {
      const rows = await api.income.history(id);
      setHistoryRows(rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this row's history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const load = (targetPage: number = page) => {
    setLoading(true);
    api.income
      .listPaged({ page: targetPage, pageSize: PAGE_SIZE })
      .then((result) => {
        setItems(result.items);
        setPage(result.page);
        setTotalPages(result.totalPages);
        setTotal(result.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load income."))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(1), []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.income.create({
        source,
        label,
        amount: parseFloat(amount),
        recurrence,
        receivedAt: new Date(receivedAt).toISOString(),
      });
      setLabel("");
      setAmount("");
      load(1); // newest-first ordering — the new entry lands on page 1
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this income entry.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.income.remove(id);
    // If this was the only row on a page beyond the first, step back a page rather
    // than reloading into an empty page that still shows a "Next" control leading
    // nowhere.
    load(items.length === 1 && page > 1 ? page - 1 : page);
  };

  // NEW (audit item #3): explicit, opt-in recurring-generation toggle. Only shown for
  // rows with a real recurrence cadence (not ONE_TIME) that weren't themselves
  // auto-generated by a template (generatedFromRecurringId is set on those — toggling
  // recurrence on a generated occurrence would be confusing UX, since the template row
  // itself is the thing to activate/deactivate).
  const onToggleRecurrence = async (item: IncomeDTO) => {
    try {
      if (item.recurrenceActive) {
        await api.income.deactivateRecurrence(item.id);
      } else {
        await api.income.activateRecurrence(item.id);
      }
      load(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this row's recurrence setting.");
    }
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.income.update(id, {
      source: values.source as string,
      label: values.label as string,
      amount: parseFloat(values.amount as string),
      recurrence: values.recurrence as string,
      receivedAt: new Date(values.receivedAt as string).toISOString(),
    });
    setEditingId(null);
    load(page);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Income</h1>
        <p className="text-sm text-ink-soft">Salary, freelance, business, rent, and everything else coming in.</p>
      </div>

      <Card title="Add income">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as IncomeSource)}
            className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Label (e.g. Monthly salary)" value={label} onChange={(e) => setLabel(e.target.value)} required />
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="Amount (₹)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="money"
          />
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as Recurrence)}
            className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30"
          >
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>
                {r.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} required />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add income"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <Card title="All income">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No income logged yet. Add your first entry above.</p>
        ) : (
          <>
            <ul>
            {items.map((item, i) => (
              <li
                key={item.id}
                className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}
              >
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      source: item.source,
                      label: item.label,
                      amount: item.amount,
                      recurrence: item.recurrence,
                      receivedAt: item.receivedAt.slice(0, 10),
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-ink">
                        {item.label}
                        {item.generatedFromRecurringId && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">auto-generated</span>
                        )}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {item.source.toLowerCase()} · {item.recurrence.toLowerCase()} ·{" "}
                        {new Date(item.receivedAt).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="money text-gain">{formatINR(item.amount)}</span>
                      {item.recurrence !== "ONE_TIME" && !item.generatedFromRecurringId && (
                        <button
                          onClick={() => onToggleRecurrence(item)}
                          className={`text-xs hover:underline ${item.recurrenceActive ? "text-ink-faint" : "text-marigold-600"}`}
                          title={
                            item.recurrenceActive
                              ? "This row auto-generates a new entry each period — click to stop"
                              : "Automatically generate a new entry each period"
                          }
                        >
                          {item.recurrenceActive ? "Auto-generating ✓" : "Make recurring"}
                        </button>
                      )}
                      <button onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                        Edit
                      </button>
                      <button onClick={() => onToggleHistory(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                        History
                      </button>
                      <button onClick={() => onDelete(item.id)} className="text-xs text-ink-faint hover:text-loss">
                        Remove
                      </button>
                    </div>
                  </div>
                )}
                {/* NEW (audit item #4): expandable amount-change history panel. */}
                {historyOpenId === item.id && (
                  <div className="mt-2 rounded-md bg-surface-muted px-3 py-2 text-xs">
                    {historyLoading ? (
                      <p className="text-ink-faint">Loading history…</p>
                    ) : !historyRows || historyRows.length === 0 ? (
                      <p className="text-ink-faint">No amount changes logged for this entry yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {historyRows.map((h) => (
                          <li key={h.id} className="text-ink-faint">
                            <span className="money">{formatINR(h.previousAmount)}</span> →{" "}
                            <span className="money text-ink">{formatINR(h.newAmount)}</span>, effective{" "}
                            {new Date(h.effectiveFrom).toLocaleDateString("en-IN")}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
            </ul>
            {/* NEW (audit item #16): Previous/Next controls for the paginated view. */}
            <div className="mt-4 flex items-center justify-between text-xs text-ink-faint">
              <span>
                Page {page} of {totalPages} · {total} total
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => load(page - 1)}
                  disabled={page <= 1 || loading}
                  className="rounded-md border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => load(page + 1)}
                  disabled={page >= totalPages || loading}
                  className="rounded-md border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
