import type { ConceptMastery, QuestionCategory } from "../../../learning/types.js";

interface ConceptMapProps {
  concepts: ConceptMastery[];
}

const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  decision: "Decisions",
  topology: "Services",
  connection: "Connections",
  "data-flow": "Data Flows",
  stack: "Stack",
};

function getNodeStatus(concept: ConceptMastery): "mastered" | "attempted" | "unexplored" {
  if (concept.mastered) return "mastered";
  if (concept.attempts > 0) return "attempted";
  return "unexplored";
}

function el(tag: string, props: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    $$typeof: Symbol.for("react.transitional.element"),
    type: tag,
    key: props.key == null ? null : String(props.key),
    props: { ...props, children },
    _owner: null,
    _store: {},
  };
}

export function ConceptMap({ concepts }: ConceptMapProps) {
  if (concepts.length === 0) {
    return el("div", { className: "concept-map" }, [
      el("div", { className: "concept-map__empty" }, ["No concepts to display. Update your architecture to generate concepts."]),
    ]);
  }

  const grouped = new Map<QuestionCategory, ConceptMastery[]>();
  for (const concept of concepts) {
    const list = grouped.get(concept.category) ?? [];
    list.push(concept);
    grouped.set(concept.category, list);
  }

  return el("div", { className: "concept-map" }, [
    el("div", { className: "concept-map__legend" }, [
      el("span", { className: "concept-map__legend-item concept-map__legend-item--mastered" }, ["Mastered"]),
      el("span", { className: "concept-map__legend-item concept-map__legend-item--attempted" }, ["Attempted"]),
      el("span", { className: "concept-map__legend-item concept-map__legend-item--unexplored" }, ["Unexplored"]),
    ]),
    ...Array.from(grouped.entries()).map(([category, items]) =>
      el("div", { key: category, className: "concept-map__group" }, [
        el("h4", { className: "concept-map__group-label" }, [CATEGORY_LABELS[category]]),
        el("div", { className: "concept-map__nodes" }, [
          ...items.map((concept) => {
            const status = getNodeStatus(concept);
            return el(
              "div",
              {
                key: concept.conceptId,
                className: `concept-map__node concept-map__node--${status}`,
                title: `${concept.label} — ${status} (${concept.attempts} attempts)`,
              },
              [concept.label]
            );
          }),
        ]),
      ])
    ),
  ]);
}
