import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createViewerServer } from "./serve.js";
import { architecturePath } from "../../io/architecture-file.js";

// `open` is an optional convenience and is deliberately NOT a declared dependency
// of this package, so it can only ever be resolved at runtime. The `.catch()`
// below is the supported degradation path: when `open` is not installed we fall
// back to printing the URL. The specifier is held in a variable so that
// TypeScript treats this as a runtime-only resolution instead of a compile-time
// module reference (which would be a hard build error for an optional module).
const OPEN_MODULE = "open";

export function createLearnCommand(): Command {
  const cmd = new Command("learn")
    .description("Open the web viewer in Learning Mode")
    .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
    .option("-p, --port <port>", "Port for the web viewer", "4567")
    .option("--no-open", "Do not auto-open the browser")
    .action(async (options) => {
      const dir = resolve(options.dir);
      const port = parseInt(options.port, 10);

      const archPath = architecturePath(dir);
      if (!existsSync(archPath)) {
        process.stderr.write(
          `arkive/architecture.json not found. Run \`arkive init\` first.\n`
        );
        process.exit(1);
      }

      const { server } = createViewerServer(dir);
      server.listen(port, () => {
        const url = `http://localhost:${port}?mode=learning`;
        process.stderr.write(`Learning Mode at ${url}\n`);

        import(OPEN_MODULE)
          .then((mod) => mod.default(url))
          .catch(() => {
            process.stderr.write(`Open ${url} in your browser.\n`);
          });
      });
    });

  return cmd;
}
