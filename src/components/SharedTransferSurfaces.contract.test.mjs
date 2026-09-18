import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('all progress-producing resource surfaces use the shared transfer waveform', () => {
  const gse = read('./GseUcStandaloneView.tsx')
  const tools = read('./GameToolsHub.tsx')
  for (const [name, source] of [['GSE', gse], ['Game Tools', tools]]) {
    assert.match(source, /import \{ DownloadWaveCard \} from '\.\/DownloadWaveCard'/, `${name} must import DownloadWaveCard`)
    assert.match(source, /<DownloadWaveCard\b/, `${name} must render DownloadWaveCard`)
    assert.match(source, /owner: 'resource'/, `${name} resource transfers must use the resource owner`)
  }
})
