import { AskWithAIError, type AskWithAI, type Decision } from "./client";

/**
 * A typed decision function for one runtime.
 *
 *   const reviewAlert = createDecision(askwithai, {
 *     runtime: "theory/alert-review",
 *     schema: z.object({ suspicious: z.enum(["suspicious", "legitimate"]) }),
 *     escalateIf: (input) => input.amount > 10_000,
 *   });
 *   await reviewAlert.verify();            // fail fast at start-up if the labels drifted
 *   const { answers, final } = await reviewAlert(input, { traceId });
 *
 * The schema is any object with `shape` and `parse`, such as a Zod object of
 * enums (Zod 3 or 4); the SDK does not depend on Zod itself.
 */

/** The parts of a Zod object schema the SDK uses. */
export interface AnswerSchema<T> {
  shape: Record<string, unknown>;
  parse(value: unknown): T;
}

export interface DecisionCallOptions<T, I> {
  traceId?: string;
  requestId?: string;
  parentDecisionId?: string;
  stepName?: string;
  idempotencyKey?: string;
  /** Narrow the runtime's serving mode for this call ("parity" or "shadow"). */
  serving?: "parity" | "shadow";
  /** Wait up to this long for a decision that is running or with a person (default 25 000 ms, the server's limit). */
  waitForMs?: number;
  /**
   * Shadow adoption without moving traffic: return what your current decider
   * answers, and send the same input to AskWithAI with `serving: "shadow"` so
   * it records its own answer for comparison. AskWithAI failing never breaks
   * the call.
   */
  legacy?: (input: I) => Promise<T> | T;
}

export interface DecisionResult<T> {
  /** The answers, checked against the schema. Provisional when `final` is false (a person or a fact is pending). */
  answers: T;
  final: boolean;
  /** The full record; null only when `legacy` answered and AskWithAI could not be reached. */
  decision: Decision | null;
}

export interface TypedDecision<T, I> {
  (input: I, options?: DecisionCallOptions<T, I>): Promise<DecisionResult<T>>;
  /** Compare the schema's labels with the runtime's live version; throws on any mismatch. */
  verify(): Promise<void>;
  readonly runtime: string;
}

/** Thrown when a decision has no answer to give yet, not even a provisional one (it failed, or it is still running). */
export class DecisionNotReadyError extends Error {
  constructor(readonly decision: Decision) {
    super(`Decision ${decision.id} is ${decision.status}; it has no answers yet.`);
    this.name = "DecisionNotReadyError";
  }
}

function enumOptions(field: unknown): string[] | null {
  const f = field as { options?: unknown; _def?: { values?: unknown; entries?: unknown } } | null;
  if (f && Array.isArray(f.options)) return f.options.map(String);
  if (f?._def && Array.isArray(f._def.values)) return f._def.values.map(String);
  if (f?._def?.entries && typeof f._def.entries === "object") return Object.values(f._def.entries as object).map(String);
  return null;
}

export function createDecision<T extends Record<string, string>, I extends Record<string, unknown> = Record<string, unknown>>(
  client: AskWithAI,
  config: { runtime: string; schema: AnswerSchema<T>; escalateIf?: (input: I) => boolean; serving?: "parity" | "shadow" },
): TypedDecision<T, I> {
  const call = async (input: I, options: DecisionCallOptions<T, I> = {}): Promise<DecisionResult<T>> => {
    const send = (serving: "parity" | "shadow" | undefined) =>
      client.decide(config.runtime, {
        input,
        traceId: options.traceId,
        requestId: options.requestId,
        parentDecisionId: options.parentDecisionId,
        stepName: options.stepName,
        idempotencyKey: options.idempotencyKey,
        serving,
        escalate: config.escalateIf?.(input) || undefined,
        waitForMs: options.waitForMs ?? 25_000,
      });
    if (options.legacy) {
      const [legacy, shadow] = await Promise.all([options.legacy(input), send("shadow").catch(() => null)]);
      return { answers: config.schema.parse(legacy), final: true, decision: shadow };
    }
    const decision = await send(options.serving ?? config.serving);
    const final = decision.status === "decided";
    const raw: Record<string, string | null> = {};
    for (const [key, d] of Object.entries(decision.decisions)) raw[key] = d.answer ?? decision.provisionalDecision?.[key]?.label ?? null;
    if (Object.values(raw).some((v) => v === null)) throw new DecisionNotReadyError(decision);
    return { answers: config.schema.parse(raw), final, decision };
  };
  const verify = async () => {
    const runtime = await client.getRuntime(config.runtime.replace(/@v?\d+$/, ""));
    const questions = runtime.liveVersion?.config.questions ?? [];
    const problems: string[] = [];
    for (const [key, field] of Object.entries(config.schema.shape)) {
      const q = questions.find((x) => x.key === key);
      if (!q) {
        problems.push(`the runtime has no question "${key}"`);
        continue;
      }
      const options = enumOptions(field);
      if (!options) continue; // not an enum: nothing to compare
      const missing = q.labels.filter((l) => !options.includes(l));
      const extra = options.filter((l) => !q.labels.includes(l));
      if (missing.length || extra.length) problems.push(`"${key}": the runtime's labels are ${q.labels.join(", ")}; the schema has ${options.join(", ")}`);
    }
    for (const q of questions) if (!(q.key in config.schema.shape)) problems.push(`the schema has no field for the runtime's question "${q.key}"`);
    if (problems.length) throw new AskWithAIError(409, "schema_mismatch", `${config.runtime} does not match the schema: ${problems.join("; ")}.`);
  };
  return Object.assign(call, { verify, runtime: config.runtime });
}
