import { Command } from "commander";

export function createLearnCommand(): Command {
  const cmd = new Command("learn")
    .description("Open the web viewer in Learning Mode")
    .option("-p, --port <port>", "Port for the web viewer", "3333")
    .option("--no-open", "Don't auto-open the browser")
    .action(async (options) => {
      const { port, open: shouldOpen } = options;
      const portNum = parseInt(port, 10);

      console.log(`Starting architecture viewer in Learning Mode on port ${portNum}...`);

      try {
        const { startViewer } = await import("../../viewer/server.js");
        await startViewer({ port: portNum, mode: "learning" });
      } catch {
        console.log(`Open http://localhost:${portNum}?mode=learning in your browser.`);
      }

      if (shouldOpen) {
        try {
          const open = (await import("open")).default;
          await open(`http://localhost:${portNum}?mode=learning`);
        } catch {
          console.log(`Open http://localhost:${portNum}?mode=learning in your browser.`);
        }
      }
    });

  return cmd;
}
