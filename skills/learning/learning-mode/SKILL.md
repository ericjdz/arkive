---
name: learning-mode
description: Socratic quizzing after architecture updates. Optional — activates when user opts in.
trigger: User runs `arkive learn`, or says "enable learning mode", or `.arkive/learning-progress.json` exists.
---

# Learning Mode (Optional)

## Activation

Learning Mode is **opt-in**. It activates when:
- User runs `npx @ericjdz/arkive learn` (opens viewer with quiz interface)
- User says "enable learning mode" in conversation
- `.arkive/learning-progress.json` exists in the project root

## Behavior (when active)

After every architecture update (any change to `architecture.json`), you MUST:

1. **Identify what changed**: What services, decisions, connections, or data flows were added or modified?

2. **Generate ONE comprehension question**: Use the templates in `references/question-templates.md`. Priority order:
   - Questions about NEW decisions (highest — user just accepted an AI decision)
   - Questions about modified data flows
   - Questions about new service dependencies
   - Questions about connection protocols

3. **Wait for the user's answer**: Do NOT proceed with the next task until the user answers.

4. **Evaluate**:
   - Correct: Acknowledge, explain briefly why, proceed
   - Incorrect: Explain the correct answer with context from the decision rationale. Ask if they want to try another question or move on.

5. **Track progress**: If `.arkive/learning-progress.json` exists, update it with the result.

## Progress Check

Before generating a question, check `.arkive/learning-progress.json`:
- If user has mastered the relevant concept, skip the question
- Report: "You've demonstrated understanding of X/Y concepts"

## Disabling

User can disable Learning Mode by:
- Saying "disable learning mode"
- Deleting `.arkive/learning-progress.json`
- Running `arkive serve` (without `learn`)

## MUST NOT

- Do NOT activate Learning Mode unless user has explicitly opted in
- Do NOT block the user's workflow if they want to skip a question
- Do NOT ask questions about concepts already mastered
