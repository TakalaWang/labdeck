import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['.next', 'next-env.d.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // The JSON API's dynamic shapes (rows, request bodies) and the tests' fixtures.
    files: ['src/server/**', 'test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Registry code copied in by the shadcn CLI (shadcn/ui + SmoothUI). Kept close to
    // upstream so future `shadcn add --overwrite` diffs stay small.
    files: ['src/components/ui/**', 'src/components/smoothui/**', 'src/hooks/use-mobile.ts'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // The pages render plain <img> for the logo and data-URI charts; there is no next/image optimizer in this app.
    files: ['src/**'],
    rules: { '@next/next/no-img-element': 'off' },
  },
])
