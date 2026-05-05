import { z } from "zod";

export const McpServerEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  description: z.string().min(1),
  author: z.union([
    z.string().min(1),
    z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      url: z.string().url().optional(),
    }),
  ]),
  homepage: z.string().url().optional(),
  repository: z
    .object({
      type: z.string(),
      url: z.string().url().or(z.string().regex(/^git\+https?:\/\//)),
    })
    .optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  skills: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
});

export const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  source: z.union([
    z.string().min(1),
    z.object({
      type: z.enum(["github", "git", "npm", "local"]),
      repo: z.string().optional(),
      url: z.string().optional(),
      package: z.string().optional(),
      path: z.string().optional(),
    }),
  ]),
  version: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const MarketplaceManifestSchema = z.object({
  name: z.string().min(1),
  owner: z.union([
    z.string().min(1),
    z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      url: z.string().url().optional(),
    }),
  ]),
  description: z.string().min(1),
  plugins: z.array(MarketplacePluginEntrySchema).min(1),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;
