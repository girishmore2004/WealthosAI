import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CoachReportDTO } from "@wealthos/types";
import { CoachAnswer } from "../CoachAnswer";
import { CoachDetailsPanel } from "../CoachDetailsPanel";
import { ConfirmPlanDialog } from "../ConfirmPlanDialog";
import { reportFromFacts, safeInternalHref, turnFromRun } from "../coach-utils";

jest.mock("@/lib/api-client", () => {
  class ApiError extends Error {}
  return { ApiError, api: { coach2: { createPlan: jest.fn() } } };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { api, ApiError } = require("@/lib/api-client");

const base = (over: Partial<CoachReportDTO> = {}): CoachReportDTO => ({
  directAnswer: "Your savings rate for 2026-09 is 40%.",
  answerType: "fact",
  evidenceSufficiency: "sufficient",
  keyFindings: [{ text: "Saved ₹40,000 of ₹100,000 income.", tone: "good" }],
  financialSnapshot: { asOf: "2026-10-15T00:00:00.000Z", currency: "INR", items: [{ key: "income", label: "Income received", value: null, display: "Not recorded", unit: "INR", quality: "missing" }] },
  evidenceCards: [],
  calculations: [{ id: "c", label: "Savings rate", formula: "(income - spending) / income", inputs: [{ label: "Income", value: "₹100,000" }], result: 40, display: "40%", unit: "%", assumptions: [], quality: "verified" }],
  predictions: [],
  scenarioComparison: null,
  recommendations: [],
  actionPlan: [],
  charts: [],
  assumptions: ["Spending excludes investments."],
  risks: [],
  dataGaps: [{ code: "X", message: "No income recorded for 2026-08.", impact: "No rate shown." }],
  followUpSuggestions: ["Am I financially healthy?"],
  executionActions: [],
  citations: [],
  metadata: { version: 1, generatedAt: "2026-10-15T00:00:00.000Z", engines: [{ name: "calculations", status: "used" }], partial: false, explanationSource: "deterministic", executionMs: 12 },
  ...over,
});

const turn = (report: CoachReportDTO | null) => ({ id: "t1", question: "What is my savings rate?", answer: report?.directAnswer ?? "legacy", report, createdAt: "2026-10-15T00:00:00.000Z" });
const noop = () => {};

describe("CoachAnswer", () => {
  it("shows the direct answer, findings and follow-ups, and follow-ups ask the question", () => {
    const onFollowUp = jest.fn();
    render(<CoachAnswer turn={turn(base())} selected onSelect={noop} onAction={noop} onFollowUp={onFollowUp} busy={false} />);
    expect(screen.getByText("Your savings rate for 2026-09 is 40%.")).toBeInTheDocument();
    expect(screen.getByText("Saved ₹40,000 of ₹100,000 income.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Am I financially healthy?"));
    expect(onFollowUp).toHaveBeenCalledWith("Am I financially healthy?");
  });

  it("renders an older answer without a report as plain text", () => {
    render(<CoachAnswer turn={turn(null)} selected={false} onSelect={noop} onAction={noop} onFollowUp={noop} busy={false} />);
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.queryByText("Show details")).not.toBeInTheDocument();
  });

  it("renders hostile text as text, never as markup or a link", () => {
    const hostile = base({
      directAnswer: "<img src=x onerror=alert(1)> done",
      executionActions: [{ id: "a", kind: "OPEN", label: "Go", description: "d", href: "https://evil.example/steal", requiresConfirmation: false }],
    });
    const { container } = render(<CoachAnswer turn={turn(hostile)} selected={false} onSelect={noop} onAction={noop} onFollowUp={noop} busy={false} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> done/)).toBeInTheDocument();
    expect(container.querySelector('a[href^="http"]')).toBeNull();
  });

  it("offers the plan action as a button that hands the proposal to the confirm flow", () => {
    const action = { id: "create-plan", kind: "CREATE_PLAN" as const, label: "Create this plan", description: "d", requiresConfirmation: true, payload: { title: "t" } };
    const onAction = jest.fn();
    render(<CoachAnswer turn={turn(base({ executionActions: [action] }))} selected={false} onSelect={noop} onAction={onAction} onFollowUp={noop} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Create this plan" }));
    expect(onAction).toHaveBeenCalledWith(action);
  });

  it("labels partial and model-worded answers", () => {
    render(<CoachAnswer turn={turn(base({ evidenceSufficiency: "partial", explanation: "That means you keep 40%.", metadata: { ...base().metadata, partial: true, explanationSource: "model" } }))} selected={false} onSelect={noop} onAction={noop} onFollowUp={noop} busy={false} />);
    expect(screen.getByText("Partial data")).toBeInTheDocument();
    expect(screen.getByText("Some sources unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Worded by AI/)).toBeInTheDocument();
  });
});

describe("CoachDetailsPanel", () => {
  it("shows a missing figure as 'Not recorded', never as zero, plus the gaps, formula and assumptions", () => {
    render(<CoachDetailsPanel report={base()} />);
    expect(screen.getByText("Not recorded", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("No income recorded for 2026-08.")).toBeInTheDocument();
    expect(screen.getByText(/Formula: \(income - spending\) \/ income/)).toBeInTheDocument();
    expect(screen.getByText("Spending excludes investments.")).toBeInTheDocument();
  });

  it("explains itself when nothing is selected", () => {
    render(<CoachDetailsPanel report={null} />);
    expect(screen.getByText(/Ask a question to see the figures/)).toBeInTheDocument();
  });

  it("gives a chart with no numeric data a plain message instead of an empty drawing", () => {
    const chart = { id: "c", kind: "bar" as const, title: "Food by month", unit: "INR" as const, xKey: "month", series: [{ key: "amount", label: "Food" }], data: [{ month: "2026-09", amount: null }], source: "Expenses" };
    render(<CoachDetailsPanel report={base({ charts: [chart] })} />);
    expect(screen.getByText("No data recorded for this chart.")).toBeInTheDocument();
  });
});

describe("ConfirmPlanDialog", () => {
  const action = { id: "create-plan", kind: "CREATE_PLAN" as const, label: "Create this plan", description: "Saves a tracked plan.", requiresConfirmation: true, payload: { type: "SAVINGS_TARGET", title: "Save ₹500,000 in 24 months" }, preview: { title: "Save ₹500,000 in 24 months", changes: [{ label: "Target", value: "₹500,000" }] } };

  beforeEach(() => jest.clearAllMocks());

  it("writes nothing until Confirm is pressed, then sends the proposal's own payload", async () => {
    api.coach2.createPlan.mockResolvedValue({ planId: "p1", createdTaskIds: [] });
    const onCreated = jest.fn();
    const onClose = jest.fn();
    render(<ConfirmPlanDialog action={action} onClose={onClose} onCreated={onCreated} />);
    expect(api.coach2.createPlan).not.toHaveBeenCalled();
    expect(screen.getByText("₹500,000")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.coach2.createPlan).toHaveBeenCalledTimes(1));
    expect(api.coach2.createPlan).toHaveBeenCalledWith(action.payload);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("cancel does not create anything", () => {
    render(<ConfirmPlanDialog action={action} onClose={jest.fn()} onCreated={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.coach2.createPlan).not.toHaveBeenCalled();
  });

  it("shows a retryable error and keeps the dialog open when saving fails", async () => {
    api.coach2.createPlan.mockRejectedValue(new ApiError("Server said no"));
    const onClose = jest.fn();
    render(<ConfirmPlanDialog action={action} onClose={onClose} onCreated={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server said no");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm" })).not.toBeDisabled();
  });
});

describe("coach-utils", () => {
  it("only accepts in-app links", () => {
    expect(safeInternalHref("/goals")).toBe("/goals");
    expect(safeInternalHref("/scenario-studio?prompt=what%20if")).toBe("/scenario-studio?prompt=what%20if");
    for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "goals", "", undefined]) expect(safeInternalHref(bad as string | undefined)).toBeNull();
  });

  it("restores a stored report only when it has the report shape", () => {
    expect(reportFromFacts({ __report: base() })?.directAnswer).toMatch(/savings rate/);
    expect(reportFromFacts({ __report: { directAnswer: "x" } })).toBeNull();
    expect(reportFromFacts(null)).toBeNull();
    expect(reportFromFacts({ other: 1 })).toBeNull();
  });

  it("turns a history run into a chat turn", () => {
    const t = turnFromRun({ id: "r1", question: "q", answer: "a", facts: { __report: base() }, createdAt: "2026-10-15T00:00:00.000Z", staleAdviceNote: null } as never);
    expect(t.report).not.toBeNull();
    expect(t.question).toBe("q");
  });
});
