import { readArchitecture } from "../io/architecture-file.js";
import type { ArchitectureDocument } from "../io/architecture-file.js";
import type { GraphDecision, GraphNode } from "../schema/graph.js";
import { HOOK_EXIT, silentResult } from "./contract.js";
import type { HookInput, HookResult } from "./contract.js";
import { hookProjectDir, locateProject, matchSourcePath, readArkiveConfig, toPosix } from "./paths.js";

/**
 * `pre-tool-use` — the nudge that closes the read/update gap.
 *
 * ADR-0005 rejected "hook only `SessionStart`; rely on drift checks for the rest"
 * because session-start is the highest-value hook but `PreToolUse` is what
 * closes the distance between "read at start" and "update after a change" — and
 * the update is the half that never happens.
 *
 * The nudge is advisory by construction. It emits context and nothing else: no
 * `permissionDecision`, no `updatedInput`, exit 0. A hook that fires on every
 * edit and can deny edits would be removed inside a day, and it would also be
 * wrong, because whether an edit is architectural is a judgement, not a pattern
 * match.
 */

/** Tool names that change a file. Anything else is out of scope for this hook. */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** Inbound edges and decisions included per node. Enough to be useful, short enough to skim. */
const MAX_INBOUND_EDGES = 6;
const MAX_DECISIONS = 2;

export function preToolUse(input: HookInput, elapsedMs = 0): HookResult {
  if (!input.toolName || !FILE_TOOLS.has(input.toolName)) {
    return silentResult("pre-tool-use", elapsedMs);
  }
  if (!input.filePath) {
    return silentResult("pre-tool-use", elapsedMs);
  }

  const project = locateProject(hookProjectDir(input));
  if (project.dir === null) return silentResult("pre-tool-use", elapsedMs);

  const match = matchSourcePath(
    input.filePath,
    project.dir,
    readArkiveConfig(project.dir)
  );
  if (!match.isSource) {
    // A hook on every edit that fires on every edit is noise. Say nothing about
    // the files that are not architecture.
    return silentResult("pre-tool-use", elapsedMs);
  }

  const read = readArchitecture(project.dir);
  if (!read.success) {
    return {
      ...silentResult("pre-tool-use", elapsedMs),
      inconclusive: true,
      notes: [`arkive pre-tool-use: could not read the document — ${read.error}`],
    };
  }

  const context = renderNudge(read.data, match.relPath ?? toPosix(input.filePath));
  if (context === null) return silentResult("pre-tool-use", elapsedMs);

  return {
    event: "pre-tool-use",
    context,
    block: false,
    reason: null,
    inconclusive: false,
    notes: [],
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs,
    overBudget: false,
  };
}

/** Longest node `path` that is a prefix of `relPath`. Exact match wins outright. */
function resolveNode(nodes: readonly GraphNode[], relPath: string): GraphNode | null {
  const exact = nodes.find((node) => node.path !== undefined && toPosix(node.path) === relPath);
  if (exact) return exact;

  let best: GraphNode | null = null;
  let bestLength = -1;
  for (const node of nodes) {
    if (node.path === undefined) continue;
    const nodePath = toPosix(node.path);
    if (!nodePath) continue;
    if (!relPath.startsWith(nodePath.endsWith("/") ? nodePath : `${nodePath}/`)) continue;
    if (nodePath.length > bestLength) {
      best = node;
      bestLength = nodePath.length;
    }
  }
  return best;
}

/**
 * One line, at most a small block.
 *
 * Two cases, and the second is the one that matters:
 *
 * - the path is a known module — name what depends on it and which decisions
 *   govern it, so the edit is made with that in view rather than after;
 * - the path is *not* in the graph — which is the signal that a module boundary
 *   may have just appeared, and the update half of the lifecycle rule that
 *   prose alone never gets done.
 */
function renderNudge(document: ArchitectureDocument, relPath: string): string | null {
  const liveNodes = document.nodes.filter((node) => node.deletedAt === undefined);
  const node = resolveNode(liveNodes, relPath);
  const where = `\`${relPath}\``;

  if (node === null) {
    return [
      `${where} is a source path and is not in the architecture graph.`,
      "If this edit creates or moves a module boundary, a service, a datastore, or a",
      "protocol, the architecture record needs a node and the reasoning behind it.",
      "Structure is derived from the code automatically; intent is not.",
    ].join(" ");
  }

  const inbound = document.edges
    .filter((edge) => edge.to === node.id && edge.dangling !== true)
    .map((edge) => `${edge.from} -${edge.kind}-> ${node.id}`)
    .slice(0, MAX_INBOUND_EDGES);

  const decisions: GraphDecision[] = document.decisions
    .filter((decision) => decision.subjects.some((subject) => subject.ref === node.id))
    .slice(-MAX_DECISIONS);

  const lines = [`${where} is \`${node.id}\` (${node.kind}${node.tech ? `, ${node.tech}` : ""}).`];
  if (node.summary) lines.push(node.summary);
  if (inbound.length > 0) lines.push(`Depends on it: ${inbound.join("; ")}.`);
  for (const decision of decisions) {
    lines.push(`Decision: ${decision.topic} — ${decision.decision}`);
  }
  lines.push("If this edit changes what depends on it, or why, record the change.");
  return lines.join(" ");
}
