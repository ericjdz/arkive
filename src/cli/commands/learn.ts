import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createViewerServer } from "./serve.js";
import { architecturePath } from "../../io/architecture-file.js";

export function createLearnCommand(): Command {
  const cmd = new Command("learn")
    .description("Open the web viewer in Learning Mode")
    .option("-d, --dir <path>", "Project directory containing architecture.json", ".")
    .option("-p, --port <port>", "Port for the web viewer", "4567")
    .option("--no-open", "Do not auto-open the browser")
    .action(async (options) => {
      const dir = resolve(options.dir);
      const port = parseInt(options.port, 10);

      const archPath = architecturePath(dir);
      if (!existsSync(archPath)) {
        process.stderr.write(
          `architecture.json not found. Run \`archlearn init\` first.\n`
        );
        process.exit(1);
      }

      const { server } = createViewerServer(dir);
      server.listen(port, () => {
        const url = `http://localhost:${port}?mode=learning`;
        process.stderr.write(`Learning Mode at ${url}\n`);

        import("open")
          .then((mod) => mod.default(url))
          .catch(() => {
            process.stderr.write(`Open ${url} in your browser.\n`);
          });
      });
    });

  return cmd;
}
