// Read-only production check: never print catalog payloads, tokens or cookies.
const assert = require('node:assert/strict');
const base = process.env.OXO_SMOKE_BASE || 'https://zeroxolemon-launcher.onrender.com';
const paths = ['/health', '/api/0xolemon1/catalog', '/api/0xolemon/catalog', '/api/0xolemon/lua-shop/catalog/search?limit=1'];
async function main() {
  for (const path of paths) for (const origin of [null, 'http://tauri.localhost', 'http://localhost:14201', 'http://localhost:1420']) {
    const started = Date.now();
    const response = await fetch(base + path, { headers: origin ? { Origin: origin } : {}, signal: AbortSignal.timeout(65000) });
    const body = await response.json();
    const allow = response.headers.get('access-control-allow-origin');
    console.log(JSON.stringify({ path, origin, status: response.status, allow, elapsedMs: Date.now() - started, count: body.games?.length ?? body.items?.length, requestId: response.headers.get('x-request-id') }));
    assert.equal(response.status, 200);
    if (origin) assert.equal(allow, origin);
  }
  for (const origin of ['null', 'http://tauri.localhost.evil.example']) {
    const response = await fetch(base + '/health', { headers: { Origin: origin }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'CORS_ORIGIN_DENIED');
    console.log(JSON.stringify({ origin, status: response.status }));
  }
  const response = await fetch(base + '/api/0xolemon/catalog', { method: 'OPTIONS', headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
  console.log(JSON.stringify({ method: 'OPTIONS', status: response.status, allow: response.headers.get('access-control-allow-origin') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
