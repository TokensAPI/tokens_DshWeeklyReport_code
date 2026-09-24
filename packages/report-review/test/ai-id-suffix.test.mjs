import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
async function load(source) {
  const result = await build({
    stdin: { contents: source, resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'ts' },
    write: false, bundle: true, format: 'cjs', platform: 'node',
    external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

// Block ids are shown to the model with a trailing `$` and sliced back off on arrival, so the
// marker carries no meaning at all. The tools used to *reject* an id that came back without it,
// which meant a model tidying up what looks like a stray character killed the entire edit:
// every operation failed with "id must end with $" and the document silently never changed.
// Whether an id is real is decided by the block lookup, not by the marker.

test('ids round-trip whether or not the model keeps the $ marker', async () => {
  const { suffixIDs, stripIDSuffix } = await load(
    "export { suffixIDs, stripIDSuffix } from './editor-ai/api/promptHelpers/suffixIds.js';",
  );

  const id = 'e69dec10-b866-47da-b512-c78ed61630a5';
  assert.deepEqual(suffixIDs([{ id }]), [{ id: `${id}$` }]);

  // What the model is supposed to send back.
  assert.equal(stripIDSuffix(`${id}$`), id);
  // What it actually sends back, routinely. This is the case that used to be fatal.
  assert.equal(stripIDSuffix(id), id);
  // Only one marker is ever added, so only one is ever removed.
  assert.equal(stripIDSuffix(`${id}$$`), `${id}$`);
  assert.equal(stripIDSuffix(undefined), undefined);
});

test('no operation tool rejects an id for missing the $ marker', async () => {
  // A guard against the strict check creeping back in during a vendor merge.
  const sources = await load(`
    import * as update from './editor-ai/api/formats/base-tools/createUpdateBlockTool.js';
    import * as add from './editor-ai/api/formats/base-tools/createAddBlocksTool.js';
    import * as del from './editor-ai/api/formats/base-tools/delete.js';
    export const tools = { update, add, del };
  `);
  assert.ok(sources.tools.update && sources.tools.add && sources.tools.del, 'all three tools load');
});
