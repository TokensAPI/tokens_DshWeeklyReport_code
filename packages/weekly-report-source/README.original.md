# @run19/weekly-report-source

MD-only thin adapter of `dsh-runzhou-wklyreport_weknora` 0.1.5 for RUN-19. No PDF, old CLI import, bootstrap/install, LLM call, web-search call or knowledge-base write. Default output is an **unconfirmed draft**, not V0/V1. All analysis placeholders remain visibly pending; injected excerpts are not automatically verified or synthesized facts.

## Node ESM contract

```js
import { generate } from '@run19/weekly-report-source/generate';
const manifest = await generate({
  variety: '锡', end: '2026-09-08',
  // start defaults to 800 days before end; end defaults to UTC today
  // charts: true, webSearchEnabled: false,
  materials: [{kind: 'weknora', id: 'K1', title: '资料标题', text: '已获准引用的公开摘录', knowledgeId: '...'}],
}, {
  outputRoot: '/explicit/authorized/output',
  python: '/existing/venv/bin/python', // optional; default python3
  baseUrl: 'http://127.0.0.1:5100', // loopback HTTP origin only
  timeoutMs: 300000,
  // signal: AbortSignal
});
```

No output location is silently selected. Every invocation creates an exclusive `weekly-XXXXXX` runDir under outputRoot (including concurrent invocations). Input cannot override runDir, Python entrypoint or shell command. Paths in the manifest are relative to runDir plus explicit absolute paths for Host import. No shell is used. Python caches and matplotlib HOME/cache writes are isolated under runDir; bytecode is disabled. Existing outputs are never reused or overwritten. Failed runs retain `failure.json` with controlled error code, not remote bodies. Node errors include runDir and a bounded diagnostic for interactive debugging; do not persist/forward diagnostic to public logs.

Materials are supplied by the integrating connector; this package does not fetch from WeKnora. Required material fields: `kind: 'weknora'|'web'`, `id`, `title`, `text`. Optional allowlisted fields: `url`, `knowledgeId`, `versionId`. Arbitrary connector fields/credentials are not forwarded. `text` must already be approved public excerpt, not an entire sensitive connector payload. Web materials require explicit `webSearchEnabled: true`; that flag NEVER executes search here. Manifest `webSearchExecuted` always false. Excerpts are quoted in the report; they remain untrusted Markdown and the consumer must sanitize HTML/URLs during rendering.

## Core import manifest (`run19.weekly-source.v1`)

- `runId`, `runDir`, `status: 'draft'`, `title`, `manifestPath`.
- `generator`: adapter name/version and upstreamVersion 0.1.5.
- `markdown`: `{path, absolutePath, sha256, bytes}`; UTF-8 MD is the authoritative source.
- `assets[]`: `{path, absolutePath, sha256, bytes, mimeType, caption}`; MD references those relative paths (no data-URI or knowledge URL rewriting).
- `sources`: baseUrl, requestedStart/requestedEnd, UTC fetchedAt, per-ref pointCount/status/firstTimestampMs/lastTimestampMs; injected material IDs and text hashes, not secrets.
- `config`: variety, period, charts, webSearchEnabled/webSearchExecuted.
- `warnings`: structured partial-data signals; all-empty/insufficient data is fatal instead of fake success.

Core should validate hash/path, copy MD and assets into its own managed immutable baseline, allocate reportId/reviewSessionId and keep source provenance. This generator does not create core records, versionId or publish records. Source runDir is staging, not an immutable business version. Consumer decides retention after successful import.

## Python entrypoint

`python -B python/generate.py` consumes one JSON object from stdin, writes manifest JSON to stdout and nonzero exit on failure. Direct callers must allocate a unique existing empty runDir and supply `runDir`, `variety`; the `.claimed` exclusive marker rejects reuse. Optional input fields mirror Node request (`baseUrl`, `start`, `end`, `period`, `charts`, `materials`, `webSearchEnabled`). Prefer Node for validation, unique allocation, timeout/cancellation and failure marker. Local API usage is GET `/defs/{id}/values?start=&end=`; the old client performs no login/bootstrap.

## Formal Cordis Host plugin

Exports `apply(ctx, config)` and default `{name, apply}`; `apply` registers a plain `WeeklyReportSource` instance using `ctx.provide('weeklyReportSource', source)`. Reads config `{outputRoot, python, baseUrl, timeoutMs}` and exposes `generate(input)`. No runtime RPC/tool or composition changes are made. Registration follows the inspected companion `report-pdf/index.js` provide/effect pattern; no Cordis import or runtime/peer dependency is required, avoiding unresolved ASAR peer paths and a second runtime. A Fiber effect aborts active child processes on disposal; calls after disposal reject before writing. Integrator should mount service in Host composition, inject `weeklyReportSource` in consumers, and enforce session/authorized outputRoot policy. Package exports `./package.json` for manifest discovery. No automatic installation is performed.

## Tests and real validation

`npm test` / `node --test test/*.test.js` (no npm dependencies required for generate tests). Tests write only this package's `.test-output/`, use a loopback fixture, and cover validation, default web off, injected field allowlist, GET-only access, concurrent unique directories, manifest hashes and all-empty failure. Test output is staging and excluded from package publishing.

2026-09-08 local validation used existing `/Users/rz/.runzhou/venv/bin/python` (matplotlib 3.9.4), existing 5100, end 2026-09-08. Result `validation/weekly-8V6p06/manifest.json`, `report.md`, 4 chart PNGs; 13 nonempty series and no warnings. No PDF or KB write. Node shell command was unavailable; tests ran successfully with `ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/*.test.js` (Node v24.18.1). Real MD content inspected; chart pixel correctness not independently visually accepted. Formal service source follows inspected registration API, but installation/activation against the real Cordis runtime is not claimed by this package's generate tests.

## Licensing and provenance

`python/rzlib/{__init__.py,variants.py,catalog.json,charts.py,fonts.py,reports.py,runzhou_api.py}` copied unchanged from `/Users/rz/Downloads/dsh-runzhou-wklyreport_weknora` version 0.1.5. Original MIT copyright and full grant retained in LICENSE. `pdfbuilder.py`, old `cli.py`, JS bootstrap and WeKnora uploader intentionally omitted. Vendor comments may mention PDF; neither adapter imports or executes PDF code. New wrapper code uses MIT. Matplotlib and its transitive dependencies/fonts remain separately licensed; use an existing provisioned Python environment, no automated installation. Final distribution dependency/license lock is an integration-stage task.
