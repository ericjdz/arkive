import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createEmptyArchitecture } from "../../schema/validate.js";
import { renderTemplate } from "../../templates/render.js";
import { injectArkiveBlock } from "./inject.js";

export interface InitOptions {
  name?: string;
  dir: string;
  description?: string;
  standalone?: boolean;
}

export function initProject(options: InitOptions): void {
  const projectDir = options.dir;
  mkdirSync(projectDir, { recursive: true });

  const projectName = options.name || basename(projectDir);
  const description = options.description || `Architecture for ${projectName}`;
  const architectureFile = "architecture.json";

  const archPath = join(projectDir, architectureFile);
  if (!existsSync(archPath)) {
    const architecture = createEmptyArchitecture(projectName, description);
    writeFileSync(archPath, JSON.stringify(architecture, null, 2) + "\n", "utf-8");
    console.log(`Created ${architectureFile}`);
  } else {
    console.log(`${architectureFile} already exists, skipping`);
  }

  const templateContext = { projectName, architectureFile };

  if (options.standalone) {
    const claudePath = join(projectDir, "CLAUDE.md");
    if (!existsSync(claudePath)) {
      const claudeContent = renderTemplate("CLAUDE.md.hbs", templateContext);
      writeFileSync(claudePath, claudeContent, "utf-8");
      console.log("Created CLAUDE.md (standalone)");
    } else {
      console.log("CLAUDE.md already exists, skipping");
    }

    const agentsPath = join(projectDir, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      const agentsContent = renderTemplate("AGENTS.md.hbs", templateContext);
      writeFileSync(agentsPath, agentsContent, "utf-8");
      console.log("Created AGENTS.md (standalone)");
    } else {
      console.log("AGENTS.md already exists, skipping");
    }
  } else {
    const block = renderTemplate("arkive-block.md.hbs", templateContext);

    const claudePath = join(projectDir, "CLAUDE.md");
    const claudeExisted = existsSync(claudePath);
    injectArkiveBlock(claudePath, block);
    console.log(claudeExisted ? "Updated CLAUDE.md (injected arkive block)" : "Created CLAUDE.md");

    const agentsPath = join(projectDir, "AGENTS.md");
    const agentsExisted = existsSync(agentsPath);
    injectArkiveBlock(agentsPath, block);
    console.log(agentsExisted ? "Updated AGENTS.md (injected arkive block)" : "Created AGENTS.md");
  }

  const cursorDir = join(projectDir, ".cursor", "rules");
  mkdirSync(cursorDir, { recursive: true });
  const cursorPath = join(cursorDir, "architecture-tracker.mdc");
  if (!existsSync(cursorPath)) {
    const cursorContent = renderTemplate("cursor-rule.mdc.hbs", templateContext);
    writeFileSync(cursorPath, cursorContent, "utf-8");
    console.log("Created .cursor/rules/architecture-tracker.mdc");
  } else {
    console.log("Cursor rule already exists, skipping");
  }

  console.log(`\nDone! Architecture tracking initialized for "${projectName}".`);
  console.log("Your AI agent will now maintain architecture.json as it builds.");
}
