/**
 * Layered walkthrough engine (issue 0009, ADR-0003): pure, deterministic
 * queries over the graph. No I/O, no LLM calls.
 */
export {
  SYSTEM_ROOT,
  STORABLE_EDGE_KINDS,
  claimForNode,
  claimForEdge,
  nodeEntry,
  edgeEntry,
  decisionEntryFor,
  directDecisions,
  emptyEdgeGroups,
  childNodes,
  descendBreadcrumb,
} from "./levels.js";
export type {
  WalkLevel,
  Breadcrumb,
  ProvenanceClaim,
  NodeEntry,
  EdgeEntry,
  AlternativeView,
  DecisionEntry,
  GraphSlice,
} from "./levels.js";
export {
  DEFAULT_OPEN_DEPTH,
  MAX_OPEN_DEPTH,
  clampDepth,
  topology,
  open,
  trace,
  traceRequest,
  explainBoundary,
  explainDecision,
  followDataShape,
  viewAtLevel,
  ascend,
} from "./traversals.js";
export type {
  CompactNode,
  CompactEdge,
  TopologyResult,
  OpenOptions,
  OpenResult,
  TraceHop,
  TraceResult,
  RequestHop,
  TraceRequestResult,
  BoundaryExplanation,
  DecisionClaimSubject,
  DecisionClaimView,
  ExplainDecisionResult,
  ShapeLink,
  FollowDataShapeResult,
  AscendResult,
} from "./traversals.js";
