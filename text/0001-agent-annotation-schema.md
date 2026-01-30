- Start Date: 2026-01-28
- RFC PR: (leave this empty)
- Issue: (leave this empty)

[← Docs](../docs/) · [Home](../README.md)

# Agent Annotation Schema

## Contents

- [Summary](#summary)
- [Basic Example](#basic-example)
- [Motivation](#motivation)
- [Detailed Design](#detailed-design)
- [Drawbacks](#drawbacks)
- [Alternatives](#alternatives)
- [Adoption Strategy](#adoption-strategy)
- [How We Teach This](#how-we-teach-this)
- [Unresolved Questions](#unresolved-questions)
- [References](#references)

## Summary

A structured, language-agnostic system for attaching queryable metadata to code. Annotations are stored in external sidecar files (`.ann.yaml`), anchored to code via CSS-like selectors, and queried through a unified API. A schema manifest enables tag discovery without scanning source files.

## Basic Example

Three backend handlers in three languages. The source code shows they take HTTP requests, but not who owns them, what the auth model is, or where they sit in the API surface:

**Go**: `UserController.go.ann.yaml`
```yaml
annotations:
  - select: 'function[name="HandleCreateUser"]'
    tag: controller
    attrs:
      method: POST
      path: /api/users
      owner: "@backend"
      auth: required
      visibility: public
```

**TypeScript**: `userController.ts.ann.yaml`
```yaml
annotations:
  - select: 'function[name="createUser"]'
    tag: controller
    attrs:
      method: POST
      path: /api/users
      owner: "@backend"
      auth: required
      visibility: public
```

**Python**: `user_routes.py.ann.yaml`
```yaml
annotations:
  - select: 'function[name="create_user"]'
    tag: controller
    attrs:
      method: POST
      path: /users
      owner: "@backend"
      auth: required
      visibility: public
```

One query finds all three:
```typescript
aql.select('controller[method="POST"]')
aql.select('[owner="@backend"]')
```

## Motivation

Agents can read source code. They can see that a function is async, that a hook is called `useSuspenseQuery`, that a handler takes `http.ResponseWriter`. What they can't see: who owns this code, what the performance SLA is, how to prefetch a query cache, which frontend hook calls which backend endpoint, or that this API is being deprecated next quarter. That metadata lives in developers' heads and gets rediscovered (or worse, guessed) every time.

Current solutions like `CLAUDE.md` or `AGENTS.md` are project-level, not expression-level. They can say "this project uses React Query" but not "here's how to invalidate this specific hook's cache."

The first iteration embedded annotations as inline code comments. This fails at scale: merge conflicts, AI churn, and no tag discovery without scanning every file <sup>[[1]](#references)</sup>. These constraints demand external storage, a discovery mechanism, and a language-agnostic query system.

### Scope Principle

Annotations are for metadata **that cannot be derived from reading source code**. If an agent can figure it out by parsing the file (a function is async, a parameter has a type, a class implements an interface), it doesn't need an annotation. The source code already says it.

What belongs in annotations:
- **Ownership and audience**
  - Who owns this, who should review it
- **Performance contracts**
  - Performance targets, tracing requirements
- **Cache and data-flow recipes**
  - How to prefetch, invalidate, or preload
- **Cross-boundary flows**
  - Which frontend code calls which backend endpoint
- **Architectural intent**
  - Why this code exists, what invariants it maintains
- **Lifecycle metadata**
  - Deprecation intent, migration plans, stability level
- **Business rules**
  - Constraints that exist in requirements, not in code

This scope constraint keeps annotation files small, reduces maintenance burden, and ensures every annotation carries information an agent genuinely can't get elsewhere.

## Detailed Design

### Architecture

Three layers separate code understanding, metadata storage, and querying:

```
┌─────────────────────────────────────────────────┐
│                 AQL Query API                    │
│  Unified interface for querying annotations      │
│  and resolving them against code                 │
├─────────────────────────────────────────────────┤
│              Annotation Store                    │
│  External .ann.yaml sidecar files mapping        │
│  code selectors to semantic tags                 │
├─────────────────────────────────────────────────┤
│              Code Resolver                       │
│  Language-specific parsing into a universal       │
│  code element model                              │
└─────────────────────────────────────────────────┘
```

**Code Resolver** (bottom) parses source files from any language into a universal code element tree. It handles language-specific syntax (Go's `func`, Python's `def`, TypeScript's arrow functions) and produces a uniform structure.

**Annotation Store** (middle) manages external `.ann.yaml` sidecar files. Each annotation uses a code selector to anchor itself to a specific code element. The store validates annotations against the schema manifest and resolves anchors via the Code Resolver.

**AQL Query API** (top) is the interface agents, CI, and tooling use to query annotations. It combines annotation metadata with resolved code elements.

A query flows through all three layers:

```
Agent: aql.select('react-hook[suspends="true"]')
  │
  ▼
AQL → parses selector, searches annotation store
  │
  ▼
Annotation Store → finds matching annotations, gets code anchor selectors
  │
  ▼
Code Resolver → parses source, matches selector to AST, returns code element
  │
  ▼
Agent receives: AnnotatedElement[] (annotation metadata + resolved code)
```

### Code Elements

Code elements are the universal vocabulary for representing code constructs across any language.

#### Element Tags

| Tag | Description | Go | TypeScript | Python | Rust | Java |
|-----|-------------|-----|-----------|--------|------|------|
| `module` | File/package scope | `package` | module/file | module | `mod` | package |
| `import` | Module import | `import` | `import` | `import` | `use` | `import` |
| `export` | Exported decl | capitalized | `export` | `__all__` | `pub` | `public` |
| `function` | Any callable | `func` | `function`/arrow | `def` | `fn` | static method |
| `class` | Type with members | `struct` | `class` | `class` | `struct` | `class` |
| `interface` | Abstract contract | `interface` | `interface` | `Protocol` | `trait` | `interface` |
| `method` | Member function | receiver func | class method | `def` in class | `impl` fn | instance method |
| `field` | Data member | struct field | property | attribute | struct field | field |
| `constructor` | Initialization | — | `constructor` | `__init__` | — | constructor |
| `param` | Function param | universal | universal | universal | universal | universal |
| `variable` | Variable decl | `var`/`const` | `let`/`const` | assignment | `let`/`const` | local var |
| `call` | Invocation | universal | universal | universal | universal | universal |
| `return` | Return stmt | universal | universal | universal | universal | universal |
| `block` | Control flow | `if`/`for`/`switch` | same | same | `if`/`for`/`match` | same |
| `type` | Type alias | `type` | `type` | `TypeAlias` | `type` | — |
| `enum` | Enumeration | `const`+iota | `enum` | `Enum` | `enum` | `enum` |

#### Universal Attributes

These are **code element attributes** used in selectors to target code, not annotation attributes. They're derived by the Code Resolver from source; you use them to *anchor* annotations, not to store metadata an agent already has.

| Attribute | Type | Applies to | Description |
|-----------|------|-----------|-------------|
| `name` | string | all | Identifier name |
| `visibility` | public/private/protected | all | Access level |
| `async` | boolean | function, method | Async callable |
| `static` | boolean | method, field | Static member |
| `generator` | boolean | function, method | Yields |
| `abstract` | boolean | class, method | Abstract |
| `readonly` | boolean | field, variable | Immutable |
| `params` | param-list | function, method, constructor | Parameters |
| `returns` | string | function, method | Return type |
| `decorators` | string[] | function, method, class | Decorators |
| `implements` | string[] | class | Implemented interfaces |
| `extends` | string | class, interface | Parent type |
| `kind` | string | block | `"if"`, `"for"`, `"while"`, `"switch"`, `"match"`, `"try"` |
| `lang-hint` | string | all | Language-specific construct hint |

#### Language-Specific Constructs

When a language has a construct with no direct universal equivalent, use the nearest universal tag with `lang-hint`:

| Language | Construct | Representation |
|----------|-----------|---------------|
| Go | `defer f()` | `call[name="f",lang-hint="defer"]` |
| Go | `go f()` | `call[name="f",lang-hint="goroutine"]` |
| Rust | `unsafe { ... }` | `block[lang-hint="unsafe"]` |
| Python | `with ctx:` | `block[kind="with",lang-hint="context-manager"]` |
| Java | `synchronized` | `block[lang-hint="synchronized"]` |

Operator overloading uses the language's own naming (`method[name="__add__"]`, `method[name="operator+"]`) with `lang-hint="operator"` to enable cross-language queries.

#### Element Nesting

```
module
├── import
├── export
│   └── function
│       ├── param
│       ├── variable
│       ├── call
│       ├── block
│       │   ├── call
│       │   └── return
│       └── return
├── class
│   ├── field
│   ├── constructor
│   └── method
│       ├── param
│       └── call
└── interface
    └── method
```

### Selector Syntax

Selectors are based on CSS Selectors Level 4, adapted for code constructs. They serve two purposes: anchoring annotations to code and querying annotations.

#### Grammar

```ebnf
selector        = compound ( combinator compound )* ;
compound        = element_tag? attr_list? pseudo* ;
element_tag     = IDENT ;
attr_list       = "[" attr_expr ( "," attr_expr )* "]" ;
attr_expr       = IDENT ( attr_op value )? ;
attr_op         = "=" | "~=" | "|=" | "^=" | "$=" | "*=" ;
value           = QUOTED_STRING | IDENT | param_list ;
param_list      = "(" param ( "," param )* ")" ;
param           = "_" | IDENT ( ":" IDENT )? ( "=" value )? ;
pseudo          = ":" IDENT ( "(" selector ")" )? ;
combinator      = ">" | "+" | "~" | " " ;

IDENT           = [a-zA-Z_-] [a-zA-Z0-9_-]* ;
QUOTED_STRING   = '"' [^"]* '"' | "'" [^']* "'" ;
```

#### Tag and Attribute Matching

```
function                              → any function
function[name="create"]               → function named "create"
function[async]                       → any async function
class[extends="BaseController"]       → classes extending BaseController
call[lang-hint="defer"]               → Go deferred calls
```

#### Attribute Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `=` | Exact match | `[name="foo"]` |
| `~=` | Contains word | `[decorators~="cache"]` |
| `^=` | Starts with | `[name^="handle"]` |
| `$=` | Ends with | `[name$="Controller"]` |
| `*=` | Contains substring | `[name*="user"]` |

#### Parameter Matching

```
function[params=(foo)]              → has param named "foo"
function[params=(foo, bar)]         → has params "foo" and "bar"
function[params=(_, bar=10)]        → 2nd param "bar", default 10
function[params=(foo: string)]      → param with type hint
function[params=(foo, ...rest)]     → param followed by rest param
```

#### Combinators

| Combinator | Meaning | Example |
|------------|---------|---------|
| (space) | Descendant | `class method` |
| `>` | Direct child | `class > method` |
| `+` | Adjacent sibling | `variable + call` |
| `~` | General sibling | `import ~ function` |

#### Pseudo-Selectors

| Pseudo | Meaning |
|--------|---------|
| `:has()` | Contains descendant matching selector |
| `:not()` | Does not match |
| `:first-child` | First child of parent |
| `:last-child` | Last child of parent |
| `:nth-child(n)` | Nth child of parent |
| `:empty` | Has no children |

#### Positional Bindings ($N)

Expression attributes can reference arguments of the annotated call:

| Binding | Meaning |
|---------|---------|
| `$1` | First argument of the annotated call |
| `$N.path` | Property access into the Nth argument |
| `$0` | Return value |

These appear in annotation attribute values and are resolved at query time, not in selectors themselves.

### Annotation File Format

Annotations are stored in sidecar files alongside source code. For any source file, its sidecar has the same name with `.ann.yaml` appended:

```
src/components/TodoList.tsx              ← source
src/components/TodoList.tsx.ann.yaml     ← sidecar
```

#### Structure

```yaml
annotations:
  - select: <code-selector>
    tag: <annotation-tag>
    attrs:
      <key>: <value>
    children:
      - select: <code-selector>
        tag: <annotation-tag>
        attrs:
          <key>: <value>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `select` | string | yes | Code selector anchoring this annotation |
| `tag` | string | yes | Semantic type, defined in schema manifest |
| `attrs` | map | no | Key-value attributes |
| `children` | list | no | Nested annotations scoped to parent's code element |

Children nest annotations within a scope: a component contains hooks, a hook contains fields. The child's selector is resolved within the parent's selected code element.

Attribute values can be strings, booleans, numbers, or expressions (strings containing `$N` positional bindings resolved at query time).

Multiple annotations can attach to the same code element from separate entries.

### Schema Manifest

The schema manifest lives at `.annotations/schema.yaml` in the project root. It defines the vocabulary of annotation tags and their attributes.

```yaml
version: "1.0"

tags:
  <tag-name>:
    description: <string>
    attrs:
      <attr-name>: { type: <type>, required: <bool>, ... }

audiences:
  <name>: <description>

visibilities:
  <name>: <description>
```

#### Attribute Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Plain text | `"requires Suspense ancestor"` |
| `boolean` | True/false | `true` |
| `number` | Numeric | `5000` |
| `enum` | Fixed set | `POST` from `values: [GET, POST, ...]` |
| `expression` | String with `$N` bindings | `"queryClient.prefetchQuery($1)"` |
| `string[]` | List of strings | `["cache", "auth"]` |

#### Built-in Attributes

Available on all tags without manifest definition:

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | string | Unique identifier |
| `visibility` | enum | API stability (from `visibilities`) |
| `audience` | enum | Target audience (from `audiences`) |
| `owner` | string | Responsible team (e.g., `@platform`) |
| `note` | string | Human-readable explanation |

#### Validation

The manifest enables: tag validation (known tags only), attribute validation (defined attrs only), type checking, required field enforcement, and enum value checking.

### AQL (Agent Query Language)

Full TypeScript interfaces are provided by the reference implementation.

#### `aql.select(annotationSelector)`

Query annotations by tag and attributes:

```typescript
aql.select('react-hook[boundary]')
aql.select('controller[method="POST"]')
aql.select('[owner="@platform"]')
```

#### `aql.selectAnnotated(codeSelector)`

Query code elements, return those with annotations:

```typescript
aql.selectAnnotated('function[async]')
aql.selectAnnotated('class > method')
```

#### `aql.validate()`

Validate annotation files against the schema manifest:

```typescript
aql.validate()
// → [{ level: "error", file: "Foo.ann.yaml", message: "Unknown tag 'controllr'" }]
```

#### `aql.repair()`

Detect and fix broken selectors caused by code changes (renames, moves, refactors):

```typescript
aql.repair()
// → [{ file: "Foo.ann.yaml", selector: 'function[name="oldName"]',
//      suggestion: 'function[name="newName"]', confidence: 0.95 }]
```

Repair uses heuristics from the Code Resolver: if a selector stopped matching and a similarly-structured element with a different name appeared, it suggests updating the selector. This is critical for long-term maintenance: validation catches drift, repair fixes it.

#### AnnotatedElement

Each query result is an annotation bound to resolved code:

| Field | Type | Description |
|-------|------|-------------|
| `tag` | string | Annotation tag name |
| `attrs` | record | Annotation attributes |
| `children` | AnnotatedElement[] | Nested child annotations |
| `parent` | AnnotatedElement \| null | Parent annotation |
| `codeSelector` | string | Anchor selector |
| `code` | CodeElement | Resolved code element |

Traversal: `closest(selector)`, `ancestors()`, `selectWithin(selector)`, `next(selector?)`.

Attribute access: `attr(name)` returns raw value, `resolve(attrName)` substitutes `$N` bindings, `binding(path)` extracts specific bindings.

## Drawbacks

- **Selector drift**
  - A renamed function breaks its selector anchor
  - `aql.validate()` catches this in CI, `aql.repair()` can suggest fixes
  - Neither eliminates the fundamental coupling between annotation selectors and code identifiers
  - This is the long-term maintenance risk
- **Nobody will maintain annotations**
  - Developers barely maintain inline comments
  - External sidecar files are additional work on every PR that changes annotated code
  - Without strong CI validation and repair tooling, annotation files rot
- **Agents improving at reading source**
  - Large context windows and better code understanding mean agents get progressively better at deriving information from source
  - The category of "non-derivable" metadata shrinks over time
  - Organizational metadata (ownership, performance targets, deprecation intent) will likely never be derivable
- **Code Resolver complexity**
  - Supporting every language requires language-specific parsers
  - [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) covers many languages but mapping each grammar to the universal element model is per-language work
  - If the Code Resolver is unreliable, selectors silently fail to match and the system becomes untrustworthy
- **Universal vocabulary limits**
  - Some constructs don't map cleanly (Go's channels, Rust's lifetimes, Python's comprehensions)
  - `lang-hint` is an escape hatch, not a solution
  - Cross-language queries over language-specific constructs are inherently lossy
- **Adoption chicken-and-egg**
  - No tooling exists → no repos have annotations → agents can't rely on them → no incentive to build tooling
  - Breaking this cycle requires the tooling and the spec to develop together
- **Another file to review**
  - PRs that change annotated code may also need sidecar updates
  - Reviewers must check both

## Alternatives

Each alternative is documented with full rationale in the [Decision Log](../docs/decisions.md) <sup>[[1]](#references)</sup>

- **Inline comment annotations** <sup>[[1]](#references)</sup>
  - Merge conflicts, AI churn, no tag discovery
- **Centralized annotation directory** <sup>[[1]](#references)</sup>
  - Duplicates source tree, distance from code
- **YAML vs JSON vs TOML** <sup>[[1]](#references)</sup>
  - JSON verbose, TOML poor nesting
- **SQL / XPath / GraphQL queries** <sup>[[1]](#references)</sup>
  - Right philosophy, wrong data model for trees
- **Line-number anchoring** <sup>[[1]](#references)</sup>
  - Breaks on every edit
- **AST path anchoring** <sup>[[1]](#references)</sup>
  - Breaks on reorder, requires AST knowledge
- **Per-language tag vocabularies** <sup>[[1]](#references)</sup>
  - Defeats cross-language queries
- **Convention-based tag discovery** <sup>[[1]](#references)</sup>
  - Ambiguous, requires scanning everything

## Adoption Strategy

1. **Start with ownership and lifecycle metadata**
   - Before annotating behavior, annotate ownership (`owner`), audience, and visibility
   - Immediate value, zero risk of duplicating source-derivable information
2. **Add a schema manifest**
   - Define only the tags the project actually needs
   - Start small: 3-5 tags, not 20
3. **Annotate high-value boundaries first**
   - API endpoints that connect frontend to backend
   - Hooks with non-obvious cache behavior
   - Code with performance requirements
   - Don't annotate everything
4. **Integrate validation in CI**
   - `aql.validate()` on PRs catches selector drift before it accumulates
   - `aql.repair()` suggests fixes
5. **Accept agent authorship**
   - Design annotation workflows assuming agents will write most annotations
   - The schema manifest constrains what they can write; validation ensures correctness

Additive: no existing code changes, no migration, no breaking changes; projects adopt incrementally; the [scope principle](#scope-principle) keeps the annotation surface small and maintainable

## How We Teach This

The core mental model has two parts:

1. **"CSS selectors, but for code"**
   - Developers who know `div.class[attr="value"]` immediately understand `function[name="create",async]`
2. **The [scope principle](#scope-principle)**
   - The most important thing to teach, because without it, teams annotate everything and then maintain nothing

The annotation file format is YAML, no new syntax to learn. The schema manifest is similar to a JSON Schema or OpenAPI spec: define your vocabulary, validate against it.

Key concepts to introduce in order:
1. The [scope principle](#scope-principle)
2. Code elements
   - The universal tags (`function`, `class`, `method`, etc.)
3. Selectors
   - How to target code elements
4. Annotation files
   - How to attach metadata externally
5. Schema manifest
   - How to define your tag vocabulary
6. AQL
   - How to query it all

The [walkthrough](../docs/walkthrough.md) <sup>[[2]](#references)</sup> demonstrates the full system applied to Grafana's Go + TypeScript codebase.

## Unresolved Questions

- **Code Resolver implementation**
  - The spec defines what the Code Resolver produces but not how
  - Tree-sitter is the obvious candidate (grammar coverage across 100+ languages)
  - Mapping from Tree-sitter AST nodes to universal code elements is per-language work that needs to be specified or prototyped
  - Without a working Code Resolver, the selector syntax is theoretical
- **Repair heuristics**
  - `aql.repair()` needs to detect renames, moves, and restructurings
  - What confidence threshold should trigger auto-repair vs manual review?
  - How does repair work across major refactors that change code structure, not just names?
- **Who writes annotations**
  - The system is designed for human authorship but will likely be agent-maintained in practice
  - How should agents generate annotations deterministically to avoid churn?
  - Should there be a canonical serialization to minimize diffs?
- **Scope boundary enforcement**
  - The scope principle says "don't annotate derivable facts"
  - Derivability depends on the agent's capabilities, which improve over time
  - Is there a formal rule, or is this a judgment call per project?
- **Selector specificity**
  - When multiple selectors match, what are the precedence rules?
  - Should CSS specificity rules apply directly?
- **Cross-file annotations**
  - Can an annotation in one sidecar reference code in another file?
  - What about annotations spanning module boundaries?
- **Schema inheritance**
  - Should manifests support extending other manifests (e.g., a base schema for React projects)?
- **Annotation versioning**
  - When the schema manifest changes (tags added, removed, renamed), how are existing annotation files migrated?
- **Performance characteristics**
  - For large codebases with thousands of annotation files, what indexing or caching strategies should the AQL implementation use?

---

## References

1. **^** ["Decision Log"](../docs/decisions.md), design decisions, alternatives considered, and rationale
2. **^** ["Walkthrough: Grafana"](../docs/walkthrough.md), applied to Grafana's Go + TypeScript codebase
3. **^** TypeScript Interfaces, `AQL`, `AnnotatedElement`, `CodeElement` type definitions (reference implementation)
