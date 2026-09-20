// Local stand-ins for a few model-SDK symbols the retained
// StreamToolExecutor and its helpers still reference. We drive the LLM natively, so
// these are just enough to satisfy the kept executor machinery without pulling in an
// external model SDK at all. The editor-ai sources import them directly from here (no
// build alias / package redirect).
//
// Some of the names (Chat, UIMessage, DeepPartial, ToolSet, JSONSchema7) are imported
// as values only because they occupy TYPE positions (`Chat<UIMessage>`, `DeepPartial<...>`).
// TypeScript lets a value and a type share a name, so we export a throwaway value AND
// keep the matching type alias.

// --- values used only as types at runtime (never called) ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Chat: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const UIMessage: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepPartial: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ToolSet: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const JSONSchema7: any = undefined;

// --- matching type aliases ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Chat = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UIMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolSet = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JSONSchema7 = any;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// --- actual values ---
export function getErrorMessage(e: any): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  try { return String(e); } catch { return 'unknown error'; }
}

export function isToolUIPart(part: any): boolean {
  return typeof part?.type === 'string' && part.type.startsWith('tool-');
}

// `jsonSchema(s)` wraps a plain JSON Schema object into a schema object whose
// `.jsonSchema` getter returns the raw schema. We only ever round-trip it through
// `asSchema(...).jsonSchema`, so a plain wrapper is sufficient.
export function jsonSchema(schema: any): any {
  return { type: 'json', jsonSchema: schema };
}

// `asSchema(x)` normalizes to a schema object exposing `.jsonSchema`.
export function asSchema(schema: any): any {
  if (schema && typeof schema === 'object' && 'jsonSchema' in schema) return schema;
  return { jsonSchema: schema };
}

// `tool(def)` builds a tool from a definition; we only need the serializable
// surface (description/inputSchema/outputSchema/execute).
export function tool(def: any): any {
  return {
    description: def?.description,
    inputSchema: def?.inputSchema ?? {},
    outputSchema: def?.outputSchema,
    execute: def?.execute,
  };
}

// Minimal partial-JSON parser. The native chat emits a COMPLETE input at
// `input-available`, so the executor's string branch (which calls this) is never hit
// in our pipeline; this only needs to resolve the import and degrade gracefully.
export function parsePartialJson(input: any): { state: string; value?: any } {
  if (input === undefined || input === null || input === '') {
    return { state: 'undefined-input' };
  }
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  try {
    const value = JSON.parse(str);
    return { state: 'full-parse', value };
  } catch {
    // Best-effort repair for trailing commas / unterminated structures (partial stream).
    try {
      const repaired = str.replace(/,\s*([}\]])/g, '$1').replace(/,\s*$/, '');
      const value = JSON.parse(repaired);
      return { state: 'repaired-parse', value };
    } catch {
      return { state: 'failed-parse' };
    }
  }
}
