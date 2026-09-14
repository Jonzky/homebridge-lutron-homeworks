import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'LutronXML_Parsin_Tool/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@stylistic/quotes': ['warn', 'single'],
      '@stylistic/indent': ['warn', 2, { SwitchCase: 1 }],
      '@stylistic/semi': ['warn', 'always'],
      '@stylistic/comma-dangle': ['warn', 'always-multiline'],
      '@stylistic/brace-style': ['warn'],
      '@stylistic/max-len': ['warn', 140],
      '@stylistic/comma-spacing': ['error'],
      '@stylistic/no-multi-spaces': ['warn', { ignoreEOLComments: true }],
      '@stylistic/lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
      'dot-notation': 'off',
      'eqeqeq': 'warn',
      'curly': ['warn', 'all'],
      'prefer-arrow-callback': ['warn'],
      'no-console': ['warn'], // use the Homebridge log method instead
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
];
