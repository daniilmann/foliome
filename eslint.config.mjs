import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['core/**/*.ts', 'base/*.js', 'scripts/checks/**/*.{cjs,ts}', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Stand fixtures exercise dynamically shaped browser and IPC messages.
    files: ['test/stand/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
