// "use client";

// import { useEffect, useState, FormEvent } from "react";
// import type { InsurancePolicyDTO, CoverageGapDTO, InsuranceType, Recurrence } from "@wealthos/types";
// import { api, ApiError } from "@/lib/api-client";
// import { Card } from "@/components/ui/Card";
// import { Button } from "@/components/ui/Button";
// import { Input } from "@/components/ui/Input";
// import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
// import { formatINR } from "@/lib/format";

// const TYPES: InsuranceType[] = [
//   "HEALTH",
//   "TERM",
//   "VEHICLE",
//   "HOME",
//   "PERSONAL_ACCIDENT",
//   "CRITICAL_ILLNESS",
//   "TRAVEL",
//   "BUSINESS",
// ];
// const FREQUENCIES: Recurrence[] = ["MONTHLY", "QUARTERLY", "YEARLY"];

// const EDIT_FIELDS: EditField[] = [
//   { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
//   { key: "provider", label: "Provider" },
//   { key: "premiumAmount", label: "Premium (₹)", type: "number", money: true },
//   { key: "premiumFrequency", label: "Premium frequency", type: "select", options: FREQUENCIES.map((f) => ({ value: f, label: f })) },
//   { key: "coverageAmount", label: "Coverage (₹)", type: "number", money: true },
//   { key: "renewalDate", label: "Renewal date", type: "date" },
// ];

// export default function ProtectPage() {
//   const [items, setItems] = useState<InsurancePolicyDTO[]>([]);
//   const [gaps, setGaps] = useState<CoverageGapDTO[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState<string | null>(null);

//   const [type, setType] = useState<InsuranceType>("HEALTH");
//   const [provider, setProvider] = useState("");
//   const [premiumAmount, setPremiumAmount] = useState("");
//   const [premiumFrequency, setPremiumFrequency] = useState<Recurrence>("YEARLY");
//   const [coverageAmount, setCoverageAmount] = useState("");
//   const [renewalDate, setRenewalDate] = useState(() => new Date().toISOString().slice(0, 10));
//   const [submitting, setSubmitting] = useState(false);
//   const [editingId, setEditingId] = useState<string | null>(null);

//   const load = () => {
//     setLoading(true);
//     Promise.all([api.insurance.list(), api.insurance.gapAnalysis()])
//       .then(([list, gaps]) => {
//         setItems(list);
//         setGaps(gaps);
//       })
//       .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load policies."))
//       .finally(() => setLoading(false));
//   };

//   useEffect(load, []);

//   const onSubmit = async (e: FormEvent) => {
//     e.preventDefault();
//     setSubmitting(true);
//     setError(null);
//     try {
//       await api.insurance.create({
//         type,
//         provider,
//         premiumAmount: parseFloat(premiumAmount),
//         premiumFrequency,
//         coverageAmount: parseFloat(coverageAmount),
//         renewalDate: new Date(renewalDate).toISOString(),
//       });
//       setProvider("");
//       setPremiumAmount("");
//       setCoverageAmount("");
//       load();
//     } catch (err) {
//       setError(err instanceof ApiError ? err.message : "Could not save this policy.");
//     } finally {
//       setSubmitting(false);
//     }
//   };

//   const onDelete = async (id: string) => {
//     await api.insurance.remove(id);
//     load();
//   };

//   const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
//     await api.insurance.update(id, {
//       type: values.type as string,
//       provider: values.provider as string,
//       premiumAmount: parseFloat(values.premiumAmount as string),
//       premiumFrequency: values.premiumFrequency as string,
//       coverageAmount: parseFloat(values.coverageAmount as string),
//       renewalDate: new Date(values.renewalDate as string).toISOString(),
//     });
//     setEditingId(null);
//     load();
//   };

//   return (
//     <div className="space-y-6">
//       <div>
//         <h1 className="font-display text-2xl text-ink">Protect</h1>
//         <p className="text-sm text-ink-soft">Health, term, vehicle, and other cover — and where the gaps are.</p>
//       </div>

//       <Card title="Coverage gap analysis">
//         <ul className="space-y-3">
//           {gaps.map((gap) => (
//             <li key={gap.type} className={`border-l-2 pl-3 ${Number(gap.gap) > 0 ? "border-marigold-500" : "border-gain"}`}>
//               <p className="text-sm font-medium text-ink">{gap.type.replace("_", " ").toLowerCase()}</p>
//               <p className="mt-0.5 text-xs text-ink-soft">{gap.message}</p>
//               <p className="mt-1 text-xs text-ink-faint">
//                 Current <span className="money">{formatINR(gap.currentCoverage)}</span> · Benchmark{" "}
//                 <span className="money">{formatINR(gap.recommendedCoverage)}</span>
//               </p>
//             </li>
//           ))}
//         </ul>
//         <p className="mt-4 text-[11px] text-ink-faint">
//           Benchmarks use common rule-of-thumb multiples (e.g. 10x income for term life), not personalized advice.
//         </p>
//       </Card>

//       <Card title="Add policy">
//         <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
//           <select value={type} onChange={(e) => setType(e.target.value as InsuranceType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
//             {TYPES.map((t) => (
//               <option key={t} value={t}>
//                 {t.replace("_", " ").toLowerCase()}
//               </option>
//             ))}
//           </select>
//           <Input placeholder="Provider (e.g. HDFC Ergo)" value={provider} onChange={(e) => setProvider(e.target.value)} required />
//           <Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} required />
//           <Input type="number" min="0" placeholder="Premium amount (₹)" value={premiumAmount} onChange={(e) => setPremiumAmount(e.target.value)} required className="money" />
//           <select value={premiumFrequency} onChange={(e) => setPremiumFrequency(e.target.value as Recurrence)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
//             {FREQUENCIES.map((f) => (
//               <option key={f} value={f}>
//                 {f.toLowerCase()}
//               </option>
//             ))}
//           </select>
//           <Input type="number" min="0" placeholder="Coverage amount (₹)" value={coverageAmount} onChange={(e) => setCoverageAmount(e.target.value)} required className="money" />
//           <Button type="submit" disabled={submitting}>
//             {submitting ? "Saving…" : "Add policy"}
//           </Button>
//         </form>
//         {error && <p className="mt-2 text-sm text-loss">{error}</p>}
//       </Card>

//       <Card title="All policies">
//         {loading ? (
//           <p className="text-sm text-ink-faint">Loading…</p>
//         ) : items.length === 0 ? (
//           <p className="text-sm text-ink-faint">No policies logged yet.</p>
//         ) : (
//           <ul>
//             {items.map((item, i) => (
//               <li key={item.id} className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
//                 {editingId === item.id ? (
//                   <InlineEditForm
//                     fields={EDIT_FIELDS}
//                     initialValues={{
//                       type: item.type,
//                       provider: item.provider,
//                       premiumAmount: item.premiumAmount,
//                       premiumFrequency: item.premiumFrequency,
//                       coverageAmount: item.coverageAmount,
//                       renewalDate: item.renewalDate.slice(0, 10),
//                     }}
//                     onSave={(values) => onUpdate(item.id, values)}
//                     onCancel={() => setEditingId(null)}
//                   />
//                 ) : (
//                   <div className="flex items-center justify-between">
//                     <div>
//                       <p className="text-ink">{item.provider}</p>
//                       <p className="text-xs text-ink-faint">
//                         {item.type.replace("_", " ").toLowerCase()} · renews {new Date(item.renewalDate).toLocaleDateString("en-IN")}
//                       </p>
//                     </div>
//                     <div className="flex items-center gap-3">
//                       <span className="money text-ink">{formatINR(item.coverageAmount)} cover</span>
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
import type { InsurancePolicyDTO, CoverageGapDTO, InsuranceType, Recurrence, DependentDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const TYPES: InsuranceType[] = [
  "HEALTH",
  "TERM",
  "VEHICLE",
  "HOME",
  "PERSONAL_ACCIDENT",
  "CRITICAL_ILLNESS",
  "TRAVEL",
  "BUSINESS",
];
const FREQUENCIES: Recurrence[] = ["MONTHLY", "QUARTERLY", "YEARLY"];

// NEW (audit item #13): nominee fields, added alongside the pre-existing ones. Options
// for nomineeDependentId are populated dynamically from the household's dependents at
// render time (see buildEditFields below), since EDIT_FIELDS itself can't know that
// list statically.
function buildEditFields(dependents: DependentDTO[]): EditField[] {
  return [
    { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
    { key: "provider", label: "Provider" },
    { key: "premiumAmount", label: "Premium (₹)", type: "number", money: true },
    { key: "premiumFrequency", label: "Premium frequency", type: "select", options: FREQUENCIES.map((f) => ({ value: f, label: f })) },
    { key: "coverageAmount", label: "Coverage (₹)", type: "number", money: true },
    { key: "renewalDate", label: "Renewal date", type: "date" },
    { key: "nomineeName", label: "Nominee name (free text)" },
    {
      key: "nomineeDependentId",
      label: "Or link to a household dependent",
      type: "select",
      options: [
        { value: "", label: "— not linked —" },
        ...dependents.map((d) => ({ value: d.id, label: `${d.name} (${d.relation})` })),
      ],
    },
  ];
}

export default function ProtectPage() {
  const [items, setItems] = useState<InsurancePolicyDTO[]>([]);
  const [gaps, setGaps] = useState<CoverageGapDTO[]>([]);
  // NEW (audit item #13): household dependents, used to populate the nominee-link
  // dropdown and to resolve a linked policy's nomineeDependentId back to a display
  // name in the read-only list view below.
  const [dependents, setDependents] = useState<DependentDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<InsuranceType>("HEALTH");
  const [provider, setProvider] = useState("");
  const [premiumAmount, setPremiumAmount] = useState("");
  const [premiumFrequency, setPremiumFrequency] = useState<Recurrence>("YEARLY");
  const [coverageAmount, setCoverageAmount] = useState("");
  const [renewalDate, setRenewalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [nomineeName, setNomineeName] = useState("");
  const [nomineeDependentId, setNomineeDependentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.insurance.list(), api.insurance.gapAnalysis(), api.household.get()])
      .then(([list, gaps, household]) => {
        setItems(list);
        setGaps(gaps);
        setDependents(household.dependents);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load policies."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.insurance.create({
        type,
        provider,
        premiumAmount: parseFloat(premiumAmount),
        premiumFrequency,
        coverageAmount: parseFloat(coverageAmount),
        renewalDate: new Date(renewalDate).toISOString(),
        nomineeName: nomineeName.trim() || undefined,
        nomineeDependentId: nomineeDependentId || undefined,
      });
      setProvider("");
      setPremiumAmount("");
      setCoverageAmount("");
      setNomineeName("");
      setNomineeDependentId("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this policy.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.insurance.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.insurance.update(id, {
      type: values.type as string,
      provider: values.provider as string,
      premiumAmount: parseFloat(values.premiumAmount as string),
      premiumFrequency: values.premiumFrequency as string,
      coverageAmount: parseFloat(values.coverageAmount as string),
      renewalDate: new Date(values.renewalDate as string).toISOString(),
      nomineeName: (values.nomineeName as string) || undefined,
      // "" is the select's "— not linked —" sentinel — send it through as an explicit
      // null (not undefined) so choosing it actually clears an existing link, rather
      // than being silently dropped from the PATCH body and leaving the old link in
      // place.
      nomineeDependentId: (values.nomineeDependentId as string) || null,
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Protect</h1>
        <p className="text-sm text-ink-soft">Health, term, vehicle, and other cover — and where the gaps are.</p>
      </div>

      <Card title="Coverage gap analysis">
        <ul className="space-y-3">
          {gaps.map((gap) => (
            <li key={gap.type} className={`border-l-2 pl-3 ${Number(gap.gap) > 0 ? "border-marigold-500" : "border-gain"}`}>
              <p className="text-sm font-medium text-ink">{gap.type.replace("_", " ").toLowerCase()}</p>
              <p className="mt-0.5 text-xs text-ink-soft">{gap.message}</p>
              <p className="mt-1 text-xs text-ink-faint">
                Current <span className="money">{formatINR(gap.currentCoverage)}</span> · Benchmark{" "}
                <span className="money">{formatINR(gap.recommendedCoverage)}</span>
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-ink-faint">
          Benchmarks use common rule-of-thumb multiples (e.g. 10x income for term life), not personalized advice.
        </p>
      </Card>

      <Card title="Add policy">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select value={type} onChange={(e) => setType(e.target.value as InsuranceType)} className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Provider (e.g. HDFC Ergo)" value={provider} onChange={(e) => setProvider(e.target.value)} required />
          <Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} required />
          <Input type="number" min="0" placeholder="Premium amount (₹)" value={premiumAmount} onChange={(e) => setPremiumAmount(e.target.value)} required className="money" />
          <select value={premiumFrequency} onChange={(e) => setPremiumFrequency(e.target.value as Recurrence)} className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30">
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f.toLowerCase()}
              </option>
            ))}
          </select>
          <Input type="number" min="0" placeholder="Coverage amount (₹)" value={coverageAmount} onChange={(e) => setCoverageAmount(e.target.value)} required className="money" />
          <Input placeholder="Nominee name (optional)" value={nomineeName} onChange={(e) => setNomineeName(e.target.value)} />
          {dependents.length > 0 && (
            <select
              value={nomineeDependentId}
              onChange={(e) => setNomineeDependentId(e.target.value)}
              className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30"
            >
              <option value="">Or link nominee to a household dependent (optional)</option>
              {dependents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.relation})
                </option>
              ))}
            </select>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add policy"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <Card title="All policies">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No policies logged yet.</p>
        ) : (
          <ul>
            {items.map((item, i) => (
              <li key={item.id} className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={buildEditFields(dependents)}
                    initialValues={{
                      type: item.type,
                      provider: item.provider,
                      premiumAmount: item.premiumAmount,
                      premiumFrequency: item.premiumFrequency,
                      coverageAmount: item.coverageAmount,
                      renewalDate: item.renewalDate.slice(0, 10),
                      nomineeName: item.nomineeName ?? "",
                      nomineeDependentId: item.nomineeDependentId ?? "",
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-ink">{item.provider}</p>
                      <p className="text-xs text-ink-faint">
                        {item.type.replace("_", " ").toLowerCase()} · renews {new Date(item.renewalDate).toLocaleDateString("en-IN")}
                      </p>
                      {/* NEW (audit item #13): nominee display — prefers the linked
                          Dependent's name (resolved from household state) over the
                          free-text nomineeName, since a linked nominee's name is the
                          household's own source of truth and could have drifted from
                          whatever was typed into nomineeName when the policy was
                          first added. */}
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {item.nomineeDependentId
                          ? `Nominee: ${dependents.find((d) => d.id === item.nomineeDependentId)?.name ?? "linked dependent"} (linked)`
                          : item.nomineeName
                            ? `Nominee: ${item.nomineeName}`
                            : "No nominee on file"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="money text-ink">{formatINR(item.coverageAmount)} cover</span>
                      <button onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                        Edit
                      </button>
                      <button onClick={() => onDelete(item.id)} className="text-xs text-ink-faint hover:text-loss">
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
