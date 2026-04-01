import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['**/*.ts'],
    extends: [
      // ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // 'prefer-const': 'off',
      // '@typescript-eslint/no-unused-vars': 'off',
      // '@typescript-eslint/no-unsafe-assignment': 'off',
      // '@typescript-eslint/no-unsafe-argument': 'off',
      // '@typescript-eslint/no-unsafe-call': 'off',
      // '@typescript-eslint/no-unsafe-member-access': 'off',
      // '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
