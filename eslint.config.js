import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", name: ["suite", "test"], package: "node:test" },
          ],
        },
      ],
      'prefer-const': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // couldn't figure out how to use ts-expect-error for this
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);
