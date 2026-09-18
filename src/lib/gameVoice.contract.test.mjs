import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const voice = await readFile(new URL('./gameVoice.ts', import.meta.url), 'utf8')
const orb = await readFile(new URL('../components/RandomGameOrb.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../components/RandomGameOrb.css', import.meta.url), 'utf8')
const titlebar = await readFile(new URL('../components/CustomTitleBar.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')

assert.ok(voice.includes('normalizeGameVoiceText'), 'voice module must normalize transcripts')
assert.ok(voice.includes('resolveGameVoiceCommand'), 'voice module must resolve game names')
assert.ok(voice.includes('webkitSpeechRecognition'), 'voice module must support WebKit speech recognition')
assert.ok(voice.includes("'unsupported'"), 'voice module must expose an unsupported fallback')
assert.ok(voice.includes('permission-denied'), 'voice module must classify microphone permission failures')

assert.ok(orb.includes('HOLD_TO_TALK_MS = 340'), 'orb must have a deliberate hold-to-talk threshold')
assert.ok(orb.includes('onPointerDown'), 'orb must start gesture tracking with pointer events')
assert.ok(orb.includes('onPointerUp'), 'orb must finish gesture tracking with pointer events')
assert.ok(orb.includes('onPointerCancel'), 'orb must cancel interrupted pointer gestures')
assert.ok(orb.includes('onPointerCancel={handlePointerCancel}'), 'cancelled gestures must not reuse the random-click handler')
assert.ok(orb.includes('aria-live="polite"'), 'orb must announce voice status accessibly')
assert.ok(orb.includes('resolveGameVoiceCommand(transcript, games)'), 'orb must resolve final speech through the shared resolver')
assert.ok(orb.includes('random-orb-voice-overlay'), 'orb must render a centered voice overlay')
assert.ok(orb.includes('setPointerCapture'), 'orb must keep hold-to-talk active when the pointer moves')
assert.ok(orb.includes('voiceTranscript'), 'orb must expose interim voice transcript state')
assert.ok(titlebar.includes('randomGameGames?: Array<{ id: string; title: string }>'), 'title bar must accept game titles')
assert.ok(app.includes("depot_downloader_get_catalog"), 'app must load the Store catalog for the orb')
assert.ok(app.includes('randomGameGames={depotRandomGames}'), 'app must pass Store game titles to the orb')

assert.ok(styles.includes('.random-orb-btn:hover .random-orb-sphere'), 'orb must grow on hover')
assert.ok(styles.includes('@keyframes random-orb-burst'), 'orb must have a bounded landing burst')
assert.ok(styles.includes('@keyframes random-orb-listening-wave'), 'orb must show a listening wave')
assert.ok(styles.includes('position: fixed'), 'voice overlay must be positioned relative to the launcher viewport')
assert.ok(styles.includes('.random-orb-voice-bars'), 'voice overlay must include animated waveform bars')
assert.ok(styles.includes('@keyframes random-orb-voice-ring'), 'voice overlay must animate listening rings')
assert.ok(styles.includes('prefers-reduced-motion: reduce'), 'orb must respect reduced motion')

console.log('Game voice/orb contract tests passed')