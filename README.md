# Agent Annotation Schema

Structured annotations that agents can query without scanning entire files

## Problem

Agents can read code but not metadata: who owns this endpoint, what's the response time target, is it deprecated

- `CLAUDE.md` <sup>[[1]](#references)</sup> is project-level; nothing exists at the function/hook/handler level
- That knowledge is in developers' heads, rediscovered every PR

## Solution

- `.aql` XML sidecar file next to each source file
- [CSS-like selectors](https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model/Locating_DOM_elements_using_selectors) for querying, binding keys for anchoring
- Agents query via [MCP](https://modelcontextprotocol.io/introduction), no source scanning
- [Schema manifest](./SPEC.md#schema-manifest) at project root: agent reads once, knows every available tag

## Design Influences

| Source | What we borrow |
|--------|----------------|
| [CSS Selectors](https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model/Locating_DOM_elements_using_selectors) | Query syntax: `tag[attr="value"]`, combinators |
| XML | Annotation format: streaming-parseable, tree-native, attribute-native |
| Prolog <sup>[[2]](#references)</sup> | Unification variables (`$N`), pattern matching for expression attributes |

Same selectors across all languages:
- `function[name="create"]`
  - Go: `func create()`
  - TypeScript: `function create()`
  - Python: `def create()`

## Example

A React component, its sidecar annotation, and a query:

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

```xml
<!-- TodoList.aql -->
<component bind="TodoList" id="TodoList" owner="@frontend" visibility="public">
  <react-hook bind="useEffect"
              error-handling="silent, no error state"
              note="Refetches on userId change" />
</component>
```

**Query:**

```typescript
aql.select('react-hook[error-handling]')
// → [{ tag: "react-hook", file: "TodoList.tsx",
//      attrs: { error-handling: "silent, no error state", note: "Refetches on userId change" } }]

aql.select('component[owner="@frontend"]')
// → [{ tag: "component", file: "TodoList.tsx",
//      attrs: { id: "TodoList", owner: "@frontend", visibility: "public" } }]
```

## Cross-Boundary Flow Tracing

The strongest use case: trace a flow from React through HTTP into Go without reading source

```typescript
// backend: who handles POST /api/dashboards/db?
aql.select('controller[method="POST"]')
// → [{ attrs: { path: "/api/dashboards/db", owner: "@grafana/dashboards-squad" },
//      file: "pkg/api/dashboard.go" }]

// frontend: what calls that endpoint?
aql.select('api-client[endpoint="/api/dashboards/db"]')
// → [{ attrs: { method: "POST" },
//      file: "public/app/features/dashboard/components/SaveDashboard/useDashboardSave.tsx" }]

// auth: what middleware guards it?
aql.select('middleware[scope*="dashboards:write"]')
// → [{ attrs: { name: "authorization", scope: "dashboards:write" },
//      file: "pkg/api/api.go" }]
```

Three queries, three languages worth of code, zero source scanning. See the [Grafana walkthrough](./WALKTHROUGH.md) for the full example.

## More Queries

```typescript
// everything one team owns, across Go + TypeScript
aql.select('[owner="@grafana/dashboards-squad"]')

// all perf-critical code with SLAs
aql.select('perf-critical[sla]')
// → [{ attrs: { sla: "200ms p99", traced: true }, code: getDashboardHelper }]

// traverse: find the component wrapping a perf-critical node
const node = aql.select('perf-critical')[0]
node.closest('component')       // enclosing component
node.selectWithin('api-client')  // nested API clients
node.resolve('preload')          // substitutes $N with actual code args

// catch annotation drift
aql.validate()
// → [{ level: "error", file: "Foo.aql", message: "Unknown tag 'controllr'" }]

aql.repair()
// → [{ selector: 'function[name="oldName"]', suggestion: 'function[name="newName"]', confidence: 0.95 }]
```

## Documentation

| Document | Description |
|----------|-------------|
| [RFC](./SPEC.md) | Full specification: selectors, code elements, annotation format, schema manifests, AQL |
| [Walkthrough](./WALKTHROUGH.md) | Applied to Grafana's Go + TypeScript codebase |
| [Decision Log](./DECISIONS.md) | What we chose, what we ruled out, why |

## Status

| Component | Description | Status |
|-----------|-------------|--------|
| Specification | [RFC](./SPEC.md) | Published |
| Core query language | Selector parsing, annotation matching, code element model | Implemented ([aql-engine](https://github.com/vikr01/aql)) |
| Resolvers | Plugin-based parsing into universal elements (code, natural language, others) | Implemented (Rust via tree-sitter) |
| Annotation store | `.aql` sidecar reading, schema manifest validation | Implemented ([aql-engine](https://github.com/vikr01/aql)) |
| MCP server | Exposes query language as 5 MCP tools | Implemented ([aql-mcp-server](https://github.com/vikr01/aql)) |
| Web REPL | Browser-based playground for queries | Implemented ([aql-repl](https://github.com/vikr01/aql)) |
| Schema presets | Community-contributed tag presets (`@aql/preset-*`) | Specified |
| Extractors | Runtime route extraction for Express, Django, etc. | Implemented ([aql-engine](https://github.com/vikr01/aql)) |
| Plugins | Language-agnostic subprocess protocol for resolvers, extractors, and search | Specified |
| Mutations | Transactional read/write for annotation files | Planned |

---

## References

1. **^** Anthropic, ["Best Practices for Claude Code"](https://code.claude.com/docs/en/best-practices), *Claude Code Documentation*
2. **^** Clocksin & Mellish, *Programming in Prolog*, Springer, 5th ed. (2003)
3. **^** OpenAI, ["Introducing Codex"](https://openai.com/index/introducing-codex/), *OpenAI Blog*; see also [Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide), [GPT-5.2-Codex](https://openai.com/index/introducing-gpt-5-2-codex/)
4. **^** rekram1-node, [Issue #3184](https://github.com/sst/opencode/issues/3184), *OpenCode, GitHub*
5. **^** Cursor, ["Codebase Indexing"](https://cursor.com/docs/context/codebase-indexing), *Cursor Documentation*
6. **^** Windsurf, ["Context Awareness"](https://docs.windsurf.com/context-awareness/windsurf-overview), *Windsurf Documentation*
7. **^** Microsoft, ["Make chat an expert in your workspace"](https://code.visualstudio.com/docs/copilot/reference/workspace-context), *VS Code Documentation*
8. **^** xAI, ["Grok Code Fast 1"](https://x.ai/news/grok-code-fast-1), *xAI News*
