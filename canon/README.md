# Canon — your tax attorney

[← Back to the README](../README.md)

Canon (`@openreturn/canon`) is OpenReturn's tax attorney. It holds the IRS and FTB reference library, searches it, answers tax-code questions with citations, and grounds each of Cade's decisions in the published text. Canon is a [Mastra](https://mastra.ai) project and an [MCP](https://modelcontextprotocol.io) server on port 4112. It has no user data and no conversation of its own.

<p align="center">
  <img src="../static/screenshots/studio-canon.png" alt="Canon's MCP server in Mastra Studio: the HTTP, SSE and CLI endpoints, and the four tools searchRefDocs, citeRefDoc, run_ask and run_ground with their descriptions" width="880">
  <br/><em>Canon's MCP server in Mastra Studio (http://localhost:4112): four tools, the whole surface.</em>
</p>

## What Canon does

| MCP tool | What it does |
| --- | --- |
| `searchRefDocs` | Hybrid search over the library: keyword (SQLite FTS5) and local embeddings, merged by rank fusion |
| `citeRefDoc` | The exact text and a readable citation for one block |
| `run_ask` | **Ask The Tax Code**: formulate → retrieve → answer → validate. A "partial" answer names its gaps as searches, and the pipeline searches once more. |
| `run_ground` | **Ground one decision**: (gather → assess risk → rule) × up to `maxIterations` (default 3). The verdict is `accurate`, `inaccurate` or `needs_more_facts`, with citations. |

Both workflows are served as tools with output schemas and answer `{ result: … }`, the run result (`status: ok | failed`) validated against the schema. Both are stateless: the caller keeps the threads, the decisions and the verdicts. Each judge is one model call with its schema as the response format, and no tools. Code checks every citation: a quote that is not word for word in a retrieved block is dropped.

In the web app, Ask The Tax Code shows Canon's answers:

<p align="center">
  <img src="../static/screenshots/ask-tax-code.png" alt="Ask Canon in the web app: a question about the 2025 HSA limit, a cited answer, and reference cards that quote Publication 969 and the Form 8889 instructions" width="880">
</p>

## The library

`canon/.data/corpus.db` is the library: 168 IRS and FTB documents, form instructions and publications, with their text, sections, citable blocks, embeddings and the source file of each. The web app's Reference Library lists them all, and a citation opens its document at the cited section:

<p align="center">
  <img src="../static/screenshots/library-document.png" alt="The FTB 5805 instructions in the Reference Library, opened at the Federal Annualized Income Worksheet, with a contents rail on the left" width="880">
</p>

```
sources/**/*.meta.json  →  fetch the source file (PDF, or a cleaned FTB web page)
                        →  parse into sections and blocks (stable ids)
                        →  contextualize each block (Haiku, ~$0.50 per document)
                        →  store in corpus.db
                        →  embed each block (EmbeddingGemma 2 via Ollama, local and free)
```

You do not have to build it: `npm run corpus -- fetch` downloads the prebuilt release. Block ids are stable citations, for example `irs-1040-inst-2025::sec::single::b01`.

## Run it

From the repo root:

```bash
npm run dev:canon          # Canon only, with Mastra Studio at http://localhost:4112
npm run corpus             # the corpus CLI; no arguments lists its commands
```

MCP clients connect to `http://localhost:4112/api/mcp/canon/mcp` (streamable HTTP) or `/api/mcp/canon/sse`. Cade's client is `cade/src/mastra/canon/client.ts`. The web app reads the library through its `/api/canon` proxy.

## The corpus CLI

| Command | What it does |
| --- | --- |
| `npm run corpus -- fetch` | Install the prebuilt `corpus.db` (sha256-checked) |
| `npm run corpus -- status` | Compare the sidecars in `sources/` with `corpus.db` |
| `npm run corpus -- sync` | Ingest new or changed documents (skips the rest by sha256) |
| `npm run corpus -- add-html <url> --dir …` | Fetch and clean an FTB web page into `sources/` |
| `npm run corpus -- search "query"` | Run the production search (`--mode fts`, `vector` or `hybrid`) |
| `npm run corpus -- reembed [--all]` | Embed the blocks again, for example after a model change |
| `npm run corpus -- check` | Row counts and embedding coverage |

## Configuration

`canon/.env.development` is written on the first run. `.env.example` lists every setting.

| Setting | What it does |
| --- | --- |
| `JUDGE_MODEL` | **Required.** The judges' model, as `provider/model` |
| `ANTHROPIC_API_KEY` | For Anthropic models (and for `corpus sync`) |
| `JUDGE_MODEL_URL` | An OpenAI-compatible server for the judges |
| `EMBEDDINGS_MODEL`, `EMBEDDINGS_MODEL_URL` | The local embedding model (default `ollama/embeddinggemma-2`) |
| `CORPUS_DB_PATH`, `MASTRA_DB_PATH` | The library and Canon's run history |
| `CANON_API_TOKEN` | Gates the port when it is reachable beyond localhost |

## Inside

```
canon/
├── src/db/                     corpus schema, store, hybrid search (corpusSearch.ts)
├── src/refdocs/                the ingest pipeline: parse, contextualize, embed; html/ for FTB pages
├── src/mastra/
│   ├── mcp.ts                  the MCP server
│   ├── workflows/ask/          Ask The Tax Code
│   ├── workflows/ground/       grounding: the judges, their prompts and schemas
│   └── server/routes/          the reference-library routes
├── scripts/corpus/             the corpus CLI
├── seed/corpus.manifest.json   the prebuilt corpus release
├── evals/                      the review (ground) and Ask evals; reports in docs/evals
└── tests/unit/                 search, parsing, Ask validation, the ground loop, the boundary
```

Run an eval from this folder: `npx tsx --env-file=.env.development evals/review/run.ts <model>`. The reports are in [docs/evals](../docs/evals/README.md).

## Boundaries

`tests/unit/boundary.test.ts` fails if anything under `src/` or `scripts/` imports Cade's code, `app.db`, the form engine or agent memory. Other services reach Canon over MCP. `@openreturn/canon` (`src/index.ts`) is the in-process API for tooling inside Canon, such as its evals.
