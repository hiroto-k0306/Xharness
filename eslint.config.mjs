import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".tools/**",
      "spike/.out/**",
      "dist/**",
      "out/**",
    ],
  },
  ...tseslint.configs.recommended,
);
