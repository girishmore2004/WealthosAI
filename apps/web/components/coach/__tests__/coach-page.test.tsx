import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CoachPage from "../../../app/(app)/coach/page";

jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
jest.mock("@/lib/api-client", () => {
  class ApiError extends Error {}
  return { ApiError, api: { coach2: { history: jest.fn(), ask: jest.fn(), createPlan: jest.fn() } } };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { api, ApiError } = require("@/lib/api-client");

const result = (answer: string) => ({
  question: "What is my savings rate?",
  answer,
  staleAdviceNote: null,
  report: {
    directAnswer: answer,
    answerType: "fact",
    evidenceSufficiency: "sufficient",
    keyFindings: [],
    financialSnapshot: { asOf: "2026-10-15T00:00:00.000Z", currency: "INR", items: [] },
    evidenceCards: [],
    calculations: [],
    predictions: [],
    scenarioComparison: null,
    recommendations: [],
    actionPlan: [],
    charts: [],
    assumptions: [],
    risks: [],
    dataGaps: [],
    followUpSuggestions: [],
    executionActions: [],
    citations: [],
    metadata: { version: 1, generatedAt: "2026-10-15T00:00:00.000Z", engines: [], partial: false, explanationSource: "deterministic", executionMs: 1 },
  },
});

describe("Coach page", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows example questions when there is no history and asks one on click", async () => {
    api.coach2.history.mockResolvedValue([]);
    api.coach2.ask.mockResolvedValue(result("Your savings rate for 2026-09 is 40%."));
    render(<CoachPage />);
    fireEvent.click(await screen.findByText("What is my savings rate last month?"));
    await waitFor(() => expect(api.coach2.ask).toHaveBeenCalledWith("What is my savings rate last month?"));
    expect(await screen.findByText("Your savings rate for 2026-09 is 40%.")).toBeInTheDocument();
  });

  it("does not offer a separate Copilot chat or the old Deterministic/Advanced tabs", async () => {
    api.coach2.history.mockResolvedValue([]);
    render(<CoachPage />);
    await screen.findByText("What would you like to know?");
    expect(screen.queryByText("Deterministic")).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
    expect(screen.queryByText(/Copilot/i)).not.toBeInTheDocument();
  });

  it("restores earlier answers, oldest first, including their stored reports", async () => {
    api.coach2.history.mockResolvedValue([
      { id: "2", question: "second", answer: "newer", facts: { __report: result("newer").report }, createdAt: "2026-10-15T00:00:00.000Z", staleAdviceNote: null },
      { id: "1", question: "first", answer: "older", facts: {}, createdAt: "2026-10-14T00:00:00.000Z", staleAdviceNote: null },
    ]);
    render(<CoachPage />);
    await screen.findByText("older");
    const articles = screen.getAllByRole("article");
    expect(articles[0]).toHaveTextContent("first");
    expect(articles[1]).toHaveTextContent("second");
  });

  it("shows a retryable error and keeps the typed question when the Coach fails", async () => {
    api.coach2.history.mockResolvedValue([]);
    api.coach2.ask.mockRejectedValueOnce(new ApiError("Too many requests")).mockResolvedValueOnce(result("Recovered."));
    render(<CoachPage />);
    const input = await screen.findByLabelText("Ask the Coach");
    fireEvent.change(input, { target: { value: "What is my savings rate?" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests");
    expect((input as HTMLInputElement).value).toBe("What is my savings rate?");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered.")).toBeInTheDocument();
    expect(api.coach2.ask).toHaveBeenCalledTimes(2);
  });

  it("limits the question length", async () => {
    api.coach2.history.mockResolvedValue([]);
    render(<CoachPage />);
    expect(await screen.findByLabelText("Ask the Coach")).toHaveAttribute("maxLength", "500");
  });
});
