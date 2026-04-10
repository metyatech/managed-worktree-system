export default [
  {
    ignores: [
      'node_modules/**',
      'AGENTS.md',
      'CLAUDE.md',
    ],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
];
