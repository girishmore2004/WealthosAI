// Prisma raises P2002 for a unique-constraint violation. Checked structurally (rather
// than with `instanceof Prisma.PrismaClientKnownRequestError`) so idempotency code that
// relies on it stays easy to unit test and survives duplicate Prisma client instances.
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
