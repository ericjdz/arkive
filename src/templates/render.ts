import Handlebars from "handlebars";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TemplateContext {
  projectName: string;
  architectureFile: string;
}

export function renderTemplate(
  templateName: string,
  context: TemplateContext
): string {
  const candidates = [
    join(__dirname, templateName),
    join(__dirname, "..", "..", "src", "templates", templateName),
    join(__dirname, "..", "src", "templates", templateName),
  ];
  const templatePath = candidates.find((candidate) => existsSync(candidate));
  if (!templatePath) {
    throw new Error(`Template not found: ${templateName}`);
  }
  const templateSource = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(templateSource);
  return template(context);
}
