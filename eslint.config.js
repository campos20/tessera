import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "target/",
      "apps/desktop/src-tauri/",
      "packages/schema/src/generated/",
      "**/playwright-report/",
      "**/test-results/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The UI must stay platform-agnostic: it only talks to the AudioPlatform interface.
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@tauri-apps/*"], message: "packages/ui must not import Tauri; use AudioPlatform." },
            {
              group: ["@tessera/platform/*"],
              message: "Import only the AudioPlatform interface from @tessera/platform.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["AudioContext", "AudioWorkletNode", "OfflineAudioContext"].map((name) => ({
          name,
          message: "packages/ui must not use Web Audio directly; use AudioPlatform.",
        })),
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}", "**/*.config.ts", "**/e2e/**"],
    languageOptions: { globals: { ...globals.node } },
  },
);
