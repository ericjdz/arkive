import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

export interface ConnectionEdgeData {
  protocol: string;
  description: string;
  [key: string]: unknown;
}

export function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = data as unknown as ConnectionEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? "var(--color-accent)" : "var(--color-border)",
          strokeWidth: selected ? 2 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: "0.625rem",
            fontFamily: "var(--font-mono)",
            background: "var(--color-bg)",
            padding: "2px 6px",
            borderRadius: 4,
            color: "var(--color-text-muted)",
            border: "1px solid var(--color-border)",
            pointerEvents: "all",
          }}
        >
          {edgeData?.protocol ?? ""}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
