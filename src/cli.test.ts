import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./cli";

/*
 * The full `askwithai` command set against a mocked fetch: every curated
 * command sends the right method, path and body, and the generic `call`
 * and `endpoints` commands work against an endpoint with no curated
 * command of its own. `cli.ts`'s existing push/check/mode/replay tests run
 * against the real server in `code/ask-with-ai`'s `server/sdk.test.ts`;
 * these are unit tests, so they stay self-contained in this repository.
 */

interface MockResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function mockFetch(responses: Record<string, MockResponse>) {
  const calls: Array<{ method: string; path: string; search: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : JSON.parse((await req.text()) || "{}");
    const headers = Object.fromEntries(req.headers.entries());
    calls.push({ method: req.method, path: url.pathname, search: url.search, body, headers });
    const key = `${req.method} ${url.pathname}`;
    const match = responses[key];
    if (!match) throw new Error(`No mock response for ${key}`);
    return new Response(JSON.stringify(match.body), { status: match.status ?? 200, headers: match.headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const DECISION = { id: "dec_1", status: "decided", decisions: { fraud: { answer: "block", final: true, answeredBy: "fast", probability: 0.9 } }, path: "fast_only", costUsd: 0.001, costBasis: "reported", costUnknownCalls: 0, servingMode: "active" };

async function cli(fetchImpl: typeof fetch, ...argv: string[]) {
  const lines: string[] = [];
  const code = await run(argv, { ASKWITHAI_API_KEY: "wai_test_0000000000000000", ASKWITHAI_URL: "https://x.test" }, (l) => lines.push(l), fetchImpl);
  return { code, out: lines.join("\n") };
}

describe("decisions", () => {
  it("decide sends input and the escalate/serving flags, and prints the answer", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /v1/decide/acme/refund": { body: DECISION } });
    const r = await cli(fetchImpl, "decide", "acme/refund", "--input", '{"amount":42}', "--escalate", "--serving", "parity");
    expect(r.code, r.out).toBe(0);
    expect(calls[0]!.body).toMatchObject({ input: { amount: 42 }, escalate: true, serving: "parity" });
    expect(r.out).toMatch(/dec_1\s+decided/);
    expect(r.out).toMatch(/fraud: block\s+by=fast/);
  });

  it("decide rejects input that is not JSON", async () => {
    const { fetchImpl } = mockFetch({});
    const r = await cli(fetchImpl, "decide", "acme/refund", "--input", "{not json");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not valid JSON/);
  });

  it("status, input, resume, outcome and erase call their endpoints", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/decisions/dec_1": { body: DECISION },
      "POST /v1/decisions/dec_1/input": { body: DECISION },
      "POST /v1/decisions/dec_1/resume": { body: DECISION },
      "POST /v1/decisions/dec_1/outcome": { status: 201, body: { id: "out_1", replayed: false } },
      "DELETE /v1/decisions/dec_1": { body: { deleted: true } },
    });
    expect((await cli(fetchImpl, "status", "dec_1")).code).toBe(0);
    expect((await cli(fetchImpl, "input", "dec_1", "--field", "channel", "--value", "web")).code).toBe(0);
    expect(calls[1]!.body).toMatchObject({ field: "channel", value: "web" });
    expect((await cli(fetchImpl, "resume", "dec_1", "--raise-budget", "5")).code).toBe(0);
    expect(calls[2]!.body).toMatchObject({ raiseBudgetUsd: 5 });
    const outcome = await cli(fetchImpl, "outcome", "dec_1", "--labels", '{"fraud":"approve"}', "--note", "customer confirmed");
    expect(outcome.out).toMatch(/Recorded outcome out_1/);
    expect(calls[3]!.body).toMatchObject({ labels: { fraud: "approve" }, note: "customer confirmed" });
    const erased = await cli(fetchImpl, "erase", "dec_1");
    expect(erased.out).toBe("Erased dec_1.");
  });

  it("resume rejects a non-positive budget without calling the server", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const r = await cli(fetchImpl, "resume", "dec_1", "--raise-budget", "0");
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("runtimes, decisions list and stats", () => {
  const RUNTIME = { id: "rt_1", ref: "acme/refund", owner: "acme", slug: "refund", name: "Refund", servingMode: "active" };

  it("runtimes list, get, create and patch", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/runtimes": { body: { data: [RUNTIME] } },
      "GET /v1/runtimes/acme/refund": { body: RUNTIME },
      "POST /v1/runtimes": { status: 201, body: RUNTIME },
      "PATCH /v1/runtimes/acme/refund": { body: { ...RUNTIME, name: "Refund v2" } },
    });
    expect((await cli(fetchImpl, "runtimes", "list")).out).toMatch(/acme\/refund\s+serving=active/);
    expect((await cli(fetchImpl, "runtimes", "get", "acme/refund")).out).toMatch(/"Refund"/);
    await cli(fetchImpl, "runtimes", "create", "--slug", "refund", "--name", "Refund");
    expect(calls[2]!.body).toMatchObject({ slug: "refund", name: "Refund" });
    const patched = await cli(fetchImpl, "runtimes", "patch", "acme/refund", "--name", "Refund v2");
    expect(patched.out).toMatch(/Refund v2/);
    expect(calls[3]!.body).toMatchObject({ name: "Refund v2" });
  });

  it("mode is a shorthand for patch --serving-mode", async () => {
    const { fetchImpl, calls } = mockFetch({ "PATCH /v1/runtimes/acme/refund": { body: { ...RUNTIME, servingMode: "shadow" } } });
    const r = await cli(fetchImpl, "mode", "acme/refund", "shadow");
    expect(r.out).toBe("acme/refund now serves in shadow mode.");
    expect(calls[0]!.body).toEqual({ servingMode: "shadow" });
  });

  it("decisions list and stats", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/runtimes/acme/refund/decisions": { body: { data: [DECISION], hasMore: false } },
      "GET /v1/runtimes/acme/refund/stats": { body: { totals: { decisions: 1 } } },
    });
    const list = await cli(fetchImpl, "decisions", "list", "acme/refund", "--limit", "5", "--disagree");
    expect(list.out).toMatch(/dec_1\s+decided/);
    expect(calls[0]!.search).toBe("?disagree=true&limit=5");
    const stats = await cli(fetchImpl, "stats", "acme/refund", "--window", "7d");
    expect(stats.out).toMatch(/"decisions": 1/);
    expect(calls[1]!.path).toBe("/v1/runtimes/acme/refund/stats");
    expect(calls[1]!.search).toBe("?window=7d");
  });
});

describe("versions and packages", () => {
  it("versions list, promote, and package export (optionally to disk)", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/runtimes/acme/refund/versions": { body: { data: [{ number: 2, status: "candidate", note: "wider band" }] } },
      "POST /v1/runtimes/acme/refund/versions/2/promote": { body: { promoted: 2 } },
      "GET /v1/runtimes/acme/refund/package": { body: { files: { "runtime.yaml": "apiVersion: withai/v1" } } },
    });
    expect((await cli(fetchImpl, "versions", "list", "acme/refund")).out).toMatch(/v2\s+candidate\s+wider band/);
    const promoted = await cli(fetchImpl, "versions", "promote", "acme/refund", "2", "--override-reason", "gates were stale");
    expect(promoted.out).toBe("Promoted version 2.");
    expect(calls[1]!.body).toMatchObject({ overrideReason: "gates were stale" });
    const pkg = await cli(fetchImpl, "package", "acme/refund");
    expect(pkg.out).toBe("runtime.yaml");
  });
});

describe("reviews, learning and templates", () => {
  it("reviews list and settle", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/reviews": { body: { data: [{ id: "rev_1", question: "fraud", labels: ["block", "approve"], deadlineAt: "2026-12-01T00:00:00Z" }] } },
      "POST /v1/reviews/rev_1/settle": { body: { id: "rev_1", status: "settled", version: 2 } },
    });
    expect((await cli(fetchImpl, "reviews", "list")).out).toMatch(/rev_1\s+fraud\s+labels=block,approve/);
    expect(calls[0]!.path).toBe("/v1/reviews");
    await cli(fetchImpl, "reviews", "settle", "rev_1", "--decision", "block", "--expected-version", "1");
    expect(calls[1]!.body).toMatchObject({ decision: "block", expectedVersion: 1 });
  });

  it("learn, learned list/promote/discard", async () => {
    const { fetchImpl, calls } = mockFetch({
      "POST /v1/runtimes/acme/refund/learn": { status: 201, body: { id: "cand_1" } },
      "GET /v1/runtimes/acme/refund/learned": { body: { data: [{ id: "cand_1", status: "proposed" }] } },
      "POST /v1/runtimes/acme/refund/learned/cand_1/promote": { body: { id: "cand_1", status: "promoted" } },
      "POST /v1/runtimes/acme/refund/learned/cand_1/discard": { body: { id: "cand_1", status: "discarded" } },
    });
    await cli(fetchImpl, "learn", "acme/refund", "--cap", "5");
    expect(calls[0]!.body).toMatchObject({ capUsd: 5 });
    expect((await cli(fetchImpl, "learned", "list", "acme/refund")).out).toMatch(/cand_1/);
    expect((await cli(fetchImpl, "learned", "promote", "acme/refund", "cand_1")).out).toMatch(/promoted/);
    expect((await cli(fetchImpl, "learned", "discard", "acme/refund", "cand_1")).out).toMatch(/discarded/);
  });

  it("templates list, use and evaluate", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/templates": { body: { data: [{ id: "ci-review", name: "CI review", available: true }] } },
      "POST /v1/templates/ci-review/use": { status: 201, body: { ref: "acme/ci-review", template: "ci-review", testSetId: "ts_1", cases: 25 } },
      "POST /v1/runtimes/acme/ci-review/evaluate": { status: 201, body: { id: "eval_1" } },
    });
    expect((await cli(fetchImpl, "templates", "list")).out).toMatch(/ci-review\s+CI review/);
    const used = await cli(fetchImpl, "templates", "use", "ci-review", "--slug", "ci-review");
    expect(used.out).toBe("Created acme/ci-review from ci-review with 25 test cases.");
    expect(calls[1]!.body).toMatchObject({ slug: "ci-review" });
    await cli(fetchImpl, "templates", "evaluate", "acme/ci-review", "--cap", "10");
    expect(calls[2]!.body).toMatchObject({ capUsd: 10 });
  });
});

describe("models and privacy", () => {
  it("models lists the catalog, privacy purge erases by request id or input hash", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /v1/models": { body: { data: [{ id: "acme/refund", name: "Refund" }] } },
      "POST /v1/privacy/purge": { body: { purged: 3 } },
    });
    expect((await cli(fetchImpl, "models")).out).toBe("acme/refund");
    const purged = await cli(fetchImpl, "privacy", "purge", "--request-id", "req_1");
    expect(purged.out).toBe("Purged 3 decision(s).");
    expect(calls[1]!.body).toMatchObject({ requestId: "req_1" });
  });

  it("privacy purge needs a request id or an input hash", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const r = await cli(fetchImpl, "privacy", "purge");
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("the escape hatch: endpoints and call", () => {
  it("endpoints lists every path from the live OpenAPI description, filtered by --grep", async () => {
    const { fetchImpl } = mockFetch({
      "GET /api/v1/openapi.json": { body: { paths: { "/v1/decide/{owner}/{runtime}": { post: { summary: "Make a decision" } }, "/v1/reviews": { get: { summary: "List person reviews" } } } } },
    });
    const all = await cli(fetchImpl, "endpoints");
    expect(all.out).toMatch(/POST\s+\/v1\/decide\/\{owner\}\/\{runtime\}\s+Make a decision/);
    expect(all.out).toMatch(/GET\s+\/v1\/reviews\s+List person reviews/);
    const filtered = await cli(fetchImpl, "endpoints", "--grep", "review");
    expect(filtered.out).toMatch(/reviews/);
    expect(filtered.out).not.toMatch(/decide/);
  });

  it("endpoints needs no API key", async () => {
    const { fetchImpl } = mockFetch({ "GET /api/v1/openapi.json": { body: { paths: {} } } });
    const lines: string[] = [];
    const code = await run(["endpoints"], {}, (l) => lines.push(l), fetchImpl);
    expect(code).toBe(0);
  });

  it("call reaches an endpoint with no curated command, with a body, a query flag and a header", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /v1/runtimes/acme/refund/evaluate": { status: 201, body: { id: "eval_1" } } });
    const r = await cli(fetchImpl, "call", "POST", "/v1/runtimes/acme/refund/evaluate", "--body", '{"capUsd":10}', "--query", "dryRun=true", "--header", "x-trace:abc");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/"id": "eval_1"/);
    expect(calls[0]!.search).toBe("?dryRun=true");
    expect(calls[0]!.body).toEqual({ capUsd: 10 });
    expect(calls[0]!.headers["x-trace"]).toBe("abc");
  });

  it("replay prints fixed/broken flip counts, tags broken regression cases, and forwards --trials", async () => {
    const { fetchImpl, calls } = mockFetch({
      "POST /v1/runtimes/acme/refund/versions/2/replay": {
        body: {
          runtime: "acme/refund",
          sources: { testCases: 2, labeledDecisions: 0, labeledDecisionsWithoutInput: 0 },
          candidate: { version: 2, cases: 2, labeledAnswers: 2, accuracy: 0.5, realizedLossPer1000Usd: 10, costPer1000Usd: 0.2, escalationShare: 0.5, synthetic: false },
          baseline: { version: 1, cases: 2, labeledAnswers: 2, accuracy: 0.5, realizedLossPer1000Usd: 10, costPer1000Usd: 0.2, escalationShare: 0.5, synthetic: false },
          flips: { fixed: 1, broken: 1, other: 0, brokenRegressionIds: ["tc_2"] },
          regressionPassRates: [{ case: "tc_2", passed: 2, trials: 3, flaky: true }],
          changed: [
            { case: "tc_1", source: "test_case", outcome: "fixed", regression: false, candidate: { fraud: "block" }, baseline: { fraud: "approve" }, truth: { fraud: "block" } },
            { case: "tc_2", source: "test_case", outcome: "broken", regression: true, candidate: { fraud: "approve" }, baseline: { fraud: "block" }, truth: { fraud: "block" } },
          ],
          changedCount: 2,
          spentUsd: 0.001,
          notes: ["1 regression case(s) broke in this replay: tc_2."],
        },
      },
    });
    const r = await cli(fetchImpl, "replay", "--runtime", "acme/refund", "--version", "2", "--trials", "3");
    expect(r.code, r.out).toBe(0);
    expect(calls[0]!.body).toMatchObject({ trials: 3 });
    expect(r.out).toMatch(/2 cases changed answer \(1 fixed, 1 broken\)\./);
    expect(r.out).toMatch(/\[FIXED\] test_case tc_1/);
    expect(r.out).toMatch(/\[BROKEN\] \[REGRESSION\] test_case tc_2/);
    expect(r.out).toMatch(/\[REGRESSION FLAKY\] tc_2: 2\/3 trials passed/);
  });
});

describe("CLI security and argument parsing", () => {
  it("parseArgs preserves '=' inside --flag=value and does not swallow positionals after boolean flags", () => {
    const a = parseArgs(["--json", "runtimes", "list"]);
    expect(a.flags.json).toBe("true");
    expect(a.positional).toEqual(["runtimes", "list"]);

    const b = parseArgs(["decide", "--escalate", "acme/refund", '--input={"url":"https://x.test?a=1&b=2"}', "--callback-url=https://hook.test/cb?token=abc=def"]);
    expect(b.positional).toEqual(["decide", "acme/refund"]);
    expect(b.flags.escalate).toBe("true");
    expect(b.flags.input).toBe('{"url":"https://x.test?a=1&b=2"}');
    expect(b.flags["callback-url"]).toBe("https://hook.test/cb?token=abc=def");
  });

  it("call preserves '=' inside --header values and rejects off-origin paths", async () => {
    const { fetchImpl, calls } = mockFetch({ "POST /v1/models": { body: { ok: true } } });
    const r = await cli(fetchImpl, "call", "POST", "/v1/models", "--query=a=1,b=2", "--header", "x-sig:sha256=abc==");
    expect(r.code, r.out).toBe(0);
    expect(calls[0]!.search).toBe("?a=1&b=2");
    expect(calls[0]!.headers["x-sig"]).toBe("sha256=abc==");

    const bad = await cli(fetchImpl, "call", "GET", ".attacker.com/leak");
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/must start with a single "\/"/);
  });

  it("package --out refuses path traversal keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "askwithai-pkg-"));
    try {
      const { fetchImpl } = mockFetch({
        "GET /v1/runtimes/acme/refund/package": { body: { files: { "../escaped.txt": "nope" } } },
      });
      const r = await cli(fetchImpl, "package", "acme/refund", "--out", dir);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Refusing to write package path outside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
