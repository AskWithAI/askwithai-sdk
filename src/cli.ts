#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AskWithAI, AskWithAIError, type ServingMode } from "./client";

/*
 * `askwithai`: push and check decision packages, replay versions, switch
 * serving modes. Reads ASKWITHAI_URL (default https://api.askwith.ai) and
 * ASKWITHAI_API_KEY. Run `askwithai help` for usage.
 */

const USAGE = `askwithai: work with AskWithAI Decision Runtimes from a repository.

  askwithai push  [dir] --runtime owner/slug [--note "why"]   save the package in dir (default ./askwithai) as a new version
  askwithai check [dir] --runtime owner/slug                  run the release gates on the package without saving it
  askwithai replay --runtime owner/slug --version 3 [--against live|2] [--since 24h] [--limit 50] [--cap 1]
                                                              run a candidate version and the live one on labeled cases
  askwithai mode owner/slug parity|shadow|active              set the serving mode

Environment: ASKWITHAI_API_KEY (required), ASKWITHAI_URL (default https://api.askwith.ai).`;

const TEXT_FILE = /\.(ya?ml|md|json|jsonl|csv|txt)$/i;
const MAX_FILES = 200;

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

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      flags[k] = inline ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true");
    } else positional.push(a);
  }
  return { positional, flags };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(4)}`);

/** Run one command. Returns the exit code; output goes to `out`. */
export async function run(argv: string[], env: Record<string, string | undefined> = process.env, out: (line: string) => void = console.log, fetchImpl?: typeof fetch): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (!command || command === "help" || flags.help) {
    out(USAGE);
    return command ? 0 : 1;
  }
  const apiKey = env.ASKWITHAI_API_KEY?.trim();
  if (!apiKey) {
    out("Set ASKWITHAI_API_KEY to an AskWithAI API key (wai_...).");
    return 2;
  }
  const client = new AskWithAI({ apiKey, baseUrl: env.ASKWITHAI_URL || undefined, fetch: fetchImpl });
  const runtime = flags.runtime ?? (command === "mode" ? rest[0] : undefined);
  if (!runtime || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(runtime)) {
    out(`Name the runtime as owner/slug${command === "mode" ? "" : " with --runtime"}.`);
    return 2;
  }
  try {
    switch (command) {
      case "push": {
        const files = readPackage(rest[0] ?? "askwithai");
        const r = await client.push(runtime, files, { note: flags.note });
        out(r.created ? `Created ${runtime}; version 1 is live.` : `Saved ${runtime} version ${r.version.number} as a ${r.version.status}. Check it, replay it, then promote it in the studio or with POST .../versions/${r.version.number}/promote.`);
        return 0;
      }
      case "check": {
        const files = readPackage(rest[0] ?? "askwithai");
        const r = await client.check(runtime, files);
        for (const g of r.gates) out(`${g.passed ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}`);
        out(r.passed ? "All release gates passed." : "Some release gates failed.");
        return r.passed ? 0 : 1;
      }
      case "replay": {
        const version = Number(flags.version);
        if (!Number.isInteger(version) || version < 1) {
          out("Give the candidate version with --version.");
          return 2;
        }
        const against = flags.against === undefined || flags.against === "live" ? "live" : Number(flags.against);
        const r = await client.replay(runtime, version, { against, since: flags.since, limit: flags.limit ? Number(flags.limit) : undefined, capUsd: flags.cap ? Number(flags.cap) : undefined });
        out(`Replayed ${r.candidate.cases} cases (${r.sources.testCases} test cases, ${r.sources.labeledDecisions} labeled decisions).`);
        for (const side of [r.candidate, r.baseline]) {
          out(`  v${side.version}: accuracy ${pct(side.accuracy)}, realized loss per 1,000 ${usd(side.realizedLossPer1000Usd)}, cost per 1,000 ${usd(side.costPer1000Usd)}, escalated ${pct(side.escalationShare)}${side.synthetic ? " (simulated)" : ""}`);
        }
        out(`${r.changedCount} cases changed answer.`);
        for (const c of r.changed.slice(0, 10)) out(`  ${c.source} ${c.case}: ${JSON.stringify(c.baseline)} -> ${JSON.stringify(c.candidate)} (truth ${JSON.stringify(c.truth)})`);
        for (const n of r.notes) out(`Note: ${n}`);
        return 0;
      }
      case "mode": {
        const mode = (rest[1] ?? flags.mode) as ServingMode | undefined;
        if (!mode || !["parity", "shadow", "active"].includes(mode)) {
          out("Give the mode: parity, shadow or active.");
          return 2;
        }
        const r = await client.setServingMode(runtime, mode);
        out(`${r.ref} now serves in ${r.servingMode} mode.`);
        return 0;
      }
      default:
        out(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    out(e instanceof AskWithAIError ? `AskWithAI answered ${e.status} (${e.code}): ${e.message}` : `Error: ${(e as Error).message}`);
    return 1;
  }
}

// Run when executed as a program (not when imported by tests).
const invoked = process.argv[1] ?? "";
if (/askwithai$|cli\.(c?js|ts)$/.test(invoked)) {
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
