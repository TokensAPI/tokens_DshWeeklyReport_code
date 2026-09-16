# @run19/report-pdf — RUN-19 formal Host module

Standalone Node ESM package; no weekly-report-source installation/import is needed. Exports `PdfRenderer`, `apply`, and default Cordis plugin `{name, apply}`. The named `apply(ctx, config)` provides `reportPdf` with `ctx.provide('reportPdf', renderer)` and registers renderer disposal through `ctx.effect`. It does not modify compositions or install itself. Provider wiring must be performed by the integrating Host composition; actual production installation remains an integration acceptance item.

## Contract

```js
import { PdfRenderer } from '@run19/report-pdf';
const pdf = new PdfRenderer({
  cacheDir: '/trusted/report-store/pdf-cache',
  assetRoots: ['/trusted/report-store/assets'],
  pythonPath: '/Users/rz/.runzhou/venv/bin/python',
  fontPath: '/System/Library/Fonts/STHeiti Medium.ttc',
  timeoutMs: 60000
});
const result = await pdf.render({
  reportId: 'report-123',
  saveToken: 'save-7',
  markdown: '# 中文周报\n\n人工补充。\n\n![图表](asset:chart1)',
  assets: [{ id: 'chart1', path: '/trusted/report-store/assets/chart.png', sha256: '64 lowercase hex characters' }],
  annotations: [{
    id: 'change-1', public: true, source: 'user_direct',
    target: { startLine: 3, endLine: 3, quote: '人工补充。' },
    displayName: '已核验用户', completedAt: '2026-09-08-22-00'
  }],
  templateVersion: 'plain-a4-v1'
});
// {status:'ready', saveToken, digest, pdfPath, cached, pages, imageCount, markedBlocks, warnings}
// {status:'stale', saveToken, digest:null|string, ...} — NEVER display as current
// {status:'failed', saveToken, digest:null|string, error:'SAFE_ERROR_CODE'} — no pdfPath
pdf.dispose();
```

`reportId` is the queue isolation key, not an access-control token. Host MUST authorize report/session association before calling. Review must verify both `saveToken` and current report association before displaying any returned path, including a previously returned ready result. Do not forward paths as arbitrary file download URLs: the review Host must serve only authorized generated PDFs.

Constructor configuration is trusted Host-only configuration, never RPC-controlled. Cache directory should be private to the module. `assets` input is expected from core-authorized snapshots, not raw user filenames. Relative asset paths are not recommended. The renderer performs realpath containment checks beneath `assetRoots`, rejects symlink escape, checks existence, file size (30 MB), sha256, and PNG/JPEG signatures for **every asset before checking cache**. It stages verified bytes and font bytes inside its cache job directory to avoid later file mutation changing rendering. This is not a general sandbox against a hostile local process able to replace files between reads.

Images must be standalone Markdown lines with `![caption](asset:ID)` (exact registered `ID` also accepted). IDs are ASCII word/dot/hyphen characters. Remote URLs, arbitrary paths, unregistered images, reference-style images, inline images, SVG, malformed image syntax and HTML are rejected. Decoder failure produces failure, not a placeholder. Core must normalize original generator image references to asset IDs. Ordinary textual links are not fetched.

## Snapshot, queue and cache behavior

- Caller input is copied synchronously, retaining only renderer-needed public annotation fields; later edits to caller objects do not alter a queued request.
- A single renderer instance serializes Python jobs globally. Waiting obsolete requests return stale without rendering. Active obsolete jobs may finish and populate immutable content cache, but return stale **without pdfPath**. Per-report latest tickets prevent results crossing report queues.
- `saveToken` is echoed, not included in content key. Digest includes MD, sorted asset IDs/hashes, full selected public annotations, actual font hash, template version, renderer version, Python script hash, Python/PyMuPDF versions.
- All assets/fonts are revalidated before cache reuse. Cached PDF checksum, PDF magic and receipt are checked; corruption rerenders.
- Final PDF and receipt use atomic renames from private job directories. Temporary files are removed. Crash leftovers and disk-quota cache eviction are not implemented in v0.1; host operations should schedule cleanup when no jobs are running. No business versions or source MD are stored here.
- Disposal stops subprocesses and makes queued requests stale. Python timeout is configurable; subprocess errors only expose allowlisted codes, never traceback/MD/prompt or filesystem paths. The implementation does not write knowledge bases or perform network calls.

## Structured annotations

Only `public:true` annotations are selected. Allowed sources: `user_direct`, `user_prompt`. `agent_inference` must not be sent as a human annotation; invalid selected sources fail. No author is inferred from existing `**bold**` syntax.

`target.startLine/endLine` are **1-based inclusive** and `target.quote` must exactly equal those source lines. Targets must encompass whole semantic blocks, including a whole table. Multiple complete blocks may be selected. Partial paragraphs/rows fail `ANNOTATION_BLOCK_BOUNDARY_REQUIRED`, not silently expanded. Image/rule selections fail `ANNOTATION_NON_TEXT_BLOCK`. Invalid or outdated quote fails `ANNOTATION_QUOTE_MISMATCH`.

Marked text is drawn with real PDF fill+stroke bold simulation AND underline strokes (including heading text and table cells). Font weight simulation is intentional; no HTML is inserted. Public source footer is deduplicated by time/name: `加粗下划线为人工注释（来自yyyy-mm-dd-hh-mm 用户xxx）`. Core supplies already-verified display name and formatted confirmation time, including preserved historical attribution. Missing identity/time is visibly provisional with a warning; renderer never assumes admin or invents completion timestamps. Core/review remains responsible for finalize/publish identity rules.

Private annotations/prompts/deleted text are not serialized to Python. Public annotations must refer to visible text; deletions belong to core audit, not final-body underlines. Any sensitive text intentionally present in Markdown remains in the PDF: this module is not a content sanitizer.

## Supported Markdown and limitations

This is a deliberately small real-PDF renderer, **not full GFM**:

- Chinese/plain paragraphs, headings 1–6, pipe tables, standalone PNG/JPEG images/captions, horizontal rules, fenced literal code.
- Tables wrap text and split excessively tall rows across pages. Escaped table pipes or very wide tables fail rather than misreport success.
- Inline bold/italic/link/list/blockquote syntax is retained as literal text rather than fully styled. Explicit `LIMITED_MARKDOWN` warnings report these format limitations. Fenced code has no syntax highlighting; nested structures, math, footnotes and advanced GFM may remain literal.
- No claim of full original 0.1.5 cover/template compatibility. No custom HTML/CSS, arbitrary fonts selected through render input, remote image loader, PDF editing or source-position PDF hit testing.
- Current receipt reports page/image/marked-block counts; graphical correctness remains subject to integration visual review. Performance measured by tests is not a zero-latency guarantee.

## Runtime and licensing

The JS/Python code here is an original implementation, MIT licensed. It does **not** copy or modify the original pdfbuilder/fonts or install source dependencies. The tested runtime is the existing `/Users/rz/.runzhou/venv/bin/python` with PyMuPDF and macOS system `STHeiti Medium.ttc` (font not redistributed). Configuration can point to another verified installation/font; system paths are deployment-specific. No package installation was performed.

**PyMuPDF is AGPL-3.0 / commercial dual-licensed. This is a material distribution/deployment risk and is not waived by local testing or this package's MIT license.** Before distribution, review applicable AGPL obligations or obtain appropriate commercial licensing, or replace the renderer with a tested permissively licensed implementation. This package does not claim that subprocess separation eliminates license obligations. macOS font redistribution rights are also not assumed.

## Tests and verified local output

Run with Electron as Node (current machine):

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/*.test.js
```

Override `RUN19_PYTHON` and `RUN19_FONT` for another verified environment. Tests create data only in this package's `.test-output/`, generate an actual PNG and actual PDF using Python, reopen PDF to verify Chinese text, price/table content, embedded images and vector drawings. `.test-output/verification.json` records one PDF path and extraction evidence. Node tests cover caching, annotation/hash effects, invalid resources and stale queue behavior. No writes to WeKnora, compositions or original backups occur.

Additional `test/source-integration.test.js` reads the existing sibling source validation manifest `weekly-8V6p06` (13 successful local-data series, four charts) and imports sibling report-core only as an integration test dependency. Runtime package remains source/core independent. It creates a new core store exclusively beneath this package's `.test-output/source-integration/`, verifies source hashes, snapshots assets, renders normalized initial Markdown, saves one human change with provisional identity/time, then confirms using an explicitly synthetic `集成测试账号（非知识库身份）` identity and renders `exportVersion`. These test confirmations are NOT actual WeKnora identity verification and no publication occurs. Evidence: `.test-output/source-integration/integration-evidence.json`, containing three PDF paths and text/image checks, and `initial/edited/confirmed-page-*.png`. The inspected real report renders three pages with all four chart images and legible tables; unsupported original quote/inline emphasis remains visible with warnings. ISO completion timestamps from core are formatted `yyyy-mm-dd-hh-mm` in the footer using their supplied offset, not current local time.

A simulated installation test copies exactly package.json plus the declared `files` payload into a private test `node_modules/@run19/report-pdf` and verifies bare-package ESM import with Electron RunAsNode. Package exports resolves to `./index.js` and LICENSE is included. This is packaging resolution verification, not production Cordis installation. Latest full run: **7 tests passed** (five original, installed-package resolution, real source/core/PDF integration). For a standalone checkout without sibling source/core fixtures, run `--test test/renderer.test.js` instead.
