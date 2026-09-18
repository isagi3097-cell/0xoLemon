import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'

const browser = [process.env.CHROME_BIN, process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe')].filter(Boolean).find(existsSync)
const entry = resolve('src/components/__depot_search_test__.tsx').replaceAll('\\', '/')
const absolute = p => JSON.stringify(resolve(p).replaceAll('\\', '/'))
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {SteamDirectDepotView} from ${absolute('src/components/SteamDirectDepotView.tsx')};
const checks=[], requests=[]; const check=(v,n)=>{if(!v)throw Error(n);checks.push(n)};
const wait=(ms=10)=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait()}throw Error('Timeout '+document.body.textContent.slice(0,1000))}
window.__invoke=(command,args)=>{
 if(command==='depot_downloader_search_games')return new Promise((resolve,reject)=>requests.push({args,resolve,reject}));
 if(command==='depot_downloader_get_status')return Promise.resolve({isDownloading:false,isPaused:false});
 if(command==='depot_downloader_get_hubcap_status')return Promise.resolve({configured:true,valid:true,serviceReady:true,fetchedAt:Date.now(),stale:false,buckets:{single:{remaining:0,limit:25},daily:{remaining:0,limit:25},bundle:{remaining:0,limit:5}}});
 throw Error('Unexpected command '+command);
};
const root=createRoot(document.getElementById('root'));
const input=()=>document.querySelector('input');
function type(value){const node=input();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));}
const button=()=>document.querySelector('.steam-direct-search-btn');
async function run(){
 flushSync(()=>root.render(React.createElement(SteamDirectDepotView,{defaultLibraryRoot:'E:/Library'})));
 await until(()=>document.querySelector('.steam-direct-hubcap-badge'));
 check(document.querySelector('.steam-direct-hubcap-badge').textContent.includes('0/25'),'zero quota is visible');
 check(!document.getElementById('root').textContent.includes('Hubcap'),'normal UI uses 0xoLemon branding');
 type('among');await wait();input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 await until(()=>requests.length===1);await wait(400);
 check(requests.length===1,'Enter cancels pending debounce');
 check(button().disabled && document.querySelectorAll('.steam-direct-search-wrap .is-spinning').length<=1 && button().querySelector('.is-spinning'),'single spinner belongs to disabled search button');
 input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait();
 check(requests.length===1,'Enter during same request reuses in-flight promise');
 type('terraria');await until(()=>requests.length===2);
 requests[1].resolve([{appid:105600,name:'Terraria'}]);await until(()=>document.querySelector('.steam-direct-search-item-name')?.textContent==='Terraria');
 requests[0].resolve([{appid:945360,name:'Among Us'}]);await wait();
 check(document.querySelector('.steam-direct-search-item-name').textContent==='Terraria','old response cannot replace newer query');
 type('failure');await wait();button().click();await until(()=>requests.length===3);
 requests[2].reject('SEARCH_RATE_LIMITED');await until(()=>!button().disabled);
 check(document.querySelector('.steam-direct-alert').textContent.includes(window.__depotTestLocale==='vi-VN'?'Quá nhiều yêu cầu':'Too many requests'),'provider failure is not no-results');
 type('missing');await wait();button().click();await until(()=>requests.length===4);
 requests[3].resolve([]);await until(()=>!button().disabled);
 check(document.querySelector('.steam-direct-alert').textContent.includes(window.__depotTestLocale==='vi-VN'?'Không tìm thấy game':'No games found'),'successful empty search has distinct message');
 root.unmount();document.body.setAttribute('data-results',btoa(JSON.stringify({checks})));
}
run().catch(error=>document.body.setAttribute('data-results',btoa(JSON.stringify({checks,error:String(error.stack||error)}))));
`
test('Depot mounts real UI: search dedupe, stale response, single spinner and zero quota', { skip: !browser }, async () => {
  const result=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'depot-ui-test',enforce:'pre',resolveId(id){
    if(id.replaceAll('\\','/')===entry)return '\0fixture';
    if(['@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog','../context/locale'].includes(id))return '\0'+id;
  },load(id){
    if(id==='\0fixture')return fixture;
    if(id==='\0@tauri-apps/api/core')return 'export const invoke=(...args)=>window.__invoke(...args)';
    if(id==='\0@tauri-apps/api/event')return 'export const listen=async()=>()=>{}';
    if(id==='\0@tauri-apps/plugin-dialog')return 'export const open=async()=>null';
    if(id==='\0../context/locale')return 'import {enUS} from '+absolute('src/i18n/en-US.ts')+'; import {viVN} from '+absolute('src/i18n/vi-VN.ts')+'; export const useLocale=()=>({locale:window.__depotTestLocale,t:window.__depotTestLocale==="vi-VN"?viVN:enUS})';
  }}],build:{write:false,emptyOutDir:false,minify:false,target:'es2022',lib:{entry,formats:['iife'],name:'DepotTest'}}});
  const script=(Array.isArray(result)?result:[result]).flatMap(r=>r.output).filter(r=>r.type==='chunk').map(r=>r.code).join('\n');
  for (const locale of ['en-US','vi-VN']) {
  const directory=await mkdtemp(join(tmpdir(),'oxo-depot-test-')),profile=await mkdtemp(join(tmpdir(),'oxo-depot-browser-')),file=join(directory,'index.html');
  await writeFile(file,`<meta charset="utf-8"><div id="root"></div><script>window.__depotTestLocale=${JSON.stringify(locale)};${script.replaceAll('</script','<\\/script')}</script>`);
  try{
    const r=spawnSync(browser,['--headless=new','--disable-gpu','--disable-extensions',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--disable-component-update','--virtual-time-budget=6000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:25000,windowsHide:true});
    assert.equal(r.error,undefined);assert.equal(r.status,0);
    const encoded=r.stdout.match(/data-results="([A-Za-z0-9+/=]+)"/)?.[1];assert.ok(encoded,r.stderr.slice(-1000));
    const payload=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));assert.equal(payload.error,undefined,JSON.stringify(payload));assert.equal(payload.checks.length,8);
  }finally{await unlink(file);await rmdir(directory)}
  }
})
