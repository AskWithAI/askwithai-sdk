import { describe, expect, it } from "vitest";
import { formatReceipt } from "./receipt";

const explanation = { quickCheck: "The fast model was 55% sure of its answer.", costCheck: "A mistake here would likely cost about $12.49, more than asking the reasoning model ($0.018), so AskWithAI asked.", secondLook: "The reasoning model answered billing.", answer: "Answer: billing." };

describe("formatReceipt", () => {
  it("prints the summary, the three numbered steps, then time and cost", () => {
    const lines = formatReceipt({ receipt: { summary: "The fast model was not enough, so the reasoning model answered billing.", explanation, questions: {}, tierCalls: [], budget: null }, latencyMs: 1300, costUsd: 0.0021, costUnknownCalls: 0, synthetic: false });
    expect(lines).toEqual([
      "The fast model was not enough, so the reasoning model answered billing.",
      "1. Quick check  The fast model was 55% sure of its answer.",
      "2. Cost check   A mistake here would likely cost about $12.49, more than asking the reasoning model ($0.018), so AskWithAI asked.",
      "3. Second look  The reasoning model answered billing.",
      "Answer: billing.",
      "1.3 s · $0.0021",
    ]);
  });
  it("shows the list-price estimate for demo calls instead of $0", () => {
    const lines = formatReceipt({ receipt: { estimatedCostUsd: 0.01806, questions: {}, tierCalls: [], budget: null }, latencyMs: 40, costUsd: 0, costUnknownCalls: 0, synthetic: true });
    expect(lines).toEqual(["40 ms · $0.0181 (estimated at list prices; simulated)"]);
  });
  it("never shows an unknown cost as $0", () => {
    expect(formatReceipt({ receipt: { questions: {}, tierCalls: [], budget: null }, latencyMs: 10, costUsd: null, costUnknownCalls: 1, synthetic: false })).toEqual(["10 ms · unknown (1 call)"]);
  });
});
