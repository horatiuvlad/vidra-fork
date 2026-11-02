import { defineConfig } from "tsup";

// @vidra-dev/cli-shared is a private workspace package, never published, so it
// is inlined here. Its own third-party imports stay external and are listed in
// this package's dependencies.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  tsconfig: "tsconfig.json",
  noExternal: ["@vidra-dev/cli-shared"],
});
