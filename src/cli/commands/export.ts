import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readArchitecture } from "../../io/architecture-file.js";
import { generateMarkdown } from "../../export/markdown.js";
import { generateMermaid } from "../../export/mermaid.js";
import { generateHtmlGraph } from "../../export/html.js";

export interface ExportOptions {
  dir: string;
  format: "markdown" | "mermaid" | "html";
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

  if (options.format === "html") {
    const content = generateHtmlGraph(arch);
    // An HTML artifact to stdout is a wall of markup nobody asked for; the
    // default is the file the viewer serves, `arkive/graph.html`.
    const outPath = options.output ?? join(options.dir, "arkive", "graph.html");
    mkdirSync(join(options.dir, "arkive"), { recursive: true });
    writeFileSync(outPath, content, "utf-8");
    console.log(`Exported html to ${outPath}`);
    return;
  }

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
