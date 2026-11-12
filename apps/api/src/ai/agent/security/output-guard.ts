import { AgentResponse } from "../agent.types";

// Data-leakage, secret and company-policy guard. Pure and deterministic (no model, no I/O) so it cannot be talked out of
// anything. It runs on the way IN (what the user typed, before it is stored or sent to a model) and on the way OUT (every text
// field of the final answer). It never removes the user's own ordinary financial figures: it targets identifiers and secrets.

export type GuardFlag =
  | "secret"
  | "card_number"
  | "government_id"
  | "bank_account"
  | "contact_detail"
  | "prompt_leak"
  | "guaranteed_returns"
  | "personalised_trade_advice"
  | "tax_legal_certainty"
  | "unsupported_claim";

const MASK = (s: string) => (s.length <= 4 ? "••••" : `••••${s.replace(/\D/g, "").slice(-4) || s.slice(-4)}`);

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface Rule {
  flag: GuardFlag;
  re: RegExp;
  replace: (m: string, ...g: string[]) => string | null; // null = leave unchanged (false positive)
}

const SENSITIVE_RULES: Rule[] = [
  // credentials / secrets
  { flag: "secret", re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replace: () => "[secret removed]" },
  { flag: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => "[secret removed]" },
  { flag: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => "[secret removed]" },
  { flag: "secret", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => "[secret removed]" },
  { flag: "secret", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: () => "Bearer [secret removed]" },
  { flag: "secret", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi, replace: () => "[connection string removed]" },
  { flag: "secret", re: /\b(password|passwd|pwd|secret|api[_-]?key|token|otp|pin|cvv)(?:\s+is)?\s*[:=]\s*\S+/gi, replace: (_m, k) => `${k}: [removed]` },
  // payment cards (Luhn-validated so ordinary large amounts are untouched)
  {
    flag: "card_number",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhn(d) ? `card ${MASK(d)}` : null;
    },
  },
  // Indian government identifiers
  { flag: "government_id", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replace: (m) => `PAN ••••${m.slice(-2)}` },
  { flag: "government_id", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, replace: (m) => `Aadhaar ${MASK(m)}` },
  // bank account numbers only when introduced as such (avoids hiding ordinary amounts)
  { flag: "bank_account", re: /\b(?:a\/c|acc(?:oun)?t)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*(\d{9,18})\b/gi, replace: (m, n) => m.replace(n, MASK(n)) },
  { flag: "bank_account", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, replace: () => "[IFSC removed]" },
  // contact details
  { flag: "contact_detail", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: (m) => `${m[0]}•••@${m.split("@")[1]}` },
  // phone: only with a +91 prefix or an introducing word, so a plain 10-digit amount is never hidden
  { flag: "contact_detail", re: /(?<![\d₹.,])\+91[ -]?[6-9]\d{9}(?![\d])/g, replace: (m) => `phone ${MASK(m)}` },
  { flag: "contact_detail", re: /\b(?:phone|mobile|mob|whatsapp|call|contact)(?:\s*(?:no\.?|number|#))?\s*(?:is|:|-)?\s*((?:\+?91[ -]?)?[6-9]\d{9})(?!\d)/gi, replace: (m, n) => m.replace(n, `••••${n.slice(-4)}`) },
];

/** Masks identifiers and secrets. Safe to call on any text; returns the flags that fired so callers can warn or refuse to store. */
export function redactSensitive(text: string): { text: string; flags: GuardFlag[] } {
  let out = text;
  const flags = new Set<GuardFlag>();
  for (const rule of SENSITIVE_RULES) {
    out = out.replace(rule.re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      const replaced = rule.replace(groups[0], ...groups.slice(1));
      if (replaced === null) return groups[0];
      flags.add(rule.flag);
      return replaced;
    });
  }
  return { text: out, flags: [...flags] };
}

export function containsSensitive(text: string): boolean {
  return redactSensitive(text).flags.length > 0;
}

// --- prompt / internals leakage ------------------------------------------------------------------------------------
const LEAK_PATTERNS: RegExp[] = [
  /<\/?untrusted_content/i,
  /\b(?:my|the)\s+(?:system|developer)\s+(?:prompt|instructions?|message)\b/i,
  /\byou are (?:wealthos|an? (?:ai|financial) (?:assistant|agent))\b.*\b(?:rules?|must|never)\b/i,
  /\b(?:tool_registry|AGENT_MEMORY_ENCRYPTION_KEY|GROQ_API_KEY|DATABASE_URL|REDIS_URL|SESSION_SECRET)\b/,
  /\b(?:agentToolExecution|agentMemory|agentApproval|agentCheckpoint)\b/,
];
export function leaksInternals(text: string): boolean {
  return LEAK_PATTERNS.some((p) => p.test(text));
}

// --- company policy ---------------------------------------------------------------------------------------------------
interface PolicyRule {
  flag: GuardFlag;
  re: RegExp;
  warning: string;
}
const POLICY_RULES: PolicyRule[] = [
  { flag: "guaranteed_returns", re: /\b(?:guarantee[ds]?|assured|risk[- ]free|sure[- ]?shot|certain)\b[^.!?\n]{0,40}\b(?:returns?|profits?|gains?|growth)\b|\b(?:returns?|profits?)\b[^.!?\n]{0,30}\b(?:are|is|will be)\s+(?:guaranteed|assured|risk[- ]free)\b/i, warning: "Removed wording that promised or guaranteed investment returns. No return can be guaranteed." },
  { flag: "personalised_trade_advice", re: /\b(?:you should|you must|i (?:recommend|advise|suggest) (?:that )?you|go ahead and|it is time to)\s+(?:now\s+)?(?:buy|sell|short|invest in|put (?:all|everything) (?:in|into))\b/i, warning: "Removed a personalised buy/sell instruction. I can explain options and trade-offs but cannot tell you what to trade." },
  { flag: "tax_legal_certainty", re: /\b(?:you (?:will not|won't|do not|don't) (?:have to|need to) pay (?:any )?tax|completely tax[- ]free for you|legally (?:safe|guaranteed)|no legal (?:risk|liability))\b/i, warning: "Removed a definite tax or legal conclusion. Please confirm tax and legal questions with a qualified professional." },
];

const DISCLAIMER = "This is general information based on your data, not personal financial, tax or legal advice.";

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

export function applyPolicy(text: string): { text: string; flags: GuardFlag[]; warnings: string[] } {
  const flags = new Set<GuardFlag>();
  const warnings: string[] = [];
  // Policy is applied per sentence, but line structure (headings, tables, lists) is preserved so formatted reports survive.
  const keepSentence = (s: string): boolean => {
    for (const r of POLICY_RULES) {
      if (r.re.test(s)) {
        flags.add(r.flag);
        if (!warnings.includes(r.warning)) warnings.push(r.warning);
        return false;
      }
    }
    return true;
  };
  const lines = text.split("\n").map((line) => {
    if (line.trim().length === 0) return line;
    if (/^\s*\|/.test(line)) return keepSentence(line) ? line : null; // table row: kept or dropped whole
    const parts = line.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
    const kept = parts.filter(keepSentence);
    return kept.length === 0 ? null : kept.join(" ");
  });
  return { text: lines.filter((l): l is string => l !== null).join("\n"), flags: [...flags], warnings };
}

// --- whole-response guard -------------------------------------------------------------------------------------------
export interface GuardInput {
  response: Omit<AgentResponse, "messageId">;
  /** True when at least one deterministic tool returned data this answer is based on. */
  hasEvidence: boolean;
}
export interface GuardResult {
  response: Omit<AgentResponse, "messageId">;
  flags: GuardFlag[];
  blocked: boolean;
}

const LEAK_REPLACEMENT = "I can't share details about how I work internally. I can help with your finances, goals, documents or plans instead.";
const STANDARD_ANSWER_TYPES = new Set(["answer", "approval_request", "action_result"]);

export function guardResponse({ response, hasEvidence }: GuardInput): GuardResult {
  const flags = new Set<GuardFlag>();
  const warnings = [...response.warnings];

  // 1. internals must never reach the user
  const fields = [response.response, ...Object.values(response.sections).flat(), ...response.followUps];
  if (fields.some(leaksInternals)) {
    return {
      blocked: true,
      flags: ["prompt_leak"],
      response: { ...response, response: LEAK_REPLACEMENT, answerType: "refusal", sections: { verifiedFacts: [], documentEvidence: [], historicalMemory: [], calculatedEstimates: [], assumptions: [], recommendations: [] }, evidence: [], followUps: [], warnings: ["The answer was withheld because it referred to internal system details."], confidence: 0 },
    };
  }

  // 2. company policy, then 3. sensitive-data masking, applied to every text field the client can see
  const clean = (t: string): string => {
    const p = applyPolicy(t);
    p.flags.forEach((f) => flags.add(f));
    p.warnings.forEach((w) => !warnings.includes(w) && warnings.push(w));
    const r = redactSensitive(p.text);
    r.flags.forEach((f) => flags.add(f));
    return r.text;
  };
  let main = clean(response.response);
  const sections = Object.fromEntries(Object.entries(response.sections).map(([k, v]) => [k, v.map(clean).filter((s) => s.trim().length > 0)])) as AgentResponse["sections"];
  const followUps = response.followUps.map((t) => redactSensitive(t).text);
  const evidence = response.evidence.map((e) => ({ ...e, ...(e.detail ? { detail: redactSensitive(e.detail).text } : {}) }));

  if (main.trim().length === 0) main = "I couldn't give a reliable answer to that. Please rephrase, or ask about a specific figure, goal or document.";
  if (flags.has("card_number") || flags.has("government_id") || flags.has("bank_account") || flags.has("secret") || flags.has("contact_detail")) {
    warnings.push("Sensitive identifiers were masked in this answer.");
  }

  // 4. faithfulness: an answer that is not backed by any of the user's data must say so and cannot be high-confidence
  let confidence = response.confidence;
  if (!hasEvidence && STANDARD_ANSWER_TYPES.has(response.answerType) && response.answerType === "answer" && response.intent !== "simple_question" && response.intent !== "memory_recall") {
    flags.add("unsupported_claim");
    confidence = Math.min(confidence, 0.4);
    warnings.push("This answer is not based on your own records, so treat it as general guidance.");
  }

  // 5. standing disclaimer whenever the answer contains advice or estimates
  const advisory = sections.recommendations.length > 0 || sections.calculatedEstimates.length > 0 || response.intent === "planning" || response.intent === "scenario_analysis";
  if (advisory && !warnings.includes(DISCLAIMER)) warnings.push(DISCLAIMER);

  return {
    blocked: false,
    flags: [...flags],
    response: { ...response, response: main, sections, followUps, evidence, warnings: [...new Set(warnings)], confidence },
  };
}
