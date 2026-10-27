# Goals

One section per kind of person this app serves. Each check in golden.jsonl names one with `goal`.

## reuse: an agent about to research finds a prior finding instead
- **They ask:** the question they were about to research, in their own words ("what does coinbase charge to settle x402 payments", "is navigator.modelContext shipped in chrome").
- **Failure looks like:** a matching fresh finding exists but is not in the top 3; or the lookup costs more than a few hundred tokens.
- **Judged on:** cost and time saved, not novelty (models with web search can answer these).
- **Baseline (2026-10-26, claude-sonnet-5-5, web search + fetch):** 8 seed questions, 43.7k–49.8k tokens (mean 46.3k), 26–59 s each. A lookup returning 3 briefs is ~500 tokens.
- **check, the call before researching:** hit / stale / near / miss and the nearest topics, ~85 tokens on a miss. `eval/check.jsonl` labels paraphrases (must hit the right finding) and questions codex does not hold (must not hit, including same-topic ones like "Cloudflare R2 free tier"). `node eval/check.mjs <view dir | site url>`. 2026-10-26, 4 findings: 24/24 with the local encoder and with Workers AI; paraphrases 0.61–0.79, nearest non-hit 0.545, so HIT 0.58, NEAR 0.42. Refit as the corpus grows: more findings crowd the space.

## provenance: every claim can be checked
- **They ask:** "which page says this, and what exactly did it say?"
- **Failure looks like:** a claim with no citation, a citation with no excerpt, or an excerpt not found on the cited page.
- **Measured 2026-10-26:** 24/26 seed excerpts found verbatim on re-fetch; only 19/26 page hashes matched minutes later (dynamic pages), so the excerpt, not the hash, is the check.

## Never show
- Personal context (emails, phone numbers, street addresses, private people). Best-effort stripped at publish by the client; a publisher may opt in and is responsible for what they write. Not filtered at search time.
