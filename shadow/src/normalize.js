// Session-event normalization: turn one Host durable event into a compact,
// JSON-safe frame B can render. This is deliberately a whitelist: unknown or
// internal event types never cross the machine boundary.
import { FORWARDED_EVENT_TYPES, LIMITS } from './constants.js'
import { byteLength, truncate } from './util.js'

/**
 * Normalize one durable `session/event` payload.
 *
 * Envelope fields are copied verbatim: `event.seq` is the durable sequence
 * used as the B-side cursor (`{type, seq, time, data, surfaceOp?,
 * sourceEventSeqs?}` — see dsh-session lib/index.js `append()`).
 *
 * @param {any} event - a committed Session event.
 * @param {object} [meta] - extra frame metadata (workspaceId).
 * @returns {object|null} a frame, or null when the type is not forwarded.
 */
export function normalizeEvent(event, meta = {}) {
  if (!event || typeof event.type !== 'string') return null
  if (!FORWARDED_EVENT_TYPES.has(event.type)) return null
  const seq = Number(event.seq)
  if (!Number.isFinite(seq)) return null
  const frame = {
    kind: 'event',
    seq,
    time: Number(event.time) || 0,
    type: event.type,
    data: trimEventData(event.type, event.data),
    ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
  }
  if (byteLength(frame) > LIMITS.maxFrameBytes) {
    // Last-resort cap: keep the identity and a marker instead of a 8 MB body.
    frame.data = { truncated: true, originalBytes: byteLength(event.data) }
  }
  return frame
}

/**
 * Trim one event payload by type. Large fields that B cannot use
 * (`request/header` tool schemas, assistant compact streams) are dropped.
 * @param {string} type - session event type.
 * @param {any} data - the logged payload.
 * @returns {any} JSON-safe, bounded payload.
 */
export function trimEventData(type, data) {
  const value = data && typeof data === 'object' ? data : {}
  switch (type) {
    case 'user/message': {
      // The logged payload is the model message itself; older shapes nest it
      // under `message`. Keep both working.
      const message = value.role !== undefined ? value : value.message
      return {
        ...identityOfMessage(message || value),
        message: trimMessage(message),
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
      }
    }
    case 'assistant/message':
      return {
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
        message: trimMessage(value.message),
        ...(value.interrupted === true ? { interrupted: true } : {}),
        ...(value.usage === undefined ? {} : { usage: value.usage }),
      }
    case 'assistant/attempt':
      return {
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
        ...(value.interrupted === true ? { interrupted: true } : {}),
        ...(value.error === undefined ? {} : { error: trimError(value.error) }),
      }
    case 'tool/call':
      return {
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
        callId: String(value.callId ?? ''),
        name: String(value.name ?? ''),
        arguments: trimArguments(value.arguments),
      }
    case 'tool/result':
      return {
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
        message: trimMessage(value.message),
        ...(value.error === undefined ? {} : { error: trimError(value.error) }),
        ...(value.meta === undefined ? {} : { meta: trimUnknown(value.meta, 4 * 1024) }),
      }
    case 'turn/start':
    case 'step/start':
    case 'step/end':
      return { ...(value.turn === undefined ? {} : { turn: value.turn }), ...(value.step === undefined ? {} : { step: value.step }) }
    case 'turn/end':
      return {
        turn: value.turn,
        reason: trimTurnEndReason(value.reason),
      }
    case 'approval/asked':
      return {
        id: String(value.id ?? ''),
        toolName: String(value.toolName ?? ''),
        ...(value.callId === undefined ? {} : { callId: String(value.callId) }),
        ...(value.reason === undefined ? {} : { reason: truncate(value.reason, 2000) }),
      }
    case 'approval/decided':
      return { id: String(value.id ?? ''), outcome: String(value.outcome ?? '') }
    case 'approval/policy':
      return { policy: String(value.policy ?? '') }
    case 'model/selection':
      return trimUnknown(value, 4 * 1024)
    case 'session/title':
      return { ...trimUnknown(value, 2 * 1024), title: truncate(value.title ?? '', 400) }
    case 'command/run':
    case 'command/done':
      return trimUnknown(value, 8 * 1024)
    case 'todo/write':
      return trimUnknown(value, 32 * 1024)
    case 'deliverables/presented':
      return trimUnknown(value, 16 * 1024)
    case 'job/registered':
    case 'job/settled':
    case 'llm/retry':
    case 'goal/change':
    case 'plan/mode':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'working-directory/change':
    case 'workspace/changes':
      return trimUnknown(value, 8 * 1024)
    default:
      return trimUnknown(value, 8 * 1024)
  }
}

/** Copy a user message's `rpcId`/`source.kind` for submit correlation. */
function identityOfMessage(value) {
  const source = value?.source
  if (!source || typeof source !== 'object') return {}
  return {
    source: {
      kind: String(source.kind ?? ''),
      ...(source.rpcId === undefined ? {} : { rpcId: String(source.rpcId) }),
    },
  }
}

/**
 * Trim one model message: keep role/id/content blocks and the provider source,
 * drop the embedded compact stream and anything over budget.
 * @param {any} message - logged message.
 * @returns {object|null} compact message.
 */
export function trimMessage(message) {
  if (!message || typeof message !== 'object') return null
  const content = Array.isArray(message.content) ? message.content.map(trimBlock).filter(Boolean) : []
  const out = {
    ...(message.id === undefined ? {} : { id: String(message.id) }),
    role: String(message.role ?? ''),
    content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: String(message.toolCallId) }),
    ...(message.isError === true ? { isError: true } : {}),
    ...(message.source === undefined ? {} : { source: trimUnknown(message.source, 2 * 1024) }),
  }
  let bytes = byteLength(out)
  while (bytes > LIMITS.maxFrameBytes && out.content.length > 0) {
    const last = out.content[out.content.length - 1]
    if (last.type === 'text' && typeof last.text === 'string' && last.text.length > 512) {
      last.text = truncate(last.text, Math.max(512, Math.floor(last.text.length / 2)))
      bytes = byteLength(out)
      continue
    }
    out.content.pop()
    bytes = byteLength(out)
  }
  return out
}

/** Trim one content block. */
function trimBlock(block) {
  if (!block || typeof block !== 'object') return null
  switch (block.type) {
    case 'text':
      return { type: 'text', text: truncate(block.text, LIMITS.maxTextChars) }
    case 'reasoning':
      return { type: 'reasoning', text: truncate(block.text ?? block.reasoning ?? '', LIMITS.maxTextChars) }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: trimArguments(block.arguments),
      }
    case 'tool-result':
      return { type: 'tool-result', toolCallId: String(block.toolCallId ?? ''), content: trimUnknown(block.content, 8 * 1024) }
    case 'image':
      return { type: 'image', attachment: { attachmentId: String(block.attachment?.attachmentId ?? '') } }
    case 'file':
      return { type: 'file', attachment: trimUnknown(block.attachment ?? {}, 1024) }
    default:
      return { type: String(block.type ?? 'unknown') }
  }
}

/** Tool arguments: JSON string when raw, else a bounded object. */
function trimArguments(args) {
  if (typeof args === 'string') return truncate(args, LIMITS.maxToolArgsChars)
  return trimUnknown(args, LIMITS.maxToolArgsChars)
}

/** Drop fields of unknown shape beyond a byte budget (best effort). */
function trimUnknown(value, maxChars) {
  try {
    const text = JSON.stringify(value ?? null)
    if (typeof text !== 'string') return null
    if (text.length <= maxChars) return JSON.parse(text)
    return { truncated: true, preview: `${text.slice(0, maxChars)}…` }
  } catch {
    return null
  }
}

/** Normalize a turn-end reason union into a small display object. */
export function trimTurnEndReason(reason) {
  if (!reason || typeof reason !== 'object') return { kind: 'unknown' }
  const kind = String(reason.kind ?? 'unknown')
  if (kind === 'aborted') {
    const cause = reason.reason
    return { kind, cause: typeof cause?.kind === 'string' ? cause.kind : 'unknown' }
  }
  if (kind === 'error') return { kind, error: trimError(reason.error) }
  if (kind === 'hook') return { kind, reason: truncate(reason.reason ?? '', 500) }
  return { kind }
}

/** Trim one error descriptor. */
export function trimError(error) {
  if (!error || typeof error !== 'object') return { message: String(error ?? '') }
  return {
    ...(error.code === undefined ? {} : { code: String(error.code) }),
    message: truncate(error.message ?? '', 2000),
  }
}

/**
 * Join the text blocks of an assistant message (same rule as the qqbot bridge:
 * non-text blocks skipped, empty text ignored).
 * @param {any} message - assistant message.
 * @returns {string} joined text.
 */
export function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (!block || block.type !== 'text') continue
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text) parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * Normalize one live `agent/assistant-stream` frame into a transient frame.
 * Frames are the loop's own `{type:'start'|'chunk'|'end', attemptId, revision,
 * index?, time?, chunk?, outcome?}` records (dsh-agent-loop lib/index.js).
 * @param {any} payload - emitted `agent/assistant-stream` payload ({agent, frame}).
 * @returns {object|null} transient frame.
 */
export function normalizeStreamFrame(payload) {
  const frame = payload?.frame
  if (!frame || typeof frame !== 'object') return null
  const agent = payload?.agent
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const type = String(frame.type ?? '')
  if (type !== 'start' && type !== 'chunk' && type !== 'end') return null
  const out = {
    kind: 'stream',
    sessionId,
    attemptId: String(frame.attemptId ?? ''),
    revision: Number(frame.revision) || 0,
    type,
    ...(frame.index === undefined ? {} : { index: Number(frame.index) }),
    ...(frame.turn === undefined ? {} : { turn: frame.turn }),
    ...(frame.step === undefined ? {} : { step: frame.step }),
  }
  if (type === 'chunk') {
    out.time = Number(frame.time) || 0
    out.chunk = trimChunk(frame.chunk)
  }
  if (type === 'end') out.outcome = trimUnknown(frame.outcome, 2 * 1024)
  return out
}

/** Trim one provider stream chunk (dsh-llm assistant-stream vocabulary). */
function trimChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return { type: 'unknown' }
  switch (chunk.type) {
    case 'text-delta':
      return { type: 'text-delta', index: Number(chunk.index) || 0, text: truncate(chunk.text, LIMITS.maxTextChars) }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', index: Number(chunk.index) || 0, text: truncate(chunk.text, LIMITS.maxTextChars) }
    case 'tool-call-delta':
      return {
        type: 'tool-call-delta',
        index: Number(chunk.index) || 0,
        id: String(chunk.id ?? ''),
        ...(chunk.name === undefined ? {} : { name: String(chunk.name) }),
        argumentsDelta: truncate(chunk.argumentsDelta, LIMITS.maxToolArgsChars),
      }
    case 'finish':
      return trimUnknown(chunk, 1024)
    default:
      return { type: String(chunk.type ?? 'unknown') }
  }
}
