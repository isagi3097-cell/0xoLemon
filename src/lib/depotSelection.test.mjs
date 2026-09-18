import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(readFileSync(new URL('./depotSelection.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText
const {defaultDepotSelection} = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
test('default coverage selects neutral/current/English and required shared, keeps other choices explicit',()=>{
  const depots=[{depotId:1},{depotId:2,language:'vietnamese'},{depotId:3,language:'english'},{depotId:4,language:'french'},{depotId:5,os:'linux'},{depotId:6,os:'windows,macos'},{depotId:7,dlcAppid:99},{depotId:8,isShared:true,fromAppid:480},{depotId:9,isShared:true,fromAppid:228980}].map(d=>({...d,publicManifestId:'123'}))
  const result=defaultDepotSelection([...depots,{depotId:10}], 'vi-VN')
  assert.deepEqual([...result.selected],[1,2,3,6,8])
  assert.deepEqual([...result.exclusions],[[4,'otherLanguage'],[5,'otherOs'],[7,'optionalDlc'],[9,'redistributable'],[10,'missingManifest']])
})
