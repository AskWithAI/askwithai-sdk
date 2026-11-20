import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AskWithAI, AskWithAIError, WithAI } from "./client";
import { createDecision, DecisionNotReadyError } from "./decision";
import { createFauxAskWithAI } from "./testing";

/*
 * The SDK against the faux server: typed decisions, verify(), escalateIf,
 * serving, shadow adoption with a legacy decider, waiting for input and
 * reviews, and the faux server's own guarantees (stable answers, nothing
 * leaves the process).
 */

const ALERTS = {
  questions: [
    { key: "suspicious", type: "binary" as const, prompt: "Is this alert suspicious?", labels: ["suspicious", "legitimate"] },
    { key: "typology", type: "pick_one" as const, prompt: "Which pattern fits?", labels: ["none", "card_testing", "account_takeover", "mule", "structuring"] },
  ],
};
const schema = z.object({ suspicious: z.enum(["suspicious", "legitimate"]), typology: z.enum(["none", "card_testing", "account_takeover", "mule", "structuring"]) });
const KEY = "wai_test_faux_key_0000000000000000";

function world(extra: Partial<Parameters<typeof createFauxAskWithAI>[0]> = {}) {
  const faux = createFauxAskWithAI({ runtimes: { "theory/alert-review": ALERTS }, ...extra });
  const client = new AskWithAI({ apiKey: KEY, baseUrl: faux.url, fetch: faux.fetch });
  return { faux, client };
}

describe("createDecision", () => {
  it("returns typed answers checked against the schema, and the full decision", async () => {
    const { client, faux } = world();
    const reviewAlert = createDecision(client, { runtime: "theory/alert-review", schema });
    await reviewAlert.verify();
    const { answers, final, decision } = await reviewAlert({ amount: 120, merchant: "m1" }, { traceId: "t1" });
    expect(final).toBe(true);
    expect(["suspicious", "legitimate"]).toContain(answers.suspicious);
    expect(decision!.synthetic).toBe(true);
    expect(faux.decisions()).toHaveLength(1);
    // Stable: the same input gets the same answers.
    expect((await reviewAlert({ amount: 120, merchant: "m1" })).answers).toEqual(answers);
  });

  it("verify() fails fast when the schema's labels drift from the runtime's", async () => {
    const { client } = world();
    const drifted = createDecision(client, { runtime: "theory/alert-review", schema: z.object({ suspicious: z.enum(["yes", "no"]), typology: schema.shape.typology }) });
    await expect(drifted.verify()).rejects.toThrow(/suspicious.*labels are suspicious, legitimate/);
    const missing = createDecision(client, { runtime: "theory/alert-review", schema: z.object({ suspicious: schema.shape.suspicious }) });
    await expect(missing.verify()).rejects.toThrow(/no field for the runtime's question "typology"/);
  });

  it("escalateIf and serving are sent with the call; the old WithAI name still works", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const { faux } = world();
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return faux.fetch(input, init);
    }) as typeof fetch;
    const client = new WithAI({ apiKey: KEY, baseUrl: faux.url, fetch: spy });
    const reviewAlert = createDecision(client, { runtime: "theory/alert-review", schema, escalateIf: (input: { amount: number }) => input.amount > 10_000 });
    await reviewAlert({ amount: 50_000 }, { serving: "parity" });
    await reviewAlert({ amount: 5 });
    expect(sent[0]).toMatchObject({ escalate: true, serving: "parity" });
    expect(sent[1]!.escalate).toBeUndefined();
  });

  it("legacy: returns the old decider's answer and records AskWithAI's in shadow; an outage never breaks the call", async () => {
    const { client, faux } = world();
    const reviewAlert = createDecision(client, { runtime: "theory/alert-review", schema });
    const legacy = () => ({ suspicious: "legitimate", typology: "none" }) as const;
    const r = await reviewAlert({ amount: 9 }, { legacy });
    expect(r.answers).toEqual({ suspicious: "legitimate", typology: "none" });
    expect(r.decision!.servingMode).toBe("shadow");
    expect(faux.decisions()[0]!.decision.servingMode).toBe("shadow");
    const down = new AskWithAI({ apiKey: KEY, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    const r2 = await createDecision(down, { runtime: "theory/alert-review", schema })({ amount: 9 }, { legacy });
    expect(r2).toMatchObject({ answers: { suspicious: "legitimate" }, decision: null });

    // A stalled AskWithAI request must not block the legacy answer past shadowTimeoutMs.
    let aborted = false;
    const hung = new AskWithAI({
      apiKey: KEY,
      fetch: ((_: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as typeof fetch,
    });
    const t0 = Date.now();
    const r3 = await createDecision(hung, { runtime: "theory/alert-review", schema })({ amount: 9 }, { legacy, shadowTimeoutMs: 40 });
    expect(r3).toMatchObject({ answers: { suspicious: "legitimate" }, decision: null });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(aborted).toBe(true);
  });

  it("refuses off-origin paths and invalid runtime references so API keys cannot leak", async () => {
    let called = false;
    const client = new AskWithAI({
      apiKey: KEY,
      baseUrl: "https://api.askwith.ai",
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    await expect(client.request("GET", ".attacker.com/steal")).rejects.toThrow(/must start with a single "\/"/);
    await expect(client.request("GET", "//attacker.com/steal")).rejects.toThrow(/must start with a single "\/"/);
    await expect(client.decide("../admin/secret", { input: {} })).rejects.toThrow(/Invalid runtime reference/);
    await expect(client.getRuntime("acme/refund?foo=bar")).rejects.toThrow(/Invalid runtime reference/);
    expect(called).toBe(false);
  });

  it("a pending person review gives provisional answers with final: false; settling makes them final", async () => {
    const { client } = world({ reviewWhen: ({ question }) => question.key === "suspicious" });
    const reviewAlert = createDecision(client, { runtime: "theory/alert-review", schema });
    const r = await reviewAlert({ amount: 9 });
    expect(r.final).toBe(false);
    const review = (await client.listReviews()).data[0]!;
    await client.settleReview(review.id, { decision: "suspicious", expectedVersion: review.version });
    const after = await client.getDecision(r.decision!.id);
    expect(after.status).toBe("decided");
    expect(after.decisions.suspicious!.answer).toBe("suspicious");
  });
});

describe("waiting, input requests and outcomes", () => {
  it("waitForDecision answers an input request from code and returns the final decision", async () => {
    const { client } = world({ inputWhen: ({ input }) => (input.currency ? null : { field: "currency", question: "Which currency?", schema: { type: "string", enum: ["USD", "EUR"] } }) });
    const d = await client.decide("theory/alert-review", { input: { amount: 9 } });
    expect(d.status).toBe("input_required");
    const asked: string[] = [];
    const done = await client.waitForDecision(d.id, { intervalMs: 1, onInputRequired: (req) => (asked.push(req.question), "EUR") });
    expect(asked).toEqual(["Which currency?"]);
    expect(done.status).toBe("decided");
    // Without a handler the wait returns at once, still waiting for the fact.
    const d2 = await client.decide("theory/alert-review", { input: { amount: 10 } });
    expect((await client.waitForDecision(d2.id, { intervalMs: 1 })).status).toBe("input_required");
    await expect(client.answerInput(d2.id, { field: "currency", value: "GBP" })).rejects.toMatchObject({ status: 422 });
  });

  it("reports outcomes, and a decision with no answer yet raises DecisionNotReadyError", async () => {
    const { client, faux } = world({ inputWhen: () => ({ field: "x", question: "x?" }) });
    const d = await client.decide("theory/alert-review", { input: { amount: 1 } });
    await client.reportOutcome(d.id, { labels: { suspicious: "legitimate" } });
    expect(faux.outcomes()).toHaveLength(1);
    await expect(createDecision(client, { runtime: "theory/alert-review", schema })({ amount: 1 })).rejects.toBeInstanceOf(DecisionNotReadyError);
  });

  it("errors carry the status and code; an unknown runtime is a 404", async () => {
    const { client } = world();
    const err = await client.decide("nobody/nothing", { input: { a: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AskWithAIError);
    expect(err).toMatchObject({ status: 404, code: "runtime_not_found" });
  });
});

describe("the faux server", () => {
  it("serves the System One and Gemini compatible endpoints with the decision id header, and honours Idempotency-Key", async () => {
    const { faux } = world();
    const body = JSON.stringify({ model: "theory/alert-review", state: { amount: 3 } });
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": "k1" };
    const a = await faux.fetch(`${faux.url}/v1/systemone`, { method: "POST", headers, body });
    const b = await faux.fetch(`${faux.url}/v1/runtimes/theory/alert-review/gemini/decisions`, { method: "POST", headers: { "x-goog-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ input: JSON.stringify({ amount: 3 }) }) });
    expect(a.headers.get("AskWithAI-Decision-Id")).toMatch(/^dec_faux_/);
    expect(((await a.json()) as { answers: Record<string, { type: string }> }).answers.suspicious!.type).toBe("noul");
    expect(b.status).toBe(200);
  });

  it("listen() serves the same API on a local port", async () => {
    const { faux } = world();
    const url = await faux.listen();
    try {
      const client = new AskWithAI({ apiKey: KEY, baseUrl: url });
      expect((await client.decide("theory/alert-review", { input: { amount: 1 } })).status).toBe("decided");
      expect((await client.setServingMode("theory/alert-review", "shadow")).servingMode).toBe("shadow");
    } finally {
      await faux.close();
    }
  });
});
