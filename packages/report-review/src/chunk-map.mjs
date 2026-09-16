// chunk-map.mjs
//
// Maps a published knowledge's chunks (seeded with a baseline markdown) onto the
// human-edited report, so each chunk can be rewritten via `updateChunk`. That makes
// weKnora natively record content/content_revision/last_editor_id/chunk_revisions with
// edit_source='user' while `source_content` stays = the LLM baseline. This is the
// "single knowledge + revision history" flow.
//
// weKnora chunk model (confirmed): each chunk has `content` (current segment),
// `start_at`/`end_at` (character offsets into the ORIGINAL seed text — they are NOT
// advanced by updateChunk), `chunk_index`, `content_revision`. After a prior human patch
// the chunk's `content` is a segment of the last-published version, while start_at/end_at
// still point into the seed text. We therefore locate each chunk by finding its `content`
// inside the base text (falling back to start_at/end_at), then map that base line range
// through a base<->target alignment to the new text.
//
// Pure functions; no store/connector dependency, so it is unit-testable.

import { diffLines } from './review-marks.mjs';

/** Absolute char index at which each 0-based line starts. */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 0-based index of the line that contains `offset`. */
function lineIndexOf(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * Compute, for every target line, the base-line index its content is anchored to.
 * - a 'same' target line is anchored to the base line it matched;
 * - an 'add' target line is anchored to the most recently encountered base line
 *   (so a replacement of a deleted line is attributed to that deleted base index,
 *   keeping it inside the chunk that originally held it).
 * Returns null when the LCS fell back to a coarse block replacement.
 */
function targetBaseMap(baseLines, targetLines) {
  const ops = diffLines(baseLines, targetLines);
  if (ops.some(op => op.op === 'delblock' || op.op === 'addblock')) return null;
  const targetBase = new Int32Array(targetLines.length);
  let bi = 0, tj = 0, lastBaseAnchor = 0;
  for (const op of ops) {
    if (op.op === 'same') { lastBaseAnchor = bi; if (tj < targetBase.length) targetBase[tj] = bi; tj++; bi++; }
    else if (op.op === 'add') { if (tj < targetBase.length) targetBase[tj] = lastBaseAnchor; tj++; }
    else if (op.op === 'del') { lastBaseAnchor = bi; bi++; }
  }
  return targetBase;
}

/** Locate a chunk's base line range [lo, hi] (0-based inclusive), or null. */
function locateChunk(baseText, lineStarts, baseLineCount, chunk) {
  const content = typeof chunk.content === 'string' ? chunk.content : '';
  if (content) {
    let idx = baseText.indexOf(content);
    if (idx < 0) idx = baseText.indexOf(content.trim());
    if (idx >= 0) {
      const lo = lineIndexOf(lineStarts, idx);
      const hi = lineIndexOf(lineStarts, idx + content.length - 1);
      if (lo >= 0 && hi >= lo && hi < baseLineCount) return { lo, hi };
    }
  }
  if (Number.isSafeInteger(chunk.start_at) && Number.isSafeInteger(chunk.end_at) && chunk.end_at > chunk.start_at) {
    const lo = lineIndexOf(lineStarts, chunk.start_at);
    const hi = lineIndexOf(lineStarts, chunk.end_at - 1);
    if (lo >= 0 && hi >= lo && hi < baseLineCount) return { lo, hi };
  }
  return null;
}

/**
 * For each weKnora chunk of a knowledge currently holding `baseText`, compute the
 * chunk's counterpart in `targetText`.
 * @returns {Array<{chunkId:string, content:string|null, changed:boolean, expectedRevision:number, error?:string}>}
 *   `content === null` means the chunk could not be located (caller should skip + warn).
 */
export function mapChunks(baseText, targetText, chunks) {
  const baseLines = (baseText || '').split('\n');
  const targetLines = (targetText || '').split('\n');
  const lineStarts = computeLineStarts(baseText || '');
  const targetBase = targetBaseMap(baseLines, targetLines);
  const mapped = [];
  for (const chunk of chunks || []) {
    const chunkId = chunk && typeof chunk.id === 'string' ? chunk.id : null;
    const rev = Number.isSafeInteger(chunk?.content_revision) ? chunk.content_revision : 0;
    if (targetBase === null || !chunkId) {
      mapped.push({ chunkId, content: null, changed: false, expectedRevision: rev, error: 'unmapped' });
      continue;
    }
    const range = locateChunk(baseText || '', lineStarts, baseLines.length, chunk);
    if (!range) {
      mapped.push({ chunkId, content: null, changed: false, expectedRevision: rev, error: 'unmapped' });
      continue;
    }
    const lo = range.lo, hi = range.hi;
    let acc = [];
    for (let j = 0; j < targetLines.length; j++) if (targetBase[j] >= lo && targetBase[j] <= hi) acc.push(targetLines[j]);
    const newText = acc.join('\n');
    const current = (typeof chunk.content === 'string' ? chunk.content : '').trim();
    mapped.push({ chunkId, content: newText, changed: newText !== current, expectedRevision: rev });
  }
  return mapped;
}
