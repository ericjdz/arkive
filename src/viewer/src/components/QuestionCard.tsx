/* @jsxRuntime classic */
import React, { useState } from "../../../../node_modules/react/index.js";
import type {
  Question,
  MultipleChoiceQuestion,
  OrderingQuestion,
  ShortAnswerQuestion,
} from "../../../learning/types.js";

interface QuestionCardProps {
  question: Question;
  onAnswer: (correct: boolean) => void;
}

function MultipleChoiceCard({
  question,
  onAnswer,
}: {
  question: MultipleChoiceQuestion;
  onAnswer: (correct: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    if (!selectedId) return;
    const choice = question.choices.find((c) => c.id === selectedId);
    onAnswer(choice?.correct ?? false);
    setSubmitted(true);
  };

  const selectedChoice = question.choices.find((c) => c.id === selectedId);

  return (
    <div className="question-card question-card--mc">
      <h3 className="question-card__question">{question.question}</h3>
      {!submitted && (
        <div className="question-card__choices">
          {question.choices.map((choice) => (
            <label key={choice.id} className="question-card__choice">
              <input
                type="radio"
                name={question.id}
                value={choice.id}
                checked={selectedId === choice.id}
                onChange={() => setSelectedId(choice.id)}
                disabled={submitted}
              />
              {choice.text}
            </label>
          ))}
        </div>
      )}
      {!submitted && (
        <button
          className="question-card__submit"
          onClick={handleSubmit}
          disabled={!selectedId}
        >
          Submit
        </button>
      )}
      {submitted && (
        <div className="question-card__explanation">
          <strong>
            {selectedChoice?.correct ? "✅ Correct!" : "❌ Incorrect"}
          </strong>
          <p>{question.explanation}</p>
        </div>
      )}
    </div>
  );
}

function OrderingCard({
  question,
  onAnswer,
}: {
  question: OrderingQuestion;
  onAnswer: (correct: boolean) => void;
}) {
  const [items, setItems] = useState([...question.items]);
  const [submitted, setSubmitted] = useState(false);

  const moveItem = (index: number, direction: "up" | "down") => {
    if (submitted) return;
    const newItems = [...items];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newItems.length) return;
    [newItems[index], newItems[swapIndex]] = [newItems[swapIndex], newItems[index]];
    setItems(newItems);
  };

  const handleSubmit = () => {
    const userOrder = items.map((item) => item.id);
    const correct = JSON.stringify(userOrder) === JSON.stringify(question.correctOrder);
    onAnswer(correct);
    setSubmitted(true);
  };

  return (
    <div className="question-card question-card--ordering">
      <h3 className="question-card__question">{question.question}</h3>
      <ol className="question-card__items">
        {items.map((item, index) => (
          <li key={item.id} className="question-card__item">
            <span>{item.text}</span>
            <span className="question-card__item-controls">
              <button onClick={() => moveItem(index, "up")} disabled={index === 0 || submitted}>↑</button>
              <button onClick={() => moveItem(index, "down")} disabled={index === items.length - 1 || submitted}>↓</button>
            </span>
          </li>
        ))}
      </ol>
      {!submitted && (
        <button className="question-card__submit" onClick={handleSubmit}>Submit</button>
      )}
      {submitted && (
        <div className="question-card__explanation">
          <p>{question.explanation}</p>
        </div>
      )}
    </div>
  );
}

function ShortAnswerCard({
  question,
  onAnswer,
}: {
  question: ShortAnswerQuestion;
  onAnswer: (correct: boolean) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    const normalized = answer.trim().toLowerCase();
    const correct = question.acceptableAnswers.some(
      (a) => a.toLowerCase() === normalized
    );
    onAnswer(correct);
    setSubmitted(true);
  };

  return (
    <div className="question-card question-card--short-answer">
      <h3 className="question-card__question">{question.question}</h3>
      <input
        type="text"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        disabled={submitted}
        placeholder="Type your answer..."
        className="question-card__input"
      />
      {!submitted && (
        <button className="question-card__submit" onClick={handleSubmit} disabled={!answer.trim()}>
          Submit
        </button>
      )}
      {submitted && (
        <div className="question-card__explanation">
          <p>{question.explanation}</p>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
  switch (question.type) {
    case "multiple-choice":
      return <MultipleChoiceCard question={question} onAnswer={onAnswer} />;
    case "ordering":
      return <OrderingCard question={question} onAnswer={onAnswer} />;
    case "short-answer":
      return <ShortAnswerCard question={question} onAnswer={onAnswer} />;
  }
}
