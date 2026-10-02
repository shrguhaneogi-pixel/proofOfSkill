import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Rust/Anchor output, mirrored into lib/solana/idl by `anchor build`.
    "target/**",
    // Scratch space for agents and one-off scripts; not app source.
    ".qwen/**",
    // Intentional CommonJS: plain `node` scripts that must run without a bundler
    // or ts-node, so `require()` is the correct form there, not a lapse.
    "scripts/**/*.cjs",
  ]),
]);

export default eslintConfig;
