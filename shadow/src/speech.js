// B-local voice bridge (0.10.25).
//
// Never part of the peer protocol: the display machine captures audio in its
// own browser, posts it to this machine's `shadow/rpc` data route, and *this*
// machine's Host transcribes it through the composed `speechToText` service.
// That keeps the audio on the machine that owns the microphone and avoids the
// dsh-sync broker's 1 MB / 8 MB envelopes entirely.
//
// The contract is the same pair of Host services the native voice plugin uses:
//   - `ctx.get('speechToText')`     registry: snapshot / resolve / transcribe / prepare
//   - `ctx.get('speechController')` api-speech-to-text: `.config` carries the
//                                   real `maxAudioBytes` / `maxDurationSeconds`
// Everything is looked up at call time and every lookup is try/catch-safe, so a
// Host without voice support degrades to `catalog().available === false` instead
// of breaking the route.
import { CODES } from './constants.js'
import { ShadowError, errorText } from './util.js'

/** Fallback recording limits, mirroring api-speech-to-text's Config defaults. */
export const SPEECH_DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024
export const SPEECH_DEFAULT_MAX_DURATION_SECONDS = 120

/** Positive integer or fallback. */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Create the B-local speech bridge. Never throws: a missing Host service or a
 * throwing fake context only makes `catalog()` report `available: false`.
 * @param {object} [ctx] - Host context (a fake is fine in tests).
 * @param {object} [options] - tuning overrides (`maxAudioBytes`, `maxDurationSeconds`, `log`).
 * @returns {{catalog: () => object, transcribe: (input: object) => Promise<object>, prepare: (input: object) => Promise<object>}}
 */
export function createSpeechBridge(ctx, options = {}) {
  const log = options?.log || null

  /** Read one Host service without throwing. */
  const service = (name) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const speechToText = () => service('speechToText')

  /**
   * Recording limits advertised to the client. Prefer the live controller
   * config; fall back to the api-speech-to-text defaults so the client always
   * has a usable number.
   * @returns {{maxAudioBytes: number, maxDurationSeconds: number}}
   */
  const limits = () => {
    let config
    try {
      config = service('speechController')?.config
    } catch {
      config = undefined
    }
    return {
      maxAudioBytes: positiveInt(
        config?.maxAudioBytes ?? options?.maxAudioBytes,
        SPEECH_DEFAULT_MAX_AUDIO_BYTES,
      ),
      maxDurationSeconds: positiveInt(
        config?.maxDurationSeconds ?? options?.maxDurationSeconds,
        SPEECH_DEFAULT_MAX_DURATION_SECONDS,
      ),
    }
  }

  /** The "nothing to transcribe with" shape; also used when snapshot() throws. */
  const unavailable = () => ({
    available: false,
    providers: [],
    selection: null,
    maxAudioBytes: 0,
    maxDurationSeconds: 0,
  })

  return {
    /**
     * Provider catalog + selection + recording limits. Never throws.
     * @returns {object} `{available, providers, selection, maxAudioBytes, maxDurationSeconds}`.
     */
    catalog() {
      try {
        const svc = speechToText()
        if (!svc || typeof svc.snapshot !== 'function') return unavailable()
        const snapshot = svc.snapshot()
        if (!snapshot || typeof snapshot !== 'object') return unavailable()
        const lim = limits()
        return {
          available: true,
          providers: Array.isArray(snapshot.providers) ? snapshot.providers : [],
          selection: snapshot.selection && typeof snapshot.selection === 'object' ? snapshot.selection : null,
          maxAudioBytes: lim.maxAudioBytes,
          maxDurationSeconds: lim.maxDurationSeconds,
        }
      } catch (error) {
        log?.warn?.('speech catalog failed', { error: errorText(error) })
        return unavailable()
      }
    },

    /**
     * Validate one canonical-base64 WAV and transcribe it through the selected
     * provider. Errors keep a routable `code` so the client can show copy.
     * @param {{audioBase64?: string, providerId?: string, language?: string}} input - recording.
     * @returns {Promise<{text: string, audioSeconds: number, inferenceSeconds: number}>}
     */
    async transcribe(input = {}) {
      const svc = speechToText()
      if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') {
        throw new ShadowError(CODES.notReady, 'speech-to-text is unavailable on this host')
      }
      const lim = limits()
      const encoded = typeof input.audioBase64 === 'string' ? input.audioBase64 : ''
      // Cheap size pre-check before decoding: base64 is 4 chars per 3 bytes.
      if (!encoded || encoded.length > Math.ceil(lim.maxAudioBytes / 3) * 4) {
        throw new ShadowError(CODES.attachBadChunk, 'audio is missing, invalid, or exceeds the recording size limit')
      }
      const audio = Buffer.from(encoded, 'base64')
      // Canonical only: reject whitespace, URL-safe and unpadded variants so the
      // bytes the Host validates are exactly the bytes the browser recorded.
      if (audio.toString('base64') !== encoded) {
        throw new ShadowError(CODES.attachBadChunk, 'audio must use canonical base64 encoding')
      }
      if (audio.length === 0) {
        throw new ShadowError(CODES.attachBadChunk, 'audio recording is empty')
      }
      if (audio.length > lim.maxAudioBytes) {
        throw new ShadowError(CODES.attachBadChunk, `audio exceeds the ${lim.maxAudioBytes}-byte recording limit`)
      }
      const providerId = typeof input.providerId === 'string' && input.providerId.trim() ? input.providerId.trim() : ''
      const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : ''
      const spec = svc.resolve({
        audio,
        ...(providerId ? { providerId } : {}),
        ...(language ? { language } : {}),
      })
      const result = await svc.transcribe(spec, new AbortController().signal)
      return {
        text: String(result?.text ?? ''),
        audioSeconds: Number(result?.audioSeconds) || 0,
        inferenceSeconds: Number(result?.inferenceSeconds) || 0,
      }
    },

    /**
     * Start (or join) provider-owned model preparation.
     * @param {{providerId?: string}} input - provider to prepare.
     * @returns {Promise<{started: boolean}>}
     */
    async prepare(input = {}) {
      const svc = speechToText()
      if (!svc) throw new ShadowError(CODES.notReady, 'speech-to-text is unavailable on this host')
      const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : ''
      if (typeof svc.prepare !== 'function') return { started: false }
      svc.prepare(providerId || undefined)
      return { started: true }
    },
  }
}
