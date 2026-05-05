import { createElement } from "../../../../node_modules/react/index.js";
import type { LearningProgress } from "../../../learning/types.js";

interface ProgressTrackerProps {
  progress: LearningProgress;
}

export function ProgressTracker({ progress }: ProgressTrackerProps) {
  const totalConcepts = progress.concepts.length;
  const masteredConcepts = progress.concepts.filter((c) => c.mastered).length;
  const percentage = totalConcepts > 0 ? Math.round((masteredConcepts / totalConcepts) * 100) : 0;
  const accuracy = progress.totalQuestions > 0
    ? Math.round((progress.correctAnswers / progress.totalQuestions) * 100)
    : 0;

  return createElement(
    "div",
    { className: "progress-tracker" },
    createElement(
      "div",
      { className: "progress-tracker__header" },
      createElement("h3", null, "Learning Progress"),
      createElement(
        "span",
        { className: "progress-tracker__count" },
        `${masteredConcepts} / ${totalConcepts} concepts mastered`,
      ),
    ),
    createElement(
      "div",
      { className: "progress-tracker__bar" },
      createElement("div", {
        className: "progress-tracker__bar-fill",
        style: { width: `${percentage}%` },
      }),
    ),
    createElement(
      "div",
      { className: "progress-tracker__stats" },
      createElement("span", null, `Accuracy: ${accuracy}%`),
      createElement("span", null, `Questions answered: ${progress.totalQuestions}`),
    ),
  );
}
