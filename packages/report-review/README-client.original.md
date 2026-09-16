# RUN-19 report-review Client

## Scope

Formal TokensCowork Client bundle only. Host `src/index.mjs`, composition, installation and server routes are parent-owned. This work does not start a server, edit a composition, install into the GUI, or write WeKnora.

- `src/client.jsx`: session header action -> large in-GUI review dialog, CM6 Markdown, real PDF object, auto-save, cautious Agent polling, diff using bundled `@codemirror/merge`, versions, identity gate, publish-plan review and click-only publish request.
- `scripts/build-client.mjs`: esbuild browser CJS inside lazy `window.__ModuleLoader__.load({id:'dsh-report-review',factory})` wrapper.
- `package.json`: `dsh.client.platform=web`, `./client=./lib/client.js`. React/runtime external; CodeMirror bundled. Host export is `./src/index.mjs` (parent responsible).
- `test/client.test.mjs`: eleven Node VM/helper contract tests. These do NOT prove real browser mounting, PDF integration, lifecycle race correctness, accessibility, or backend behavior.

## Round 3 — local human information review

The `重点人工信息` button loads human annotation candidates via humanItems. Each current block can be selected (default false), classified as supplement/correction/retraction/judgment/style, marked public/local (default local), and given a bounded public source explanation. Settings submit only through saveHumanItems with the panel's saveToken; after success the current draft is reloaded for its new saveToken and the saved panel remains visible. Confirmed drafts are read-only until startRevision. Local notes have no first-version control and are never included in client payload. Deleted-original retractions remain unsupported and explicitly disclosed.

UI clearly labels local confirmation / publication preparation, not remote ingestion. Independent human-item publication is not implemented; Host refuses selected public entries rather than silently dropping them. Client helper/control tests now 14/14 pass; total review Host+Client tests35/35. Actual GUI acceptance still pending.

## Deployment status / restart

Actual GUI activation is **not verified**. The packaged Electron launcher may not watch composition patches. Fully quit and restart TokensCowork after parent installs the package; refreshing alone may not load the Host. If the Client itself is not loaded, no header button can be shown. If the Client is loaded but its Host route returns 404, the dialog now explicitly recommends a full TokensCowork restart and then Host installation/log checks; non-JSON responses also show restart/troubleshooting guidance rather than claiming success.

Eleven VM/helper contract tests pass including missing-Host guidance and the four Client regressions below. Parent owns archive/repack and installation; this Client task provides built artifacts only, not an installed-GUI acceptance receipt.

## Generate entry

The dialog includes a **生成周报** form: variety defaults to 锡, end date defaults to local calendar today, `includeKnowledge` defaults true and can be unchecked, and `knowledgeQuery` is optional. Submitting calls action `generate` with `{variety,end,includeKnowledge,knowledgeQuery}`. Host should return a flat draft (or `{draft}`); the result becomes the current working draft and enters automatic PDF preview. Dirty drafts/in-flight saves/busy operations block generation so local edits are not replaced. Failures leave the current draft in place. Actual data generation remains Host-owned.

The UI explicitly states **联网搜索暂未接入** and supplies no misleading enabled search toggle. `generate` does not send web-search options. Inputs are locally checked for nonempty variety and a valid ISO calendar date, with authoritative validation still required on Host.

Client contract tests cover generation payload, disabled knowledge selection, date validation and absence of a fake web-search flag. No additional real-GUI integration claim is implied.

## Client regression repair

This repair changed only `src/client.jsx`, `test/client.test.mjs`, this README and generated `lib/client.js`; no Host/package/composition changes, real knowledge writes or server startup.

- Confirmed drafts are read-only (CodeMirror and onChange/save guards). The UI explains that “开启新一轮修订” must create a new working draft; that button is enabled only for confirmed drafts. Unknown draft status is fail-closed/read-only.
- Synchronization requires a matching clean **ready** receipt and matching loaded PDF token/digest. Failed/pending/stale receipts cannot certify an existing PDF as synchronized; matching failure receipts are still kept so failure state and warnings are visible.
- PDF effect identity includes URL, digest **and saveToken**. An identical cached resource under a new token reloads/rebinds its receipt; old Blob ownership is revoked on effect cleanup. This is contract-tested, not a claim of tested browser race behavior.
- Generation/draft/preview warning codes are visibly listed, notably missing knowledge-version filtering and low-confidence attribution. Only bounded uppercase code tokens are echoed with fixed explanations; arbitrary detail strings/objects (including paths and URLs) produce `WARNING_DETAILS_REDACTED`, never raw warning details. Same-report generation warnings are conservatively retained across polling; switching reports clears that retained warning list.

Validation: actual Electron RunAsNode build succeeded (`lib/client.js` 1,019,861 bytes); **11/11 tests pass**, 0 failures. Tests include readonly predicates and wiring, non-ready synchronization rejection, same-digest/new-token effect keys, and warning redaction. Actual GUI mount, interaction and PDF lifecycle remain unverified.

## Round 2: read-only publication records and reconciliation

The header **发布记录** button calls `publicationStatus`. Its result panel includes **只读核对**, which calls `reconcile`. Both use a dedicated `readPublication(sessionId, reportId, action)` helper restricted to these two actions and submit only `{reportId, action, sessionId}`. No publish token or retry flag is sent; errors never fall back to `publish`. No automatic reconciliation polling was added. Existing draft polling is unchanged.

Host contract: `{records:[{planId,versionId,status,phase,remoteId?,parseStatus?,parseReady?,indexingVerified:false,published:false,outcomeUnknown?,checkedAt?,message?}],warnings?}`. The panel renders bounded identifier/status/time fields and fixed status explanations, not arbitrary remote message text. Warning values use the existing safe warning code projection. Host must implement reconciliation as remote read-only status lookup plus local audit update, not upload/reparse/delete.

A submitted upload receipt explicitly invites read-only reconciliation, and **解析就绪** always appears alongside **检索未核验，未标记发布完成**. Unknown/executing/failed records never instruct automatic retransmission. No automatic success promotion is implemented in Client.

Validation: actual Electron RunAsNode build succeeded, bundle 1,027,093 bytes, **13/13 tests pass**. Two new tests execute the dedicated request helper (including failed-reconcile no-retry behavior), execute the record buttons' handlers against a captured action callback, and verify submitted/parse-ready/unknown wording. Confirmed readonly, PDF guards and safe warnings remain regression-tested. No Host/package/composition change, real WeKnora write, GUI restart or actual browser acceptance in this task.

## Build

Normal Node environment:

```
pnpm install
pnpm run build:client
pnpm run test:client
```

This environment has a managed pnpm wrapper and no PATH node. Installation resolved/downloaded dependencies and wrote `pnpm-lock.yaml`, but pnpm exited 1 because esbuild's lifecycle script was unapproved (`ERR_PNPM_IGNORED_BUILDS`). No lifecycle approval was requested/bypassed. The platform binary package was available, so the actual build and six tests succeeded using:

```
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork scripts/build-client.mjs
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/client.test.mjs
```

Build output: `lib/client.js`, approximately 1 MB unminified with inline third-party legal comments. A complete dependency license inventory remains an integration deliverable.

## Transport evidence and contract

`inspection/dsh-client-connection/lib/client.js:5065-5066` selects `globalThis.__DSH_TRANSPORT__?.fetch`. Its service handle exposes `rpc`, **not** a generic `connection.fetch` client method. Therefore this client mirrors the evidenced transport choice:

- `globalThis.__DSH_TRANSPORT__?.fetch || globalThis.fetch`.
- HTTP origin from page; opaque/file origin uses `http://dsh.internal`, matching connection RPC's fallback.
- POST `/api/run19/review` with JSON `{...data,action,sessionId}`.
- response `{ok:true,value}` or `{ok:false,error:{code,message}}`.
- credentials `same-origin`; only same-origin HTTP(S) resource URLs accepted.
- Host must register authenticated `connection.fetch` routes, not an unguarded webserver handler. This is not a cookie bypass: Electron's official transport owns the IPC bridge and Host authentication boundaries remain required.
- PDF URL is obtained from preview and fetched through the same transport. Bytes must start `%PDF-`; Client creates/revokes an owned PDF Blob URL. Server URLs are never embedded directly (important for Electron file-origin).

### Value shapes

- `list`: report array or `{reports:[{reportId,title}]}`.
- `create`: `{title,markdown,assets:[]}` -> flat draft.
- `get`, `save`, `startRevision`: flat draft `{reportId,title,markdown,saveToken,assets}`; `{draft}` / `{workingDraft}` wrappers also accepted.
- `save`: `{reportId,saveToken,markdown}`; stale tokens must be rejected, never silently overwrite. Save receipt must contain new saveToken.
- `preview`: `{status,saveToken,digest,pdfUrl,warnings?}`; pending/queued/rendering/running are polled. Matching receipts can update visible status, but only `status:'ready'` + matching saveToken + nonempty digest can certify synchronization. PDF asset effect keys include saveToken. Host must ensure digest identifies the exact requested assets/renderer state.
- `identity`: `{confirmed:true,displayName}` required to enable confirm/publish. False/unknown blocks; never defaults to admin.
- `audit`: preferably `{baselineMarkdown,changes:[...]}`. Without explicit baseline, no fabricated diff is shown. Local audit is rendered as local structured details.
- `versions`: array or `{versions:[{versionId,title,markdown}]}`. Markdown is needed for version content view.
- `confirm`: called only on button, then versions/get refresh. Host enforces identity and immutable version semantics.
- `publishPlan`: `{reportId,versionId}` -> public-only plan `{versionId,planId,digest,publishToken,...}`.
- `publish`: only trusted human button event -> `{reportId,saveToken,versionId,planId,digest,publishToken,userInitiated:true}`. Host MUST validate authenticated session + one-time token/version/digest, and enforce actual backend identity/assets support. Client isTrusted is not a standalone security boundary.

## Safety and limitations

- 650ms debounce saves. Dirty text or in-flight save blocks switching report/closing; MD export provides a manual copy. No discard button; failed drafts require save recovery or export and deliberate application exit.
- Agent get polling every five seconds accepts only if clean, no save in flight, same local revision. Agent can never overwrite dirty input. Server remains responsible for optimistic concurrency.
- Save failure stops automatic retries and retains text. Manual retry is available. There is no automatic merge resolution UI yet; diff/local export are available.
- Actual PDF requests are coalesced by effect cleanup, preview token checks and transport cancellation. Server must independently prevent stale asset/result publication. Rendering latency, PDF scroll persistence and actual browser PDF support are not validated.
- No HTML rendering substitute; Markdown is text/code editor. No PDF direct editing, select-to-source mapping, or highlighting provenance implementation in Client; rendering provenance belongs to renderer/core.
- Audit and plans are displayed as structured JSON (MVP), not polished editable human-information classification forms. Baseline diff depends on Host field availability. Versions without markdown cannot show full text.
- Known unverified identity intentionally prevents confirmation/publication; this is a safety gate, not a finished identity feature. No fake successful WeKnora publication claims.
- Published status, versions, failure recovery, assets support and immutable snapshots are Host responsibilities. The UI displays Host errors rather than treating unsupported operations as success.
- No real TokensCowork mount/refresh/installation/browser testing was performed in this Client-only task; parent owns integration. Do not claim HMR or completed P0/P2 based on build tests alone.
