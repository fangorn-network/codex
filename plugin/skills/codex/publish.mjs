#!/usr/bin/env node
// Publish one finding to codex: draft (codex checks every quote against its page) → commit → push.
//   node publish.mjs [--auto] [--join] draft.json
// draft.json: {question, teaser, answer, fresh_for, cost_tokens, model, claims:[{text,url,quote}], caveats, lineage}
// --auto  refuse a draft that names this machine's private context (the user ran nothing to approve it)
// --join  if the wallet is not a codex publisher yet, join (public and permanent) and push again
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const C = process.env.CODEX_URL || "https://codex.fangorn-0be.workers.dev";
const REPO = path.join(os.homedir(), ".codex-research");   // one codex repo per wallet
const env = { ...process.env, FANGORN_NETWORK: "baseSepolia", CHAIN_NAME: "baseSepolia" };   // codex lives on Base Sepolia
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const die = (m) => { console.error(m); process.exit(1); };
const run = (...args) => spawnSync("fangorn", ["--app", "codex", ...args], { cwd: REPO, env, encoding: "utf8" });
if (!file) die("usage: node publish.mjs [--auto] [--join] draft.json");
const draft = JSON.parse(fs.readFileSync(file, "utf8"));

// Words that would place a finding on this machine. Conservative on purpose: auto has no human in the loop.
// ponytail: names only (cwd, git repo, user, host, home paths); a real private-context check needs the model
function privateWords(cwd = process.cwd()) {
  const git = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).stdout?.trim().split("/").pop()?.replace(/\.git$/, "");
  const words = [cwd !== os.homedir() && path.basename(cwd), git, os.userInfo().username, os.hostname()];
  return [...new Set(words.filter((w) => w && w.length >= 4).map((w) => w.toLowerCase()))];
}
function leaks(text, words) {
  const t = text.toLowerCase();
  return [...words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)),
    ...(/(\/home\/|\/users\/|~\/|[a-z]:\\)/i.test(text) ? ["a local path"] : [])];
}

if (flags.has("--auto")) {
  const text = [draft.question, draft.teaser, draft.answer, draft.caveats, ...(draft.claims ?? []).map((c) => c.text)].join("\n");
  const hit = leaks(text, privateWords());
  if (hit.length) die(`not published (--auto): the finding mentions ${hit.join(", ")}. Rewrite it in general terms, or ask the user.`);
}

const wallet = spawnSync("fangorn", ["wallet"], { env, encoding: "utf8" }).stdout ?? "";
const publisher = wallet.match(/Address:\s+(0x[0-9a-fA-F]{40})/)?.[1] ?? die("no wallet: run `fangorn wallet` to make one");

// Only auto is stamped: nobody falsely admits skipping review, so the label can't flatter. "Reviewed" would be unverifiable.
const r = await fetch(`${C}/api/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, publisher, ...(flags.has("--auto") ? { method: { ...draft.method, publish: "auto" } } : {}) }) }).then((x) => x.json());
for (const p of r.problems ?? []) console.error(`${p.level}: ${p.message}`);
if (!r.ready) die("not published: fix the errors above and run again");

fs.mkdirSync(REPO, { recursive: true });
if (!fs.existsSync(path.join(REPO, ".fangorn", "repo.json"))) {
  const init = run("repo", "init", "research");
  if (init.status) die(`repo init failed:\n${init.stderr || init.stdout}`);
}
const repoFile = path.join(REPO, ".fangorn", "repo.json");
const repo = JSON.parse(fs.readFileSync(repoFile, "utf8"));
if (repo.owner.toLowerCase() !== publisher.toLowerCase())
  die(`${REPO} belongs to ${repo.owner}, but fangorn signs as ${publisher}. Switch ~/.fangorn/config.json back, or move ${REPO} aside to start a repo for this wallet.`);
// Build on the on-chain tip, not the local one: a commit left by an earlier failed push would make this one a stale parent.
const tip = run("status").stdout?.match(/On-chain tip:\s+(baf\w+)/)?.[1];
if (tip && tip !== repo.head) fs.writeFileSync(repoFile, JSON.stringify({ ...repo, head: tip }, null, 2));
fs.writeFileSync(path.join(REPO, "records.json"), JSON.stringify(r.records_json));
const commit = run("commit", "records.json", "-m", draft.question);   // without --replace: adds to the repo
if (commit.status) die(`commit failed:\n${commit.stderr || commit.stdout}`);
let push = run("push");
if (push.status && flags.has("--join")) {
  const j = await fetch(`${C}/api/join`, { method: "POST", body: JSON.stringify({ address: publisher }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  console.error(`join: ${JSON.stringify(j)}`);
  push = run("push");
}
if (push.status) die(`push failed:\n${push.stderr || push.stdout}\nIf ${publisher} is not a codex publisher yet, ask the user, then rerun with --join (joining is public and permanent).`);
console.log(`published: ${C}/wiki.html#${r.record.id} (live within about five minutes)`);
