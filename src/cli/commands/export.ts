import { writeFileSync } from "node:fs";
import { readArchitecture } from "../../io/architecture-file.js";
import { generateMarkdown } from "../../viewer/src/utils/markdown.js";
import { generateMermaid } from "../../viewer/src/utils/mermaid.js";

export interface ExportOptions {
  dir: string;
  format: "markdown" | "mermaid";
  output?: string;
}

export function exportArchitecture(options: ExportOptions): void {
  const read = readArchitecture(options.dir);
  if (!read.success) {
    process.stderr.write(read.error + "\n");
    process.exit(1);
  }

  // The v1 shape is what the mermaid exporter and the markdown generator both
  // take. `readArchitecture` attaches it as a computed projection of
  // `nodes`/`edges`, so nothing here reaches into the graph or invents fields
  // the projection already provides.
  const arch = read.data;
  let content: string;

  if (options.format === "mermaid") {
    content = generateMermaid(arch.services, arch.connections);
  } else {
    content = generateMarkdown(arch as unknown as Parameters<typeof generateMarkdown>[0]);
  }

  if (options.output) {
    writeFileSync(options.output, content, "utf-8");
    console.log(`Exported ${options.format} to ${options.output}`);
  } else {
    process.stdout.write(content + "\n");
  }
}
