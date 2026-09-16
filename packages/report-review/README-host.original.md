# RUN-19 report-review — formal Host MVP

Host-only implementation in `src/index.mjs`, tests in `test/host.test.mjs`. This work does not modify the Client, package.json, a composition, deployed application, or launch a server. Package installation/build wiring belongs to the integrator.

## Installation contract

Default export `{name:'run19-report-review', inject, apply}`; named `apply`, `createReviewHost`, `draftView`, `registerReviewTools` exports. Hard dependencies: `connection`, `reportCore`, `reportPdf`, `sessions`. Optional services are looked up with `ctx.get('weeklyReportSource')` and `ctx.get('weknoraConnector')` on each use.

```js
{
  allowedSessionIds: ['session-actual-current-id'],
  sourceOutputRoot: '/absolute/trusted/source-staging', // same as weeklyReportSource outputRoot
  publishKbId: 'explicit-allowlisted-kb-id',             // must also be allowed by connector
  maxBodyBytes: 1048576,                               // optional; default 1 MiB
  publishTokenTtlMs: 300000                            // optional; default 5 minutes
}
```

No secret or filesystem root comes from browser/model arguments. Core's root and PDF assetRoots/cache/font/Python remain in their own trusted service configs. Source root is required for generation, not editing. publishKbId is required for publication plans, not editing. Register the five services in the **Host composition**, in an authorized integration step; no composition edit is included here.

`apply` provides `reportReview` with `ctx.provide`. It registers exact routes via `connection.fetch.register`:

- `/api/run19/review`, `methods:['POST']`, `requestBody:'buffered'`, `fetch(Request) -> Promise<Response>`.
- `/api/run19/pdf`, `methods:['GET']`, `requestBody:'buffered'`.

This is the existing Connection authenticated route registry, not a new HTTP listener. Registration and disposal semantics were read from `inspection/dsh-client-connection/lib/index.js:548–600`; the `/api` authenticated wrapper is owned by Connection. Never mount the factory's fetch handlers on an unauthenticated listener. Closure maps are disposed with the owning Fiber; route unregistering belongs to Connection's scoped effect.

### Session security model

The current authenticated desktop user may select **existing** sessions; `sessions.get(sessionId)` must succeed. Every report operation then goes through core's session/report association check. A browser-provided session ID is not a proof of an individual human identity. This is explicitly a single authenticated desktop-user pilot, not multi-user row-level authorization. Configure `allowedSessionIds` to the intended session(s) to narrow access; omitted means all existing sessions available to that desktop principal. Authentication/Origin rejection must happen in Connection before entering the route.

PDF GET accepts only `sessionId`, `reportId`, and strict lowercase 64-hex digest; no file path. A successful core-authorized render stores its local path privately against session/report/digest/saveToken. GET rechecks session/report, current token, PDF magic and token after reading. Old-token results return 409. Restart clears preview handles; re-render/re-cache produces new authorized URLs.

## Browser API

POST JSON `{action,sessionId,...}` returns `{ok:true,value}` or `{ok:false,error:{code,message}}`. Core typed errors are allowlisted; native errors, source diagnostics, paths, key material and stderr are not returned. All JSON and PDF responses are no-store.

| Action | Inputs in addition to sessionId | Value |
| --- | --- | --- |
| list | — | `{reports:[draft projection]}` via core.listDrafts, restart-safe |
| create | title, markdown? | draft; nonempty assets rejected; no browser path import |
| get | reportId | draft |
| save | reportId, saveToken, markdown | draft; provenance fixed to user_direct, ignores author/source/instruction |
| preview | reportId, saveToken? | ready/stale/failed, saveToken, digest, warnings, pdfUrl only if current ready |
| versions | reportId | `{versions:[safe version including markdown]}` |
| confirm | reportId, saveToken | safe version; author comes only from verified upload credential |
| startRevision | reportId, versionId?, saveToken? | draft; omitted version defaults latest confirmed |
| audit | reportId | `{baselineMarkdown,currentMarkdown,entries}`; local before/after text, no prompt or asset paths |
| identity | — | `{confirmed,verified,authorId?,displayName?,humanIdentityVerified:false,blocked?}` |
| publishPlan | reportId, versionId | frozen public text, target, version/plan/digest and short-lived publishToken |
| publish | reportId, versionId, planId, digest, publishToken, userInitiated:true | conservative submitted/unknown/failed, always published:false until reconciliation |
| generate | variety,start?,end?,period?,charts?,includeKnowledge?,query?,matchCount?,webSearchEnabled? | imported draft; webSearchEnabled:true explicitly rejects WEB_SEARCH_UNAVAILABLE |

Draft/versions are explicit allowlists, not serialized core records. They exclude asset path/snapshotPath, arbitrary markers, instruction/prompts, provenance candidates and raw annotation quote. Current Markdown and local audit before/after intentionally remain visible to this authenticated session; this is not content DLP. User-authored secrets intentionally retained in body remain visible and must be reviewed before publishing.

Private preview passes only core-owned snapshot assets and explicit public human-source, non-low-confidence annotation fields to PDF. Low-confidence mappings remain visibly warned, not silently certified. Preview readiness is checked against current saveToken after rendering; PDF failure does not alter the draft. The renderer independently enforces resource roots, hashes and syntax.

## Identity and publication boundary

`identity({forPublication:true})` must return `verified:true`, `credentialPurpose:'publish'`, and `principal.userId/username`. The connector must resolve these using the **write credential through read-only auth/me**, not infer identity from a tenant ID, read key, local nickname or admin fallback. Unverified identity blocks confirmation. Historical author is compared again at plan and execution; changed account blocks rather than rewriting a frozen version. This upload-account attribution does **not** prove the current keyboard operator.

`dispatchHuman`/`fetchReview`/the connector write port are trusted Host interfaces. Do not expose them as generic model tools or generic RPC dispatchers. The browser's real publication button checks native event.isTrusted; Host checks Connection authentication, session ownership, configured KB, immutable version author, frozen payload digest, token binding and expiry. `userInitiated:true` alone does not grant a capability. Browser isTrusted is a UI guard, not cryptographic proof of a physical person against a compromised authenticated client. The trust boundary is the authenticated desktop UI plus absence of an Agent publishing interface.

Only publication execution creates the connector's `createReviewHost()` port and calls `approve`/`execute` in its closure. Opaque connector capabilities never leave Host. Plan token is random 256-bit, process-local, expiring and consumed once before execution; bound session/report/version/plan/digest prevents rebinding. Report-level locks prevent concurrent attempts. A durable `executing` record is written **before** the remote effect. Crashes/unknown/submitted results block another plan pending trusted reconciliation; there is no automatic retry.

Core currently accepts only publication status succeeded/failed. This Host intentionally writes `failed` with detailed `phase:'executing'|'submitted'|'unknown'|'failed'` until remote parsing/retrieval is verified. It never equates submitted with published. Latest record per plan is used, so confirmed failed attempts can be replanned, but submitted/unknown/executing require explicit trusted reconciliation. Connector result IDs/parse states are retained in private publication record details for that reconciliation. Read-only reconciliation actions are now implemented below; UI integration is separate, and automatic indexed-success promotion remains unimplemented.

### Round 2 read-only remote reconciliation

`publicationStatus` and `reconcile` actions accept `{action,sessionId,reportId,planId?,saveToken?}`. Any additional input, including arbitrary remote IDs/KBs, is rejected. Both require the authenticated local UI route and core session/report ownership; neither is registered as an Agent tool. `publicationStatus` reads persisted plans/attempts only. `reconcile` selects each plan's latest durable attempt, uses only its recorded `remote.id` and plan target with `connector.status` (or `detail` if absent), and performs no remote writes, title search, upload retries or auto-polling. No current in-memory publish token is required after an API restart.

Return shape: `{records:[{planId,versionId,status,phase,remoteId?,parseStatus?,parseReady,published:false,indexingVerified:false,outcomeUnknown,automaticRetry:false,checkedAt?,message,warnings}],published:false,indexingVerified:false,warnings}`. List contains one latest safe projection per plan, including never-executed plans as `planned`; no raw payload, key, network diagnostics or local paths. Optional planId selects an existing plan or returns NOT_FOUND.

Reconcile serializes against upload/reconciliation per report. Known IDs are read once each with ID/KB response checks. `parse_status:completed` means only `parseReady:true`, never full publication/indexing acceptance. Pending summary/subtasks show `SUMMARY_OR_SUBTASKS_PENDING`. A successful verification appends core status `failed` with phase `submitted` and an allowlisted observation. Missing IDs in executing/submitted/unknown attempts remain `unknown` with manual-check explanation; no top-k/title guessing. Network failures append sanitized failed-read observations without upload retry and do not clear the publication guard. Unknown results with known IDs can become submitted only upon a matching read response. There is no action to promote indexed success or release a blind retry.

Four new fake-connector fixtures cover API restart persistence, wrong-session and remote override rejection, no-ID/no-search behavior, completed-only parsing, summary pending and network/scope failures with zero remote writes. `test/reconciliation.test.mjs` plus existing Host/warnings tests: 18 passed. No product server, live KB access, app restart or GUI acceptance in this work.

### Explicit MVP limits (not full RUN-19 acceptance)

- Images are unsupported by the connector: plans containing assets or image syntax block `IMAGES_UNSUPPORTED`; no partial text-only upload masquerades as full image-report publication.
- Text-only publication is available, with warning `TEXT_ONLY_MVP`; independent human intelligence entries, public annotation footers in remote Markdown, tag/collection workflows and latest-effective-version retrieval filtering are not completed here. The plan warns `NO_INDEPENDENT_HUMAN_ITEMS`, `REMOTE_INDEXING_NOT_VERIFIED`; no complete RUN-19 publish success is claimed.
- No publication reconciliation UI, parser-status polling, known-answer retrieval acceptance or active-version switching. All successful POST receipts are submitted only.
- Generation calls existing source with a selected input projection, reads each declared file beneath trusted staging/run directories, rejects symlink files/path escape and validates sha256/byte counts before passing assets to core snapshot creation. Absolute source paths are never returned. Trusted staging is assumed not adversarially modified between validation and core import.
- Generator provenance is retained as a private core marker, omitting undefined optional manifest fields. Client-supplied materials/paths/commands are ignored. `includeKnowledge:true` calls connector.search(config.publishKbId, knowledgeQuery ?? query ?? variety, {matchCount}), default 5 and maximum 20. Off means no search. Only id/knowledgeId/title/text are converted into source materials; scope-mismatched or malformed responses reject. Excerpts are explicitly unverified and latest-version filtering is NOT implemented (returned warnings); retrieval may invoke embedding. Empty retrieval is visibly warned. `webSearchEnabled:true` rejects WEB_SEARCH_UNAVAILABLE before generation because no actual web service is wired; it never silently implies successful web search.
- No free PDF editing, PDF selection-to-MD mapping, arbitrary client annotations/author edits, external editor synchronization, multi-user collaboration, global report catalog, quota/garbage collection or durable PDF-link store.
- Body limit is checked after Connection buffered the HTTP request; Connection/server global request limits must also be configured if required for transport memory defense.

## Human information review (Round 3)

Authenticated human-only actions `humanItems` and `saveHumanItems` use `{sessionId,reportId,saveToken?}` and on save require `saveToken,items`. Each item accepts only annotationId/category/selected/visibility/publicSource?/localNote?; category is supplement/correction/retraction/judgment/style and visibility public/local. Unknown fields, duplicate IDs and stale tokens reject. Core validates annotation ownership; confirmed drafts require a new revision. Defaults come from core: unselected, local-only. Getter/save return `{reportId,saveToken,status,items,warnings}` projected without localNote or arbitrary metadata; the current content is the core-verified annotation quote only. Low-confidence/stale targets and unsupported deleted retractions are visible.

Client saves then reloads the draft to obtain the new saveToken, retaining the updated settings panel. This is local review preparation, not independent remote ingestion. Any nonempty public `exportVersion.humanItems` blocks publishPlan with `HUMAN_ITEMS_PUBLICATION_UNSUPPORTED`; it cannot silently drop the user's selected intelligence. Agent tools expose neither action. Local note UI is intentionally absent; client payload omits it and core preserves existing notes on omission.

Round 3 tests: human-items exact field validation, scope/token/frozen-draft enforcement, private note response exclusion, selected-public publication blocking, and no Agent tools; Client controls and payload omit localNote. Entire review suite 35/35 passed with actual core and fake connector, no live writes or GUI acceptance.

## Optional Agent read/save tools

`registerReviewTools(ctx, api = ctx.get('reportReview'))` is an opt-in helper to call from a trusted Agent-scoped plugin. Do not auto-register it globally. It registers only `run19_report_list`, `run19_report_read` and `run19_report_save`; returns the combined disposer. `src/tools.mjs` is an opt-in default plugin with inject ['tools','reportReview'] for Agent-preset integration by explicit file path. It does not modify the installation patch or package exports. List requires no arguments and discovers current-session report IDs. All three tools derive the session from exec.agent.id. ToolDefinition was verified via exact Host Service Inspect `tools`: `register(definition)`; JSON-schema parameters/output; `execute(args,exec)` returns JSON; `exec.agent.id` identifies calling session.

Both tools derive sessionId from exec.agent.id, never a model argument. Save requires reportId/saveToken/markdown/source (`user_prompt` or `agent_inference`), optional private instruction. Human prompt attribution remains the caller's responsible selection and is not automatically fact verification. Tool output is a safe draft projection. No tool offers confirm, audit, publishPlan, publish, token retrieval, connector approve/execute or generic dispatch.

## Verification

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/host.test.mjs
```

13 tests pass with actual report-core, fake services and no listening server, including a real existing generator manifest and its four PNG files imported into actual core snapshots, opt-in tools registration, knowledge search allowlisting/off behavior and explicit web unavailability: formal registration; persistence-backed list/draft/privacy; session and token conflicts; upload-credential identity/fake author rejection; authorized and stale PDF retrieval; annotation exclusion; one-time publish plan/replay/unknown-safe records; image blocking; sanitized errors; generated manifest hash/root validation; exact ToolDefinition and Agent scope. Fixture PDF only tests transport/magic, not PDF renderer graphical fidelity. Test suite does not install or validate production GUI activation, perform live writes, real embedding, or confirm full P0–P6 acceptance.
