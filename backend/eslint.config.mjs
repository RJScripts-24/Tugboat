import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.mjs"] },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Decorated Nest constructors carry metadata TypeScript alone cannot see.
      "@typescript-eslint/no-extraneous-class": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
