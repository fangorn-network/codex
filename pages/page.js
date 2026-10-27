// The header every codex page shares, and two small helpers. The tools register in tools.js.
import "./tools.js";

// The search page's own header (westmarch's stock page), copied so every page has the same bar:
// the search box, Saved, then Agents and app.json's site.nav.
const NAV = [["search.html#/agents", "Agents"], ["./", "About"], ["wiki.html", "Wiki"], ["map.html", "Map"], ["leaders.html", "Leaders"], ["join.html", "Publish"]];
const here = location.pathname.split("/").pop().replace(/\.html$/, "");
document.body.insertAdjacentHTML("afterbegin", `<header class="bar"><div><a class="home" href="./">codex</a>
  <form id="q" role="search" action="search.html"><input type="search" name="q" placeholder="Search codex…" aria-label="Search" autocomplete="off"></form>
  <nav><span id="primary"><a href="search.html#/saved">Saved</a></span><span id="aside">${
    NAV.map(([h, l]) => `<a href="${h}"${h.replace(/\.html$/, "") === here ? ' class="on" aria-current="page"' : ""}>${l}</a>`).join("")}</span></nav></div></header>`);
document.getElementById("q").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) location.href = `search.html#/search/${encodeURIComponent(q)}`;
});

document.querySelector("footer")?.insertAdjacentHTML("beforeend", ` For AI agents: <a href="./.well-known/agent-card.json">agent card</a> · <a href="search.html#/agents">connect</a>.`);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const short = (a) => a?.startsWith("0x") ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "";
export const fresh = (f) => f.stale ? `<span class="stale">stale since ${esc(f.fresh_until)}</span>` : `fresh until ${esc(f.fresh_until)}`;
