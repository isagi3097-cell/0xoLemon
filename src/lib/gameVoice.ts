export type VoiceGame = {
  id: string
  title: string
  aliases?: string[]
}

export type SpeechRecognitionResultLike = {
  transcript: string
  isFinal: boolean
}

export type GameVoiceError = 'unsupported' | 'permission-denied' | 'no-speech' | 'unknown'

export type GameVoiceCallbacks = {
  onStart?: () => void
  onResult?: (result: SpeechRecognitionResultLike) => void
  onError?: (error: GameVoiceError) => void
  onEnd?: () => void
}

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

type SpeechRecognitionInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: Event & { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

const COMMAND_WORDS = new Set([
  'please', 'open', 'launch', 'play', 'start', 'find', 'show', 'choose', 'select', 'random',
  'game', 'mo', 'choi', 'bat', 'tim', 'goi', 'ten', 'name',
])

export function normalizeGameVoiceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function resolveGameVoiceCommand(transcript: string, games: readonly VoiceGame[]): string | null {
  const words = normalizeGameVoiceText(transcript).split(' ')
  while (words.length > 1 && COMMAND_WORDS.has(words[0])) words.shift()
  const normalizedTranscript = words.join(' ')
  if (!normalizedTranscript) return null

  const candidates = games.flatMap((game) => [
    { id: game.id, value: normalizeGameVoiceText(game.title) },
    ...(game.aliases ?? []).map((alias) => ({ id: game.id, value: normalizeGameVoiceText(alias) })),
  ]).filter((candidate) => candidate.value)

  const exactMatches = candidates.filter((candidate) => candidate.value === normalizedTranscript)
  if (new Set(exactMatches.map((candidate) => candidate.id)).size === 1) return exactMatches[0].id

  const partialMatches = candidates.filter((candidate) =>
    candidate.value.includes(normalizedTranscript) || normalizedTranscript.includes(candidate.value)
  )
  const uniqueIds = [...new Set(partialMatches.map((candidate) => candidate.id))]
  return uniqueIds.length === 1 ? uniqueIds[0] : null
}

export function createGameVoiceRecognition(
  callbacks: GameVoiceCallbacks,
  language = 'vi-VN',
): { start: () => boolean; stop: () => void; abort: () => void } {
  const constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition
  let recognition: SpeechRecognitionInstance | null = null

  if (constructor) {
    recognition = new constructor()
    recognition.lang = language
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onstart = callbacks.onStart ?? null
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1]
      if (!result) return
      callbacks.onResult?.({ transcript: result[0].transcript, isFinal: Boolean((result as { isFinal?: boolean }).isFinal) })
    }
    recognition.onerror = (event) => {
      const error = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'permission-denied'
        : event.error === 'no-speech'
          ? 'no-speech'
          : 'unknown'
      callbacks.onError?.(error)
    }
    recognition.onend = callbacks.onEnd ?? null
  }

  return {
    start: () => {
      if (!recognition) {
        callbacks.onError?.('unsupported')
        return false
      }
      try {
        recognition.start()
        return true
      } catch {
        callbacks.onError?.('unknown')
        return false
      }
    },
    stop: () => recognition?.stop(),
    abort: () => recognition?.abort(),
  }
}