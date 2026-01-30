# Agent Annotation Schema

Structured annotations that agents can query without scanning entire files

`CLAUDE.md` gives agents project-level context; this gives expression-level context that source code can't express

Coding agents ([`claude`](https://claude.ai/code), [`codex`](https://openai.com/index/introducing-codex/), [`opencode`](https://opencode.ai), [`cursor`](https://cursor.com), [`windsurf`](https://windsurf.com), [`copilot`](https://code.visualstudio.com/docs/copilot/overview)) read source into a finite context window (64K-200K tokens); no structured metadata layer to query

## Contents

- [Before and After](#before-and-after)
- [How It Works](#how-it-works)
- [Beyond Bigger Context Windows](#beyond-bigger-context-windows)
- [Documentation](#documentation)
- [References](#references)

## Before and After

Task: *"Add rate limiting to `createUser`"*

| | Today | With Annotations |
|:--|:--|:--|
| **→ Agent runs** | `cat src/userController.ts`<br>`cat src/userService.ts`<br>`cat src/userMiddleware.ts`<br>`rg "createUser"` (34 matches)<br>`cat src/authHelpers.ts`<br>`cat src/rateLimiter.ts`<br>`cat src/apiRouter.ts` | `mcp__aql__select 'controller[name="createUser"]'` |
| **← Response** | ~4,200 tokens of raw source across 7 files | `createUser` endpoint metadata:<br>`owner: @backend`<br>`response-time: 200ms`<br>`path: POST /api/users`<br>`auth: required`<br>`visibility: public` |
| **Outcome** | Agent edits without knowing `createUser` endpoint ownership, response time target, or auth requirements | Agent edits with full context |

Agents can read code, not metadata: endpoint ownership, performance targets, deprecation status

That knowledge lives in developers' heads, rediscovered every time

## How It Works

- `.ann.yaml` sidecar file next to source
  - CSS-like selectors point at code elements
  - Structured metadata attaches to those elements
  - Captures what source code can't express: ownership, performance contracts, cache recipes, deprecation intent
  - If derivable from reading source (concurrency patterns, type signatures, return types), doesn't belong in an annotation
- Agent queries via MCP, no source scanning
  - Same selectors across all languages
    - `function[name="create"]`
      - Go: `func create()`
      - TypeScript: `function create()`
      - Python: `def create()`
- `.annotations/schema.yaml` [manifest](./docs/decisions.md) at project root defines available tags
  - Agent reads once, knows what to query

**Source:**

```tsx
// TodoList.tsx
export function TodoList({ userId, filter }: TodoListProps): React.ReactNode {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchTodos(userId).then((data) => {
      setTodos(data);
      setIsLoading(false);
    });
  }, [userId]);

  if (filter === "completed") {
    const sorted = sortByCompletedDate(todos);
    return <TodoListView items={sorted} isLoading={false} />;
  }

  return <TodoListView items={todos} isLoading={isLoading} />;
}
```

**Annotation:**

```yaml
# TodoList.tsx.ann.yaml
annotations:
  - select: 'function[name="TodoList"]'
    tag: component
    attrs:
      id: TodoList
      owner: "@frontend"
      visibility: public
    children:
      - select: 'call[name="useEffect"]'
        tag: react-hook
        attrs:
          error-handling: "silent, no error state"
          note: "Refetches on userId change"
```

**Query and result:**

```sh
$ mcp__aql__select 'react-hook[error-handling]'
```

```json
[
  {
    "tag": "react-hook",
    "codeSelector": "call[name=\"useEffect\"]",
    "file": "TodoList.tsx",
    "attrs": {
      "error-handling": "silent, no error state",
      "note": "Refetches on userId change"
    }
  }
]
```

```sh
# same query across Go, TS, Python
$ mcp__aql__select 'controller[method="POST"]'

# platform team ownership
$ mcp__aql__select '[owner="@platform"]'
```

## Beyond Bigger Context Windows

- Bigger context windows won't make this unnecessary, same as a faster database not eliminating the need for indexes
  - Full table scan vs indexed query: not about hardware speed, about declaring what you need
  - `SELECT owner, response_time FROM endpoints WHERE name = 'createUser'` won't become unnecessary because the database can read every row faster
- People work the same way
  - Nobody reads an entire codebase to answer "who owns this endpoint?"
  - They skim, ⌘F, ask someone who knows
- Both improve in parallel: smarter models *and* structured metadata
  - Faster engines *and* better indexes

## Documentation

**[Full documentation →](./docs/)**

| Document | Description |
|----------|-------------|
| [RFC](./text/0001-agent-annotation-schema.md) | Full specification: selectors, code elements, annotation format, schema manifests, AQL |
| [Walkthrough](./docs/walkthrough.md) | Applied to Grafana's Go + TypeScript codebase |
| [Decision Log](./docs/decisions.md) | What we chose, what we ruled out, why |
| [Examples](./examples/) | Source files (Go, TS, Python) with `.ann.yaml` sidecars |

## Status

| Component | Description | Status |
|-----------|-------------|--------|
| Proposal | This document | Drafting |
| Specification | [RFC](./text/0001-agent-annotation-schema.md) | Drafting |
| Core query language | Selector parsing, annotation matching, code element model | Sketched (type interfaces) |
| Resolvers | Plugin-based parsing into universal elements (code, natural language, others) | Planned |
| Annotation store | `.ann.yaml` sidecar reading, schema manifest validation | Planned |
| MCP server | Exposes query language as MCP tools | Planned |
| Mutations | Transactional read/write for annotation files | Planned |

---

## References

1. **^** Anthropic, ["Best Practices for Claude Code"](https://code.claude.com/docs/en/best-practices), *Claude Code Documentation*
2. **^** OpenAI, ["Introducing Codex"](https://openai.com/index/introducing-codex/), *OpenAI Blog*; see also [Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide), [GPT-5.2-Codex](https://openai.com/index/introducing-gpt-5-2-codex/)
3. **^** rekram1-node, [Issue #3184](https://github.com/sst/opencode/issues/3184), *OpenCode, GitHub*
4. **^** Cursor, ["Codebase Indexing"](https://cursor.com/docs/context/codebase-indexing), *Cursor Documentation*
5. **^** Windsurf, ["Context Awareness"](https://docs.windsurf.com/context-awareness/windsurf-overview), *Windsurf Documentation*
6. **^** Microsoft, ["Make chat an expert in your workspace"](https://code.visualstudio.com/docs/copilot/reference/workspace-context), *VS Code Documentation*
7. **^** xAI, ["Grok Code Fast 1"](https://x.ai/news/grok-code-fast-1), *xAI News*
