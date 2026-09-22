// Bridge: present DSH llm.stream (host) as a native LanguageModel so that our own
// AI editing can run on our own LLM (no external model SDK / streamText).
//
// Client side. The actual LLM call happens in the DSH host (/api/run19/ai-stream, see
// index.mjs fetchAiStream). We only convert model messages/tools -> DSH messages/tools,
// and map the DSH stream chunks back to LanguageModel-like stream parts.
//
// NOTE: DSH GenerateOptions has NO toolChoice field, so we cannot force tool calls the
// way XL-AI does with `toolChoice:'required'`. We rely on the injected document-state
// instruction message to drive the model to issue operations.

const AI_CLIENT_TIMEOUT_MS = 100 * 1000; // client-side per-read bound; host also aborts

function textPartId(prefix, n) { return `dsh-${prefix}-${n}`; }

// Surface the AI round-trip outcome on-screen (block-editor listens to this event)
// so the user sees WHY an edit did/didn't apply without needing DevTools.
function emitDiag(detail) {
  try { if (typeof window !== 'undefined' && window.dispatchEvent && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('dsh-ai-diag', { detail })); } catch { /* ignore */ }
}

// Map a DSH finish reason to the model finishReason vocabulary.
function mapFinishReason(kind) {
  switch (kind) {
    case 'stop': return 'stop';
    case 'tool-calls': return 'tool-calls';
    case 'max-tokens': return 'length';
    case 'aborted': return 'aborted';
    case 'error': return 'error';
    default: return 'stop';
  }
}

// Convert a model message part to a DSH ContentBlock.
function toDshBlock(part) {
  switch (part?.type) {
    case 'text': return { type: 'text', text: part.text ?? '' };
    case 'reasoning': return { type: 'reasoning', text: part.text ?? '' };
    // UIMessage/ModelMessage tool call part:
    case 'tool-call': return { type: 'tool-call', id: String(part.toolCallId), name: part.toolName, arguments: JSON.stringify(part.args ?? {}) };
    // LanguageModelV1 (prompt) tool part:
    case 'tool': return { type: 'tool-call', id: String(part.toolCallId), name: part.toolName, arguments: JSON.stringify(part.args ?? {}) };
    // UIMessage/ModelMessage tool result part:
    case 'tool-result': return { type: 'tool-result', toolCallId: String(part.toolCallId), isError: part.isError ?? false, content: [{ type: 'text', text: JSON.stringify(part.output ?? '') }] };
    // LanguageModelV1 tool-result part:
    case 'tool-result-part': return { type: 'tool-result', toolCallId: String(part.toolCallId), isError: part.isError ?? false, content: [{ type: 'text', text: typeof part.output === 'string' ? part.output : String(part.output ?? '') }] };
    case 'file': return { type: 'text', text: `[文件附件：${part.filename ?? ''}]` };
    default: return { type: 'text', text: typeof part === 'string' ? part : '' };
  }
}

// Convert one model message (parts-shaped, LanguageModelPrompt-ish, or ModelMessage)
// into a DSH Message. Handles string content, UIMessage parts, and V1 prompt parts.
function toDshMessage(msg, i) {
  const role = msg?.role === 'assistant'
    ? 'assistant'
    : msg?.role === 'system' ? 'system'
    : msg?.role === 'tool' ? 'tool'
    : msg?.role === 'tool-result' ? 'tool'
    : 'user';
  const raw = msg?.content;
  let content;
  if (typeof raw === 'string') content = [{ type: 'text', text: raw }];
  else if (Array.isArray(raw)) content = raw.map(toDshBlock);
  else if (raw && typeof raw === 'object') content = [{ type: 'text', text: JSON.stringify(raw) }];
  else content = [{ type: 'text', text: '' }];
  return { id: `m${i}-${msg?.role ?? 'user'}-${Math.random().toString(36).slice(2, 8)}`, role, content, source: { kind: 'plugin', plugin: 'run19-report-review' } };
}

// Extract a plain JSON-Schema object from a schema wrapper.
function extractJsonSchema(s) {
  if (!s) return {};
  // tool.inputSchema is a schema object with a `jsonSchema` getter that
  // returns the raw JSON Schema object directly.
  if (s.jsonSchema && typeof s.jsonSchema === 'object') return s.jsonSchema;
  if (s.jsonSchema && typeof s.jsonSchema === 'function') return s.jsonSchema();
  if (typeof s === 'object') return s;
  return {};
}

// Convert the tools handed to doStream into DSH ToolSchema[] ({ name, description, parameters }).
// The model receives tools as an ARRAY; the tool name lives on each entry
// (`tool.name`), not the array key. Some callers (e.g. our own createDshTransport) pass a
// ToolSet record instead. Handle both, and never fall back to a numeric index as the name.
async function toDshTools(tools) {
  if (!tools) return undefined;
  const entries = Array.isArray(tools)
    ? tools.map((t, i) => [t?.name ?? String(i), t])
    : Object.entries(tools);
  const out = [];
  for (const [key, t] of entries) {
    if (!t) continue;
    const name = t.name ?? key;
    if (!name || /^\d+$/.test(String(name))) continue;
    out.push({ name, description: t.description ?? '', parameters: extractJsonSchema(t.inputSchema) });
  }
  return out.length ? out : undefined;
}

/**
 * An LLM model that runs through the DSH host llm.stream.
 * @param {object} opts
 * @param {string} opts.provider  provider route (host-selected when omitted)
 * @param {string} opts.model     model id (host-selected when omitted)
 * @param {string} [opts.system]
 * @param {(path:string, init?:object)=>Promise<Response>} opts.fetchFn
 */
export function createDshLlmModel(opts) {
  const fetchFn = opts.fetchFn ?? ((path, init) => fetch(path, init));
  let seq = 0;
  const provider = opts.provider ?? 'dsh';
  const modelId = opts.model ?? 'dsh';

  const doStream = async ({ messages, prompt, input, tools, system, temperature, maxTokens, abortSignal }) => {
    // The model hands the conversation to doStream under `prompt` (LanguageModelPrompt[]);
    // v2 under `input`; some callers pass `messages`. Normalize and split out the leading
    // system message (V3 folds `system` into prompt[0]) so the host nudge can append to it.
    let src = prompt ?? messages ?? input ?? [];
    let dshSystem = system ?? opts.system;
    if (Array.isArray(src) && src[0]?.role === 'system') {
      const c = src[0].content;
      const sysText = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map(p => p?.type === 'text' ? (p.text ?? '') : '').join('') : '';
      if (!dshSystem) dshSystem = sysText;
      src = src.slice(1);
    }
    const dshMessages = Array.isArray(src) ? src.map(toDshMessage) : [];
    const dshTools = await toDshTools(tools);
    const requestBody = {
      provider: opts.provider, model: opts.model,
      messages: dshMessages,
      system: dshSystem,
      tools: dshTools,
      temperature: typeof temperature === 'number' ? temperature : undefined,
      maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
      // Route the edit call to a real DSH session (context/telemetry/replay) when one is
      // provided. Omitted for one-shot / demo / non-session callers.
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };

    try { console.error('[dsh-ai] >>> request tools=', (dshTools||[]).map(t=>t.name).join(','), 'msgs=', dshMessages.length, 'provider=', opts.provider ?? '(host-default)', 'model=', opts.model ?? '(host-default)'); } catch { /* ignore */ }
    let response;
    let connectTimer;
    try {
      response = await Promise.race([
        fetchFn('/api/run19/ai-stream', {
          method: 'POST', credentials: 'same-origin', signal: abortSignal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }),
        new Promise((_, reject) => { connectTimer = setTimeout(() => reject(new Error('AI 请求超时（无法连接宿主 AI 流）')), AI_CLIENT_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(connectTimer));
    } catch (e) {
      emitDiag({ tools: (dshTools||[]).map(t => t.name), toolCalls: 0, finishReason: 'error', error: String(e?.message || e) });
      throw e;
    }
    if (!response.ok || !response.body) {
      const msg = `DSH AI stream failed (HTTP ${response.status})`;
      emitDiag({ tools: (dshTools||[]).map(t => t.name), toolCalls: 0, finishReason: 'error', error: msg });
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    if (abortSignal?.aborted) return { stream: emptyStream(), request: { body: requestBody } };

    // We stream parts out through a TransformStream that consumes the NDJSON lines.
    let textId = 0;
    let dshFinishReason = null; // preserves DSH finish reason (e.g. 'tool-calls')
    let streamMetaProvider = null, streamMetaModel = null; // resolved model from host meta record
    const toolOpen = new Map(); // toolCallId -> {name, startEmitted}
    const stream = new ReadableStream({
      async start(ctrl) {
        let buf = '';
        try {
          for (;;) {
            // Bound each read so a stalled host/model stream can't hang the AI UI.
            const readPromise = reader.read();
            let timer;
            const rr = await Promise.race([
              readPromise,
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AI 请求超时（等待宿主流超时）')), AI_CLIENT_TIMEOUT_MS); }),
            ]).finally(() => clearTimeout(timer));
            if (rr.done) break;
            buf += decoder.decode(rr.value, { stream: true });
            // NDJSON is newline-delimited; process complete lines.
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
              if (!line.trim()) continue;
              let rec; try { rec = JSON.parse(line); } catch { continue; }
              if (rec.t === 'error') { ctrl.enqueue({ type: 'error', error: new Error(rec.error?.message || 'DSH stream error') }); break; }
              if (rec.t === 'done') break;
              if (rec.t === 'meta') { streamMetaProvider = rec.provider ?? null; streamMetaModel = rec.model ?? null; continue; }
              if (rec.t !== 'chunk') continue;
              const c = rec.chunk;
              switch (c?.type) {
                case 'text-delta': { const id = textPartId('text', textId++); ctrl.enqueue({ type: 'text-start', id }); ctrl.enqueue({ type: 'text-delta', id, delta: c.text ?? '' }); ctrl.enqueue({ type: 'text-end', id }); break; }
                case 'reasoning-delta': { const id = textPartId('reasoning', textId++); ctrl.enqueue({ type: 'reasoning-start', id }); ctrl.enqueue({ type: 'reasoning-delta', id, delta: c.text ?? '' }); ctrl.enqueue({ type: 'reasoning-end', id }); break; }
                case 'tool-call-delta': {
                  const callId = String(c.id ?? c.blockId ?? '');
                  let st = toolOpen.get(callId);
                  if (!st) { st = { name: c.name, arguments: '', closed: false }; toolOpen.set(callId, st); }
                  // Accumulate the raw JSON-string arguments from the deltas. We do NOT
                  // emit tool-input-start/delta here: emitting only the final `tool-call`
                  // part makes the model produce exactly one `tool-input-available`
                  // UIMessage part. If we also emitted tool-input-delta, xl-ai's
                  // processToolCallPart would write the (already-complete) input twice,
                  // causing duplicate operations. The typing/cursor effect comes from the
                  // executor's internal delays, so it is preserved.
                  st.arguments = (st.arguments ?? '') + (c.argumentsDelta ?? '');
                  break;
                }
                case 'block-end': {
                  const b = c.block;
                  // Accept BOTH shapes: some providers emit a `block` object
                  // ({type:'tool-call', id, name, arguments}), while the DSH host emits
                  // flat fields (blockType:'tool-call', blockName, blockId). The latter
                  // has no `block.arguments`, so fall back to the accumulated delta.
                  const isTool = b?.type === 'tool-call' || c.blockType === 'tool-call';
                  if (isTool) {
                    const callId = String(b?.id ?? c.blockId ?? '');
                    const name = b?.name ?? c.blockName ?? '';
                    let st = toolOpen.get(callId);
                    if (!st) { st = { name, arguments: b?.arguments ?? '', closed: false }; toolOpen.set(callId, st); }
                    // Tool-call parsing expects the tool-call part's `input` to be the RAW
                    // JSON-string arguments (it calls toolCall.input.trim() and safeParseJSON3).
                    // Passing a parsed OBJECT here made trim() throw -> InvalidToolInputError ->
                    // tool-input-error -> XL-AI never applied the edit. Send the raw string.
                    const rawArgs = b?.arguments ?? st.arguments ?? '';
                    st.closed = true;
                    try { console.error('[dsh-ai] tool-call completed:', name, callId, rawArgs.slice(0, 160)); } catch {}
                    ctrl.enqueue({ type: 'tool-call', id: callId, toolName: name, input: rawArgs });
                  }
                  break;
                }
                case 'finish': { dshFinishReason = mapFinishReason(c.reason?.kind); try { console.error('[dsh-ai] finish reason=', dshFinishReason); } catch {} break; }
                default: break;
              }
            }
          }
          // Safety net: emit a `tool-call` for any tool we saw deltas for but that
          // didn't get a block-end (so the model always reaches `input-available`).
          for (const [callId, st] of toolOpen) {
            if (st && !st.closed) {
              st.closed = true;
              ctrl.enqueue({ type: 'tool-call', id: callId, toolName: st.name, input: st.arguments ?? '' });
            }
          }
          const reason = dshFinishReason && dshFinishReason !== 'stop' ? dshFinishReason : (toolOpen.size ? 'tool-calls' : 'stop');
          try { console.error('[dsh-ai] DONE: tool calls received =', toolOpen.size, '-> finishReason =', reason); } catch {}
          emitDiag({ tools: (dshTools||[]).map(t => t.name), toolCalls: toolOpen.size, finishReason: reason, error: null, provider: streamMetaProvider, model: streamMetaModel });
          ctrl.enqueue({ type: 'finish', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: reason });
          ctrl.close();
        } catch (e) {
          try { reader.cancel(); } catch { /* ignore */ }
          try { ctrl.enqueue({ type: 'error', error: e }); } catch {}
          emitDiag({ tools: (dshTools||[]).map(t => t.name), toolCalls: toolOpen.size, finishReason: 'error', error: String(e?.message || e) });
          try { ctrl.close(); } catch {}
        }
      },
      cancel() { try { reader.cancel(); } catch {} },
    });
    return { stream, request: { body: requestBody } };
  };

  return {
    specificationVersion: 'v3',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => { throw new Error('DSH model: generate (non-streaming) not implemented'); },
    doStream,
  };
}

function emptyStream() {
  return new ReadableStream({
    start(ctrl) { ctrl.enqueue({ type: 'finish', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' }); ctrl.close(); },
  });
}

/**
 * A chat transport that drives the DSH-hosted LLM, shaped like XL-AI's
 * ClientSideTransport: it reads body.toolDefinitions, rebuilds the ToolSet, and calls
 * streamText with the DSH-backed model so `.toUIMessageStream()` produces the
 * UIMessageChunk stream XL-AI consumes.
 * @deprecated The editor now uses {@link createNativeChat}; kept only for API compat.
 */
export async function createDshTransport() {
  throw new Error('createDshTransport removed: the AI editor uses createNativeChat (no model SDK)');
}

// Re-export helpers other modules may want.
export { createDshLlmModel as createDshModel };

// ---------------------------------------------------------------------------
// Native LLM chat (no model SDK).
//
// XL-AI's AIExtension/sendMessageWithAIRequest/setupToolCallStreaming expect an
// object with a model-agent `Chat` shape: lastMessage.parts, status, error, messages,
// addToolOutput, stop() and the three `~register*Callback` hooks. We provide that
// shape but drive the DSH-hosted LLM directly through createDshLlmModel.doStream —
// no third-party chat client, no `streamText`, no `toUIMessageStream`. The parts we
// emit are UIMessage-shaped (`tool-applyDocumentOperations` with state
// `input-available`) so the retained StreamToolExecutor + suggest/undo machinery
// behave exactly as before.
// ---------------------------------------------------------------------------

// Mirror of xl-ai's injectDocumentStateMessages: fold the latest document state
// (from message.metadata.documentState) into an assistant text message that tells
// the model to operate on the current doc/selection. Kept local so we don't depend
// on any external util module.
function injectDocumentStateMessages(messages) {
  return messages.flatMap((message) => {
    const documentState = message?.metadata?.documentState;
    if (message.role === 'user' && documentState) {
      const sel = documentState.selection;
      const docParts = sel
        ? [
            { type: 'text', text: `This is the latest state of the selection (ignore previous selections, you MUST issue operations against this latest version of the selection):` },
            { type: 'text', text: JSON.stringify(documentState.selectedBlocks) },
            { type: 'text', text: `This is the latest state of the entire document (INCLUDING the selected text),\nyou can use this to find the selected text to understand the context (but you MUST NOT issue operations against this document, you MUST issue operations against the selection):` },
            { type: 'text', text: JSON.stringify(documentState.blocks) },
          ]
        : [
            { type: 'text', text: `There is no active selection. This is the latest state of the document (ignore previous documents, you MUST issue operations against this latest version of the document).\nThe cursor is BETWEEN two blocks as indicated by cursor: true.\n` + (documentState.isEmptyDocument ? `Because the document is empty, YOU MUST first update the empty block before adding new blocks.` : `Prefer updating existing blocks over removing and adding (but this also depends on the user's question).`) },
            { type: 'text', text: JSON.stringify(documentState.blocks) },
          ];
      return [
        { role: 'assistant', id: 'assistant-document-state-' + (message.id || 'x'), parts: docParts },
        message,
      ];
    }
    return [message];
  });
}

// Last user/assistant text from a message whose `content`/`parts` may carry text
// blocks (and possibly tool/state blocks that we want to exclude from context).
function extractMessageText(msg) {
  if (!msg) return '';
  const raw = msg.content ?? msg.parts;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('');
  if (raw && typeof raw === 'object') return typeof raw.text === 'string' ? raw.text : '';
  return '';
}

/**
 * Create a native chat object that drives the DSH LLM directly (no model SDK).
 * @param {object} opts  forwarded to createDshLlmModel (fetchFn, provider, model, system, sessionId)
 */
export function createNativeChat(opts) {
  const model = createDshLlmModel(opts);
  // Which report this conversation is scoped to. Each report mounts its own editor
  // (client uses key={reportId}), so a chat is per-report. We use this to (a) tag every
  // convo entry and only feed the current report's turns back, (b) anchor the model on the
  // current report, and (c) reject applyDocumentOperations calls stamped for another report.
  const reportId = (typeof opts?.reportId === 'string' && opts.reportId.length > 0) ? opts.reportId : null;
  const state = {
    messages: [],
    // Full user/assistant exchange used to give the model conversation context across
    // turns. `messages`/`lastMessage` keep the xl-ai UIMessage shape for the executor.
    convo: [],
    lastMessage: null,
    status: 'ready',             // 'ready' | 'submitted' | 'error'
    error: undefined,
    abortController: new AbortController(),
    msgsCb: [],
    statusCb: [],
    errCb: [],
  };
  const fire = (arr, ...a) => { for (const cb of arr.slice()) { try { cb(...a); } catch { /* ignore */ } } };
  const setStatus = (s) => { state.status = s; fire(state.statusCb, s); };
  const setError = (e) => { state.error = e; setStatus('error'); fire(state.errCb, e); };
  const setLastMessage = (m) => { state.lastMessage = m; state.messages = [...state.messages.slice(0, -1), m]; fire(state.msgsCb, state.messages); };

  return {
    get lastMessage() { return state.lastMessage; },
    get messages() { return state.messages; },
    get status() { return state.status; },
    get error() { return state.error; },

    '~registerMessagesCallback'(cb) { state.msgsCb.push(cb); return () => { state.msgsCb = state.msgsCb.filter((x) => x !== cb); }; },
    '~registerStatusCallback'(cb) { state.statusCb.push(cb); return () => { state.statusCb = state.statusCb.filter((x) => x !== cb); }; },
    '~registerErrorCallback'(cb) { state.errCb.push(cb); return () => { state.errCb = state.errCb.filter((x) => x !== cb); }; },

    async sendMessage(message, options) {
      // The document-state metadata is set by sendMessageWithAIRequest before we get here.
      const toolDefinitions = (options && options.body && options.body.toolDefinitions) || {};
      const tools = Object.entries(toolDefinitions).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));
      // The DSH bridge consumes ModelMessage-shaped messages (`content` is an array of
      // parts). xl-ai's injected state uses UIMessage-shaped `parts`, so normalize here.
      // For a conversation we prepend the accumulated history (prior user + assistant
      // text) so the model sees the whole exchange, then inject the latest document state
      // onto the current message. This is what makes "直接对话修改" carry real context.
      const userText = extractMessageText(message);
      // Tag every convo entry with the report it belongs to, so the model only ever sees
      // turns from the CURRENT report (each report mounts its own chat; this is defensive).
      state.convo = [...state.convo, { role: 'user', text: userText, reportId }];
      const history = state.convo.slice(0, -1)
        .filter((m) => m && typeof m.text === 'string' && m.text.length > 0 && (reportId == null || m.reportId == null || m.reportId === reportId))
        .map((m) => ({ role: m.role, content: [{ type: 'text', text: m.text }] }));
      const injected = injectDocumentStateMessages([...history, message]).map((m) =>
        m && Array.isArray(m.parts) ? { role: m.role, id: m.id, content: m.parts } : m,
      );

      setStatus('submitted');
      let stream;
      try {
        // Anchor the model on the current report so it knows which report it is editing and
        // stamps it on applyDocumentOperations; the tool-call guard below rejects mismatches.
        const system = [
          opts.system,
          reportId ? `当前报告 ID：${reportId}。你正在编辑这份报告。调用 applyDocumentOperations 时必须在顶层传入 reportId 字段，其值必须等于 ${reportId}，否则会被拒绝。` : '',
        ].filter(Boolean).join('\n');
        ({ stream } = await model.doStream({
          prompt: injected,
          tools,
          system: system || undefined,
          abortSignal: state.abortController.signal,
        }));
      } catch (e) {
        setError(e);
        return;
      }

      const parts = [];
      let curText = null;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (value.type === 'text-delta') {
            if (!curText) { curText = { type: 'text', text: '' }; parts.push(curText); setLastMessage({ role: 'assistant', parts: [...parts] }); }
            curText.text += value.delta || '';
          } else if (value.type === 'tool-call') {
            // The executor consumes exactly one `input-available` part (writes + closes).
            // `input` must be the parsed operations OBJECT (objectStreamToOperationsResult
            // expects DeepPartial<{operations}>), not the raw JSON string.
            let input = value.input;
            if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* keep */ } }
            // Guard: if the model stamps a reportId that is NOT this report, refuse to apply so
            // we can never edit a different report's document. Absent stamp = accept (the chat is
            // per-report anchored anyway). Strip reportId before forwarding so the operations
            // pipeline only ever sees {operations}.
            const stamp = input && typeof input === 'object' ? input.reportId : undefined;
            if (reportId && typeof stamp === 'string' && stamp !== reportId) {
              const err = new Error(`AI 尝试编辑其他报告（reportId=${stamp}），为保护当前报告已拒绝本次修改。`);
              emitDiag({ tools: (tools || []).map((t) => t.name), toolCalls: 1, finishReason: 'error', error: String(err.message) });
              setError(err);
              break;
            }
            const safeInput = input && typeof input === 'object' && Array.isArray(input.operations) ? { operations: input.operations } : input;
            parts.push({ type: 'tool-applyDocumentOperations', state: 'input-available', toolCallId: String(value.id), input: safeInput });
            setLastMessage({ role: 'assistant', parts: [...parts] });
          } else if (value.type === 'finish') {
            break;
          } else if (value.type === 'error') {
            setError(value.error);
            break;
          }
        }
      } catch (e) {
        setError(e);
      }
      if (curText?.text) state.convo = [...state.convo, { role: 'assistant', text: curText.text, reportId }];
      if (state.status !== 'error') {
        setLastMessage({ role: 'assistant', parts: [...parts] });
        setStatus('ready');
      }
    },

    // Record the tool output; the edit is already applied, so no second model turn.
    addToolOutput(part, meta) {
      setLastMessage({ role: 'assistant', parts: state.lastMessage?.parts ?? [], ...(meta || {}) });
    },

    stop() { state.abortController.abort(); },
  };
}
