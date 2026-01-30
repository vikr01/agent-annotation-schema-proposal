# Decision Log

[← Docs](./README.md) · [Home](../README.md)

---

This document tracks the key design decisions made during the development of the Agent Annotation Schema, including what was considered, what was chosen, and why alternatives were ruled out.

## Contents

- [1. Inline Comments vs External Annotation Files](#1-inline-comments-vs-external-annotation-files)
- [2. Sidecar Files vs Centralized Store](#2-sidecar-files-vs-centralized-store)
- [3. YAML vs JSON vs Custom Format](#3-yaml-vs-json-vs-custom-format)
- [4. Query Language: CSS Selectors vs SQL vs XPath vs GraphQL](#4-query-language-css-selectors-vs-sql-vs-xpath-vs-graphql)
- [5. Anchoring: Selectors vs Line Numbers vs Symbol Names](#5-anchoring-selectors-vs-line-numbers-vs-symbol-names)
- [6. Language-Specific Constructs: Universal Tags + lang-hint vs Per-Language Tags](#6-language-specific-constructs-universal-tags--lang-hint-vs-per-language-tags)
- [7. Tag Discovery: Schema Manifest vs Convention vs Scanning](#7-tag-discovery-schema-manifest-vs-convention-vs-scanning)
- [8. Annotation Scope: Non-Derivable Metadata Only](#8-annotation-scope-non-derivable-metadata-only)
- [9. Selector Drift: Validation + Repair vs Validation Only](#9-selector-drift-validation--repair-vs-validation-only)
- [References](#references)

---

## 1. Inline Comments vs External Annotation Files
[↩](#contents)

**Context**: The original v1 proposal embedded annotations as XML-like tags inside code comments (`// <component id="TodoList">`). This worked for a single-author proof of concept but raised fundamental questions about multi-author workflows.

**Options considered**:

| Option | Description |
|--------|-------------|
| Inline comments (v1) | XML tags embedded in `//` or `/* */` comments alongside code |
| External sidecar files | `.ann.yaml` files alongside source files |
| Centralized annotation store | All annotations in a single `.annotations/` directory |

**Decision**: External sidecar files.

**Rationale**:
- **Multi-author conflicts**: Inline annotations mean every agent, CI job, and human editing a file risks disrupting annotations. Merge conflicts between code changes and annotation changes become routine.
- **Non-deterministic AI churn**: AI agents aren't deterministic. An inline approach means every agent pass would suggest adding, modifying, or restructuring annotations — creating noisy diffs on every edit.
- **Tag discovery**: With inline annotations, the only way to know what's queryable is to scan every file in the project. External files with a [schema manifest](../text/0001-agent-annotation-schema.md#schema-manifest) solve this entirely.
- **Source code stays clean**: Engineers read code, not metadata. Keeping annotations external preserves readability.

**What we ruled out**: Inline comments are fundamentally incompatible with multi-author, multi-agent workflows. The v1 approach was valuable for proving the annotation concept but doesn't scale.

---

## 2. Sidecar Files vs Centralized Store
[↩](#contents)

**Context**: Once we moved annotations external, the question became *where* they live.

**Options considered**:

| Option | Description |
|--------|-------------|
| Sidecar files | `Foo.tsx.ann.yaml` alongside `Foo.tsx` |
| Centralized directory | `.annotations/src/components/Foo.tsx.yaml` mirroring the source tree |
| Database/service | Annotations stored in a queryable backend |

**Decision**: Sidecar files (`.ann.yaml` suffix alongside source).

**Rationale**:
- **Locality**: Sidecar files appear next to the source file in the file tree, making it obvious which annotations belong to which code.
- **Git diffs**: Changes to annotations for `Foo.tsx` show up in `Foo.tsx.ann.yaml` — easy to review in PRs.
- **No path duplication**: A centralized store must mirror the source tree, creating redundant directory structures that break when files move.
- **Tooling simplicity**: File watchers, IDE plugins, and agents can discover annotation files by convention without configuration.

**What we ruled out**: A centralized `.annotations/` directory duplicates the source tree structure and creates distance between code and its metadata. A database/service adds infrastructure complexity inappropriate for a file-based annotation system.

---

## 3. YAML vs JSON vs Custom Format
[↩](#contents)

**Context**: External annotation files need a serialization format.

**Options considered**:

| Option | Description |
|--------|-------------|
| YAML | Human-readable, supports comments, multiline strings |
| JSON | Universal, strict, no ambiguity |
| TOML | Good for config, less suited for nested data |
| Custom DSL | Purpose-built syntax |

**Decision**: YAML (`.ann.yaml`).

**Rationale**:
- **Readability**: Annotations are authored and reviewed by humans. YAML's indentation-based nesting and lack of braces makes annotation files scannable.
- **Comments**: YAML supports comments, useful for documenting annotation intent within the file itself.
- **Nesting**: Annotation hierarchies (children nested under parents) map naturally to YAML's indentation.
- **Ecosystem**: YAML parsers exist for every language. No custom parser needed for the file format itself.

**Trade-offs accepted**: YAML has well-known pitfalls (the Norway problem, implicit type coercion). Annotation files should use quoted strings for values that could be ambiguous.

**What we ruled out**: JSON is verbose for human authoring (requires quoting every key, no comments). TOML handles flat config well but nested annotation trees poorly. A custom DSL would require a parser and add learning curve for no clear benefit over YAML.

---

## 4. Query Language: CSS Selectors vs SQL vs XPath vs GraphQL
[↩](#contents)

**Context**: The system needs a query language for finding annotations and anchoring them to code. This is the most consequential design decision — it determines how every agent, CI job, and developer interacts with annotations.

### The SQL insight

The core idea — describe *what* data you want, not *how* to find it — comes from relational databases. E.F. Codd's 1970 paper established the principle: "Future users of large data banks must be protected from having to know how the data is organized in the machine" <sup>[[1]](#query-language-references)</sup>. Chamberlin and Boyce built SEQUEL (later SQL) on this foundation in 1974 <sup>[[2]](#query-language-references)</sup>, and Chamberlin later wrote explicitly: "the Sequel version of this query describes the information it is looking for but does not provide a detailed plan for how to find this information. This is why Sequel is called a declarative (rather than a procedural) language" <sup>[[3]](#query-language-references)</sup>.

This is exactly the problem annotation queries solve. An agent shouldn't scan files to find who owns an endpoint — it should declare what it wants (`controller[method="POST"]`) and let the system find it. The SQL standard (ISO/IEC 9075, first published 1987, now in its 9th edition as SQL:2023 <sup>[[4]](#query-language-references)</sup>) has maintained this declarative model for nearly 40 years across every major database. The principle is proven.

The question is which declarative syntax best fits our data model — a *tree* of annotations attached to a *tree* of code elements.

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

**Verdict**: All four work. CSS is the most concise. SQL requires understanding JSON column access (`attrs->>'method'`). XPath and GraphQL are fine.

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

**Verdict**: CSS and XPath express "has attribute" natively (`[boundary]`). SQL needs `IS NOT NULL`. GraphQL would need a custom `hasAttr` filter or a different schema design.

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

**Verdict**: This is where tree-native languages pull ahead. CSS and XPath express parent-child relationships in a single line. SQL requires joins against a parent ID — it wasn't designed for trees. GraphQL handles nesting naturally but is verbose.

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

**Verdict**: SQL wins. Joins across annotation types are natural in SQL and impossible in CSS selectors or XPath. GraphQL can express this if the schema defines the relationship, but that pushes complexity into schema design. CSS requires imperative two-step querying through the AQL API.

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

**Verdict**: SQL wins again. Aggregation is first-class in SQL. CSS and XPath have no concept of grouping or counting. GraphQL can support it but only through custom resolvers.

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

CSS Selectors Level 4, adapted for code elements.

### Rationale

The 80% case for annotation queries is filtering a tree: "find nodes with this tag and these attributes" and "find children of this node." CSS selectors handle this in a single concise expression that most developers already know. The combinator syntax (`>`, `+`, `~`, space) maps directly to code structure (class > method, function call).

SQL would be the right choice if annotations were flat rows in a table. They're not — they're a tree of tags anchored to a tree of code elements. SQL can query trees (recursive CTEs, self-joins), but the syntax for tree traversal is clumsy compared to CSS or XPath.

SQL's strength — joins and aggregations — covers the 20% case: cross-file flow matching ("which frontend calls which backend?") and team-level rollups ("how many endpoints per owner?"). These are valuable but less common than simple tree filtering. For the 20%, the AQL API supports imperative multi-step queries (`select` → extract attribute → `select` again), which is less elegant than SQL but adequate.

The declarative principle behind SQL — describe what you want, not how to find it — is exactly right, and the annotation schema adopts it fully. The difference is the data model: SQL assumes tables, CSS assumes trees. Annotations are trees.

**Extensions over standard CSS**: Param-list matching (`params=(foo, bar=10)`) and `$N` positional bindings extend CSS selectors for code-specific needs. See [Selectors](../text/0001-agent-annotation-schema.md#selector-syntax).

**What we ruled out**:
- **SQL**: Right philosophy, wrong data model. Tree queries are clumsy. Verbose for simple filters. Would require flattening annotations into rows, losing the tree structure that mirrors code nesting. However, the core library could expose a SQLite interface for power users who need joins and aggregations.
- **XPath**: Handles trees well, but verbose (`/descendant::function[@name="foo"]` vs `function[name="foo"]`) and unfamiliar to most developers outside the XML ecosystem.
- **GraphQL**: Good for nested data, but implies a full type system and schema layer. Adds implementation complexity (resolvers, schema definition) for no clear benefit over CSS selectors. The schema manifest already defines the vocabulary — adding a GraphQL schema on top is redundant.
- **Custom DSL**: Another syntax to learn with no ecosystem support. The main argument for a custom language would be to combine CSS-like tree matching with SQL-like joins, but that's inventing a query language — a massive scope increase.

**Future consideration**: If cross-type joins prove common, the core library could additionally expose annotations as a SQLite virtual table, giving power users `SELECT`/`JOIN`/`GROUP BY` alongside the CSS selector API. Both interfaces would query the same underlying annotation store.

<span id="query-language-references"></span>

#### References

1. Codd, E. F. ["A Relational Model of Data for Large Shared Data Banks."](https://doi.org/10.1145/362384.362685) *Communications of the ACM* 13, no. 6 (June 1970): 377–387.
2. Chamberlin, D. D. and R. F. Boyce. ["SEQUEL: A Structured English Query Language."](https://doi.org/10.1145/800296.811515) *Proceedings of the 1974 ACM SIGFIDET Workshop*, 249–264.
3. Chamberlin, D. D. ["Early History of SQL."](https://doi.org/10.1109/MAHC.2012.61) *IEEE Annals of the History of Computing* 34, no. 4 (Oct–Dec 2012): 78–82.
4. International Organization for Standardization. [*ISO/IEC 9075:2023 — Database languages SQL*](https://www.iso.org/standard/76583.html). 9th ed. Geneva: ISO, 2023.

---

## 5. Anchoring: Selectors vs Line Numbers vs Symbol Names
[↩](#contents)

**Context**: External annotations must reference specific code locations. The anchoring mechanism determines how stable annotations are across code changes.

**Options considered**:

| Option | Description |
|--------|-------------|
| Code element selectors | `function[name="HandleCreateUser",params=(w,r)]` |
| Line numbers | `line: 42` or `lines: 42-58` |
| Symbol names (plain) | `HandleCreateUser` |
| AST paths | `module.declarations[0].body.statements[2]` |

**Decision**: Code element selectors (CSS-like, same syntax as queries).

**Rationale**:
- **Stability**: Selectors match by semantic identity (`function[name="foo"]`), not position. Adding a line above doesn't break the anchor. Renaming the function is a clear, intentional change that *should* require updating the annotation.
- **Expressiveness**: Plain symbol names can't distinguish overloaded functions, methods with the same name in different classes, or anonymous functions. Selectors can: `class[name="UserService"] > method[name="create",async]`.
- **Unified syntax**: The selector used to anchor an annotation is the same syntax used to query code elements. One system, not two.
- **Language-agnostic**: Selectors target universal [code elements](../text/0001-agent-annotation-schema.md#code-elements), not language-specific AST nodes. The same selector works whether the function is in Go, TypeScript, or Python.

**What we ruled out**: Line numbers break on every edit — they're the most fragile option. Plain symbol names lack the expressiveness to handle overloading, nesting, or disambiguation. AST paths (`module.declarations[0]`) are precise but break whenever code is reordered, and they require knowledge of the AST structure.

---

## 6. Language-Specific Constructs: Universal Tags + lang-hint vs Per-Language Tags
[↩](#contents)

**Context**: Programming languages have constructs that don't map cleanly across languages (Go's `defer`, Python's decorators, Rust's lifetimes, etc.).

**Options considered**:

| Option | Description |
|--------|-------------|
| Universal tags + `lang-hint` | One set of tags for all languages, with a `lang-hint` attribute for specifics |
| Per-language tag sets | `go-func`, `ts-function`, `py-def` |
| Universal tags only (no escape hatch) | Force everything into universal vocabulary |

**Decision**: Universal tags with a `lang-hint` attribute for language-specific constructs.

**Rationale**:
- **Cross-language queries**: The primary goal is writing `function[name="create"]` and matching Go, TS, and Python functions alike. Per-language tags defeat this entirely — you'd need `go-func OR ts-function OR py-def`.
- **Graceful specificity**: When language-specific behavior matters, `lang-hint` provides an escape hatch: `call[lang-hint="defer"]` targets Go deferred calls specifically without polluting the universal vocabulary.
- **Manageable vocabulary**: A finite set of universal tags (function, class, method, field, etc.) is learnable. Per-language tags would multiply the vocabulary by the number of supported languages.

**What we ruled out**: Per-language tags make cross-language queries impossible — the core value proposition. Universal-only (no escape hatch) is too rigid for languages with genuinely unique constructs.

See [Code Elements](../text/0001-agent-annotation-schema.md#code-elements) for the full universal vocabulary.

---

## 7. Tag Discovery: Schema Manifest vs Convention vs Scanning
[↩](#contents)

**Context**: When an agent encounters a project, how does it know what annotation tags are available to query?

**Options considered**:

| Option | Description |
|--------|-------------|
| Schema manifest | `.annotations/schema.yaml` at project root defines all tags |
| Convention-based | Tags follow naming patterns, agents infer from usage |
| File scanning | Agent reads all `.ann.yaml` files to discover tags |
| Hardcoded built-ins | Fixed set of tags known to all tools |

**Decision**: Explicit schema manifest at project root.

**Rationale**:
- **Single source of truth**: One file defines every tag, its attributes, and their types. No ambiguity about what's available.
- **Zero scanning**: An agent reads one file and knows every queryable tag and attribute in the project. This is the fastest possible discovery path.
- **Validation**: The manifest enables tooling to validate that annotation files only use defined tags and that required attributes are present.
- **Self-documenting**: The manifest serves as documentation for the project's annotation vocabulary. New contributors can read it to understand what metadata exists.

**What we ruled out**: Convention-based discovery is ambiguous — what patterns? File scanning defeats the purpose of structured metadata (you still have to read everything). Hardcoded built-ins are too rigid for diverse codebases.

See [Schema Manifest](../text/0001-agent-annotation-schema.md#schema-manifest) for the manifest specification.

---

## 8. Annotation Scope: Non-Derivable Metadata Only
[↩](#contents)

**Context**: The initial design annotated everything — async functions, suspension behavior, parameter types, HTTP methods. But agents can already derive most of this by reading source code. Annotations that duplicate source-readable information create maintenance burden without adding value.

**Options considered**:

| Option | Description |
|--------|-------------|
| Annotate everything | Include both derivable and non-derivable metadata for completeness |
| Non-derivable only | Only annotate metadata that cannot be inferred by reading source code |
| Hybrid with derivable flags | Include some derivable facts as convenience shortcuts |

**Decision**: Non-derivable metadata only.

**Rationale**:
- **Maintenance cost**: Every annotation is a liability — it can drift from code. Annotations that duplicate source information (e.g., `suspends: true` on a hook named `useSuspenseQuery`, `async: true` on an `async def`) double the maintenance burden for zero information gain.
- **Agent capabilities are improving**: Large context windows and better code understanding mean agents get progressively better at deriving information from source. Annotations encoding derivable facts lose their value over time.
- **Smaller surface**: Fewer annotations mean fewer files to maintain, fewer selectors that can drift, and faster validation.
- **Clearer value signal**: When every annotation carries information that genuinely can't be found in source, the schema is worth maintaining. When annotations mix derivable and non-derivable facts, the signal-to-noise ratio drops and teams stop maintaining them.

See the RFC's Scope Principle <sup>[1]</sup> for the canonical definition of what belongs in annotations and what doesn't.

**What we ruled out**: "Annotate everything" creates an unsustainable maintenance burden. "Hybrid with convenience flags" blurs the scope boundary and invites scope creep — once you allow some derivable facts, there's no principled line.

---

## 9. Selector Drift: Validation + Repair vs Validation Only
[↩](#contents)

**Context**: External annotations reference code via selectors like `function[name="HandleCreateUser"]`. When code is renamed, moved, or restructured, selectors break silently.

**Options considered**:

| Option | Description |
|--------|-------------|
| Validation only | `aql.validate()` reports broken selectors; humans fix them |
| Validation + repair | `aql.repair()` detects renames and suggests selector updates |
| Automatic rewrite | Tool automatically updates selectors on every code change |

**Decision**: Validation + repair (`aql.validate()` + `aql.repair()`).

**Rationale**:
- **Validation alone is insufficient**: Catching drift and fixing drift are different problems. If the only tool is "here's a list of broken selectors," teams will ignore the list until the annotation file is deleted.
- **Repair enables maintenance at scale**: When a function is renamed from `PostDashboard` to `SaveDashboard`, repair can detect the structural similarity and suggest updating the selector. This turns a manual hunt into a one-click fix.
- **Not fully automatic**: Automatic rewrite is risky — a major refactor that changes structure (not just names) could produce incorrect automatic updates. Repair suggests with a confidence score; humans or agents approve.

**What we ruled out**: Automatic rewrite is too aggressive for structural changes where the "correct" update is ambiguous. Validation-only is too passive for real-world maintenance.

See [AQL](../text/0001-agent-annotation-schema.md#aql--agent-query-language) for the repair API.

---

## References
[↩](#contents)

1. [Agent Annotation Schema — RFC](../text/0001-agent-annotation-schema.md) — full specification (scope principle, code elements, selectors, AQL)
2. [Walkthrough](./walkthrough.md) — Grafana case study (Go + TypeScript)
