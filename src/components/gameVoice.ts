/**
 * gameVoice.ts — drop-in replacement
 *
 * Giữ nguyên 3 export cũ (createGameVoiceRecognition, resolveGameVoiceCommand, VoiceGame)
 * nên RandomGameOrb.tsx không cần đổi import.
 *
 * Điểm khác so với bản cũ:
 *  - maxAlternatives = 5, và match trên TẤT CẢ alternatives, không chỉ cái đầu.
 *  - Matching fuzzy + phonetic (metaphone rút gọn) thay vì so chuỗi cứng.
 *  - Chuẩn hoá số La Mã / số chữ / dấu tiếng Việt / hậu tố "Remastered, GOTY...".
 *  - Tự sinh acronym (Counter Strike 2 -> cs2, Grand Theft Auto V -> gta5).
 *  - warmUpMic() để mic không bị "nuốt" 300-500ms đầu câu.
 *  - Phân biệt lỗi permission / no-speech / network thay vì gộp một cục.
 */

/* ------------------------------------------------------------------ types */

export interface VoiceGame {
  id: string
  /** Bản cũ của bạn có thể dùng `name` hoặc `title` — module này nhận cả hai. */
  name?: string
  title?: string
  aliases?: string[]
}

export type VoiceErrorCode =
  | 'unsupported'
  | 'not-allowed'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'unknown'

export interface VoiceResultPayload {
  transcript: string
  isFinal: boolean
  /** Toàn bộ alternatives của kết quả final, đã sort theo confidence. */
  alternatives: string[]
  confidence: number
}

export interface VoiceRecognitionOptions {
  /** 'en-US' nếu thư viện game chủ yếu tên tiếng Anh. Mặc định auto-đoán. */
  lang?: string
  onStart?: () => void
  onResult?: (payload: VoiceResultPayload) => void
  onError?: (code: VoiceErrorCode) => void
  onEnd?: () => void
}

export interface GameMatch {
  gameId: string
  score: number
  matchedOn: string
}

/* ------------------------------------------------- normalisation helpers */

const NUM_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  mot: '1', hai: '2', ba: '3', bon: '4', nam: '5', sau: '6',
  bay: '7', tam: '8', chin: '9', muoi: '10',
}

const ROMAN: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7',
  viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13',
  xiv: '14', xv: '15', xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20',
}

/** Động từ ra lệnh ở đầu câu — bỏ đi trước khi match. */
const COMMAND_PREFIX =
  /^(?:ok|oke|hey|nay|nay claude)?\s*(?:play|open|launch|start|run|load|mo|choi|bat|chay|vao|khoi dong|toi muon choi|cho toi choi)\s+/

/** Hậu tố phiên bản — làm nhiễu match, bỏ đi ở cả hai phía. */
const EDITION_NOISE =
  /\b(?:remastered|remake|reloaded|definitive|deluxe|ultimate|complete|enhanced|anniversary|legacy|goty|game of the year|directors cut|special edition|edition|repack|full|crack|viet hoa|tieng viet)\b/g

const ACRONYM_SKIP = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'to', 'for'])

/** Bỏ dấu tiếng Việt + hạ thường + bỏ ký tự lạ. */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export const normalizeGameVoiceText = normalize

/** Đưa "five" / "V" / "nam" về "5" ở cả query lẫn tên game (đối xứng nên an toàn). */
function canonicalizeNumbers(normalized: string): string {
  return normalized
    .split(' ')
    .map((token) => NUM_WORDS[token] ?? ROMAN[token] ?? token)
    .join(' ')
}

function stripNoise(normalized: string): string {
  return normalized
    .replace(COMMAND_PREFIX, '')
    .replace(EDITION_NOISE, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Chuẩn hoá đầy đủ: dùng cho cả tên game và câu nói. */
export function canonical(input: string): string {
  return canonicalizeNumbers(stripNoise(normalize(input)))
}

function acronymOf(canonicalTitle: string): string | null {
  const words = canonicalTitle.split(' ').filter(Boolean)
  if (words.length < 2) return null
  let out = ''
  for (const w of words) {
    if (/^\d+$/.test(w)) out += w
    else if (!ACRONYM_SKIP.has(w)) out += w[0]
  }
  return out.length >= 2 ? out : null
}

/* ------------------------------------------------------------- phonetics */

/**
 * Metaphone rút gọn. Mục tiêu: "elton ring" và "elden ring" ra cùng skeleton,
 * "hollow night" khớp "hollow knight", "valerie ant" gần "valorant".
 */
export function phonetic(input: string): string {
  let t = input.replace(/\s+/g, '')
  if (!t) return ''
  t = t
    .replace(/^(kn|gn|pn|wr|ps)/, (m) => m[1])
    .replace(/^x/, 's')
    .replace(/ough/g, 'f')
    .replace(/ph/g, 'f')
    .replace(/sch/g, 'sk')
    .replace(/tch/g, 'x')
    .replace(/sh/g, 'x')
    .replace(/ch/g, 'x')
    .replace(/ck/g, 'k')
    .replace(/th/g, '0')
    .replace(/qu/g, 'kw')
    .replace(/gh/g, 'g')
    .replace(/c(?=[iey])/g, 's')
    .replace(/c/g, 'k')
    .replace(/g(?=[iey])/g, 'j')
    .replace(/z/g, 's')
    .replace(/([aeiou])h/g, '$1')
    .replace(/(.)\1+/g, '$1')
  const head = t[0] ?? ''
  return head + t.slice(1).replace(/[aeiouyw]/g, '')
}

/* --------------------------------------------------------------- scoring */

function bigrams(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}

/** Dice coefficient trên bigram — tốt cho sai vài ký tự giữa chuỗi. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const ba = bigrams(a)
  const bb = bigrams(b)
  const pool = new Map<string, number>()
  for (const g of ba) pool.set(g, (pool.get(g) ?? 0) + 1)
  let hits = 0
  for (const g of bb) {
    const n = pool.get(g) ?? 0
    if (n > 0) {
      pool.set(g, n - 1)
      hits++
    }
  }
  return (2 * hits) / (ba.length + bb.length)
}

/** Jaro-Winkler — tốt cho sai ở cuối chuỗi và hoán vị ký tự. */
function jaroWinkler(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aFlags = new Array<boolean>(a.length).fill(false)
  const bFlags = new Array<boolean>(b.length).fill(false)
  let matches = 0

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window)
    const hi = Math.min(i + window + 1, b.length)
    for (let j = lo; j < hi; j++) {
      if (!bFlags[j] && a[i] === b[j]) {
        aFlags[i] = true
        bFlags[j] = true
        matches++
        break
      }
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aFlags[i]) continue
    while (!bFlags[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2

  const m = matches
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3
  let prefix = 0
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Điểm tương đồng tổng hợp giữa câu nói (a) và một biến thể tên game (b). */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1

  const na = a.replace(/ /g, '')
  const nb = b.replace(/ /g, '')
  if (na === nb) return 0.985

  // Nói đúng phần đầu tên game: "resident evil" -> "resident evil village"
  if (nb.startsWith(na) && na.length >= 4) return 0.9 + 0.07 * (na.length / nb.length)
  if (na.startsWith(nb) && nb.length >= 4) return 0.88 + 0.07 * (nb.length / na.length)
  if (nb.includes(na) && na.length >= 5) return 0.85
  if (na.includes(nb) && nb.length >= 5) return 0.83

  const d = dice(na, nb)
  const jw = jaroWinkler(na, nb)
  const ph = dice(phonetic(a), phonetic(b))

  // Trọng số: chính tả trước, phát âm là lưới đỡ.
  return Math.max(d * 0.96, jw * 0.9, ph * 0.87)
}

/* -------------------------------------------------------- game indexing */

interface IndexedGame {
  id: string
  variants: string[]
  display: string
}

const indexCache = new WeakMap<object, IndexedGame[]>()

function titleOf(game: VoiceGame): string {
  return game.title ?? game.name ?? game.id
}

function buildIndex(games: VoiceGame[]): IndexedGame[] {
  const cached = indexCache.get(games as unknown as object)
  if (cached) return cached

  const index = games.map((game) => {
    const display = titleOf(game)
    const base = canonical(display)
    const variants = new Set<string>()
    if (base) {
      variants.add(base)
      variants.add(base.replace(/ /g, ''))
      const acr = acronymOf(base)
      if (acr) variants.add(acr)
      // Bỏ phần sau dấu hai chấm: "Half-Life 2: Episode One" -> "half life 2"
      const colonIdx = display.indexOf(':')
      if (colonIdx > 0) {
        const head = canonical(display.slice(0, colonIdx))
        if (head) variants.add(head)
      }
    }
    for (const alias of game.aliases ?? []) {
      const c = canonical(alias)
      if (c) {
        variants.add(c)
        variants.add(c.replace(/ /g, ''))
      }
    }
    return { id: game.id, display, variants: [...variants].filter(Boolean) }
  })

  indexCache.set(games as unknown as object, index)
  return index
}

/* ---------------------------------------------------------------- match */

const ACCEPT_THRESHOLD = 0.62
/** Nếu hạng 1 và hạng 2 sát nhau thế này thì coi là mơ hồ, nên hỏi lại. */
const AMBIGUITY_GAP = 0.06

/**
 * Xếp hạng game khớp nhất với danh sách transcript (alternatives từ ASR).
 * Alternatives sau bị phạt nhẹ để bản đầu vẫn được ưu tiên.
 */
export function rankGameMatches(
  transcripts: string[],
  games: VoiceGame[],
  limit = 3,
): GameMatch[] {
  const index = buildIndex(games)
  const queries = transcripts
    .map((t) => canonical(t))
    .filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i)
  if (queries.length === 0 || index.length === 0) return []

  const best = new Map<string, GameMatch>()

  queries.forEach((query, qi) => {
    const penalty = 1 - Math.min(qi, 4) * 0.03
    const queryNoSpace = query.replace(/ /g, '')

    for (const game of index) {
      let localBest = 0
      let matchedOn = game.display
      for (const variant of game.variants) {
        const s = Math.max(similarity(query, variant), similarity(queryNoSpace, variant))
        if (s > localBest) {
          localBest = s
          matchedOn = variant
        }
      }
      const score = localBest * penalty
      const prev = best.get(game.id)
      if (!prev || score > prev.score) {
        best.set(game.id, { gameId: game.id, score, matchedOn })
      }
    }
  })

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Kết quả đủ tự tin để mở luôn, hay nên hiển thị danh sách cho người dùng chọn. */
export function resolveGameVoiceMatch(
  transcripts: string | string[],
  games: VoiceGame[],
): { status: 'match'; gameId: string } | { status: 'ambiguous'; options: GameMatch[] } | { status: 'none' } {
  const list = Array.isArray(transcripts) ? transcripts : [transcripts]
  const ranked = rankGameMatches(list, games)
  if (ranked.length === 0 || ranked[0].score < ACCEPT_THRESHOLD) return { status: 'none' }
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < AMBIGUITY_GAP) {
    return { status: 'ambiguous', options: ranked.filter((m) => m.score >= ACCEPT_THRESHOLD) }
  }
  return { status: 'match', gameId: ranked[0].gameId }
}

/** Giữ nguyên chữ ký cũ để component hiện tại chạy được ngay. */
export function resolveGameVoiceCommand(
  transcript: string | string[],
  games: VoiceGame[],
): string | null {
  const result = resolveGameVoiceMatch(transcript, games)
  if (result.status === 'match') return result.gameId
  if (result.status === 'ambiguous') return result.options[0].gameId
  return null
}

/* ----------------------------------------------------------- recognition */

type SpeechRecognitionCtor = new () => any

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isVoiceSupported(): boolean {
  return getRecognitionCtor() !== null
}

let warmStream: MediaStream | null = null
let warmTimer: number | null = null

/**
 * Mở sẵn mic để engine không mất 300-500ms khởi động (đây là lý do chính
 * làm mất chữ đầu câu). Gọi ngay khi pointerdown, không cần await.
 */
export async function warmUpMic(holdMs = 8000): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
  if (warmTimer) window.clearTimeout(warmTimer)
  try {
    if (!warmStream) {
      warmStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    }
  } catch {
    warmStream = null
    return
  }
  warmTimer = window.setTimeout(releaseMic, holdMs)
}

export function releaseMic(): void {
  if (warmTimer) window.clearTimeout(warmTimer)
  warmTimer = null
  warmStream?.getTracks().forEach((t) => t.stop())
  warmStream = null
}

/** Stream để vẽ waveform thật thay vì thanh CSS giả. */
export function getWarmStream(): MediaStream | null {
  return warmStream
}

function mapError(code: string): VoiceErrorCode {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed'
    case 'no-speech':
      return 'no-speech'
    case 'network':
      return 'network'
    case 'aborted':
      return 'aborted'
    default:
      return 'unknown'
  }
}

export function createGameVoiceRecognition(options: VoiceRecognitionOptions) {
  const Ctor = getRecognitionCtor()
  if (!Ctor) {
    return {
      start: () => {
        options.onError?.('unsupported')
        return false
      },
      stop: () => {},
      abort: () => {},
    }
  }

  const recognition = new Ctor()
  recognition.lang = options.lang ?? 'en-US'
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 5

  let finished = false

  recognition.onstart = () => options.onStart?.()

  recognition.onresult = (event: any) => {
    const result = event.results[event.results.length - 1]
    const alternatives: string[] = []
    for (let i = 0; i < result.length; i++) {
      const t = String(result[i].transcript ?? '').trim()
      if (t) alternatives.push(t)
    }
    if (alternatives.length === 0) return
    if (result.isFinal) finished = true
    options.onResult?.({
      transcript: alternatives[0],
      isFinal: Boolean(result.isFinal),
      alternatives,
      confidence: Number(result[0]?.confidence ?? 0),
    })
  }

  recognition.onerror = (event: any) => options.onError?.(mapError(String(event?.error ?? '')))

  recognition.onend = () => {
    options.onEnd?.()
    if (!finished) options.onResult?.({ transcript: '', isFinal: true, alternatives: [], confidence: 0 })
  }

  return {
    start(): boolean {
      try {
        recognition.start()
        return true
      } catch {
        return false
      }
    },
    /** Dừng nhưng vẫn chờ engine trả kết quả final. Dùng khi người dùng nhả nút. */
    stop(): void {
      try {
        recognition.stop()
      } catch {
        /* noop */
      }
    },
    /** Huỷ, không chờ kết quả. Chỉ dùng khi unmount. */
    abort(): void {
      finished = true
      try {
        recognition.abort()
      } catch {
        /* noop */
      }
    },
  }
}
