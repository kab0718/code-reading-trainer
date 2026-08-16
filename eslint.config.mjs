import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig([
  {
    ignores: ["dist/**"],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
      },
    },
    rules: js.configs.recommended.rules,
  },
  {
    files: [
      "api/**/*.mjs",
      "scripts/**/*.mjs",
      "tests/**/*.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: js.configs.recommended.rules,
  },
]);
