import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export interface ActivePrompt {
  name: string;
  version: number;
  template: string;
}

// Prompts are code, but versioned in the DB rather than only in source, so
// AiInteractionLog.promptVersion can point at immutable template text forever —
// changing a prompt later must never silently rewrite what an old log row meant.
//
// DEFAULT_PROMPTS below is the source of truth for prompt *content*; this service's
// job is to get that content into AiPromptVersion (once, idempotently, on boot) and
// serve the active version back out by name. There is no admin UI to edit prompts yet
// — bumping a prompt today means adding a new entry to DEFAULT_PROMPTS with an
// incremented version and redeploying, which is the same "changes reviewed like code"
// property every other config in this repo has.
const DEFAULT_PROMPTS: ActivePrompt[] = [
  {
    name: "ai.health.classify_ping",
    version: 1,
    template:
      "You are a health-check probe for an AI gateway. Given the input, classify it as " +
      'either "ping" or "other". This is a synthetic self-test with no real user data.',
  },
  {
    name: "rag.query_rewrite",
    version: 1,
    template:
      "You help a personal-finance search system understand a user's question. Given their question, " +
      "produce 1-3 alternate phrasings that would help match it against source text that may use different " +
      "wording (synonyms, more formal/less formal phrasing). Also decide whether the question genuinely " +
      "bundles multiple distinct things that would each need their own search (e.g. a comparison across two " +
      "time periods, or two unrelated asks joined by 'and') — if so, set isMultiHop true and list the " +
      "sub-questions; otherwise isMultiHop is false and subQuestions is empty. Do not answer the question " +
      "itself, only rephrase/decompose it.",
  },
  {
    // v2 adds queryType/complexity classification, which drives HybridRetrievalService's
    // per-query-type weight profile and adaptive top-k downstream — see rag.constants.ts.
    name: "rag.query_rewrite",
    version: 2,
    template:
      "You help a personal-finance search system understand a user's question. Given their question, " +
      "produce 1-3 alternate phrasings that would help match it against source text that may use different " +
      "wording (synonyms, more formal/less formal phrasing). Also decide whether the question genuinely " +
      "bundles multiple distinct things that would each need their own search (e.g. a comparison across two " +
      "time periods, or two unrelated asks joined by 'and') — if so, set isMultiHop true and list the " +
      "sub-questions; otherwise isMultiHop is false and subQuestions is empty. Classify queryType as " +
      "factual (a specific lookup, e.g. a balance or a due date), comparative (across two time periods or " +
      "entities), analytical (a judgment call over scattered evidence, e.g. 'am I on track'), or exploratory " +
      "(open-ended/general). Classify complexity as simple (one clear fact), moderate (a normal single-topic " +
      "question), or complex (compound/multi-hop, or requires synthesizing many sources). Do not answer the " +
      "question itself, only rephrase/decompose/classify it.",
  },
  {
    name: "rag.rerank",
    version: 1,
    template:
      "You are reranking search results for a personal-finance app. Given a criterion and a numbered list of " +
      "candidate snippets (each tagged with its source type), order the indices from most to least relevant " +
      "to the criterion. Prefer snippets that directly address the question over ones that are only " +
      "topically related. Give a short rationale for your ordering.",
  },
  {
    name: "rag.synthesis",
    version: 1,
    template:
      "You answer a user's question about their own personal finances using ONLY the numbered sources " +
      "provided — never information from general knowledge or anything not in the sources. If the sources " +
      "don't actually contain enough to answer the question, set hasEvidence to false and leave the answer " +
      "empty rather than guessing or partially answering from outside knowledge. When you do answer, cite " +
      "every source index you actually relied on. Be concise and factual — this is financial information, " +
      "not conversation filler.",
  },
  {
    // v2: every numeric claim in the answer must be traceable to a number that
    // actually appears in the provided sources (including the broader parent-context
    // passed alongside them) — the gateway independently verifies this and will ask
    // for a correction if a figure doesn't check out, so the model should treat that
    // as a real constraint rather than a suggestion.
    name: "rag.synthesis",
    version: 2,
    template:
      "You answer a user's question about their own personal finances using ONLY the numbered sources " +
      "provided — never information from general knowledge or anything not in the sources. Every number you " +
      "state (amounts, percentages, dates, counts) must be one that actually appears in the sources — do not " +
      "compute, estimate, or restate a number that isn't directly present in the provided text, even if it " +
      "seems like an obvious derivation; if a calculation is needed, only report it when the sources contain " +
      "the exact result already. If the sources don't actually contain enough to answer the question, set " +
      "hasEvidence to false and leave the answer empty rather than guessing or partially answering from " +
      "outside knowledge. When you do answer, cite every source index you actually relied on. Be concise and " +
      "factual — this is financial information, not conversation filler.",
  },
  {
    name: "coach2.classify_advanced",
    version: 1,
    template:
      "You classify a personal-finance question into exactly one category from the given list, based on " +
      "the descriptions provided. Pick the single best-fitting category. If genuinely nothing fits well, " +
      "choose general_search.",
  },
  {
    name: "coach2.prioritize",
    version: 1,
    template:
      "You are ranking a personal-finance user's open items (alerts and off-track goals) by how urgently " +
      "they should be addressed. Consider severity, financial impact, and how close a deadline or target " +
      "might be. Order the indices most-urgent-first.",
  },
  {
    name: "coach2.compare_periods_parse",
    version: 1,
    template:
      "You extract which two time periods a user's question is asking to compare, as YYYY-MM month " +
      "strings. If the question doesn't clearly name two periods, use the defaults given in the input " +
      "verbatim. Do not invent a period the input didn't suggest.",
  },
  {
    name: "coach2.explain_deterministic",
    version: 1,
    template:
      "You add brief, plain-language context around an already-correct, already-computed personal-finance " +
      "answer — helping the user understand what it means for them, not recalculating it. Use ONLY the " +
      "numbers given in the facts; do not compute, estimate, round differently, or introduce any figure " +
      "that isn't already stated in the facts. Keep it concise — one to three sentences of added context, " +
      "not a restated essay.",
  },
  {
    name: "coach2.compose_prioritize_actions",
    version: 1,
    template:
      "You compose a short, plain-language answer telling the user what to prioritize, using ONLY the " +
      "already-ordered list of items given in the facts — do not reorder them yourself, do not introduce " +
      "any item or figure not already listed, and do not invent urgency reasons beyond what's stated.",
  },
  {
    name: "coach2.compose_goal_conflict",
    version: 1,
    template:
      "You compose a short, plain-language answer about whether the user's financial goals are realistic " +
      "given their surplus, using ONLY the numbers given in the facts. State clearly whether they are " +
      "overcommitted, whether targets are reachable at the current pace, and by roughly how much (using " +
      "only figures already given) — do not calculate anything not already computed in the facts.",
  },
  {
    name: "coach2.compose_risk_tradeoff",
    version: 1,
    template:
      "You compose a short, plain-language answer about a debt-vs-investment risk tradeoff, using ONLY the " +
      "numbers and comparison already given in the facts. Present both sides fairly (a loan is a guaranteed " +
      "return, an investment return is not) rather than issuing a single directive recommendation — this " +
      "is educational framing, not personalized financial advice.",
  },
  {
    name: "coach2.compose_compare_periods",
    version: 1,
    template:
      "You compose a short, plain-language comparison between two time periods, using ONLY the figures " +
      "already given in the facts (income, expenses, savings rate, and the precomputed differences). Do " +
      "not recompute any difference yourself — use the ones already given.",
  },
  {
    name: "coach2.compose_compare_periods",
    version: 1,
    template:
      "You compose a short, plain-language comparison between two time periods, using ONLY the figures " +
      "already given in the facts (income, expenses, savings rate, and the precomputed differences). Do " +
      "not recompute any difference yourself — use the ones already given.",
  },
  {
    name: "coach2.parse_calculation_request",
    version: 1,
    template:
      "You extract a structured deterministic calculation request from a user's question — which " +
      "operation (a hypothetical EMI, the maximum affordable loan for a given EMI budget, a loan payoff " +
      "timeline with extra monthly payment, a savings projection, or the required monthly savings " +
      "contribution to reach a target), and only the numeric fields relevant to that operation. Never " +
      "invent a number the user didn't state — leave a field unset rather than guessing.",
  },
  {
    name: "coach2.parse_plan_request",
    version: 1,
    template:
      "You extract a structured long-running financial plan request from a user's question — which type of " +
      "plan (debt payoff, savings target, retirement, investment allocation, or custom), a short title, the " +
      "target amount if one was stated, the timeline in months if one was stated, and any specific loan or " +
      "goal the user referred to by name. Never invent a target amount or timeline the user didn't actually " +
      "state — leave it unset instead so the system can ask rather than silently guess.",
  },
  {
    name: "coach2.compose_create_plan",
    version: 1,
    template:
      "You compose a short, plain-language confirmation that a financial plan has been created, using ONLY " +
      "the numbers given in the facts (the starting value, target, target date, and required pace). " +
      "Explain what the plan tracks and what the user needs to do to stay on pace — do not invent any " +
      "figure not already given, and do not promise the plan will succeed.",
  },
  {
    name: "coach2.compose_plan_progress",
    version: 1,
    template:
      "You compose a short, plain-language status update on one or more financial plans, using ONLY the " +
      "numbers already given in the facts (current value, expected value, and whether each is on track). " +
      "Be direct about whether the user is on track or falling behind — do not soften a genuinely behind- " +
      "schedule plan into sounding fine, and do not calculate anything not already given.",
  },
  {
    name: "coach2.compose_calculation",
    version: 1,
    template:
      "You compose a short, plain-language answer to a personal-finance calculation question, using ONLY " +
      "the already-computed numbers given in the facts. Do not perform any calculation yourself — the " +
      "numbers in the facts are the complete, correct answer; your job is only to phrase them clearly.",
  },
  {
    name: "coach2.critic_check",
    version: 1,
    template:
      "You review a personal-finance coaching answer for two problems: (1) overpromising — absolute or " +
      'guarantee language like "guaranteed", "risk-free", "you will definitely" about outcomes that are ' +
      "never actually certain, and (2) unsafe advice — suggestions like borrowing against retirement " +
      "savings, dropping insurance, or concentrating all savings into one option. Classify as exactly one " +
      "of: safe, overpromising, unsafe_advice, needs_disclaimer (a directive recommendation stated as fact " +
      "rather than informational framing). Choose safe only if none of these problems are present.",
  },
  {
    name: "scenario_studio.parse_prompt",
    version: 1,
    template:
      "You parse a personal-finance what-if question into a structured scenario type and its numeric " +
      "parameters, from a fixed list of supported scenario types. You never invent or estimate a large " +
      "ambiguous amount the prompt didn't actually specify — leave it out so the system can ask for it " +
      "explicitly instead of silently guessing a number the user didn't give.",
  },
  {
    name: "scenario_studio.explain",
    version: 1,
    template:
      "You explain, briefly and in plain language, which variable(s) drove the difference in outcome " +
      "across a set of already-computed personal-finance scenario variants, using ONLY the numbers given. " +
      "Never calculate a new figure yourself — only refer to the ones already provided.",
  },
  {
    name: "copilot_ingestion.statement_understanding",
    version: 1,
    template:
      "You extract transactions from messy bank/card statement lines that didn't parse cleanly with a " +
      "regular parser — each line should have a date, an amount, and a merchant description. Only extract " +
      "a transaction if you can find something resembling all three; skip lines that are clearly headers, " +
      "page footers, or running balances rather than actual transactions. Mark isDebit false for money " +
      "coming in (credits, refunds, reversals) — this pipeline only imports expenses.",
  },
  {
    name: "copilot_ingestion.suggest_category",
    version: 1,
    template:
      "You suggest the single best-fitting category for a merchant, chosen from the exact list of " +
      "categories given — never propose a category outside that list.",
  },
  {
    name: "ml_insights.explain_anomaly",
    version: 1,
    template:
      "You explain, briefly and in plain language, the most likely reason(s) a set of expense transactions " +
      "were flagged as statistical outliers, using ONLY the deterministic likely-cause facts already given " +
      "for each one (e.g. new merchant, first transaction in category, recurring amount changed, magnitude " +
      "vs. category median). Never invent a cause, merchant, or number not present in the facts.",
  },
];

@Injectable()
export class PromptRegistryService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    for (const prompt of DEFAULT_PROMPTS) {
      await this.prisma.client.aiPromptVersion.upsert({
        where: { name_version: { name: prompt.name, version: prompt.version } },
        update: {},
        create: { name: prompt.name, version: prompt.version, template: prompt.template, isActive: true },
      });
    }
  }

  async getActive(name: string): Promise<ActivePrompt> {
    const row = await this.prisma.client.aiPromptVersion.findFirst({
      where: { name, isActive: true },
      orderBy: { version: "desc" },
    });

    if (!row) {
      // Falling back to an in-code default (if one exists) keeps a misconfigured DB
      // from taking down every AI feature at once — but this path always means
      // something is wrong (a prompt was referenced that was never registered), so it
      // still throws when there's truly nothing to fall back to.
      const fallback = DEFAULT_PROMPTS.find((p) => p.name === name);
      if (fallback) return fallback;
      throw new Error(`No active prompt registered for "${name}"`);
    }

    return { name: row.name, version: row.version, template: row.template };
  }
}
