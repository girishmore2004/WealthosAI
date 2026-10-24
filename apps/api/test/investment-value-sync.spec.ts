import { NotFoundException } from "@nestjs/common";
import { InvestmentsService } from "../src/investments/investments.service";

// Editing a holding's value must reach Net Worth / the Home dashboard, which read the latest DATED
// valuation. And the dashboard's headline investment value must be the same number Net Worth uses.
function build() {
  const tx = {
    investment: { findFirst: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    investmentValuation: { create: jest.fn(async ({ data }: any) => data) },
  };
  const client = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    investment: { findUnique: jest.fn(async () => ({ id: "i1" })), updateMany: jest.fn(), findMany: jest.fn() },
    goal: { findUnique: jest.fn() },
  };
  return { svc: new InvestmentsService({ client } as never), tx, client };
}

describe("InvestmentsService.update keeps Net Worth in step", () => {
  it("a changed value is also recorded as a dated manual valuation, atomically", async () => {
    const { svc, tx, client } = build();
    tx.investment.findFirst.mockResolvedValue({ currentValue: 100000 });
    await svc.update("u1", "i1", { currentValue: 125000 } as never);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.investment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1", userId: "u1" } }));
    expect(tx.investmentValuation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "u1", investmentId: "i1", value: 125000, origin: "MANUAL" }) });
  });

  it("an unchanged value adds no valuation row", async () => {
    const { svc, tx } = build();
    tx.investment.findFirst.mockResolvedValue({ currentValue: 100000 });
    await svc.update("u1", "i1", { currentValue: 100000, name: "Renamed" } as never);
    expect(tx.investmentValuation.create).not.toHaveBeenCalled();
  });

  it("someone else's holding is a 404 and nothing is written", async () => {
    const { svc, tx } = build();
    tx.investment.findFirst.mockResolvedValue(null);
    await expect(svc.update("u1", "theirs", { currentValue: 5 } as never)).rejects.toThrow(NotFoundException);
    expect(tx.investment.updateMany).not.toHaveBeenCalled();
    expect(tx.investmentValuation.create).not.toHaveBeenCalled();
  });

  it("edits that do not touch the value never open a transaction", async () => {
    const { svc, client } = build();
    client.investment.updateMany.mockResolvedValue({ count: 1 });
    await svc.update("u1", "i1", { name: "x" } as never);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe("InvestmentsService.totalCurrentValue matches Net Worth", () => {
  it("uses each holding's latest valuation, falling back to the saved value only when there is none", async () => {
    const { svc, client } = build();
    client.investment.findMany.mockResolvedValue([
      { currentValue: 100, valuations: [{ value: 150 }] },
      { currentValue: 200, valuations: [] },
    ]);
    expect(await svc.totalCurrentValue("u1")).toBe(350);
    expect(client.investment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
  });
});
