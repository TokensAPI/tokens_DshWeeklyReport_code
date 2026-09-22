/**
 * Minimal cross-module bus that lets the editor-level right-Alt shortcut drive voice
 * input inside the AI menu, without either module depending on the other's internals.
 *
 * - `menuOpen` is maintained by AIMenu (set true on mount, false on unmount), so the
 *   editor layer knows whether a right-Alt should OPEN the AI menu + auto-start voice,
 *   or TOGGLE the already-open menu's recording.
 * - `autoStartPending` is set by the editor layer right before it opens the AI menu via
 *   right-Alt; AIMenu consumes it once on mount and immediately starts recording.
 *
 * Kept as plain mutable state because there is exactly one editor per report and any
 * race (a stale flag) is bounded by a single consume-on-mount.
 */
export const voiceBus: { menuOpen: boolean; autoStartPending: boolean } = {
  menuOpen: false,
  autoStartPending: false,
};

/** Editor layer: right-Alt opened the menu and wants voice to auto-start. */
export function markVoiceAutoStart() {
  voiceBus.autoStartPending = true;
}

/** AIMenu: return-and-clear the pending auto-start request. */
export function consumeVoiceAutoStart(): boolean {
  const pending = voiceBus.autoStartPending;
  voiceBus.autoStartPending = false;
  return pending;
}

/** Window event the editor layer dispatches to toggle recording while the menu is open. */
export const VOICE_TOGGLE_EVENT = "dsh-ai-voice-toggle";
