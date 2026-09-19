import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { globSync } from 'tinyglobby';

// Extensions treated as binary by git (matches .gitattributes binary overrides).
// All other files are treated as text and normalized CRLF→LF before hashing,
// so the sha256 always matches what git stores with eol=lf regardless of the
// local core.autocrlf setting.
const BINARY_EXTS = new Set([
  '.dll', '.exe', '.pyd', '.zip', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.db', '.dat', '.ndb', '.ldb', '.wav', '.mp3', '.mp4',
  '.a3x', '.a3xenc', // AutoIt compiled binary
]);

function hashBytes(filePath, rawBytes) {
  let bytes = rawBytes;
  if (!BINARY_EXTS.has(path.extname(filePath).toLowerCase()) && rawBytes.indexOf(13) !== -1) {
    const str = rawBytes.toString('binary').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    bytes = Buffer.from(str, 'binary');
  }
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(repo, 'src-tauri');
const root = path.join(tauri, 'resources/gse-uc');
const config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(root, 'launcher-asset-overrides.json'), 'utf8')).files;
const bundled = new Set(globSync(config.bundle.resources, { cwd: tauri, dot: true, onlyFiles: true }));
const selected = manifest.files.filter(file => /^(7zip\/|embedded\/(gse|gse_tools)\/)/.test(file.relativePath)
  && !file.relativePath.includes('/_OUTPUT/') && !file.relativePath.endsWith('.log'));
const errors = [];
for (const file of selected) {
  const relative = `resources/gse-uc/${file.relativePath}`;
  const absolute = path.join(tauri, relative);
  if (!bundled.has(relative)) { errors.push(`Not bundled: ${relative}`); continue; }
  const rawBytes = fs.readFileSync(absolute);
  const override = overrides.find(item => item.path === file.relativePath && item.baselineSha256 === file.sha256);
  const expected = override || file;
  const { sha256, sizeBytes } = hashBytes(absolute, rawBytes);
  if (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256) {
    errors.push(`Manifest mismatch: ${relative}`);
  }
}
const required = [
  'bin/gse-core.exe', 'bin/gse-core.build.json',
  'embedded/gse_tools/generate_emu_config/_internal/Cryptodome/Hash/_MD5.pyd',
  'embedded/gse_tools/generate_emu_config/_internal/base_library.zip'
];
for (const file of required) {
  if (!bundled.has(`resources/gse-uc/${file}`)) errors.push(`Required runtime missing: ${file}`);
}
// A local file can exist yet disappear in a clean checkout due to .gitignore.
try {
  const ignored = execFileSync('git', ['check-ignore', '--stdin'], {
    cwd: repo, encoding: 'utf8', input: [...selected.map(f => f.relativePath), ...required]
      .map(p => `src-tauri/resources/gse-uc/${p}`).join('\n') + '\n'
  }).trim();
  if (ignored) errors.push(`Release inputs still ignored:\n${ignored}`);
} catch (error) { if (error.status !== 1) throw error; }
if ([...bundled].some(p => /gse-uc\/google\/|gse-uc\/updates\/|\/_OUTPUT\/|\/downloading\//.test(p))) {
  errors.push('Bundle contains credentials, local updates or generated output.');
}
if ([...bundled].some(p => /gse-uc\//.test(p) && /(?:^|\/)(?:my_login\.txt|refresh_tokens\.json|credentials\.json|client_secret[^/]*\.json)$/i.test(p))) {
  errors.push('Bundle contains generator login credentials.');
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`GSE packaging: ${selected.length} manifest files verified; native modules/archives included; credentials excluded.`);
console.log('Integrity evidence only; imported component provenance/license release gates remain separate.');
