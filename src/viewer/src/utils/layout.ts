import dagre from "dagre";

interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

interface LayoutEdge {
  source: string;
  target: string;
}

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: "TB" | "LR" = "TB"
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 80, ranksep: 100 });

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const pos = g.node(node.id);
    positions.set(node.id, {
      x: pos.x - node.width / 2,
      y: pos.y - node.height / 2,
    });
  }

  return positions;
}
