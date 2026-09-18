// Mechanical extraction only: emit an apply_patch diff, never write source files.
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const patches = [], translations = { en: {}, vi: {} }
function literal(node) {
  if (ts.isParenthesizedExpression(node)) return literal(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, args: [] }
  if (!ts.isTemplateExpression(node)) return null
  return { text: node.head.text + node.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join(''), args: node.templateSpans.map(s => s.expression.getText()) }
}
for (const [file, namespace] of [['src/components/SteamDirectDepotView.tsx', 'depotDirectUi'], ['src/components/DepotDownloaderView.tsx', 'depotLegacyUi']]) {
  const source = readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), edits = []
  translations.en[namespace] = {}; translations.vi[namespace] = {}
  function walk(node) {
    if (ts.isConditionalExpression(node) && node.condition.getText() === 'isVi') {
      const vi = literal(node.whenTrue), en = literal(node.whenFalse)
      if (vi && en) {
        // Keep locale-specific expression ordering explicit in the replacement.
        const args = [...new Set([...en.args, ...vi.args])]
        const remap = entry => entry.text.replace(/\{(\d+)\}/g, (_, i) => `{${args.indexOf(entry.args[Number(i)])}}`).replaceAll('Hubcap', '0xoLemon')
        const stem = en.text.replace(/\{\d+\}/g, '').replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/).slice(0, 6).map((s, i) => i ? s[0].toUpperCase()+s.slice(1).toLowerCase() : s.toLowerCase()).join('') || 'message'
        let key = stem, suffix = 2
        while (translations.en[namespace][key] !== undefined) key = stem + suffix++
        translations.en[namespace][key] = remap(en); translations.vi[namespace][key] = remap(vi)
        edits.push({ start: node.getStart(ast), end: node.end, value: `t.${namespace}.${key}` + args.map((arg, i) => `.replaceAll('{${i}}', String(${arg}))`).join('') })
        return
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  const groups = []
  for (const edit of edits.sort((a,b)=>a.start-b.start)) {
    const start = source.lastIndexOf('\n', edit.start - 1) + 1
    const newline = source.indexOf('\n', edit.end), end = newline < 0 ? source.length : newline
    const previous = groups.at(-1)
    if (previous && start <= previous.end) { previous.end = Math.max(previous.end,end); previous.edits.push(edit) }
    else groups.push({ start,end,edits:[edit] })
  }
  for (const group of groups) {
    const before = source.slice(group.start, group.end)
    let after = before
    for (const edit of group.edits.sort((a,b)=>b.start-a.start)) after = after.slice(0,edit.start-group.start)+edit.value+after.slice(edit.end-group.start)
    patches.push({file,before,after})
  }
}
for (const [locale, language] of [['en-US','en'], ['vi-VN','vi']]) {
  const file = `src/i18n/${locale}.ts`, source = readFileSync(file,'utf8')
  const extra = Object.entries(translations[language]).map(([key,value])=>`  ${key}: ${JSON.stringify(value,null,2)},\n`).join('')
  patches.push({ file, before: '  depotArchive: {', after: extra+'  depotArchive: {' })
}
let patch = '*** Begin Patch\n'
for (const file of [...new Set(patches.map(p=>p.file))]) {
  patch += `*** Update File: E:/007Launcher/${file}\n`
  for (const {before,after} of patches.filter(p=>p.file===file)) patch += '@@\n'+before.replaceAll('\r','').split('\n').map(l=>'-'+l).join('\n')+'\n'+after.replaceAll('\r','').split('\n').map(l=>'+'+l).join('\n')+'\n'
}
process.stdout.write(patch+'*** End Patch\n')
