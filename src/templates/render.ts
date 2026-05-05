import Handlebars from "handlebars";
import { readFileSync } from "node:fs";
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
  const templatePath = join(__dirname, templateName);
  const templateSource = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(templateSource);
  return template(context);
}
