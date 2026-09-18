import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tsx = fs.readFileSync(path.join(here, 'DepotDownloaderView.tsx'), 'utf8')
const steamDirectTsx = fs.readFileSync(path.join(here, 'SteamDirectDepotView.tsx'), 'utf8')
const css = fs.readFileSync(path.join(here, 'DepotDownloaderView.css'), 'utf8')

test('live depot logs scroll only inside the terminal, never the whole detail pane', () => {
  assert.doesNotMatch(tsx, /scrollIntoView\s*\(/)
  assert.match(tsx, /terminalBodyRef/)
  assert.match(tsx, /terminalBodyRef\.current\.scrollTop\s*=\s*terminalBodyRef\.current\.scrollHeight/)
  assert.match(tsx, /className="store-terminal-body"\s+ref=\{terminalBodyRef\}/)
})

test('download CTA avoids the old hard-coded orange slab', () => {
  const start = css.indexOf('.depot-btn-primary-start {')
  const end = css.indexOf('}', start)
  const block = css.slice(start, end + 1)
  assert.doesNotMatch(block, /#ff9f43|#f59e0b/)
  assert.match(block, /border:/)
})


test('game selection races cannot mix one game with another build or folder', () => {
  assert.match(tsx, /detailRequestSeqRef/)
  assert.match(tsx, /const requestId = \+\+detailRequestSeqRef\.current/)
  assert.match(tsx, /setSelectedBuildId\(''\)/)
  assert.match(tsx, /detailRequestSeqRef\.current !== requestId/)
  assert.match(tsx, /appid: gameDetail\.appid/)
  assert.match(tsx, /folderName: gameDetail\.folderName/)
})

test('catalog and inspector own their scroll instead of chaining to the whole page', () => {
  assert.match(css, /\.depot-main-layout\s*\{[\s\S]*?min-height:\s*0/)
  assert.match(css, /\.depot-cards-grid\s*\{[\s\S]*?overflow-y:\s*auto[\s\S]*?overscroll-behavior-y:\s*contain/)
  assert.match(css, /\.depot-detail-scroll\s*\{[\s\S]*?overflow-y:\s*auto[\s\S]*?overscroll-behavior-y:\s*contain/)
})

test('download button matches Lua Shop Add to Steam neutral action styling', () => {
  const start = css.indexOf('.depot-btn-primary-start {')
  const end = css.indexOf('}', start)
  const block = css.slice(start, end + 1)
  assert.match(block, /background:\s*rgba\(255, 255, 255, 0\.1\)/)
  assert.match(block, /border[^;]*rgba\(255, 255, 255, 0\.2\)/)
  assert.match(block, /color:\s*#fff/)
})

test('Depot Downloader renders as its own Store tab branch and never leaks into Backup Game', () => {
  const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8')
  const appCss = fs.readFileSync(path.join(here, '..', 'App.css'), 'utf8')
  const activeView = fs.readFileSync(path.join(here, '..', 'components', 'ActiveView.tsx'), 'utf8')
  const library = fs.readFileSync(path.join(here, '..', 'components', 'library.tsx'), 'utf8')
  // Store alone owns the depot surface; the Backup Game detail stays launcher-owned.
  assert.match(app, /activeTab === 'Store' \? \([\s\S]*?<DepotDownloaderView/)
  assert.match(app, /<DepotDownloaderView[\s\S]*?selectedAppId=\{selectedDepotAppId\}/)
  assert.doesNotMatch(app, /depot-persistent-layer/)
  assert.doesNotMatch(activeView, /DepotDownloaderView|SteamDirectDepotView/)
  assert.doesNotMatch(library, /SteamDirectDepotView/)
  // Tab content is hidden only for GSE / UC Setup, which still owns a persistent layer.
  assert.match(app, /activeTab === 'GSE \/ UC Setup' \? \{ display: 'none' \} : undefined/)
  assert.match(app, /className="gse-persistent-layer"/)
  assert.match(appCss, /\.gse-persistent-layer[\s\S]*?\{/)
})

test('Backup Game detail keeps install controls but drops the depot store layout', () => {
  const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8')
  const library = fs.readFileSync(path.join(here, '..', 'components', 'library.tsx'), 'utf8')
  const appCss = fs.readFileSync(path.join(here, '..', 'App.css'), 'utf8')
  assert.match(library, /if \(desktopDetail && !showLibraryRail\)/)
  assert.match(library, /desktop-action-dock/)
  assert.match(library, /desktop-screens-rail/)
  assert.match(app, /desktopDetail=\{activeTab === 'Backup Game'/)
  assert.match(appCss, /\.game-detail-view\.desktop-detail-view\s*\{/)
})

test('Depot Downloader exposes Steam-like pause/resume and explicit version switching', () => {
  assert.match(tsx, /depot_downloader_pause_download/)
  assert.match(tsx, /depot_downloader_resume_download/)
  assert.match(tsx, /depot_downloader_get_install_state/)
  assert.match(tsx, /isPaused/)
  assert.match(tsx, /installedBuildId/)
  assert.match(tsx, /Switch to BuildID|Chuyển sang BuildID/)
  assert.match(tsx, /Pause|Tạm dừng/)
  assert.match(tsx, /Resume|Tiếp tục/)
})
