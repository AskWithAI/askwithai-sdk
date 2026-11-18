import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Decision, ServingMode } from "./client";

/**
 * `createFauxAskWithAI()`: an in-process stand-in for the Decision API, for
 * an app's tests. No request leaves the process. Answers are stable: each
 * label and probability is drawn from a hash of the runtime, the question
 * and the input, so the same input always gets the same answer. Everything
 * it returns is marked `synthetic: true`.
 *
 *   const faux = createFauxAskWithAI({ runtimes: { "acme/refunds": { questions: [...] } } });
 *   const askwithai = new AskWithAI({ apiKey: "wai_test_faux_key_000000000000", fetch: faux.fetch, baseUrl: faux.url });
 *
 * It serves `/v1/decide`, `GET /v1/decisions/{id}`, outcomes, reviews and
 * input answers, runtimes (read and serving mode), the System One and Gemini
 * compatible endpoints, and `/v1/systemone`. `listen()` also serves it on a
 * local port for clients that cannot take a `fetch`.
 */

export interface FauxQuestion {
  key: string;
  type: "binary" | "pick_one";
  prompt: string;
  labels: string[];
}

export interface FauxRuntime {
  questions: FauxQuestion[];
  servingMode?: ServingMode;
}

export interface FauxOptions {
  runtimes: Record<string, FauxRuntime>;
  /** Open a person review for this question instead of answering (the decision is pending_review). */
  reviewWhen?: (a: { runtime: string; question: FauxQuestion; input: Record<string, unknown> }) => boolean;
  /** Ask for a missing fact before answering (the decision is input_required). */
  inputWhen?: (a: { runtime: string; input: Record<string, unknown> }) => { field: string; question: string; schema?: Record<string, unknown> } | null;
  /** Override an answer, for a test that needs a specific one. */
  answer?: (a: { runtime: string; question: FauxQuestion; input: Record<string, unknown> }) => string | undefined;
}

interface Stored {
  decision: Decision;
  input: Record<string, unknown>;
  runtime: string;
}

const hashUnit = (parts: unknown[]): number => parseInt(createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8), 16) / 0xffffffff;

export function createFauxAskWithAI(options: FauxOptions) {
  const decisions = new Map<string, Stored>();
  const outcomes: Array<{ decisionId: string; labels: Record<string, string>; key?: string }> = [];
  const reviews = new Map<string, { id: string; decisionId: string; question: string; labels: string[]; status: "pending" | "settled"; requestKind: "label" | "input"; field?: string; prompt?: string; schema?: Record<string, unknown>; version: number; decision?: string }>();
  const idempotency = new Map<string, string>();
  const modes = new Map(Object.entries(options.runtimes).map(([ref, r]) => [ref, r.servingMode ?? "active"]));

  const runtimeOf = (ref: string) => {
    const r = options.runtimes[ref.replace(/@v?\d+$/, "")];
    if (!r) throw new FauxError(404, "runtime_not_found", `No runtime "${ref}" in the faux server.`);
    return r;
  };

  function answerFor(ref: string, q: FauxQuestion, input: Record<string, unknown>) {
    const forced = options.answer?.({ runtime: ref, question: q, input });
    const u = hashUnit([ref, q.key, input]);
    const label = forced ?? q.labels[Math.floor(u * q.labels.length) % q.labels.length]!;
    const p = Math.round((0.55 + ((u * 1000) % 1) * 0.44) * 1e4) / 1e4;
    const dist = Object.fromEntries(q.labels.map((l) => [l, l === label ? p : Math.round(((1 - p) / (q.labels.length - 1)) * 1e4) / 1e4]));
    return { label, p, dist };
  }

  function decide(ref: string, body: { input?: unknown; serving?: string; escalate?: boolean; traceId?: string; requestId?: string }, opts: { excludePerson?: boolean } = {}): { stored: Stored; dists: Record<string, Record<string, number>> } {
    const runtime = runtimeOf(ref);
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) throw new FauxError(400, "invalid_input", "input must be a JSON object.");
    const input = body.input as Record<string, unknown>;
    const base = modes.get(ref.replace(/@v?\d+$/, "")) ?? "active";
    if (body.serving !== undefined && body.serving !== "parity" && body.serving !== "shadow") throw new FauxError(400, "invalid_serving", "serving may be parity or shadow.");
    const rank = { parity: 0, shadow: 1, active: 2 } as const;
    const servingMode = body.serving && rank[body.serving as ServingMode] < rank[base] ? (body.serving as ServingMode) : base;
    const id = `dec_faux_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const dists: Record<string, Record<string, number>> = {};
    const decisionsOut: Decision["decisions"] = {};
    const provisional: NonNullable<Decision["provisionalDecision"]> = {};
    const pending: NonNullable<Decision["reviews"]> = [];
    const inputReq = servingMode === "active" ? options.inputWhen?.({ runtime: ref, input }) : null;
    for (const q of runtime.questions) {
      const a = answerFor(ref, q, input);
      dists[q.key] = a.dist;
      if (!inputReq && servingMode === "active" && !opts.excludePerson && options.reviewWhen?.({ runtime: ref, question: q, input })) {
        const reviewId = `rev_faux_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        reviews.set(reviewId, { id: reviewId, decisionId: id, question: q.key, labels: q.labels, status: "pending", requestKind: "label", version: 1 });
        pending.push({ reviewId, question: q.key, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), onTimeout: "use_provisional" });
        provisional[q.key] = { label: a.label, p: a.p, final: false };
        decisionsOut[q.key] = { answer: null, final: false, answeredBy: "person", probability: null };
      } else decisionsOut[q.key] = { answer: inputReq ? null : a.label, final: !inputReq, answeredBy: "fast", probability: a.p };
    }
    const inputRequests: NonNullable<Decision["inputRequests"]> = [];
    if (inputReq) {
      const reviewId = `rev_faux_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const schema = inputReq.schema ?? { type: "string", minLength: 1 };
      reviews.set(reviewId, { id: reviewId, decisionId: id, question: "input", labels: [], status: "pending", requestKind: "input", field: inputReq.field, prompt: inputReq.question, schema, version: 1 });
      inputRequests.push({ reviewId, field: inputReq.field, question: inputReq.question, schema, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: 1 });
    }
    const status: Decision["status"] = inputRequests.length ? "input_required" : pending.length ? "pending_review" : "decided";
    const decision: Decision = {
      id, object: "decision", runtime: ref.replace(/@v?\d+$/, ""), version: 1, status, decisions: decisionsOut,
      ...(pending.length ? { reviews: pending, provisionalDecision: provisional } : {}),
      ...(inputRequests.length ? { inputRequests } : {}),
      path: "fast_only", costUsd: 0, costBasis: "reported", costUnknownCalls: 0, latencyMs: 1, synthetic: true, estimate: "provisional",
      servingMode,
      shadowResult: servingMode === "shadow" ? { decisions: Object.fromEntries(runtime.questions.map((q) => [q.key, { answer: answerFor(`${ref}#shadow`, q, input).label }])), synthetic: true } : null,
      receipt: { questions: {}, tierCalls: [{ tier: "fast", kind: "fast", model: "faux", ok: true, latencyMs: 1, costUsd: 0, costBasis: "reported" }], budget: null },
      outcomeStatus: "pending_window", requestId: body.requestId ?? null, traceId: body.traceId ?? null, createdAt: new Date().toISOString(),
    };
    const stored = { decision, input, runtime: ref };
    decisions.set(id, stored);
    return { stored, dists };
  }

  function wireAnswers(ref: string, requested: unknown, dists: Record<string, Record<string, number>>) {
    const runtime = runtimeOf(ref);
    const entries = requested && typeof requested === "object" && Object.keys(requested).length ? Object.entries(requested as Record<string, { instructions?: string; type?: string }>) : runtime.questions.map((q) => [q.key, { instructions: q.prompt }] as const);
    return Object.fromEntries(
      entries.map(([wire, raw]) => {
        const q = runtime.questions.find((x) => x.key === wire) ?? runtime.questions.find((x) => x.prompt === raw?.instructions);
        if (!q) throw new FauxError(422, "unknown_question", `questions.${wire} names no question of ${ref}.`);
        const d = dists[q.key]!;
        return [wire, q.type === "binary" ? { type: "noul", noul: d[q.labels[0]!] } : { type: "choice", choice: Object.entries(d).sort((a, b) => b[1] - a[1])[0]![0], probabilities: d }];
      }),
    );
  }

  async function handle(method: string, url: URL, headers: Headers, body: unknown): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const auth = headers.get("authorization") ?? (headers.get("x-goog-api-key") ? `Bearer ${headers.get("x-goog-api-key")}` : "");
    if (!/^Bearer wai_/.test(auth) && !(method === "GET" && url.pathname === "/v1/models")) throw new FauxError(401, "unauthorized", "Send an API key as Authorization: Bearer wai_...");
    const path = url.pathname.replace(/^\/api/, "");
    const key = headers.get("idempotency-key");
    const remember = (id: string) => {
      if (key) idempotency.set(key, id);
    };
    const replayed = key ? idempotency.get(key) : undefined;
    let m: RegExpMatchArray | null;
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === "POST" && (m = path.match(/^\/v1\/decide\/([^/]+\/[^/]+)$/))) {
      if (replayed) return { status: 200, body: decisions.get(replayed)!.decision };
      const { stored } = decide(m[1]!, b as never);
      remember(stored.decision.id);
      return { status: stored.decision.status === "decided" ? 200 : 202, body: stored.decision };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/decisions\/([^/]+)$/))) {
      const s = decisions.get(m[1]!);
      if (!s) throw new FauxError(404, "decision_not_found", "No such decision.");
      return { status: 200, body: { ...s.decision, timeline: [], steps: [], outcomes: outcomes.filter((o) => o.decisionId === m![1]) } };
    }
    if (method === "POST" && (m = path.match(/^\/v1\/decisions\/([^/]+)\/outcome$/))) {
      if (!decisions.has(m[1]!)) throw new FauxError(404, "decision_not_found", "No such decision.");
      outcomes.push({ decisionId: m[1]!, labels: b.labels as Record<string, string>, key: b.key as string | undefined });
      decisions.get(m[1]!)!.decision.outcomeStatus = "reported";
      return { status: 201, body: { id: `out_faux_${outcomes.length}`, replayed: false } };
    }
    if (method === "POST" && path === "/v1/outcomes") return handle("POST", new URL(`/v1/decisions/${String(b.decisionId)}/outcome`, url), headers, body);
    if (method === "POST" && (m = path.match(/^\/v1\/decisions\/([^/]+)\/input$/))) {
      const s = decisions.get(m[1]!);
      const r = [...reviews.values()].find((x) => x.decisionId === m![1] && x.requestKind === "input" && x.status === "pending" && (!b.field || x.field === b.field));
      if (!s || !r) throw new FauxError(409, "no_input_requested", "This decision is not waiting for any input.");
      if (b.value === undefined || b.value === null || b.value === "") throw new FauxError(422, "input_invalid", "The answer is empty.");
      const enumValues = (r.schema as { enum?: unknown[] } | undefined)?.enum;
      if (enumValues && !enumValues.includes(b.value)) throw new FauxError(422, "input_invalid", `The answer must be one of ${enumValues.join(", ")}.`);
      r.status = "settled";
      r.version++;
      s.input = { ...s.input, reviewerInput: { ...((s.input.reviewerInput as object) ?? {}), [r.field!]: b.value } };
      const runtime = runtimeOf(s.runtime);
      s.decision.status = "decided";
      delete s.decision.inputRequests;
      for (const q of runtime.questions) s.decision.decisions[q.key] = { answer: answerFor(s.runtime, q, s.input).label, final: true, answeredBy: "fast", probability: null };
      return { status: 200, body: s.decision };
    }
    if (method === "GET" && path === "/v1/reviews") {
      const status = url.searchParams.get("status") ?? "pending";
      return { status: 200, body: { data: [...reviews.values()].filter((r) => r.status === status).map((r) => ({ ...r, inputField: r.field, inputQuestion: r.prompt, inputSchema: r.schema })) } };
    }
    if (method === "POST" && (m = path.match(/^\/v1\/reviews\/([^/]+)\/settle$/))) {
      const r = reviews.get(m[1]!);
      if (!r) throw new FauxError(404, "review_not_found", "No such review.");
      if (r.requestKind === "input") throw new FauxError(400, "input_review", "Answer an input request with POST /v1/decisions/{id}/input.");
      if (r.status !== "pending") throw new FauxError(409, "review_closed", "This review is already settled.");
      if (b.expectedVersion !== r.version) throw new FauxError(409, "version_conflict", "The review changed since you loaded it.");
      if (!r.labels.includes(String(b.decision))) throw new FauxError(400, "invalid_label", `decision must be one of ${r.labels.join(", ")}.`);
      Object.assign(r, { status: "settled", decision: String(b.decision), version: r.version + 1 });
      const s = decisions.get(r.decisionId)!;
      s.decision.decisions[r.question] = { answer: String(b.decision), final: true, answeredBy: "person", probability: null };
      if (![...reviews.values()].some((x) => x.decisionId === r.decisionId && x.status === "pending")) {
        s.decision.status = "decided";
        delete s.decision.reviews;
        delete s.decision.provisionalDecision;
      }
      return { status: 200, body: { id: r.id, status: "settled", version: r.version } };
    }
    if ((m = path.match(/^\/v1\/runtimes\/([^/]+\/[^/]+)$/))) {
      const ref = m[1]!;
      const runtime = runtimeOf(ref);
      if (method === "PATCH" && b.servingMode !== undefined) {
        if (!["parity", "shadow", "active"].includes(String(b.servingMode))) throw new FauxError(400, "invalid_serving_mode", "servingMode must be parity, shadow or active.");
        modes.set(ref, b.servingMode as ServingMode);
      }
      const [owner, slug] = ref.split("/");
      return { status: 200, body: { id: `rt_faux_${slug}`, ref, owner, slug, name: slug, description: "", servingMode: modes.get(ref), servingModeChangedBy: null, servingModeChangedAt: null, liveVersion: { number: 1, config: { questions: runtime.questions } } } };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/runtimes\/([^/]+\/[^/]+)\/decisions$/))) {
      const ref = m[1]!;
      return { status: 200, body: { object: "list", data: [...decisions.values()].filter((s) => s.runtime.replace(/@v?\d+$/, "") === ref).map((s) => s.decision).reverse(), hasMore: false } };
    }
    if (method === "POST" && ((m = path.match(/^\/v1\/runtimes\/([^/]+\/[^/]+)(?:\/v1)?\/systemone$/)) || path === "/v1/systemone")) {
      const ref = m ? m[1]! : String(b.model ?? "");
      const { stored, dists } = decide(ref, { input: typeof b.state === "string" ? { text: b.state } : b.state }, { excludePerson: true });
      remember(stored.decision.id);
      return { status: 200, headers: { "AskWithAI-Decision-Id": stored.decision.id }, body: { id: stored.decision.id, model: `${ref}@v1`, answers: wireAnswers(ref, b.questions, dists), usage: { input_tokens: 0, output_tokens: 0 }, askwithai: { decision_id: stored.decision.id, status: stored.decision.status, serving_mode: stored.decision.servingMode, cost_usd: 0, cost_basis: "reported", latency_ms: 1, synthetic: true } } };
    }
    if (method === "POST" && (m = path.match(/^\/v1\/runtimes\/([^/]+\/[^/]+)\/gemini\/decisions$/))) {
      let input: unknown = b.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = { text: input };
        }
      }
      const { stored, dists } = decide(m[1]!, { input }, { excludePerson: true });
      return { status: 200, headers: { "AskWithAI-Decision-Id": stored.decision.id }, body: { model: `${m[1]}@v1`, answers: wireAnswers(m[1]!, b.questions, dists), usage: { total_input_tokens: 0, total_output_tokens: 0 } } };
    }
    if (method === "GET" && path === "/v1/models") {
      return { status: 200, body: { data: Object.keys(options.runtimes).map((id) => ({ id, name: id, architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, pricing: { prompt: "0", completion: "0", request: "0", image: "0" } })) } };
    }
    throw new FauxError(404, "not_found", `The faux server does not serve ${method} ${path}.`);
  }

  /** A `fetch` that answers in process. Give it to `new AskWithAI({ fetch })` or to a provider client. */
  const fauxFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return Response.json({ error: { code: "bad_json", message: "The request body is not valid JSON." } }, { status: 400 });
    }
    try {
      const out = await handle(req.method.toUpperCase(), url, req.headers, body);
      return Response.json(out.body, { status: out.status, headers: out.headers });
    } catch (e) {
      if (e instanceof FauxError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
      throw e;
    }
  }) as typeof fetch;

  let server: Server | null = null;
  return {
    fetch: fauxFetch,
    /** The base address to use with `fetch` (any host works; nothing is sent). */
    url: "http://faux.askwithai.test",
    /** Every decision made, newest last, with the input it was made on. */
    decisions: () => [...decisions.values()],
    outcomes: () => [...outcomes],
    reviews: () => [...reviews.values()],
    servingMode: (ref: string) => modes.get(ref),
    /** Serve on a local port (127.0.0.1) for clients that cannot take a `fetch`. Returns the base address. */
    async listen(port = 0): Promise<string> {
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const url = `http://127.0.0.1${req.url ?? "/"}`;
        const r = await fauxFetch(url, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
    },
    async close() {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}

export type FauxAskWithAI = ReturnType<typeof createFauxAskWithAI>;

class FauxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
