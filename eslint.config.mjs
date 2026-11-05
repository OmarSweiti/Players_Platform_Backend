// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Tenancy (0.4.3). A module reaches the database only through
// TenantTransactions (src/common/tenancy), never the root client; and a tenant
// context is minted only by the session guard (0.5.6), the worker's job loader
// (0.7.6) or an audited platform operation, each added to MINTERS as it arrives.
const MINTERS = [
  'src/common/tenancy/tenant-context.ts',
  'src/common/guards/session.guard.ts', // 0.5.6
  'src/cli/provision-tenant.ts', // 0.5.9: an audited platform operation
];
const MINT = {
  group: ['**/common/tenancy/tenant-context'],
  importNames: ['mintTenantContext'],
  message:
    'Only the session guard, the job loader or an audited platform operation mints a tenant context; receive one instead (0.4.3).',
};
const ROOT_CLIENT_MESSAGE =
  "Modules reach the database only through TenantTransactions.withTenantTransaction (src/common/tenancy, 0.4.3), never the root client.";
const ROOT_CLIENT = {
  paths: [
    { name: '@prisma/client', importNames: ['PrismaClient'], message: ROOT_CLIENT_MESSAGE },
  ],
  patterns: [
    {
      group: ['**/infrastructure/prisma/prisma.service'], // PrismaModule is global wiring, not the client
      message: ROOT_CLIENT_MESSAGE,
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // ESLint keeps one set of options per rule: a module gets both restrictions in one.
  {
    files: ['src/**/*.ts'],
    ignores: MINTERS,
    rules: { 'no-restricted-imports': ['error', { patterns: [MINT] }] },
  },
  {
    files: ['src/modules/**/*.ts'],
    ignores: MINTERS,
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ROOT_CLIENT.paths, patterns: [...ROOT_CLIENT.patterns, MINT] },
      ],
    },
  },
);
