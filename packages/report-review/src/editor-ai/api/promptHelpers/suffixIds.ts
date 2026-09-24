export function suffixIDs<T>(source: Array<T>): Array<T> {
  return source.map((el) => {
    if (typeof el === "object" && el && "id" in el) {
      return {
        ...el,
        id: `${String(el.id)}$`,
      };
    }
    return el;
  });
}

/**
 * Undo {@link suffixIDs} on the way back from the model.
 *
 * The `$` is a display-only marker: it is appended before the document is shown to the model and
 * sliced straight off again here, so it carries no meaning of its own. Models routinely drop it
 * — a UUID with a trailing `$` reads like a typo worth cleaning up — and rejecting those ids
 * turned a cosmetic slip into an edit that silently did nothing at all. Accept both forms;
 * whether the id is real is settled by looking the block up, which every caller already does.
 */
export function stripIDSuffix(id: string | undefined): string | undefined {
  return typeof id === "string" && id.endsWith("$") ? id.slice(0, -1) : id;
}
