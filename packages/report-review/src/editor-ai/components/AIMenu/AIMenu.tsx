import { BlockNoteEditor } from "@blocknote/core";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
  useExtensionState,
} from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiMicFill, RiSparkling2Fill } from "react-icons/ri";
import { AIExtension } from "../../AIExtension.js";
import { useAIDictionary } from "../../hooks/useAIDictionary.js";
import { useVoicePrefs } from "../../hooks/useVoicePrefs.js";
import { PromptSuggestionMenu } from "./PromptSuggestionMenu.js";
import {
  AIMenuSuggestionItem,
  getDefaultAIMenuItems,
} from "./getDefaultAIMenuItems.js";
import {
  consumeVoiceAutoStart,
  VOICE_TOGGLE_EVENT,
  voiceBus,
} from "../../voiceBus.js";

// The upstream ASR (whisper-family) cannot parse MediaRecorder's default webm/opus duration without
// ffprobe. Decode the recorded blob to PCM with the Web Audio API and re-encode as a standard 16-bit
// PCM WAV, so the provider can read it deterministically. If decoding fails (unsupported container)
// we fall back to sending the original blob unchanged.
async function blobToWav(src: Blob): Promise<Blob> {
  const audioCtx = new (window.AudioContext ||
    (window as any).webkitAudioContext)();
  try {
    const arrayBuf = await src.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
    const numCh = Math.min(audioBuffer.numberOfChannels, 2);
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);
    const wStr = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    wStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    wStr(8, "WAVE");
    wStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    wStr(36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    const channels: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([out], { type: "audio/wav" });
  } finally {
    audioCtx.close().catch(() => {});
  }
}

export type AIMenuProps = {
  items?: (
    editor: BlockNoteEditor<any, any, any>,
    aiResponseStatus:
      | "user-input"
      | "thinking"
      | "ai-writing"
      | "error"
      | "user-reviewing"
      | "closed",
  ) => AIMenuSuggestionItem[];
  onManualPromptSubmit?: (userPrompt: string) => void;
};

export const AIMenu = (props: AIMenuProps) => {
  const editor = useBlockNoteEditor();
  const [prompt, setPrompt] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const [asrBusy, setAsrBusy] = useState(false);
  const [asrError, setAsrError] = useState<string | null>(null);
  // Live "what the agent is doing" strip. The host relays NDJSON activity lines through
  // window `dsh-ai-activity` (see ai-bridge.mjs emitActivity), e.g. the model is calling
  // web_search, or is writing the doc. We mirror that as a small status line under the prompt.
  const [aiActivity, setAiActivity] = useState<{
    kind?: string;
    name?: string;
    status?: string;
    callId?: string;
    turn?: number;
  } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const dict = useAIDictionary();
  const voicePrefs = useVoicePrefs();

  const Components = useComponentsContext()!;

  const ai = useExtension(AIExtension);

  const aiResponseStatus = useExtensionState(AIExtension, {
    selector: (state) =>
      state.aiMenuState !== "closed" ? state.aiMenuState.status : "closed",
  });

  const { items: externalItems } = props;
  // note, technically there might be a bug with this useMemo when quickly changing the selection and opening the menu
  // would not call getDefaultAIMenuItems with the correct selection, because the component is reused and the memo not retriggered
  // practically this should not happen (you can test it by using a high transition duration in useUIElementPositioning)
  const items = useMemo(() => {
    let items: AIMenuSuggestionItem[] = [];
    if (externalItems) {
      items = externalItems(editor, aiResponseStatus);
    } else {
      items = getDefaultAIMenuItems(editor, aiResponseStatus);
    }

    // map from AI items to React Items required by PromptSuggestionMenu
    return items.map((item) => {
      return {
        ...item,
        onItemClick: () => {
          item.onItemClick(setPrompt);
        },
      };
    });
  }, [externalItems, aiResponseStatus, editor]);

  const onManualPromptSubmitDefault = useCallback(
    async (userPrompt: string) => {
      await ai.invokeAI({
        userPrompt,
        useSelection: editor.getSelection() !== undefined,
      });
    },
    [ai, editor],
  );

  const transcribe = useCallback(async (blob: Blob) => {
    setAsrBusy(true);
    try {
      // Upstream ASR cannot parse webm/opus duration. Convert to a standard PCM WAV first.
      let payload = blob;
      const mime = (blob.type || "").toLowerCase();
      if (mime.includes("webm") || mime.includes("ogg") || mime.includes("opus")) {
        payload = await blobToWav(blob);
      }
      const transport = (globalThis as any)?.__DSH_TRANSPORT__;
      const send = transport?.fetch || globalThis.fetch;
      const res = await send("/api/run19/asr", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": payload.type || "audio/wav" },
        body: payload,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error?.message || `语音识别失败 (${res.status})`);
      }
      const d = await res.json();
      const text = (d?.text || "").trim();
      if (!text) {
        setAsrError("未能识别到内容");
        return;
      }
      // Base behavior: drop the transcript into the prompt for the user to confirm/edit.
      setPrompt((prev) => {
        if (!prev) return text;
        return /[\s。！？，、.!?,;；]$/.test(prev) ? `${prev}${text}` : `${prev} ${text}`;
      });
      setAsrError(null);
      // Optional polish: when enabled, an LLM call normalizes the transcript (script/language,
      // completeness) and returns a cleaner instruction. NEVER auto-submits — the user always
      // confirms the final text. On any failure we keep the raw transcript in the box.
      if (voicePrefs.enabled) {
        try {
          const selectionText =
            editor.getSelection() !== undefined
              ? ((editor as any).getSelectedText?.()?.slice(0, 2000) as string) || ""
              : "";
          const pr = await send("/api/run19/asr-polish", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              lang: voicePrefs.lang,
              selection: selectionText,
            }),
          });
          const pj = await pr.json().catch(() => ({}));
          if (pr.ok && pj?.ok && typeof pj?.polished === "string" && pj.polished.trim()) {
            const polished = pj.polished.trim();
            if (polished !== text) setPrompt(polished);
          }
        } catch (e) {
          console.error("[run19-asr-polish]", e);
        }
      }
    } catch (e) {
      const msg = (e as any)?.message || String(e);
      setAsrError(`语音识别失败：${msg}`);
      console.error("[run19-asr]", e);
    } finally {
      setAsrBusy(false);
    }
  }, [setPrompt, voicePrefs.enabled, voicePrefs.lang, editor]);

  const startVoice = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        setAsrError("当前环境不支持麦克风（mediaDevices 不可用）");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start();
      recorderRef.current = rec;
      streamRef.current = stream;
      setAsrError(null);
      setVoiceOn(true);
    } catch (e) {
      const err = e as any;
      const name = err?.name || "";
      const hint =
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在系统/浏览器设置中允许"
          : name === "NotFoundError"
            ? "找不到麦克风设备"
            : name === "NotReadableError"
              ? "麦克风被其他程序占用"
              : name === "SecurityError"
                ? "页面未授权访问麦克风"
                : err?.message || String(e);
      setAsrError(`无法录音：${hint}`);
      console.error("[run19-asr] 麦克风不可用", e);
      setVoiceOn(false);
    }
  }, []);

  const stopVoice = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) {
      setVoiceOn(false);
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
    });
    rec.stop();
    await stopped;
    const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setVoiceOn(false);
    if (blob.size > 0) await transcribe(blob);
  }, [transcribe]);

  const toggleVoice = useCallback(() => {
    // Voice is only meaningful while the prompt is editable.
    if (aiResponseStatus !== "user-input" || asrBusy) return;
    if (voiceOn) {
      void stopVoice();
    } else {
      void startVoice();
    }
  }, [aiResponseStatus, asrBusy, voiceOn, startVoice, stopVoice]);

  // Keep refs so one-shot mount/unmount effects always call the latest handlers.
  const startVoiceRef = useRef(startVoice);
  const toggleVoiceRef = useRef(toggleVoice);
  useEffect(() => {
    startVoiceRef.current = startVoice;
    toggleVoiceRef.current = toggleVoice;
  }, [startVoice, toggleVoice]);

  // While the menu is open, drive voice from the editor-level right-Alt shortcut:
  // - on mount, consume a pending "auto-start" request (right-Alt opened the menu).
  // - on a VOICE_TOGGLE_EVENT (right-Alt while already open), toggle recording.
  // - on unmount, stop the mic and discard (do not transcribe a half-clipped recording).
  useEffect(() => {
    voiceBus.menuOpen = true;
    if (consumeVoiceAutoStart()) {
      void startVoiceRef.current();
    }
    const onToggle = () => toggleVoiceRef.current();
    window.addEventListener(VOICE_TOGGLE_EVENT, onToggle);
    return () => {
      voiceBus.menuOpen = false;
      window.removeEventListener(VOICE_TOGGLE_EVENT, onToggle);
      const rec = recorderRef.current;
      if (rec) {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  useEffect(() => {
    // this is a bit hacky to run a useeffect to reset the prompt when the AI response is done
    if (
      aiResponseStatus === "ai-writing" ||
      aiResponseStatus === "user-reviewing" ||
      aiResponseStatus === "error"
    ) {
      setPrompt("");
    }
  }, [aiResponseStatus]);

  // Subscribe to the host's agent-activity ticker. `aiActivity` drives the small
  // "正在…" line, and also surfaces the tool name while each system tool runs.
  useEffect(() => {
    const onActivity = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.kind === "finished") {
        setAiActivity(null);
        return;
      }
      // A completed tool is immediately followed by the next model turn's `thinking`,
      // so holding the running label here avoids a jarring flash; clear only on finished.
      if (d?.kind === "tool" && d?.status === "done") return;
      setAiActivity(d && typeof d === "object" ? d : null);
    };
    window.addEventListener("dsh-ai-activity", onActivity);
    return () => window.removeEventListener("dsh-ai-activity", onActivity);
  }, []);

  // Human-friendly label for a system tool name (e.g. web_search -> 联网搜索).
  const toolLabel = useCallback((name?: string) => {
    if (!name) return "工具";
    const map: Record<string, string> = {
      web_search: "联网搜索",
      web_fetch: "抓取网页",
      read_file: "读取文件",
      write_file: "写入文件",
      edit: "编辑文件",
      glob: "查找文件",
      grep: "搜索内容",
      bash: "执行命令",
      todo_write: "更新清单",
    };
    return map[name] || name;
  }, []);

  // Compose the status text and whether to show a spinner.
  const activityStrip = useMemo(() => {
    if (!aiResponseStatus) return null;
    const isWorking = aiResponseStatus === "thinking" || aiResponseStatus === "ai-writing";
    if (!isWorking) return null;
    const a = aiActivity;
    let text: string;
    let spinning = true;
    if (!a) {
      text = "AI 正在处理…";
    } else if (a.kind === "thinking") {
      text = "正在思考…";
    } else if (a.kind === "tool" && a.status === "running") {
      text = `正在${toolLabel(a.name)}…`;
    } else if (a.kind === "tool" && a.status === "error") {
      text = `${toolLabel(a.name)}失败`;
      spinning = false;
    } else if (a.kind === "edit" && a.status === "applying") {
      text = "正在写入文档…";
    } else if (a.kind === "edit" && a.status === "done") {
      text = "已写入文档，请审阅";
      spinning = false;
    } else {
      text = "AI 正在处理…";
    }
    return { text, spinning };
  }, [aiResponseStatus, aiActivity, toolLabel]);

  const placeholder = useMemo(() => {
    if (voiceOn) {
      return "正在聆听… 按右 Alt 或点话筒结束";
    } else if (asrBusy) {
      return "识别中…";
    }
    if (aiResponseStatus === "thinking") {
      return dict.ai_menu.status.thinking;
    } else if (aiResponseStatus === "ai-writing") {
      return dict.ai_menu.status.editing;
    } else if (aiResponseStatus === "error") {
      return dict.ai_menu.status.error;
    }

    return dict.ai_menu.input_placeholder;
  }, [aiResponseStatus, dict, voiceOn, asrBusy]);

  const rightSection = useMemo(() => {
    if (aiResponseStatus === "thinking" || aiResponseStatus === "ai-writing") {
      return (
        <Components.SuggestionMenu.Loader
          className={"bn-suggestion-menu-loader bn-combobox-right-section"}
        />
      );
    } else if (aiResponseStatus === "error") {
      return (
        <div className={"bn-combobox-right-section bn-combobox-error"}>
          {/* Taken from Google Material Icons */}
          {/* https://fonts.google.com/icons?selected=Material+Symbols+Rounded:error:FILL@0;wght@400;GRAD@0;opsz@24&icon.query=error&icon.size=24&icon.color=%23e8eaed&icon.set=Material+Symbols&icon.style=Rounded&icon.platform=web */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="1em"
            viewBox="0 -960 960 960"
            width="1em"
            fill="currentColor"
          >
            <path d="M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360q-17 0-28.5 11.5T440-320q0 17 11.5 28.5T480-280Zm0-160q17 0 28.5-11.5T520-480v-160q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640v160q0 17 11.5 28.5T480-440Zm0 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
          </svg>
        </div>
      );
    }

    // Editable (user-input) state: a compact, premium voice control sitting flush inside the
    // input's right edge. Idle = a quiet circular mic; recording = the same circle morphs into an
    // animated sound-wave equalizer with a soft breathing glow. The "正在聆听" state is reflected
    // in the input placeholder instead of any wide would-be-card label, so nothing overflows the
    // fixed-width rightSection.
    return (
      <div className="bn-combobox-right-section rr-ai-voice">
        <button
          type="button"
          className={
            "rr-ai-mic" +
            (voiceOn ? " rr-ai-mic--live" : "") +
            (asrBusy ? " rr-ai-mic--busy" : "")
          }
          title={voiceOn ? "结束并识别（右 Alt）" : "语音输入（右 Alt）"}
          aria-pressed={voiceOn}
          aria-label={voiceOn ? "结束语音输入" : "开始语音输入"}
          disabled={asrBusy}
          onClick={toggleVoice}
        >
          {voiceOn && !asrBusy ? (
            <span className="rr-ai-eq" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          ) : voiceOn && asrBusy ? (
            <span className="rr-ai-spin" aria-hidden="true" />
          ) : (
            <RiMicFill />
          )}
        </button>
        {asrError && (
          <div className="rr-ai-asr-error" role="status">
            <button
              type="button"
              className="rr-ai-asr-error-x"
              aria-label="关闭语音错误提示"
              onClick={() => setAsrError(null)}
            >
              ×
            </button>
            <span>{asrError}</span>
          </div>
        )}
      </div>
    );
  }, [Components, aiResponseStatus, voiceOn, asrBusy, asrError, toggleVoice]);

  return (
    <PromptSuggestionMenu
      onManualPromptSubmit={
        props.onManualPromptSubmit || onManualPromptSubmitDefault
      }
      items={items}
      promptText={prompt}
      onPromptTextChange={setPrompt}
      placeholder={placeholder}
      disabled={
        aiResponseStatus === "thinking" || aiResponseStatus === "ai-writing"
      }
      icon={
        <div className="bn-combobox-icon">
          <RiSparkling2Fill />
        </div>
      }
      rightSection={rightSection}
      activity={
        activityStrip ? (
          <div
            className="rr-ai-activity"
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 12px 6px",
              fontSize: 12,
              color: "#a3a9b2",
              minHeight: 18,
            }}
          >
            {activityStrip.spinning ? (
              <span
                className="rr-ai-spin"
                aria-hidden="true"
                style={{ width: 11, height: 11, flex: "none" }}
              />
            ) : (
              <span aria-hidden="true" style={{ flex: "none", fontSize: 11 }}>
                ✓
              </span>
            )}
            <span>{activityStrip.text}</span>
          </div>
        ) : undefined
      }
    />
  );
};
