import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Verify the release input set without executing binaries or reading credentials.
// An explicit extracted package directory can be checked after installer build.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonical = path.join(repository, 'src-tauri/resources/lua-steamkit')
const root = path.resolve(process.argv[2] ?? canonical)
const manifestBytes = await readFile(path.join(canonical, 'artifact-manifest.json'))
assert.deepEqual(await readFile(path.join(root, 'artifact-manifest.json')), manifestBytes, 'package trust manifest differs from build input')
const manifest = JSON.parse(manifestBytes)
assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.entryPoint, '0xoLemon.LuaSteamKit.exe')
assert.equal(manifest.source.commit, '1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7')
assert.equal(manifest.build.sdk, '8.0.420')
assert.equal(manifest.build.rid, 'win-x64')
assert.equal(manifest.build.selfContained, true)
assert.equal(manifest.build.singleFile, false)
assert.ok(manifest.files.length > 0 && manifest.files.length <= 512)
const expected = new Set(['artifact-manifest.json'])
let bytes = 0
for (const file of manifest.files) {
  assert.match(file.path, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'resource must be a plain file name')
  assert.ok(!expected.has(file.path.toLowerCase()), 'duplicate resource')
  expected.add(file.path.toLowerCase())
  const filename = path.join(root, file.path)
  const stat = await lstat(filename)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `unsafe resource: ${file.path}`)
  assert.equal(stat.size, file.size, `size: ${file.path}`)
  assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), file.sha256, `hash: ${file.path}`)
  bytes += stat.size
}
for (const name of await readdir(root)) assert.ok(expected.has(name.toLowerCase()), `unlisted resource: ${name}`)
for (const required of [manifest.entryPoint, 'SteamKit2.dll', 'LuaSteamKit-adapter-source.zip', manifest.source.upstreamArchive, ...manifest.licenseEvidence]) {
  assert.ok(expected.has(required.toLowerCase()), `missing release input: ${required}`)
}
if (root === canonical) {
  const config = JSON.parse(await readFile(path.join(repository, 'src-tauri/tauri.conf.json'), 'utf8'))
  assert.ok(config.bundle.resources.includes('resources/lua-steamkit/**/*'), 'SteamKit resource glob is absent')
  for (const source of manifest.bridgeSources) {
    const contents = await readFile(path.join(repository, 'src-tauri/lua-steamkit', source.path))
    assert.equal(createHash('sha256').update(contents).digest('hex'), source.sha256, `rebuild required after source change: ${source.path}`)
  }
  // Catch the original class of clean-checkout regression: locally present
  // native modules/manifests that broad .gitignore rules would omit from Git.
  const inputs = ['artifact-manifest.json', ...manifest.files.map(file => file.path)].map(name => `src-tauri/resources/lua-steamkit/${name}`)
  inputs.push('src-tauri/lua-steamkit/global.json', 'src-tauri/lua-steamkit/packages.lock.json', 'src-tauri/lua-steamkit/tests/packages.lock.json')
  const ignored = spawnSync('git', ['-C', repository, 'check-ignore', '--no-index', '--stdin'], {
    input: inputs.join('\n') + '\n', encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.equal(ignored.error, undefined, 'Git input verification could not run')
  assert.equal(ignored.status, 1, `release inputs are ignored or Git check failed: ${ignored.stdout}${ignored.stderr}`)
}
console.log(JSON.stringify({ verified: true, files: manifest.files.length, bytes, root, sourceCommit: manifest.source.commit }))
