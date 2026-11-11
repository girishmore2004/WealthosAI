// Minimal in-memory stand-in for the Prisma delegates the agent uses. Supports equality, in/notIn/gt/gte/lt/lte/not,
// OR, compound-unique where keys (a_b: {a, b}), increment, orderBy and take. Test helper only.
type Row = Record<string, any>;

function matchValue(actual: any, cond: any): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]: [string, any]) => {
      switch (op) {
        case "in": return v.includes(actual);
        case "notIn": return !v.includes(actual);
        case "gt": return actual > v;
        case "gte": return actual >= v;
        case "lt": return actual < v;
        case "lte": return actual <= v;
        case "not": return actual !== v;
        default: return true;
      }
    });
  }
  return actual === cond || (actual instanceof Date && cond instanceof Date && actual.getTime() === cond.getTime());
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
    if (k.includes("_") && v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v).every((x) => x in row || k.split("_").includes(x))) {
      return matches(row, v);
    }
    return matchValue(row[k], v);
  });
}

let seq = 0;
export class FakeDelegate {
  constructor(private defaults: Row = {}) {}
  rows: Row[] = [];
  create = async ({ data }: { data: Row }) => {
    const now = new Date();
    const row = { id: `id_${++seq}`, createdAt: now, updatedAt: now, ...this.defaults, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    this.rows.push(row);
    return { ...row };
  };
  private apply(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = (row[k] ?? 0) + (v as Row).increment;
      else row[k] = v;
    }
    row.updatedAt = new Date();
  }
  findUnique = async ({ where }: { where: Row }) => { const r = this.rows.find((x) => matches(x, where)); return r ? { ...r } : null; };
  findFirst = async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => { const r = (await this.findMany({ where, orderBy, take: 1 }))[0]; return r ?? null; };
  findMany = async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) => {
    let out = this.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    if (orderBy) {
      const [[k, dir]] = Object.entries(orderBy);
      out.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return take ? out.slice(0, take) : out;
  };
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const r = this.rows.find((x) => matches(x, where));
    if (!r) throw new Error("Record not found");
    this.apply(r, data);
    return { ...r };
  };
  updateMany = async ({ where, data }: { where?: Row; data: Row }) => {
    const hit = this.rows.filter((r) => matches(r, where));
    hit.forEach((r) => this.apply(r, data));
    return { count: hit.length };
  };
  upsert = async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
    const r = this.rows.find((x) => matches(x, where));
    if (r) { this.apply(r, update); return { ...r }; }
    return this.create({ data: create });
  };
  delete = async ({ where }: { where: Row }) => {
    const i = this.rows.findIndex((x) => matches(x, where));
    if (i < 0) throw new Error("Record not found");
    return this.rows.splice(i, 1)[0];
  };
  deleteMany = async ({ where }: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  };
  count = async ({ where }: { where?: Row } = {}) => this.rows.filter((r) => matches(r, where)).length;
}

// Column defaults the real schema provides.
const DEFAULTS: Record<string, Row> = {
  agentApproval: { status: "PENDING", executedAt: null, result: null, error: null, decidedAt: null },
  agentMemory: { accessCount: 0, supersededById: null, subjectKey: null, expiresAt: null, embedding: [], embeddingVersion: null, lastAccessedAt: null },
};

export function fakePrisma() {
  const models = new Map<string, FakeDelegate>();
  const client = new Proxy({} as Record<string, FakeDelegate>, {
    get: (_t, name: string) => {
      if (!models.has(name)) models.set(name, new FakeDelegate(DEFAULTS[name] ?? {}));
      return models.get(name)!;
    },
  });
  return { client, models, table: (n: string) => client[n].rows };
}
