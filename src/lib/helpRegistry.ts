import type { TabId } from '../types'

export type HelpTopicId =
  | 'whatsNew'
  | 'home'
  | 'social'
  | 'store'
  | 'luaShop'
  | 'luaInstaller'
  | 'library'
  | 'offlineActivation'
  | 'downloads'
  | 'cloudRedirect'
  | 'translations'
  | 'cache'
  | 'settings'

export const HELP_TOPIC_BY_TAB: Record<TabId, HelpTopicId> = {
  "What's New!": 'whatsNew',
  'Home': 'home',
  'Social': 'social',
  'Store': 'store',
  'Backup Game': 'store',
  'Lua Shop': 'luaShop',
  'Lua Installer': 'luaInstaller',
  'GSE / UC Setup': 'settings',
  'Tools': 'settings',
  'Library': 'library',
  'Offline Activation': 'offlineActivation',
  'Downloads': 'downloads',
  'CloudRedirect': 'cloudRedirect',
  'Bypass-fix': 'settings',
  'Translations': 'translations',
  'Cache': 'cache',
  'Settings': 'settings',
}

export const HELP_TOPIC_ORDER: HelpTopicId[] = [
  'home', 'social', 'store', 'library', 'luaShop', 'luaInstaller', 'downloads',
  'cloudRedirect', 'translations', 'offlineActivation', 'cache', 'settings', 'whatsNew',
]

export type HelpConceptId =
  | 'buildId'
  | 'manifest'
  | 'depotKey'
  | 'verify'
  | 'cache'
  | 'cloudSave'
  | 'luaMode'
  | 'luaSources'
  | 'offlineActivation'

export const HELP_CONCEPT_ORDER: HelpConceptId[] = [
  'buildId', 'manifest', 'depotKey', 'verify', 'cache', 'cloudSave', 'luaMode', 'luaSources', 'offlineActivation',
]
