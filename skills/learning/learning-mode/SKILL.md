# Learning Mode

## When This Skill Activates

This skill activates when the user has toggled Learning Mode on (via `archlearn learn` or the web viewer toggle). Check for the presence of `.archlearn/learning-progress.json` in the project root — if it exists, Learning Mode is active.

## Behavior

After every architecture update (any change to `architecture.json`), you MUST:

1. **Identify what changed**: Compare the update to the previous state. What services, decisions, connections, or data flows were added or modified?

2. **Generate a comprehension question**: Based on the change, ask the user ONE question that tests whether they understand the architectural decision or structure. Use the question templates in `references/question-templates.md`.

3. **Wait for the user's answer**: Do NOT proceed with the next task until the user answers.

4. **Evaluate the answer**: 
   - If correct: Acknowledge, explain briefly why it's right, mark the concept as mastered in `.archlearn/learning-progress.json`, and proceed.
   - If incorrect: Explain the correct answer with context from the decision rationale or data flow steps. Ask if they'd like to try another question on the same concept or move on.

5. **Update progress**: Write the result to `.archlearn/learning-progress.json`.

## Question Selection Priority

1. Questions about NEW decisions (highest priority — the user just accepted an AI decision)
2. Questions about modified data flows
3. Questions about new service dependencies
4. Questions about connection protocols

## Progress Check

Before generating a question, check `.archlearn/learning-progress.json`:
- If the user has already mastered the relevant concept, skip the question
- Report progress: "You've demonstrated understanding of X/Y concepts"

## Example Interaction

```
Agent: I've updated the architecture to use Redis for session caching.

📝 Learning Mode Question:
Why is Redis a better choice for session caching than PostgreSQL in this architecture?

A) Redis stores data in-memory for sub-millisecond reads
B) Redis is a relational database
C) PostgreSQL doesn't support key-value storage
D) Redis is the only database that supports TTL

User: A

✅ Correct! Redis's in-memory storage model makes it ideal for session data
that needs fast reads and can tolerate data loss on restart.

Progress: 8/14 concepts mastered
```

## Disabling Learning Mode

The user can disable Learning Mode at any time by:
- Running `archlearn serve` (without `learn`)
- Deleting `.archlearn/learning-progress.json`
- Saying "disable learning mode" in conversation
