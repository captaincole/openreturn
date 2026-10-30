# Project OpenReturn — Claude Development Guide

## What this is

**OpenReturn** is an open-source AI tax platform: twin agents, Cade and Canon, that prepare your US federal and California return or estimate. Target user has W-2 income of $400k+/yr and $2–5M in investable assets, often with RSUs, K-1s, rental property, multi-state or foreign exposure, crypto, and meaningful charitable giving.

The twin agents:

- **Cade** — your CPA. The conversational front-desk agent: guides the user through the tax-prep flow, records facts and decisions, orchestrates workflows, narrates progress. First agent built.
- **Canon** — your tax attorney. Grounds Cade's decisions in the IRS/FTB reference corpus and answers tax-code questions with citations. Canon is its own Mastra project (`canon/`, port 4112) with an MCP server (`searchRefDocs`, `citeRefDoc`, `run_ask`, `run_ground`) and the reference-library routes. Cade reaches Canon only over MCP (`cade/src/mastra/canon/client.ts`); nothing in Cade imports Canon's code or opens corpus.db (`cade/tests/unit/boundary.test.ts`).
There is exactly **one** conversational agent (Cade). Grounding is NOT a conversation: every `record-ai-decision` triggers the background **review-decision workflow** (`workflows/reviewDecision/`), which hands the decision and its facts to Canon's `ground` workflow — deterministic gather/retrieval plus three narrow LLM "judges" (Canon's `workflows/ground/judges/`: queryFormulator, assessRiskAgent, ruleAgent on Haiku), looped up to `maxIterations` (default 3) inside Canon — and writes the verdict and the judges' step log back to app.db.

**Tax-code Q&A ("Ask The Tax Code")** is not a conversation either: each question runs a fixed pipeline (Canon's `workflows/ask/`: formulate → retrieve → answer → validate; Cade's `workflows/askTurn/` owns the thread rows and calls it) with two more judges (askQueryFormulator, askAnswerer). A "partial" answer names its gaps as search queries; the pipeline searches once more with them and answers again. Follow-ups pass the earlier turns as context; threads live in `ask_threads`/`ask_turns` in `app.db`, whose `log_json` is the query log. `validate.ts` drops any citation or quote that does not trace to a retrieved block. The Ask eval (`canon/evals/ask/`, report in `docs/evals/ask.md`) runs labeled questions through this pipeline and scores coverage, grounding, retrieval and the stated facts.

Note: the Unix working directory is still `project-merrilin` (the product's earliest name; later "Wheel of Time," then "Summa," now "OpenReturn"). The directory name was left alone to avoid churning local paths/configs. Internal names / IDs / docs use "openreturn" or "OpenReturn". The agent was "Luca" before it was Cade; old threads in mastra.db carry that id.

The end goal is a three-stage workflow:

1. **Gatherer** (Stage 1, where we are now) — Cade runs conversational intake that captures structured tax facts with citations and produces a live-updating case state (draft 1040, open asks, decisions).
2. **Summarizer** (Stage 2, not built yet) — turns gathered facts into a human-reviewable tax summary / organizer.
3. **Preparer** (Stage 3, not built yet) — fills out the actual forms (1040 + schedules, state returns). Human-in-the-loop is mandatory; a CPA signs off.

Everything routes through a `tax_facts` table (libsql/SQLite, `.data/app.db`) where each row has a `source_note` citing where the value came from. No fact exists without a citation.

## Repo structure

This is a monorepo. `canon`, `cade`, `engine`, `engine/builder` and `sources` are npm workspaces with one root lockfile; `web` installs on its own. Select the engine by name in npm commands (`npm -w @openreturn/engine`): `-w engine` also selects the nested builder. The layout is flat: each top-level folder builds and runs on its own.

```
canon/                           # @openreturn/canon — CANON, the tax attorney. Mastra project, port 4112.
├── src/db/                        corpus.db schema, store, files, hybrid search (corpusSearch.ts)
├── src/refdocs/                   reference-corpus ingest pipeline (parse, contextualize, embed)
├── src/mastra/                    index.ts (instance), mcp.ts (MCP server), tools/refDocs.ts,
│                                  workflows/ask/ (Ask The Tax Code), workflows/ground/ (judges,
│                                  prompts, schemas), server/routes/refdocs.ts (the library)
├── scripts/corpus/                the `corpus` CLI (npm run corpus)
├── seed/corpus.manifest.json      the prebuilt corpus.db release pointer
├── evals/                         model evals of Canon's pipelines (review = ground, ask); the
│                                  reports land in docs/evals with Cade's ingest eval
├── tests/unit/                    refdocs, search, ask validation, ground loop, boundary.test.ts
│                                  (no Cade, no app.db, no engine imports)
└── .data/                         corpus.db + mastra.db (gitignored)
engine/                          # @openreturn/engine — THE FORM ENGINE. Pure, deterministic, no AI/DB/network.
├── src/                           Owns the fact vocabulary (facts/), per-jurisdiction form
│                                  registries (federal/, state/ca/; each form's catalog.json sits
│                                  next to its bindings.ts), worksheets, PDF fill.
│                                  Boundary enforced by tests/unit/boundary.test.ts.
├── tests/                       # the engine's test pyramid: unit/, integration/, golden/, scenarios/
├── scripts/                     # renderScenario, lockScenario, compareFiled
├── paths.ts                     # on-disk locations for offline tooling
├── README.md                    # contributor guide; public API = package.json "exports"
└── builder/                     # @openreturn/builder — dev-time tools that build the engine's assets:
                                   the `form-engine` CLI (scripts/formEngine/) and the forms pipeline
                                   (src/: widget extraction, AI labeling, bindings drafts, tax-table
                                   parsers). Calls Anthropic; searches Canon over MCP (src/canonSearch.ts).
                                   Its own env files (below). Never runs in production.
sources/                         # @openreturn/sources — data only: what the IRS/FTB publish, by tax year.
                                   <year>/forms/federal/<short>/ and <year>/forms/state/<st>/<short>/
                                   hold blank.pdf, the instructions sidecar (instructions.meta.json)
                                   and tax-table sources; <year>/publications/{federal,state/<st>}/<pub>/
                                   holds publication.meta.json. The instruction and publication files
                                   (PDFs, or cleaned FTB web pages) are not committed: corpus.db
                                   stores them. Files we generate
                                   (catalogs, tax-table JSON) live with the engine.
cade/                            # @openreturn/cade — CADE, the AI CPA. Mastra project, port 4111 → Vercel.
├── src/mastra/                  # agent code (Cade, tools, db, server, workflows); canon/client.ts is
│                                  the MCP client, the only path to Canon.
│                                  loadScenario.ts is the one db↔engine bridge; formAssets.ts loads
│                                  blank PDFs from public/sources/<year>/forms/ (gitignored, built
│                                  by `npm --prefix cade run sources:sync` before dev/build).
├── scripts/                     # standalone diagnostics (doctor, smokeReview, inspectLastReview)
│                                  and syncSources (the runtime copy of the blank PDFs)
├── evals/                       # the ingest eval; review and ask evals are Canon's (canon/evals)
├── tests/                       # agent tests (tools, db, boundary); corpus tests are in canon/, engine tests in engine
├── package.json                 # agent deps + scripts (mastra dev, sources:sync)
└── tsconfig.json                # "paths" aliases @openreturn/engine to source so `mastra dev` bundles it
web/                             # Next.js 16 (App Router) frontend → deployed to Vercel
├── app/                         # /setup, /login, (app)/{page (home), r/[returnId], ask/[threadId],
│                                  library, library/[docId]}, /documents/[id] + /api/* route handlers
├── components/                  # AppShell, ChatPane, ActivityCard, PlanCard, TopBar, Markdown
├── lib/                         # localAuth, serverDb, api, ask, activity, mastraClient, uploads, …
├── e2e/                         # Playwright E2E: drives web + Cade + Canon + a real model (npm run e2e)
├── proxy.ts                     # Next.js 16 Proxy (renamed Middleware): optimistic session-cookie gate
├── package.json                 # web deps + scripts (next dev, next build, e2e)
└── next.config.ts

(no other top-level infra — auth is a password gate in the web app; see below)
package.json                     # workspace root: workspaces + thin delegating scripts (dev, dev:all, test, …)
CLAUDE.md
```

The agent uses the engine only through `@openreturn/engine`'s exports. The web app shares no source with either.

## Running it

Three services: Canon (:4112), Cade (:4111) and the web app (:3000). Run all three — backend changes hot-reload via Mastra file-watching, frontend changes HMR via Next.js (Turbopack). All commands run from the repo root; root scripts delegate via `npm --prefix <folder>` (`canon`, `cade`, `web`).

```bash
npm run install:all                         # installs the workspaces (root) + web
npm run dev:all                             # canon (:4112) + cade (:4111) + next (:3000) — that's everything

# or run them separately:
npm run dev:canon    # Canon only — Mastra Studio at :4112, MCP at /api/mcp/canon/mcp
npm run dev          # Cade only — also opens Mastra Studio at :4111
npm run dev:web      # next only

npm test             # engine golden suite; positional filters work (npm test -- alex)
npm run test:unit    # engine + canon + agent unit tests (test:integration likewise)
npm run typecheck    # tsc over engine + builder + canon + agent
npm run e2e          # Playwright E2E through the UI + real model (stop dev:all first; see web/e2e/README.md)
```

All persistent state lives in local files: user data under `cade/.data/`, the corpus under `canon/.data/` ("the DB is a file"):

| file | contents | owner |
| --- | --- | --- |
| `corpus.db` | reference corpus (ref_* tables, FTS5 + vectors); lives in `canon/.data/` | `canon/src/db/libsql.ts` |
| `app.db` | domain data (tax_facts, ai_decisions, filings, ask_threads/ask_turns, …) | `db/appDb.ts` |
| `mastra.db` | Mastra runtime (threads, messages, working memory) | `@mastra/libsql` |
| `documents/` | document blobs `{filingId}/{category}/{slug}-{ulid}.{ext}` | `db/blobStore.ts` |

Pin all four paths via env (`CORPUS_DB_PATH` in Canon's env file; `APP_DB_PATH` / `MASTRA_DB_PATH` / `DOCUMENTS_PATH` in Cade's) — module-relative defaults resolve differently inside Mastra's bundled output than in tsx scripts. Cade finds Canon at `CANON_URL` (default `http://127.0.0.1:4112`).

**Env files, the same in every package** (`canon/`, `cade/`, `web/`, `engine/builder/`): `.env.example` (committed) lists every setting; `.env.development` (gitignored) is written on first run by `scripts/bootstrap-env.mjs` and is the file `mastra dev` reads; a gitignored `.env` holds personal overrides. The CLIs (`corpus`, `form-engine`, `doctor`) load `.env` first, then `.env.development` (dotenv never overrides a set key). They load them after their imports run, so read env at call time, not in a module-level constant. There are **no external services**: no Docker, no Postgres, no Supabase.

**Auth (single-user):** identity = the instance. One `owner` row in `app.db` holds profile data (name/email) plus an scrypt password hash and the session-cookie HMAC secret — all created by the web app's first-run `/setup` screen. Login = one password → signed httpOnly cookie (`lib/localAuth.ts`, ~100 lines, node:crypto only). `proxy.ts` does an optimistic cookie-presence redirect; layouts/route handlers verify for real via `getOwnerSession()`.

**The browser never talks to the agent.** All agent calls (chat streaming, `/app/state`, filing lifecycle, thread history) go through the same-origin `/api/agent/[...path]` proxy — session-cookie authenticated, forwarded server-side to `AGENT_INTERNAL_URL` (default `http://127.0.0.1:4111`), streaming passed through. The agent itself has no user auth; `ownerMiddleware` resolves the instance owner from `app.db` for memory scoping, and an optional `AGENT_API_TOKEN` gates the port when it's reachable beyond localhost. Everything non-agent — activity, drafts, uploads, filings lists — is read from `app.db` directly: Server Components via `lib/serverDb.ts`, browser code via the `/api/*` Route Handlers (no realtime channel — client components poll on a short interval). With RLS gone, **every query scopes explicitly** by `userId`/`filingId` (`Scope` in `db/appDb.ts`), and routes gate with membership checks before touching another filing's data. Reference-library calls (`/library`, Open PDF) go through a second proxy, `/api/canon/[...path]`, to Canon at `CANON_INTERNAL_URL` (default `http://127.0.0.1:4112`); it is read-only and gated by the same session cookie.

## First run / factory reset

`npm run reset` wipes user data (app.db, mastra.db, documents/, and Canon's mastra.db, whose ground-run snapshots carry the facts Cade sent) while **preserving corpus.db** (rebuilding it costs Haiku money for contextualization). After a reset, the web app redirects to `/setup` — create the owner account (name, email, password) — then start a filing from the home page. No seed scripts, no test users; the setup screen IS the seeding.

## Development workflow

We're building agent + UI together. When changes touch both, expect to:

1. **Edit code** (backend in `cade/src/mastra/`, frontend in `web/{app,components,lib}/`).
2. **Watch logs** for errors. Three places to look:
   - **Mastra log** — backend errors, agent traces, tool-call output. When Claude runs mastra in the background it writes to that background task's output file; otherwise it's whatever terminal you started `npm run dev` in.
   - **Mastra Studio** at http://localhost:4111 (Canon's at :4112) — the **Observability** tab shows full agent traces (which tools fired, with what args, in what order). This is the right place to debug "why did Cade do X?".
   - **Browser console + Network panel** — frontend errors and HTTP failures (401s from a wrong passcode, 404s from a missing proxy entry, etc.).
3. **Verify the change in the browser** at http://localhost:3000. Sign in with the owner password (session cookie persists across reloads). To wipe state between test runs use **Delete filing** (avatar menu, top-right) and start a fresh filing from the home page. The activity rail and header counters refresh after each agent turn (plus a short client-side poll).

For backend-only changes you don't always need to open the browser — `curl` against `http://localhost:4111/app/state` (or `/api/agents/cade/stream`) with `Authorization: Bearer <DEMO_PASSCODE>` is faster.

### Claude verifies UI changes via claude-in-chrome

Claude has the `mcp__claude-in-chrome__*` toolset available. After any non-trivial UI change, use it to drive the browser yourself: navigate to `:3000`, log in, exercise the affected flow, read the console for errors, and report what you observed. This is faster and more reliable than asking Andrew to manually test every iteration. For multi-step interactions worth reviewing later, use `gif_creator` to record the run.

Limits worth remembering:
- These tools are deferred — load each one with `ToolSearch` (`select:mcp__claude-in-chrome__<name>`) before calling it.
- Avoid triggering `alert()` / `confirm()` / `prompt()` dialogs — they freeze the extension. The Delete-filing button uses `confirm()`; if you need to test it programmatically, dispatch the click in the codepath that bypasses the confirm or temporarily comment it out.
- If a browser tool errors twice in a row, stop and ask Andrew rather than retrying blindly.

### Claude verifies the whole stack with `npm run e2e`

After a change to the web app, the agent tools, or document generation, run `npm run e2e` in the background (a few minutes; the models come from `cade/.env.development` (Canon's from `canon/.env.development`) and optional `E2E_*` lines in the gitignored `cade/.env`, see web/e2e/README.md). Read `web/e2e/.run/<runId>/summary.md`. A `plumbing` failure means the change probably broke the app. A `model` failure can be a model mistake: run again before you debug. `dev:all` must be stopped first.

### Resetting user data

Two paths:
- **UI: Delete filing** (avatar menu) → `DELETE /app/filings/:id` — removes the filing's blob directory, cascades every domain row, deletes the Mastra thread. Start a fresh filing from the home page afterwards.
- **API: `POST /app/session/reset`** → `resetCurrentUserData` in `cade/src/mastra/db/resetUserData.ts` — wipes the user's rows but keeps the filing + memberships. No UI button anymore.

**Reference corpus and `sources/` always survive.** To rebuild the corpus, delete `canon/.data/corpus.db` and run `npm run corpus -- sync` (or `npm run corpus -- fetch` for the prebuilt release). To nuke everything, delete both `.data/` directories (`cade/`, `canon/`) and re-run `npm run reset`.

## Mastra schema

The runtime store is `@mastra/libsql` (see `server/storage.ts`). Cade's `Memory` has no storage of its own: Mastra hands it the instance store, so threads and messages share `mastra.db` with the workflow snapshots. Mastra runs its own idempotent `init()` on boot — a handful of local `CREATE TABLE IF NOT EXISTS` statements, cheap enough that the old `disableInit` + standalone-migration machinery is gone. On `@mastra/*` version bumps, the framework migrates its own schema; keep `mastra.db` separate from `app.db` so that can never touch user data.

## Data-model iteration: wipe + re-ingest, not migrations

While the data model is in flux, breaking schema changes are handled by **wiping and re-seeding**, not by migrations or backfill scripts: edit the `CREATE TABLE` statements in `db/appDb.ts` (or `canon/src/db/libsql.ts` for the corpus), delete the affected `.data/*.db` file, and re-run `npm run reset` / `npm run corpus -- sync`. Delete-filing + fixture-driven re-ingest restores a known-good user state.

There is no migration system for the libsql files — dev/test data only. That changes when real users have data worth preserving (revisit in Phase 4 packaging).

## Form engine — the FormField model

Every output form (1040, 540, 8949, Schedule D, …) is a collection of typed **FormField**s. A FormField is the unified abstraction over every inputable value on the form — numeric lines, single-select checkboxes, text fields (name, address), boolean checkboxes, date fields. All share `BaseFormField` (`fieldId`, `label`, `category`, `valueType`, `result`).

**Two required properties every new field must declare:**

- **`category: Category`** — which Filing Status panel bucket the field rolls up into. One of `personal_info | filing_scope | income | deductions_credits | other`.
- **`valueType: FieldValueType`** — shape of the field's value. One of `numeric | single_select | text | boolean | date`.

TypeScript enforces both. Adding a field without declaring them is a compile error — the categorization layer (`engine/src/categorization/categorize.ts`) is automatically consistent because it reads `field.category` directly off each field.

**When adding a new form**: follow the checklist in `engine/README.md` — form folder under the jurisdiction (`src/federal/<short>/` or `src/state/<st>/<short>/`, with its `catalog.json`), one `makeFormSpec` entry in that jurisdiction's `index.ts`, source documents in `sources/<year>/forms/<same subpath>/`. TypeScript will fail to compile until every field has its `category` and `valueType`.

**Header fields** (top-of-form personal info, filing-status checkboxes) are modeled as FormFields too — text/single-select kinds that derive from identity facts / scope decisions. They sit in the same `EvaluatedForm.fields` array as the numeric lines. PDF renderers continue to read raw facts directly; the header fields exist for the Filing Status panel rollup.

### Whole-dollar rounding convention — nearest dollar

Tax-form lines take whole dollars, rounded to the **nearest** dollar with `roundDollars()` in `engine/src/money.ts` (decided 2026-10-16). `money.ts` is the one module for engine money math: `sum`, `atLeast`, `roundDollars`, `stepsOf`, `formatDollars`, and the `Money` brand. Lint bans `Math.round` / `ceil` / `floor` / `trunc`, `toFixed`, and `toLocaleString` elsewhere in the engine's `src/`. The IRS rule (1040 instructions, "Rounding Off to Whole Dollars"): drop amounts under 50 cents, raise 50–99 cents to the next dollar.

- **Document sums** keep the cents while adding and round only the total (IRS: "include cents when adding the amounts and round off only the total"). Example: interest $9.59 + $2,287.09 = $2,296.68 → $2,297. Verified: Alejandro's CPA return, 1040 line 3a $381.40 → $381.
- **Calculated lines** (percentages, worksheet steps, rate-schedule tax) also round to nearest. Verified against a filed 2025 return (private comparison kit) and marcus's CPA (8959: 43,500 × 0.9% = 391.50 → 392; 243,500 × 1.45% = 3,530.75 → 3,531).
- **Exception — step rules:** "for each $2,500 **or part** of $2,500" (CA AGI limitation) rounds up by definition (`stepsOf()`, a ceiling on the step count). That is the rule itself, not dollar rounding.

Lines that the form defines as arithmetic on other lines use those lines' rounded values (Schedule D col (h) = rounded (d) − rounded (e)).

```ts
"line.3a": (_, info) => roundDollars(info.qualifiedDividends); // document sum
const line18 = roundDollars(line17 * 0.15);                     // calculated line
```

`roundDollars()` snaps to cents first, so a float sum like 202887.49999999997 does not round the wrong way. Tax-table lookups (`lookupTax`) already return whole dollars; rate-schedule lookups return un-rounded values for the caller to round.

**Preparers differ.** A CPA's 2024 QDCG worksheet rounded a 20% line up (x.20 → the next dollar). Marcus's CPA wrote 392 on 8959 line 7 but 391 on Schedule 2 line 11 (which should copy it). The engine follows the IRS rule. Don't use bare `Math.round` or `Math.ceil` on tax-form money (lint enforces this in the engine); record new evidence here.

## Vercel logs (production debugging)

Production runtime logs for the agent come through `vercel logs`, but with gotchas:

- **Run from `cade/`** — the linked project's directory. From the repo root, the CLI uses the wheel-of-finances project context and returns nothing for the agent. `cade/.vercel/project.json` (gitignored) is what scopes the call.
- **`/health` bypasses user middleware.** Mastra special-cases its framework routes; a `/health` hit doesn't fire `server.middleware`, so it won't show your `console.log` lines. Test logging via `/api/*` or `/app/*` instead.
- **We don't use Mastra's `PinoLogger`** — its default destination is async-buffered and gets truncated on Vercel function exit, swallowing every log line on requests that error. We ship `ConsoleLogger` (`cade/src/mastra/server/consoleLogger.ts`) instead — a ~70-line `MastraLogger` subclass that writes single-line JSON via `console.{log,warn,error}`. `vercel logs --json` parses each line into its structured fields. Use `mastra.getLogger()` (or `logger.error("msg", { err })`) anywhere new error paths land; no need for ad-hoc `console.log`.
- **Useful flags:** `--since 30m --limit 30 --expand` (historical), `--follow` (live tail), `--json` (richer per-request record incl. `responseStatusCode`, `cache`, structured `logs` array). No duration field — log timings yourself in middleware if needed.
- **Build logs (separate from runtime):** `vercel inspect <deployment-url> --logs`.

## Design principles

- **Never invent a number.** If the taxpayer isn't sure, the agent records an open question, not a guess. This is enforced in the system prompt and should be enforced in prompt tests once we have them.
- **Every fact has a citation.** The `source_note` field is required — document source, statement line number, or "verbal, date".
- **Document minimalism — only ask for load-bearing forms.** Getting a form is expensive user labor (dig through email, HR portal, physical mail). The default is verbal confirmation; we escalate to "please upload X" only when (a) the form is required to compute or file the return, or (b) a fact on the form can't be reliably obtained another way. Example: don't ask for Form 1095-C if the only fact we need is "had coverage all year" — a yes/no scoping question gets it faster. Example: W-2 box 12 code D already proves 401(k) contribution, so we don't also ask for Form 5498.
- **Bottom-up derivation, not top-down guessing.** The case engine computes state (draft 1040, scoping decisions, open asks) from facts via a graph of typed pure-function derivations. Cade *reads* the computed state to decide what to ask next; he doesn't invent scope or asks on his own.
- **Reactive, not batch.** Every fact write triggers downstream re-derivation. At any turn, the draft 1040, open-asks list, and decisions reflect everything known so far. Observable at every step.
- **Stage boundaries are hard.** Stage 1 (Gatherer) doesn't compute tax owed, suggest strategies, or fill forms. Cross-stage leakage is a bug.
- **Human in the loop.** Stage 3 requires CPA sign-off before anything ships. The preparer will probably use Opus for accuracy over cost.
- **Suggest the manual edit when it's faster.** If a task can be done in 10 seconds by Andrew opening a file and changing one line — `.env`, a constant, a feature-flag default — say so up-front instead of writing scripts, chained env loaders, or dotenv-cli wrappers to do it programmatically. Reach for tooling only when the change is repeated, conditional, or part of an automated flow.

## Facts vs. AI decisions (two-phase reasoning)

The system separates two kinds of data:

- **Tax facts** (`tax_facts` table) — things the taxpayer stated directly. Raw, verbatim. Written by `record-tax-facts` / `ingest-w2-structured`.
- **AI decisions** (`ai_decisions` table) — judgment calls the agent made when facts were ambiguous or underdetermined. Every decision carries: `decisionKey`, `decision`, `rationale` (the agent's plain-English "why"), `supportingFactKeys[]` (which facts it used), `confidence` (low/medium/high), and `dissentingConsiderations` (what could make it wrong). Written by `record-ai-decision`.

Decisions flow back into the case engine: a decision with key `decisions.ca_residency` becomes a fact-like input that downstream derivations can consume. This means "is this person a full-year CA resident?" can be the output of AI reasoning, and the CA 540 scoping derivation reads it like any other fact.

**Two-phase pattern — decide, then ground in the background.** Every `record-ai-decision` call returns immediately with `verdict: 'pending'` and fires the review-decision workflow, which grounds the decision against the supporting facts + the IRS reference corpus and re-stamps the row: `accurate` / `inaccurate` / `needs_more_facts` / `review_failed` / `review_unreached` (Canon never got the call; retried later). Legacy rows may carry `ungroundable`. `authority_citations` populates with `{blockId, quote?}[]` on `accurate`. Non-accurate verdicts also write an `open_questions` row so Cade circles back with the user. See the "Reference-document RAG" section for the corpus and retrieval pipeline.

## Tax facts schema

`tax_facts` rows are keyed by `(taxpayer_id, year, category, fact_key)` in spirit — we don't enforce uniqueness yet because we want an append-only audit log of what was told to us and when.

Categories (see `cade/src/mastra/tools/taxFacts.ts` for the enum):
`identity`, `filing_status`, `dependents`, `wages`, `self_employment`, `k1`, `investment_income`, `capital_gains`, `rental`, `retirement`, `hsa`, `charitable`, `mortgage`, `state_local_tax`, `medical`, `education`, `estimated_payments`, `crypto`, `foreign`, `trust_estate`, `other`.

Add categories as the domain grows. Prefer splitting over lumping (it's easier to roll up later than to untangle a bucket).

## Reference-document RAG and the grounding workflow

### Where the corpus lives

The reference corpus (IRS/FTB form instructions and publications) lives in **`canon/.data/corpus.db`** — a local libsql/SQLite file, separate from user data (`app.db`) because it's shared, read-mostly reference material that will ship prebuilt as a release asset (Phase 4). Client + schema live in `canon/src/db/libsql.ts`. (The forms catalog tables are gone: the catalog is engine output, written as catalog.json by the forms pipeline.)

### Corpus shape (libsql)

```
ref_documents → ref_pages    (page char-ranges into canonical_text)
              → ref_sections (heading hierarchy with stable slugs)
              → ref_blocks   (paragraph/list_item/etc — the citable unit)
                  + embedding          — F32_BLOB (libsql native; 768-dim
                                         embeddinggemma-2 via local Ollama)
ref_blocks_fts                (FTS5 mirror of coalesce(contextualized_text, text),
                               porter stemming; populated at write time)
ref_meta                      (key/value; embedding_model = which model built the
                               stored vectors — search refuses to mix models)
```

Stable IDs — used everywhere as citations:
- `irs-1040-inst-2025` (doc)
- `irs-1040-inst-2025::sec::single` (section)
- `irs-1040-inst-2025::sec::single::b01` (block — section-anchored: the 1st block under that heading; a parser change elsewhere in the doc does not renumber it)

**corpus.db is the library.** It holds every document's text, sections, blocks, embeddings, and its source file (`ref_document_files`): a PDF's bytes, or a cleaned web page as UTF-8. `ref_documents.format` (`pdf` | `html`) says which; the reference library's "Open PDF" serves PDFs from there, and its `/library/<docId>` page renders HTML documents (styled by `.ref-doc` in `web/app/globals.css`). Git holds only the sidecars, each with the source file's `sha256`: the source files and the extracted `*.canonical.txt` text are gitignored build files, written next to the sidecar when sync ingests.

**FTB instructions are HTML when FTB has a page.** FTB publishes most instructions only as web pages. `refdocs/html/cleanFtb.ts` keeps the page's article (allowlisted tags, every heading's id = its section slug, images inlined), and `refdocs/html/parseHtml.ts` reads sections from `h2`–`h4` and blocks from whole elements; a table row carries its column headers. An HTML document has no pages (all page 1): citations show `§ Section`, and open the library page at `#<slug>`. The sha256 covers the cleaned output (the raw page differs on every request); bump `CLEANER_VERSION` when the cleaner's output changes. Use the PDF when FTB has no page (3514, 3526, the FTB publications).

### Adding or updating a reference document

Each form's instructions are described by `sources/<year>/forms/<jurisdiction>/<short>/instructions.meta.json`. Publications (IRS/FTB guides to a topic across forms) are described by `sources/<year>/publications/<jurisdiction>/<pub>/publication.meta.json`, and their docIds start `irs-pub-` / `ftb-pub-`. The sidecar names the source file by `sourceUrl` and `sha256` (plus `"format": "html"` for a web page); only the sidecar is committed:

```json
{
  "docId": "irs-1040-inst-2025",
  "title": "Instructions for Form 1040 (2025)",
  "publisher": "IRS",
  "taxYear": 2025,
  "sourceUrl": "https://www.irs.gov/pub/irs-pdf/i1040gi.pdf",
  "sha256": "<sha256 of the PDF>"
}
```

When sync needs a source file that is not on disk, it takes it from corpus.db (every ingested file is stored there), else downloads `sourceUrl` (and cleans it, for HTML) and checks `sha256`. Publishers replace files at the same URL with new editions, so the stored copy is what keeps re-ingests working; a mismatch error names the fix (`canon/src/refdocs/fetchSource.ts`).

Each document has a publication date (`ref_documents.published`, `refdocs/published.ts`). The Ask answerer sees it in each passage header and prefers the newer document when two passages disagree; the library shows it. A PDF's date is its creation date, read at ingest; a sidecar's optional `"published": "YYYY-MM[-DD]"` overrides it (set it when the PDF's metadata is older than its revision, e.g. 3921 "Rev. April 2025"). `add-html` records an FTB page's "Revised" date; FTB's tax-year pages show none, so they have no date.

Operator flow (the `corpus` CLI — `npm run corpus` with no args lists all subcommands, `-- <cmd> --help` shows options):

```bash
# 1. Download the PDF and write its sidecar (docId, title, publisher, taxYear, sourceUrl,
#    sha256) as instructions.meta.json in sources/<year>/forms/<jurisdiction>/<short>/,
#    or publication.meta.json in sources/<year>/publications/<jurisdiction>/<pub>/.
#    Leave the PDF beside it; it is gitignored. For an FTB web page instead:
npm run corpus -- add-html <url> --dir 2025/forms/state/ca/540 --doc-id ca-540-inst-2025
# 2. See what's drifted vs the corpus DB:
npm run corpus -- status            # diff: present / missing / sha-drift / extra / unconfigured / no source
npm run corpus -- status --strict   # exit non-zero on any drift (for CI/pre-push later)

# 3. Sync changes into corpus.db (idempotent, sha-skips already-ingested docs):
npm run corpus -- sync              # ~$0.50 + a few min per new/changed doc

# 3b. Publish: corpus.db is a GitHub Release asset (canon/seed/corpus.manifest.json);
#     a new release is how other clones get the new documents.

# 4. If a previous sync wrote rows but embeddings failed (Ollama down),
#    re-embed without re-paying for Haiku contextualization:
npm run corpus -- reembed
#    After switching EMBEDDINGS_MODEL (or fetching a corpus built with a
#    different model), rebuild every vector:
npm run corpus -- reembed --all
```

Cost: ~$0.50 Haiku contextualization per doc; embeddings are local and free (EmbeddingGemma 2 via Ollama). Sha-skip means re-runs are free.

### Ingest pipeline

```
sidecar sha256 (compare to ref_documents.sha256 — skip if match)
    → ensureSourceFile (disk, else corpus.db, else sourceUrl; sha256 checked)
    → PDF:  unpdf extractText (per-page text)
            → parseDoc (heading detection → Document/Section/Block tree, stable IDs)
      HTML: parseHtmlDoc (h2–h4 sections, element blocks, one page)
    → contextualize (Haiku per block, section-scoped prompt cache)
    → writeDocument (insert rows + format, embedding=NULL) + setDocumentSource (ref_document_files)
    → embed (embeddinggemma-2 via Ollama /api/embed, batches of 32, task prefixes)
    → setBlockEmbeddings (batched UPDATEs + ref_meta.embedding_model stamp)
```

We write the rows BEFORE embedding so an embed failure (Ollama down) doesn't waste the ~$0.50 of Haiku contextualization — that's what `corpus reembed` recovers from. `block_text_sha1` column is in place for future "skip re-summarize when text unchanged" optimization (not yet wired).

### Retrieval — `search-ref-docs` tool

Single entry point. `callMatch` in `canon/src/db/corpusSearch.ts` (the TS port of the old Postgres `match_ref_blocks` function) runs two legs and merges in JS: top-N from the FTS5 leg (`MATCH` + bm25, negated to higher-is-better) unioned with top-N from the vector leg (brute-force `vector_distance_cos` — exact and fast at low-thousands of blocks; no ANN index on purpose). Final ordering is reciprocal rank fusion: each leg ranks its own hits, and a block scores `1/(60 + rank)` from each leg that found it, so the legs count equally and bm25 is never compared with cosine (a max() of raw scores once let any keyword hit outrank every vector-only hit). Query embedding comes from the local model via `src/refdocs/embeddings.ts` (`EMBEDDINGS_MODEL`, default `ollama/embeddinggemma-2`).

```
query
 → embedQuery (local Ollama) ┐
 → callMatch ─┬─ FTS5 top-50 (bm25 over ref_blocks_fts)          ┐
              └─ vector top-50 (vector_distance_cos over blocks) ┘ → rank fusion (RRF) → top-K
```

Falls back gracefully to keyword-only (searching always works; semantic quality is what degrades):
- Ollama down / model not pulled → FTS-only with a warning
- `ref_meta.embedding_model` ≠ active model (e.g. prebuilt corpus from another model) → FTS-only with a warning; fix with `npm run corpus -- reembed --all`

`mode` parameter (`fts` | `vector` | `hybrid`, default hybrid) lets evals A/B specific legs.

### The reviewDecision workflow

`cade/src/mastra/workflows/reviewDecision/` — fired in the background by `record-ai-decision` (fire-and-forget; the tool returns `pending` immediately). Shape: `init → ground → finalize`, driven by `reviewDecision(scope, decisionId)`. The judges run in Canon: `ground` is one MCP call (`run_ground`) that loops `(gather → assess → rule) × ≤maxIterations` (default 3; a parameter of the call) in `canon/src/mastra/workflows/ground/`.

- **init** (Cade) — loads the decision and the facts it cites from app.db, opens the `review_runs` row.
- **gather** (Canon, deterministic) — runs hybrid retrieval per query (queries from the `queryFormulator` judge on iteration 1, from the rule step's `suggestedQueries` after).
- **assess / rule** (Canon's LLM judges, `workflows/ground/judges/` — Haiku, structured output) — risk tier, then verdict-or-loop. Each judge is one model call with its output schema as the response format (`canon/src/mastra/judge.ts`), no tools. The hard rule — never cite a `blockId` that wasn't retrieved in this run, and quote it word for word — is enforced in code after the rule call (`ground/validateCitations.ts`).
- **finalize** (Cade) — persists verdict + citations; `needs_more_facts`/`inaccurate` also write an `open_questions` row. Canon's step log is written to `review_run_steps` by the ground step, one row per judge step.
- **Reviews run one at a time** (the queue in `reviewDecision/index.ts`): the judges share one model, so parallel reviews only slow each other down and time out together (the MCP call's cap is `CANON_TIMEOUT_MS`, default 5 min; a ground call that needs longer means fewer iterations — `CANON_GROUND_MAX_ITERATIONS`, which the e2e pins to 1 — or a faster judge, never a longer cap).
- **When Canon is down**, the decision is stamped `review_unreached` (not `review_failed`): the judges never ran. No scheduler — the next `record-ai-decision` queues every unreached review after its own, and `POST /app/filings/:filingId/reviews/retry` does it on demand.
- Shared CPA heuristics both judges import live in Canon's `workflows/ground/judges/cpaRules.ts` — rules accumulate there as CPAs flag edge cases.
- Every step logs to `review_run_steps` (raw input/output JSON — future fine-tuning substrate). `npm run smoke:review` is the end-to-end test (3 cases, temp DB, real calls to Canon's judge model; needs Canon running, skips when it is not).

### Operator CLIs and inspection scripts

Canon's corpus CLI lives under `canon/scripts/corpus/`, the form-engine CLI under `engine/builder/scripts/formEngine/`, Cade's tooling under `cade/scripts/`, engine scripts under `engine/scripts/`. Two subcommand CLIs (each package has its own copy of the small dispatcher, `scripts/lib/cli.ts` — no args lists subcommands, `-- <cmd> --help` shows options) plus standalone diagnostics. All run from the repo root; `--` passes args through both npm layers.

**`npm run corpus`** — the RAG knowledge base, end to end:

| subcommand | use |
|---|---|
| `fetch` | install the prebuilt corpus.db (local seed or sha-verified release download) |
| `sync` | idempotent corpus sync from the `sources/**/{instructions,publication}.meta.json` sidecars; fetches source files as needed |
| `add-html <url> --dir …` | fetch + clean a publisher web page into a sources folder (HTML file + sidecar); re-run to refresh the sha256 |
| `status [--strict]` | diff repo sidecars vs corpus.db (no source file needed) |
| `ingest` | manual single-doc ingest (any PDF or HTML path; debug flags) |
| `reembed [--all]` | re-embed NULL blocks; `--all` after a model switch |
| `check` | row counts + per-doc embedding coverage |
| `search "q" [--mode …]` | invoke the production search tool |

**`npm run form-engine`** — source documents (`sources`) → engine assets (`engine/src`): `generate-catalog`, `generate-bindings`, `generate-types`, `ingest-federal-tax-table`, `ingest-ca-tax-table`. It is the builder's CLI (`engine/builder/`): put `ANTHROPIC_API_KEY` in `engine/builder/.env.development` for the two AI commands, and run Canon (`npm run dev:canon`) for `generate-bindings`.

**Standalone diagnostics** (run via `npx tsx` from `cade/`):

| script | use |
|---|---|
| `smokeReview.ts` | three end-to-end review scenarios (npm: `smoke:review`; needs `npm run dev:canon`) |
| `inspectLastReview.ts` | dump most recent review-decision workflow run + trace |

**Engine scripts** (run via `npx tsx` from `engine/`):

| script | use |
|---|---|
| `renderScenario.ts` | render every form in a scenario to PDF for spot-checking |
| `lockScenario.ts --scenario=<name>` | rewrite a scenario's `expected.ts` engineFields from the engine's output — only after the output is verified (jordan pattern, see docs/contributing.md); then `renderScenario.ts --scenario=<name> --golden` rewrites its golden PDFs |
| `compareFiled/cli.ts <folder>` | private comparison kit: engine vs a real filed return (scenario format, kept outside the repo); writes a no-amounts report with root causes for the checker to send to a maintainer |

### Lessons from this build (read before changing the pipeline)

- **No judge gets a tool or a second structuring pass.** The first reviewer was one critic agent with search tools; a model cannot combine tool calls with native structured output, so a second model pass turned her prose into JSON (`structuredOutput.model`). The three-judge split kept that pass, and on Haiku it cost a second. On a local 31b each pass cost 25–60 s (more than the judging) and once looped for 12 minutes on four repeating tokens. Since 2026-10-24 every judge is one `generate` with the schema as response format (`canon/src/mastra/judge.ts`), and the rule judge's quote check is code (`validateCitations.ts`). If a judge ever needs a tool again, run the tool deterministically in the workflow step and hand the result to the prompt; don't bring the structurer back.
- **The cookbook's "send the whole document" doesn't fit big tax docs.** 1040 instructions alone are ~211k tokens — over Haiku's 200k. We use **section-scoped context** for contextual summarization: each block is summarized with its section text as the cached prefix. Same caching benefit (cache hits across blocks within a section), no doc-size ceiling.
- **Embedding models need their documented task prefixes.** EmbeddingGemma expects `task: search result | query: …` for queries and `title: none | text: …` for documents (applied in `src/refdocs/embeddings.ts`); skipping them silently degrades retrieval precision. When swapping embedding models, read the model card for its prompt convention — and remember vectors from different models (or dims) are never comparable, which is why `ref_meta.embedding_model` gates the vector leg.
- **Vector literals serialize as strings, not arrays.** `vectorLiteral([1,2,3])` returns `"[1,2,3]"` — that string feeds libsql's `vector32()`. Passing a JS array silently fails or coerces. (SQLite doesn't enforce the declared `F32_BLOB` dim — only query-vs-stored dim equality matters at distance time.)
- **Diagnose retrieval failures bottom-up.** Order: parser → FTS index → embeddings → merge ordering → agent prompt. Don't blame the corpus first. Our headline parsing failure was attributing the `§ Single` block to `(Preamble)`, not a corpus or retrieval gap. Verify section attribution by querying `ref_blocks` directly before tuning retrieval.
- **Heading detection needs both regex and named prose.** `Line Nx`, `Part N`, `Schedule N` come from regex. Standalone Title Case headings like `Single`, `Married Filing Jointly`, `Head of Household` need an explicit `KNOWN_PROSE_HEADINGS` set in `canon/src/refdocs/parse.ts`. Title-case continuation rule absorbs multi-line headings (`Qualifying Surviving` + `Spouse`). Since 2026-10-15 the parser also detects run-in headings (`Line 4. If…`), worksheet titles (`…Worksheet—Line 16`), and standalone Title Case prose headings (previous line ends a sentence, body follows); FTB PDFs get the FTB rules automatically (sidecar `publisher: "FTB"`, or `"parserStyle"`), and HTML documents do not use this parser at all; blocks are capped at 1,200 chars (`refdocs/chunk.ts`). After any parser change: `corpus sync --force`, then re-point code citations to block ids.
- **One-off smoke tests miss "fixed A but broke B" patterns.** A 3-case smoke gave us false confidence twice during this build. Phase 6 of the original plan (a real Mastra eval dataset with scorers) is the next thing to build before any further prompt/retrieval changes.
- **The review judges use Haiku because each task is narrow.** Read decision + facts + retrieval, emit one structured output. If verdict-quality drops on harder cases, swap to Sonnet — one-line change per judge in `canon/src/mastra/workflows/ground/judges/`. Don't reach for it preemptively.
- **`structuredOutput.errorStrategy: "strict"` is right for production but loud during prompt iteration.** Catches malformed model output explicitly via the existing try/catch → `review_failed` verdict, so failures surface in the DB rather than being papered over.
- **Mastra's bundled Anthropic provider uses native structured output only for Claude models it knows.** For a newer model (e.g. `claude-haiku-5-5`) it falls back to a JSON tool call, where Claude sometimes sends an array as a string and the turn fails. The Ask judges pass `providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } }` to force native mode (Canon's `workflows/ask/index.ts`), and their schema's lists default to empty.
- **Pre-retrieval and curated topic indexes were dead ends for this domain.** We considered both; agent-with-good-tool wins on simplicity once the retrieval pipeline is strong. Resist re-introducing pre-retrieval plumbing unless evals show the agent genuinely can't formulate queries — and even then, fix the agent prompt first.

## Related project — lessons carried forward

This project is a deliberate application of lessons learned from **Mr. BigBadgeGuy** (BBG), an earlier Mastra-based agent. Its repo and memory are local to the maintainer's machine; the pointer to them lives in local Claude memory, not here.

Lessons worth bringing forward:

- **Mastra tool `execute` signature**: receives the Zod-validated input as the first argument (not a wrapped `{ context }` object in current versions). When calling a tool outside of an agent, use `(tool as any).execute(input)`.
- **Agent `Memory` + per-item loops is a trap.** BBG's Twitter poller used `agent.generate()` inside a `for` loop over mentions; memory carried context between iterations and polluted replies. For multi-item batch work, either make each iteration stateless or use separate threads.
- **Advance dedup markers before processing, not after.** BBG was replying to the same mention multiple times because the "last processed" marker only advanced after the loop completed successfully. Set it first so a crash can't re-process.
- **Research before building integrations.** For any new third-party API (IRS, state, Plaid, document OCR), do a research pass first, then build. Coding from memory against unfamiliar APIs wastes cycles. This is also saved in BBG's memory.
- **`mastra dev` doesn't auto-load `.env`.** The `dev` script in `cade/package.json` passes `--env .env.development` explicitly for a reason.
- **Vercel Cron is the right primitive for scheduled work** *(historical — self-host runs a long-lived process now, so plain background tasks work)*. Kept for if a hosted deployment returns.

## Finding Mastra docs

Mastra ships its reference docs *inside* the installed package — always check there before guessing from memory or going to the web:

- **Reference docs (Markdown)**: `node_modules/@mastra/core/dist/docs/references/`
  - `docs-*.md` — topical guides (e.g. `docs-studio-observability.md`, `docs-memory-storage.md`)
  - `reference-*.md` — per-API/class reference (e.g. `reference-logging-pino-logger.md`, `reference-storage-libsql.md`)
  - `SKILL.md` — canonical quick-start and core concepts
- **Type definitions**: `node_modules/@mastra/core/dist/**/*.d.ts` — authoritative when docs are silent (e.g. finding what `InMemoryStore`, `MastraCompositeStore`, `ObservabilityStorage` actually expose)
- **Sibling packages**: `node_modules/@mastra/<name>/dist/` — loggers, libsql, observability, memory, server, etc. all follow the same layout

Rule of thumb: grep the bundled docs first (`Grep pattern path=node_modules/@mastra/core/dist/docs`), then fall back to `.d.ts` files, then to `mastra.ai` docs online. The bundled copy is pinned to the installed version, so it can't drift from what's actually running.

## The `.scratch/` directory — Claude's workspace

All temporary work Claude produces or needs to save locally goes in **`.scratch/`** at the repo root — screenshots, verification artifacts, backups, one-off scripts, analysis output. It is gitignored and never committed. Make subfolders freely (e.g. `.scratch/readme-run-screenshots/`). Don't scatter temp files elsewhere in the repo, and don't use system temp dirs for anything worth keeping between sessions.

**Private tax data is the exception: it never goes anywhere inside this project, not even `.scratch/`.** A real return (documents, filed values, notes that describe it) lives in a folder outside the project that Claude sessions here cannot read; tools point at it by path (`scripts/compareFiled/cli.ts <folder>` refuses a folder inside the project, and prints only no-amount reports). Never write real figures, or any hint that a real return shaped something, into a committed file, a code comment, or a commit message.

## What belongs in CLAUDE.md vs memory

- Architecture, file layout, commands, design principles → **this file** (checked in, visible to anyone).
- User preferences, cross-project learnings, ongoing context → **`~/.claude/projects/.../memory/`** (local, persists across sessions).

If you're a fresh Claude Code session starting in this folder: read this file, then the BBG memory (see your local memory index for its path) for broader context on how Andrew builds agents.

## Things explicitly out of scope (for now)

- A dedicated OCR/parsing service. Document reading DOES work today — chat attachments are sent inline to Cade (base64 in the stream, `AppShell.tsx` `sendChat`), Claude reads the PDF/image natively, then calls the structured ingest tools (`ingestW2`, `ingest1099Div`, `ingest1099B`, …). Out of scope is only a separate extraction pipeline (batch OCR, non-chat ingestion paths).
- Direct IRS filing (human-in-the-loop CPA signs off first)
- Multi-tenant auth / client portal (single-user for prototyping)
- Pricing, payments, scheduling (Stage 1 only cares about extracting facts)
- Anything outside the Alex-simple scenario (single CA filer, one W-2, no deps, standard deduction). When the user's situation goes outside, Cade responds "Oh, we don't handle that scenario yet" rather than inventing behavior.
