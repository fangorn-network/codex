// codex's page tools for agents in a browser (WebMCP). Each calls the same Worker endpoint the
// page's own controls call, so an agent and a person get the same answer. Loaded by every codex
// page; site/agent.js registers them too, so the agent card lists them.
const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

export const codex = {
    check: (question) => fetch(`./api/check?q=${encodeURIComponent(question)}`).then((r) => r.json()),
    wiki: ({ topic, tag, id } = {}) => fetch(`./api/wiki?${new URLSearchParams(Object.entries({ topic, tag, id }).filter(([, v]) => v))}`).then((r) => r.json()),
    leaders: () => fetch("./api/leaders").then((r) => r.json()),
    graph: () => fetch("./api/graph").then((r) => r.json()),
    path: (from, to) => fetch(`./api/path?${new URLSearchParams({ from, to })}`).then((r) => r.json()),
    map: (q) => fetch(`./api/map${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.json()),
    draft: (args) => fetch("./api/draft", { method: "POST", body: JSON.stringify(args) }).then((r) => r.json()),
    join: (address) => fetch("./api/join", { method: "POST", body: JSON.stringify({ address }) }).then((r) => r.json()),
};

export function registerCodex(mc = globalThis.document?.modelContext) {
    if (!mc?.registerTool) return;   // most browsers have no WebMCP yet
    mc.registerTool({
        name: "check-codex",
        description: "Call first, before researching, with the question in plain words. verdict hit (use the finding: wiki-codex with its id), stale, near or miss; `where` names the topics it sits nearest. The Map page shows the same answer.",
        inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        execute: async ({ question }) => ok(await codex.check(question)),
    });
    mc.registerTool({
        name: "wiki-codex",
        description: "The Wiki page's data. No arguments: topics with counts. topic (from that list): its findings, newest first. id (a finding_id from check-codex or search): one finding in full, with claims and cited excerpts.",
        inputSchema: { type: "object", properties: { topic: { type: "string" }, id: { type: "string" } } },
        execute: async (args) => ok(await codex.wiki(args)),
    });
    mc.registerTool({
        name: "leaders-codex",
        description: "The Leaders page: publishers ranked by tokens their findings saved others (reads × cost_tokens), with findings, fresh findings and share of claims cited.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ok(await codex.leaders()),
    });
    mc.registerTool({
        name: "join-codex",
        description: "Become a codex publisher: accepts `address` (the wallet the publisher's fangorn CLI signs with). Ask the person first; they are responsible for what they publish. Returns how to publish.",
        inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, required: ["address"] },
        execute: async ({ address }) => ok(await codex.join(address)),
    });
    mc.registerTool({
        name: "draft-codex",
        description: "After researching: research in any form → a checked codex record. `text` (notes or a report, with the urls read and their exact words) or the fields, plus `publisher` (your wallet). Each cited page is fetched: a quote is kept only if it is on the page. Emails and phone numbers are removed unless allow_personal. Returns problems and records_json. Nothing is published.",
        inputSchema: { type: "object", properties: { publisher: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, text: { type: "string" }, allow_personal: { type: "boolean" } }, required: ["publisher", "text"] },
        execute: async (args) => ok(await codex.draft(args)),
    });
}

if (globalThis.document) registerCodex();
