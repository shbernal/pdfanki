import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { globalIgnores } from 'eslint/config'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url))

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map(
  config => ({ ...config, files: ['**/*.ts'] }),
)

const stylisticConfigs = tseslint.configs.stylisticTypeChecked.map(config => ({
  ...config,
  files: ['**/*.ts'],
}))

export default tseslint.config(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.tmp/**',
    '**/*.tsbuildinfo',
    '**/*.d.ts',
    // local-only, gitignored working directories
    'fixtures/**',
    'docs/**',
    'test/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  ...typeCheckedConfigs,
  ...stylisticConfigs,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      // Error budget: these five fire ~660 times because tsconfig.base.json
      // sets `strict: false`, so `noImplicitAny` is off and the PDF/EPUB JSON
      // plumbing is implicitly `any`. Turning them on is gated on annotating
      // the ~123 implicit-any parameters `noImplicitAny` reports; do that as
      // its own task, then delete this block.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // `||` is load-bearing on primitives here: an empty PDF/EPUB title must
      // still fall back to the filename, so `??` would be a behavior change.
      // Keep the rule for object operands, where `||` is a genuine bug risk.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, number: true, boolean: true } },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          // cli/src/pdfankiRuntime.ts needs `typeof import(...)` to type the
          // workspace-vs-published module switch; there is no static form.
          disallowTypeAnnotations: false,
        },
      ],
      // unused-imports owns unused reporting so it can auto-drop dead imports
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
)
