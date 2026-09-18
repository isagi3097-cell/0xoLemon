const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { once } = require('node:events');
const {
  BackupContentBroker,
  BackupContentError,
  allowedContentPath,
  loadBackupContentConfig
} = require('../remote/backup-content');
const { createRemoteRouter } = require('../remote/routes');

function repository(repoId, token, overrides = {}) {
  return {
    repoId,
    repoType: 'dataset',
    revision: 'main',
    token,
    enabled: true,
    gamePathPrefixes: {},
    ...overrides
  };
}

function brokerFixture(repositories, fetchImpl) {
  return new BackupContentBroker({
    config: { enabled: true, timeoutMs: 1_000, maxRedirects: 3, repositories },
    fetchImpl
  });
}

async function expectBackupError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof BackupContentError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('Backup Game broker rejects traversal, encoded paths and unexpected extensions before network access', async () => {
  const invalid = [
    '../catalog.json',
    'versions/../manifest.json',
    'catalog.json%2fsecret',
    'packs/pack.zip',
    'https://example.invalid/catalog.json',
    'versions/v1/other.json',
    'packs/a\\b.bin'
  ];
  for (const path of invalid) assert.equal(allowedContentPath(path), false, path);

  let calls = 0;
  const broker = brokerFixture([repository('owner/one', 'server-secret-token')], async () => {
    calls += 1;
    return new Response('unexpected');
  });
  await expectBackupError(broker.fetchContent({ gameId: 'game-a', relativePath: '../catalog.json' }), 'BACKUP_CONTENT_MISSING', 404);
  assert.equal(calls, 0);
});

test('Backup Game broker falls back after an upstream 404 and forwards a single Range request', async () => {
  const calls = [];
  const broker = brokerFixture([
    repository('owner/first', 'first-server-token'),
    repository('owner/second', 'second-server-token')
  ], async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    if (calls.length === 1) return new Response('', { status: 404 });
    return new Response('catalog', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-6/7', 'Accept-Ranges': 'bytes', 'Content-Length': '7' }
    });
  });

  const response = await broker.fetchContent({ gameId: 'game-a', relativePath: 'catalog.json', range: 'bytes=0-6' });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'catalog');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('range'), 'bytes=0-6');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer second-server-token');
  assert.match(calls[1].url, /owner\/second\/resolve\/main\/game-a\/catalog\.json$/);
});

test('Backup Game broker does not forward a provider credential after redirecting to a CDN', async () => {
  const calls = [];
  const broker = brokerFixture([repository('owner/private', 'provider-only-token')], async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    if (calls.length === 1) {
      return new Response('', { status: 302, headers: { Location: 'https://cdn.example.test/signed-pack' } });
    }
    return new Response('pack', { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } });
  });

  const response = await broker.fetchContent({ gameId: 'game-a', relativePath: 'packs/pack-001.bin', range: 'bytes=0-3' });
  assert.equal(response.status, 206);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer provider-only-token');
  assert.equal(calls[1].headers.get('authorization'), null);
  assert.equal(calls[1].headers.get('range'), 'bytes=0-3');
});

test('Backup Game broker maps missing, timeout and upstream failures without exposing credentials', async () => {
  const secret = 'do-not-expose-this-server-token';
  const missing = brokerFixture([repository('owner/one', secret)], async () => new Response('', { status: 404 }));
  await expectBackupError(missing.fetchContent({ gameId: 'game-a', relativePath: 'catalog.json' }), 'BACKUP_CONTENT_MISSING', 404);

  const timeout = brokerFixture([repository('owner/one', secret)], async () => { throw new Error('provider timeout with ' + secret); });
  await expectBackupError(timeout.fetchContent({ gameId: 'game-a', relativePath: 'catalog.json' }), 'BACKUP_CONTENT_UNAVAILABLE', 503);

  const broken = brokerFixture([repository('owner/one', secret)], async () => new Response('', { status: 418 }));
  try {
    await broken.fetchContent({ gameId: 'game-a', relativePath: 'catalog.json' });
    assert.fail('expected a broker error');
  } catch (error) {
    assert.equal(error.code, 'BACKUP_UPSTREAM_FAILED');
    assert.equal(error.status, 502);
    assert.equal(String(error).includes(secret), false);
  }
});

test('disabled broker ignores malformed optional configuration, but enabled broker fails startup validation', () => {
  const previousEnabled = process.env.BACKUP_CONTENT_ENABLED;
  const previousRepositories = process.env.BACKUP_HF_REPOSITORIES_JSON;
  try {
    process.env.BACKUP_CONTENT_ENABLED = 'false';
    process.env.BACKUP_HF_REPOSITORIES_JSON = '{not-json';
    assert.deepEqual(loadBackupContentConfig().repositories, []);
    process.env.BACKUP_CONTENT_ENABLED = 'true';
    assert.throws(loadBackupContentConfig, /BACKUP_HF_REPOSITORIES_JSON must be valid JSON/);
  } finally {
    if (previousEnabled == null) delete process.env.BACKUP_CONTENT_ENABLED;
    else process.env.BACKUP_CONTENT_ENABLED = previousEnabled;
    if (previousRepositories == null) delete process.env.BACKUP_HF_REPOSITORIES_JSON;
    else process.env.BACKUP_HF_REPOSITORIES_JSON = previousRepositories;
  }
});

async function routeFixture(t, { service, broker }) {
  const app = express();
  app.use('/api/:tenant', createRemoteRouter({
    service,
    config: {
      backupContent: { enabled: true, timeoutMs: 1_000, maxRedirects: 3, repositories: [] },
      secureCookies: false,
      sessionCookieName: 'session',
      csrfCookieName: 'csrf',
      oauthCookieName: 'oauth',
      oauthTtlMs: 1000,
      sessionTtlMs: 1000,
      publicWebUrl: 'https://launcher.example',
      discord: { authorizeUrl: 'https://discord.example' }
    },
    eventHub: { subscribe: () => () => {} },
    backupContentBroker: broker
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('Backup Game route is independent from Discord authorization', async t => {
  const broker = { fetchContent: async () => new Response('data', { status: 200 }) };
  const denied = await routeFixture(t, {
    service: {
      assertEnabled: () => {},
      authorizeDesktopBearer: async () => { throw new Error('Discord must not be called'); },
      getLegalAcceptance: async () => ({ accepted: false })
    },
    broker
  });
  const responseWithoutDiscord = await denied('/api/0xolemon/backup-content/game-a/catalog.json');
  assert.equal(responseWithoutDiscord.status, 200);
  assert.equal(await responseWithoutDiscord.text(), 'data');

  // Legal acceptance belongs to the cookie-based web dashboard. It must not
  // gate this desktop content broker.
  const route = await routeFixture(t, {
    service: {
      assertEnabled: () => {},
      authorizeDesktopBearer: async () => ({ accountKey: 'account' }),
      getLegalAcceptance: async () => ({ accepted: false })
    },
    broker
  });
  const response = await route('/api/0xolemon/backup-content/game-a/catalog.json', { headers: { Authorization: 'Bearer desktop-token' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data');
});

test('Backup Game route preserves resumable response headers after authenticated access', async t => {
  let request;
  const route = await routeFixture(t, {
    service: {
      assertEnabled: () => {},
      authorizeDesktopBearer: async () => ({ accountKey: 'account' }),
      getLegalAcceptance: async () => ({ accepted: true })
    },
    broker: {
      fetchContent: async (input) => {
        request = input;
        return new Response('range', {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': '5',
            'Content-Range': 'bytes 0-4/5',
            ETag: 'manifest-tag'
          }
        });
      }
    }
  });
  const response = await route('/api/0xolemon/backup-content/game-a/catalog.json', {
    headers: { Authorization: 'Bearer desktop-token', Range: 'bytes=0-4' }
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'range');
  assert.equal(request.range, 'bytes=0-4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), 'bytes 0-4/5');
  assert.equal(response.headers.get('etag'), 'manifest-tag');
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
});
