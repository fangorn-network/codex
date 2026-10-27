// The owner's own findings: seed/*.json (written by research runs) → codex.finding.v1 records.
//   node sources/seed.mjs --dir seed --publisher <0x…> --output-dir .ship/stage/<ns>
//        [--publish --namespace <ns> --fangorn-bin <cli>]
// Cost per file comes from seed/_cost.jsonl ({file, model, tokens, tool_calls, seconds}).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: {
  dir: { type: "string" }, publisher: { type: "string" }, "output-dir": { type: "string" },
  publish: { type: "boolean" }, replace: { type: "boolean" },
  namespace: { type: "string" }, "fangorn-bin": { type: "string", default: "fangorn" } } });
for (const k of ["dir", "publisher", "output-dir"]) if (!a[k]) throw new Error(`--${k} is required`);

import { TYPE as TAG, record } from "../site/draft.mjs";
const TOPICS = ["payments", "chain", "llm-pricing", "hosting", "storage", "web-platform", "ml"];
const costFile = join(a.dir, "_cost.jsonl");
const cost = Object.fromEntries((existsSync(costFile) ? readFileSync(costFile, "utf8").trim().split("\n") : [])
  .filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.file, c]));

// A file holding {records} is a draft's records_json, as pushed: kept as it is. Every finding the owner
// pushes to this namespace goes here too, or the next ship's --replace drops it.
const records = (await Promise.all(readdirSync(a.dir).filter((f) => f.endsWith(".json")).sort().map(async (f) => {
  const d = JSON.parse(readFileSync(join(a.dir, f), "utf8"));
  if (d.records) return d.records.map((r) => ({ name: r.id, fields: r.payload }));
  if (!TOPICS.includes(d.topic)) throw new Error(`${f}: topic "${d.topic}" is not one of ${TOPICS.join(", ")}`);
  const c = cost[f] ?? {};
  const r = await record({ ...d, model: c.model, cost_tokens: c.tokens, cost_seconds: c.seconds }, a.publisher);
  return [{ name: r.id, fields: r.payload }];
}))).flat();

const out = resolve(a["output-dir"]);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "volume_1_findings.json"), JSON.stringify(records, null, 1));
console.error(`[seed] ${records.length} findings → ${out}`);

if (a.publish) {
  if (!a.namespace) throw new Error("--publish needs --namespace");
  const cwd = resolve(".ship/repos", a.namespace);
  mkdirSync(cwd, { recursive: true });
  const [bin, ...pre] = a["fangorn-bin"].split(/\s+/).map((t) => (t.includes("/") && !t.startsWith("/") ? resolve(t) : t));
  const cli = (...args) => execFileSync(bin, [...pre, ...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (!existsSync(join(cwd, ".fangorn/repo.json"))) cli("repo", "init", a.namespace);
  const file = join(cwd, "records.json");
  writeFileSync(file, JSON.stringify({ records: records.map((r) => ({ id: r.name, type: TAG, payload: r.fields })) }));
  cli("commit", file, "-m", `${records.length} findings`, "--replace");
  cli("push");
}
