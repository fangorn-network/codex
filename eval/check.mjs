// How well `check` separates questions codex holds (`hit`: the finding it should return) from
// ones it does not, and where HIT and NEAR should sit. `near_ok`: near with the right finding passes.
//   node eval/check.mjs <view dir | site url> [eval/check.jsonl]
// A view dir is scored here (the local encoder); a URL through its GET /api/check (Workers AI).
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { HIT, NEAR, check } from "../site/codex.mjs";

const [where, file = "eval/check.jsonl"] = process.argv.slice(2);
const labels = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let ask;
if (/^https?:/.test(where)) ask = async (q) => (await fetch(`${where.replace(/\/$/, "")}/api/check?q=${encodeURIComponent(q)}`)).json();
else {
  const { embedQueryDirect, unpackVec } = await import("@fangorn-network/westmarch/embed");
  const rows = [];
  for (const d of readdirSync(`${where}/cdn/domains`)) for (const f of readdirSync(`${where}/cdn/domains/${d}/shards`))
    for (const l of gunzipSync(readFileSync(`${where}/cdn/domains/${d}/shards/${f}`)).toString().split("\n").filter(Boolean)) {
      const r = JSON.parse(l), v = unpackVec(r.v);
      rows.push({ id: r.track_id, owner: r.owner, ...r.fields, vector: v, norm: Math.hypot(...v) || 1 });
    }
  ask = async (q) => check(rows, await embedQueryDirect(q), { near: process.env.ALL ? 0 : NEAR });
}
const out = [];
for (const t of labels) {
  const c = await ask(t.q);
  out.push({ q: t.q.slice(0, 60), want: t.hit ? "hit" : "-", got: c.verdict, score: c.finding?.score ?? null, id_ok: !t.hit || c.finding?.id === t.hit,
             ok: t.hit ? (c.verdict === "hit" || (t.near_ok && c.verdict === "near")) && c.finding?.id === t.hit : c.verdict !== "hit" });
}
console.table(out);
// A miss reports no score: ALL=1 (a view dir only) scores every question.
const ins = out.filter((o) => o.want === "hit").map((o) => o.score ?? 0), outs = out.filter((o) => o.want === "-").map((o) => o.score ?? 0);
console.log(`HIT ${HIT} NEAR ${NEAR}: ${out.filter((o) => o.ok).length}/${out.length} right; lowest hit ${Math.min(...ins)}, highest non-hit ${Math.max(...outs)}`);
process.exit(out.every((o) => o.ok) ? 0 : 1);
