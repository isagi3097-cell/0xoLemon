import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, ChevronRight, Download, File, Folder, HardDrive, Loader2, X } from 'lucide-react'
import { formatBytes } from '../lib/format'
import { backupContentErrorMessage } from '../lib/backupContentError'

interface ManifestFileInfo { path: string; size: number }
interface DirNode { name: string; children: Map<string, DirNode>; files: ManifestFileInfo[] }

function buildDirTree(files: ManifestFileInfo[]): DirNode {
  const root: DirNode = { name: '', children: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), files: [] })
      node = node.children.get(part)!
    }
    node.files.push(file)
  }
  return root
}

function allPathsInDir(node: DirNode): string[] {
  const paths: string[] = []
  const collect = (n: DirNode) => { for (const f of n.files) paths.push(f.path); for (const c of n.children.values()) collect(c) }
  collect(node)
  return paths
}

function totalSizeInDir(node: DirNode): number {
  let size = 0
  const sum = (n: DirNode) => { for (const f of n.files) size += f.size; for (const c of n.children.values()) sum(c) }
  sum(node)
  return size
}

function DirRow({ node, selected, onToggleDir, onToggleFile }: {
  node: DirNode; selected: Set<string>
  onToggleDir: (paths: string[], allSelected: boolean) => void
  onToggleFile: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const allPaths = useMemo(() => allPathsInDir(node), [node])
  const dirSize = useMemo(() => totalSizeInDir(node), [node])
  const allSel = allPaths.length > 0 && allPaths.every((p) => selected.has(p))
  const someSel = !allSel && allPaths.some((p) => selected.has(p))
  return (
    <div className="fp-dir">
      <div className="fp-dir-row">
        <label className="fp-checkbox-label">
          <input type="checkbox" checked={allSel} ref={(el) => { if (el) el.indeterminate = someSel }} onChange={() => onToggleDir(allPaths, allSel)} />
        </label>
        <button type="button" className="fp-dir-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={13} />
          <span className="fp-name">{node.name}</span>
        </button>
        <span className="fp-size">{formatBytes(dirSize)}</span>
      </div>
      {expanded && (
        <div className="fp-dir-children">
          {[...node.children.values()].map((child) => (
            <DirRow key={child.name} node={child} selected={selected} onToggleDir={onToggleDir} onToggleFile={onToggleFile} />
          ))}
          {node.files.map((file) => {
            const name = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path
            return (
              <label key={file.path} className={`fp-file-row${selected.has(file.path) ? ' is-checked' : ''}`}>
                <input type="checkbox" checked={selected.has(file.path)} onChange={() => onToggleFile(file.path)} />
                <File size={12} className="fp-file-icon" />
                <span className="fp-name" title={file.path}>{name}</span>
                <span className="fp-size">{formatBytes(file.size)}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function FilePickerModal({ gameId, targetVersion, onConfirm, onClose }: {
  gameId: string; targetVersion?: string
  onConfirm: (selectedPaths: string[]) => void
  onClose: () => void
}) {
  const [files, setFiles] = useState<ManifestFileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [isAllocating, setIsAllocating] = useState(false)
  const [allocatingProgress, setAllocatingProgress] = useState(0)

  useEffect(() => {
    if (!isAllocating) return
    const timer1 = window.setTimeout(() => setAllocatingProgress(35), 250)
    const timer2 = window.setTimeout(() => setAllocatingProgress(75), 650)
    const timer3 = window.setTimeout(() => setAllocatingProgress(100), 1050)
    const timer4 = window.setTimeout(() => {
      setIsAllocating(false)
      onConfirm([...selected])
    }, 1300)
    return () => {
      window.clearTimeout(timer1)
      window.clearTimeout(timer2)
      window.clearTimeout(timer3)
      window.clearTimeout(timer4)
    }
  }, [isAllocating, onConfirm, selected])

  useEffect(() => {
    invoke<{ path: string; size: number }[]>('get_game_manifest_files', { gameId: gameId || null, targetVersion: targetVersion || null })
      .then((r) => { setFiles(r); setSelected(new Set()) })
      .catch((error) => {
        // Keep the original Tauri error visible. The previous generic fallback
        // made a missing route, bad game id, broker 503, and auth failure all
        // look identical, which made this modal impossible to diagnose.
        console.error('[backup-file-picker] get_game_manifest_files failed', {
          gameId,
          targetVersion,
          error,
        })
        setError(backupContentErrorMessage(error) || 'The Backup Game file list could not be loaded.')
      })
      .finally(() => setLoading(false))
  }, [gameId, targetVersion])

  const tree = useMemo(() => buildDirTree(files), [files])
  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files])
  const selectedSize = useMemo(() => files.filter((f) => selected.has(f.path)).reduce((s, f) => s + f.size, 0), [files, selected])
  const allSelected = files.length > 0 && selected.size === files.length

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, searchQuery])

  const handleToggleAll = useCallback(() => {
    if (allSelected) setSelected(new Set()); else setSelected(new Set(files.map((f) => f.path)))
  }, [allSelected, files])

  const handleToggleDir = useCallback((paths: string[], wasAllSelected: boolean) => {
    setSelected((prev) => { const next = new Set(prev); for (const p of paths) { if (wasAllSelected) next.delete(p); else next.add(p) }; return next })
  }, [])

  const handleToggleFile = useCallback((path: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next })
  }, [])

  if (isAllocating) {
    return (
      <div className="dialog-backdrop" role="dialog" aria-modal="true">
        <section className="install-modal fp-modal" style={{ maxWidth: 520 }}>
          <header>
            <h2><HardDrive size={16} /> Preparing Download</h2>
          </header>
          <div style={{ padding: '24px 20px' }}>
            <div className="steam-allocating-container" style={{ margin: 0, padding: 0 }}>
              <div className="steam-allocating-header">
                <div className="steam-allocating-icon">
                  <HardDrive size={22} color="#38bdf8" />
                </div>
                <div>
                  <div className="steam-allocating-title" style={{ fontWeight: 700, color: '#f8fafc', fontSize: 15 }}>
                    Allocating disk space for selected files...
                  </div>
                  <div className="steam-allocating-subtitle" style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>
                    Reserving storage and verifying local directory structure...
                  </div>
                </div>
              </div>
              <div className="steam-allocating-bar-track" style={{ margin: '18px 0 14px', height: 8, borderRadius: 999, background: 'rgba(15,23,42,0.85)', overflow: 'hidden' }}>
                <div className="steam-allocating-fill" style={{ width: `${allocatingProgress}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, #38bdf8, #818cf8, #c084fc)', transition: 'width 300ms ease' }} />
              </div>
              <div className="steam-allocating-meta-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
                <div className="steam-allocating-meta-item" style={{ background: 'rgba(255,255,255,0.04)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <small style={{ display: 'block', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Selected files</small>
                  <strong style={{ color: '#f1f5f9', fontSize: 14 }}>{selected.size} file{selected.size === 1 ? '' : 's'}</strong>
                </div>
                <div className="steam-allocating-meta-item" style={{ background: 'rgba(255,255,255,0.04)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <small style={{ display: 'block', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total download size</small>
                  <strong style={{ color: '#38bdf8', fontSize: 14 }}>{formatBytes(selectedSize)}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <section className="install-modal fp-modal">
        <header>
          <h2><File size={16} /> Select files to download</h2>
          <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        <div className="fp-toolbar">
          <div className="fp-toolbar-row">
            <label className="fp-checkbox-label fp-select-all">
              <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = !allSelected && selected.size > 0 }} onChange={handleToggleAll} />
              All ({files.length} files &middot; {formatBytes(totalSize)})
            </label>
            <div className="fp-toolbar-actions">
              <button type="button" className="fp-action-btn" onClick={() => setSelected(new Set(files.map((f) => f.path)))}>Select All</button>
              <button type="button" className="fp-action-btn" onClick={() => setSelected(new Set())}>Deselect All</button>
            </div>
          </div>
          <div className="fp-search-row">
            <input
              type="text"
              className="fp-search-input"
              placeholder="Search file name (e.g. discord, dll, exe)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="fp-list">
          {loading && <div className="fp-loading"><Loader2 size={20} className="fp-spin" /> Loading file list...</div>}
          {error && <div className="fp-error">{error}</div>}
          {!loading && !error && (
            filteredFiles !== null ? (
              filteredFiles.length === 0 ? (
                <div className="fp-empty">No files matching &ldquo;{searchQuery}&rdquo;</div>
              ) : (
                filteredFiles.map((file) => {
                  const isChecked = selected.has(file.path)
                  return (
                    <label key={file.path} className={`fp-file-row${isChecked ? ' is-checked' : ''}`}>
                      <input type="checkbox" checked={isChecked} onChange={() => handleToggleFile(file.path)} />
                      <File size={12} className="fp-file-icon" />
                      <span className="fp-name" title={file.path}>{file.path}</span>
                      <span className="fp-size">{formatBytes(file.size)}</span>
                    </label>
                  )
                })
              )
            ) : (
              <>
                {[...tree.children.values()].map((child) => (
                  <DirRow key={child.name} node={child} selected={selected} onToggleDir={handleToggleDir} onToggleFile={handleToggleFile} />
                ))}
                {tree.files.map((file) => {
                  const name = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path
                  return (
                    <label key={file.path} className={`fp-file-row${selected.has(file.path) ? ' is-checked' : ''}`}>
                      <input type="checkbox" checked={selected.has(file.path)} onChange={() => handleToggleFile(file.path)} />
                      <File size={12} className="fp-file-icon" />
                      <span className="fp-name" title={file.path}>{name}</span>
                      <span className="fp-size">{formatBytes(file.size)}</span>
                    </label>
                  )
                })}
              </>
            )
          )}
        </div>
        <footer>
          <span className="fp-summary">Selected: {selected.size}/{files.length} files &middot; {formatBytes(selectedSize)}</span>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            className="primary-control"
            type="button"
            disabled={loading || selected.size === 0}
            onClick={() => {
              setIsAllocating(true)
              setAllocatingProgress(15)
            }}
          >
            <Download size={15} />
            {selected.size === files.length ? 'Download all' : `Download ${selected.size} file${selected.size === 1 ? '' : 's'}`}
          </button>
        </footer>
      </section>
    </div>
  )
}
