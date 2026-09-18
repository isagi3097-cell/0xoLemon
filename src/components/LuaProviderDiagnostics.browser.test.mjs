import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { build } from 'vite'

const chromium = [
  process.env.EDGE_BIN, process.env.CHROME_BIN,
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean).find(existsSync)
const virtualEntry = resolve('src/components/__lua_diagnostics_fixture__.tsx').replaceAll('\\', '/')

// Bundle and mount the production React component. Only the process boundary and
// locale are substituted; tests never contact a provider or a running launcher.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {LuaProviderDiagnostics, freshnessAt} from ${JSON.stringify(resolve('src/components/LuaProviderDiagnostics.tsx').replaceAll('\\', '/'))};
const base = Date.parse('2026-09-04T12:00:00Z');
let currentTime = base;
Date.now = () => currentTime;
const ageTimers = [];
const originalInterval = window.setInterval.bind(window);
window.setInterval = (callback, delay, ...args) => {
  if (delay === 30000) ageTimers.push(callback);
  return originalInterval(callback, delay, ...args);
};
const checks = [];
const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let attempt = 0; attempt < 80; attempt++) { if (predicate()) return; await wait(10); }
  throw new Error('Component did not reach expected state: '+document.getElementById('root').textContent.slice(0,800));
}
const quota = {usage:null,limit:null,remaining:null};
const stamp = new Date(base).toISOString();
const observation = {checkedAt:stamp,result:'ready',errorCode:null,expiresAt:null,expiryEstimated:false,daily:quota,single:quota,bundle:quota,workshop:quota};
const settings = {schemaVersion:1,providerOrder:['hubcap','huggingFace','openLua'],pinnedProvider:null,healthTtlSeconds:300,confirmationPolicy:'manual',changeImpacts:{providerSelection:'applyNow',runtimeProfile:'relaunchGame',steamCompatibility:'restartSteam'}};
const health = {schemaVersion:1,observedAt:stamp,refreshed:false,settings,
 providers:[{id:'hubcap',configured:true,enabled:true,freshness:'fresh',availability:'ready',checkedAt:stamp,errorCode:null},{id:'openLua',configured:true,enabled:true,freshness:'unknown',availability:'unknown',checkedAt:null,errorCode:null}],
 capabilities:[{id:'metadata',state:'available',reason:'luaMetadataIndependentOfProviderQuota',activationAllowed:true,changeImpact:'applyNow'},{id:'gse',state:'unverified',reason:'runtimeIntegrityAndProvenanceRequired',activationAllowed:false,changeImpact:'relaunchGame'},{id:'workshop',state:'available',reason:'directWorkshopAccessOnly',activationAllowed:false,changeImpact:'applyNow'}],
 components:[],steam:{build:null,buildAllowlisted:false,binaryFile:'steam.exe',binarySha256:null,channel:'unknown',identitySource:'installedPackageManifestAndLocalBinaryHash',nativePatchApproved:false},hubcapHistory:[observation],quotaObservation:observation,warnings:[]};
const calls = [];
window.__luaInvoke = async (command, args) => {
  calls.push({command,args:structuredClone(args)});
  if(command === 'lua_save_experience_settings') return {...settings,...args.input};
  if(command !== 'lua_get_experience_health') throw new Error('Unexpected command: '+command);
  if(args.refresh) return {...health,refreshed:true,providers:[{...health.providers[0],availability:'unavailable',errorCode:'HUBCAP_RATE_LIMITED'},health.providers[1]],hubcapHistory:[observation,{...observation,checkedAt:new Date(base+1000).toISOString(),result:'failed',errorCode:'HUBCAP_RATE_LIMITED'}]};
  return health;
};
const onSaved = [];
const root = createRoot(document.getElementById('root'));
const button = text => Array.from(document.querySelectorAll('button')).find(node => node.textContent === text);
const provider = name => Array.from(document.querySelectorAll('.lpd-provider')).find(node => node.querySelector('strong').textContent.startsWith(name));
async function run() {
 flushSync(() => root.render(React.createElement(LuaProviderDiagnostics,{onSettingsSaved:value=>onSaved.push(value)})));
 await until(() => button('Check 0xoLemon quota') && !button('Check 0xoLemon quota').disabled);
 check(calls.length === 1 && calls[0].args.refresh === false,'mount reads local status only');
 check(provider('0xoLemon') && !document.querySelector('section').textContent.includes('Hubcap'),'real English UI displays the new brand');
 check(provider('OpenLua').textContent.includes('Unknown') && !provider('OpenLua').textContent.includes('Provider responded'),'unmeasured provider never appears healthy');
 check(Array.from(document.querySelectorAll('tbody td')).every(node => node.textContent === 'Unknown'),'unknown quotas never become zero or unlimited');
 check(document.querySelector('.lpd-capabilities .is-unverified').textContent.includes('Managed GSE'),'unverified runtime stays gated');
 check(document.body.textContent.includes('Unknown / unlisted build: native compatibility blocked'),'unknown Steam identity remains blocked');
 button('Check 0xoLemon quota').click();
 await until(() => calls.length === 2 && provider('0xoLemon').textContent.includes('HUBCAP_RATE_LIMITED') && !button('Check 0xoLemon quota').disabled);
 check(calls[1].args.refresh === true,'explicit quota button requests remote refresh');
 check(provider('0xoLemon').textContent.includes('HUBCAP_RATE_LIMITED'),'failed refresh is visible');
 check(document.querySelector('.lpd-capabilities .is-available').textContent.includes('Lua metadata'),'0xoLemon failure does not disable metadata');
 check(Array.from(document.querySelectorAll('.lpd-capabilities .is-available')).some(node=>node.textContent.includes('Workshop')),'Workshop public item tooling is independent of 0xoLemon quota');
 check(document.body.textContent.includes('These numbers retain their original timestamp'),'previous successful quota retains its timestamp');
 const select = document.querySelector('select'); select.value = 'openLua'; select.dispatchEvent(new Event('change',{bubbles:true}));
 await wait(20);
 button('Save Lua policy').click();
 await until(() => onSaved.length === 1 && document.querySelector('[role="status"]')?.textContent.includes('Lua policy saved'));
 const saved = calls.find(row=>row.command === 'lua_save_experience_settings');
 check(saved.args.input.pinnedProvider === 'openLua','manual pin is sent through policy command');
 check(Object.keys(saved.args.input).sort().join(',') === 'healthTtlSeconds,pinnedProvider,providerOrder','policy writes only its explicit settings fields');
 check(document.body.textContent.includes('No game, Steam setting or provider credential changed.'),'save notice does not claim runtime or credential mutation');
 currentTime = base + 301000; flushSync(() => ageTimers.forEach(callback=>callback()));
 check(provider('0xoLemon').textContent.includes('Stale observation') && provider('0xoLemon').textContent.includes('Unknown'),'observation ages without another remote request');
 check(calls.filter(row=>row.command === 'lua_get_experience_health').length === 2,'local freshness timer never polls provider');
 check(freshnessAt(stamp,300,base+300000) === 'fresh' && freshnessAt(stamp,300,base+300001) === 'stale','freshness boundary uses exact milliseconds');
 check(freshnessAt(null,300,base) === 'unknown' && freshnessAt('invalid',300,base) === 'unknown' && freshnessAt(stamp,300,base-1) === 'unknown','missing malformed and future timestamps are unknown');
 root.unmount();
 window.__luaLocale = 'vi-VN';
 const translated = createRoot(document.getElementById('root'));
 flushSync(() => translated.render(React.createElement(LuaProviderDiagnostics,{compact:true})));
 await until(() => button('Kiểm tra quota 0xoLemon') && !button('Kiểm tra quota 0xoLemon').disabled);
 check(document.querySelector('section').getAttribute('aria-label') === 'Chẩn đoán provider Lua','Vietnamese locale renders an accessible translated panel');
 check(provider('0xoLemon') && !document.querySelector('section').textContent.includes('Hubcap'),'real Vietnamese UI displays the new brand');
 check(calls.at(-1).command === 'lua_get_experience_health' && calls.at(-1).args.refresh === false,'compact translated remount remains local-only');
 translated.unmount();
 document.body.setAttribute('data-lua-results',btoa(JSON.stringify({checks})));
}
run().catch(error=>document.body.setAttribute('data-lua-results',btoa(JSON.stringify({checks,error:String(error.stack||error)}))));
`

test('Lua diagnostics mounts real component and enforces explicit refresh, scoped policy and independent degradation', {
  skip: chromium ? false : 'Microsoft Edge or Chrome is required for React DOM integration verification',
}, async () => {
  const result = await build({
    configFile: false, logLevel: 'error', define: {'process.env.NODE_ENV': '"production"'},
    plugins: [{
      name: 'lua-diagnostics-test-boundaries',
      enforce: 'pre',
      resolveId(source) {
        if (source.replaceAll('\\', '/') === virtualEntry) return '\0lua-diagnostics-test'
        if (source === '@tauri-apps/api/core') return '\0lua-test-tauri'
        if (source === '../context/locale') return '\0lua-test-locale'
      },
      load(id) {
        if (id === '\0lua-diagnostics-test') return fixture
        if (id === '\0lua-test-tauri') return 'export const invoke = (...args) => window.__luaInvoke(...args)'
        if (id === '\0lua-test-locale') return `import { enUS } from ${JSON.stringify(resolve('src/i18n/en-US.ts').replaceAll('\\', '/'))}; import { viVN } from ${JSON.stringify(resolve('src/i18n/vi-VN.ts').replaceAll('\\', '/'))}; export const useLocale = () => ({locale:window.__luaLocale || 'en-US', t:window.__luaLocale === 'vi-VN' ? viVN : enUS})`
      },
    }],
    build: {
      write: false, emptyOutDir: false, minify: false, target: 'es2022',
      lib: {entry: virtualEntry, formats: ['iife'], name: 'LuaDiagnosticsTest'},
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap(value => value.output)
  const script = output.filter(value => value.type === 'chunk').map(value => value.code).join('\n')
  assert.ok(script.includes('lua_get_experience_health'), 'production component was not bundled')
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'lua-provider-diagnostics-'))
  const fixturePath = join(fixtureDirectory, 'index.html')
  // A running desktop Edge instance otherwise consumes the headless invocation
  // and returns without DOM output. Never attach tests to the user's profile.
  const browserProfile = await mkdtemp(join(tmpdir(), 'lua-provider-browser-'))
  await writeFile(fixturePath, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><div id="root"></div><script>window.addEventListener('error', event => document.body.setAttribute('data-lua-results', btoa(JSON.stringify({error:event.message}))));${script.replaceAll('</script', '<\\/script')}</script>`, 'utf8')
  try {
    const browser = spawnSync(chromium, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-default-apps',
      `--user-data-dir=${browserProfile}`,
      '--no-first-run', '--disable-background-networking', '--disable-component-update',
      '--virtual-time-budget=6000', '--dump-dom', pathToFileURL(fixturePath).href,
    ], {encoding:'utf8', maxBuffer:16*1024*1024, timeout:25_000, windowsHide:true})
    assert.equal(browser.error, undefined, browser.error?.message)
    assert.equal(browser.status, 0, browser.stderr)
    const encoded = browser.stdout.match(/data-lua-results="([A-Za-z0-9+/=]+)"/)?.[1]
    assert.ok(encoded, `browser did not emit the real component test result: ${browser.stdout.slice(0, 1500)}; ${browser.stderr.slice(0, 1000)}`)
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    assert.equal(payload.error, undefined, `${payload.error}; completed checks: ${JSON.stringify(payload.checks)}`)
    assert.equal(payload.checks.length, 21, JSON.stringify(payload.checks))
  } finally {
    // Exact test-owned file and empty directory only; no recursive cleanup.
    await unlink(fixturePath)
    await rmdir(fixtureDirectory)
    // Chromium owns nested profile/cache files. Retain the isolated temporary
    // profile rather than using recursive cleanup or touching a personal profile.
  }
})
