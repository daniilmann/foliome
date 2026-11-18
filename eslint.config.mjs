import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['core/**/*.ts', 'base/*.js', 'scripts/checks/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
