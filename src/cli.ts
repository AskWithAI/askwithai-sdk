#!/usr/bin/env node
import { readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AskWithAI, AskWithAIError, type Decision, type ServingMode } from "./client";

/*
 * `askwithai`: call the full Decision API from a terminal or a script.
 * Reads ASKWITHAI_URL (default https://api.askwith.ai) and
 * ASKWITHAI_API_KEY. Run `askwithai help` for usage. Add `--json` to any
 * command for the raw response instead of the formatted summary.
 *
 * `call` and `endpoints` read the live /api/v1/openapi.json, so they work
 * against any endpoint — including ones added after this was written. The
 * other commands are curated shortcuts over the typed client in `client.ts`;
 * see AGENTS.md in this repository for when to add one.
 */

const USAGE = `askwithai: call AskWithAI Decision Runtimes from a terminal or a script.

Packages
  askwithai push  [dir] --runtime owner/slug [--note "why"]   save the package in dir (default ./askwithai) as a new version
  askwithai check [dir] --runtime owner/slug                  run the release gates on the package without saving it
  askwithai package owner/slug [--version 3] [--out dir]      export a version as a decision package (the reverse of push)

Decisions
  askwithai decide owner/slug --input '{"...": ...}' [--version n] [--escalate] [--serving parity|shadow]
                    [--wait-ms n] [--trace-id x] [--request-id x] [--idempotency-key x] [--callback-url x]
  askwithai status <decisionId>                                fetch a decision and its timeline
  askwithai input  <decisionId> --field f --value v [--expected-version n]   answer a fact it's waiting for
  askwithai resume <decisionId> --raise-budget 5               resume a decision paused by its budget
  askwithai outcome <decisionId> --labels '{"key":"label"}' [--key x] [--note x]   report what really happened
  askwithai erase  <decisionId>                                erase a decision (right to erasure)

Runtimes
  askwithai runtimes list
  askwithai runtimes get   owner/slug
  askwithai runtimes create --slug x [--name y] [dir]          dir: a package to create it from
  askwithai runtimes patch owner/slug [--name] [--description] [--slug] [--serving-mode parity|shadow|active]
  askwithai mode owner/slug parity|shadow|active               shorthand for patch --serving-mode
  askwithai decisions list owner/slug [--status] [--answered-by] [--trace-id] [--since] [--before] [--disagree] [--limit n]
  askwithai stats owner/slug [--window 1h|24h|7d|30d]

Versions and replay
  askwithai versions list    owner/slug
  askwithai versions promote owner/slug <v> [--override-reason x]
  askwithai replay --runtime owner/slug --version 3 [--against live|2] [--since 24h] [--limit 50] [--cap 1] [--trials 3]

Reviews
  askwithai reviews list [--status pending|settled|expired]
  askwithai reviews settle <reviewId> --decision x --expected-version n [--reason x]

Learning
  askwithai learn   owner/slug [--cap 5]                       propose a learned candidate from settled cases
  askwithai learned list            owner/slug
  askwithai learned promote|discard owner/slug <id> [--override-reason x]

Templates
  askwithai templates list
  askwithai templates use      <id> [--slug x] [--name y]
  askwithai templates evaluate owner/slug [--cap 10]

Other
  askwithai models                                             the runtimes this key can call, OpenRouter-style
  askwithai privacy purge [--request-id x] [--input-hash y]     erase every decision with that id or hash

Escape hatch (always in sync, including endpoints added after this was written)
  askwithai endpoints [--grep text]                            list every endpoint from the live API description
  askwithai call <METHOD> </v1/...> [--body '<json>'|--body-file f|-] [--query "k=v,k2=v2"] [--header "k:v"]

Environment: ASKWITHAI_API_KEY (required except for endpoints), ASKWITHAI_URL (default https://api.askwith.ai).`;

const TEXT_FILE = /\.(ya?ml|md|json|jsonl|csv|txt)$/i;
const MAX_FILES = 200;
const RUNTIME_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Every text file in a package folder, by its path inside the folder. */
export function readPackage(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT_FILE.test(name)) {
        if (Object.keys(files).length >= MAX_FILES) throw new Error(`The package has more than ${MAX_FILES} files.`);
        files[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
      }
    }
  };
  walk(dir);
  if (!files["runtime.yaml"] && !files["runtime.yml"]) throw new Error(`${dir} has no runtime.yaml.`);
  return files;
}

/** The reverse of readPackage: write a file map to a folder, refusing paths that escape it. */
function writePackage(dir: string, files: Record<string, string>): void {
  const root = resolve(dir);
  for (const [path, contents] of Object.entries(files)) {
    if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
      throw new Error(`Refusing to write unsafe package path "${path}".`);
    }
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`Refusing to write package path outside "${dir}": "${path}".`);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

const BOOLEAN_FLAGS = new Set(["json", "escalate", "disagree", "help"]);

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      const k = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = "true";
      else flags[k] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(4)}`);

function requireRuntime(ref: string | undefined, label = "the runtime"): string {
  if (!ref || !RUNTIME_RE.test(ref)) throw new CliUsageError(`Name ${label} as owner/slug.`);
  return ref;
}

function parseJsonFlag(raw: string | undefined, label: string): Record<string, unknown> {
  if (raw === undefined) throw new CliUsageError(`Give ${label} as JSON.`);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliUsageError(`${label} is not valid JSON.`);
  }
}

/** "k=v,k2=v2" or "k:v,k2:v2" -> { k: "v", k2: "v2" }. Splits on the primary separator first so header values may contain "=". */
function parsePairs(raw: string | undefined, primary: "=" | ":" = "="): Record<string, string> {
  if (!raw) return {};
  const fallback = primary === "=" ? ":" : "=";
  return Object.fromEntries(
    raw.split(",").map((pair) => {
      const pIdx = pair.indexOf(primary);
      const i = pIdx >= 0 ? pIdx : pair.indexOf(fallback);
      if (i < 0) throw new CliUsageError(`"${pair}" is not a k${primary}v pair.`);
      return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }),
  );
}

function summarizeDecision(d: Decision): string[] {
  const lines = [`${d.id}  ${d.status}  path=${d.path}  serving=${d.servingMode}  cost=${usd(d.costUsd)}${d.costUnknownCalls ? ` (${d.costUnknownCalls} unknown)` : ""}`];
  for (const [key, a] of Object.entries(d.decisions ?? {})) lines.push(`  ${key}: ${a.answer ?? "(none yet)"}  by=${a.answeredBy}${a.final ? "" : " (provisional)"}${a.probability !== null ? `  p=${a.probability}` : ""}`);
  for (const r of d.inputRequests ?? []) lines.push(`  waiting for input: ${r.field} — ${r.question}`);
  for (const r of d.reviews ?? []) lines.push(`  waiting for a person: ${r.question} (deadline ${r.deadlineAt})`);
  return lines;
}

/** A bad command, a bad flag, or a bad argument. Exits 2, like a missing API key. */
class CliUsageError extends Error {}

/** Run one command. Returns the exit code; output goes to `out`. */
export async function run(argv: string[], env: Record<string, string | undefined> = process.env, out: (line: string) => void = console.log, fetchImpl?: typeof fetch): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, sub, ...rest] = positional;
  if (!command || command === "help" || flags.help) {
    out(USAGE);
    return command ? 0 : 1;
  }
  const baseUrl = env.ASKWITHAI_URL || undefined;
  if (command === "endpoints") {
    const base = (baseUrl ?? "https://api.askwith.ai").replace(/\/+$/, "");
    const res = await (fetchImpl ?? fetch)(`${base}/api/v1/openapi.json`);
    if (!res.ok) {
      out(`Could not fetch ${base}/api/v1/openapi.json (HTTP ${res.status}).`);
      return 1;
    }
    const spec = (await res.json()) as { paths: Record<string, Record<string, { summary?: string }>> };
    const grep = flags.grep?.toLowerCase();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const line = `${method.toUpperCase().padEnd(6)} ${path}  ${op.summary ?? ""}`;
        if (!grep || line.toLowerCase().includes(grep)) out(line);
      }
    }
    return 0;
  }
  const apiKey = env.ASKWITHAI_API_KEY?.trim();
  if (!apiKey) {
    out("Set ASKWITHAI_API_KEY to an AskWithAI API key (wai_...).");
    return 2;
  }
  const client = new AskWithAI({ apiKey, baseUrl, fetch: fetchImpl });
  const show = (result: unknown, lines: () => string[]) => {
    if (flags.json) out(JSON.stringify(result, null, 2));
    else for (const l of lines()) out(l);
  };
  try {
    switch (command) {
      case "push": {
        const runtime = requireRuntime(flags.runtime);
        const files = readPackage(sub ?? "askwithai");
        const r = await client.push(runtime, files, { note: flags.note });
        out(r.created ? `Created ${runtime}; version 1 is live.` : `Saved ${runtime} version ${r.version.number} as a ${r.version.status}. Check it, replay it, then promote it in the studio or with POST .../versions/${r.version.number}/promote.`);
        return 0;
      }
      case "check": {
        const runtime = requireRuntime(flags.runtime);
        const files = readPackage(sub ?? "askwithai");
        const r = await client.check(runtime, files);
        for (const g of r.gates) out(`${g.passed ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}`);
        if (r.flips && (r.flips.fixed > 0 || r.flips.broken > 0)) {
          out(`Flips (holdout): ${r.flips.fixed} fixed, ${r.flips.broken} broken${r.flips.brokenIds.length ? ` (broken: ${r.flips.brokenIds.join(", ")})` : ""}`);
        }
        out(r.passed ? "All release gates passed." : "Some release gates failed.");
        return r.passed ? 0 : 1;
      }
      case "package": {
        const runtime = requireRuntime(sub);
        const ref = flags.version ? `${runtime}@v${flags.version}` : runtime;
        const r = await client.exportPackage(ref);
        if (flags.out) {
          writePackage(flags.out, r.files);
          out(`Wrote ${Object.keys(r.files).length} files to ${flags.out}.`);
        } else show(r, () => Object.keys(r.files));
        return 0;
      }
      case "replay": {
        const runtime = requireRuntime(flags.runtime);
        const version = Number(flags.version);
        if (!Number.isInteger(version) || version < 1) throw new CliUsageError("Give the candidate version with --version.");
        const against = flags.against === undefined || flags.against === "live" ? "live" : Number(flags.against);
        const r = await client.replay(runtime, version, { against, since: flags.since, limit: flags.limit ? Number(flags.limit) : undefined, capUsd: flags.cap ? Number(flags.cap) : undefined, trials: flags.trials ? Number(flags.trials) : undefined });
        show(r, () => {
          const lines = [`Replayed ${r.candidate.cases} cases (${r.sources.testCases} test cases, ${r.sources.labeledDecisions} labeled decisions).`];
          for (const side of [r.candidate, r.baseline]) lines.push(`  v${side.version}: accuracy ${pct(side.accuracy)}, realized loss per 1,000 ${usd(side.realizedLossPer1000Usd)}, cost per 1,000 ${usd(side.costPer1000Usd)}, escalated ${pct(side.escalationShare)}${side.synthetic ? " (simulated)" : ""}`);
          const flipSummary = r.flips ? ` (${r.flips.fixed} fixed, ${r.flips.broken} broken${r.flips.other ? `, ${r.flips.other} other` : ""})` : "";
          lines.push(`${r.changedCount} cases changed answer${flipSummary}.`);
          for (const c of r.changed.slice(0, 10)) {
            const tag = c.outcome ? `[${c.outcome.toUpperCase()}]${c.regression ? " [REGRESSION]" : ""} ` : "";
            lines.push(`  ${tag}${c.source} ${c.case}: ${JSON.stringify(c.baseline)} -> ${JSON.stringify(c.candidate)} (truth ${JSON.stringify(c.truth)})`);
          }
          for (const p of (r.regressionPassRates ?? []).filter((x) => x.passed < x.trials)) {
            lines.push(`  [REGRESSION ${p.flaky ? "FLAKY" : "FAIL"}] ${p.case}: ${p.passed}/${p.trials} trials passed`);
          }
          for (const n of r.notes) lines.push(`Note: ${n}`);
          return lines;
        });
        return 0;
      }
      case "mode": {
        const runtime = requireRuntime(sub);
        const mode = (rest[0] ?? flags.mode) as ServingMode | undefined;
        if (!mode || !["parity", "shadow", "active"].includes(mode)) throw new CliUsageError("Give the mode: parity, shadow or active.");
        const r = await client.setServingMode(runtime, mode);
        out(`${r.ref} now serves in ${r.servingMode} mode.`);
        return 0;
      }
      case "decide": {
        const runtime = requireRuntime(sub);
        const input = parseJsonFlag(flags.input, "--input");
        const d = await client.decide(runtime, {
          input,
          version: flags.version ? Number(flags.version) : undefined,
          requestId: flags["request-id"],
          traceId: flags["trace-id"],
          waitForMs: flags["wait-ms"] ? Number(flags["wait-ms"]) : undefined,
          callbackUrl: flags["callback-url"],
          serving: flags.serving as "parity" | "shadow" | undefined,
          escalate: flags.escalate === "true",
          idempotencyKey: flags["idempotency-key"],
        });
        show(d, () => summarizeDecision(d));
        return 0;
      }
      case "status": {
        if (!sub) throw new CliUsageError("Give the decision id.");
        const d = await client.getDecision(sub);
        show(d, () => summarizeDecision(d));
        return 0;
      }
      case "input": {
        if (!sub) throw new CliUsageError("Give the decision id.");
        if (flags.value === undefined) throw new CliUsageError("Give the answer with --value.");
        const d = await client.answerInput(sub, { field: flags.field, value: flags.value, expectedVersion: flags["expected-version"] ? Number(flags["expected-version"]) : undefined });
        show(d, () => summarizeDecision(d));
        return 0;
      }
      case "resume": {
        if (!sub) throw new CliUsageError("Give the decision id.");
        const raise = Number(flags["raise-budget"]);
        if (!Number.isFinite(raise) || raise <= 0) throw new CliUsageError("Give --raise-budget as a positive number of dollars.");
        const d = await client.resumeDecision(sub, raise);
        show(d, () => summarizeDecision(d));
        return 0;
      }
      case "outcome": {
        if (!sub) throw new CliUsageError("Give the decision id.");
        const labels = parseJsonFlag(flags.labels, "--labels");
        const r = await client.reportOutcome(sub, { labels: labels as Record<string, string>, key: flags.key, note: flags.note });
        out(`Recorded outcome ${r.id}${r.replayed ? " (replayed the decision)" : ""}.`);
        return 0;
      }
      case "erase": {
        if (!sub) throw new CliUsageError("Give the decision id.");
        const r = await client.eraseDecision(sub);
        out(r.deleted ? `Erased ${sub}.` : `${sub} was not erased.`);
        return 0;
      }
      case "runtimes": {
        if (sub === "list") {
          const r = await client.listRuntimes();
          show(r, () => r.data.map((rt) => `${rt.ref}  serving=${rt.servingMode}`));
          return 0;
        }
        if (sub === "get") {
          const runtime = requireRuntime(rest[0]);
          const r = await client.getRuntime(runtime);
          show(r, () => [`${r.ref}  "${r.name}"  serving=${r.servingMode}${r.description ? `\n  ${r.description}` : ""}`]);
          return 0;
        }
        if (sub === "create") {
          if (!flags.slug) throw new CliUsageError("Give --slug.");
          const files = rest[0] ? readPackage(rest[0]) : undefined;
          const r = await client.createRuntime({ slug: flags.slug, name: flags.name, files });
          show(r, () => [`Created ${r.ref}.`]);
          return 0;
        }
        if (sub === "patch") {
          const runtime = requireRuntime(rest[0]);
          const r = await client.patchRuntime(runtime, { name: flags.name, description: flags.description, slug: flags.slug, servingMode: flags["serving-mode"] as ServingMode | undefined });
          show(r, () => [`${r.ref}  "${r.name}"  serving=${r.servingMode}${r.description ? `\n  ${r.description}` : ""}`]);
          return 0;
        }
        throw new CliUsageError("Use runtimes list, get, create or patch.");
      }
      case "decisions": {
        if (sub !== "list") throw new CliUsageError("Use decisions list.");
        const runtime = requireRuntime(rest[0]);
        const r = await client.listDecisions(runtime, {
          status: flags.status,
          answeredBy: flags["answered-by"],
          traceId: flags["trace-id"],
          since: flags.since,
          before: flags.before,
          disagree: flags.disagree === "true",
          limit: flags.limit ? Number(flags.limit) : undefined,
        });
        show(r, () => r.data.map((d) => `${d.id}  ${d.status}  ${d.path}  ${usd(d.costUsd)}`));
        return 0;
      }
      case "stats": {
        const runtime = requireRuntime(sub);
        const window = (flags.window ?? "24h") as "1h" | "24h" | "7d" | "30d";
        const r = await client.stats(runtime, window);
        out(JSON.stringify(r, null, 2));
        return 0;
      }
      case "versions": {
        if (sub === "list") {
          const runtime = requireRuntime(rest[0]);
          const r = await client.listVersions(runtime);
          show(r, () => r.data.map((v) => `v${v.number}  ${v.status}${v.note ? `  ${v.note}` : ""}`));
          return 0;
        }
        if (sub === "promote") {
          const runtime = requireRuntime(rest[0]);
          const version = Number(rest[1]);
          if (!Number.isInteger(version) || version < 1) throw new CliUsageError("Give the version number to promote.");
          const r = await client.promoteVersion(runtime, version, { overrideReason: flags["override-reason"] });
          show(r, () => [`Promoted version ${r.promoted}.`]);
          return 0;
        }
        throw new CliUsageError("Use versions list or promote.");
      }
      case "reviews": {
        if (sub === "list") {
          const r = await client.listReviews((flags.status as "pending" | "settled" | "expired") ?? "pending");
          show(r, () => r.data.map((rv) => `${rv.id}  ${rv.question}  labels=${rv.labels.join(",")}  deadline=${rv.deadlineAt}`));
          return 0;
        }
        if (sub === "settle") {
          if (!rest[0]) throw new CliUsageError("Give the review id.");
          if (!flags.decision) throw new CliUsageError("Give --decision.");
          const expectedVersion = Number(flags["expected-version"]);
          if (!Number.isInteger(expectedVersion)) throw new CliUsageError("Give --expected-version (from reviews list).");
          const r = await client.settleReview(rest[0], { decision: flags.decision, expectedVersion, reason: flags.reason });
          out(JSON.stringify(r));
          return 0;
        }
        throw new CliUsageError("Use reviews list or settle.");
      }
      case "learn": {
        const runtime = requireRuntime(sub);
        const r = await client.learn(runtime, { capUsd: flags.cap ? Number(flags.cap) : undefined });
        show(r, () => [JSON.stringify(r)]);
        return 0;
      }
      case "learned": {
        if (sub === "list") {
          const runtime = requireRuntime(rest[0]);
          const r = await client.listLearned(runtime);
          show(r, () => r.data.map((c) => JSON.stringify(c)));
          return 0;
        }
        if (sub === "promote" || sub === "discard") {
          const runtime = requireRuntime(rest[0]);
          if (!rest[1]) throw new CliUsageError("Give the candidate id.");
          const r = await client.decideLearned(runtime, rest[1], sub, { overrideReason: flags["override-reason"] });
          show(r, () => [JSON.stringify(r)]);
          return 0;
        }
        throw new CliUsageError("Use learned list, promote or discard.");
      }
      case "templates": {
        if (sub === "list") {
          const r = await client.listTemplates();
          show(r, () => r.data.map((t) => `${t.id}  ${t.name}${t.available ? "" : "  (not available yet)"}`));
          return 0;
        }
        if (sub === "use") {
          if (!rest[0]) throw new CliUsageError("Give the template id.");
          const r = await client.useTemplate(rest[0], { slug: flags.slug, name: flags.name });
          show(r, () => [`Created ${r.ref} from ${r.template} with ${r.cases} test cases.`]);
          return 0;
        }
        if (sub === "evaluate") {
          const runtime = requireRuntime(rest[0]);
          const r = await client.evaluateTemplate(runtime, { capUsd: flags.cap ? Number(flags.cap) : undefined });
          show(r, () => [JSON.stringify(r)]);
          return 0;
        }
        throw new CliUsageError("Use templates list, use or evaluate.");
      }
      case "models": {
        const r = await client.listModels();
        show(r, () => r.data.map((m) => m.id));
        return 0;
      }
      case "privacy": {
        if (sub !== "purge") throw new CliUsageError("Use privacy purge.");
        if (!flags["request-id"] && !flags["input-hash"]) throw new CliUsageError("Give --request-id or --input-hash.");
        const r = await client.purge({ requestId: flags["request-id"], inputHash: flags["input-hash"] });
        out(`Purged ${r.purged} decision(s).`);
        return 0;
      }
      case "call": {
        const method = command === "call" ? sub : undefined;
        const path = rest[0];
        if (!method || !path) throw new CliUsageError("Give the method and path, e.g. askwithai call GET /v1/models.");
        let body: unknown;
        if (flags.body === "-") body = JSON.parse(readFileSync(0, "utf8"));
        else if (flags.body !== undefined) body = JSON.parse(flags.body);
        else if (flags["body-file"] !== undefined) body = JSON.parse(readFileSync(flags["body-file"], "utf8"));
        const query = parsePairs(flags.query, "=");
        const qs = Object.keys(query).length ? `${path.includes("?") ? "&" : "?"}${new URLSearchParams(query)}` : "";
        const r = await client.request<unknown>(method.toUpperCase(), `${path}${qs}`, body, parsePairs(flags.header, ":"));
        out(JSON.stringify(r, null, 2));
        return 0;
      }
      default:
        out(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliUsageError) {
      out(e.message);
      return 2;
    }
    out(e instanceof AskWithAIError ? `AskWithAI answered ${e.status} (${e.code}): ${e.message}` : `Error: ${(e as Error).message}`);
    return 1;
  }
}

// Run when executed as a program (not when imported by tests).
const invoked = process.argv[1] ?? "";
if (/askwithai$|cli\.(c?js|ts)$/.test(invoked)) {
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
