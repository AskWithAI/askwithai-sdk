import type { Decision } from "./client";

/** The receipt's step titles, the same words the AskWithAI screens use. */
export const RECEIPT_STEPS = { quickCheck: "Quick check", costCheck: "Cost check", secondLook: "Second look" } as const;

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * A decision's receipt as short plain lines: the summary, the three numbered
 * steps, then time and cost. Demo-mode decisions show the list-price estimate
 * instead of $0. Servers older than November 2026 send no summary; then only
 * the time and cost line is returned.
 */
export function formatReceipt(d: Pick<Decision, "receipt" | "latencyMs" | "costUsd" | "costUnknownCalls" | "synthetic">): string[] {
  const lines: string[] = [];
  const r = d.receipt;
  if (r.summary) lines.push(r.summary);
  if (r.explanation) {
    lines.push(`1. ${RECEIPT_STEPS.quickCheck}  ${r.explanation.quickCheck}`);
    lines.push(`2. ${RECEIPT_STEPS.costCheck}   ${r.explanation.costCheck}`);
    lines.push(`3. ${RECEIPT_STEPS.secondLook}  ${r.explanation.secondLook}`);
    lines.push(r.explanation.answer);
  }
  const cost = d.costUsd === null ? `unknown (${d.costUnknownCalls} ${d.costUnknownCalls === 1 ? "call" : "calls"})` : d.synthetic && r.estimatedCostUsd ? `${usd(r.estimatedCostUsd)} (estimated at list prices; simulated)` : usd(d.costUsd);
  lines.push(`${seconds(d.latencyMs)} · ${cost}`);
  return lines;
}
