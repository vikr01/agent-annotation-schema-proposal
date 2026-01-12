# Agent Annotation Schema Proposal

A proposal for structured annotations in code comments that agents can query without scanning entire files.

## Problem

Agents need dense, structured metadata about code that humans find noisy. Current solutions like `CLAUDE.md` or `AGENTS.md` are file-level, not expression-level. Every time an agent touches a file, it lacks fine-grained context about specific lines, props, hooks, etc.

## Solution

XML-like annotations embedded in code comments, queryable via CSS selector-like syntax with Prolog-style unification for dynamic values.

## Design Influences

| Source | What we borrow |
|--------|----------------|
| XML/HTML | Tag and attribute structure |
| JSX | Curly braces `{}` for expression context |
| [CSS Selectors](https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model/Locating_DOM_elements_using_selectors) | Query by tag, id, attribute—fast because browsers optimize selector matching |
| Prolog | Unification variables, pattern matching |
| Shell/Perl | Positional arguments (`$1`, `$2`, ...) |

## Syntax

| Element | Description |
|---------|-------------|
| `<tag attr="value">` | Annotation wrapping code |
| `<@>` | Self-reference—attach attributes to code that already declares its type |
| `$N` | Nth argument of annotated call (1-indexed) |
| `$N.path` | Property access into argument |
| `$0` | Return value of annotated call |
| `{expr}` | Expression with unification, evaluated at query time |
| `-list` suffix | Container convention (e.g., `<prop-list>`, `<omission-list>`) |

### Self-referencing with `<@>`

When code already declares its type (e.g., `interface`, `function`), use `<@>` to attach attributes without redundancy:

```ts
// <@ visibility="public">
interface AQL { ... }
// </@>
```

### Positional bindings with `$N`

Reference arguments from annotated code:

```ts
// <react-hook
//   preload={queryClient.prefetchQuery($1)}
// >
const { data } = useSuspenseQuery({ queryKey: ['todos', props.userId], ... });
// </react-hook>
```

`$1` resolves to `{ queryKey: ['todos', props.userId], ... }` from the actual code.

## Files

- [`schema/spec/aql.ts`](./schema/spec/aql.ts) — Agent Query Language interface
- [`schema/examples/TodoList.tsx`](./schema/examples/TodoList.tsx) — Annotated React component

## Query API

### `aql.select(selector)` — CSS-like selection

```ts
// Find all suspending hooks
aql.select('react-hook[suspends="true"]')
// → [<react-hook suspends="true" ...>...</react-hook>]

// Find all omitted props
aql.select('omission')
// → [<omission reason="fetched from API">'items'</omission>,
//    <omission reason="computed from fetch state">'isLoading'</omission>]

// Find performance-critical code owned by platform team
aql.select('perf-critical[owner="@platform"]')
// → [<perf-critical owner="@platform" audience="infra" visibility="internal">
//    const sorted = sortByCompletedDate(data);
//    </perf-critical>]
```

### `node.closest(selector)` — Ancestor traversal

```ts
const node = aql.select('perf-critical[owner="@platform"]')[0]

node.closest('branch')
// → <branch condition={props.filter === 'completed'}>if (props.filter === 'completed') { ... }</branch>

node.closest('component')
// → <component id="TodoList">export function TodoList(props: TodoListProps) { ... }</component>

node.ancestors()
// → ['perf-critical', 'branch', 'component']

node.closest('[audience]')
// → <perf-critical owner="@platform" audience="infra" visibility="internal">...</perf-critical>

node.closest('branch')?.attr('condition')
// → 'props.filter === "completed"'
```

### `node.selectWithin(selector)` — Descendant traversal

```ts
const component = aql.select('component')[0]

component.selectWithin('react-hook')
// → [<react-hook suspends="true" ...>const { data } = useSuspenseQuery({ ... });</react-hook>]

component.selectWithin('render')
// → [<render>return (<TodoListView ... />);</render>, <render>return (<TodoListView ... />);</render>]

component.selectWithin('branch > render')
// → [<render>return (<TodoListView ... />);</render>]  // only render inside branch
```

### `node.next(selector?)` — Sibling traversal

```ts
const hook = aql.select('react-hook')[0]

hook.next()
// → <branch condition={props.filter === 'completed'}>...</branch>

hook.next('render')
// → <render>return (<TodoListView ... />);</render>
```

### `node.resolve(attr)` — Prolog-style binding resolution

```ts
const hook = aql.select('react-hook[preload]')[0]

hook.attr('preload')
// → 'queryClient.prefetchQuery($1)'  // raw template

hook.resolve('preload')
// → 'queryClient.prefetchQuery({ queryKey: ["todos", props.userId], queryFn: () => fetchTodos(props.userId) })'

hook.binding('$1')
// → '{ queryKey: ["todos", props.userId], queryFn: () => fetchTodos(props.userId) }'

hook.binding('$1.queryKey')
// → '["todos", props.userId]'
```

## Built-in Attributes

| Attribute | Purpose |
|-----------|---------|
| `id` | Unique identifier for the node |
| `visibility` | API stability: `public` (stable) or `internal` (may change) |
| `audience` | Who this is relevant to: `product`, `infra`, etc. |
| `owner` | Team/person responsible (e.g., `@platform`) |
| `note` | Human-readable explanation |

## Status

**Early exploration** — still figuring out if this idea has legs.
