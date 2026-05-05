import { defineConfig, type Plugin } from "tsup";

const emitDeclarations: Plugin = {
  name: "emit-declarations",
  async buildEnd() {
    const { execSync } = await import("node:child_process");
    execSync(
      'npx tsc --ignoreConfig --emitDeclarationOnly --noCheck --declaration --declarationMap --module ES2022 --target ES2022 --moduleResolution bundler --lib ES2022 --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule --types node --rootDir src src/index.ts src/schema/index.ts src/cli/index.ts src/server/index.ts --outDir dist',
      { stdio: "inherit" }
    );
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
