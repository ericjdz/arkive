# arkive/architecture.json Schema Guide

## Top-Level Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | string | Yes | Schema version, currently "1.0.0" |
| `project` | object | Yes | Project metadata |
| `stack` | object | Yes | Technology stack summary |
| `services` | array | Yes | All services/components in the system |
| `connections` | array | Yes | How services communicate |
| `decisions` | array | Yes | Architectural decisions with rationale |
| `dataFlows` | array | Yes | Important user-facing data flows |
| `history` | array | Yes | Chronological change log |

## Service Types

`frontend` | `backend` | `database` | `cache` | `queue` | `gateway` | `cdn` | `storage` | `auth` | `search` | `monitoring` | `other`

## Validation Rules

1. Every `connection.from` and `connection.to` must reference an existing `service.id`
2. Every `service.dependencies[]` entry must reference an existing `service.id`
3. `project.name` must be non-empty
4. `decision.alternatives` should include at least one rejected alternative
5. `dataFlow.steps` must have at least one step
6. All timestamps must be ISO 8601 format

## Stack Categories

| Category | Examples |
|---|---|
| `language` | TypeScript, Python, Go, Rust |
| `runtime` | Node.js, Bun, Deno, Browser |
| `framework` | Next.js, Express, Django, FastAPI |
| `database` | PostgreSQL, MongoDB, Redis, SQLite |
| `infrastructure` | Vercel, AWS, Docker, Cloudflare |
