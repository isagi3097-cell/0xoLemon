import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'

const browser = [process.env.EDGE_BIN, process.env.CHROME_BIN,
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean).find(existsSync)
const entry = resolve('src/hooks/__catalog_test__.tsx').replaceAll('\\', '/')
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {useCatalogResource} from ${JSON.stringify(resolve('src/hooks/useCatalogResource.ts').replaceAll('\\', '/'))};
const checks = [], requests = [];
const check = (value, name) => { if (!value) throw Error(name); checks.push(name); };
const originalTimeout = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 8000 ? 40 : ms === 65000 ? 2500 : ms, ...args);
const wait = () => new Promise(resolve => originalTimeout(resolve, 10));
async function until(fn) { for(let i=0;i<100;i++) { if(fn()) return; await wait(); } throw Error('Timeout: '+JSON.stringify(current)); }
window.fetch = (url, options) => new Promise((resolve, reject) => requests.push({url,signal:options.signal,resolve,reject}));
let current, generation=0;
const normalize = raw => typeof raw.id === 'string' ? raw : null;
function Probe({generation}) { current = useCatalogResource('https://catalog.invalid/api','primaryBackend',generation,normalize); return React.createElement('p',null,current.state); }
const root = createRoot(document.getElementById('root'));
const render = () => flushSync(()=>root.render(React.createElement(Probe,{generation})));
const reply = (i, games, status=200) => requests[i].resolve(new Response(JSON.stringify({games}),{status,headers:{'Content-Type':'application/json'}}));
async function run() {
 localStorage.clear(); render(); await until(()=>requests.length===1);
 await until(()=>current.errorCode==='CATALOG_WARMING');
 check(current.state==='error' && !requests[0].signal.aborted,'8s warming panel leaves network request alive');
 reply(0,[{id:'good'}]); await until(()=>current.state==='ready');
 check(current.data.games[0].id==='good','cold start response appears without reload');
 await until(()=>localStorage.getItem('0xolemon.catalog.v1:https://catalog.invalid/api'));
 generation++; render(); await until(()=>requests.length===2);
 check(current.state==='stale' && current.data.games[0].id==='good','refresh renders last known good cache');
 generation++; render(); await until(()=>requests.length===3);
 check(requests[1].signal.aborted,'retry aborts the old generation');
 reply(2,[{id:'new'}]); await until(()=>current.state==='ready' && current.data.games[0].id==='new');
 reply(1,[{id:'obsolete'}]); await wait();
 check(current.data.games[0].id==='new','late response cannot overwrite new generation');
 await until(()=>JSON.parse(localStorage.getItem('0xolemon.catalog.v1:https://catalog.invalid/api')).data.games[0].id==='new');
 generation++; render(); await until(()=>requests.length===4); reply(3,[],403);
 await until(()=>current.httpStatus===403);
 check(current.state==='stale' && current.data.games[0].id==='new','outage retains last known good');
 generation++; render(); await until(()=>requests.length===5); reply(4,[]);
 await until(()=>current.state==='ready');
 check(current.data.games.length===0,'valid empty payload becomes ready rather than infinite loading');
 check(JSON.parse(localStorage.getItem('0xolemon.catalog.v1:https://catalog.invalid/api')).data.games[0].id==='new','empty payload never erases disk good cache');
 localStorage.clear(); generation++; render(); await until(()=>requests.length===6); reply(5,[],403);
 await until(()=>current.httpStatus===403);
 check(current.state==='error' && !current.data,'outage with no cache becomes explicit error');
 root.unmount(); check(requests[5].signal.aborted,'unmount releases request lifecycle');
 document.body.setAttribute('data-results',btoa(JSON.stringify({checks})));
}
run().catch(error=>document.body.setAttribute('data-results',btoa(JSON.stringify({checks,error:String(error.stack||error)}))));
`

test('production catalog hook handles cold start, retry races, stale cache, empty and outage in React DOM', { skip: !browser }, async () => {
  const result = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'catalog-test', enforce: 'pre', resolveId: id => id.replaceAll('\\', '/') === entry ? '\0catalog-test' : undefined, load: id => id === '\0catalog-test' ? fixture : undefined }],
    build: { write: false, emptyOutDir: false, minify: false, target: 'es2022', lib: { entry, formats: ['iife'], name: 'CatalogTest' } } })
  const script = (Array.isArray(result) ? result : [result]).flatMap(r=>r.output).filter(r=>r.type==='chunk').map(r=>r.code).join('\n')
  const directory = await mkdtemp(join(tmpdir(), 'oxo-catalog-test-')), profile = await mkdtemp(join(tmpdir(), 'oxo-catalog-browser-'))
  const file = join(directory, 'index.html')
  await writeFile(file, `<meta charset="utf-8"><div id="root"></div><script>${script.replaceAll('</script','<\\/script')}</script>`)
  try {
    const result = spawnSync(browser, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-default-apps', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-component-update', '--virtual-time-budget=6000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', maxBuffer: 16*1024*1024, timeout: 25000, windowsHide: true })
    assert.equal(result.error, undefined); assert.equal(result.status, 0)
    const encoded = result.stdout.match(/data-results="([A-Za-z0-9+/=]+)"/)?.[1]
    assert.ok(encoded, result.stdout.slice(-2000) + result.stderr.slice(-2000))
    const payload = JSON.parse(Buffer.from(encoded,'base64').toString('utf8'))
    assert.equal(payload.error, undefined, JSON.stringify(payload)); assert.equal(payload.checks.length, 10)
  } finally { await unlink(file); await rmdir(directory) }
  // Browser-managed temporary profile is retained; never recursively clean it.
})
