import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface ServiceNodeData {
  label: string;
  type: string;
  technology: string;
  description: string;
  ports?: string[];
  [key: string]: unknown;
}

const TYPE_COLORS: Record<string, string> = {
  frontend: "var(--color-frontend)",
  backend: "var(--color-backend)",
  database: "var(--color-database)",
  cache: "var(--color-cache)",
  queue: "var(--color-cache)",
  gateway: "var(--color-backend)",
  other: "var(--color-other)",
};

export function ServiceNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ServiceNodeData;
  const color = TYPE_COLORS[nodeData.type] ?? TYPE_COLORS.other;

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "var(--radius)",
        background: "var(--color-surface)",
        border: `2px solid ${selected ? "var(--color-accent)" : color}`,
        minWidth: 160,
        boxShadow: selected
          ? `0 0 0 2px ${color}40`
          : "0 2px 8px rgba(0,0,0,0.3)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div
        style={{
          fontSize: "0.625rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color,
          marginBottom: 4,
          fontWeight: 600,
        }}
      >
        {nodeData.type}
      </div>
      <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: 2 }}>
        {nodeData.label}
      </div>
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--color-text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {nodeData.technology}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}
