# Decision Log

[← Home](./README.md)

---

Design decisions for the [Agent Annotation Schema](./SPEC.md), ordered latest to earliest

Each entry documents context, options considered, decision, and rationale

## Contents

- [14. Plugins: Language-Agnostic Subprocess Protocol](#14-plugins-language-agnostic-subprocess-protocol)
- [13. Implementation Language: Rust vs TypeScript](#13-implementation-language-rust-vs-typescript)
- [12. MCP Server: One Per Project, Annotation-Only Queries Skip Parsing](#12-mcp-server-one-per-project-annotation-only-queries-skip-parsing)
- [11. Code Resolver: Adapter Pattern with Parser Auto-Detection](#11-code-resolver-adapter-pattern-with-parser-auto-detection)
- [10. Project Configuration: `.config/aql.schema` vs `.annotations/schema.yaml`](#10-project-configuration-configaqlyaml-vs-annotationsschemayaml)
- [9. Selector Drift: Validation + Repair vs Validation Only](#9-selector-drift-validation--repair-vs-validation-only)
- [8. Annotation Scope: Non-Derivable Metadata Only](#8-annotation-scope-non-derivable-metadata-only)
- [7. Tag Discovery: Schema Manifest vs Convention vs Scanning](#7-tag-discovery-schema-manifest-vs-convention-vs-scanning)
- [6. Language-Specific Constructs: Universal Tags + lang-hint vs Per-Language Tags](#6-language-specific-constructs-universal-tags--lang-hint-vs-per-language-tags)
- [5. Anchoring: Selectors vs Line Numbers vs Symbol Names](#5-anchoring-selectors-vs-line-numbers-vs-symbol-names)
- [4. Query Language: CSS Selectors vs SQL vs XPath vs GraphQL](#4-query-language-css-selectors-vs-sql-vs-xpath-vs-graphql)
- [3. XML vs YAML vs JSON vs Custom Format](#3-xml-vs-yaml-vs-json-vs-custom-format)
- [2. Sidecar Files vs Centralized Store](#2-sidecar-files-vs-centralized-store)
- [1. Inline Comments vs External Annotation Files](#1-inline-comments-vs-external-annotation-files)
- [References](#references)

---

## 14. Plugins: Language-Agnostic Subprocess Protocol

**Context**: The built-in Code Resolver uses tree-sitter for structural parsing, which works for basic code element extraction but can't access type-level information, framework-specific metadata, or external code registries. The Extractor mechanism (Decision 11) solves one dimension (runtime annotation discovery), but three separate extension points need a unified approach: code resolution, annotation extraction, and external search.

**Options considered**:

| Option | Description |
|--------|-------------|
| In-process dynamic libraries | Plugins as `.so`/`.dylib` loaded at runtime |
| Language-specific SDKs | Separate SDK per language (npm package, pip package, etc.) |
| Subprocess + JSON-RPC | Any executable that speaks JSON over stdin/stdout |
| WASM plugins | WebAssembly modules loaded in-process |

**Decision**: Subprocess + JSON-RPC over stdin/stdout. One protocol, three capabilities (`resolve`, `extract`, `search`).

**Rationale**:

- Language agnosticism
  - A Python developer writes a Django plugin in Python; a Node developer writes a TypeScript plugin in Node
  - No FFI, no shared memory, no ABI compatibility — just JSON over pipes
  - The plugin author's only contract: read JSON-RPC from stdin, write JSON-RPC to stdout
- Unifies three extension points
  - Code resolution (parse files → code elements), annotation extraction (discover metadata), and external search (query registries) all use the same protocol
  - A single plugin can provide multiple capabilities: a TypeScript plugin resolves `.ts` files and extracts Next.js routes
  - No separate config formats for each extension type
- Process isolation
  - A crashing plugin doesn't take down the AQL server
  - Plugins can have arbitrary dependencies without polluting the core binary
  - Memory leaks in plugins are bounded to their process
- Fast path preserved
  - Built-in tree-sitter resolvers handle common languages with zero IPC overhead
  - Plugins only activate for file types they register, or on explicit search queries
  - The subprocess is long-lived (spawned once per session), not one-shot per request
- Distribution via existing package managers
  - npm for Node plugins, pip for Python, cargo for Rust, brew for binaries
  - No custom plugin registry, no special packaging format

**What we ruled out**:

- Dynamic libraries
  - Maximum performance but requires ABI stability, C FFI, and platform-specific builds
  - Plugin authors must use Rust, C, or languages with C FFI — defeats language agnosticism
- WASM
  - Good isolation and portability, but WASI support for filesystem and network access is immature
  - Plugin authors would need WASM-compatible toolchains, which is an adoption barrier
- Language-specific SDKs
  - Would require maintaining SDKs in every language AQL wants to support
  - Each SDK duplicates protocol logic; the JSON-RPC approach means the "SDK" is just `readline()` + `JSON.parse()`

**Trade-offs accepted**: JSON-RPC over stdio adds serialization overhead compared to in-process calls. For code resolution (the hot path), this means microseconds-to-milliseconds per file. The built-in tree-sitter resolver remains the default fast path; plugins are for cases where fidelity or capability matters more than raw speed.

---

## 13. Implementation Language: Rust vs TypeScript

**Context**: The reference implementation needs a language. The early design assumed TypeScript (the RFC shows `npx` invocations, `aql.select()` TypeScript examples, and the Code Resolver discussion centers on Babel/TypeScript compiler adapters). The question is whether TypeScript is the right choice for the shipping implementation.

**Options considered**:

| Option | Description |
|--------|-------------|
| TypeScript (Node.js) | Natural fit for the JS ecosystem; direct access to Babel, TypeScript compiler, ESLint parsers |
| Rust | Single static binary; no runtime; fast startup; tree-sitter for parsing |
| Go | Static binary; good CLI tooling ecosystem; simpler than Rust |

**Decision**: Rust

**Rationale**:

- Zero-dependency distribution
  - The MCP server is a single static binary — no Node.js, no `npx`, no `node_modules`
  - Users install via `brew install`, `curl | sh`, or download one file
  - MCP hosts launch it directly: `"command": "aql-mcp-server"` — no runtime wrapper
  - This matters because MCP servers are spawned as subprocesses by host apps; requiring Node.js adds a dependency that not every environment has
- Startup time
  - MCP servers are short-lived subprocesses spawned per-session
  - A Rust binary starts in single-digit milliseconds; a Node.js process with `npx` resolution takes hundreds of milliseconds to seconds
  - For `aql_select` (the most common operation), the entire round-trip — startup, annotation index load, selector parse, query, response — should be imperceptible
- tree-sitter for Code Resolvers
  - tree-sitter grammars exist for every major language, are written in C, and have first-class Rust bindings
  - A single resolver framework covers Rust, Go, TypeScript, Python, Java, etc. without pulling in each language's native toolchain
  - The TypeScript approach would require Babel for JS/TS, a Go parser for Go, a Python parser for Python — each with its own runtime and dependency chain
  - tree-sitter trades some fidelity (it doesn't understand type-level semantics) for universal coverage; for AQL's purposes (extracting functions, structs, classes, and their names/visibility/modifiers), this is sufficient
- Correctness guarantees
  - Rust's type system and ownership model eliminate classes of bugs (null pointer dereferences, data races, use-after-free) that would require runtime discipline in TypeScript or Go
  - The `CodeResolver` trait enforces a consistent interface across all language adapters at compile time
- Cross-platform
  - cargo-dist produces binaries for macOS (ARM + x86), Linux (glibc + musl, ARM + x86) from a single CI workflow
  - No platform-specific Node.js native module issues

**What we ruled out**:

- TypeScript
  - Would have direct access to the TypeScript compiler and Babel, making JS/TS resolution trivially correct
  - But requires Node.js at runtime, which is a hard dependency for a tool that should work in any environment
  - Startup overhead matters for short-lived MCP subprocesses
  - Using tree-sitter from Rust for JS/TS parsing sacrifices some type-level fidelity but avoids the Node.js runtime dependency entirely
- Go
  - Also produces static binaries with fast startup
  - tree-sitter bindings exist but are less mature than Rust's
  - Rust was preferred for its stronger type system guarantees and the existing tree-sitter ecosystem

**Trade-offs accepted**: The TypeScript/Babel resolver path would produce higher-fidelity code elements for JS/TS files (full type resolution, decorator metadata, Flow support). tree-sitter-based resolution is structural only — it sees syntax, not types. For AQL's use case (anchoring annotations to named code elements), structural parsing is sufficient. If full type resolution becomes necessary, a future TypeScript resolver could run as a separate optional adapter.

---

## 12. MCP Server: One Per Project, Annotation-Only Queries Skip Parsing

**Context**: Agents need a way to query annotations without importing a library. The MCP (Model Context Protocol) provides a standard tool-calling interface over stdio that any MCP-compatible host (Claude Desktop, Claude Code, etc.) can use. The question is how to structure the server: one per workspace vs one per project, and which operations require source code parsing.

**Options considered**:

| Option | Description |
|--------|-------------|
| Single server, multi-project | One server handles multiple projects via a `project` parameter per request |
| One server per project | Separate server instance for each project, scoped via `--project` flag at startup |
| Library-only (no server) | Agents import AQL directly, no MCP layer |

**Decision**: One MCP server per project. Annotation-only queries (`aql_select`, `aql_schema`, `aql_validate`, `aql_repair`) never parse source code. Only `aql_select_annotated` parses source, and only for a single file.

**Architecture**:

```
Agent (Claude Desktop / Claude Code)
  │
  ▼
MCP stdio transport
  │
  ▼
aql-mcp-server --project /path/to/project
  │
  ├── Startup: parse .config/aql.schema, index all .aql → memory
  │
  ├── aql_schema          → return manifest (no parsing)
  ├── aql_select           → query annotation index (no parsing)
  ├── aql_select_annotated → parse source file + match annotations (single file)
  ├── aql_validate         → check annotations vs schema (no parsing)
  └── aql_repair           → suggest selector fixes (no parsing for basic, source for advanced)
```

**Rationale**:

- One server per project
  - Eliminates ambiguity about which project a query targets
  - The `--project` flag at startup scopes everything; no per-request routing
  - Multi-project setups use multiple MCP server instances, which host apps already support
  - Keeps the server stateless within a project (one manifest, one annotation index)
- Annotation queries skip source parsing
  - `aql_select` is the most common operation: "find all controllers", "find all code owned by @backend"
  - These queries only need annotation data (`.aql` files), not source code
  - Building the full annotation index at startup (XML parsing) makes all `aql_select` calls O(n) over the index, not O(files × parse time)
  - Source parsing is expensive and language-specific; keeping it out of the common path means the server works for any language even before a resolver adapter exists
- Code queries are per-file only
  - `aql_select_annotated` requires parsing source, which is expensive
  - Requiring a `file` parameter bounds the cost: parse one file, not the whole project
  - This matches real agent workflows: the agent already knows which file it's looking at and wants to know what annotations exist on specific code elements

**What we ruled out**: Single multi-project server adds routing complexity with no benefit (MCP hosts already handle multiple servers); library-only approach requires agents to have a Node.js runtime and import AQL, which not all MCP clients support

**Impact**: This decision introduces 5 MCP tools as the primary agent interface. The Rust library API (`aql-engine`) remains available for programmatic use, CI integration, and build tool plugins.

---

## 11. Code Resolver: Adapter Pattern with Parser Auto-Detection

**Context**: The Code Resolver parses source files into universal CodeElements. This raises several interrelated problems:

- Different projects use different syntax configurations (TypeScript vs Flow, with or without decorators, JSX, etc.)
- Agents use AQL across multiple projects on the filesystem, each configured differently
- New file extensions and syntax features can appear at any time; file extensions alone don't indicate syntax (`.js` could be Flow, plain JavaScript, or JSX)
- Build tools, editors, and linters already parse source code; re-parsing wastes work and risks inconsistency
- Syntax is composable: JavaScript + JSX + Flow + decorators are independent layers, and projects combine them differently

**Options considered**:

| Option | Description |
|--------|-------------|
| Custom parsers per language | Build AQL-specific parsers for each language |
| Tree-sitter exclusively | Use Tree-sitter grammars for all languages |
| Adapter pattern | Delegate to existing parsers, transform their AST → CodeElement |
| Permissive fallback only | Always parse with all syntax plugins enabled |

**Decision**: Adapter pattern with project-level parser auto-detection

**Architecture**:

```
Source Code
  │
  ▼
Detect project root (walk up to .config/aql.schema)
  │
  ▼
Discover parser config (tsconfig.json, .babelrc, .flowconfig, etc.)
  │
  ▼
Existing Parser (Babel, TypeScript compiler, Tree-sitter, etc.)
  │
  ▼
Language-specific AST
  │
  ▼
AQL Resolver (thin adapter)
  │
  ▼
Universal CodeElement
```

**Rationale**:

- Resolvers are adapters, not parsers
  - They delegate to battle-tested parsers (Babel, TypeScript compiler, Tree-sitter, etc.)
  - They transform the resulting AST into AQL's universal CodeElement model
  - AQL does not re-implement parsing
- Project config auto-detection
  - Walk up from file to find project root (`.config/aql.schema`, falling back to `.git`/`package.json`)
  - Discover parser configuration from existing project files:
    - `tsconfig.json` → TypeScript parser with project settings
    - `.babelrc` / `babel.config.js` → Babel parser with configured plugins
    - `.flowconfig` → Flow parser
  - Cache discovered config per project root
- Syntax is composable and must be respected
  - JavaScript syntax varies by project: base ES version + JSX + Flow or TypeScript + decorators + pipeline operator + ...
  - Each extension layers on top of the base language
  - If a project's `.babelrc` includes `@babel/plugin-syntax-decorators`, AQL uses that same configuration
  - This principle extends to any language: Rust editions, Go versions, Python type annotation styles
- File extensions are unreliable
  - `.js` could be plain JavaScript, Flow, or JSX depending on project config
  - New extensions can emerge (e.g., a hypothetical `.fts` with novel syntax layered on TypeScript)
  - The resolver must parse unknown extensions correctly for the syntax features it does recognize, without breaking on syntax it doesn't
  - Parser configuration comes from the project, not the file extension
- Integrations can provide pre-parsed ASTs
  - Build tools (webpack, Vite) already have ASTs during compilation
  - Editors (VS Code, via LSP) already have ASTs from the language service
  - Linters (ESLint) already have ASTs from their parser
  - AQL integrations can bypass the parsing step entirely by providing an existing AST
  - The resolver accepts either a file path (parse it) or a pre-parsed AST (transform it directly)
- Graceful fallback
  - If no project config is found, use a permissive parser (e.g., Babel with common syntax plugins enabled)
  - Warn when falling back so the user knows config was not auto-detected

**What we ruled out**: Custom parsers per language re-invent solved problems at massive scope; Tree-sitter exclusively doesn't respect project-specific syntax configuration (Babel plugins, TypeScript compiler options); relying on file extensions alone breaks on `.js` files with Flow, projects with custom extensions, and any future syntax layering

---

## 10. Project Configuration: `.config/aql.schema` vs `.annotations/schema.yaml`

**Context**: The schema manifest needs a canonical location in the project. Originally proposed at `.annotations/schema.yaml` in the project root ([Decision 7](#7-tag-discovery-schema-manifest-vs-convention-vs-scanning)). A growing ecosystem convention places tool configuration in a `.config/` directory to reduce root-level clutter <sup>[[7]](#references)</sup>.

**Options considered**:

| Option | Description |
|--------|-------------|
| `.annotations/schema.yaml` | Schema lives in the annotation directory alongside data |
| `.config/aql.schema` | Follows the `.config/` convention; separates config from annotation data |
| Support both | Auto-discover whichever exists |

**Decision**: `.config/aql.schema` for project configuration; `.aql` sidecars for annotation data. Integrations can override config discovery via callbacks.

**Default behavior**: AQL always looks for `.config/aql.schema`. Walk up from the file being queried, stop at the first directory containing `.config/aql.schema`. That directory is the project root.

**Custom discovery**: Integrations that need a different location (e.g., a build tool embedding AQL config inside its own config, or an editor with workspace-level settings) can provide a callback to override config resolution. The core library does not search multiple locations or guess — it uses `.config/aql.schema` unless told otherwise programmatically.

**Rationale**:

- Separation of concerns
  - Project configuration (schema definitions, resolver settings, workspace includes) is fundamentally different from annotation data (`.aql` sidecars next to source files)
  - Mixing them in `.annotations/` conflates tooling config with the data it governs
- `.config/` is the emerging standard
  - Tools using cosmiconfig/lilconfig already support `.config/` (e.g., Stylelint)
  - ESLint has an active proposal for `.config/` support <sup>[[7]](#references)</sup>
  - Placing AQL config here aligns with the ecosystem direction
- Reduces root clutter
  - One `.config/` directory shared across tools, rather than each tool adding its own dotfile or dotdir to the project root
- One canonical location, extensible via code
  - No ambiguity about which file takes precedence — it's always `.config/aql.schema`
  - Integrations that genuinely need a different location hook in via callback, keeping the default simple and predictable
  - This avoids cosmiconfig-style multi-location search where users must reason about which of several files is actually being read
- Natural home for future configuration
  - Resolver settings, workspace includes for monorepos, CI validation options, and schema inheritance (`extends`) all belong in project config, not in the annotation data directory
- Project boundary marker
  - `.config/aql.schema` serves as the project root marker for walk-up discovery (same algorithm as `tsconfig.json`, `Cargo.toml`, `go.mod`)
  - When an agent queries a file, AQL walks up parent directories until it finds `.config/aql.schema`

**What we ruled out**: `.annotations/schema.yaml` mixes configuration with data; cosmiconfig-style multi-location search introduces ambiguity about which file is authoritative

**Impact on previous decisions**: This supersedes the location specified in [Decision 7](#7-tag-discovery-schema-manifest-vs-convention-vs-scanning); the schema manifest concept remains unchanged, only its file path changes from `.annotations/schema.yaml` to `.config/aql.schema`

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

See the [AQL specification](./SPEC.md#aql-agent-query-language) for the repair API

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

See the RFC's [Scope Principle](./SPEC.md#scope-principle) for the canonical definition

**What we ruled out**: "Annotate everything" creates unsustainable maintenance burden; "hybrid with convenience flags" blurs the scope boundary and invites scope creep

---

## 7. Tag Discovery: Schema Manifest vs Convention vs Scanning

> **Note**: The manifest location has been updated from `.annotations/schema.yaml` to `.config/aql.schema`; see [Decision 10](#10-project-configuration-configaqlyaml-vs-annotationsschemayaml)

**Context**: When an agent encounters a project, how does it know what annotation tags are available to query?

**Options considered**:

| Option | Description |
|--------|-------------|
| Schema manifest | `.annotations/schema.yaml` at project root defines all tags |
| Convention-based | Tags follow naming patterns, agents infer from usage |
| File scanning | Agent reads all `.aql` files to discover tags |
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

See the [Schema Manifest specification](./SPEC.md#schema-manifest) for details

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

See [Code Elements](./SPEC.md#code-elements) for the full universal vocabulary

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

**Extensions over standard CSS**: Param-list matching (`params=(foo, bar=10)`) and `$N` positional bindings extend CSS selectors for code-specific needs; see the [Selector Syntax specification](./SPEC.md#selector-syntax)

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

## 3. XML vs YAML vs JSON vs Custom Format

**Context**: External annotation files need a serialization format. Annotations are trees of tagged elements with attributes — the format must handle nesting naturally and parse efficiently at scale.

**Options considered**:

| Option | Description |
|--------|-------------|
| XML | Tree-native, streaming-parseable, attribute-native |
| YAML | Human-readable, supports comments, indentation-based nesting |
| JSON | Universal, strict, no ambiguity |
| TOML | Good for config, less suited for nested data |
| Custom DSL | Purpose-built syntax |

**Decision**: XML (`.aql`)

**Rationale**:
- Annotations are trees with attributes — XML's native data model
  - Tag name = annotation type, XML attributes = metadata, nesting = parent-child scope
  - `<controller bind="create" method="POST" />` — the annotation *is* the markup
  - YAML approximates this with indentation and key-value maps, adding a layer of indirection
- Streaming zero-copy parsing
  - XML parsers can read events (start tag, attribute, end tag) without allocating the full document tree
  - For large projects with thousands of sidecar files, this is an order-of-magnitude advantage over YAML (which must parse the entire document before traversal)
- No ambiguity
  - XML has no implicit type coercion (YAML's Norway problem: `NO` becomes `false`)
  - Attribute values are always strings; type coercion is explicit in the engine
- Comments
  - XML supports `<!-- comments -->`, preserving the ability to document intent within sidecar files
- Familiar syntax
  - Anyone who reads HTML can read `.aql` files
  - `<tag attr="value">` is universally understood

**Trade-offs accepted**: XML is more verbose than YAML for deeply nested structures. In practice, annotation files are shallow (1-2 levels of nesting) with most metadata in attributes, so verbosity is minimal. XML also requires closing tags for nested elements, but self-closing tags (`<tag />`) handle the common case of leaf annotations.

**What we ruled out**: YAML is slower to parse and its indentation sensitivity creates subtle bugs in machine-generated files; JSON is verbose for human authoring (requires quoting every key, no comments); TOML handles flat config well but nested annotation trees poorly; a custom DSL would require a parser and add learning curve

---

## 2. Sidecar Files vs Centralized Store

**Context**: Once annotations moved external (see [Decision 1](#1-inline-comments-vs-external-annotation-files)), the question became *where* they live

**Options considered**:

| Option | Description |
|--------|-------------|
| Sidecar files | `Foo.tsx.aql` alongside `Foo.tsx` |
| Centralized directory | `.annotations/src/components/Foo.tsx.yaml` mirroring the source tree |
| Database/service | Annotations stored in a queryable backend |

**Decision**: Sidecar files (`.aql` suffix alongside source)

**Rationale**:
- Locality
  - Sidecar files appear next to the source file in the file tree
  - Obvious which annotations belong to which code
- Git diffs
  - Changes to annotations for `Foo.tsx` show up in `Foo.tsx.aql`
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
| External sidecar files | `.aql` files alongside source files |
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

1. **^** ["Agent Annotation Schema — RFC"](./SPEC.md), full specification (scope principle, code elements, selectors, AQL)
2. **^** ["Walkthrough: Grafana"](./WALKTHROUGH.md), applied to Grafana's Go + TypeScript codebase
3. **^** Codd, E. F., ["A Relational Model of Data for Large Shared Data Banks"](https://doi.org/10.1145/362384.362685), *Communications of the ACM* 13, no. 6 (June 1970): 377-387
4. **^** Chamberlin, D. D. and R. F. Boyce, ["SEQUEL: A Structured English Query Language"](https://doi.org/10.1145/800296.811515), *Proceedings of the 1974 ACM SIGFIDET Workshop*, 249-264
5. **^** Chamberlin, D. D., ["Early History of SQL"](https://doi.org/10.1109/MAHC.2012.61), *IEEE Annals of the History of Computing* 34, no. 4 (Oct-Dec 2012): 78-82
6. **^** International Organization for Standardization, [*ISO/IEC 9075:2023 — Database languages SQL*](https://www.iso.org/standard/76583.html), 9th ed., Geneva: ISO, 2023
7. **^** ["Change Request: Support `.config` directory"](https://github.com/eslint/eslint/issues/18294), ESLint issue #18294; see also [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) which supports `.config/` by default
