import type { Architecture, Decision, Service, Connection, DataFlow } from "../schema/types.js";
import type {
  Question,
  MultipleChoiceQuestion,
  ShortAnswerQuestion,
  OrderingQuestion,
  Choice,
} from "./types.js";

let questionCounter = 0;
function nextId(): string {
  questionCounter += 1;
  return `q-${String(questionCounter).padStart(3, "0")}`;
}

export function resetQuestionCounter(): void {
  questionCounter = 0;
}

export function generateDecisionQuestions(arch: Architecture): MultipleChoiceQuestion[] {
  return arch.decisions.map((dec) => {
    const correctChoice: Choice = {
      id: "correct",
      text: dec.rationale,
      correct: true,
    };

    const wrongChoices: Choice[] = dec.alternatives.map((alt, i) => ({
      id: `wrong-${i}`,
      text: alt.whyNot,
      correct: false,
    }));

    if (wrongChoices.length < 2) {
      wrongChoices.push({
        id: `wrong-generic`,
        text: "It was the only option available.",
        correct: false,
      });
    }

    const choices = [...wrongChoices];
    const insertIndex = dec.id.charCodeAt(dec.id.length - 1) % (choices.length + 1);
    choices.splice(insertIndex, 0, correctChoice);

    return {
      id: nextId(),
      type: "multiple-choice" as const,
      category: "decision" as const,
      conceptId: `concept-${dec.id}`,
      question: `Why did this project choose "${dec.decision}"?`,
      choices,
      explanation: dec.rationale,
      sourceRef: { type: "decision" as const, id: dec.id },
    };
  });
}

export function generateTopologyQuestions(arch: Architecture): MultipleChoiceQuestion[] {
  const questions: MultipleChoiceQuestion[] = [];

  for (const service of arch.services) {
    const dependents = arch.services.filter((s) => s.dependencies.includes(service.id));
    if (dependents.length === 0) continue;

    const correctNames = dependents.map((d) => d.name);
    const correctChoice: Choice = {
      id: "correct",
      text: correctNames.join(", "),
      correct: true,
    };

    const nonDependents = arch.services.filter(
      (s) => s.id !== service.id && !s.dependencies.includes(service.id)
    );
    const wrongChoices: Choice[] = nonDependents.slice(0, 3).map((s, i) => ({
      id: `wrong-${i}`,
      text: s.name,
      correct: false,
    }));

    if (wrongChoices.length === 0) {
      wrongChoices.push({ id: "wrong-0", text: "No other services", correct: false });
    }

    const choices = [...wrongChoices];
    choices.splice(0, 0, correctChoice);

    questions.push({
      id: nextId(),
      type: "multiple-choice",
      category: "topology",
      conceptId: `concept-svc-${service.id}`,
      question: `Which services depend on ${service.name}?`,
      choices,
      explanation: `${correctNames.join(" and ")} depend on ${service.name}.`,
      sourceRef: { type: "service", id: service.id },
    });
  }

  return questions;
}

export function generateConnectionQuestions(arch: Architecture): MultipleChoiceQuestion[] {
  const allProtocols = [...new Set(arch.connections.map((c) => c.protocol))];

  return arch.connections.map((conn) => {
    const correctChoice: Choice = {
      id: "correct",
      text: conn.protocol,
      correct: true,
    };

    const wrongProtocols = allProtocols.filter((p) => p !== conn.protocol);
    const wrongChoices: Choice[] = wrongProtocols.slice(0, 3).map((p, i) => ({
      id: `wrong-${i}`,
      text: p,
      correct: false,
    }));

    const genericProtocols = ["gRPC", "GraphQL", "AMQP", "MQTT"];
    for (const gp of genericProtocols) {
      if (wrongChoices.length >= 3) break;
      if (gp !== conn.protocol && !wrongProtocols.includes(gp)) {
        wrongChoices.push({ id: `wrong-g${wrongChoices.length}`, text: gp, correct: false });
      }
    }

    const choices = [correctChoice, ...wrongChoices];

    return {
      id: nextId(),
      type: "multiple-choice" as const,
      category: "connection" as const,
      conceptId: `concept-conn-${conn.from}-${conn.to}`,
      question: `What protocol does the connection from ${conn.from} to ${conn.to} use?`,
      choices,
      explanation: `${conn.from} connects to ${conn.to} via ${conn.protocol}: ${conn.description}`,
      sourceRef: { type: "connection" as const, from: conn.from, to: conn.to },
    };
  });
}

export function generateDataFlowQuestions(arch: Architecture): OrderingQuestion[] {
  return arch.dataFlows.map((flow) => {
    const items = flow.steps.map((step, i) => ({
      id: `step-${i}`,
      text: `[${step.actor}] ${step.action}`,
    }));

    const correctOrder = items.map((item) => item.id);

    return {
      id: nextId(),
      type: "ordering" as const,
      category: "data-flow" as const,
      conceptId: `concept-flow-${flow.name.toLowerCase().replace(/\s+/g, "-")}`,
      question: `Arrange the steps for "${flow.name}":`,
      items,
      correctOrder,
      explanation: `The flow "${flow.name}" proceeds through ${flow.steps.length} steps from ${flow.steps[0].actor} to ${flow.steps[flow.steps.length - 1].actor}.`,
      sourceRef: { type: "dataFlow" as const, name: flow.name },
    };
  });
}

export function generateAllQuestions(arch: Architecture): Question[] {
  resetQuestionCounter();
  return [
    ...generateDecisionQuestions(arch),
    ...generateTopologyQuestions(arch),
    ...generateConnectionQuestions(arch),
    ...generateDataFlowQuestions(arch),
  ];
}
