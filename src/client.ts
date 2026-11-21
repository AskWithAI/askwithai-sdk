/**
 * The AskWithAI client: a small typed wrapper over the Decision API.
 *
 *   const askwithai = new AskWithAI({ apiKey: process.env.ASKWITHAI_API_KEY! });
 *   const d = await askwithai.decide("acme/refund-check", { input: { amount: 42 } });
 *
 * Every call is plain `fetch`, so it runs in Node 22, edge runtimes and the
 * browser (never put a secret key in a browser). Pass `fetch` to test against
 * `createFauxAskWithAI()` from `@askwithai/sdk/testing`.
 */

export interface DecisionAnswer {
  answer: string | null;
  final: boolean;
  answeredBy: string;
  probability: number | null;
}

export interface DecisionCitation {
  quote: string;
  source?: string;
  locator?: string;
}

export interface DecisionQuestionReceipt {
  answeredBy: string;
  path: string[];
  pRaw: number | null;
  p: number | null;
  pFinal: number | null;
  lossNow: number | null;
  values: Record<string, number>;
  band: { low: number; high: number };
  lambda: number;
  reason: string;
  warnings: string[];
  citations: DecisionCitation[];
  /** This question's steps in plain words (servers from November 2026 on). */
  explanation?: ReceiptExplanation;
}

/** A receipt's three steps in plain words, built by the server's routing code, not by a model. */
export interface ReceiptExplanation {
  /** Step 1: what the fast model said and how sure it was. */
  quickCheck: string;
  /** Step 2: whether a second opinion was worth its price, given what a mistake would cost. */
  costCheck: string;
  /** Step 3: what the second opinion said, or why none was needed. */
  secondLook: string;
  /** The final answer, or what the decision is waiting for. */
  answer: string;
}

/** Where a cost came from. An unknown cost is null, never 0. */
export type CostBasis = "reported" | "estimate" | "unknown";
export type ServingMode = "parity" | "shadow" | "active";
export type DecisionStatus = "running" | "decided" | "pending_review" | "input_required" | "paused" | "failed";

export interface InputRequest {
  reviewId: string;
  field: string;
  question: string;
  schema: Record<string, unknown>;
  deadlineAt: string;
  expectedVersion: number;
}

export interface Decision {
  id: string;
  object: "decision";
  runtime: string;
  version: number;
  status: DecisionStatus;
  decisions: Record<string, DecisionAnswer>;
  provisionalDecision?: Record<string, { label: string; p: number | null; final: false }>;
  reviews?: Array<{ reviewId: string; question: string; deadlineAt: string; onTimeout: string }>;
  inputRequests?: InputRequest[];
  path: string;
  costUsd: number | null;
  costBasis: CostBasis;
  costUnknownCalls: number;
  latencyMs: number;
  synthetic: boolean;
  estimate: "measured" | "provisional";
  servingMode: ServingMode;
  shadowResult: Record<string, unknown> | null;
  receipt: {
    /** One plain sentence saying what was decided and how (servers from November 2026 on). */
    summary?: string;
    /** The first question's three steps in plain words. */
    explanation?: ReceiptExplanation | null;
    /** Demo-mode calls only: what the same calls would cost at the runtime's list prices. */
    estimatedCostUsd?: number | null;
    questions: Record<string, DecisionQuestionReceipt>;
    tierCalls: Array<{ tier: string; kind: string; model: string; ok: boolean; latencyMs: number; costUsd: number | null; costBasis: CostBasis; error?: string }>;
    budget: { limitUsd: number | null; spentUsd: number; applied: "per_decision" | "daily_cap" | null; onBudget: string } | null;
  } & Record<string, unknown>;
  outcomeStatus: "pending_window" | "matured_implicit" | "reported";
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
}

export interface DecideOptions {
  input: Record<string, unknown>;
  version?: number;
  requestId?: string;
  traceId?: string;
  parentDecisionId?: string;
  stepName?: string;
  chainContext?: Record<string, unknown>;
  /** Wait up to this long (at most 25 000 ms) for a decision that is still running or with a person. */
  waitForMs?: number;
  overrides?: Record<string, number>;
  callbackUrl?: string;
  /** Narrow the runtime's serving mode for this call; it can never be widened. */
  serving?: "parity" | "shadow";
  /** Escalate past the fast tier for this call. */
  escalate?: boolean;
  /** A retry with the same key resumes the same decision and is never billed twice. */
  idempotencyKey?: string;
}

export interface Runtime {
  id: string;
  ref: string;
  owner: string;
  slug: string;
  name: string;
  description: string;
  servingMode: ServingMode;
  servingModeChangedBy: string | null;
  servingModeChangedAt: string | null;
  liveVersion?: { number: number; config: { questions: Array<{ key: string; type: "binary" | "pick_one"; prompt: string; labels: string[] }> } & Record<string, unknown> } | null;
}

export interface ReplayReport {
  runtime: string;
  sources: { testCases: number; labeledDecisions: number; labeledDecisionsWithoutInput: number };
  candidate: ReplaySide;
  baseline: ReplaySide;
  flips?: { fixed: number; broken: number; other: number; brokenRegressionIds: string[] };
  regressionPassRates?: Array<{ case: string; passed: number; trials: number; flaky: boolean }>;
  changed: Array<{ case: string; source: string; outcome?: "fixed" | "broken" | "other"; regression?: boolean; candidate: Record<string, string | null>; baseline: Record<string, string | null>; truth: Record<string, string> }>;
  changedCount: number;
  spentUsd: number;
  notes: string[];
}
export interface ReplaySide {
  version: number;
  cases: number;
  labeledAnswers: number;
  accuracy: number | null;
  realizedLossPer1000Usd: number | null;
  costPer1000Usd: number | null;
  escalationShare: number | null;
  synthetic: boolean;
}

export class AskWithAIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "AskWithAIError";
  }
}

export interface AskWithAIOptions {
  apiKey: string;
  /** Default https://api.askwith.ai; locally http://localhost:3700. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default request timeout in milliseconds (default 35 000). */
  timeoutMs?: number;
}

const FINISHED: readonly DecisionStatus[] = ["decided", "failed"];
const DEFAULT_TIMEOUT_MS = 35_000;

/** Validate `owner/slug` or `owner/slug@v3` and encode each path segment safely. */
function runtimePath(runtime: string): string {
  const m = runtime.match(/^([^/?#]+)\/([^/?#@]+)(?:@([^/?#]+))?$/);
  if (!m) throw new Error(`Invalid runtime reference "${runtime}". Expected "owner/slug" or "owner/slug@v3".`);
  const [, owner, slug, version] = m;
  if (owner === "." || owner === ".." || slug === "." || slug === "..") {
    throw new Error(`Invalid runtime reference "${runtime}".`);
  }
  return `${encodeURIComponent(owner!)}/${encodeURIComponent(slug!)}${version ? `@${encodeURIComponent(version)}` : ""}`;
}

export type ExpertReviewKind = "ruling" | "fact" | "rules_disagree" | "spot_check" | "traffic_changed" | "improvement_ready";

/** One item in a runtime's Expert Review. Settle it on the route its `actions` name. */
export interface ExpertReviewItem {
  id: string;
  kind: ExpertReviewKind;
  title: string;
  explanation: string;
  costAtStake: number | null;
  deadline: string | null;
  receiptRef: string | null;
  options: string[];
  expectedVersion?: number;
  field?: string;
  /** What a person needs to see to answer (a review's redacted input), or null when it was not kept. */
  input?: unknown;
  actions: Array<{ label: string; method: "GET" | "POST"; path: string; platformOnly?: boolean }>;
  createdAt: string;
}

export class AskWithAI {
  readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AskWithAIOptions) {
    if (!opts.apiKey) throw new Error("AskWithAI needs an API key (wai_...).");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.askwith.ai").replace(/\/+$/, "");
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Any Decision API call. Paths must start with a single `/`. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error(`AskWithAI API paths must start with a single "/". Got "${path}".`);
    }
    const url = new URL(`${this.baseUrl}${path}`);
    if (url.origin !== this.baseOrigin) {
      throw new Error(`Refusing to send AskWithAI credentials to a different origin (${url.origin}).`);
    }
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = timeoutMs > 0 && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = opts.signal && timeoutSignal && typeof AbortSignal.any === "function" ? AbortSignal.any([opts.signal, timeoutSignal]) : (opts.signal ?? timeoutSignal);
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new AskWithAIError(res.status, "bad_response", `The server answered ${res.status} with a body that is not JSON.`);
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error;
      throw new AskWithAIError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, e?.details, res.headers.get("withai-request-id") ?? undefined);
    }
    return data as T;
  }

  /** Make a decision. `runtime` is "owner/slug" or "owner/slug@v3". */
  async decide(runtime: string, opts: DecideOptions, reqOpts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Decision> {
    const { idempotencyKey, ...body } = opts;
    return this.request("POST", `/v1/decide/${runtimePath(runtime)}`, body, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}, reqOpts);
  }

  getDecision(id: string): Promise<Decision & { timeline: unknown[]; steps: unknown[] }> {
    return this.request("GET", `/v1/decisions/${encodeURIComponent(id)}`);
  }

  /**
   * Poll a decision until it is decided or failed, or until `timeoutMs`.
   * With `onInputRequired`, a decision waiting for a fact gets it from your
   * code (for example an agent reading the repository) and resumes; without
   * it, the wait returns as soon as the decision needs input.
   */
  async waitForDecision(
    id: string,
    opts: { timeoutMs?: number; intervalMs?: number; onInputRequired?: (request: InputRequest, decision: Decision) => Promise<unknown> | unknown } = {},
  ): Promise<Decision> {
    const until = Date.now() + (opts.timeoutMs ?? 60_000);
    const answered = new Set<string>();
    for (;;) {
      const d = await this.getDecision(id);
      if (FINISHED.includes(d.status)) return d;
      if (d.status === "input_required") {
        const open = (d.inputRequests ?? []).filter((r) => !answered.has(r.reviewId));
        if (!opts.onInputRequired || !open.length) return d;
        for (const r of open) {
          answered.add(r.reviewId);
          await this.answerInput(id, { field: r.field, value: await opts.onInputRequired(r, d), expectedVersion: r.expectedVersion });
        }
        continue;
      }
      if (d.status === "paused" || Date.now() >= until) return d;
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
  }

  /** Supply a fact a decision is waiting for. It never becomes a label. */
  answerInput(decisionId: string, body: { field?: string; value: unknown; expectedVersion?: number }): Promise<Decision> {
    return this.request("POST", `/v1/decisions/${encodeURIComponent(decisionId)}/input`, body);
  }

  reportOutcome(decisionId: string, outcome: { labels: Record<string, string>; key?: string; note?: string }) {
    return this.request<{ id: string; replayed: boolean }>("POST", `/v1/decisions/${encodeURIComponent(decisionId)}/outcome`, outcome);
  }

  eraseDecision(id: string) {
    return this.request<{ deleted: boolean }>("DELETE", `/v1/decisions/${encodeURIComponent(id)}`);
  }

  /** Resume a decision paused by its budget (onBudget: "pause"), allowing that much more spend. */
  resumeDecision(id: string, raiseBudgetUsd: number): Promise<Decision> {
    return this.request("POST", `/v1/decisions/${encodeURIComponent(id)}/resume`, { raiseBudgetUsd });
  }

  listReviews(status: "pending" | "settled" | "expired" = "pending") {
    return this.request<{ data: Array<{ id: string; decisionId: string; question: string; labels: string[]; requestKind: "label" | "input"; version: number; deadlineAt: string }> }>("GET", `/v1/reviews?status=${status}`);
  }

  settleReview(id: string, body: { decision: string; reason?: string; expectedVersion: number }) {
    return this.request("POST", `/v1/reviews/${encodeURIComponent(id)}/settle`, body);
  }

  /**
   * Expert Review for one runtime: everything only a person can settle
   * (rulings, missing facts, stress-test questions, spot checks, traffic
   * changes, ready improvements), money at stake first.
   */
  expertReview(runtime: string, kind?: ExpertReviewKind) {
    return this.request<{ data: ExpertReviewItem[] }>("GET", `/v1/runtimes/${runtimePath(runtime)}/reviews${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`);
  }

  /** Every runtime in the key's workspace. */
  listRuntimes() {
    return this.request<{ data: Runtime[] }>("GET", "/v1/runtimes");
  }

  /** Create a runtime from JSON (`{slug, name, description, config}`) or from a package (`{files}`). */
  createRuntime(body: { slug: string; name?: string; description?: string; config?: unknown; files?: Record<string, string> }): Promise<Runtime> {
    return this.request("POST", "/v1/runtimes", body);
  }

  async getRuntime(runtime: string): Promise<Runtime> {
    return this.request("GET", `/v1/runtimes/${runtimePath(runtime)}`);
  }

  /** Rename or describe a runtime, or change its serving mode. */
  async patchRuntime(runtime: string, body: { name?: string; description?: string; slug?: string; servingMode?: ServingMode }): Promise<Runtime> {
    return this.request("PATCH", `/v1/runtimes/${runtimePath(runtime)}`, body);
  }

  /** Switch the serving mode: parity (the provider's answer), shadow (also record the routed answer), active (routed). */
  setServingMode(runtime: string, mode: ServingMode): Promise<Runtime> {
    return this.patchRuntime(runtime, { servingMode: mode });
  }

  async listDecisions(runtime: string, filters: { status?: string; answeredBy?: string; traceId?: string; since?: string; before?: string; disagree?: boolean; limit?: number } = {}) {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.request<{ data: Decision[]; hasMore: boolean }>("GET", `/v1/runtimes/${runtimePath(runtime)}/decisions${q.size ? `?${q}` : ""}`);
  }

  async stats(runtime: string, window: "1h" | "24h" | "7d" | "30d" = "24h") {
    return this.request<Record<string, unknown>>("GET", `/v1/runtimes/${runtimePath(runtime)}/stats?window=${window}`);
  }

  /** Run the release gates on a package without saving it. */
  async check(runtime: string, files: Record<string, string>) {
    return this.request<{ passed: boolean; gates: Array<{ name: string; passed: boolean; detail: string }>; flips?: { fixed: number; broken: number; fixedIds: string[]; brokenIds: string[] } }>("POST", `/v1/runtimes/${runtimePath(runtime)}/check`, { files });
  }

  /** Save a package as a new candidate version, creating the runtime the first time. */
  async push(runtime: string, files: Record<string, string>, opts: { name?: string; note?: string } = {}): Promise<{ created: boolean; version: { number: number; status: string } }> {
    const refPath = runtimePath(runtime);
    try {
      await this.getRuntime(runtime);
    } catch (e) {
      if (!(e instanceof AskWithAIError) || e.status !== 404) throw e;
      const slug = runtime.split("/")[1]!.replace(/@.*$/, "");
      // A new runtime belongs to the key's workspace, and its first version goes live.
      await this.request("POST", "/v1/runtimes", { slug, name: opts.name ?? slug, files });
      return { created: true, version: { number: 1, status: "live" } };
    }
    const v = await this.request<{ number: number; status: string }>("POST", `/v1/runtimes/${refPath}/versions`, { files, note: opts.note });
    return { created: false, version: v };
  }

  /** Replay a candidate version against the live one on labeled cases. */
  async replay(runtime: string, version: number, opts: { against?: "live" | number; since?: string; limit?: number; capUsd?: number; trials?: number } = {}): Promise<ReplayReport> {
    return this.request("POST", `/v1/runtimes/${runtimePath(runtime)}/versions/${version}/replay`, opts);
  }

  /** Every immutable version of a runtime, newest first. */
  async listVersions(runtime: string) {
    return this.request<{ data: Array<{ number: number; status: string; note?: string; createdAt: string }> }>("GET", `/v1/runtimes/${runtimePath(runtime)}/versions`);
  }

  /** Promote a version through the release gates. A failed gate needs `overrideReason` (at least 10 characters). */
  async promoteVersion(runtime: string, version: number, opts: { overrideReason?: string } = {}) {
    return this.request<{ promoted: number } & Record<string, unknown>>("POST", `/v1/runtimes/${runtimePath(runtime)}/versions/${version}/promote`, opts);
  }

  /** Export a version as a portable decision package: a map of file path to contents, the same shape `push` sends. */
  async exportPackage(runtime: string) {
    return this.request<{ files: Record<string, string> }>("GET", `/v1/runtimes/${runtimePath(runtime)}/package`);
  }

  /** Look for improvements: propose a learned candidate version from cases settled by people or outcomes, replay it and check the release gates. */
  async learn(runtime: string, opts: { capUsd?: number } = {}) {
    return this.request<Record<string, unknown>>("POST", `/v1/runtimes/${runtimePath(runtime)}/learn`, opts);
  }

  /** Learned candidates, newest first. */
  async listLearned(runtime: string) {
    return this.request<{ data: Array<Record<string, unknown>> }>("GET", `/v1/runtimes/${runtimePath(runtime)}/learned`);
  }

  /**
   * Promote (through the release gates and a canary) or discard a learned
   * candidate. A failed gate needs `overrideReason`; a candidate that
   * changes a high-cost answer needs a person signed in to the AskWithAI
   * Platform and cannot be approved with only an API key.
   */
  async decideLearned(runtime: string, id: string, action: "promote" | "discard", opts: { overrideReason?: string } = {}) {
    return this.request<Record<string, unknown>>("POST", `/v1/runtimes/${runtimePath(runtime)}/learned/${encodeURIComponent(id)}/${action}`, opts);
  }

  /** Runtime templates, including app templates not yet available. */
  listTemplates() {
    return this.request<{ data: Array<{ id: string; name: string; available: boolean } & Record<string, unknown>> }>("GET", "/v1/templates");
  }

  /** Create a runtime from a template, with its synthetic cases as a test set. */
  useTemplate(id: string, opts: { slug?: string; name?: string } = {}) {
    return this.request<Runtime & { template: string; testSetId: string; cases: number }>("POST", `/v1/templates/${encodeURIComponent(id)}/use`, opts);
  }

  /** Benchmark the live version on the template's synthetic cases (a runtime made from a template). */
  async evaluateTemplate(runtime: string, opts: { capUsd?: number } = {}) {
    return this.request<Record<string, unknown>>("POST", `/v1/runtimes/${runtimePath(runtime)}/evaluate`, opts);
  }

  /** Erase every decision with this request id or input hash (right to erasure, by caller-known identifier). */
  purge(by: { requestId?: string; inputHash?: string }) {
    return this.request<{ purged: number }>("POST", "/v1/privacy/purge", by);
  }

  /** The runtimes this key can call, in OpenRouter's catalog shape. */
  listModels() {
    return this.request<{ data: Array<{ id: string; name: string; askwithai: Record<string, unknown> }> }>("GET", "/v1/models?output_modalities=decisions");
  }
}

/** @deprecated The old name, kept for one release. Use `AskWithAI`. */
export const WithAI = AskWithAI;
/** @deprecated The old name, kept for one release. Use `AskWithAIError`. */
export const WithAIError = AskWithAIError;
