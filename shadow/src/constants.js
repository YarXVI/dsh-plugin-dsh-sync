// Cross-machine protocol + product constants for the Shadow Workspace plugin.
//
// All remote operations go through dsh-sync's `dshSync` service as `ext.*`
// RPCs. dsh-sync 0.5.1 adds `registerRpc(op, handler, { allow: true })`, which
// lets this plugin work right after install without hand-editing the profile's
// `extRpcAllow` config. The security envelope (paired peers, encrypted body,
// ext. prefix, 1 MB request / 8 MB response, default 10 s timeout) is still
// owned by dsh-sync.

/** Wire protocol version. Bump on incompatible payload changes. */
export const PROTOCOL_VERSION = 1

/** Package version, mirrored from the merged plugin's package.json for diagnostics. */
export const PLUGIN_VERSION = '0.10.25'

/** Cordis service name exposed by dsh-sync 0.5.x. */
export const SYNC_SERVICE = 'dshSync'

/** A-side operations (served on the sharing machine, called by the display machine). */
export const OPS = Object.freeze({
  ping: 'ext.shadow.ping',
  info: 'ext.shadow.info',
  list: 'ext.shadow.list',
  create: 'ext.shadow.create',
  prompt: 'ext.shadow.prompt',
  cancel: 'ext.shadow.cancel',
  events: 'ext.shadow.events',
  approvals: 'ext.shadow.approvals',
  answer: 'ext.shadow.answer',
  // Model catalogue + per-session model selection (0.7.0).
  models: 'ext.shadow.models',
  selectModel: 'ext.shadow.select-model',
  // Interactive user questions / plan review (0.8.0).
  questions: 'ext.shadow.questions',
  answerQuestion: 'ext.shadow.answer-question',
  // Chunked file transfer receiver (0.9.0): one op, `action: begin|chunk|commit|abort`.
  pushFile: 'ext.shadow.push-file',
  // Composer controls (0.10.25): permission preset catalog/switch and the
  // in-memory attachment staging that feeds `ext.shadow.prompt.attachments`.
  permissions: 'ext.shadow.permissions',
  attach: 'ext.shadow.attach',
})

/** Every op this plugin serves. Used by self-test as a closed-set check. */
export const HOST_OPS = Object.freeze(Object.values(OPS))

/** B-side Host routes, served by the dsh-sync bundle. */
export const PANEL_ROUTE = '/plugins/dsh-plugin-dsh-sync/shadow'
export const DATA_ROUTE = '/plugins/dsh-plugin-dsh-sync/shadow/rpc'

/** Client-side slot keys. */
export const SETTINGS_KEY = 'shadow-workspace'
export const GROUP_PREFIX = 'shadow-workspace:'

/** Files under `$DSH_HOME/shadow-workspace`. */
export const STATE_FILE = 'state.json'
export const SESSIONS_FILE = 'sessions.json'
export const AUDIT_FILE = 'audit.jsonl'

/**
 * Received files land directly under `$DSH_HOME/shadow-uploads` (NOT inside the
 * state directory): a transferred file is a user artifact, not plugin state.
 */
export const UPLOADS_DIR = 'shadow-uploads'

/** Numeric limits. */
export const LIMITS = Object.freeze({
  maxEventFrames: 120,
  maxTransientFrames: 240,
  maxBatchBytes: 512 * 1024,
  maxFrameBytes: 96 * 1024,
  maxTextChars: 32 * 1024,
  maxToolArgsChars: 16 * 1024,
  defaultWaitMs: 15_000,
  maxWaitMs: 25_000,
  rpcTimeoutMarginMs: 6_000,
  defaultApprovalTtlMs: 60_000,
  defaultPresenceTtlMs: 45_000,
  minApprovalTtlMs: 5_000,
  maxPromptChars: 64 * 1024,
  defaultPromptsPerMinute: 20,
  maxEventOpenSessions: 4,
  maxAuditRows: 500,
  maxAuditFileBytes: 2 * 1024 * 1024,
  panelAuditRows: 20,
  maxBufferedEvents: 2000,
  maxBufferedTransient: 2000,
  maxQuestions: 8,
  maxQuestionChars: 16 * 1024,
  maxQuestionOptions: 12,
  maxAnswerChars: 4096,
  // Chunked file transfer (0.9.0). The dsh-sync broker caps one request body at
  // 1 MB, so a chunk is 512 KiB raw (≈700 KB as base64 in the JSON payload).
  maxUploadBytes: 64 * 1024 * 1024,
  uploadChunkBytes: 512 * 1024,
  uploadTtlMs: 10 * 60 * 1000,
  maxUploadTransfers: 8,
  maxUploadNameChars: 180,
  maxUploadTransferIdChars: 120,
  maxUploadCompleted: 32,
  // Chunked prompt-attachment staging (0.10.25). Same broker budget as the
  // upload receiver: one 512 KiB raw chunk travels as ≈700 KB base64 inside the
  // peer RPC body. Staging is in-memory only; the Host admission stores the
  // final bytes once the prompt is accepted.
  attachChunkBytes: 512 * 1024,
  maxAttachBytes: 64 * 1024 * 1024,
  attachTtlMs: 10 * 60 * 1000,
  maxAttachTransfers: 8,
  maxPromptAttachments: 20,
  maxPromptImageBytes: 20 * 1024 * 1024,
})

/** Session-event types forwarded to the display machine. Everything else stays local. */
export const FORWARDED_EVENT_TYPES = Object.freeze(new Set([
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'model/selection',
  'permission/preset',
  'sandbox/mode',
  'session/title',
  'command/run',
  'command/done',
  'todo/write',
  'deliverables/presented',
  'goal/change',
  'plan/mode',
  'job/registered',
  'job/settled',
  'llm/retry',
  'working-directory/change',
  'workspace/changes',
]))

/** Approval outcomes accepted from the display machine (same set the Host answerer returns). */
export const ANSWER_OUTCOMES = Object.freeze(['allowed-once', 'rejected'])

/** Every outcome the approval waterfall can produce. */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** RPC error codes raised by this plugin (stable; the client routes on them). */
export const CODES = Object.freeze({
  disabled: 'shadow/disabled',
  notReady: 'shadow/not-ready',
  badRequest: 'shadow/bad-request',
  sharingOff: 'shadow/sharing-off',
  notShared: 'shadow/workspace-not-shared',
  notManaged: 'shadow/session-not-managed',
  notOwner: 'shadow/not-owner',
  notFound: 'shadow/session-not-found',
  peerRequired: 'shadow/peer-required',
  peerOffline: 'shadow/peer-offline',
  approvalGone: 'shadow/approval-not-pending',
  approvalTtl: 'shadow/approval-expired',
  questionGone: 'shadow/question-not-pending',
  questionTtl: 'shadow/question-expired',
  questionBadAnswer: 'shadow/question-invalid-answer',
  rateLimited: 'shadow/rate-limited',
  tooManySessions: 'shadow/too-many-open-sessions',
  payloadTooLarge: 'shadow/payload-too-large',
  // Chunked file transfer (0.9.0).
  uploadsDisabled: 'shadow/uploads-disabled',
  uploadNotFound: 'shadow/upload-not-found',
  uploadHashMismatch: 'shadow/upload-hash-mismatch',
  uploadBusy: 'shadow/upload-busy',
  // Composer controls (0.10.25).
  permissionUnavailable: 'shadow/permission-unavailable',
  attachDisabled: 'shadow/attach-disabled',
  attachNotFound: 'shadow/attach-not-found',
  attachTooLarge: 'shadow/attach-too-large',
  attachBusy: 'shadow/attach-busy',
  attachBadChunk: 'shadow/attach-bad-chunk',
  attachBadKind: 'shadow/attach-bad-kind',
  internal: 'shadow/internal',
})




















