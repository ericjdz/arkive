// --- Source references: link questions back to architecture.json data ---

export type DecisionSourceRef = { type: "decision"; id: string };
export type ServiceSourceRef = { type: "service"; id: string };
export type ConnectionSourceRef = { type: "connection"; from: string; to: string };
export type DataFlowSourceRef = { type: "dataFlow"; name: string };

export type SourceRef =
  | DecisionSourceRef
  | ServiceSourceRef
  | ConnectionSourceRef
  | DataFlowSourceRef;

// --- Question types ---

export type QuestionCategory = "decision" | "topology" | "data-flow" | "connection" | "stack";

interface BaseQuestion {
  id: string;
  type: string;
  category: QuestionCategory;
  conceptId: string;
  question: string;
  explanation: string;
  sourceRef: SourceRef;
}

export interface Choice {
  id: string;
  text: string;
  correct: boolean;
}

export interface MultipleChoiceQuestion extends BaseQuestion {
  type: "multiple-choice";
  choices: Choice[];
}

export interface ShortAnswerQuestion extends BaseQuestion {
  type: "short-answer";
  acceptableAnswers: string[];
}

export interface OrderingItem {
  id: string;
  text: string;
}

export interface OrderingQuestion extends BaseQuestion {
  type: "ordering";
  items: OrderingItem[];
  correctOrder: string[];
}

export type Question = MultipleChoiceQuestion | ShortAnswerQuestion | OrderingQuestion;

// --- Type guards ---

export function isMultipleChoiceQuestion(q: Question): q is MultipleChoiceQuestion {
  return q.type === "multiple-choice";
}

export function isShortAnswerQuestion(q: Question): q is ShortAnswerQuestion {
  return q.type === "short-answer";
}

export function isOrderingQuestion(q: Question): q is OrderingQuestion {
  return q.type === "ordering";
}

// --- Concept tracking ---

export interface ConceptMastery {
  conceptId: string;
  label: string;
  category: QuestionCategory;
  mastered: boolean;
  attempts: number;
  lastAttemptAt: string;
}

export interface LearningProgress {
  projectName: string;
  startedAt: string;
  lastActivityAt: string;
  concepts: ConceptMastery[];
  totalQuestions: number;
  correctAnswers: number;
}
