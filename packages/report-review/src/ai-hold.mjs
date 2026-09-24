// Gate that keeps the document out of Markdown serialization while an AI edit is mid-flight.
//
// Why this exists: AI edits land through prosemirror-suggest-changes, which does NOT remove
// replaced content. A deletion is a `deletion` mark over text that stays in the document, an
// insertion is marked too, and deletions on a textblock boundary insert a zero-width space.
// So between `thinking` and the user's accept/reject the document holds the old AND the new
// content at once. Serializing that shape produces Markdown that is not merely ugly but
// invalid — a half-rewritten table loses its column grid — and `saveBlockMarkdown` can throw
// outright, which used to flip the editor into its permanent "cannot edit visually" fallback.
//
// The executor applies each operation as its own transaction (with typing delays), so a single
// AI edit fires hundreds of change events; every one of them used to be serialized.
//
// Kept free of React and DOM so it can be unit-tested without a browser.

// AIExtension exposes `aiMenuState` on its store: "closed" | { blockId, status }, where status
// is one of user-input | thinking | ai-writing | user-reviewing | error (see AIExtension.ts).
// `user-input` is the prompt box before any model call, so the document is still clean there.
// `error` holds too: a failed run can leave suggestion marks behind until the user dismisses it.
const HOLD_STATUS = new Set(['thinking', 'ai-writing', 'user-reviewing', 'error']);

export function isAiHolding(aiMenuState) {
  if (!aiMenuState || aiMenuState === 'closed' || typeof aiMenuState !== 'object') return false;
  return HOLD_STATUS.has(aiMenuState.status);
}

/**
 * Tracks whether serialization is currently held, and guarantees exactly one settle flush.
 *
 * `flush(final)` is supplied by the caller. `final` is true only for the post-AI settle, which
 * is the one moment a serialization failure is genuinely fatal — mid-AI failures are expected
 * and must be swallowed.
 */
export function createHoldGate(flush) {
  let holding = false;
  let pending = false;
  return {
    get holding() { return holding; },
    get pending() { return pending; },
    /** An editor change. Returns true when it was serialized and bubbled. */
    onChange() {
      if (holding) { pending = true; return false; }
      flush(false);
      return true;
    },
    /** A new AIExtension store state. Drives the hold and the settle flush. */
    onAiState(aiMenuState) {
      const next = isAiHolding(aiMenuState);
      const was = holding;
      holding = next;
      // Falling edge. Both acceptChanges() and rejectChanges() call closeAIMenu() last, after
      // their document transactions are dispatched, so by now the suggestions are applied or
      // reverted and the document is final. Without this flush the AI's result would never be
      // bubbled to the workspace and would never be saved.
      if (was && !next && pending) { pending = false; flush(true); }
    },
  };
}
