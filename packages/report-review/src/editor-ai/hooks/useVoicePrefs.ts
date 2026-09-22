import { useCallback, useState } from "react";

const ENABLED_KEY = "rr_voice_polish_enabled";
const DEFAULT_ENABLED = true;

export type VoicePrefs = {
  /** Whether the post-ASR "intent understanding + polish" step runs (fills the prompt back in). */
  enabled: boolean;
  /** Target language for the LLM to normalize the transcript toward (follows the system by default). */
  lang: string;
  /** Toggle the post-ASR polish step; persisted locally. */
  setEnabled: (next: boolean) => void;
};

function readEnabled(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(ENABLED_KEY);
    if (raw == null) return DEFAULT_ENABLED;
    return raw === "1";
  } catch {
    return DEFAULT_ENABLED;
  }
}

function systemLang(): string {
  try {
    return (navigator?.language || "zh-CN") as string;
  } catch {
    return "zh-CN";
  }
}

/**
 * Voice preference for the report editor: whether to run the LLM "intent + polish" step after
 * speech-to-text, and which language to normalize toward. The language always follows the system
 * (navigator.language); only the on/off toggle is persisted, so switching back and forth is cheap.
 */
export function useVoicePrefs(): VoicePrefs {
  const [enabled, setEnabledState] = useState<boolean>(readEnabled);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      globalThis.localStorage?.setItem(ENABLED_KEY, next ? "1" : "0");
    } catch {
      /* storage may be unavailable; keep in-memory state */
    }
  }, []);
  return { enabled, lang: systemLang(), setEnabled };
}
