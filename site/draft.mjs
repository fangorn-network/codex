// Research in → a codex.finding.v1 record out, checked. The one place a finding's shape is made:
// sources/seed.mjs builds the owner's findings with `record`, and the Worker's `draft` tool
// (MCP, POST /api/draft, the Publish page) runs `draft` on whatever a publisher has.
//
// draft takes research as it comes: free text (a model pulls out the question, answer and claims,
// each with the url and exact words that support it), or the fields themselves, loosely shaped
// (claims as strings or {text, url, quote}, sources as urls). Then, in code, not by the model:
//   - fetches every cited page, keeps a quote only if it is on the page, and hashes the bytes
//   - a claim may cite a record of another Fangorn app ({app: appId, id}) instead of a page: the
//     record is read with that app's own `get`, from the card its appId binds on chain, and the
//     quote must be in the record's text
//   - removes emails and phone numbers unless `allow_personal`
//   - picks the nearest topic when none is given, and flags a question codex already holds
//   - computes finding_id, found_at, fresh_until, uncited_claims
// It returns the record and what is wrong with it; nothing is published.

export const TYPE = "codex.finding.v1";
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, APP_ID = /^0x[0-9a-fA-F]{64}$/, DURATION = /^P(\d+)([DWMY])$/, SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const DAYS = { D: 1, W: 7, M: 30, Y: 365 };
export const until = (at, dur) => {
  const m = DURATION.exec(dur ?? "");
  if (!m) throw new Error(`fresh_for "${dur}" is not PnD, PnW, PnM or PnY`);
  return new Date(Date.parse(at) + m[1] * DAYS[m[2]] * 864e5).toISOString().slice(0, 10);
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));

/** A finding (question, teaser, topic, claims, citations, …) → its records.json entry. */
export async function record(d, publisher) {
  const pub = publisher.toLowerCase();
  const found_at = d.citations.map((c) => c.retrieved_at).filter(Boolean).sort()[0] ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const id = `codex:finding:${(await sha256(`${d.question}\n${pub}\n${found_at}`)).slice(0, 16)}`;
  // A claim counts as cited only if one of its citations carries a verbatim excerpt.
  const uncited = d.claims.filter((c) => !(c.cites ?? []).some((i) => d.citations[i]?.excerpt)).length;
  return { id, type: TYPE, payload: {
    entityType: TYPE, finding_id: id,
    question: d.question, teaser: d.teaser, topic: d.topic, tags: d.tags ?? [],
    found_at, fresh_for: d.fresh_for, fresh_until: until(found_at, d.fresh_for), publisher: pub,
    model: d.model ?? null, cost_tokens: d.cost_tokens ?? null, cost_seconds: d.cost_seconds ?? null,
    claims: d.claims, answer: d.answer, citations: d.citations, method: d.method, caveats: d.caveats ?? null,
    lineage: d.lineage ?? [],
    citation_urls: d.citations.map((x) => x.url), uncited_claims: uncited } };
}

// ── personal data: removed unless the publisher says it belongs ──
const PERSONAL = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "an email address"],
  [/(?<![\w-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g, "a phone number"],
  [/(?<![\w-])\+\d{1,3}(?:[\s-]?\d){8,12}(?![\w-])/g, "a phone number"],
];
function scrub(s, found) {
  if (typeof s !== "string") return s;
  for (const [re, what] of PERSONAL) s = s.replace(re, () => (found.add(what), "[removed]"));
  return s;
}

// ── a cited page: fetched once, its text for finding quotes in ──
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/\s+/g, " ").trim().toLowerCase();
const visible = (html) => html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
async function page(fetcher, url) {
  try {
    const r = await fetcher(url, { headers: { "user-agent": "codex-draft (+https://codex.fangorn-0be.workers.dev)" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > 5e6) return { error: "over 5 MB" };
    const raw = new TextDecoder().decode(bytes);
    // The visible text, and the raw markup too: pages rendered by script keep their words in it.
    return { sha256: await sha256(bytes), at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), text: norm(visible(raw)), raw: norm(raw.replace(/<[^>]+>/g, " ")) };
  } catch (e) { return { error: e.name === "TimeoutError" ? "timed out" : e.message }; }
}

// ── a cited app record: {app, id} ↔ fangorn://<appId>/<id>, the key it is fetched and cited by ──
export const appUrl = (app, id) => `fangorn://${app.toLowerCase()}/${encodeURIComponent(id)}`;
const appRef = (u) => { const m = /^fangorn:\/\/(0x[0-9a-f]{64})\/(.+)$/.exec(u); return m ? { app: m[1], id: decodeURIComponent(m[2]) } : null; };
const strings = (v) => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
async function appPage(read, u) {
  if (!read) return { error: "this codex cannot read app records" };
  const { app, id } = appRef(u);
  try {
    // read → { text: the record exactly as the app's get returned it, name, site }, verified against the chain.
    const r = await read(app, id);
    if (r.error) return { error: r.error };
    const text = norm(strings(JSON.parse(r.text)).join(" "));
    return { sha256: await sha256(r.text), at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), text, raw: text,
      app: { id: app, name: r.name, site: r.site ?? null }, record_id: id };
  } catch (e) { return { error: e.message }; }
}

// ── what reading a finding's evidence costs: the pages behind its quotes, fetched by codex, ~4 characters a token ──
// A page counts its visible words, or its raw markup when only the markup holds the quotes (pages rendered by script).
export async function measure(citations, env) {
  let chars = 0, read = 0;
  for (const u of new Set((citations ?? []).filter((c) => c.excerpt).map((c) => c.url))) {
    const p = appRef(u) ? await appPage(env.record, u) : /^https?:\/\//.test(u) ? await page(env.fetch, u) : { error: "not a url" };
    if (p.error) continue;
    const qs = citations.filter((c) => c.url === u && c.excerpt).map((c) => norm(c.excerpt));
    chars += (qs.every((q) => p.text.includes(q)) ? p.text : p.raw).length; read++;
  }
  return read ? Math.round(chars / 4) : null;
}

// ── free text → fields, by a model: the schema it must fill ──
const SCHEMA = { type: "object", required: ["question", "teaser", "answer", "claims"], properties: {
  question: { type: "string", description: "The one question this research answers, general enough that another agent would ask it. No names of private people, no personal context." },
  teaser: { type: "string", description: "The answer in one line, under 140 characters, with the key numbers." },
  answer: { type: "string", description: "The answer in a few sentences." },
  topic: { type: "string", description: "One lowercase slug" },
  tags: { type: "array", items: { type: "string" } },
  fresh_for: { type: "string", description: "How long this stays true: ISO duration PnD, PnW, PnM or PnY. Prices and versions P30D; standards P6M." },
  caveats: { type: "string" },
  claims: { type: "array", items: { type: "object", required: ["text"], properties: {
    text: { type: "string", description: "One checkable statement" },
    url: { type: "string", description: "The source url the research gives for it, exactly as written; empty if none" },
    quote: { type: "string", description: "Words from the research that it says the source contains, copied exactly; empty if none" } } } } } };
const PROMPT = `You turn an AI agent's research notes into one structured finding for codex, a shared registry of research.
question: a real question ending in "?", as another agent would ask it, with no personal context.
teaser: the answer itself in one line, with its numbers, not a description of it.
claims: every checkable statement, one each. For each, url is the page the notes give for it, and quote is the text the notes put in quotation marks for it, copied exactly without the quotation marks. Never invent a url or a quote; leave them empty when the notes give none.
fresh_for: from what the notes say about how long it holds, else your judgement.
Topics already in codex: TOPICS. Use one of them if it fits, else a new lowercase slug.`;
async function extract(ai, text, topics) {
  const out = await ai(MODEL, { messages: [{ role: "system", content: PROMPT.replace("TOPICS", topics.join(", ") || "none yet") },
    { role: "user", content: text }], response_format: { type: "json_schema", json_schema: SCHEMA }, max_tokens: 3000 });
  const r = out?.response ?? out;
  return typeof r === "string" ? JSON.parse(r) : r;
}

/**
 * input: { publisher, text?, question?, teaser?, answer?, topic?, tags?, fresh_for?, caveats?, claims?, sources?/citations?,
 *          lineage?, model?, cost_tokens?, cost_seconds?, method?, allow_personal? }
 * env:   { fetch, ai(model, body), topics: [slug], nearest(question) → { topic, check },
 *          record(appId, id) → { text, name, site } | { error } }
 * → { ready, problems: [{ level: error|warn, message }], record, records_json, next }
 */
export async function draft(input, env) {
  const problems = [], error = (message) => problems.push({ level: "error", message }), warn = (message) => problems.push({ level: "warn", message });
  if (!ADDRESS.test(input.publisher ?? "")) error("publisher must be your wallet address (0x and 40 hex), the one you joined with");
  let d = { ...input };
  if (input.text) {
    if (input.text.length > 40000) return { ready: false, problems: [{ level: "error", message: "text is over 40,000 characters: send the finding, not the whole transcript" }] };
    const x = await extract(env.ai, input.text, env.topics ?? []);
    d = { ...x, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v != null && k !== "text")) };
  }

  // Every page the research cites, fetched once: its hash, and its words to check quotes against.
  // An app record is cited as {app, id}; from here on it is one more url.
  const asUrl = (c) => (APP_ID.test(c.app ?? "") && c.id ? { ...c, url: appUrl(c.app, String(c.id)) } : c);
  const given = [...(d.citations ?? d.sources ?? [])].map((c) => asUrl(typeof c === "string" ? { url: c } : { ...c }));
  const raw = (d.claims ?? []).map((c) => asUrl(typeof c === "string" ? { text: c } : c));
  const urls = [...new Set([...given, ...raw].map((c) => c.url).filter(Boolean))];
  if (urls.length > 12) error("12 sources at most per finding");
  const pages = new Map();
  for (const u of urls.slice(0, 12)) {
    const isApp = !!appRef(u);
    if (!isApp && !/^https?:\/\//.test(u)) { error(`source "${u}" is not an http(s) url, or an app record {app: appId, id}`); continue; }
    const p = isApp ? await appPage(env.record, u) : await page(env.fetch, u);
    pages.set(u, p);
    if (p.error) warn(`could not read ${u} (${p.error}): its quotes are unchecked, and its claims count as uncited`);
  }
  const on = (u, q) => { const p = pages.get(u); return !!q && !!p && !p.error && (p.text.includes(norm(q)) || p.raw.includes(norm(q))); };

  // Words the research quotes ("…"): a claim left without a quote takes the one on its page that shares
  // the most numbers and words with it. Models drop quotes; the notes keep them.
  const said = [...(input.text ?? "").matchAll(/["\u201C]([^"\u201D\n]{8,400})["\u201D]/g)].map((m) => m[1]);
  const terms = (x) => new Set((norm(x).match(/[$\w][\w.$/,-]*/g) ?? []).map((t) => t.replace(/[.,]+$/, "")).filter((t) => t.length > 3 || /\d/.test(t)));
  const best = (u, text) => {
    const want = terms(text);
    const [n, q] = said.filter((q) => on(u, q)).map((q) => [[...terms(q)].filter((t) => want.has(t)).length, q]).sort((x, y) => y[0] - x[0])[0] ?? [0];
    return n >= 2 ? q : null;
  };

  const citations = [];
  const cite = (url, excerpt, from = {}) => {
    let i = citations.findIndex((c) => c.url === url && (c.excerpt ?? null) === (excerpt ?? null));
    if (i < 0) {
      const p = pages.get(url);
      i = citations.push({ url, retrieved_at: from.retrieved_at ?? p?.at ?? null, sha256: from.sha256 ?? p?.sha256 ?? null,
        ...(p?.app ? { app: p.app, record_id: p.record_id } : {}), ...(excerpt ? { excerpt } : {}) }) - 1;
    }
    return i;
  };
  const claims = raw.map((c) => {
    // Where the claim says it came from: its cites into the sources, its url, or the only source there is.
    const refs = c.cites?.length ? c.cites.map((i) => given[i]).filter(Boolean)
      : c.url ? [{ url: c.url, excerpt: c.quote }]
      : urls.length === 1 ? [{ url: urls[0], excerpt: c.quote }]
      : urls.map((u) => ({ url: u, excerpt: c.quote })).filter((r) => on(r.url, r.excerpt) || best(r.url, c.text)).slice(0, 1);
    const cites = refs.filter((r) => pages.has(r.url)).map((r) => {
      let q = r.excerpt || null;
      if (q && !on(r.url, q)) { warn(`the quote "${q.slice(0, 80)}" is not on ${r.url}: copy the exact words from the page, or the claim counts as uncited`); q = null; }
      return cite(r.url, q ?? best(r.url, c.text), r);
    });
    return { text: c.text, cites: [...new Set(cites)] };
  });
  for (const u of urls) if (pages.has(u) && !citations.some((c) => c.url === u)) cite(u, null, given.find((g) => g.url === u));

  // Personal data out, unless it belongs.
  const found = new Set();
  if (!input.allow_personal) {
    for (const k of ["question", "teaser", "answer", "caveats"]) d[k] = scrub(d[k], found);
    for (const c of claims) c.text = scrub(c.text, found);
    for (const c of citations) if (c.excerpt) c.excerpt = scrub(c.excerpt, found);
    if (found.size) warn(`removed ${[...found].join(" and ")}. If it belongs in the finding, draft again with allow_personal: true; you are responsible for what you publish`);
  }

  if (!d.question?.trim()) error("question is missing: the one question this research answers");
  if (!d.teaser?.trim()) error("teaser is missing: the answer in one line");
  else if (d.teaser.length > 160) warn("teaser is over 160 characters; it is what search shows");
  if (!claims.length) error("no claims: list the checkable statements, each with the url that supports it");
  if (!citations.length) error("no sources: a finding cites the pages it read");
  if (!d.fresh_for || !DURATION.test(d.fresh_for)) { if (d.fresh_for) warn(`fresh_for "${d.fresh_for}" is not PnD/PnW/PnM/PnY`); d.fresh_for = "P30D"; warn("fresh_for set to P30D: say how long this stays true"); }
  if (d.cost_tokens == null) warn("cost_tokens is missing: what the research cost, which the leaderboard counts as saved when others reuse it");

  // Its topic and whether codex already holds it, from the question's vector.
  const near = d.question ? await env.nearest(d.question) : null;
  if (!SLUG.test(d.topic ?? "")) { if (d.topic) warn(`topic "${d.topic}" is not a lowercase slug`); d.topic = near?.topic ?? "general"; }
  const lineage = [...(d.lineage ?? [])];
  if (near?.check?.verdict === "hit") warn(`codex already holds this question: ${near.check.finding.id} ("${near.check.finding.question}"). Publish only if yours is newer or better, and keep its id in lineage`);
  if (near?.check?.verdict === "stale" && !lineage.includes(near.check.finding.id)) lineage.push(near.check.finding.id);

  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) return { ready: false, problems };
  // The app tools codex called to check this finding are part of how it was made.
  const method = { tools: [], ...d.method };
  for (const c of citations) if (c.app && !method.tools.some((t) => t.app === c.app.id && t.id === c.record_id)) method.tools = [...method.tools, { app: c.app.id, name: c.app.name, tool: "get", id: c.record_id }];
  const rec = await record({ ...d, claims, citations, lineage, tags: d.tags ?? [], method }, input.publisher);
  const bare = claims.filter((c) => !c.cites.some((i) => citations[i]?.excerpt)).map((c) => `"${c.text.slice(0, 60)}"`);
  if (bare.length) warn(`${bare.length} of ${claims.length} claims have no quote found on their page, so they count as uncited: ${bare.join(", ")}. Add the page's exact words in quotation marks and draft again`);
  return { ready: true, problems, record: rec, records_json: { records: [rec] },
    next: "Save records_json as records.json, then: fangorn commit records.json -m \"<question>\" && fangorn push. Without --replace, a commit adds to what your repo already holds." };
}

// node site/draft.mjs: draft on a fake page and a fake model.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const fetcher = async (url) => url.includes("gone") ? new Response("", { status: 404 })
    : new Response(`<html><script>x</script><p>The fee is &quot;$0.001&quot; per settlement after 1,000 free.</p></html>`);
  const env = { fetch: fetcher, topics: ["payments"], nearest: async () => ({ topic: "payments", check: { verdict: "miss" } }),
    ai: async () => ({ response: { question: "What does X charge?", teaser: "$0.001 each after 1,000 free", answer: "a", fresh_for: "P30D",
      claims: [{ text: "It costs $0.001; mail bob@example.com", url: "https://x.test/a", quote: "the fee is “$0.001” per settlement" },
               { text: "Made up", url: "https://x.test/a", quote: "free forever" }, { text: "Gone", url: "https://x.test/gone", quote: "z" }] } }) };
  const pub = "0x" + "ab".repeat(20);
  const r = await draft({ publisher: pub, text: "notes", cost_tokens: 9 }, env);
  assert(r.ready, JSON.stringify(r.problems));
  const p = r.record.payload;
  assert(p.citations.length === 3 && p.citations[0].excerpt && !p.citations[1].excerpt && p.citations[0].sha256.length === 64, "a quote on the page is kept, one not on it dropped");
  assert(p.uncited_claims === 2 && p.topic === "payments" && p.fresh_until && p.finding_id === r.record.id, "uncited, topic, dates, id");
  assert(p.claims[0].text.includes("[removed]") && r.problems.some((x) => /email/.test(x.message)), "an email is removed");
  assert((await draft({ publisher: pub, text: "notes", allow_personal: true }, env)).record.payload.claims[0].text.includes("bob@"), "allow_personal keeps it");
  assert(!(await draft({ publisher: "nope", claims: ["a"], sources: ["https://x.test/a"] }, env)).ready, "a bad publisher is an error");
  const s = await draft({ publisher: pub, question: "q", teaser: "t", claims: ["call +1 555-123-4567 on 2026-10-26"], sources: ["https://x.test/a"] }, env);
  assert(s.ready && s.record.payload.claims[0].text === "call [removed] on 2026-10-26", "a phone goes, a date stays: " + s.record.payload.claims[0].text);
  const h = await draft({ publisher: pub, question: "q", teaser: "t", claims: ["c"], sources: ["https://x.test/a"] },
    { ...env, nearest: async () => ({ topic: "payments", check: { verdict: "stale", finding: { id: "codex:finding:old" } } }) });
  assert(h.record.payload.lineage[0] === "codex:finding:old", "a stale match goes into lineage");
  const n = await draft({ publisher: pub, text: 'x.test/a says "per settlement after 1,000 free" and that is it' },
    { ...env, ai: async () => ({ response: { question: "q?", teaser: "t", claims: [{ text: "free for the first 1,000 per settlement", url: "https://x.test/a" }], fresh_for: "P1W" } }) });
  assert(n.ready && n.record.payload.citations[0]?.excerpt === "per settlement after 1,000 free", "a quote in the notes is recovered");
  const Q = "0x" + "b".repeat(64), qrec = JSON.stringify({ id: "q:1", text: "Mississippi: 545,431 road segments and 126,894 places.", vector: [0.1] });
  const a = await draft({ publisher: pub, question: "q?", teaser: "t", claims: [
      { text: "545,431 roads", app: Q, id: "q:1", quote: "545,431 road segments" },
      { text: "a million places", app: Q, id: "q:1", quote: "1,000,000 places" }, { text: "gone", app: Q, id: "q:404", quote: "x" }] },
    { ...env, record: async (app, id) => (app === Q.toLowerCase() && id === "q:1" ? { text: qrec, name: "quest", site: "https://q.test/" } : { error: "no such record" }) });
  const ac = a.record.payload.citations;
  assert(a.ready && ac[0].excerpt === "545,431 road segments" && ac[0].app.name === "quest" && ac[0].record_id === "q:1" && ac[0].url === appUrl(Q, "q:1"), "an app record's quote is kept: " + JSON.stringify(ac[0]));
  assert(ac[0].sha256 === (await sha256(qrec)) && a.record.payload.uncited_claims === 2, "hashed as served; a quote not in the record, and a missing record, are uncited");
  assert(a.problems.some((x) => /no such record/.test(x.message)) && a.record.payload.method.tools.length === 1, "a missing record is reported; get is in method.tools");
  assert(!(await draft({ publisher: pub, question: "q?", teaser: "t", claims: [{ text: "x", app: Q, id: "q:1", quote: "545,431" }] }, env)).record.payload.citations[0].excerpt, "no reader: unchecked");
  const m = await measure(p.citations, env), visibleText = "the fee is \"$0.001\" per settlement after 1,000 free.";
  assert(m === Math.round(visibleText.length / 4), "measure counts the visible text of quoted pages only: " + m);
  assert(await measure([{ url: "https://x.test/gone", excerpt: "z" }, { url: "https://x.test/a" }], env) === null, "nothing quoted and readable: unmeasured");
  assert(until("2026-10-26T00:00:00Z", "P2W") === "2026-11-09", "until");
  console.log("draft.mjs ok");
}
