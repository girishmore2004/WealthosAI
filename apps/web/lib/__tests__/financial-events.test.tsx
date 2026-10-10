import { act, render, screen } from "@testing-library/react";
import { emitFinancialChange, onFinancialChange, useFinancialVersion } from "../financial-events";

function Probe({ kinds }: { kinds?: Parameters<typeof useFinancialVersion>[0] }) {
  const v = useFinancialVersion(kinds);
  return <p data-testid="v">{v}</p>;
}

describe("financial event bus", () => {
  it("tells listeners what kind of change happened, and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    emitFinancialChange("expense");
    emitFinancialChange("receivable");
    off();
    emitFinancialChange("transfer");
    expect(seen).toEqual(["expense", "receivable"]);
  });

  it("one failing listener never stops the others from refreshing", () => {
    const ok = jest.fn();
    const offBad = onFinancialChange(() => {
      throw new Error("boom");
    });
    const offOk = onFinancialChange(ok);
    expect(() => emitFinancialChange("expense")).not.toThrow();
    expect(ok).toHaveBeenCalledWith("expense");
    offBad();
    offOk();
  });

  it("useFinancialVersion increments on every relevant change so data effects re-run", () => {
    render(<Probe />);
    expect(screen.getByTestId("v")).toHaveTextContent("0");
    act(() => emitFinancialChange("expense"));
    act(() => emitFinancialChange("investment"));
    expect(screen.getByTestId("v")).toHaveTextContent("2");
  });

  it("can be limited to the kinds a widget cares about", () => {
    render(<Probe kinds={["receivable"]} />);
    act(() => emitFinancialChange("expense"));
    expect(screen.getByTestId("v")).toHaveTextContent("0");
    act(() => emitFinancialChange("receivable"));
    expect(screen.getByTestId("v")).toHaveTextContent("1");
  });

  it("unsubscribes on unmount (no leaks, no updates on unmounted components)", () => {
    const { unmount } = render(<Probe />);
    unmount();
    expect(() => act(() => emitFinancialChange("expense"))).not.toThrow();
  });
});
