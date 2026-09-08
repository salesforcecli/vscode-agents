// Flat config (ESLint 9+/10). Ports the former .eslintrc.json 1:1.
const tseslint = require('typescript-eslint');
const eslintConfigPrettier = require('eslint-config-prettier');
const importX = require('eslint-plugin-import-x');
const { createTypeScriptImportResolver } = require('eslint-import-resolver-typescript');

module.exports = tseslint.config(
  // Former .eslintignore
  {
    ignores: ['lib/', 'dist/', 'scripts/', 'webview/', 'test/', 'node_modules/', '.vscode-test/']
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    plugins: {
      'import-x': importX
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()]
    },
    rules: {
      'import-x/extensions': ['error', 'ignorePackages', { js: 'never', jsx: 'never', ts: 'never', tsx: 'never' }],
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'warn'
    }
  },
  // Disable stylistic rules that conflict with Prettier (former "prettier" extend). Keep last.
  eslintConfigPrettier
);
