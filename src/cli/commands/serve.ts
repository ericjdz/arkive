import { existsSync } from "node:fs";
import { architecturePath } from "../../io/architecture-file.js";
import { startStdioServer } from "../../server/index.js";

export interface ServeOptions {
  dir: string;
}

export async function serveProject(options: ServeOptions): Promise<void> {
  const archPath = architecturePath(options.dir);
  if (!existsSync(archPath)) {
    process.stderr.write(
      `architecture.json not found at ${archPath}. Run \`archlearn init\` first.\n`
    );
    process.exit(1);
  }

  await startStdioServer({ dir: options.dir });
}
