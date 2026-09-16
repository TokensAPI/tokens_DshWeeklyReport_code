# @run19/report-core 0.1.0

Independent, dependency-free Node ESM package (Node >=20). Markdown is the only report body; no rendered HTML/PDF is persisted as a competing source of truth.

```js
import reportCore, { ReportStore, ReportError } from '@run19/report-core';
const store = new ReportStore({ rootDir: '/absolute/private/report-data' });
const draft = await store.createDraft({ sessionId: 's1', title: 'Report', markdown: '# Hello' });
const saved = await store.saveDraft({ sessionId: 's1', reportId: draft.reportId,
  saveToken: draft.saveToken, markdown: '# Updated', source: 'user_direct' });
const v1 = await store.confirm({ sessionId: 's1', reportId: draft.reportId,
  saveToken: saved.saveToken, author: { authorId: 'u1', displayName: 'Alice' } });
```

Default Cordis plugin: `apply(ctx, { rootDir })` provides `reportCore` using `ctx.provide('reportCore', store)`. Provide syntax verified against existing `run19/inspection/dsh-client-connection/lib/client.js:5171`. No composition, deployment, or registration was changed. Cordis owns the service lifetime; the store holds no timers or open persistent handles.

## Contract

Every method is async and returns detached plain data. Every report operation takes `{sessionId, reportId}`; wrong session and missing reports both throw `ReportError` with `code: 'NOT_FOUND'`. The caller must derive sessionId from authenticated session context, never trust arbitrary browser input. `rootDir` is a private trusted application directory, not a user-selected writable shared directory.

| Method | Additional inputs | Return |
| --- | --- | --- |
| `createDraft` | `sessionId,title,markdown,assets?[],markers?[],annotations?[],source?` | draft; source defaults to agent_inference |
| `listDrafts` | `sessionId` only | session-scoped summaries, newest first; includes confirmed reports |
| `getDraft` | — | draft |
| `getHumanItems` | — | private local review view (see below) |
| `saveHumanItems` | `saveToken,items[]` | private review view with new saveToken; full setting replacement |
| `saveDraft` | `saveToken,markdown,source,instruction?,author?,markers?,annotations?` | updated draft with new token |
| `snapshotAssets` | `saveToken,assets[]` | updated draft with new token and asset path mapping |
| `confirm` | `saveToken,author:{authorId,displayName}` | immutable version |
| `startRevision` | `versionId,saveToken?` | draft copied from that version |
| `getVersion` | `versionId` | immutable version |
| `listVersions` | — | `{versionId,contentHash,author,completedAt,baseVersionId}[]` |
| `getAudit` | — | **private** complete audit entries |
| `exportVersion` | `versionId` | public body/metadata projection for renderer; see privacy below |
| `savePublicationPlan` | `versionId,target,payload?` | append-only `{planId,reportId,versionId,target,payload,createdAt}` |
| `recordPublication` | `planId,status:'succeeded'\|'failed',details?` | append-only `{recordId,planId,reportId,status,details,recordedAt}` |
| `listPublicationPlans` | — | private plan array |
| `listPublicationRecords` | — | private attempt array |

A draft contains `reportId,sessionId,title,markdown,assets,markers,annotations,saveToken,status:'draft'|'confirmed',baseVersionId,updatedAt`. A version contains `versionId:'V1'|'V2'|...,reportId,title,markdown,assets,markers,annotations,contentHash,confirmedFromToken,baseVersionId,author,completedAt`. Versions are never mutated. Timestamps are ISO strings.

`source` must be `user_direct`, `user_prompt`, or `agent_inference`. Save audit includes before/after Markdown, source, optional instruction/author, and before/after markers. Instructions and deleted body content stay in private audit. Arbitrary marker/annotation structures are retained in snapshots across revisions. Annotation objects may use `{id,target:{startLine,endLine,quote?},source,public,displayName,completedAt}`. Without explicit replacement annotations, saves automatically compare semantic blocks: heading, paragraph, table, list, blockquote, image, code and rule. Boundaries mirror report-pdf renderer.py; list/quote kinds share its paragraph boundaries. Unique identical blocks inherit original annotation IDs, source, author and completion time, with relocated full-block line range/quote. Changed/new blocks receive pending annotations using the save source; user_direct/user_prompt are public, agent_inference is not. Repeated identical blocks are marked low-confidence with ANNOTATION_AMBIGUOUS_BLOCK warnings and private provenanceCandidates, never silently assigned to the new human author. All new automatic annotations include full-block quote and 1-based inclusive line ranges. Confirm fills only pending annotations with the current authorId/displayName/completedAt, preserving frozen historical metadata. Initial unspecified source is agent_inference, so a human one-paragraph save never relabels the untouched generated document as human. Explicit annotations are a trusted internal override; review must validate identity and avoid forwarding arbitrary client-supplied provenance.

`confirm` uses Markdown plus ordered asset manifest to identify content. It creates the next V-number only when content differs from the latest version. Repeated same-token confirmation is idempotent; a no-change revision returns the original version, preserving original author and completion time. Metadata/annotation-only edits do not create a new version. Confirmed drafts cannot be saved: call `startRevision`. Starting a revision while an editable draft exists throws `DRAFT_EXISTS` to avoid data loss. Stale tokens throw `CONFLICT`. Other typed errors: `INVALID_INPUT`, `REVISION_REQUIRED`, `ASSET_CORRUPT`; native IO/JSON errors propagate.

## Local priority human-information review

`getHumanItems({sessionId,reportId})` and `saveHumanItems({sessionId,reportId,saveToken,items})` return `{reportId,saveToken,status,items,warnings}`. Each local item has `{id,annotationId,category,selected,visibility,publicSource?,localNote?,source,mappingConfidence,stale,content?,unsupported?}`. This local view contains private notes and must not be serialized into publication. An unset current human annotation appears with `category:'supplement',selected:false,visibility:'local'`. Stable `id = 'human_' + annotationId` is scoped by reportId. `content` exists only when the current annotation matches a complete current Markdown semantic block with reliable mapping. Inference/unchanged generated blocks are not selectable human items.

Save accepts only `{annotationId,category,selected,visibility,publicSource?,localNote?}` per item, where category is `supplement|correction|retraction|judgment|style`, selected is boolean, visibility is `public|local`; optional text is bounded to 8192 characters. Full array replaces settings; omitted annotations revert to unselected/local defaults. Existing item's omitted localNote is retained; explicit empty string clears it. Unknown/nonhuman/duplicate annotation IDs and additional fields (including id/content/before/after/source) are rejected. Caller cannot fabricate quoted content or provenance. All saves use the same atomic queue and saveToken as body editing, so a stale body/review writer conflicts. Confirmed settings are immutable; create a new revision first.

Confirmation snapshots settings as `version.humanItems`. Public `exportVersion().humanItems` is already filtered to selected, public, non-style and verified current human targets, with `{id,annotationId,category,content,source,publicSource?,authorId?,displayName?,completedAt?}`. Content comes only from validated annotation quote, never localNote, prompt, audit or caller payload. The public list has no selected/visibility flags: its presence means those filters passed. `getDraft/getVersion/getAudit` remain private and may contain notes. `publicSource` is explicit public user text, not automatically sanitized for user-typed secrets.

Body/image changes alone define versions. A settings-only re-review followed by confirm returns the original immutable version and restores its annotations/settings; it cannot quietly alter V1 or create V2. Audit retains the attempted local setting change. `startRevision` inherits the selected version's settings/IDs. When a body edit removes an annotation its settings are pruned; an unverified remaining target is marked stale and cannot export. Deleted retractions without current human text are explicitly `DELETED_RETRACTIONS_UNSUPPORTED`; no deleted text is resurrected into an independent fact. Retraction category is allowed only for an existing human annotation and does not certify truth or implement remote withdrawal.

## Assets and renderer integration

Only explicitly supplied `{path:'/absolute/file.png',markdownPath:'./file.png'}` descriptors are read; no directory scan, URL fetch, implicit dependency discovery or symlink import occurs. A missing markdownPath defaults to the supplied file path. Each result asset has:

```js
{ id: '<sha256>', path: '/root/assets/r_<uuid>/<sha256>', sha256: '<sha256>',
  hash: '<sha256>', snapshotPath: 'assets/r_<uuid>/<sha256>',
  markdownPath: './file.png', name: 'file.png', size: 123 }
```

`path` is the local snapshot file for the PDF renderer; `snapshotPath` is relative to root. Files are published via exclusive hard link from fsynced temporary bytes and are never overwritten. Existing bytes are hash-verified. Each report owns its asset namespace. `snapshotAssets` replaces the current draft manifest; old version assets/files remain untouched. It does not delete assets.

Common Markdown inline references `](./file.png)` and `](<./file.png>)` are rewritten to `](asset:<sha256>)`; replacing an asset also rewrites its previous asset ID. Returned Markdown and asset mapping are authoritative. Reference-style links, title-bearing destinations and complex escaped Markdown are **not parsed or automatically rewritten** in this MVP; callers must normalize them using the returned mapping. The module never fetches unregistered Markdown URLs; the renderer must reject unregistered/external references.

For PDF use `getDraft` for private preview or `exportVersion` for a confirmed/public renderer payload; add the caller's required saveToken if its adapter expects one. Renderer assets already have `{id,path,sha256}`.

## Public/private boundary

Do not serialize `getDraft`, `getVersion`, or `getAudit` into public exports. Use `exportVersion`, which explicitly selects title/current Markdown/assets/author/completion time and public annotations. It excludes session IDs, audit, prompts, prior/deleted bodies, tokens and arbitrary markers. Only annotations with explicit `public:true`, a user source, a target, and no low-confidence flag survive; only line target/verified full-block quote/source/authorId/displayName/completion time/id are emitted, never arbitrary annotation fields. Quote must match the current body exactly and the target must cover one full semantic block; stale quotes, image/rule annotations and low-confidence annotations are filtered out, matching PDF text-marking limits. This is a conservative projection, not a Markdown sanitization/redaction engine: text the user intentionally leaves in the current body remains public. Snapshot asset paths in this projection are **renderer-local transport**, not a publicly served JSON response; renderers must not print local paths into public documents. Publication payload/details are private operational data, not public export content.

## Persistence and limits

Reports are separate `reports/r_<uuid>.json` files containing draft, immutable versions, private audit and publication metadata. Writes use a mode-0600 temp file, fsync, atomic rename and parent-directory fsync. Mutations for the same report are serialized across all ReportStore instances within **one Node process**, and token checking occurs inside that queue. Reads see old or new complete state. Restart simply reloads files; no in-memory authoritative cache. Orphan temp/assets from process interruption are harmless but there is no garbage collector.

**Not a multi-process database**: only one Node process may own a root. Network filesystems, hostile local filesystem manipulation, external edits to stored JSON, distributed locking and filesystem corruption recovery are out of scope. JSON metadata must be JSON-compatible. Whole-document persistence favors small reports rather than huge histories. Publication methods record plans/attempts only: they do not publish, schedule, or deduplicate remote side effects.

## Tests

```sh
npm test
# In TokensCowork without node on PATH:
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test
```

Tests cover concurrent token conflicts across instances, restart recovery, immutable versions, same-content retry idempotency, all-method session isolation, asset snapshot integrity/symlink rejection, Markdown asset normalization, public annotation filtering, publication persistence and default plugin service provision.
