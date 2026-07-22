"use client";

import { useState, FormEvent } from "react";
import type { ScenarioStudioResultDTO, ScenarioVariantLabel } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

const SUGGESTED_PROMPTS = [
  "What if I increase my SIP by ₹5,000/month?",
  "What if I prepay ₹2,00,000 on a loan?",
  "What if I retire at 55 instead?",
  "What if I get a 15% salary hike?",
];

const VARIANT_STYLE: Record<ScenarioVariantLabel, { label: string; badge: string }> = {
  best: { label: "Best case", badge: "bg-marigold-50 text-marigold-600" },
  base: { label: "Base case", badge: "bg-paper text-ink-faint" },
  worst: { label: "Worst case", badge: "bg-paper text-loss" },
  constrained: { label: "Constrained (affordable)", badge: "bg-paper text-gain" },
};

export default function ScenarioStudioPage() {
  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioStudioResultDTO | null>(null);

  const build = async (p: string) => {
    if (!p.trim()) return;
    setBuilding(true);
    setError(null);
    try {
      const r = await api.scenarioStudio.build(p);
      setResult(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't build the scenario right now.");
    } finally {
      setBuilding(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    build(prompt);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Scenario Studio</h1>
        <p className="text-sm text-ink-soft">
          Describe a what-if in plain language — it expands into best/base/worst/constrained variants, runs a
          sensitivity sweep, and ranks them, all computed by the same deterministic simulator engine as the regular
          What-If Simulator.
        </p>
      </div>

      <Card>
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input
            placeholder="e.g. what if I increase my SIP by ₹5,000/month?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <Button type="submit" disabled={building || !prompt.trim()}>
            {building ? "Building…" : "Build"}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => {
                setPrompt(p);
                build(p);
              }}
              disabled={building}
              className="rounded-sm border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-marigold-500 hover:text-marigold-600"
            >
              {p}
            </button>
          ))}
        </div>
      </Card>

      {error && (
        <Card className="border-loss">
          <p className="text-sm text-loss">{error}</p>
        </Card>
      )}

      {result && !result.understood && (
        <Card eyebrow="Couldn't parse this prompt">
          <p className="text-sm text-ink-soft">{result.explanation}</p>
        </Card>
      )}

      {result && result.understood && result.variants.length === 0 && (
        <Card eyebrow="Missing detail">
          <p className="text-sm text-ink-soft">{result.explanation}</p>
        </Card>
      )}

      {result && result.understood && result.ranked.length > 0 && (
        <>
          <Card eyebrow="Ranked variants" title={`Scenario: ${result.scenarioType}`}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {result.ranked.map((r, i) => {
                const variant = result.variants.find((v) => v.label === r.label)!;
                const style = VARIANT_STYLE[r.label];
                return (
                  <div key={r.label} className="rounded-sm border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wide ${style.badge}`}>{style.label}</span>
                      {i === 0 && <span className="text-[10px] font-medium text-marigold-600">#1</span>}
                    </div>
                    <p className="mt-2 font-mono text-lg text-ink">
                      {r.netWorthDeltaIn5Years >= 0 ? "+" : ""}
                      {formatINR(r.netWorthDeltaIn5Years)}
                    </p>
                    <p className="text-[11px] text-ink-faint">net worth change, 5 years</p>
                    <p className="mt-2 text-[11px] text-ink-soft">{JSON.stringify(variant.params)}</p>
                    {!r.feasible && (
                      <p className="mt-2 rounded-sm bg-marigold-50 px-2 py-1 text-[11px] text-marigold-600">{r.feasibilityNote}</p>
                    )}
                    {r.goalImpacts.map((g) => (
                      <p key={g.goalId} className="mt-1 text-[11px] text-ink-faint">{g.note}</p>
                    ))}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card eyebrow="Which variables drove this" title="Explanation">
            <p className="text-sm text-ink-soft">{result.explanation}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-faint">
              <span>
                Confidence: <span className="font-mono">{Math.round(result.explanationConfidence * 100)}%</span>
              </span>
              {!result.verificationPassed && (
                <span className="rounded-sm bg-marigold-50 px-2 py-0.5 text-marigold-600">
                  Composed explanation didn&apos;t verify — showing the underlying facts instead
                </span>
              )}
            </div>
          </Card>

          <Card eyebrow="Sensitivity analysis" title="How the outcome shifts">
            <div className="space-y-4">
              {result.sensitivity.map((dim) => (
                <div key={dim.field}>
                  <p className="text-xs text-ink-faint">{dim.dimension}</p>
                  <div className="mt-1 flex items-end gap-2 overflow-x-auto">
                    {dim.points.map((p) => {
                      const max = Math.max(...dim.points.map((pt) => Math.abs(pt.projectedNetWorthIn5Years)), 1);
                      const heightPercent = Math.max(4, (Math.abs(p.projectedNetWorthIn5Years) / max) * 100);
                      return (
                        <div key={p.paramValue} className="flex w-16 shrink-0 flex-col items-center">
                          <div className="flex h-20 w-full items-end">
                            <div
                              className={`w-full rounded-t-sm ${p.projectedNetWorthIn5Years >= 0 ? "bg-marigold-400" : "bg-loss"}`}
                              style={{ height: `${heightPercent}%` }}
                            />
                          </div>
                          <p className="mt-1 text-[10px] text-ink-faint">{p.paramValue}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
