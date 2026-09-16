# Publication manifest preparation (Round 4 → Round 5)

Pure Host-side helpers in `src/publication-manifest.mjs`. These functions do not read local assets, write WeKnora, authorize publication, or change the current UI/index image/selected-human publication blocks. They are not model Tools.

**Round 5 integration**: the `report-review` Host `publishPlan`/`publish` route now consume these helpers. `publishPlan` calls `preparePublicationManifest` on the confirmed version to freeze the ordered image→report→human plan and persist its digest + per-item intents; `publish` re-prepares from the immutable version, uploads images via the connector one-shot `publishImage` capability, binds the returned `resource://<22>` handle, resolves the report Markdown with `resolvePublicationMarkdown`, then publishes the report (`publishReport`) and each selected-public human item (`publishManual`). Each item is recorded with a durable intent before any remote effect and a per-item outcome; no automatic retry; only a human click may start publish. **Deployment write/parse/display acceptance is still unverified** — all Round 5 evidence is offline fake-connector.

## Contract

`preparePublicationManifest(publicVersion, {kbId})` accepts the `report-core.exportVersion` projection and returns a recursively frozen owned `{reportId,versionId,target,title,items,digest,warnings}`. Input assets contain `{id,sha256,path}` but paths are never copied into the plan. The coordinator must retain core's trusted version snapshot to obtain upload bytes and separately verify hashes; this pure function cannot prove file contents.

Items are ordered image -> report -> human. Image items include key/type/assetId/sha256/hash/title/caption/index. Report items contain the asset-based `markdown` template and hash. Human items contain an explicit public projection with report/version/annotation association, category/content/source/publicSource and original author/time. Their IDs must match a public human annotation with exactly matching quote/source/author/time. Core's export has already filtered selected public non-style items; explicit private/unselected inputs are rejected. Arbitrary private fields are never copied.

The digest binds target, report identity/version, MD template, asset IDs/hashes/captions, selected human items and warnings; changing local paths or private fields does not change it. Same asset repeated with the same caption produces only one upload item. Different captions for one asset, duplicate asset descriptors, missing/unregistered/unreferenced assets, malformed/reference-style images, HTML and data/file/preexisting resource schemes fail explicitly. Only simple `![caption](asset:id)` is supported. Ordinary HTTP text/source links are retained and are never fetched by the helper; external image destinations are rejected.

Public-source descriptions cannot contain image syntax; title, displayName and public-source metadata are Markdown-escaped before interpolation into generated text to prevent metadata-driven image injection. Ordinary source URLs in the original report stay inert and are not fetched.

Public attribution footers preserve author/time, formatted `yyyy-mm-dd-hh-mm` using the original timestamp offset representation. The footer explicitly says remote bold+underline rendering has not been verified; no unsupported `<u>` markup is inserted and no remote-style success is claimed.

`resolvePublicationMarkdown(manifest, bindings)` returns a new report Markdown string, leaving both input version and prepared template unchanged. Bindings are an array of exactly `{assetId,sha256,kbId,resourceUri,knowledgeId}` from the trusted connector. IDs/hash/KB must match, every image must have exactly one binding, unknown/duplicate/missing bindings fail. Resource URI grammar is `resource://[A-Za-z0-9_-]{22}`, based on WeKnora `internal/types/resource.go` `ResourceHandleLength`/`ParseResourcePath`. No query/path/fragment/public URL is accepted.

Only an in-process object returned by prepare is accepted by resolve. After process restart, reprepare from the immutable core version, compare the stored digest, then resolve using separately persisted verified connector receipts. This provenance fence is not proof that a resource exists: the coordinator must validate the connector/server receipt, claims, parse and rendered-image behavior. Neither arbitrary browser bindings nor model-provided `userConfirmed:true` are valid authorization.

## Validation

Seven pure tests cover ownership/freeze/private suppression, stable digest despite paths, changed content hashes/human metadata, image ambiguity/missing references, human linkage and strict resource replacement. Run with bundled Electron Node:

```
ELECTRON_RUN_AS_NODE=1 /Applications/TokensCowork.app/Contents/MacOS/TokensCowork --test test/publication-manifest.test.mjs
```

No actual remote publication or image rendering acceptance is performed by these tests.
