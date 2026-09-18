const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const PACK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.bin$/;
const SAFE_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified'
];

class BackupContentError extends Error {
  constructor(code, status, retryAfterSeconds = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function intEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isSafeGameId(value) {
  return typeof value === 'string' && GAME_ID_PATTERN.test(value);
}

function isSafePathSegment(value) {
  return typeof value === 'string' && PATH_SEGMENT_PATTERN.test(value);
}

function validateRepository(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} must be an object`);
  }
  const repoId = String(value.repoId || '').trim();
  const repoType = String(value.repoType || 'dataset').trim().toLowerCase();
  const revision = String(value.revision || 'main').trim();
  const token = String(value.token || '').trim();
  const enabled = value.enabled !== false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(repoId)) {
    throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} has an invalid repoId`);
  }
  if (!['dataset', 'model', 'space'].includes(repoType)) {
    throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} has an invalid repoType`);
  }
  if (!isSafePathSegment(revision)) {
    throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} has an invalid revision`);
  }
  if (enabled && token.length < 8) {
    throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} is enabled but has no credential`);
  }

  const gamePathPrefixes = {};
  if (value.gamePathPrefixes != null) {
    if (!value.gamePathPrefixes || typeof value.gamePathPrefixes !== 'object' || Array.isArray(value.gamePathPrefixes)) {
      throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} has invalid gamePathPrefixes`);
    }
    for (const [gameId, prefix] of Object.entries(value.gamePathPrefixes)) {
      const normalizedGameId = String(gameId || '').trim();
      const normalizedPrefix = String(prefix || '').trim();
      if (!isSafeGameId(normalizedGameId) || !isSafePathSegment(normalizedPrefix)) {
        throw new Error(`BACKUP_HF_REPOSITORIES_JSON repository ${index} has an unsafe game path prefix`);
      }
      gamePathPrefixes[normalizedGameId] = normalizedPrefix;
    }
  }

  return { repoId, repoType, revision, token, enabled, gamePathPrefixes };
}

function loadBackupContentConfig() {
  const enabled = boolEnv('BACKUP_CONTENT_ENABLED', false);
  const timeoutMs = intEnv('BACKUP_CONTENT_TIMEOUT_MS', 30_000, 1_000, 180_000);
  const maxRedirects = intEnv('BACKUP_CONTENT_MAX_REDIRECTS', 3, 0, 5);
  const raw = String(process.env.BACKUP_HF_REPOSITORIES_JSON || '').trim();
  let repositories = [];

  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (enabled) throw new Error('BACKUP_HF_REPOSITORIES_JSON must be valid JSON');
      return { enabled, timeoutMs, maxRedirects, repositories };
    }
    const entries = Array.isArray(parsed) ? parsed : parsed?.repositories;
    if (!Array.isArray(entries)) {
      if (enabled) throw new Error('BACKUP_HF_REPOSITORIES_JSON must be an array or an object with repositories');
      return { enabled, timeoutMs, maxRedirects, repositories };
    }
    try {
      repositories = entries.map(validateRepository).filter((repository) => repository.enabled);
    } catch (error) {
      if (enabled) throw error;
      return { enabled, timeoutMs, maxRedirects, repositories: [] };
    }
  }

  if (enabled && repositories.length === 0) {
    throw new Error('BACKUP_CONTENT_ENABLED requires at least one enabled repository');
  }

  return { enabled, timeoutMs, maxRedirects, repositories };
}

function allowedContentPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 512) return false;
  if (relativePath.includes('%') || relativePath.includes('\\') || /[\x00-\x1f\x7f]/.test(relativePath)) return false;
  if (relativePath.startsWith('/') || relativePath.endsWith('/') || relativePath.includes('//')) return false;
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (relativePath === 'catalog.json') return true;
  if (parts.length === 3 && parts[0] === 'versions' && isSafePathSegment(parts[1])) {
    return parts[2] === 'manifest.json' || parts[2] === 'build-info.json';
  }
  if (parts.length === 2 && parts[0] === 'packs') return PACK_NAME_PATTERN.test(parts[1]);
  if (parts.length === 3 && parts[0] === 'patches' && isSafePathSegment(parts[1])) {
    return parts[2] === 'manifest.json';
  }
  return parts.length === 4
    && parts[0] === 'patches'
    && isSafePathSegment(parts[1])
    && parts[2] === 'packs'
    && PACK_NAME_PATTERN.test(parts[3]);
}

function validateRangeHeader(value) {
  if (value == null || value === '') return null;
  const range = String(value).trim();
  return /^bytes=\d*-\d*$/.test(range) ? range : null;
}

function repositoryUrl(repository, gameId, relativePath) {
  const prefix = repository.repoType === 'dataset'
    ? 'datasets/'
    : repository.repoType === 'space'
      ? 'spaces/'
      : '';
  const gamePath = repository.gamePathPrefixes[gameId] || gameId;
  const encoded = [gamePath, ...relativePath.split('/')].map(encodeURIComponent).join('/');
  return `https://huggingface.co/${prefix}${repository.repoId}/resolve/${encodeURIComponent(repository.revision)}/${encoded}`;
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function isSuccessfulContent(status) {
  return status === 200 || status === 206;
}

class BackupContentBroker {
  constructor({ config, fetchImpl = fetch }) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async fetchContent({ gameId, relativePath, range }) {
    if (!this.config.enabled) {
      throw new BackupContentError('BACKUP_CONTENT_UNAVAILABLE', 503, 30);
    }
    if (!isSafeGameId(gameId) || !allowedContentPath(relativePath)) {
      throw new BackupContentError('BACKUP_CONTENT_MISSING', 404);
    }
    const safeRange = validateRangeHeader(range);
    if (range && !safeRange) {
      throw new BackupContentError('BACKUP_CONTENT_MISSING', 404);
    }

    let sawUnavailable = false;
    let sawUpstreamFailure = false;
    for (const repository of this.config.repositories) {
      let response;
      try {
        response = await this.fetchRepository(repository, gameId, relativePath, safeRange);
      } catch {
        sawUnavailable = true;
        continue;
      }
      if (isSuccessfulContent(response.status)) return response;
      if (response.status === 404) continue;
      if (response.status === 401 || response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500) {
        sawUnavailable = true;
      } else {
        sawUpstreamFailure = true;
      }
      response.body?.cancel?.().catch(() => {});
    }

    if (sawUnavailable) throw new BackupContentError('BACKUP_CONTENT_UNAVAILABLE', 503, 30);
    if (sawUpstreamFailure) throw new BackupContentError('BACKUP_UPSTREAM_FAILED', 502);
    throw new BackupContentError('BACKUP_CONTENT_MISSING', 404);
  }

  async fetchRepository(repository, gameId, relativePath, range) {
    let url = repositoryUrl(repository, gameId, relativePath);
    let includeAuthorization = true;
    for (let redirects = 0; redirects <= this.config.maxRedirects; redirects += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const headers = {
          Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.1',
          'User-Agent': '0xoLemon-backup-content-broker/1'
        };
        if (range) headers.Range = range;
        if (includeAuthorization) headers.Authorization = `Bearer ${repository.token}`;
        const response = await this.fetch(url, { headers, redirect: 'manual', signal: controller.signal });
        if (!isRedirect(response.status)) return response;
        if (redirects === this.config.maxRedirects) {
          response.body?.cancel?.().catch(() => {});
          throw new Error('redirect limit');
        }
        const location = response.headers.get('location');
        response.body?.cancel?.().catch(() => {});
        if (!location) throw new Error('redirect without location');
        const next = new URL(location, url);
        if (next.protocol !== 'https:') throw new Error('non-https redirect');
        url = next.toString();
        // Hugging Face credentials are only valid for the initial provider request.
        includeAuthorization = false;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('redirect limit');
  }
}

function writeBackupError(res, error) {
  const safe = error instanceof BackupContentError
    ? error
    : new BackupContentError('BACKUP_UPSTREAM_FAILED', 502);
  if (safe.retryAfterSeconds != null) res.set('Retry-After', String(safe.retryAfterSeconds));
  res.status(safe.status).json({ error: safe.code });
}

async function streamBackupResponse(response, res) {
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) res.set(name, value);
  }
  // Authenticated game content must not be shared through public browser caches.
  res.set('Cache-Control', 'private, no-store, no-transform');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(response.status);
  if (!response.body) return res.end();
  await pipeline(Readable.fromWeb(response.body), res);
}

module.exports = {
  BackupContentBroker,
  BackupContentError,
  allowedContentPath,
  isSafeGameId,
  loadBackupContentConfig,
  streamBackupResponse,
  validateRangeHeader,
  writeBackupError
};
