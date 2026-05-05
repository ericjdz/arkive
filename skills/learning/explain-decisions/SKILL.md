---
name: explain-decisions
description: Answer "why" questions about architectural choices using architecture.json.
trigger: User asks "why did we choose X?", "why this database?", "why not use Y?", "explain the architecture", or clicks "Why this?" in the web viewer.
---

# Explain Decisions

## Behavior

1. **Read architecture data**:
   - Via MCP: read `architecture://decisions` resource
   - Via file: read `decisions` array from `architecture.json`

2. **Find the relevant decision**: Search by `topic`, `decision`, or `relatedServices` matching the user's question.

3. **Explain with this structure**:

```
## {topic}

**Decision:** {decision}

**Why:** {rationale}

**Alternatives considered:**
- **{alternative.name}**: Rejected because {alternative.whyNot}

**Related services:** {relatedServices}
```

4. **If no matching decision exists**:
   - Check services, connections, and stack for relevant context
   - Explain what's available
   - Suggest recording a formal decision:
     - Via MCP: "I can call `record_decision` to document this choice"
     - Via file: "I can add a decision entry to `architecture.json`"

5. **Connect to the bigger picture**: After explaining, briefly mention how this decision relates to other architectural choices in the project.

## MUST NOT

- Do NOT fabricate rationale that isn't in architecture.json
- Do NOT guess at alternatives that weren't recorded
