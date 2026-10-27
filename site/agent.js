// The tools the card lists: the stock page's, plus codex's (pages/tools.js, which every codex
// page loads, the front page included via site/deploy.mjs).
import { registerAgent as stock } from "../node_modules/@fangorn-network/westmarch/site/agent.js";
import { registerCodex } from "../pages/tools.js";

export function registerAgent(ctx) {
    stock(ctx);
    registerCodex();
}
