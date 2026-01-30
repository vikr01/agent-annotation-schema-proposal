# Decision Log

[← Docs](./README.md) · [Home](../README.md)

---

Design decisions for the [Agent Annotation Schema](../text/0001-agent-annotation-schema.md), ordered latest to earliest

Each entry documents context, options considered, decision, and rationale

## Contents

- [9. Selector Drift: Validation + Repair vs Validation Only](#9-selector-drift-validation--repair-vs-validation-only)
- [8. Annotation Scope: Non-Derivable Metadata Only](#8-annotation-scope-non-derivable-metadata-only)
- [7. Tag Discovery: Schema Manifest vs Convention vs Scanning](#7-tag-discovery-schema-manifest-vs-convention-vs-scanning)
- [6. Language-Specific Constructs: Universal Tags + lang-hint vs Per-Language Tags](#6-language-specific-constructs-universal-tags--lang-hint-vs-per-language-tags)
- [5. Anchoring: Selectors vs Line Numbers vs Symbol Names](#5-anchoring-selectors-vs-line-numbers-vs-symbol-names)
- [4. Query Language: CSS Selectors vs SQL vs XPath vs GraphQL](#4-query-language-css-selectors-vs-sql-vs-xpath-vs-graphql)
- [3. YAML vs JSON vs Custom Format](#3-yaml-vs-json-vs-custom-format)
- [2. Sidecar Files vs Centralized Store](#2-sidecar-files-vs-centralized-store)
- [1. Inline Comments vs External Annotation Files](#1-inline-comments-vs-external-annotation-files)
- [References](#references)

---

## 9. Selector Drift: Validation + Repair vs Validation Only

**Context**: External annotations reference code via selectors like `function[name="HandleCreateUser"]`; when code is renamed, moved, or restructured, selectors break silently

**Options considered**:

| Option | Description |
|--------|-------------|
| Validation only | `aql.validate()` reports broken selectors; humans fix them |
| Validation + repair | `aql.repair()` detects renames and suggests selector updates |
| Automatic rewrite | Tool automatically updates selectors on every code change |

**Decision**: Validation + repair (`aql.validate()` + `aql.repair()`)

**Rationale**:
- Validation alone is insufficient
  - Catching drift and fixing drift are different problems
  - If the only tool is "here's a list of broken selectors," teams ignore the list until the annotation file is deleted
- Repair enables maintenance at scale
  - Function renamed from `PostDashboard` to `SaveDashboard` → repair detects structural similarity → suggests updating the selector
  - Turns a manual hunt into a one-click fix
- Not fully automatic
  - Major refactors that change structure (not just names) could produce incorrect automatic updates
  - Repair suggests with a confidence score; humans or agents approve

**What we ruled out**: Automatic rewrite is too aggressive for structural changes where the "correct" update is ambiguous; validation-only is too passive for real-world maintenance

See the [AQL specification](../text/0001-agent-annotation-schema.md#aql--agent-query-language) for the repair API

---

## 8. Annotation Scope: Non-Derivable Metadata Only

**Context**: The initial design annotated everything: async functions, suspension behavior, parameter types, HTTP methods; but agents can already derive most of this by reading source code; annotations that duplicate source-readable information create maintenance burden without adding value

**Options considered**:

| Option | Description |
|--------|-------------|
| Annotate everything | Include both derivable and non-derivable metadata for completeness |
| Non-derivable only | Only annotate metadata that cannot be inferred by reading source code |
| Hybrid with derivable flags | Include some derivable facts as convenience shortcuts |

**Decision**: Non-derivable metadata only

**Rationale**:
- Maintenance cost
  - Every annotation is a liability; it can drift from code
  - Annotations duplicating source information (e.g., `suspends: true` on a hook named `useSuspenseQuery`) double the maintenance burden for zero information gain
- Agent capabilities are improving
  - Large context windows and better code understanding mean agents get progressively better at deriving information from source
  - Annotations encoding derivable facts lose their value over time
- Smaller surface
  - Fewer annotations mean fewer files to maintain, fewer selectors that can drift, faster validation
- Clearer value signal
  - When every annotation carries information that genuinely can't be found in source, the schema is worth maintaining
  - When annotations mix derivable and non-derivable facts, signal-to-noise drops and teams stop maintaining them

See the RFC's [Scope Principle](../text/0001-agent-annotation-schema.md#scope-principle) for the canonical definition

**What we ruled out**: "Annotate everything" creates unsustainable maintenance burden; "hybrid with convenience flags" blurs the scope boundary and invites scope creep

---

## 7. Tag Discovery: Schema Manifest vs Convention vs Scanning

**Context**: When an agent encounters a project, how does it know what annotation tags are available to query?

**Options considered**:

| Option | Description |
|--------|-------------|
| Schema manifest | `.annotations/schema.yaml` at project root defines all tags |
| Convention-based | Tags follow naming patterns, agents infer from usage |
| File scanning | Agent reads all `.ann.yaml` files to discover tags |
| Hardcoded built-ins | Fixed set of tags known to all tools |

**Decision**: Explicit schema manifest at project root

**Rationale**:
- Single source of truth
  - One file defines every tag, its attributes, and their types
  - No ambiguity about what's available
- Zero scanning
  - Agent reads one file and knows every queryable tag and attribute in the project
  - Fastest possible discovery path
- Validation
  - Manifest enables tooling to validate that annotation files only use defined tags and that required attributes are present
- Self-documenting
  - Manifest serves as documentation for the project's annotation vocabulary
  - New contributors read it to understand what metadata exists

**What we ruled out**: Convention-based discovery is ambiguous; file scanning defeats the purpose of structured metadata (you still have to read everything); hardcoded built-ins are too rigid for diverse codebases

See the [Schema Manifest specification](../text/0001-agent-annotation-schema.md#schema-manifest) for details

---

## 6. Language-Specific Constructs: Universal Tags + lang-hint vs Per-Language Tags

**Context**: Programming languages have constructs that don't map cleanly across languages (Go's `defer`, Python's decorators, Rust's lifetimes, etc.)

**Options considered**:

| Option | Description |
|--------|-------------|
| Universal tags + `lang-hint` | One set of tags for all languages, with a `lang-hint` attribute for specifics |
| Per-language tag sets | `go-func`, `ts-function`, `py-def` |
| Universal tags only (no escape hatch) | Force everything into universal vocabulary |

**Decision**: Universal tags with a `lang-hint` attribute for language-specific constructs

**Rationale**:
- Cross-language queries
  - The primary goal is writing `function[name="create"]` and matching Go, TypeScript, and Python functions alike
  - Per-language tags defeat this entirely; you'd need `go-func OR ts-function OR py-def`
- Graceful specificity
  - When language-specific behavior matters, `lang-hint` provides an escape hatch
  - `call[lang-hint="defer"]` targets Go deferred calls specifically without polluting the universal vocabulary
- Manageable vocabulary
  - A finite set of universal tags (`function`, `class`, `method`, `field`, etc.) is learnable
  - Per-language tags multiply the vocabulary by the number of supported languages

**What we ruled out**: Per-language tags make cross-language queries impossible (the core value proposition); universal-only (no escape hatch) is too rigid for languages with genuinely unique constructs

See [Code Elements](../text/0001-agent-annotation-schema.md#code-elements) for the full universal vocabulary

---

## 5. Anchoring: Selectors vs Line Numbers vs Symbol Names

**Context**: External annotations must reference specific code locations; the anchoring mechanism determines how stable annotations are across code changes

**Options considered**:

| Option | Description |
|--------|-------------|
| Code element selectors | `function[name="HandleCreateUser",params=(w,r)]` |
| Line numbers | `line: 42` or `lines: 42-58` |
| Symbol names (plain) | `HandleCreateUser` |
| AST paths | `module.declarations[0].body.statements[2]` |

**Decision**: Code element selectors (CSS-like, same syntax as queries)

**Rationale**:
- Stability
  - Selectors match by semantic identity (`function[name="foo"]`), not position
  - Adding a line above doesn't break the anchor
  - Renaming the function is a clear, intentional change that *should* require updating the annotation
- Expressiveness
  - Plain symbol names can't distinguish overloaded functions, methods with the same name in different classes, or anonymous functions
  - Selectors can: `class[name="UserService"] > method[name="create",async]`
- Unified syntax
  - The selector used to anchor an annotation is the same syntax used to query code elements
  - One system, not two
- Language-agnostic
  - Selectors target universal code elements <sup>[[1]](#references)</sup>, not language-specific AST nodes
  - Same selector works whether the function is in Go, TypeScript, or Python

**What we ruled out**: Line numbers break on every edit (most fragile option); plain symbol names lack expressiveness to handle overloading, nesting, or disambiguation; AST paths (`module.declarations[0]`) are precise but break whenever code is reordered and require knowledge of the AST structure

---

## 4. Query Language: CSS Selectors vs SQL vs XPath vs GraphQL

**Context**: The system needs a query language for finding annotations and anchoring them to code; this is the most consequential design decision, determining how every agent, CI job, and developer interacts with annotations

### The SQL insight

The core idea, describe *what* data you want, not *how* to find it, comes from relational databases

E. F. Codd's 1970 paper established the principle: "Future users of large data banks must be protected from having to know how the data is organized in the machine" <sup>[[3]](#references)</sup>

Chamberlin and Boyce built SEQUEL (later SQL) on this foundation in 1974 <sup>[[4]](#references)</sup>, and Chamberlin later wrote: "the Sequel version of this query describes the information it is looking for but does not provide a detailed plan for how to find this information. This is why Sequel is called a declarative (rather than a procedural) language" <sup>[[5]](#references)</sup>

This is exactly the problem annotation queries solve: an agent shouldn't scan files to find who owns an endpoint; it should declare what it wants (`controller[method="POST"]`) and let the system find it

The SQL standard (ISO/IEC 9075, first published 1987, now in its 9th edition as SQL:2023 <sup>[[6]](#references)</sup>) has maintained this declarative model for nearly 40 years across every major database

The question is which declarative syntax best fits our data model: a *tree* of annotations attached to a *tree* of code elements

### Side-by-side comparison

The same five queries in each candidate language:

#### Query 1: Find all POST controllers

```sql
-- SQL
SELECT * FROM annotations WHERE tag = 'controller' AND attrs->>'method' = 'POST'
```
```xpath
(: XPath :)
//controller[@method='POST']
```
```graphql
# GraphQL
{ annotations(tag: "controller", method: "POST") { tag attrs file } }
```
```css
/* CSS Selectors (our choice) */
controller[method="POST"]
```

**Verdict**: All four work; CSS is the most concise; SQL requires understanding JSON column access (`attrs->>'method'`); XPath and GraphQL are fine

#### Query 2: Find hooks that need a Suspense boundary

```sql
-- SQL
SELECT * FROM annotations WHERE tag = 'react-hook' AND attrs->>'boundary' IS NOT NULL
```
```xpath
(: XPath :)
//react-hook[@boundary]
```
```graphql
# GraphQL
{ annotations(tag: "react-hook", hasAttr: "boundary") { tag attrs file } }
```
```css
/* CSS Selectors */
react-hook[boundary]
```

**Verdict**: CSS and XPath express "has attribute" natively (`[boundary]`); SQL needs `IS NOT NULL`; GraphQL would need a custom `hasAttr` filter

#### Query 3: Find async methods inside a class

```sql
-- SQL (requires recursive CTE or parent_id join)
SELECT a.* FROM annotations a
  JOIN code_elements c ON a.code_element_id = c.id
  JOIN code_elements parent ON c.parent_id = parent.id
  WHERE c.tag = 'method' AND c.async = true AND parent.tag = 'class'
```
```xpath
(: XPath :)
//class/method[@async='true']
```
```graphql
# GraphQL
{ codeElements(tag: "class") { children(tag: "method", async: true) { name annotations } } }
```
```css
/* CSS Selectors */
class > method[async]
```

**Verdict**: This is where tree-native languages pull ahead; CSS and XPath express parent-child relationships in a single line; SQL requires joins against a parent ID (it wasn't designed for trees); GraphQL handles nesting naturally but is verbose

#### Query 4: Find frontend code calling a backend endpoint where auth is required

```sql
-- SQL (join across annotation types)
SELECT client.* FROM annotations client
  JOIN annotations handler
    ON client.attrs->>'endpoint' = handler.attrs->>'path'
  WHERE client.tag = 'api-client'
    AND handler.tag = 'controller'
    AND handler.attrs->>'auth' = 'required'
```
```xpath
(: XPath — cannot express cross-document joins :)
(: Not possible in a single expression :)
```
```graphql
# GraphQL (requires schema-level relationship)
{ apiClients { endpoint handler { auth } } }
```
```css
/* CSS Selectors — cannot express joins */
/* Requires two queries: */
/* 1. aql.select('api-client') → get endpoint attr */
/* 2. aql.select('controller[path="...",auth="required"]') */
```

**Verdict**: SQL wins; joins across annotation types are natural in SQL and impossible in CSS selectors or XPath; GraphQL can express this if the schema defines the relationship, but that pushes complexity into schema design; CSS requires imperative two-step querying through the AQL API

#### Query 5: Count endpoints per team

```sql
-- SQL
SELECT attrs->>'owner' AS team, COUNT(*) FROM annotations
  WHERE tag = 'controller' GROUP BY attrs->>'owner'
```
```xpath
(: XPath — no aggregation support :)
(: Not possible :)
```
```graphql
# GraphQL (requires custom resolver)
{ controllersByOwner { owner count } }
```
```css
/* CSS Selectors — no aggregation */
/* Must select all, then count in application code: */
/* aql.select('controller').reduce(...) */
```

**Verdict**: SQL wins again; aggregation is first-class in SQL; CSS and XPath have no concept of grouping or counting; GraphQL can support it but only through custom resolvers

### Summary

| Capability | CSS Selectors | SQL | XPath | GraphQL |
|---|---|---|---|---|
| Simple filter | `controller[method="POST"]` | `SELECT ... WHERE` | `//controller[@method]` | `{ annotations(...) }` |
| Has attribute | `[boundary]` | `IS NOT NULL` | `[@boundary]` | custom filter |
| Tree traversal | `class > method` | recursive CTE / joins | `//class/method` | nested fields |
| Cross-type joins | **not possible** | `JOIN ... ON` | **not possible** | schema-defined |
| Aggregation | **not possible** | `GROUP BY / COUNT` | **not possible** | custom resolvers |
| Familiarity | web developers | backend developers | XML developers | API developers |
| Conciseness | highest | lowest | medium | medium |
| Learning curve | lowest | medium | medium | highest |

### Decision

[CSS Selectors Level 4](https://www.w3.org/TR/selectors-4/), adapted for code elements

### Rationale

The 80% case for annotation queries is filtering a tree: "find nodes with this tag and these attributes" and "find children of this node"

CSS selectors handle this in a single concise expression that most developers already know; the combinator syntax (`>`, `+`, `~`, space) maps directly to code structure (`class > method`, `function call`)

SQL would be the right choice if annotations were flat rows in a table; they're not, they're a tree of tags anchored to a tree of code elements; SQL can query trees (recursive CTEs, self-joins), but the syntax for tree traversal is clumsy compared to CSS or XPath

SQL's strength, joins and aggregations, covers the 20% case: cross-file flow matching ("which frontend calls which backend?") and team-level rollups ("how many endpoints per owner?"); these are valuable but less common than simple tree filtering; for the 20%, the AQL API supports imperative multi-step queries (`select` → extract attribute → `select` again), which is less elegant than SQL but adequate

The declarative principle behind SQL, describe what you want not how to find it, is exactly right, and the annotation schema adopts it fully; the difference is the data model: SQL assumes tables, CSS assumes trees; annotations are trees

**Extensions over standard CSS**: Param-list matching (`params=(foo, bar=10)`) and `$N` positional bindings extend CSS selectors for code-specific needs; see the [Selector Syntax specification](../text/0001-agent-annotation-schema.md#selector-syntax)

**What we ruled out**:
- SQL
  - Right philosophy, wrong data model
  - Tree queries are clumsy; verbose for simple filters
  - Would require flattening annotations into rows, losing the tree structure that mirrors code nesting
  - However, the core library could expose a SQLite interface for power users who need joins and aggregations
- XPath
  - Handles trees well
  - Verbose (`/descendant::function[@name="foo"]` vs `function[name="foo"]`)
  - Unfamiliar to most developers outside the XML ecosystem
- GraphQL
  - Good for nested data
  - Implies a full type system and schema layer; adds implementation complexity (resolvers, schema definition) for no clear benefit over CSS selectors
  - The schema manifest already defines the vocabulary; adding a GraphQL schema on top is redundant
- Custom DSL
  - Another syntax to learn with no ecosystem support
  - Main argument would be combining CSS-like tree matching with SQL-like joins, but that's inventing a query language (massive scope increase)

**Future consideration**: If cross-type joins prove common, the core library could additionally expose annotations as a SQLite virtual table, giving power users `SELECT`/`JOIN`/`GROUP BY` alongside the CSS selector API; both interfaces would query the same underlying annotation store

---

## 3. YAML vs JSON vs Custom Format

**Context**: External annotation files need a serialization format

**Options considered**:

| Option | Description |
|--------|-------------|
| YAML | Human-readable, supports comments, multiline strings |
| JSON | Universal, strict, no ambiguity |
| TOML | Good for config, less suited for nested data |
| Custom DSL | Purpose-built syntax |

**Decision**: YAML (`.ann.yaml`)

**Rationale**:
- Readability
  - Annotations are authored and reviewed by humans
  - YAML's indentation-based nesting and lack of braces makes annotation files scannable
- Comments
  - YAML supports comments, useful for documenting annotation intent within the file itself
- Nesting
  - Annotation hierarchies (children nested under parents) map naturally to YAML's indentation
- Ecosystem
  - YAML parsers exist for every language
  - No custom parser needed for the file format itself

**Trade-offs accepted**: YAML has well-known pitfalls (the Norway problem, implicit type coercion); annotation files should use quoted strings for values that could be ambiguous

**What we ruled out**: JSON is verbose for human authoring (requires quoting every key, no comments); TOML handles flat config well but nested annotation trees poorly; a custom DSL would require a parser and add learning curve for no clear benefit over YAML

---

## 2. Sidecar Files vs Centralized Store

**Context**: Once annotations moved external (see [Decision 1](#1-inline-comments-vs-external-annotation-files)), the question became *where* they live

**Options considered**:

| Option | Description |
|--------|-------------|
| Sidecar files | `Foo.tsx.ann.yaml` alongside `Foo.tsx` |
| Centralized directory | `.annotations/src/components/Foo.tsx.yaml` mirroring the source tree |
| Database/service | Annotations stored in a queryable backend |

**Decision**: Sidecar files (`.ann.yaml` suffix alongside source)

**Rationale**:
- Locality
  - Sidecar files appear next to the source file in the file tree
  - Obvious which annotations belong to which code
- Git diffs
  - Changes to annotations for `Foo.tsx` show up in `Foo.tsx.ann.yaml`
  - Easy to review in PRs
- No path duplication
  - A centralized store must mirror the source tree, creating redundant directory structures that break when files move
- Tooling simplicity
  - File watchers, IDE plugins, and agents can discover annotation files by convention without configuration

**What we ruled out**: Centralized `.annotations/` directory duplicates the source tree structure and creates distance between code and its metadata; a database/service adds infrastructure complexity inappropriate for a file-based annotation system

---

## 1. Inline Comments vs External Annotation Files

**Context**: The original v1 proposal embedded annotations as XML-like tags inside code comments (`// <component id="TodoList">`); this worked for a single-author proof of concept but raised fundamental questions about multi-author workflows

**Options considered**:

| Option | Description |
|--------|-------------|
| Inline comments (v1) | XML tags embedded in `//` or `/* */` comments alongside code |
| External sidecar files | `.ann.yaml` files alongside source files |
| Centralized annotation store | All annotations in a single `.annotations/` directory |

**Decision**: External sidecar files

**Rationale**:
- Multi-author conflicts
  - Inline annotations mean every agent, CI job, and human editing a file risks disrupting annotations
  - Merge conflicts between code changes and annotation changes become routine
- Non-deterministic AI churn
  - AI agents aren't deterministic
  - Inline approach means every agent pass would suggest adding, modifying, or restructuring annotations, creating noisy diffs on every edit
- Tag discovery
  - With inline annotations, the only way to know what's queryable is to scan every file in the project
  - External files with a schema manifest solve this entirely
- Source code stays clean
  - Engineers read code, not metadata
  - Keeping annotations external preserves readability

**What we ruled out**: Inline comments are fundamentally incompatible with multi-author, multi-agent workflows; the v1 approach was valuable for proving the annotation concept but doesn't scale

---

## References

1. **^** ["Agent Annotation Schema — RFC"](../text/0001-agent-annotation-schema.md), full specification (scope principle, code elements, selectors, AQL)
2. **^** ["Walkthrough: Grafana"](./walkthrough.md), applied to Grafana's Go + TypeScript codebase
3. **^** Codd, E. F., ["A Relational Model of Data for Large Shared Data Banks"](https://doi.org/10.1145/362384.362685), *Communications of the ACM* 13, no. 6 (June 1970): 377-387
4. **^** Chamberlin, D. D. and R. F. Boyce, ["SEQUEL: A Structured English Query Language"](https://doi.org/10.1145/800296.811515), *Proceedings of the 1974 ACM SIGFIDET Workshop*, 249-264
5. **^** Chamberlin, D. D., ["Early History of SQL"](https://doi.org/10.1109/MAHC.2012.61), *IEEE Annals of the History of Computing* 34, no. 4 (Oct-Dec 2012): 78-82
6. **^** International Organization for Standardization, [*ISO/IEC 9075:2023 — Database languages SQL*](https://www.iso.org/standard/76583.html), 9th ed., Geneva: ISO, 2023
