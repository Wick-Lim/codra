import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/out-remote-test/**",
      "**/dist/**",
      "**/dist-remote-test/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);
