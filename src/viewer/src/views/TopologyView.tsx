import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Node, Edge } from "@xyflow/react";
import { ServiceNode } from "../components/ServiceNode.js";
import type { ServiceNodeData } from "../components/ServiceNode.js";
import { ConnectionEdge } from "../components/ConnectionEdge.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { computeLayout } from "../utils/layout.js";
import type { Service, Connection, Decision } from "../api/architecture.js";

interface TopologyViewProps {
  services: Service[];
  connections: Connection[];
  decisions: Decision[];
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

const nodeTypes = { service: ServiceNode };
const edgeTypes = { connection: ConnectionEdge };

export function TopologyView({
  services,
  connections,
  decisions,
}: TopologyViewProps) {
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  const { initialNodes, initialEdges } = useMemo(() => {
    const layoutNodes = services.map((s) => ({
      id: s.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));
    const layoutEdges = connections.map((c) => ({
      source: c.from,
      target: c.to,
    }));
    const positions = computeLayout(layoutNodes, layoutEdges);

    const nodes: Node[] = services.map((s) => {
      const pos = positions.get(s.id) ?? { x: 0, y: 0 };
      return {
        id: s.id,
        type: "service",
        position: pos,
        data: {
          label: s.name,
          type: s.type,
          technology: s.technology,
          description: s.description,
          ports: s.ports,
        } satisfies ServiceNodeData,
      };
    });

    const edges: Edge[] = connections.map((c, i) => ({
      id: `e-${i}`,
      source: c.from,
      target: c.to,
      type: "connection",
      data: {
        protocol: c.protocol,
        description: c.description,
      },
    }));

    return { initialNodes: nodes, initialEdges: edges };
  }, [services, connections]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const service = services.find((s) => s.id === node.id) ?? null;
      setSelectedService(service);
    },
    [services]
  );

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-border)" gap={20} />
        <Controls
          style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        />
        <MiniMap
          style={{ background: "var(--color-surface)" }}
          nodeColor="var(--color-accent)"
        />
      </ReactFlow>
      <DetailPanel
        service={selectedService}
        connections={connections}
        decisions={decisions}
        onClose={() => setSelectedService(null)}
      />
    </div>
  );
}
