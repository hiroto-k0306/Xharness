import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".tools/**", "spike/.out/**", "dist/**"] },
  ...tseslint.configs.recommended,
);
