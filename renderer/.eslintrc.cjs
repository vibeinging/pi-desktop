module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist/', 'node_modules/'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    // Sanitizers intentionally match ASCII control characters.
    'no-control-regex': 'off',
    'no-extra-semi': 'warn',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx}'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
      extends: ['plugin:react-hooks/recommended'],
      rules: {
        'no-undef': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        'react-hooks/exhaustive-deps': 'warn',
        'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      },
    },
  ],
}
