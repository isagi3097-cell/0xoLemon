type Depot = { depotId: number; os?: string | null; language?: string | null; dlcAppid?: number | null; isShared?: boolean; fromAppid?: number | null; publicManifestId?: string | null }
export function defaultDepotSelection(depots: Depot[], locale: string, os = 'windows') {
  const language = locale.toLowerCase().startsWith('vi') ? 'vietnamese' : 'english'
  const selected = new Set<number>()
  const exclusions = new Map<number, 'otherOs' | 'otherLanguage' | 'optionalDlc' | 'redistributable' | 'missingManifest'>()
  for (const depot of depots) {
    const systems = (depot.os || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    const lang = depot.language?.toLowerCase()
    const reason = systems.length && !systems.includes(os) ? 'otherOs'
      : lang && ![language, 'english'].includes(lang) ? 'otherLanguage'
      : depot.dlcAppid ? 'optionalDlc'
      : depot.fromAppid === 228980 ? 'redistributable'
      : !depot.publicManifestId ? 'missingManifest' : null
    if (reason) exclusions.set(depot.depotId, reason)
    else selected.add(depot.depotId)
  }
  return { selected, exclusions }
}
