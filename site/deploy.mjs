// Deploy codex's Worker (site/worker.mjs) over what `westmarch-ship app.json --no-deploy` built:
// the same .ship/wrangler.json and .ship/site, with the Worker swapped. The stock page moves to
// search.html (with pages/tools.js loaded on it) and pages/home.html becomes the front page.
//   node site/deploy.mjs [--dry-run]        (npm run ship does both steps)
import { readFileSync, writeFileSync, renameSync, copyFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";

const w = JSON.parse(readFileSync(".ship/wrangler.json", "utf8"));
w.main = new URL("./worker.mjs", import.meta.url).pathname;
writeFileSync(".ship/wrangler.codex.json", JSON.stringify(w, null, 1));

const index = ".ship/site/index.html", search = ".ship/site/search.html", tag = '<script type="module" src="./tools.js"></script>';
if (readFileSync(index, "utf8").includes("./assets/index-")) renameSync(index, search);   // fresh from ship: the stock page
let html = readFileSync(search, "utf8");
if (!html.includes(tag)) html = html.replace(/<html[^>]*>/i, (m) => `${m}\n${tag}`);
// codex's name goes to the front page on every page, as it does on codex's own.
writeFileSync(search, html.replace('id="home" href="#/"', 'id="home" href="./"'));
copyFileSync(".ship/site/home.html", index);
cpSync("skill", ".ship/site/skill", { recursive: true });   // the Claude Code skill, served for `curl` installs

execFileSync("npx", ["wrangler", "deploy", "--config", ".ship/wrangler.codex.json", ...(process.argv.includes("--dry-run") ? ["--dry-run"] : [])],
    { stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: w.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID } });
