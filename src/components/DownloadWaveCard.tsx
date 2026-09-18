import { useEffect, useId, useSyncExternalStore } from 'react'
import { useLocale } from '../context/locale'
import { formatBytes } from '../lib/format'
import { publishTransfer, readTransfer, subscribeTransfers } from '../lib/transferTelemetry'
import type { TransferTelemetryV1 } from '../lib/transferTelemetry'
import './DownloadWaveCard.css'

function buildMonotoneSpline(pts: [number, number][]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

export function DownloadWaveCard({ telemetry, variant = 'default' }: { telemetry: TransferTelemetryV1; variant?: 'default' | 'storeTransfer' }) {
  const { t } = useLocale()
  const gradient = useId().replace(/:/g, '')
  // Depend on data fields, not render-created object identity.
  const serialized = JSON.stringify(telemetry)
  useEffect(() => { publishTransfer(JSON.parse(serialized)) }, [serialized])
  const wave = useSyncExternalStore(subscribeTransfers, () => readTransfer(telemetry.transferId))
  const rawSamples = wave?.samples || []
  const paddedSamples = rawSamples.length >= 44 ? rawSamples.slice(-44) : [...Array(44 - rawSamples.length).fill(0), ...rawSamples]
  const speed = telemetry.bytesPerSecond !== undefined && Number.isFinite(telemetry.bytesPerSecond) && telemetry.bytesPerSecond >= 0 ? telemetry.bytesPerSecond : undefined
  if (speed !== undefined && speed > 0 && paddedSamples[paddedSamples.length - 1] === 0) {
    paddedSamples[paddedSamples.length - 1] = speed
  }
  const max = Math.max(1, ...paddedSamples)
  const isDownloading = ['downloading', 'resolving', 'verifying'].includes(telemetry.state)
  const points: [number, number][] = paddedSamples.map((v, i) => {
    const x = i * (1000 / 43)
    if (max > 1) {
      return [x, 96 - (v / max) * 78]
    }
    if (isDownloading) {
      const waveOffset = Math.sin((i / 43) * Math.PI * 4) * 6
      return [x, 88 + waveOffset]
    }
    return [x, 98]
  })
  const path = buildMonotoneSpline(points)
  const fillPath = path ? `${path} L 1000 110 L 0 110 Z` : ''
  const progress = telemetry.progress === undefined || !Number.isFinite(telemetry.progress) ? undefined : Math.max(0, Math.min(100, telemetry.progress))
  return <section className={`download-wave-card ${variant === 'storeTransfer' ? 'download-wave-card--store-transfer' : ''} ${progress === undefined && isDownloading ? 'is-indeterminate' : ''}`} aria-label={t.transferProgress.title}>
    <header><strong>{telemetry.phaseLabel || t.transferProgress.title}</strong><span>{speed === undefined ? '—' : `${formatBytes(speed)}/s`}</span></header>
    <svg viewBox="0 0 1000 110" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#6366f1" stopOpacity="0.65" />
          <stop offset="95%" stopColor="#8b5cf6" stopOpacity="0.0" />
        </linearGradient>
      </defs>
      {[25, 50, 75, 100].map(y => <line key={y} x1="0" y1={y} x2="1000" y2={y} stroke="rgba(255, 255, 255, 0.07)" strokeDasharray="4 4" />)}
      {path && <><path d={fillPath} fill={`url(#${gradient})`} /><path d={path} fill="none" stroke="#818cf8" strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
    </svg>
    <div className="download-wave-track" role="progressbar" aria-label={t.transferProgress.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div style={{ width: `${progress ?? 30}%` }} /></div>
    <footer><span>{t.transferProgress.transferred}: {telemetry.downloadedBytes === undefined ? '—' : formatBytes(telemetry.downloadedBytes)}{telemetry.totalBytes ? ` / ${formatBytes(telemetry.totalBytes)}` : ''}</span><span>{progress === undefined ? t.transferProgress.preparing : `${progress.toFixed(1)}%`}</span><span>{t.transferProgress.eta}: {telemetry.etaSeconds === undefined ? '—' : `${Math.ceil(telemetry.etaSeconds)}s`}</span></footer>
  </section>
}
