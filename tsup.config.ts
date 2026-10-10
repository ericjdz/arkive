import { defineConfig, type Options } from "tsup";

// tsup declares `Plugin` internally but does not export it. Derive the same
// type from the public `plugins` option so this stays in step with tsup itself.
type Plugin = NonNullable<Options["plugins"]>[number];

const emitDeclarations: Plugin = {
  name: "emit-declarations",
  async buildEnd() {
    const { execSync } = await import("node:child_process");
    try {
      execSync(
        'npx tsc --ignoreConfig --emitDeclarationOnly --noCheck --declaration --declarationMap --module ES2022 --target ES2022 --moduleResolution bundler --lib ES2022 --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule --types node --rootDir src src/index.ts src/schema/index.ts src/cli/index.ts src/server/index.ts --outDir dist',
        { stdio: "inherit" }
      );
    } catch {
      console.warn("Skipping declaration emit; tsc unavailable or incomplete.");
    }
  },
};

export default defineConfig([
  {
    name: "cli",
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    sourcemap: true,
    clean: true,
    splitting: false,
    shims: false,
  },
  {
    name: "server",
    entry: { "server/index": "src/server/index.ts" },
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    sourcemap: true,
    splitting: false,
  },
  {
    name: "lib",
    entry: {
      "index": "src/index.ts",
      "schema/index": "src/schema/index.ts",
    },
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    sourcemap: true,
    splitting: false,
    plugins: [emitDeclarations],
  },
]);
