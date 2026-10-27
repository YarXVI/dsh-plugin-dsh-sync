// Display-half Host route: the same-origin JSON endpoint its own Web client uses.
//
// A third-party client plugin cannot add a generated Typert Remote namespace
// (those come from build-time codegen), so this follows the proven pattern of
// the dsh-sync panel: one prefix route on the Host Web server, authenticated
// exactly like the rest of the GUI (browser cookie through
// `ctx.connection.requestRejection`, or loopback during local development).
//
// The route is a thin adapter over ShadowClientProxy. For `events` it passes an
// AbortSignal tied to the browser request, so closing the page stops the local
// long poll immediately (the proxy also tells the sharing peer to release its
// in-flight request).
import { DATA_ROUTE } from './constants.js'
import { createAuthorizer, readJsonBody, sendJson } from './http.js'
import { createSpeechBridge } from './speech.js'
import { errorText } from './util.js'

/** Actions the data route accepts. */
export const DATA_ACTIONS = Object.freeze([
  'state', 'open', 'close', 'create', 'prompt', 'cancel', 'answer', 'events', 'approvals', 'pause',
  'models', 'select-model', 'questions', 'answer-question',
  // Chunked file transfer (0.9.0): local receive switch + push steps.
  'uploads-enable', 'push-file',
  // Composer controls (0.10.25): permission presets, attachment staging and
  // B-local speech-to-text.
  'permissions', 'attach', 'voice',
])

/**
 * Body cap for the `voice` action only. One 120 s PCM16 WAV is ≈5.2 MB as
 * base64; every other action keeps the 1 MB `MAX_LOCAL_BODY` default.
 */
export const MAX_VOICE_BODY = 8 * 1024 * 1024

/**
 * Create the data route handler. Exported separately so the self-test can drive
 * it with fake request/response objects and no Web server.
 * @param {object} options - handler wiring.
 * @param {object} options.ctx - Host context.
 * @param {import('./b-proxy.js').ShadowClientProxy} options.proxy - display proxy.
 * @param {object} [options.log] - logger.
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createDataHandler(options = {}) {
  const { ctx, proxy, log = null } = options
  const authorize = createAuthorizer(ctx)
  // B-local voice bridge: it reads `speechToText` / `speechController` from the
  // Host at call time and degrades to `{available:false}` when the Host has no
  // voice support. Tests may inject a fake.
  const speech = options.speech || createSpeechBridge(ctx, { log })
  return async function handleData(req, res) {
    const admission = authorize(req)
    if (!admission.ok) {
      log?.warn?.('data route forbidden', { status: admission.status, remote: String(req?.socket?.remoteAddress || '') })
      sendJson(res, admission.status, { ok: false, error: { code: 'forbidden', message: 'shadow data route is available to the local GUI only' } })
      return
    }
    if (req.method === 'GET') {
      const started = Date.now()
      try {
        const state = await proxy.state()
        log?.debug?.('data route GET state', {
          online: state.online,
          workspaces: state.workspaces?.length || 0,
          sessions: state.sessions?.length || 0,
          ms: Date.now() - started,
        })
        sendJson(res, 200, { ok: true, state, approvals: proxy.approvals(), stats: proxy.stats(), uploads: proxy.uploadsState() })
      } catch (error) {
        log?.warn?.('data route GET state failed', { error })
        sendJson(res, 500, { ok: false, error: { code: 'state', message: errorText(error) } })
      }
      return
    }
    if (req.method !== 'POST') {
      log?.warn?.('data route method not allowed', { method: String(req?.method || '') })
      sendJson(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST' } })
      return
    }
    let body
    try {
      // The action is only readable from the body, but the `voice` transcribe
      // payload can be ~5.2 MB while every other action stays capped at 1 MB.
      // The bundled client therefore announces the action in this header; an
      // absent/unrelated header keeps the default cap.
      const hintedAction = String(req?.headers?.['x-shadow-action'] ?? '')
      body = await readJsonBody(req, hintedAction === 'voice' ? MAX_VOICE_BODY : undefined)
    } catch (error) {
      log?.warn?.('data route body invalid', { error })
      sendJson(res, error.statusCode || 400, { ok: false, error: { code: 'bad-json', message: errorText(error) } })
      return
    }
    const action = String(body?.action ?? '')
    // A closed page aborts its fetch; stop waiting on the mirror right away.
    const controller = new AbortController()
    const onClosed = () => {
      if (!res.writableEnded) controller.abort()
    }
    req.on?.('aborted', onClosed)
    res.on?.('close', onClosed)
    const started = Date.now()
    try {
      const value = await runDataAction({ proxy, action, body, signal: controller.signal, speech })
      if (action === 'events') {
        const batch = value.batch || {}
        log?.debug?.('data route events', {
          sessionId: String(body?.sessionId || ''),
          frames: (batch.events?.length || 0) + (batch.transient?.length || 0),
          aborted: controller.signal.aborted,
          ms: Date.now() - started,
        })
      } else {
        log?.info?.('data route action ok', { action, sessionId: String(body?.sessionId || ''), ms: Date.now() - started })
      }
      sendJson(res, 200, { ok: true, ...value })
    } catch (error) {
      const aborted = controller.signal.aborted
      if (aborted) {
        log?.debug?.('data route request aborted by page close', { action, sessionId: String(body?.sessionId || '') })
        return
      }
      const status = typeof error?.code === 'string' && (
        error.code === 'shadow/bad-request'
        || error.code === 'shadow/uploads-disabled'
        || error.code === 'shadow/upload-not-found'
        || error.code === 'shadow/upload-hash-mismatch'
        || error.code === 'shadow/payload-too-large'
        || error.code === 'shadow/permission-unavailable'
        || error.code === 'shadow/attach-disabled'
        || error.code === 'shadow/attach-not-found'
        || error.code === 'shadow/attach-too-large'
        || error.code === 'shadow/attach-busy'
        || error.code === 'shadow/attach-bad-chunk'
        || error.code === 'shadow/attach-bad-kind'
      ) ? 400 : 500
      log?.warn?.('data route action failed', { action, sessionId: String(body?.sessionId || ''), code: String(error?.code || ''), error })
      sendJson(res, status, {
        ok: false,
        error: { code: typeof error?.code === 'string' ? error.code : 'shadow/internal', message: errorText(error) },
      })
    }
  }
}

/**
 * Dispatch one display-local UI action.
 * @param {{proxy: import('./b-proxy.js').ShadowClientProxy, action: string, body: object, signal?: AbortSignal, speech?: object}} input - action input.
 * @returns {Promise<object>} JSON body additions.
 */
export async function runDataAction({ proxy, action, body, signal, speech }) {
  switch (action) {
    case 'state':
      return { state: await proxy.state(), approvals: proxy.approvals(), stats: proxy.stats(), uploads: proxy.uploadsState() }
    case 'open':
      return { open: await proxy.openSession(body.sessionId) }
    case 'close':
      return { closed: proxy.closeSession(body.sessionId) }
    case 'create':
      return {
        created: await proxy.createSession({
          workspaceId: body.workspaceId,
          agentPreset: body.agentPreset,
          ...(body.model && typeof body.model === 'object' ? { model: body.model } : {}),
        }),
      }
    case 'prompt':
      return {
        prompt: await proxy.prompt({
          sessionId: body.sessionId,
          text: body.text,
          requestId: body.requestId,
          // 0.10.25: staged composer attachments (order is meaningful).
          attachments: body.attachments,
        }),
      }
    case 'cancel':
      return { cancel: await proxy.cancel({ sessionId: body.sessionId }) }
    case 'answer':
      return { answer: await proxy.answer({ sessionId: body.sessionId, approvalId: body.approvalId, outcome: body.outcome }) }
    case 'events':
      return {
        batch: await proxy.localEvents({
          sessionId: body.sessionId,
          sinceSeq: body.sinceSeq,
          sinceRev: body.sinceRev,
          epoch: body.epoch,
          waitMs: body.waitMs,
          signal,
        }),
      }
    case 'approvals':
      return { approvals: proxy.approvals() }
    case 'questions':
      return { questions: proxy.questions() }
    case 'answer-question':
      return {
        result: await proxy.answerQuestion({
          sessionId: body.sessionId,
          questionId: body.questionId,
          answers: body.answers,
          cancel: body.cancel === true,
          reason: body.reason,
        }),
      }
    case 'models':
      return { models: await proxy.models(body.force === true) }
    case 'select-model':
      return {
        selected: (await proxy.selectModel({
          sessionId: body.sessionId,
          provider: body.provider,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        })).selected,
      }
    case 'pause':
      proxy.setPaused(body.paused === true)
      return { paused: body.paused === true }
    // -------------------------------------------------------------------
    // Chunked file transfer (0.9.0)
    // -------------------------------------------------------------------
    case 'uploads-enable': {
      // A-half switch: accept files from paired peers on this device. Off by
      // default; the same value is persisted in state.json.
      proxy.setUploadsEnabled(body.enabled === true)
      return { uploads: proxy.uploadsState() }
    }
    case 'push-file': {
      // One transfer step from the local file picker; forwarded to the selected
      // peer as `ext.shadow.push-file`. Chunks carry base64 file bytes only.
      return {
        push: await proxy.pushFileStep({
          // `body.step` is the transfer step; the data-route action
          // ('push-file') stays under `action`. Callers exercising the route
          // directly may still put the step in `action`: accept that too, but
          // never mistake the route action itself for a step.
          action: body.step ?? (body.action === 'push-file' ? '' : body.action),
          transferId: body.transferId,
          name: body.name,
          size: body.size,
          sha256: body.sha256,
          index: body.index,
          data: body.data,
        }),
      }
    }
    // -------------------------------------------------------------------
    // Composer controls (0.10.25)
    // -------------------------------------------------------------------
    case 'permissions':
      // Permission preset catalog (`op:'catalog'`) or one switch
      // (`op:'set'`); the sharing peer re-checks ownership + risk confirmation.
      return {
        permissions: await proxy.permissions({
          sessionId: body.sessionId,
          op: body.op,
          preset: body.preset,
          confirmed: body.confirmed === true,
        }),
      }
    case 'attach': {
      // One staging step for a composer attachment; `body.step` is the step
      // (`begin|chunk|commit|abort`), never the route action itself.
      return {
        attach: await proxy.attachStep({
          sessionId: body.sessionId,
          action: body.step ?? (body.action === 'attach' ? undefined : body.action),
          transferId: body.transferId,
          index: body.index,
          data: body.data,
          kind: body.kind,
          name: body.name,
          size: body.size,
          mediaType: body.mediaType,
        }),
      }
    }
    case 'voice': {
      // B-local speech-to-text: the audio never crosses the peer protocol, it
      // is transcribed by this machine's own Host `speechToText` service.
      if (!speech) {
        throw Object.assign(new Error('the voice bridge is unavailable on this Host'), { code: 'shadow/not-ready' })
      }
      const op = String(body?.op ?? 'catalog')
      if (op === 'catalog') return { voice: await speech.catalog() }
      if (op === 'transcribe') {
        return {
          voice: await speech.transcribe({
            audioBase64: body.audioBase64,
            providerId: body.providerId,
            language: body.language,
          }),
        }
      }
      if (op === 'prepare') return { voice: await speech.prepare({ providerId: body.providerId }) }
      throw Object.assign(new Error(`unknown voice op: ${op}`), { code: 'shadow/bad-request' })
    }
    default:
      throw Object.assign(new Error(`unknown shadow action: ${action}`), { code: 'shadow/bad-request' })
  }
}

/** Route path exported for tests and documentation. */
export const LOCAL_DATA_ROUTE = DATA_ROUTE
