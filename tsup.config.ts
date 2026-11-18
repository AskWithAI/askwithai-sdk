import { defineConfig } from "tsup";

// Plain JavaScript and type declarations, so apps can install the package with no TypeScript build step.
export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing.ts", cli: "src/cli.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node22",
  sourcemap: false,
});
