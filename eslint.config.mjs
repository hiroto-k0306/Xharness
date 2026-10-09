import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "Old/retired-sources/**",
      "node_modules/**",
      ".tools/**",
      "spike/.out/**",
      ".out/**",
      "dist/**",
      "out/**",
    ],
  },
  ...tseslint.configs.recommended,
);
