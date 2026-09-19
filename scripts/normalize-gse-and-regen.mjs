#!/usr/bin/env node
// normalize-gse-and-regen.mjs
// Normalizes CRLF→LF in all gse-uc text files, then regenerates manifest.json sha256.
// Run once after adding .gitattributes to fix stale CRLF content.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BINARY_EXTS = new Set([
  '.dll', '.exe', '.pyd', '.zip', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.db', '.dat', '.ndb', '.ldb', '.wav', '.mp3', '.mp4',
  '.a3x', '.a3xenc',
]);

function isBinary(filePath) {
  return BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(repo, 'src-tauri');
const root = path.join(tauri, 'resources', 'gse-uc');
const manifestPath = path.join(root, 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let filesNormalized = 0;
let entriesUpdated = 0;

for (const file of manifest.files) {
  // Only check entries covered by check-gse-package.mjs
  if (!/^(7zip\/|embedded\/(gse|gse_tools)\/)/.test(file.relativePath)) continue;
  if (file.relativePath.includes('/_OUTPUT/') || file.relativePath.endsWith('.log')) continue;

  const absolute = path.join(tauri, 'resources', 'gse-uc', file.relativePath.replace(/\//g, path.sep));
  if (!fs.existsSync(absolute)) continue;

  let bytes = fs.readFileSync(absolute);

  // Normalize CRLF→LF for text files (same rule git applies with eol=lf)
  if (!isBinary(absolute)) {
    let normalized = bytes;
    // Only normalize if CRLF is present to avoid unnecessary writes
    if (bytes.indexOf(13) !== -1) {
      // Replace \r\n → \n (and stray \r → \n as safety)
      const str = bytes.toString('binary').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      normalized = Buffer.from(str, 'binary');
      fs.writeFileSync(absolute, normalized);
      filesNormalized++;
    }
    bytes = normalized;
  }

  const newSha256 = sha256hex(bytes);
  const newSize = bytes.length;

  if (file.sha256 !== newSha256 || file.sizeBytes !== newSize) {
    file.sha256 = newSha256;
    file.sizeBytes = newSize;
    entriesUpdated++;
  }
}

// Write manifest as LF, no BOM
const json = JSON.stringify(manifest, null, 2).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
fs.writeFileSync(manifestPath, json + '\n', { encoding: 'utf8' });

console.log(`Done: ${filesNormalized} files normalized to LF, ${entriesUpdated} manifest entries updated.`);
