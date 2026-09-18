import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('SteamDirectDepotView uses custom concurrency dropdown and does not render native select', () => {
  const tsxPath = path.resolve(__dirname, 'SteamDirectDepotView.tsx')
  const content = fs.readFileSync(tsxPath, 'utf8')

  // Must not have native <select> for concurrency
  assert.ok(!content.includes('<select'), 'Must not contain native <select> element')

  // Must have custom select trigger and menu
  assert.ok(content.includes('steam-direct-custom-select-wrap'), 'Must render custom select wrapper')
  assert.ok(content.includes('steam-direct-select-trigger'), 'Must render custom select trigger button')
  assert.ok(content.includes('steam-direct-select-menu'), 'Must render custom select dropdown menu')
  assert.ok(content.includes('CONCURRENCY_OPTIONS'), 'Must use CONCURRENCY_OPTIONS constant')
})

test('SteamDirectDepotView renders realtime speed waveform graph and hides raw logs by default', () => {
  const tsxPath = path.resolve(__dirname, 'SteamDirectDepotView.tsx')
  const content = fs.readFileSync(tsxPath, 'utf8')

  // Waveform graph elements
  assert.ok(content.includes('<DownloadWaveCard'), 'Must delegate rendering to the shared waveform')
  assert.ok(content.includes('bytesPerSecond: currentSpeedBps'), 'Must pass measured speed to shared telemetry')
  assert.ok(!content.includes('speedAreaGrad'), 'Must not retain a duplicate waveform implementation')

  // showLogs must be false by default
  assert.ok(content.includes('const [showLogs, setShowLogs] = useState(false)'), 'showLogs must be defaulted to false')
})

test('SteamDirectDepotView.css synchronizes all elements with color wheel theme variables', () => {
  const cssPath = path.resolve(__dirname, 'SteamDirectDepotView.css')
  const css = fs.readFileSync(cssPath, 'utf8')

  // Waveform styling
  assert.ok(css.includes('.steam-direct-wave-card'), 'Must style wave card')
  assert.ok(css.includes('.steam-direct-wave-svg-wrap'), 'Must style wave SVG wrap')
  assert.ok(css.includes('.steam-direct-wave-speed-val'), 'Must style speed value readout')

  // Custom select styling
  assert.ok(css.includes('.steam-direct-custom-select-wrap'), 'Must style custom select wrapper')
  assert.ok(css.includes('.steam-direct-select-menu'), 'Must style custom select menu')
  assert.ok(css.includes('.steam-direct-select-option'), 'Must style select options')

  // Color wheel variables synchronization
  assert.ok(css.includes('var(--theme-accent'), 'Must use theme accent color')
  assert.ok(css.includes('var(--theme-control-bg'), 'Must use theme control background')
  assert.ok(css.includes('var(--theme-card-bg'), 'Must use theme card background')
})
