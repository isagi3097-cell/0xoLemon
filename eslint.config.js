import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'src-tauri/target',
    'tools/launcher-tools/target',
    'src/App_backup.tsx',
    'worker/node_modules',
    'worker/dist',
    'worker/worker-configuration.d.ts',
    // Local backup/scratch trees: not part of the repo, but present on disk.
    // They carry their own tsconfig.json files, which otherwise break the parser.
    '.bak/**',
    '.tmp-*/**',
    'downloads/**',
    'downloading/**',
    'patch_test/**',
    'testnehubcap/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
