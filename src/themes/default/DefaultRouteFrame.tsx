import { useState } from 'react'
import type { TabId } from '../../types'
import type { ThemeRouteFrameProps } from '../contracts'
import './DefaultRouteFrame.css'

const DEFAULT_ROUTE_ORDER: readonly TabId[] = [
  "What's New!",
  'Home',
  'Library',
  'Store',
  'Downloads',
  'Social',
  'Lua Shop',
  'Lua Installer',
  'GSE / UC Setup',
  'CloudRedirect',
  'Tools',
  'Translations',
  'Offline Activation',
  'Cache',
  'Settings',
]

export default function DefaultRouteFrame({ children, activeTab }: ThemeRouteFrameProps) {
  const [motionState, setMotionState] = useState<{ tab: TabId; direction: 'settled' | 'forward' | 'backward' }>({
    tab: activeTab,
    direction: 'settled',
  })

  if (motionState.tab !== activeTab) {
    const previousIndex = DEFAULT_ROUTE_ORDER.indexOf(motionState.tab)
    const activeIndex = DEFAULT_ROUTE_ORDER.indexOf(activeTab)
    setMotionState({
      tab: activeTab,
      direction: activeIndex >= previousIndex ? 'forward' : 'backward',
    })
  }

  return (
    <div
      className={`default-route-frame is-${motionState.direction}`}
      data-default-route={activeTab}
    >
      {children}
    </div>
  )
}
