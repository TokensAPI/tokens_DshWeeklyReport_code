# RUN-19 WeKnora connector (independent Node ESM module)

No dependencies, installation, presets or deployment changes. `src/index.mjs` exports `Connector`, named `name`/`apply`, and default Cordis plugin `{name:'weknora-connector',apply}`. `apply(ctx,config)` provides `weknoraConnector` via `ctx.provide`; mount this shared service in Host composition, with disposal owned by Cordis. It registers **no Agent tools**. The trusted Host must explicitly expose only the intended read methods. This is a local pilot adapter, not a multi-user authorization service.

## Round4 image upload primitive (not complete image publication)

Trusted Host may optionally configure `assetRoots: ['/absolute/core/snapshots']`. Missing/empty roots reject image approval. `port = connector.createReviewHost()` now accepts synchronous `port.approve({operation:'publishImage',kbId,title,path,sha256,tagIds?})`; successful approval returns the same opaque, one-use, port-local capability as other writes. `await port.execute(cap)` posts one multipart knowledge file using `file`, `fileName`, `tag_ids` (comma-separated) and `channel=api`. The file's wire filename is fixed image.png/image.jpg, while fileName carries the bounded report title plus image extension. No endpoint/key/URL input is accepted.

Approval verifies an absolute realpath inside configured roots, O_NOFOLLOW leaf open, matching inode/stat before/after read, size <=10MiB, lowercase SHA256, PNG/JPEG magic. It copies bytes into a private capability record; subsequent file/path/content or request-object mutations cannot alter the uploaded snapshot. This is **magic validation, not full image decoding**: truncated/malformed PNG/JPEG may still be rejected during server parsing, and upload success cannot prove image validity/display/indexing. Approve is synchronous and may block briefly reading <=10MiB; each outstanding capability retains that buffer until consumed or garbage collected. Host coordinator must bound outstanding image count/total bytes (no aggregate port quota in this primitive).

Image success requires server `id`, exact `knowledge_base_id`, and canonical `file_path` matching `resource://[A-Za-z0-9_-]{22}`. Grammar comes from WeKnora `internal/types/resource.go` ResourceHandleLength=22 and ParseResourcePath, not a general URL regex. Output is allowlisted with `submitted:true`, `processing_complete:false`; malformed/missing/cross-KB/legacy physical file_path or unknown responses remain failure/unknown and never retry. One capability is consumed even on failure. Local input/config validation happens before network.

`await port.imageDetail(kbId,knowledgeId)` is a trusted-Host-only read-key GET projection returning the same validated id/KB/resource path and parse/summary fields, with no submitted flag. Ordinary `connector.detail()` does not expose file_path. Do not expose this port to Agent or arbitrary Client RPC.

**Manual resource-image input remains rejected**; no caller-supplied bindings or free resource URI bypass is introduced. `capabilities().images` remains false; `imageUploadConfigured` reports only this primitive. A future coordinator must bind actual verified upload results into a human-approved multi-item plan, preserve per-item intent/unknown states, and verify claims/chunks/display. Current deployment differs from researched source; these tests do not establish deployed support. PNG/JPEG upload can initiate OCR/embedding/summary costs and must be included explicitly in human publication preview. No real KB upload was performed.

Tests use synthetic signature-byte fixtures (not real decoded photos), short-lived fake HTTP listeners, and cover multipart, byte freezing/TOCTOU, path/hash/size/symlink/scope, resource grammar, unknown/redirect/no-retry and replay rejection.

## Host-owned configuration

```js
import { Connector } from './src/index.mjs';
const connector = new Connector({
  baseUrl: 'http://127.0.0.1:8088',
  readSecretFile: '/absolute/path/to/retrieve-only.key',
  writeSecretFile: '/absolute/path/to/separate-ingest.key', // optional
  allowedKbs: ['explicit-kb-id'],
  // Default: self-contained Node HTTP reader; no Python needed.
  // clientPath: '/absolute/trusted/knowledge_client.py', // optional legacy override
  // pythonPath: '/usr/bin/python3', // only used with clientPath
  timeoutMs: 15000,
});
```

Never take these fields from model tool arguments. HTTPS or literal 127.0.0.1/::1 HTTP only, explicit nonempty KB allowlist, separate read/write file paths. Read commands default to `src/read-http.mjs`, shipped inside this package: direct Node HTTP(S), no environment proxies/cookies/bearer, no redirects/retries, request/response limits, cancellation/deadline, parent-KB and chunk ownership checks, strict scalar projections and credential redaction. Owner-only regular secret files are checked without following a leaf symlink. An explicit `clientPath` retains the trusted legacy Python CLI override (`-B`, no shell, bounded stdout/stderr); only that opt-in mode needs Python and an external pinned client. Credential files are not printed. No development checkout path is needed for default operation. Distinct paths cannot prove key capability separation: issue a real retrieve-only read key; the connector does not mint or inspect key scopes.

## Read contract (safe to wrap as tools)

- `await identity({forPublication:true})` uses **only the configured write credential** in GET `/api/v1/auth/me`; missing write credential or failed/schema-invalid response returns `verified:false` and never falls back to the read account. Default `identity()` uses write when configured, else read; `identity({purpose:'read'})` explicitly checks read identity. Success → `{verified:true,verification:'GET /api/v1/auth/me',credentialPurpose:'publish'|'read',authentication:'scoped_api_key',principal:{userId,username,tenantId},humanIdentityVerified:false,explanation}`. Only three identity leaves are retained, not full user/tenant config or email. This verifies the backend-resolved API-key account, **not** the current human or an admin role. Host confirmation and publication attribution should use the publication identity, not model-supplied display names.
- `capabilities()` → read methods and explicit `images:false`.
- `detail(kbId, knowledgeId, {signal}?)`; `status(...)` is an alias, not polling.
- `chunks(kbId, knowledgeId, {page=1,pageSize=20,signal}?)`.
- `search(kbId, query, {matchCount=10,signal}?)` — may invoke query embedding, so not automatically called for health checks.
- Success: `{ok:true,data:<allowlisted result>}` (same shape for Node default and Python override). Errors: `{ok:false,error:<sanitized category>,outcome_unknown:false,automatic_retry:false}`. No raw stderr or HTTP error body leaves the adapter.

## Review Host closed write interface

`const review = connector.createReviewHost()` returns `approve(request)` and `execute(capability)`. **Keep both methods and the Connector instance inside trusted Host code. Do not register approve/execute as model tools, expose them by generic RPC, or serialize the port to the browser.** The Host is responsible for authenticated human review/click handling, ownership of the reviewed draft and matching the displayed revision before calling approve. This port by itself does not implement human UI authentication; approval is a trust boundary of the integrating Host.

`approve` snapshots and freezes validated input, returning an opaque object tracked in a private WeakMap. `execute` accepts only this exact same-port object once; JSON clones, `userConfirmed:true`, foreign capabilities, replay and altered model payloads cannot authorize writes. Input errors return normal error objects instead of a capability. A failed execution consumes approval and never retries. This is process-local authorization, not durable request idempotency. A Host must reconcile unknown outcomes before allowing another approval.

Supported requests:

```js
{operation:'publishManual', kbId, title, content, tagIds?: ['existing-tag-id']}
{operation:'publishReport', kbId, title, content, tagIds?: ['existing-tag-id']}
{operation:'title', kbId, knowledgeId, title}
{operation:'tags', kbId, knowledgeId, tagIds: ['existing-tag-id']}
```

- `publishReport` (Round 5) is the Host-coordinator path for the resolved report Markdown: it accepts canonical `resource://<22>` image destinations (verified bindings from `publishImage`) and still rejects data:/file:/external-HTML/local-path images. It uses the same manual endpoint/body shape as `publishManual`.
- Publish: POST `/api/v1/knowledge-bases/:kb/knowledge/manual`, `status:'publish'`, `channel:'api'`, `tag_ids`. This creates a new manual record, never updates an existing document.
- Title: read-key parent preflight then PUT `/api/v1/knowledge/:id`, `{title}`.
- Tags: read-key parent preflight then PUT `/api/v1/knowledge/tags`, `{kb_id,updates:{[id]:tagIds}}`. **Replaces** that document's tag set; [] clears it. Does not create tags.
- Existing tag IDs are supplied explicitly; the server is authoritative for their KB scope. List/create-tag APIs are not exposed in this minimal adapter.
- Publish/title success is a submitted record, **not** successful parsing/indexing; preserve parse/summary status, use status and later known-answer read verification. Tags success is API acknowledgement only.
- POST timeout, transport error, 3xx, 5xx, oversized/malformed/mismatched success are `outcome_unknown:true`; there is no retry, redirect following or existing-ID guess after a conflict.
- Titles ≤512 characters, content ≤512KiB and JSON ≤1MiB; output ≤2MiB. Supported writes do not accept arbitrary endpoint, headers, process config or file paths.

### Images and generation risks

Images are intentionally unsupported: Markdown image syntax, image HTML, data URIs and common local file references are rejected before any write. No local image file is read, no image uploaded, and no data URI is silently submitted. This conservative validator may reject harmless code examples containing such syntax; it is not a complete DLP or HTML parser. Caller should provide plain Markdown text only. MD/link content remains untrusted; do not execute or auto-fetch links. Future image support needs a separately reviewed resource flow, MIME/size controls and verified deployment support.

Publishing can invoke embedding, summary, Wiki, auto-tag or other configured backend work. Approval must explain these effects/costs; there is no zero-cost promise. Title updates may affect derived metadata. Ingest keys also authorize native destructive endpoints even though none is exposed here. Parent preflight is defense in depth, not a replacement for server authorization or protection against concurrent KB movement.

## Tests and evidence

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/*.test.mjs
```

Fake loopback HTTP server and temporary owner-only test secrets; Python reads are actual subprocesses using existing `knowledge_client.py`. Tests cover detail/chunks/search, CLI option-injection defense, scope rejection, separate request keys, publish/title/tags exact payloads, image rejection, capability snapshot/replay/forgery, no-retry 503/redirect and invalid configuration. The test fixture creates/deletes temporary files. No real database write, embedding call, new package installation or live API acceptance is part of the test. Test currently uses the known absolute Python-client checkout path. Deployment source/image mismatch, expired credentials, real A/B isolation and backend generation success require separate acceptance.

### Self-contained reader delivery and licensing decision

The development `knowledge_client.py` imports only Python standard-library modules; it has no internal local-module dependency. The inspected development tree did not contain a project LICENSE (only virtualenv dependency licenses were found). Consequently no Python source was copied or relicensed. `src/read-http.mjs` is an original Node implementation of the documented wire/security contract and is included by the existing package `files: ["src", "README.md"]` allowlist. This decision does not assert a license for the external legacy checkout.

`test/installed.test.mjs` builds a tar.gz-shaped package from the delivery allowlist, extracts it into a temporary isolated installation, then imports it in actual child Node processes with no Python on PATH and an unusable HTTP_PROXY. Fake loopback HTTP verifies detail/chunks/search, redaction/projection, KB mismatch, redirects, encoding and byte limits, timeout/cancellation, unsafe/symlink credential refusal and no retries. Original identity/capability integration additionally retains actual Python subprocess override regression. No real knowledge database is accessed. External runtime requirements remaining for default mode: Node >=22, configured credential files and a WeKnora endpoint. Python interpreter plus external script remain only for explicit clientPath compatibility mode.

### Live read-only identity evidence

A separate authorized probe performed only GET `/api/v1/auth/me` with the existing vector read and write secret references. Both resolved username `tc-synthetic-a`, user ID `3fe83204-ea15-4a18-8a31-a49e7b0f4b7c`, tenant `10000`. No key, raw response, login, account creation, ingestion or embedding request was printed/performed. This is runtime account evidence, not a guarantee that credentials will remain valid. Reference route: `weknora/internal/router/routes_auth_tenant.go:228–231` (apiKeyAny); response: `internal/handler/auth.go:613–667`. Tests additionally simulate different read/upload usernames and missing/denied publication credentials.

### Permanent image API research / explicit unsupported contract

Source routes expose `POST /knowledge-bases/:id/knowledge/file` for a complete knowledge document, not a standalone durable image-asset upload associated with an existing manual document. `internal/router/files.go` exposes GET/HEAD presigned reading and protected resource proxies; no permanent KB-image-upload route was found in this audited router tree. `POST /sessions/:session_id/attachments` is temporary chat attachment ingestion and must not be substituted for KB assets.

`internal/application/service/knowledge_create.go:1231–1256` internally resolves data URI and remote HTTP(S) images into object storage and binds references before Go chunking. `internal/infrastructure/docparser/image_resolver.go` performs storage resolution. These internal services are not a published independent image-upload API. We do not submit data URIs to the text pipeline or assume local relative paths are accessible inside containers. Consequently manual content containing images still returns `images_not_supported` before its HTTP write; the separate Round4 `publishImage` primitive at the top of this document now supports PNG/JPEG knowledge-file upload in fake-tested form. It does not yet bind or publish a complete image report.

A future graph-and-text release must add/verify a Host-controlled durable asset adapter (bytes→MIME/size validation→authenticated asset store→scoped stable reference→manual resource binding), one-time approval bound to all image hashes and final Markdown, and cleanup/reconciliation for partial upload success. Direct S3/MinIO upload alone is insufficient: tenant/KB ownership and WeKnora resource claims must be preserved. Alternatively, a reviewed staging HTTPS resource can be consumed by the backend remote resolver, but lifetime, SSRF, disclosure, actual permanent copy completion and orphan cleanup require verification first. Round4 implements only the constrained knowledge-file upload and resource-handle response validation primitive; the full multi-item adapter, manual bindings and real deployment acceptance remain unfinished.
