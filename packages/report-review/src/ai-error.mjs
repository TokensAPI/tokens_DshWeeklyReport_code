// Turn whatever the AI pipeline failed with into one readable line.
//
// Worth its own module because the failure that motivated it was invisible: ChunkExecutionError
// keeps the real reason in `message`, and `message`/`cause` are both non-enumerable, so the
// object logged to the console serializes to `{aborted, chunk, name}` — the interesting part is
// gone by the time anyone copies it. Executor failures also arrive wrapped as `{ok:false,error}`
// results rather than thrown errors, and the actual cause is often one `cause` hop further down.

const messageOf = e => {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string' && e.message) return e.message;
  return '';
};

export function describeAiError(input, maxDepth = 4) {
  // Executor results are `{ok:false, error}`; thrown errors arrive bare.
  let node = input && typeof input === 'object' && 'ok' in input && 'error' in input ? input.error : input;
  const seen = [];
  for (let depth = 0; node && depth < maxDepth; depth++) {
    const message = messageOf(node);
    if (message && !seen.includes(message)) seen.push(message);
    // `cause` carries the underlying failure; some call sites put a detail object there instead.
    const next = node.cause;
    if (next && typeof next === 'object' && !messageOf(next)) {
      const detail = Object.entries(next)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      if (detail && !seen.includes(detail)) seen.push(detail);
      break;
    }
    node = next;
  }
  return seen.join(' ← ') || '未知错误';
}
