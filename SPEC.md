- Start Date: 2026-01-28
- RFC PR: (leave this empty)
- Issue: (leave this empty)

[← Home](./README.md)

# Agent Annotation Schema

## Contents

- [Summary](#summary)
- [Basic Example](#basic-example)
- [Motivation](#motivation)
- [Detailed Design](#detailed-design)
  - [Schema Presets](#schema-presets)
    - [External Standards Alignment](#external-standards-alignment)
    - [Advanced Extension Mechanisms](#advanced-extension-mechanisms)
  - [Example Taxonomies (Non-Normative)](#example-taxonomies-non-normative)
  - [Extractors](#extractors)
  - [MCP Server](#mcp-server)
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

**Code Resolver** (bottom) transforms source files from any language into a universal code element tree. Rather than implementing its own parsers, it delegates to existing ones (Babel, TypeScript compiler, Tree-sitter, etc.) and transforms their ASTs into the uniform CodeElement model <sup>[[1]](#references)</sup>. It auto-detects parser configuration from project files (`tsconfig.json`, `.babelrc`, `.flowconfig`), respecting each project's syntax settings. Integrations that already have a parsed AST (build tools, editors, linters) can provide it directly, avoiding re-parsing.

**Annotation Store** (middle) manages external `.ann.yaml` sidecar files. Each annotation uses a code selector to anchor itself to a specific code element. The store validates annotations against the schema manifest (`.config/aql.yaml`) and resolves anchors via the Code Resolver.

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

The schema manifest lives at `.config/aql.yaml` in the project root <sup>[[1]](#references)</sup>. It defines the vocabulary of annotation tags and their attributes, and serves as the project boundary marker for AQL tooling.

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

### Schema Presets

Rather than defining all tags in a single schema manifest, AQL supports community-contributed schema presets that users import into their config. This model is inspired by [ESLint shareable configs](https://eslint.org/docs/latest/extend/shareable-configs) (`eslint-config-*` packages with `extends`) and [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) (community-contributed `@types/*` packages).

#### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Community Presets                          │
│  @aql/preset-graphql    @aql/preset-express    @aql/preset-grpc  │
│  @aql/preset-fastapi    @aql/preset-hacklang   @aql/preset-trpc  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ extends
┌─────────────────────────────────────────────────────────────┐
│                   Project Schema Manifest                    │
│  .config/aql.yaml                                           │
│  - imports presets                                          │
│  - adds project-specific tags                               │
│  - configures extractors                                    │
└─────────────────────────────────────────────────────────────┘
```

#### Manifest with Presets

```yaml
version: "1.0"

# Import community presets
extends:
  - "@aql/graphql"        # GraphQL query/mutation/subscription tags
  - "@aql/express"        # HTTP endpoint tags + extractor
  - "@aql/hacklang"       # Hack-specific patterns

# Project-specific tags (supplement presets)
tags:
  internal-api:
    description: Internal-only endpoints
    attrs:
      team: { type: string }

# Project-specific extractors
extractors:
  - name: custom-routes
    run: node scripts/extract-routes.js
```

#### Preset Package Structure

Presets are npm packages following a standard structure:

```
@aql/preset-graphql/
├── package.json
├── index.yaml          # Schema definition
├── extractor.js        # Optional extractor script
└── README.md
```

**index.yaml** (preset schema):
```yaml
name: "@aql/graphql"
version: "1.0.0"
description: GraphQL operation tags for AQL

tags:
  graphql-query:
    description: GraphQL query resolver
    attrs:
      field: { type: string, required: true }
      args: { type: string[] }

  graphql-mutation:
    description: GraphQL mutation resolver
    attrs:
      field: { type: string, required: true }
      args: { type: string[] }

  graphql-subscription:
    description: GraphQL subscription resolver
    attrs:
      field: { type: string, required: true }
      channel: { type: string }
```

#### Preset Resolution Rules

1. Presets are loaded in the order listed in `extends`
2. Later presets override earlier ones (like CSS cascade)
3. Project-level `tags` override all presets
4. Tag names must not conflict (error if the same tag is defined twice without explicit override)

#### Tag Design Philosophy

The core spec does not mandate a base `endpoint` tag or inheritance model. Preset authors decide how to structure their tags:

- **Option A**: Define protocol-specific tags (`graphql-query`, `http-endpoint`, `grpc-method`)
- **Option B**: Use a unified `endpoint` tag with protocol attrs
- **Option C**: Mix both approaches

This flexibility allows presets to evolve based on community feedback. The spec only requires:
1. Tags have unique names (no conflicts between presets without explicit override)
2. Tags define their attrs with types
3. Extractors output JSON matching the tag schema

#### External Standards Alignment

Rather than inventing new formats, AQL adopts existing popular standards wherever possible:

| Concern | Standard | Usage in AQL |
|---------|----------|--------------|
| Type validation | [JSON Schema](https://json-schema.org/) | Custom types use JSON Schema keywords (`pattern`, `format`, `minimum`, `maxLength`) |
| Expression language | [CEL](https://github.com/google/cel-spec) (Common Expression Language) | `when` clauses, `computed` attrs, complex conditions |
| Duration format | [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601#Durations) | Duration attrs use `PT1H30M` format (or shorthand `1h30m`) |
| Timestamps | [RFC 3339](https://datatracker.ietf.org/doc/html/rfc3339) | `generated-at`, `reviewed-at` meta-attrs |
| Cron schedules | [Cron syntax](https://en.wikipedia.org/wiki/Cron#CRON_expression) | `schedule` attrs in background jobs |
| API definitions | [OpenAPI 3.x](https://swagger.io/specification/) | HTTP endpoint attrs align with OpenAPI operation objects |
| Event definitions | [CloudEvents](https://cloudevents.io/) | Event attrs align with CloudEvents spec |
| Async APIs | [AsyncAPI](https://www.asyncapi.com/) | Message queue/pub-sub attrs align with AsyncAPI |
| Observability | [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/) | Span, metric, and trace attrs use OTel naming |
| Auth scopes | [OAuth 2.0](https://oauth.net/2/) | Scope attrs use OAuth scope syntax |
| Auth claims | [OIDC](https://openid.net/connect/) | Identity attrs align with OIDC standard claims |

**Benefits of alignment:**
- Developers already know these formats
- Tools can import/export with existing ecosystems
- Validation libraries already exist
- Documentation and examples are abundant

**Example: Using CEL for expressions**

[CEL (Common Expression Language)](https://github.com/google/cel-spec) is used by Kubernetes, Firebase, Google Cloud IAM, and many other projects. AQL adopts CEL for all expression evaluation:

```yaml
tags:
  endpoint:
    attrs:
      method: { type: string }
      path: { type: string }

      # CEL expression for conditional requirement
      requires-body:
        type: boolean
        when: "method in ['POST', 'PUT', 'PATCH']"
        default: true

      # CEL expression for computed value
      operation-id:
        type: computed
        expr: "method.lowerAscii() + '_' + path.replace('/', '_').replace('{', '').replace('}', '')"

  rate-limit:
    attrs:
      requests: { type: number }
      window: { type: duration }  # ISO 8601: PT1M, PT1H

      # CEL: complex condition
      applies-when:
        type: string
        description: "CEL expression evaluated at runtime"
        # Example value: "request.auth.claims.tier != 'enterprise'"
```

**Example: JSON Schema for custom types**

Custom types use [JSON Schema](https://json-schema.org/) keywords directly:

```yaml
types:
  # JSON Schema string format
  email:
    type: string
    format: email

  # JSON Schema pattern (regex)
  slug:
    type: string
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    minLength: 1
    maxLength: 100

  # JSON Schema number constraints
  percentage:
    type: number
    minimum: 0
    maximum: 100

  # JSON Schema with custom format (ISO 8601 duration)
  duration:
    type: string
    format: duration  # ISO 8601: PT1H30M5S
    examples: ["PT1H", "PT30M", "PT1H30M"]

  # JSON Schema enum
  http-method:
    type: string
    enum: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS]
```

**Example: OpenTelemetry semantic conventions**

Observability attrs use [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/) naming:

```yaml
tags:
  span:
    attrs:
      # OTel standard span attributes
      "span.kind": { type: enum, values: [internal, server, client, producer, consumer] }
      "http.method": { type: string }
      "http.route": { type: string }
      "http.status_code": { type: number }
      "db.system": { type: string }
      "db.statement": { type: string }
      "messaging.system": { type: string }
      "messaging.destination": { type: string }
```

#### Advanced Extension Mechanisms

To enable 100% coverage of arbitrary scenarios via plugins, presets support these advanced mechanisms:

**Tag Inheritance**: Tags can extend other tags, inheriting attrs and adding new ones:

```yaml
tags:
  # Base tag (can be in a preset or same manifest)
  endpoint:
    description: Base API operation
    attrs:
      intent: { type: enum, values: [read, write, subscribe] }
      auth: { type: enum, values: [none, required, optional] }

  # Extended tag inherits all attrs from endpoint
  internal-endpoint:
    extends: endpoint
    description: Internal API operation (not exposed publicly)
    attrs:
      # Inherited: intent, auth
      # Added:
      team: { type: string, required: true }
      internal-only: { type: boolean, default: true }
```

When a tag extends another:
- All attrs from the parent are inherited
- Child attrs override parent attrs with the same name
- Child can mark inherited attrs as required or change defaults
- Multiple inheritance is not supported (single `extends` only)

**Custom Types**: Define reusable type definitions using [JSON Schema](https://json-schema.org/) keywords:

```yaml
types:
  # ISO 8601 duration (aligns with JSON Schema "duration" format)
  duration:
    type: string
    format: duration
    description: "ISO 8601 duration like 'PT1H30M', 'PT5S'"
    examples: ["PT1H", "PT30M", "PT1H30M5S"]

  http-path:
    type: string
    pattern: "^/.*"
    description: "HTTP path starting with /"

  semver:
    type: string
    pattern: "^v?\\d+\\.\\d+\\.\\d+(-[\\w.]+)?(\\+[\\w.]+)?$"
    description: "Semantic version string"

  url:
    type: string
    format: uri
    description: "Valid URL"

  percentage:
    type: number
    minimum: 0
    maximum: 100

tags:
  endpoint:
    attrs:
      path: { type: http-path, required: true }
      timeout: { type: duration }
      version: { type: semver }
      docs: { type: url }
```

Custom types use JSON Schema keywords directly:

| JSON Schema Keyword | Applies to | Example |
|--------------------|-----------| --------|
| `type` | all | `string`, `number`, `boolean`, `array`, `object` |
| `format` | string | `uri`, `email`, `date-time`, `uuid`, `duration`, `hostname` |
| `pattern` | string | Regex pattern |
| `minLength`/`maxLength` | string | Length constraints |
| `minimum`/`maximum` | number | Range constraints |
| `enum` | all | Fixed set of values |
| `items` | array | Schema for array elements |
| `$ref` | all | Reference another type |

Built-in formats (from JSON Schema + ISO 8601):
- `uri`, `uri-reference` — URLs
- `email` — Email addresses
- `date-time`, `date`, `time` — RFC 3339 timestamps
- `duration` — ISO 8601 durations (`PT1H30M`)
- `uuid` — UUIDs
- `hostname`, `ipv4`, `ipv6` — Network identifiers
- `regex` — Regular expression

**Conditional Attrs**: Require or validate attrs based on other attr values:

```yaml
tags:
  endpoint:
    attrs:
      protocol: { type: enum, values: [http, graphql, grpc] }

      # HTTP-specific: required when protocol=http
      method:
        type: enum
        values: [GET, POST, PUT, PATCH, DELETE]
        when: "protocol == 'http'"
        required: true

      path:
        type: http-path
        when: "protocol == 'http'"
        required: true

      # GraphQL-specific: required when protocol=graphql
      operation:
        type: enum
        values: [query, mutation, subscription]
        when: "protocol == 'graphql'"
        required: true

      field:
        type: string
        when: "protocol == 'graphql'"
        required: true

      # gRPC-specific
      service:
        type: string
        when: "protocol == 'grpc'"
        required: true
```

The `when` clause uses [CEL (Common Expression Language)](https://github.com/google/cel-spec) syntax:

```cel
// Basic comparisons
protocol == 'http'
status_code >= 400
retries > 0

// Logical operators
protocol == 'http' && method == 'POST'
role == 'admin' || role == 'superuser'
!(deprecated == true)

// Membership tests
method in ['POST', 'PUT', 'PATCH']
'admin' in roles

// String operations
name.startsWith('test_')
path.contains('/api/')
method.lowerAscii() == 'get'

// Existence checks
has(timeout)  // attr is present
!has(deprecated)  // attr is absent
```

CEL is used by Kubernetes, Firebase, Google Cloud IAM, and Envoy. Full CEL spec: https://github.com/google/cel-spec

**References**: Link annotations to each other with type-safe references:

```yaml
tags:
  cache-config:
    description: Cache configuration
    attrs:
      name: { type: string, required: true }
      ttl: { type: duration }
      strategy: { type: enum, values: [lru, lfu, fifo] }

  endpoint:
    attrs:
      method: { type: enum, values: [GET, POST, PUT, DELETE] }
      path: { type: string }
      # Reference to a cache-config annotation
      cache:
        type: ref
        target: cache-config          # Must reference this tag
        by: name                      # Match by this attr
        required: false

  saga-step:
    attrs:
      saga: { type: string }
      step: { type: number }
      # Self-reference: link to another saga-step
      triggers-next:
        type: ref
        target: saga-step
        by: [saga, step]              # Composite key
```

Usage in annotation:

```yaml
annotations:
  - select: 'class[name="UserCache"]'
    tag: cache-config
    attrs:
      name: user-cache
      ttl: "1h"
      strategy: lru

  - select: 'function[name="getUser"]'
    tag: endpoint
    attrs:
      method: GET
      path: /users/{id}
      cache: user-cache               # References the cache-config above
```

Reference validation:
- Validator ensures referenced annotation exists
- Validator ensures referenced annotation has the correct tag
- IDE tooling can provide autocomplete and jump-to-definition
- Queries can follow references: `aql.select('endpoint[cache]').resolve('cache')`

**Computed Attrs**: Derive values from other attrs using CEL expressions:

```yaml
tags:
  endpoint:
    attrs:
      prefix: { type: string, default: "/api" }
      path: { type: string, required: true }
      method: { type: enum, values: [GET, POST, PUT, DELETE] }

      # Computed: concatenation of prefix + path
      full-path:
        type: computed
        expr: "prefix + path"

      # Computed: generate OpenAPI-style operation ID
      operation-id:
        type: computed
        expr: "method.lowerAscii() + '_' + path.replace('/', '_').replace('{', '').replace('}', '')"

      # Computed: conditional default
      timeout:
        type: computed
        expr: "method in ['POST', 'PUT'] ? 'PT30S' : 'PT10S'"
```

Computed attrs use CEL expressions with access to:
- Other attrs by name: `prefix`, `path`, `method`
- CEL string functions: `.lowerAscii()`, `.upperAscii()`, `.contains()`, `.startsWith()`, `.replace()`
- CEL conditionals: `condition ? valueIfTrue : valueIfFalse`
- CEL list operations: `size()`, `map()`, `filter()`, `exists()`
- Code element context: `code.name`, `code.file`, `code.line`

```cel
// Examples of computed expressions

// String manipulation
method.lowerAscii() + path.replace('/', '_')

// Conditional logic
has(custom_timeout) ? custom_timeout : 'PT30S'

// List operations
scopes.map(s, 'scope:' + s).join(',')

// Code context
code.name + '_handler'
```

Computed attrs are:
- Read-only (cannot be set in annotation files)
- Calculated at query time
- Useful for derived identifiers, normalized forms, generated documentation

**Preset Scoping**: Control where presets apply:

```yaml
extends:
  # Simple: apply everywhere
  - "@aql/typescript"

  # Scoped: only apply to specific paths
  - preset: "@aql/express"
    include:
      - "src/api/**"
      - "src/routes/**"
    exclude:
      - "**/*.test.ts"
      - "**/*.spec.ts"

  # Scoped by language
  - preset: "@aql/fastapi"
    languages: ["python"]

  # Scoped by file pattern
  - preset: "@aql/graphql"
    include: ["**/*.resolvers.ts", "**/*.graphql"]
```

Scoping rules:
- `include`: Glob patterns for files where preset applies (default: all)
- `exclude`: Glob patterns for files to skip (default: none)
- `languages`: Language identifiers where preset applies
- When scopes overlap, later presets in the list take precedence
- Project-level tags always apply everywhere (cannot be scoped)

**Deprecation**: Mark tags or attrs as deprecated:

```yaml
tags:
  controller:
    deprecated: true
    deprecated-message: "Use 'endpoint' tag instead"
    deprecated-since: "2.0.0"
    replaced-by: endpoint

  endpoint:
    attrs:
      method: { type: string }
      # Deprecated attr
      http-method:
        type: string
        deprecated: true
        deprecated-message: "Use 'method' instead"
        replaced-by: method
```

Deprecation behavior:
- Deprecated tags/attrs still work (backward compatible)
- Validator emits warnings (not errors) for deprecated usage
- IDE tooling shows strikethrough and suggests replacement
- `aql.validate()` includes deprecation warnings in output

**Meta-Attrs**: Annotations about the annotation itself:

```yaml
annotations:
  - select: 'function[name="processPayment"]'
    tag: endpoint
    attrs:
      method: POST
      path: /payments
    meta:
      generated-by: express-extractor
      generated-at: "2025-01-15T10:30:00Z"
      confidence: 0.95
      needs-review: true
      reviewer: "@security-team"
```

Meta-attrs are separate from tag attrs:
- Not validated against tag schema
- Reserved for tooling, workflow, provenance
- Standard meta-attrs:
  - `generated-by`: Tool that created the annotation
  - `generated-at`: Timestamp of generation
  - `confidence`: Extractor confidence score (0-1)
  - `needs-review`: Flag for human review
  - `reviewer`: Assigned reviewer
  - `reviewed-by`: Who approved it
  - `reviewed-at`: When it was approved

### Example Taxonomies (Non-Normative)

The following taxonomy sections are **examples, not specifications**. They demonstrate how to use the extension mechanisms above to model common patterns. The actual tag definitions belong in community presets, not in this spec.

**Why examples matter:**
- Show how to decompose complex patterns into attrs
- Demonstrate unified vocabulary across frameworks
- Provide starting points for preset authors
- Illustrate real-world usage of extension mechanisms

**What's normative vs non-normative:**

| Normative (must implement) | Non-normative (examples only) |
|---------------------------|-------------------------------|
| Schema manifest format | Specific tag definitions |
| Preset `extends` syntax | Taxonomy vocabularies |
| Extension mechanisms (inheritance, refs, etc.) | Framework mappings |
| Annotation file format | Example queries |
| Selector syntax | Suggested attr names |

Community presets will evolve these examples based on real-world usage. The spec provides the **building blocks**; presets provide the **vocabulary**.

---

### API Operation Taxonomy

API operations (routes, controllers, handlers, procedures) vary widely across frameworks:

| Framework | Term | Example |
|-----------|------|---------|
| Express/Koa | Route handler | `app.get('/users', handler)` |
| NestJS | Controller method | `@Get() findAll()` |
| FastAPI | Path operation | `@app.get("/users")` |
| Django | View | `path('users/', views.list_users)` |
| GraphQL | Resolver | `Query.users`, `Mutation.createUser` |
| gRPC | Service method | `rpc GetUser(...)` |
| tRPC | Procedure | `query`, `mutation` |

A unified model maps these concepts to common vocabulary via two orthogonal dimensions:

**Semantic Intent** (what it does):
- `read` — Fetch data, no side effects (GraphQL Query, REST GET, gRPC read)
- `write` — Modify state (GraphQL Mutation, REST POST/PUT/PATCH/DELETE)
- `subscribe` — Receive ongoing updates (GraphQL Subscription, SSE, WebSocket)

**Communication Pattern** (how it communicates):
- `request-response` — Single request, single response (REST, GraphQL Query/Mutation, gRPC Unary)
- `server-stream` — Single request, stream of responses (SSE, gRPC Server Streaming)
- `client-stream` — Stream of requests, single response (gRPC Client Streaming)
- `bidirectional` — Stream both directions (WebSockets, gRPC Bidirectional)

#### Example Endpoint Tag

This is a non-normative example of a unified `endpoint` tag that presets may use or extend:

```yaml
tags:
  endpoint:
    description: An API operation (route, resolver, procedure, RPC method)
    attrs:
      # Semantic intent
      intent: { type: enum, values: [read, write, subscribe] }

      # Communication pattern
      pattern: { type: enum, values: [request-response, server-stream, client-stream, bidirectional] }

      # Protocol (optional, for mixed codebases)
      protocol: { type: enum, values: [http, graphql, grpc, websocket, sse] }

      # HTTP-specific (when protocol=http)
      method: { type: enum, values: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS] }
      path: { type: string }

      # GraphQL-specific (when protocol=graphql)
      operation: { type: enum, values: [query, mutation, subscription] }
      field: { type: string }

      # gRPC-specific (when protocol=grpc)
      service: { type: string }
      rpc: { type: string }

      # Common
      auth: { type: enum, values: [none, required, optional] }
      deprecated: { type: boolean }

      # Extended (optional, for richer API metadata)
      version: { type: string }              # API version (e.g., "v1", "2024-01-01")
      rate-limit: { type: string }           # Rate limit tier (e.g., "100/min", "tier:premium")
      cache: { type: enum, values: [none, private, public, stale-while-revalidate] }
      idempotent: { type: boolean }          # Safe to retry? Important for writes
      scopes: { type: string[] }             # Required OAuth/permission scopes
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Express | `app.get('/users', ...)` | `endpoint[intent=read, method=GET, path="/users"]` |
| Express | `app.post('/users', ...)` | `endpoint[intent=write, method=POST, path="/users"]` |
| NestJS | `@Get() @Controller('users')` | `endpoint[intent=read, method=GET, path="/users"]` |
| FastAPI | `@app.get("/users")` | `endpoint[intent=read, method=GET, path="/users"]` |
| Django | `path('users/', list_users)` | `endpoint[intent=read, path="/users/"]` |
| GraphQL | `Query.users` | `endpoint[intent=read, operation=query, field="users"]` |
| GraphQL | `Mutation.createUser` | `endpoint[intent=write, operation=mutation, field="createUser"]` |
| GraphQL | `Subscription.userCreated` | `endpoint[intent=subscribe, operation=subscription]` |
| gRPC | `rpc GetUser(Request) returns (Response)` | `endpoint[intent=read, pattern=request-response, rpc="GetUser"]` |
| gRPC | `rpc StreamUpdates(...) returns (stream ...)` | `endpoint[intent=subscribe, pattern=server-stream]` |
| SSE | `res.write('data: ...')` | `endpoint[intent=subscribe, pattern=server-stream, protocol=sse]` |
| WebSocket | `ws.on('message', ...)` | `endpoint[intent=subscribe, pattern=bidirectional, protocol=websocket]` |

#### Query Examples

```typescript
// All read operations across all protocols
aql.select('endpoint[intent="read"]')

// All HTTP POST endpoints
aql.select('endpoint[method="POST"]')

// All streaming endpoints (SSE, WebSocket, gRPC streaming)
aql.select('endpoint[pattern^="server"]')  // server-stream
aql.select('endpoint[pattern="bidirectional"]')

// All GraphQL mutations
aql.select('endpoint[operation="mutation"]')

// All deprecated endpoints
aql.select('endpoint[deprecated]')

// All endpoints requiring auth
aql.select('endpoint[auth="required"]')
```

#### Alternative: Separate Tags per Protocol

Instead of one `endpoint` tag with protocol-specific attrs, presets may define separate tags:

```yaml
tags:
  http-endpoint:
    attrs:
      method: { type: enum, values: [GET, POST, PUT, PATCH, DELETE] }
      path: { type: string }
      intent: { type: enum, values: [read, write] }

  graphql-operation:
    attrs:
      type: { type: enum, values: [query, mutation, subscription] }
      field: { type: string }

  grpc-method:
    attrs:
      service: { type: string }
      method: { type: string }
      pattern: { type: enum, values: [unary, server-stream, client-stream, bidirectional] }

  stream-endpoint:
    attrs:
      protocol: { type: enum, values: [sse, websocket] }
      direction: { type: enum, values: [server-push, bidirectional] }
```

**Trade-off**: Separate tags are more precise but require knowing the protocol to query. A unified `endpoint` tag enables cross-protocol queries but has optional/conditional attrs.

#### Controller Complexity

Real-world controllers involve more than just the handler function. Presets should consider:

**Middleware Chains**: Auth, rate limiting, validation, logging, and caching often live in middleware, not the handler itself. Two approaches:
1. **Flatten**: Include middleware-derived attributes on the `endpoint` tag (`auth`, `rate-limit`, `scopes`)
2. **Compose**: Use separate `middleware` annotations that can be queried alongside endpoints

```yaml
# Option 1: Flattened
- select: 'function[name="createUser"]'
  tag: endpoint
  attrs:
    method: POST
    path: /users
    auth: required
    scopes: ["users:write"]
    rate-limit: "100/min"

# Option 2: Composed (separate middleware annotation)
- select: 'function[name="createUser"]'
  tag: endpoint
  attrs:
    method: POST
    path: /users
    middleware: ["auth", "rate-limit:100"]  # Reference by name
```

**Path Parameters**: Different frameworks use different syntax (`/users/:id`, `/users/{id}`, `/users/<id>`). Preset extractors should normalize to a common format; OpenAPI's `{param}` style is recommended.

**Composite Operations**: Some handlers perform both read and write (e.g., `POST /cart/checkout` reads inventory, writes order). The `intent` attribute can be an array (`[read, write]`) or presets can define a separate `action` intent for non-idempotent operations that don't fit cleanly.

**Request/Response Schemas**: The endpoint tag does not include input/output schemas. These are better represented by linking to OpenAPI/JSON Schema definitions or using separate annotation tags for request validation.

#### Dynamic Routes: Limitations

Some routes cannot be discovered statically or even at startup:

| Pattern | Example | Why Unextractable |
|---------|---------|-------------------|
| Database-driven | Routes from CMS/DB | Requires live DB connection |
| User-generated | Tenant-specific paths | Changes at runtime |
| API-driven | Routes from config API | External dependency |
| Conditional | `if (flag) app.get(...)` | Requires execution context |

Extractors handle "startup-discoverable" routes (Express router stack, Django urlpatterns). Truly dynamic routes are out of scope—users should annotate them manually if needed.

### Event-Driven Taxonomy

Event-driven patterns (message queues, pub/sub, event sourcing) vary across frameworks:

| Framework | Term | Example |
|-----------|------|---------|
| Node EventEmitter | Listener | `emitter.on('user.created', handler)` |
| Kafka | Consumer | `consumer.subscribe({ topic: 'users' })` |
| RabbitMQ | Queue handler | `channel.consume('tasks', handler)` |
| AWS SQS/SNS | Lambda handler | `exports.handler = async (event) => {}` |
| Redis Pub/Sub | Subscriber | `subscriber.subscribe('channel')` |
| NestJS | Event handler | `@OnEvent('user.created')` |
| Spring | Event listener | `@EventListener` |
| Domain Events | Handler | `when(UserCreated event)` |

#### Unified Vocabulary

**Role** (what it does in the event flow):
- `producer` — Emits/publishes events
- `consumer` — Receives/handles events
- `transformer` — Consumes then produces (e.g., enrichment, routing)

**Delivery Semantics**:
- `at-most-once` — Fire and forget, may lose messages
- `at-least-once` — Retries until ack, may duplicate
- `exactly-once` — Transactional, no duplicates (where supported)

**Ordering**:
- `unordered` — No ordering guarantees
- `partition-ordered` — Ordered within partition/key
- `total-ordered` — Global ordering (rare, expensive)

#### Example Event Tag

```yaml
tags:
  event-handler:
    description: Handles an event from a message queue or event bus
    attrs:
      role: { type: enum, values: [producer, consumer, transformer] }
      event: { type: string, required: true }           # Event name/topic
      delivery: { type: enum, values: [at-most-once, at-least-once, exactly-once] }
      ordering: { type: enum, values: [unordered, partition-ordered, total-ordered] }
      idempotent: { type: boolean }                     # Safe to replay?
      partition-key: { type: string }                   # Key for ordering
      dead-letter: { type: string }                     # DLQ topic/queue
      max-retries: { type: number }
      retry-backoff: { type: string }                   # e.g., "exponential:1s:30s"
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Kafka consumer | `@KafkaListener(topics = "orders")` | `event-handler[role=consumer, event="orders", delivery=at-least-once]` |
| SQS Lambda | `exports.handler = async (event) => {}` | `event-handler[role=consumer, event="order-queue", idempotent=true]` |
| RabbitMQ | `channel.consume('tasks', handler)` | `event-handler[role=consumer, event="tasks", delivery=at-least-once]` |
| EventEmitter | `emitter.on('user.created', fn)` | `event-handler[role=consumer, event="user.created", delivery=at-most-once]` |
| Kafka producer | `producer.send({ topic: 'events' })` | `event-handler[role=producer, event="events"]` |

#### Event Handler Complexity

**Idempotency**: Consumers often need to handle redelivery. The `idempotent` attr signals whether the handler is safe to replay. If `false`, agents should look for deduplication logic.

**Dead Letter Queues**: Failed messages often route to a DLQ. The `dead-letter` attr captures this relationship, enabling queries like "what handles DLQ for order events?"

**Saga/Choreography**: Event-driven sagas involve multiple producers and consumers coordinating. Annotations can link related handlers:

```yaml
- select: 'function[name="handleOrderCreated"]'
  tag: event-handler
  attrs:
    role: consumer
    event: order.created
    saga: checkout-flow
    saga-step: 1

- select: 'function[name="handlePaymentProcessed"]'
  tag: event-handler
  attrs:
    role: consumer
    event: payment.processed
    saga: checkout-flow
    saga-step: 2
```

### Background Job Taxonomy

Background jobs (workers, scheduled tasks, async processors) vary across frameworks:

| Framework | Term | Example |
|-----------|------|---------|
| Sidekiq (Ruby) | Worker | `class HardWorker; include Sidekiq::Worker` |
| Celery (Python) | Task | `@app.task` |
| Bull (Node) | Processor | `queue.process(async (job) => {})` |
| Hangfire (.NET) | Job | `BackgroundJob.Enqueue(() => SendEmail())` |
| Laravel | Job | `class ProcessOrder implements ShouldQueue` |
| Spring | Scheduled | `@Scheduled(cron = "0 0 * * *")` |
| Go (cron libs) | Job | `c.AddFunc("@hourly", func() {})` |
| Kubernetes | CronJob | `schedule: "*/5 * * * *"` |

#### Unified Vocabulary

**Trigger** (what starts the job):
- `queue` — Triggered by queue message
- `schedule` — Triggered by cron/interval
- `event` — Triggered by event (overlaps with event-handler)
- `manual` — Triggered by explicit call

**Execution**:
- `sync` — Runs in request context (blocking)
- `async` — Runs in worker process
- `distributed` — Runs across multiple workers

#### Example Job Tag

```yaml
tags:
  background-job:
    description: A background task that runs outside the request cycle
    attrs:
      trigger: { type: enum, values: [queue, schedule, event, manual] }
      schedule: { type: string }                # Cron expression or interval
      queue: { type: string }                   # Queue name
      priority: { type: enum, values: [critical, high, default, low] }
      timeout: { type: string }                 # e.g., "5m", "1h"
      retries: { type: number }
      retry-backoff: { type: string }
      unique: { type: boolean }                 # Prevent duplicate jobs?
      unique-key: { type: string }              # Key for uniqueness check
      concurrency: { type: number }             # Max parallel executions
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Celery | `@app.task(bind=True, max_retries=3)` | `background-job[trigger=queue, retries=3]` |
| Sidekiq | `sidekiq_options queue: 'critical'` | `background-job[trigger=queue, queue="critical", priority=critical]` |
| Bull | `queue.process(5, processor)` | `background-job[trigger=queue, concurrency=5]` |
| Spring | `@Scheduled(cron = "0 0 * * *")` | `background-job[trigger=schedule, schedule="0 0 * * *"]` |
| Laravel | `$this->onQueue('emails')` | `background-job[trigger=queue, queue="emails"]` |

#### Job Complexity

**Uniqueness**: Many job systems support "unique jobs" to prevent duplicates. The `unique` and `unique-key` attrs capture this:

```yaml
- select: 'class[name="SyncUserJob"]'
  tag: background-job
  attrs:
    trigger: queue
    unique: true
    unique-key: "user_id"  # Only one job per user at a time
```

**Job Chains/Workflows**: Complex jobs often chain together (job A triggers job B). Annotations can capture dependencies:

```yaml
- select: 'class[name="ProcessOrderJob"]'
  tag: background-job
  attrs:
    trigger: queue
    triggers: ["SendConfirmationJob", "UpdateInventoryJob"]  # Jobs triggered on success
```

**Timeout and Deadlines**: Jobs may have SLAs. The `timeout` attr captures max execution time, but deadline (must complete by X) is business logic better captured in a separate `sla` attr.

### State Machine Taxonomy

State machines (workflows, lifecycle, status flows) appear in many forms:

| Framework | Term | Example |
|-----------|------|---------|
| XState (JS) | Machine | `createMachine({ states: {...} })` |
| AASM (Ruby) | State machine | `aasm do; state :pending; end` |
| django-fsm | FSM field | `@transition(source='new', target='paid')` |
| Spring Statemachine | StateMachine | `@WithStateMachine` |
| Stateless (.NET) | State machine | `new StateMachine<State, Trigger>()` |
| Domain models | Enum + methods | `order.status = 'shipped'` |
| Database | Status column | `status VARCHAR CHECK (status IN (...))` |

#### Unified Vocabulary

State machines have well-defined concepts that are universal:

**States**: The possible values (e.g., `pending`, `processing`, `completed`, `failed`)

**Transitions**: Valid state changes (e.g., `pending → processing`)

**Guards**: Conditions that must be true for a transition (e.g., "payment received")

**Actions**: Side effects on transition (e.g., "send email on completion")

#### Example State Machine Tag

```yaml
tags:
  state-machine:
    description: A state machine or workflow definition
    attrs:
      entity: { type: string, required: true }  # What has this state (Order, User, etc.)
      field: { type: string }                   # Field name storing state
      states: { type: string[], required: true }
      initial: { type: string }
      terminal: { type: string[] }              # Final states (no outbound transitions)

  state-transition:
    description: A transition in a state machine
    attrs:
      machine: { type: string, required: true } # Reference to state-machine
      from: { type: string[], required: true }  # Source state(s), or ["*"] for any
      to: { type: string, required: true }      # Target state
      trigger: { type: string }                 # Event/method that triggers this
      guard: { type: string }                   # Condition expression
      action: { type: string }                  # Side effect description
```

#### Example: Order Lifecycle

```yaml
# On the Order class/model
- select: 'class[name="Order"]'
  tag: state-machine
  attrs:
    entity: Order
    field: status
    states: [draft, pending, paid, shipped, delivered, cancelled, refunded]
    initial: draft
    terminal: [delivered, cancelled, refunded]

# On the transition methods
- select: 'method[name="submit"]'
  tag: state-transition
  attrs:
    machine: Order
    from: [draft]
    to: pending
    guard: "has_items && has_shipping_address"
    action: "send order confirmation email"

- select: 'method[name="markPaid"]'
  tag: state-transition
  attrs:
    machine: Order
    from: [pending]
    to: paid
    trigger: payment.completed
    action: "notify warehouse"

- select: 'method[name="cancel"]'
  tag: state-transition
  attrs:
    machine: Order
    from: [draft, pending, paid]  # Can cancel from multiple states
    to: cancelled
    guard: "not shipped"
    action: "refund if paid, send cancellation email"
```

#### Query Examples

```typescript
// All terminal states for Order
aql.select('state-machine[entity="Order"]').attr('terminal')

// All transitions that can reach "cancelled"
aql.select('state-transition[to="cancelled"]')

// All transitions with side effects (actions)
aql.select('state-transition[action]')

// What triggers the "shipped" transition?
aql.select('state-transition[to="shipped"]').attr('trigger')
```

#### State Machine Complexity

**Implicit State Machines**: Many codebases have state machines that aren't explicit—just a status column with ad-hoc checks scattered across the code. Annotations can formalize these:

```yaml
# Even without a formal state machine library, annotate the intent
- select: 'field[name="status"]'
  tag: state-machine
  attrs:
    entity: Order
    states: [pending, processing, completed, failed]
    note: "Implicit state machine, transitions scattered across OrderService"
```

**Hierarchical States**: Some machines have nested states (e.g., `active.pending`, `active.processing`). The `states` attr can use dot notation or a separate `substates` attr.

**Parallel States**: XState and others support parallel regions. This is complex enough that it may warrant a separate `parallel-machine` tag or a `parallel: true` attr.

### Data Access Taxonomy

Data access patterns (repositories, ORMs, query builders) vary across frameworks:

| Framework | Term | Example |
|-----------|------|---------|
| TypeORM | Repository | `@EntityRepository(User)` |
| Prisma | Client method | `prisma.user.findMany()` |
| SQLAlchemy | Session query | `session.query(User).filter(...)` |
| Django ORM | Manager/QuerySet | `User.objects.filter(...)` |
| GORM (Go) | DB method | `db.Where(...).Find(&users)` |
| Spring Data | Repository interface | `interface UserRepository extends JpaRepository` |
| ActiveRecord | Model method | `User.where(active: true)` |
| Raw SQL | Query | `SELECT * FROM users WHERE ...` |

#### Unified Vocabulary

**Operation Type**:
- `read` — SELECT, find, get
- `write` — INSERT, UPDATE, DELETE
- `transaction` — Multiple operations in a transaction

**Query Complexity** (for read operations):
- `simple` — Single table, indexed lookup
- `moderate` — Joins, subqueries, moderate filtering
- `complex` — Multiple joins, aggregations, CTEs, full-text search
- `unbounded` — No limit, scans entire table (dangerous)

**Write Pattern**:
- `single` — One row
- `batch` — Multiple rows in one operation
- `upsert` — Insert or update

#### Example Data Access Tag

```yaml
tags:
  data-access:
    description: A database query or data access operation
    attrs:
      operation: { type: enum, values: [read, write, transaction] }
      entity: { type: string }                  # Table/model being accessed
      complexity: { type: enum, values: [simple, moderate, complex, unbounded] }
      write-pattern: { type: enum, values: [single, batch, upsert] }
      indexed: { type: boolean }                # Uses index?
      n-plus-one: { type: boolean }             # Known N+1 risk?
      cache: { type: enum, values: [none, read-through, write-through, write-behind] }
      isolation: { type: enum, values: [read-uncommitted, read-committed, repeatable-read, serializable] }
      timeout: { type: string }                 # Query timeout
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Prisma | `prisma.user.findUnique({ where: { id } })` | `data-access[operation=read, entity=User, complexity=simple, indexed=true]` |
| TypeORM | `repo.find({ relations: ['posts', 'comments'] })` | `data-access[operation=read, entity=User, complexity=moderate, n-plus-one=false]` |
| Raw SQL | `SELECT * FROM users` | `data-access[operation=read, entity=users, complexity=unbounded]` |
| Django | `User.objects.select_related('profile').get(pk=1)` | `data-access[operation=read, entity=User, complexity=simple]` |

#### Data Access Complexity

**N+1 Queries**: A common performance issue. The `n-plus-one` attr explicitly flags whether a query pattern is safe:

```yaml
- select: 'call[name="findMany"]'
  tag: data-access
  attrs:
    operation: read
    entity: Post
    n-plus-one: true
    note: "Loads author separately for each post. Use include: { author: true }"
```

**Transaction Boundaries**: For transactions, annotate the boundary:

```yaml
- select: 'function[name="transferFunds"]'
  tag: data-access
  attrs:
    operation: transaction
    entities: [Account, TransactionLog]
    isolation: serializable
    note: "Must be serializable to prevent double-spend"
```

**Caching Layers**: Data access often involves caching. The `cache` attr captures the pattern, but cache invalidation logic may need a separate annotation linking to the cache key strategy.

### Caching Taxonomy

Caching appears at every layer (browser, CDN, application, database) with varying complexity:

| Framework | Term | Example |
|-----------|------|---------|
| Redis client | Cache ops | `redis.get()`, `redis.setex()` |
| Memcached | Cache ops | `cache.get()`, `cache.set()` |
| React Query | Query cache | `useQuery({ staleTime: 5000 })` |
| Apollo Client | Normalized cache | `cache.writeQuery()` |
| Django | Cache framework | `@cache_page(60)` |
| Spring | Cache abstraction | `@Cacheable("users")` |
| Node (node-cache) | In-memory cache | `cache.set(key, val, ttl)` |
| HTTP | Cache headers | `Cache-Control: max-age=3600` |

#### Unified Vocabulary

**Cache Strategy** (how cache is populated):
- `cache-aside` — Application checks cache, fetches from source on miss, writes to cache
- `read-through` — Cache layer fetches from source on miss automatically
- `write-through` — Writes go to cache and source synchronously
- `write-behind` — Writes go to cache, async flush to source
- `refresh-ahead` — Cache proactively refreshes before expiry

**Invalidation Pattern**:
- `ttl` — Time-based expiration
- `explicit` — Manual invalidation on write
- `event-driven` — Invalidated by events
- `version` — Cache key includes version/hash
- `stale-while-revalidate` — Serve stale, refresh in background

**Cache Level**:
- `l1` — In-process/local memory
- `l2` — Distributed cache (Redis, Memcached)
- `cdn` — Edge cache
- `browser` — Client-side cache

#### Example Cache Tag

```yaml
tags:
  cache-operation:
    description: A caching operation or cached computation
    attrs:
      strategy: { type: enum, values: [cache-aside, read-through, write-through, write-behind, refresh-ahead] }
      invalidation: { type: enum, values: [ttl, explicit, event-driven, version, stale-while-revalidate] }
      level: { type: enum, values: [l1, l2, cdn, browser] }
      ttl: { type: string }                     # e.g., "5m", "1h", "1d"
      key-pattern: { type: string }             # e.g., "user:{userId}", "posts:page:{page}"
      invalidated-by: { type: string[] }        # Events/operations that invalidate
      warm-on: { type: string[] }               # Events that trigger cache warming
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Redis | `redis.setex('user:123', 3600, data)` | `cache-operation[strategy=cache-aside, level=l2, ttl="1h", key-pattern="user:{id}"]` |
| React Query | `useQuery({ queryKey: ['user', id], staleTime: 5 * 60 * 1000 })` | `cache-operation[strategy=cache-aside, level=l1, ttl="5m", invalidation=stale-while-revalidate]` |
| Spring | `@Cacheable(value="users", key="#id")` | `cache-operation[strategy=read-through, key-pattern="users:{id}"]` |
| Django | `@cache_page(60 * 15)` | `cache-operation[strategy=cache-aside, level=l2, ttl="15m"]` |
| HTTP | `Cache-Control: max-age=3600, stale-while-revalidate=60` | `cache-operation[level=cdn, ttl="1h", invalidation=stale-while-revalidate]` |

#### Cache Complexity

**Invalidation Relationships**: The hardest part of caching is knowing when to invalidate. Annotations can explicitly link cache entries to their invalidation triggers:

```yaml
- select: 'function[name="getUserById"]'
  tag: cache-operation
  attrs:
    key-pattern: "user:{userId}"
    ttl: "1h"
    invalidated-by: ["user.updated", "user.deleted"]

- select: 'function[name="updateUser"]'
  tag: cache-invalidation
  attrs:
    invalidates: ["user:{userId}", "user-list:*"]  # Glob patterns
    event: user.updated
```

**Cache Stampede Prevention**: When cache expires, many requests may hit the origin simultaneously. Annotations can flag functions that implement stampede prevention:

```yaml
- select: 'function[name="getPopularPosts"]'
  tag: cache-operation
  attrs:
    stampede-prevention: true  # Uses locking/single-flight
    lock-ttl: "10s"
```

**Multi-Level Caching**: Some systems use L1 (local) + L2 (distributed) caches:

```yaml
- select: 'function[name="getConfig"]'
  tag: cache-operation
  attrs:
    levels: [l1, l2]
    l1-ttl: "30s"
    l2-ttl: "5m"
    note: "Local cache for hot path, Redis for cross-instance consistency"
```

### Resilience Taxonomy

Resilience patterns (circuit breakers, retries, fallbacks, bulkheads) protect systems from cascading failures:

| Framework | Term | Example |
|-----------|------|---------|
| Polly (.NET) | Policy | `Policy.Handle<Exception>().Retry(3)` |
| Resilience4j (Java) | Decorators | `@CircuitBreaker`, `@Retry` |
| Hystrix (Java) | Command | `@HystrixCommand(fallbackMethod=...)` |
| Cockatiel (Node) | Policy | `retry(handleAll, { maxAttempts: 3 })` |
| Tenacity (Python) | Decorator | `@retry(stop=stop_after_attempt(3))` |
| Go (sony/gobreaker) | Circuit breaker | `cb.Execute(func() error {...})` |
| Elixir | Supervisor | `Supervisor.start_link(children, strategy: :one_for_one)` |

#### Unified Vocabulary

**Pattern Type**:
- `retry` — Retry failed operations with backoff
- `circuit-breaker` — Stop calling failing services temporarily
- `timeout` — Limit operation duration
- `bulkhead` — Isolate failures to prevent cascade
- `fallback` — Provide degraded response on failure
- `hedge` — Send parallel requests, take first response

**Circuit State** (for circuit breakers):
- `closed` — Normal operation, requests pass through
- `open` — Failing, requests rejected immediately
- `half-open` — Testing if service recovered

**Backoff Strategy** (for retries):
- `fixed` — Same delay between retries
- `exponential` — Doubling delay (1s, 2s, 4s, 8s...)
- `exponential-jitter` — Exponential with random jitter
- `linear` — Incrementing delay (1s, 2s, 3s, 4s...)

#### Example Resilience Tag

```yaml
tags:
  resilience:
    description: A resilience pattern protecting an operation
    attrs:
      pattern: { type: enum, values: [retry, circuit-breaker, timeout, bulkhead, fallback, hedge] }

      # Retry-specific
      max-attempts: { type: number }
      backoff: { type: enum, values: [fixed, exponential, exponential-jitter, linear] }
      initial-delay: { type: string }           # e.g., "100ms", "1s"
      max-delay: { type: string }
      retryable-errors: { type: string[] }      # Error types to retry

      # Circuit breaker-specific
      failure-threshold: { type: number }       # Failures before opening
      success-threshold: { type: number }       # Successes to close
      open-duration: { type: string }           # How long to stay open

      # Timeout-specific
      timeout: { type: string }

      # Bulkhead-specific
      max-concurrent: { type: number }
      max-wait: { type: string }

      # Fallback-specific
      fallback: { type: string }                # Fallback method/value description
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Resilience4j | `@Retry(name = "api", maxAttempts = 3)` | `resilience[pattern=retry, max-attempts=3]` |
| Polly | `Policy.Handle<HttpRequestException>().WaitAndRetryAsync(3, i => TimeSpan.FromSeconds(Math.Pow(2, i)))` | `resilience[pattern=retry, max-attempts=3, backoff=exponential, initial-delay="1s"]` |
| Hystrix | `@HystrixCommand(fallbackMethod = "getFallback")` | `resilience[pattern=fallback, fallback="getFallback()"]` |
| Resilience4j | `@CircuitBreaker(name = "api", failureRateThreshold = 50)` | `resilience[pattern=circuit-breaker, failure-threshold=50]` |
| Go | `breaker.Execute(fn)` | `resilience[pattern=circuit-breaker, failure-threshold=5, open-duration="30s"]` |

#### Resilience Complexity

**Composed Policies**: Real systems often combine multiple patterns:

```yaml
- select: 'function[name="callPaymentAPI"]'
  tag: resilience
  attrs:
    patterns: [timeout, retry, circuit-breaker, fallback]
    timeout: "5s"
    max-attempts: 3
    backoff: exponential-jitter
    failure-threshold: 5
    fallback: "Return cached last-known-good response"
    note: "Order matters: timeout → retry → circuit-breaker → fallback"
```

**Error Classification**: Not all errors should be retried:

```yaml
- select: 'function[name="createOrder"]'
  tag: resilience
  attrs:
    pattern: retry
    max-attempts: 3
    retryable-errors: ["NetworkError", "TimeoutError", "503"]
    non-retryable: ["400", "401", "409"]  # Client errors, don't retry
```

**Observability Integration**: Circuit breaker state changes are important events:

```yaml
- select: 'class[name="PaymentServiceBreaker"]'
  tag: resilience
  attrs:
    pattern: circuit-breaker
    metrics: ["circuit.state", "circuit.failures", "circuit.successes"]
    alerts-on: [open]  # Alert when circuit opens
```

### Validation Taxonomy

Input validation appears everywhere with varying patterns:

| Framework | Term | Example |
|-----------|------|---------|
| Joi (Node) | Schema | `Joi.object({ email: Joi.string().email() })` |
| Zod (Node) | Schema | `z.object({ email: z.string().email() })` |
| Pydantic (Python) | Model | `class User(BaseModel): email: EmailStr` |
| Marshmallow (Python) | Schema | `class UserSchema(Schema): email = fields.Email()` |
| class-validator (Node) | Decorators | `@IsEmail() email: string` |
| Bean Validation (Java) | Annotations | `@Email String email` |
| FluentValidation (.NET) | Rules | `RuleFor(x => x.Email).EmailAddress()` |
| JSON Schema | Schema | `{ "type": "string", "format": "email" }` |

#### Unified Vocabulary

**Validation Layer**:
- `input` — Request/API input validation
- `domain` — Business rule validation
- `output` — Response/output validation (rare but important for contracts)
- `persistence` — Database constraints

**Validation Mode**:
- `fail-fast` — Stop on first error
- `accumulate` — Collect all errors
- `coerce` — Transform invalid to valid (e.g., trim strings)

**Error Handling**:
- `reject` — Return error, reject input
- `sanitize` — Clean input, continue
- `default` — Use default value

#### Example Validation Tag

```yaml
tags:
  validation:
    description: Input/output validation logic
    attrs:
      layer: { type: enum, values: [input, domain, output, persistence] }
      mode: { type: enum, values: [fail-fast, accumulate, coerce] }
      schema: { type: string }                  # Reference to schema definition
      fields: { type: string[] }                # Fields being validated
      rules: { type: string[] }                 # Rule descriptions
      on-error: { type: enum, values: [reject, sanitize, default] }
      sanitizes: { type: boolean }              # Does it sanitize/transform?
      security: { type: boolean }               # Security-critical validation?
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Zod | `z.object({ email: z.string().email() }).parse(input)` | `validation[layer=input, mode=fail-fast, fields=["email"]]` |
| Pydantic | `class CreateUser(BaseModel): email: EmailStr` | `validation[layer=input, mode=accumulate, schema="CreateUser"]` |
| class-validator | `@IsEmail() @MaxLength(255)` | `validation[layer=input, fields=["email"], rules=["email format", "max 255 chars"]]` |
| Bean Validation | `@Valid @RequestBody User user` | `validation[layer=input, mode=accumulate]` |

#### Validation Complexity

**Security-Critical Validation**: Some validation prevents security vulnerabilities:

```yaml
- select: 'function[name="sanitizeHtml"]'
  tag: validation
  attrs:
    layer: input
    security: true
    sanitizes: true
    rules: ["XSS prevention", "Strip script tags", "Whitelist safe HTML"]
    note: "CRITICAL: All user-generated HTML must pass through this"

- select: 'function[name="validateSqlParam"]'
  tag: validation
  attrs:
    layer: input
    security: true
    rules: ["SQL injection prevention", "Parameterized query enforcement"]
```

**Multi-Layer Validation**: The same data often validated at multiple layers:

```yaml
# API layer - format validation
- select: 'class[name="CreateOrderDTO"]'
  tag: validation
  attrs:
    layer: input
    mode: fail-fast
    fields: ["customerId", "items", "shippingAddress"]
    rules: ["Required fields", "Type coercion", "Format validation"]

# Domain layer - business rules
- select: 'method[name="validateOrder"]'
  tag: validation
  attrs:
    layer: domain
    mode: accumulate
    rules: ["Customer exists", "Items in stock", "Shipping address serviceable", "Order total within credit limit"]

# Persistence layer - database constraints
- select: 'class[name="Order"]'
  tag: validation
  attrs:
    layer: persistence
    rules: ["Foreign key: customer_id", "Check: total > 0", "Unique: order_number"]
```

**Validation Dependencies**: Some validations depend on external data:

```yaml
- select: 'function[name="validatePromoCode"]'
  tag: validation
  attrs:
    layer: domain
    requires: ["promo-service"]  # External dependency
    async: true
    cache: "promo:{code}"  # Cacheable validation
```

### Webhook Taxonomy

Webhooks (both inbound and outbound) are a common integration pattern:

| Framework | Term | Example |
|-----------|------|---------|
| Express | Route handler | `app.post('/webhooks/stripe', handler)` |
| FastAPI | Endpoint | `@app.post("/webhooks/github")` |
| Django | View | `path('webhooks/slack/', slack_webhook)` |
| Stripe SDK | Webhook construct | `stripe.webhooks.constructEvent()` |
| Octokit | Webhook handler | `webhooks.on('push', handler)` |
| AWS SNS | HTTP endpoint | Lambda subscribed to SNS topic |
| Svix | Webhook sender | `svix.message.create()` |

#### Unified Vocabulary

**Direction**:
- `inbound` — Receiving webhooks from external services
- `outbound` — Sending webhooks to external consumers

**Security**:
- `signature` — HMAC signature verification
- `mtls` — Mutual TLS
- `ip-whitelist` — Source IP validation
- `token` — Bearer token in header

**Delivery** (for outbound):
- `at-least-once` — Retry until acknowledged
- `best-effort` — Single attempt, no retry

#### Example Webhook Tag

```yaml
tags:
  webhook:
    description: Webhook handler (inbound) or sender (outbound)
    attrs:
      direction: { type: enum, values: [inbound, outbound] }
      provider: { type: string }                # e.g., "stripe", "github", "slack"
      events: { type: string[] }                # Event types handled/sent

      # Security
      security: { type: enum, values: [signature, mtls, ip-whitelist, token, none] }
      signature-header: { type: string }        # e.g., "X-Hub-Signature-256"
      signature-algo: { type: string }          # e.g., "HMAC-SHA256"

      # Delivery (outbound)
      delivery: { type: enum, values: [at-least-once, best-effort] }
      max-retries: { type: number }
      retry-backoff: { type: string }
      timeout: { type: string }

      # Processing (inbound)
      idempotent: { type: boolean }
      idempotency-key: { type: string }         # Header/field containing idempotency key
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Stripe webhook | `stripe.webhooks.constructEvent(body, sig, secret)` | `webhook[direction=inbound, provider=stripe, security=signature, signature-header="Stripe-Signature"]` |
| GitHub webhook | `webhooks.on('push', handler)` | `webhook[direction=inbound, provider=github, events=["push"], security=signature]` |
| Outbound webhook | `fetch(url, { method: 'POST', body: event })` | `webhook[direction=outbound, delivery=at-least-once, max-retries=5]` |
| Slack webhook | `app.post('/slack/events', handler)` | `webhook[direction=inbound, provider=slack, security=signature, idempotent=true]` |

#### Webhook Complexity

**Idempotency Handling**: Webhooks may be delivered multiple times:

```yaml
- select: 'function[name="handleStripeWebhook"]'
  tag: webhook
  attrs:
    direction: inbound
    provider: stripe
    events: ["payment_intent.succeeded", "payment_intent.failed"]
    idempotent: true
    idempotency-key: "event.id"
    note: "Deduplicates using event ID stored in processed_webhooks table"
```

**Event Routing**: Single endpoint handling multiple event types:

```yaml
- select: 'function[name="githubWebhookRouter"]'
  tag: webhook
  attrs:
    direction: inbound
    provider: github
    events: ["push", "pull_request", "issues", "release"]
    routes-to: ["handlePush", "handlePR", "handleIssue", "handleRelease"]
```

**Outbound Webhook System**: For platforms that send webhooks:

```yaml
- select: 'class[name="WebhookDispatcher"]'
  tag: webhook
  attrs:
    direction: outbound
    delivery: at-least-once
    max-retries: 5
    retry-backoff: "exponential:1m:24h"
    timeout: "30s"
    events: ["order.created", "order.updated", "order.cancelled"]
    dead-letter: true  # Failed webhooks stored for manual retry
```

### Observability Taxonomy

Observability (tracing, metrics, logging, health checks) is cross-cutting:

| Framework | Term | Example |
|-----------|------|---------|
| OpenTelemetry | Span | `tracer.startSpan('operation')` |
| Datadog | Trace | `@tracer.wrap()` |
| Prometheus | Metrics | `counter.inc()`, `histogram.observe()` |
| StatsD | Metrics | `statsd.increment('requests')` |
| Micrometer (Java) | Metrics | `@Timed("http.requests")` |
| Sentry | Error tracking | `Sentry.captureException(e)` |
| Pino/Winston | Logging | `logger.info({ userId }, 'User logged in')` |
| Health checks | Endpoint | `GET /health`, `GET /ready` |

#### Unified Vocabulary

**Signal Type**:
- `trace` — Distributed tracing spans
- `metric` — Quantitative measurements
- `log` — Structured log events
- `health` — Health/readiness checks

**Metric Type**:
- `counter` — Monotonically increasing count
- `gauge` — Point-in-time value
- `histogram` — Distribution of values
- `summary` — Quantiles over time

**Health Check Type**:
- `liveness` — Is the process alive?
- `readiness` — Can it serve traffic?
- `startup` — Has it finished initializing?

#### Example Observability Tag

```yaml
tags:
  observability:
    description: Observability instrumentation
    attrs:
      signal: { type: enum, values: [trace, metric, log, health] }

      # Tracing
      span-name: { type: string }
      span-kind: { type: enum, values: [internal, server, client, producer, consumer] }
      attributes: { type: string[] }            # Span attributes captured

      # Metrics
      metric-name: { type: string }
      metric-type: { type: enum, values: [counter, gauge, histogram, summary] }
      labels: { type: string[] }                # Metric labels/dimensions
      unit: { type: string }                    # e.g., "ms", "bytes", "requests"

      # Health checks
      health-type: { type: enum, values: [liveness, readiness, startup] }
      checks: { type: string[] }                # What it checks

      # Common
      slo: { type: string }                     # SLO this supports (e.g., "p99 < 200ms")
      alerts: { type: string[] }                # Alert rules triggered by this
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| OpenTelemetry | `tracer.startSpan('db.query')` | `observability[signal=trace, span-name="db.query", span-kind=client]` |
| Prometheus | `http_requests_total.labels(method='GET').inc()` | `observability[signal=metric, metric-name="http_requests_total", metric-type=counter, labels=["method"]]` |
| Datadog | `@tracer.wrap(service='payment')` | `observability[signal=trace, span-name="payment", attributes=["order_id", "amount"]]` |
| K8s health | `GET /healthz` | `observability[signal=health, health-type=liveness, checks=["process alive"]]` |
| K8s ready | `GET /ready` | `observability[signal=health, health-type=readiness, checks=["db connected", "cache connected"]]` |

#### Observability Complexity

**SLO-Linked Instrumentation**: Connect metrics to SLOs:

```yaml
- select: 'function[name="handleRequest"]'
  tag: observability
  attrs:
    signal: metric
    metric-name: "http_request_duration_seconds"
    metric-type: histogram
    slo: "p99 < 200ms"
    alerts: ["HighLatencyAlert", "ErrorRateAlert"]
```

**Trace Context Propagation**: Mark functions that propagate trace context:

```yaml
- select: 'function[name="callDownstreamService"]'
  tag: observability
  attrs:
    signal: trace
    span-kind: client
    propagates-context: true  # Passes trace headers to downstream
    attributes: ["service.name", "http.method", "http.url"]
```

**Structured Logging**: Define what context is logged:

```yaml
- select: 'function[name="processOrder"]'
  tag: observability
  attrs:
    signal: log
    context-fields: ["orderId", "userId", "correlationId"]
    log-level: info
    sensitive-fields: ["creditCard"]  # Fields to redact
```

**Composite Health Checks**: Health checks that aggregate multiple dependencies:

```yaml
- select: 'function[name="readinessCheck"]'
  tag: observability
  attrs:
    signal: health
    health-type: readiness
    checks: ["database", "redis", "kafka", "external-api"]
    timeout: "5s"
    failure-threshold: 1  # Fail if any check fails
```

### Authentication & Authorization Taxonomy

Auth is more than a boolean—it involves identity providers, token flows, permission models, and session management:

| Framework | Term | Example |
|-----------|------|---------|
| Passport.js | Strategy | `passport.use(new JwtStrategy(...))` |
| Spring Security | Filter chain | `@PreAuthorize("hasRole('ADMIN')")` |
| Django | Permission | `@permission_required('app.view_model')` |
| ASP.NET | Authorize | `[Authorize(Roles = "Admin")]` |
| Casbin | Policy | `e.Enforce(sub, obj, act)` |
| Auth0 SDK | Middleware | `requiresAuth()` |
| AWS IAM | Policy | `Action: s3:GetObject` |
| OAuth2 | Scopes | `scope: 'read:users write:users'` |

#### Unified Vocabulary

**Authentication Method** (how identity is verified):
- `jwt` — JSON Web Token (stateless)
- `session` — Server-side session (stateful)
- `api-key` — Static API key
- `oauth2` — OAuth 2.0 flow
- `saml` — SAML assertion
- `mtls` — Mutual TLS certificate
- `basic` — Basic auth (username/password)

**Authorization Model** (how permissions are checked):
- `rbac` — Role-based access control
- `abac` — Attribute-based access control
- `acl` — Access control lists
- `pbac` — Policy-based access control
- `ownership` — Resource owner check

**Token Location** (where credentials are found):
- `header` — Authorization header
- `cookie` — HTTP cookie
- `query` — Query parameter (discouraged)
- `body` — Request body

#### Example Auth Tags

```yaml
tags:
  auth-provider:
    description: Authentication provider/strategy configuration
    attrs:
      method: { type: enum, values: [jwt, session, api-key, oauth2, saml, mtls, basic] }
      provider: { type: string }                # e.g., "auth0", "okta", "cognito"
      token-location: { type: enum, values: [header, cookie, query, body] }
      refresh: { type: boolean }                # Supports token refresh?
      mfa: { type: boolean }                    # Multi-factor authentication?

  auth-check:
    description: Authorization check on a protected resource
    attrs:
      model: { type: enum, values: [rbac, abac, acl, pbac, ownership] }
      roles: { type: string[] }                 # Required roles (RBAC)
      permissions: { type: string[] }           # Required permissions
      scopes: { type: string[] }                # OAuth scopes required
      resource: { type: string }                # Resource being protected
      action: { type: string }                  # Action being performed
      condition: { type: string }               # ABAC condition expression
      owner-field: { type: string }             # Field to check for ownership
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Passport JWT | `passport.use(new JwtStrategy(opts, verify))` | `auth-provider[method=jwt, token-location=header]` |
| Spring | `@PreAuthorize("hasRole('ADMIN')")` | `auth-check[model=rbac, roles=["ADMIN"]]` |
| Express | `requiresAuth({ scopes: ['read:users'] })` | `auth-check[scopes=["read:users"]]` |
| Django | `@permission_required('app.change_model')` | `auth-check[permissions=["app.change_model"]]` |
| Casbin | `e.Enforce(sub, obj, act)` | `auth-check[model=pbac, resource=$2, action=$3]` |

#### Auth Complexity

**Multi-Tenancy**: Auth often involves tenant isolation:

```yaml
- select: 'function[name="getOrders"]'
  tag: auth-check
  attrs:
    model: abac
    condition: "user.tenantId == resource.tenantId"
    tenant-isolation: true
    note: "Users can only see orders from their own tenant"
```

**Hierarchical Permissions**: Permissions often have inheritance:

```yaml
- select: 'class[name="DocumentController"]'
  tag: auth-check
  attrs:
    model: rbac
    roles: ["editor"]
    inherits-from: ["viewer"]  # Editors implicitly have viewer permissions
    note: "Role hierarchy: admin > editor > viewer"
```

**Context-Dependent Auth**: Some auth depends on request context:

```yaml
- select: 'function[name="updateUser"]'
  tag: auth-check
  attrs:
    model: ownership
    owner-field: "userId"
    or-roles: ["admin"]  # Owner OR admin can update
    note: "Users can update their own profile, admins can update anyone"
```

**Session Management**: For session-based auth:

```yaml
- select: 'class[name="SessionStore"]'
  tag: auth-provider
  attrs:
    method: session
    storage: redis
    ttl: "24h"
    refresh-on-activity: true
    absolute-timeout: "7d"
    concurrent-sessions: 3  # Max sessions per user
```

### Feature Flag Taxonomy

Feature flags (toggles, experiments, rollouts) control feature availability:

| Framework | Term | Example |
|-----------|------|---------|
| LaunchDarkly | Flag | `ldClient.variation('new-checkout', user, false)` |
| Unleash | Toggle | `unleash.isEnabled('feature.newUI')` |
| Split.io | Treatment | `client.getTreatment('user-id', 'feature')` |
| Flagsmith | Flag | `flagsmith.hasFeature('new_feature')` |
| ConfigCat | Flag | `client.getValue('isMyFeatureEnabled', false)` |
| Flipper (Ruby) | Feature | `Flipper.enabled?(:new_feature, user)` |
| Django Waffle | Flag | `@flag_is_active('new_feature')` |
| Homebrew | Feature | `process.env.FEATURE_NEW_UI === 'true'` |

#### Unified Vocabulary

**Flag Type**:
- `release` — Feature release toggle (temporary)
- `experiment` — A/B test or experiment
- `ops` — Operational toggle (kill switch, circuit breaker)
- `permission` — Permission/entitlement toggle

**Rollout Strategy**:
- `boolean` — Simple on/off
- `percentage` — Percentage of users
- `user-list` — Specific user IDs
- `attribute` — Based on user attributes
- `gradual` — Increasing percentage over time

**Lifecycle**:
- `active` — Currently in use
- `stale` — Should be removed (feature fully launched)
- `permanent` — Long-term toggle (ops, permission)

#### Example Feature Flag Tag

```yaml
tags:
  feature-flag:
    description: A feature flag or experiment check
    attrs:
      flag: { type: string, required: true }    # Flag key/name
      type: { type: enum, values: [release, experiment, ops, permission] }
      rollout: { type: enum, values: [boolean, percentage, user-list, attribute, gradual] }
      percentage: { type: number }              # For percentage rollouts
      targeting: { type: string }               # Targeting rule description
      default: { type: string }                 # Default value if flag unavailable
      lifecycle: { type: enum, values: [active, stale, permanent] }
      owner: { type: string }                   # Team owning this flag
      expires: { type: string }                 # Expected removal date
      variants: { type: string[] }              # For multivariate flags
      metrics: { type: string[] }               # Metrics to track
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| LaunchDarkly | `ldClient.variation('new-checkout', user, false)` | `feature-flag[flag="new-checkout", type=release, default="false"]` |
| Split | `client.getTreatment(userId, 'checkout-experiment')` | `feature-flag[flag="checkout-experiment", type=experiment, variants=["control", "variant-a", "variant-b"]]` |
| Unleash | `unleash.isEnabled('kill-switch-payments')` | `feature-flag[flag="kill-switch-payments", type=ops, lifecycle=permanent]` |
| Env var | `process.env.FEATURE_NEW_UI === 'true'` | `feature-flag[flag="FEATURE_NEW_UI", rollout=boolean, type=release]` |

#### Feature Flag Complexity

**Experiment Tracking**: Flags used for experiments need metrics:

```yaml
- select: 'function[name="renderCheckout"]'
  tag: feature-flag
  attrs:
    flag: "checkout-redesign-v2"
    type: experiment
    variants: ["control", "new-design"]
    metrics: ["conversion_rate", "cart_abandonment", "time_to_checkout"]
    hypothesis: "New design increases conversion by 5%"
    owner: "@growth-team"
```

**Flag Dependencies**: Some flags depend on others:

```yaml
- select: 'function[name="showNewDashboard"]'
  tag: feature-flag
  attrs:
    flag: "new-dashboard"
    requires: ["new-api-v2"]  # Must also be enabled
    conflicts: ["legacy-dashboard"]  # Must be disabled
```

**Stale Flag Detection**: Track flags that should be removed:

```yaml
- select: 'function[name="useNewPaymentFlow"]'
  tag: feature-flag
  attrs:
    flag: "new-payment-flow"
    type: release
    lifecycle: stale
    launched: "2025-01-15"  # Fully launched date
    expires: "2025-04-01"   # Remove by this date
    note: "TODO: Remove flag, new flow is now default"
```

### Rate Limiting Taxonomy

Rate limiting protects services from overload and abuse:

| Framework | Term | Example |
|-----------|------|---------|
| Express rate-limit | Middleware | `rateLimit({ windowMs: 60000, max: 100 })` |
| Django Ratelimit | Decorator | `@ratelimit(key='ip', rate='100/m')` |
| Spring | Annotation | `@RateLimiter(name="api", fallback="fallbackMethod")` |
| Kong | Plugin | `rate-limiting: { minute: 100 }` |
| Redis (custom) | Lua script | Token bucket implementation |
| Nginx | Directive | `limit_req_zone ... rate=10r/s` |
| Cloudflare | Rule | Rate limiting rule |
| Stripe API | Headers | `X-RateLimit-Limit: 100` |

#### Unified Vocabulary

**Algorithm**:
- `fixed-window` — Count requests in fixed time windows
- `sliding-window` — Smooth rolling window
- `token-bucket` — Refilling token bucket
- `leaky-bucket` — Constant rate output
- `sliding-log` — Track individual request timestamps

**Scope** (what is rate limited):
- `global` — Total requests to service
- `per-ip` — Per client IP address
- `per-user` — Per authenticated user
- `per-api-key` — Per API key
- `per-tenant` — Per tenant/organization
- `per-endpoint` — Per specific endpoint

**Response** (what happens when limited):
- `reject` — Return 429 Too Many Requests
- `queue` — Queue request for later
- `throttle` — Slow down requests
- `degrade` — Return degraded response

#### Example Rate Limit Tag

```yaml
tags:
  rate-limit:
    description: Rate limiting configuration for an endpoint or service
    attrs:
      algorithm: { type: enum, values: [fixed-window, sliding-window, token-bucket, leaky-bucket, sliding-log] }
      scope: { type: enum, values: [global, per-ip, per-user, per-api-key, per-tenant, per-endpoint] }
      limit: { type: number, required: true }   # Max requests
      window: { type: string, required: true }  # Time window (e.g., "1m", "1h")
      burst: { type: number }                   # Burst allowance
      response: { type: enum, values: [reject, queue, throttle, degrade] }
      tier: { type: string }                    # Rate limit tier (e.g., "free", "pro", "enterprise")
      headers: { type: boolean }                # Include rate limit headers?
      key: { type: string }                     # Custom key expression
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Express | `rateLimit({ windowMs: 60000, max: 100 })` | `rate-limit[algorithm=fixed-window, limit=100, window="1m", scope=per-ip]` |
| Django | `@ratelimit(key='user', rate='1000/h')` | `rate-limit[limit=1000, window="1h", scope=per-user]` |
| Kong | `rate-limiting: { minute: 100, policy: redis }` | `rate-limit[limit=100, window="1m", algorithm=sliding-window]` |
| Token bucket | Custom Redis implementation | `rate-limit[algorithm=token-bucket, limit=100, window="1m", burst=20]` |

#### Rate Limit Complexity

**Tiered Rate Limits**: Different limits for different user tiers:

```yaml
- select: 'function[name="handleApiRequest"]'
  tag: rate-limit
  attrs:
    scope: per-api-key
    tiers:
      free: { limit: 100, window: "1h" }
      pro: { limit: 1000, window: "1h" }
      enterprise: { limit: 10000, window: "1h" }
    headers: true
```

**Endpoint-Specific Limits**: Expensive endpoints get lower limits:

```yaml
- select: 'function[name="generateReport"]'
  tag: rate-limit
  attrs:
    algorithm: token-bucket
    scope: per-user
    limit: 10
    window: "1h"
    burst: 2
    note: "CPU-intensive, limit heavily"

- select: 'function[name="getUser"]'
  tag: rate-limit
  attrs:
    scope: per-user
    limit: 1000
    window: "1m"
    note: "Lightweight read, higher limit"
```

**Distributed Rate Limiting**: For multi-instance deployments:

```yaml
- select: 'class[name="DistributedRateLimiter"]'
  tag: rate-limit
  attrs:
    algorithm: sliding-window
    storage: redis
    sync-interval: "100ms"
    note: "Uses Redis for cross-instance coordination"
```

### Batch Processing Taxonomy

Batch processing (ETL, bulk operations, data pipelines) differs from request-response:

| Framework | Term | Example |
|-----------|------|---------|
| Apache Spark | Job | `spark.read().transform().write()` |
| Apache Beam | Pipeline | `Pipeline.create().apply(transforms)` |
| AWS Glue | Job | ETL job definition |
| dbt | Model | `SELECT ... FROM {{ ref('source') }}` |
| Airflow | DAG | `@dag` decorated function |
| Luigi | Task | `class MyTask(luigi.Task)` |
| Spring Batch | Job | `@EnableBatchProcessing` |
| Pandas | Script | `df.read_csv().transform().to_parquet()` |

#### Unified Vocabulary

**Processing Mode**:
- `batch` — Process all data at once
- `micro-batch` — Small batches with low latency
- `streaming` — Continuous processing (overlaps with event-driven)

**Execution Pattern**:
- `sequential` — Steps run in order
- `parallel` — Steps run concurrently
- `map-reduce` — Fan out, then aggregate
- `dag` — Directed acyclic graph of dependencies

**Checkpointing**:
- `none` — No checkpointing (restart from beginning)
- `periodic` — Checkpoint at intervals
- `per-record` — Checkpoint after each record
- `transactional` — Exactly-once with transactions

#### Example Batch Tag

```yaml
tags:
  batch-job:
    description: A batch processing job or ETL pipeline
    attrs:
      mode: { type: enum, values: [batch, micro-batch, streaming] }
      execution: { type: enum, values: [sequential, parallel, map-reduce, dag] }
      checkpoint: { type: enum, values: [none, periodic, per-record, transactional] }
      source: { type: string[] }                # Input sources
      sink: { type: string[] }                  # Output destinations
      schedule: { type: string }                # Cron schedule
      timeout: { type: string }                 # Max execution time
      retry-failed: { type: boolean }           # Retry failed records?
      parallelism: { type: number }             # Parallel workers/partitions
      idempotent: { type: boolean }             # Safe to re-run?

  batch-step:
    description: A step within a batch pipeline
    attrs:
      job: { type: string, required: true }     # Parent job reference
      order: { type: number }                   # Execution order
      operation: { type: enum, values: [extract, transform, load, validate, aggregate] }
      input: { type: string }                   # Input from previous step
      output: { type: string }                  # Output to next step
      can-skip: { type: boolean }               # Skip on re-run if complete?
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Spark | `spark.read.parquet(src).transform(fn).write.parquet(dst)` | `batch-job[mode=batch, execution=parallel, source=["s3://input"], sink=["s3://output"]]` |
| Airflow | `@dag(schedule='0 0 * * *')` | `batch-job[mode=batch, execution=dag, schedule="0 0 * * *"]` |
| Spring Batch | `@Bean Job importJob()` | `batch-job[mode=batch, execution=sequential, checkpoint=per-record]` |
| dbt | `{{ config(materialized='incremental') }}` | `batch-job[mode=micro-batch, idempotent=true]` |

#### Batch Complexity

**Incremental Processing**: Process only new/changed data:

```yaml
- select: 'class[name="IncrementalUserSync"]'
  tag: batch-job
  attrs:
    mode: micro-batch
    checkpoint: per-record
    watermark: "updated_at"  # Track progress by this field
    lookback: "1h"           # Re-process last hour for late arrivals
    idempotent: true
```

**Error Handling**: What happens when records fail:

```yaml
- select: 'function[name="processOrders"]'
  tag: batch-job
  attrs:
    mode: batch
    retry-failed: true
    max-retries: 3
    dead-letter: "failed_orders"  # Table/queue for failed records
    skip-threshold: 0.01          # Fail job if >1% records fail
```

**Dependencies**: Jobs that depend on other jobs:

```yaml
- select: 'class[name="AggregateMetricsJob"]'
  tag: batch-job
  attrs:
    depends-on: ["ExtractEventsJob", "ExtractUsersJob"]
    wait-for: all  # Wait for all dependencies (vs "any")
```

### Audit Logging Taxonomy

Audit logging tracks who did what for compliance and debugging:

| Framework | Term | Example |
|-----------|------|---------|
| Django Auditlog | Middleware | `AuditlogMiddleware` |
| Spring Data Envers | Annotation | `@Audited` |
| Hibernate Envers | Revision | `@Audited` entity |
| Rails PaperTrail | Gem | `has_paper_trail` |
| Sequelize | Hook | `afterCreate`, `afterUpdate` |
| Jaeger/OTEL | Span | Distributed trace |
| Custom | Logger | `auditLog.record(...)` |
| Database | Trigger | `CREATE TRIGGER audit_trigger` |

#### Unified Vocabulary

**Audit Event Type**:
- `create` — Resource created
- `read` — Resource accessed (sensitive)
- `update` — Resource modified
- `delete` — Resource removed
- `login` — Authentication event
- `permission` — Permission change
- `export` — Data export
- `admin` — Administrative action

**Audit Level**:
- `system` — Infrastructure/system events
- `application` — Business logic events
- `data` — Data access events
- `security` — Security-relevant events

**Retention**:
- `short` — Days (debugging)
- `medium` — Months (operational)
- `long` — Years (compliance)
- `permanent` — Never delete

#### Example Audit Tag

```yaml
tags:
  audit-log:
    description: Audit logging for compliance and traceability
    attrs:
      event: { type: enum, values: [create, read, update, delete, login, permission, export, admin] }
      level: { type: enum, values: [system, application, data, security] }
      resource: { type: string }                # Resource type being audited
      fields: { type: string[] }                # Fields to capture
      actor-field: { type: string }             # Field containing actor ID
      sensitive: { type: boolean }              # Contains PII/sensitive data?
      retention: { type: enum, values: [short, medium, long, permanent] }
      compliance: { type: string[] }            # Compliance frameworks (GDPR, HIPAA, SOC2)
      immutable: { type: boolean }              # Cannot be modified after write?
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Django Auditlog | `@auditlog.register(Model)` | `audit-log[event=[create, update, delete], resource="Model", level=data]` |
| Spring Envers | `@Audited` | `audit-log[event=[create, update, delete], immutable=true]` |
| PaperTrail | `has_paper_trail` | `audit-log[event=[create, update, delete], fields=["*"]]` |
| Custom | `auditLog.record({ action, user, resource })` | `audit-log[event=$1.action, actor-field="user", resource=$1.resource]` |

#### Audit Complexity

**Compliance Requirements**: Different rules for different data:

```yaml
- select: 'class[name="PatientRecord"]'
  tag: audit-log
  attrs:
    event: [create, read, update, delete]
    level: security
    compliance: ["HIPAA"]
    retention: permanent
    sensitive: true
    fields: ["*"]  # Log all field changes
    read-logging: true  # Log reads, not just writes
    immutable: true
```

**Selective Field Logging**: Only log certain fields:

```yaml
- select: 'class[name="UserProfile"]'
  tag: audit-log
  attrs:
    event: [update]
    fields: ["email", "phone", "address"]  # Only audit these
    exclude-fields: ["lastLogin", "sessionToken"]  # Never log these
    sensitive: true
    redact: ["ssn", "creditCard"]  # Redact in logs
```

**Cross-System Correlation**: Link audit logs across services:

```yaml
- select: 'function[name="processPayment"]'
  tag: audit-log
  attrs:
    event: admin
    level: security
    correlation-id: "X-Request-ID"  # Header for tracing
    includes-downstream: true  # Propagate to called services
```

### Concurrency Taxonomy

Concurrency patterns (locks, actors, async boundaries) manage parallel execution:

| Framework | Term | Example |
|-----------|------|---------|
| Java | synchronized | `synchronized(lock) { ... }` |
| Go | Mutex/Channel | `mu.Lock()`, `ch <- msg` |
| Rust | Mutex/RwLock | `Mutex::new(data)` |
| Python | Lock/asyncio | `async with lock:` |
| Akka | Actor | `actorRef ! message` |
| Erlang/Elixir | Process | `GenServer` |
| Redis | Distributed lock | `SETNX` / Redlock |
| PostgreSQL | Advisory lock | `pg_advisory_lock()` |

#### Unified Vocabulary

**Concurrency Model**:
- `mutex` — Mutual exclusion lock
- `rwlock` — Reader-writer lock
- `semaphore` — Counting semaphore
- `actor` — Actor model (message passing)
- `csp` — Communicating sequential processes (channels)
- `stm` — Software transactional memory

**Lock Scope**:
- `local` — Single process/thread
- `distributed` — Across instances (Redis, ZooKeeper)
- `database` — Database-level lock

**Async Boundary**:
- `spawn` — Fire and forget
- `await` — Wait for result
- `select` — Wait for first of many
- `join` — Wait for all

#### Example Concurrency Tag

```yaml
tags:
  concurrency:
    description: Concurrency control or synchronization point
    attrs:
      model: { type: enum, values: [mutex, rwlock, semaphore, actor, csp, stm] }
      scope: { type: enum, values: [local, distributed, database] }
      resource: { type: string }                # What is being protected
      timeout: { type: string }                 # Lock acquisition timeout
      fairness: { type: boolean }               # FIFO ordering?
      reentrant: { type: boolean }              # Same thread can re-acquire?
      deadlock-risk: { type: boolean }          # Known deadlock potential?
      contention: { type: enum, values: [low, medium, high] }

  async-boundary:
    description: Async/await boundary or parallel execution point
    attrs:
      pattern: { type: enum, values: [spawn, await, select, join] }
      parallelism: { type: number }             # Max concurrent operations
      timeout: { type: string }
      cancel-on-error: { type: boolean }        # Cancel siblings on failure?
      error-handling: { type: enum, values: [fail-fast, collect-all, ignore] }
```

#### Framework Mappings

| Framework | Code | AQL Annotation |
|-----------|------|----------------|
| Go | `mu.Lock(); defer mu.Unlock()` | `concurrency[model=mutex, scope=local, resource="sharedState"]` |
| Redis | `redisLock.acquire('resource', ttl)` | `concurrency[model=mutex, scope=distributed, timeout="10s"]` |
| Java | `readWriteLock.readLock().lock()` | `concurrency[model=rwlock, scope=local]` |
| Akka | `context.spawn(behavior, "worker")` | `concurrency[model=actor]` |
| Go | `result := <-ch` | `concurrency[model=csp]` |
| JS | `await Promise.all(tasks)` | `async-boundary[pattern=join, cancel-on-error=false]` |

#### Concurrency Complexity

**Distributed Locking**: For cross-instance coordination:

```yaml
- select: 'function[name="processUniqueJob"]'
  tag: concurrency
  attrs:
    model: mutex
    scope: distributed
    resource: "job:{jobId}"
    timeout: "30s"
    storage: redis
    algorithm: redlock
    note: "Prevents duplicate processing across instances"
```

**Deadlock Documentation**: Mark known deadlock risks:

```yaml
- select: 'function[name="transferFunds"]'
  tag: concurrency
  attrs:
    model: mutex
    resources: ["account:{fromId}", "account:{toId}"]
    deadlock-risk: true
    lock-ordering: "Always lock lower account ID first"
    note: "Must acquire locks in consistent order to prevent deadlock"
```

**Parallel Execution Limits**: Control parallelism:

```yaml
- select: 'function[name="processInParallel"]'
  tag: async-boundary
  attrs:
    pattern: join
    parallelism: 10
    timeout: "5m"
    cancel-on-error: true
    error-handling: fail-fast
    note: "Limit to 10 concurrent API calls to avoid rate limiting"
```

### Integration Taxonomy

Integration patterns describe how systems communicate beyond simple request/response:

| Pattern | Description | Example |
|---------|-------------|---------|
| Request-Reply | Sync request with response | REST API call |
| Fire-and-Forget | Async, no response expected | Send to queue |
| Publish-Subscribe | Broadcast to multiple subscribers | Kafka topic |
| Scatter-Gather | Parallel requests, aggregate responses | Price comparison |
| Saga | Distributed transaction via compensation | Order fulfillment |
| Circuit Breaker | Fail fast when downstream is down | (covered in Resilience) |
| Gateway | Single entry point, routing | API Gateway |
| Sidecar | Co-located helper process | Service mesh proxy |

#### Unified Vocabulary

**Integration Style**:
- `sync` — Synchronous request/response
- `async-request` — Async request, await response
- `fire-forget` — Send and don't wait
- `pubsub` — Publish/subscribe
- `rpc` — Remote procedure call

**Message Exchange Pattern**:
- `request-response` — One request, one response
- `request-reply-async` — Request now, reply later (correlation ID)
- `one-way` — No response
- `broadcast` — One to many
- `scatter-gather` — Many parallel, aggregate

**Reliability**:
- `best-effort` — May lose messages
- `at-least-once` — May duplicate
- `exactly-once` — Transactional

#### Example Integration Tag

```yaml
tags:
  integration:
    description: Integration point with external system or service
    attrs:
      style: { type: enum, values: [sync, async-request, fire-forget, pubsub, rpc] }
      pattern: { type: enum, values: [request-response, request-reply-async, one-way, broadcast, scatter-gather] }
      reliability: { type: enum, values: [best-effort, at-least-once, exactly-once] }
      service: { type: string }                 # Target service name
      protocol: { type: string }                # HTTP, gRPC, AMQP, etc.
      timeout: { type: string }
      retry: { type: boolean }
      circuit-breaker: { type: string }         # Circuit breaker name if used
      correlation-id: { type: string }          # Header for request correlation
      contract: { type: string }                # API contract reference (OpenAPI, Proto)

  saga:
    description: Distributed transaction using saga pattern
    attrs:
      name: { type: string, required: true }
      step: { type: number }
      action: { type: string }                  # Forward action
      compensation: { type: string }            # Rollback action
      triggers-next: { type: string }           # Next saga step
      timeout: { type: string }
      idempotent: { type: boolean }
```

#### Framework Mappings

| Pattern | Code | AQL Annotation |
|---------|------|----------------|
| REST call | `fetch(url)` | `integration[style=sync, pattern=request-response, protocol=http]` |
| gRPC | `client.getUser(request)` | `integration[style=sync, pattern=request-response, protocol=grpc, contract="user.proto"]` |
| Queue send | `queue.send(message)` | `integration[style=fire-forget, pattern=one-way, reliability=at-least-once]` |
| Scatter-gather | `Promise.all(services.map(s => s.getPrice()))` | `integration[pattern=scatter-gather, timeout="5s"]` |

#### Integration Complexity

**Saga Pattern**: Distributed transactions via compensation:

```yaml
# Order saga - step 1: Reserve inventory
- select: 'function[name="reserveInventory"]'
  tag: saga
  attrs:
    name: "create-order"
    step: 1
    action: "Reserve items in warehouse"
    compensation: "releaseInventory"
    triggers-next: "processPayment"
    idempotent: true

# Order saga - step 2: Process payment
- select: 'function[name="processPayment"]'
  tag: saga
  attrs:
    name: "create-order"
    step: 2
    action: "Charge customer"
    compensation: "refundPayment"
    triggers-next: "shipOrder"

# Order saga - step 3: Ship order
- select: 'function[name="shipOrder"]'
  tag: saga
  attrs:
    name: "create-order"
    step: 3
    action: "Create shipping label"
    compensation: "cancelShipment"
```

**API Gateway Routing**: Document routing rules:

```yaml
- select: 'function[name="routeRequest"]'
  tag: integration
  attrs:
    pattern: gateway
    routes:
      - path: "/api/users/*"
        service: user-service
      - path: "/api/orders/*"
        service: order-service
      - path: "/api/payments/*"
        service: payment-service
    auth: "Validate JWT before routing"
    rate-limit: "Apply per-client limits"
```

**Service Mesh Sidecar**: Document sidecar behavior:

```yaml
- select: 'class[name="EnvoyConfig"]'
  tag: integration
  attrs:
    pattern: sidecar
    handles: ["mTLS", "load-balancing", "circuit-breaker", "tracing"]
    note: "All service-to-service calls go through Envoy proxy"
```

### UI Framework Taxonomy

Declarative UI frameworks (SwiftUI, React Native, Flutter, Jetpack Compose) share patterns but use different terminology:

| Framework | View | State | Binding | Lifecycle | Navigation |
|-----------|------|-------|---------|-----------|------------|
| **SwiftUI** | `View` | `@State` | `@Binding` | `.onAppear` | `NavigationStack` |
| **UIKit** | `UIView` | property | delegate | `viewDidLoad` | `UINavigationController` |
| **React Native** | Component | `useState` | props | `useEffect` | React Navigation |
| **Flutter** | `Widget` | `setState` | callback | `initState` | `Navigator` |
| **Jetpack Compose** | `@Composable` | `remember` | state hoisting | `LaunchedEffect` | NavHost |

#### Unified Vocabulary

**View Type**:
- `screen` — Full-screen view/page
- `component` — Reusable UI component
- `layout` — Container/layout component
- `control` — Interactive control (button, input, etc.)
- `decorator` — Modifier/wrapper (SwiftUI modifiers, HOCs)

**State Scope**:
- `local` — Component-local state (@State, useState)
- `inherited` — Passed from parent (@Binding, props)
- `shared` — Shared across components (@EnvironmentObject, Context)
- `global` — App-wide state (Redux, @Observable)

**Lifecycle Phase**:
- `mount` — Component created/appeared
- `update` — State/props changed
- `unmount` — Component destroyed/disappeared

**Platform**:
- `ios` — iOS only
- `android` — Android only
- `web` — Web only
- `cross-platform` — All platforms

#### Example UI Tags

```yaml
tags:
  ui-view:
    description: A UI view/component
    attrs:
      type: { type: enum, values: [screen, component, layout, control, decorator] }
      platform: { type: enum, values: [ios, android, web, cross-platform] }
      pure: { type: boolean }                   # No side effects, deterministic
      accessibility:
        type: object
        properties:
          label: { type: string }
          hint: { type: string }
          role: { type: string }

  ui-state:
    description: State declaration in a UI component
    attrs:
      scope: { type: enum, values: [local, inherited, shared, global] }
      source: { type: string }                  # Where state comes from
      persisted: { type: boolean }              # Survives app restart?
      observed: { type: boolean }               # Triggers re-render on change?

  ui-lifecycle:
    description: Lifecycle hook in a UI component
    attrs:
      phase: { type: enum, values: [mount, update, unmount] }
      async: { type: boolean }
      cleanup: { type: string }                 # Cleanup function/action
      dependencies: { type: string[] }          # What triggers re-run

  ui-navigation:
    description: Navigation action or destination
    attrs:
      type: { type: enum, values: [push, present, replace, pop, deep-link] }
      destination: { type: string }
      params: { type: string[] }
      animated: { type: boolean }
```

#### SwiftUI Examples

```yaml
# SwiftUI View
- select: 'class[name="ProfileView"]'
  tag: ui-view
  attrs:
    type: screen
    platform: ios
    pure: false

# @State property
- select: 'field[decorators~="State"]'
  tag: ui-state
  attrs:
    scope: local
    observed: true
    note: "Triggers view re-render on change"

# @Binding property
- select: 'field[decorators~="Binding"]'
  tag: ui-state
  attrs:
    scope: inherited
    observed: true
    note: "Two-way binding to parent state"

# @EnvironmentObject
- select: 'field[decorators~="EnvironmentObject"]'
  tag: ui-state
  attrs:
    scope: shared
    source: "SwiftUI environment"
    observed: true

# .onAppear modifier
- select: 'call[name="onAppear"]'
  tag: ui-lifecycle
  attrs:
    phase: mount
    async: false

# .task modifier (async)
- select: 'call[name="task"]'
  tag: ui-lifecycle
  attrs:
    phase: mount
    async: true
    cleanup: "Task cancelled on disappear"
```

#### React Native Examples

```yaml
# Screen component
- select: 'function[name="ProfileScreen"]'
  tag: ui-view
  attrs:
    type: screen
    platform: cross-platform
    pure: false

# useState hook
- select: 'call[name="useState"]'
  tag: ui-state
  attrs:
    scope: local
    observed: true

# useContext hook
- select: 'call[name="useContext"]'
  tag: ui-state
  attrs:
    scope: shared
    source: $1  # Context name from first argument

# useEffect for mount
- select: 'call[name="useEffect"]'
  tag: ui-lifecycle
  attrs:
    phase: mount
    dependencies: $2  # Dependency array
    cleanup: "Return function called on unmount"

# Navigation
- select: 'call[name="navigation.navigate"]'
  tag: ui-navigation
  attrs:
    type: push
    destination: $1
    params: $2
```

#### Flutter Examples

```yaml
# StatefulWidget
- select: 'class[extends="StatefulWidget"]'
  tag: ui-view
  attrs:
    type: component
    platform: cross-platform
    pure: false

# StatelessWidget
- select: 'class[extends="StatelessWidget"]'
  tag: ui-view
  attrs:
    type: component
    platform: cross-platform
    pure: true

# initState
- select: 'method[name="initState"]'
  tag: ui-lifecycle
  attrs:
    phase: mount

# dispose
- select: 'method[name="dispose"]'
  tag: ui-lifecycle
  attrs:
    phase: unmount
    note: "Clean up controllers, subscriptions"

# Navigator.push
- select: 'call[name="Navigator.push"]'
  tag: ui-navigation
  attrs:
    type: push
    animated: true
```

#### Jetpack Compose Examples

```yaml
# Composable function
- select: 'function[decorators~="Composable"]'
  tag: ui-view
  attrs:
    type: component
    platform: android

# remember { mutableStateOf() }
- select: 'call[name="remember"]'
  tag: ui-state
  attrs:
    scope: local
    observed: true

# LaunchedEffect
- select: 'call[name="LaunchedEffect"]'
  tag: ui-lifecycle
  attrs:
    phase: mount
    async: true
    dependencies: $1  # Key parameter

# DisposableEffect
- select: 'call[name="DisposableEffect"]'
  tag: ui-lifecycle
  attrs:
    phase: mount
    cleanup: "onDispose block"
```

#### Native Bridge Taxonomy

Cross-platform frameworks need to call native code:

| Framework | Bridge Mechanism | Example |
|-----------|-----------------|---------|
| React Native | Native Modules | `NativeModules.MyModule.doSomething()` |
| Flutter | Platform Channels | `MethodChannel('channel').invokeMethod()` |
| Kotlin Multiplatform | expect/actual | `expect fun platformName(): String` |
| Capacitor | Plugins | `Plugins.Camera.getPhoto()` |

```yaml
tags:
  native-bridge:
    description: Call from cross-platform code to native platform code
    attrs:
      direction: { type: enum, values: [to-native, from-native] }
      platform: { type: enum, values: [ios, android, web, all] }
      async: { type: boolean }
      channel: { type: string }                 # Channel/module name
      method: { type: string }
      fallback: { type: string }                # Fallback if not available
      permissions: { type: string[] }           # Required permissions
```

```yaml
# React Native native module call
- select: 'call[name="NativeModules.Camera.takePicture"]'
  tag: native-bridge
  attrs:
    direction: to-native
    platform: all
    async: true
    channel: Camera
    method: takePicture
    permissions: ["camera"]

# Flutter platform channel
- select: 'call[name="invokeMethod"][lang-hint="platform-channel"]'
  tag: native-bridge
  attrs:
    direction: to-native
    async: true
    channel: $receiver  # The MethodChannel instance
    method: $1          # Method name argument
```

#### Accessibility Taxonomy

Accessibility is critical for mobile apps:

```yaml
tags:
  accessibility:
    description: Accessibility configuration for a UI element
    attrs:
      label: { type: string }                   # Screen reader label
      hint: { type: string }                    # Additional context
      role: { type: enum, values: [button, link, header, image, text, list, checkbox, radio, slider, switch] }
      hidden: { type: boolean }                 # Hidden from screen readers
      live-region: { type: enum, values: [none, polite, assertive] }
      actions: { type: string[] }               # Custom accessibility actions
      order: { type: number }                   # Focus order
```

```yaml
# SwiftUI accessibility
- select: 'call[name="accessibilityLabel"]'
  tag: accessibility
  attrs:
    label: $1

# React Native accessible prop
- select: 'field[name="accessible"]'
  tag: accessibility
  attrs:
    role: $sibling.accessibilityRole
    label: $sibling.accessibilityLabel
```

#### Animation Taxonomy

Animations are a key part of mobile UX:

```yaml
tags:
  animation:
    description: Animation definition
    attrs:
      type: { type: enum, values: [transition, spring, keyframe, gesture-driven] }
      duration: { type: duration }
      easing: { type: enum, values: [linear, ease-in, ease-out, ease-in-out, spring] }
      property: { type: string }                # What's being animated
      interruptible: { type: boolean }
      repeats: { type: boolean }
```

```yaml
# SwiftUI withAnimation
- select: 'call[name="withAnimation"]'
  tag: animation
  attrs:
    type: transition
    easing: $1.animation  # Animation curve from argument

# React Native Animated
- select: 'call[name="Animated.timing"]'
  tag: animation
  attrs:
    type: transition
    duration: $1.duration
    easing: $1.easing

# Flutter AnimationController
- select: 'variable[type="AnimationController"]'
  tag: animation
  attrs:
    type: transition
    duration: $initializer.duration
```

### Extractors

For frameworks where routes/controllers are registered imperatively at runtime (Express, Koa, Django), static analysis cannot discover them. Extractors are user-provided scripts that execute in the target language runtime and output annotations in a standard JSON format.

| Framework | Pattern | Static Analyzability |
|-----------|---------|---------------------|
| NestJS | `@Controller()` decorator | High (AST) |
| FastAPI | `@app.get()` decorator | High (AST) |
| [Hack GraphQL](https://github.com/slackhq/hack-graphql) | `<<GraphQL\ObjectType>>` attribute | High (AST) |
| Express | `app.get('/path', handler)` | Low (runtime only) |
| Django | `urls.py` config | Medium (requires execution) |

#### Configuration

Extractors are declared in the schema manifest:

```yaml
version: "1.0"

extractors:
  - name: express-routes
    run: node .config/aql/extract-express.js
  - name: django-urls
    run: python .config/aql/extract-django.py

tags:
  controller:
    description: HTTP route handler
    attrs:
      method: { type: enum, values: [GET, POST, PUT, DELETE, PATCH] }
      path: { type: string }
```

#### Output Format

Extractors print JSON to stdout:

```json
{
  "annotations": [
    {
      "file": "src/routes/users.ts",
      "bind": "createUser",
      "tag": "controller",
      "attrs": {
        "method": "POST",
        "path": "/api/users"
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | string | yes | Relative path to source file |
| `bind` | string | yes | Code element name to bind to |
| `tag` | string | yes | Annotation tag (must be defined in schema) |
| `attrs` | object | no | Annotation attributes |

#### Execution Model

- Extractors run on index/startup, not on every query
- Results are cached; re-run when extractor script mtime changes
- Each extractor runs in a subprocess with configurable timeout (default: 30s)
- Stdout is parsed as JSON; stderr is logged
- Non-zero exit code is an error

#### Example: Express

```javascript
// .config/aql/extract-express.js
const app = require('../../src/app');

const annotations = [];
app._router.stack.forEach(layer => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods);
    annotations.push({
      file: 'src/routes.ts',
      bind: layer.route.stack[0]?.handle?.name || 'anonymous',
      tag: 'controller',
      attrs: {
        method: methods[0].toUpperCase(),
        path: layer.route.path
      }
    });
  }
});

console.log(JSON.stringify({ annotations }));
```

#### Example: Django

```python
# .config/aql/extract-django.py
import os, json
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings')

import django
django.setup()

from django.urls import get_resolver

annotations = []
def extract(resolver, prefix=''):
    for pattern in resolver.url_patterns:
        if hasattr(pattern, 'url_patterns'):
            extract(pattern, prefix + str(pattern.pattern))
        else:
            annotations.append({
                'file': pattern.callback.__module__.replace('.', '/') + '.py',
                'bind': pattern.callback.__name__,
                'tag': 'controller',
                'attrs': {'path': '/' + prefix + str(pattern.pattern).rstrip('$')}
            })

extract(get_resolver())
print(json.dumps({'annotations': annotations}))
```

#### Example: FastAPI

```python
# .config/aql/extract-fastapi.py
import json
from main import app

annotations = []
for route in app.routes:
    if hasattr(route, 'methods'):
        for method in route.methods:
            annotations.append({
                'file': route.endpoint.__module__.replace('.', '/') + '.py',
                'bind': route.endpoint.__name__,
                'tag': 'controller',
                'attrs': {'method': method, 'path': route.path}
            })

print(json.dumps({'annotations': annotations}))
```

#### Mock-Based Extraction

The examples above require running the actual application with all its dependencies. A simpler approach: **mock the framework API** to capture registrations without executing real code.

**Key insight**: Frameworks register routes/handlers via a known public API. Mock that API to capture the registrations.

| Framework | API to Mock | Captures |
|-----------|-------------|----------|
| Express | `app.get()`, `app.post()`, etc. | Routes |
| React Router | `<Route path="...">` | Routes |
| Flask | `@app.route()` | Routes |
| GraphQL | `Query`, `Mutation` builders | Resolvers |
| gRPC | Service definitions | RPC methods |
| tRPC | `router.query()`, `router.mutation()` | Procedures |

**Example: Express Mock Extractor**

Instead of introspecting `app._router.stack`, mock Express itself:

```javascript
// .config/aql/mock-express.js
const annotations = [];
const callsites = new Map();

// Track where functions are defined
function trackCallsite(fn) {
  const err = new Error();
  const stack = err.stack.split('\n')[3]; // Caller's caller
  const match = stack.match(/at .+ \((.+):(\d+):\d+\)/);
  if (match) {
    callsites.set(fn, { file: match[1], line: parseInt(match[2]) });
  }
  return fn;
}

// Mock Express app
const mockApp = {
  get: (path, ...handlers) => {
    const handler = handlers[handlers.length - 1];
    const loc = callsites.get(handler) || { file: 'unknown', line: 0 };
    annotations.push({
      file: loc.file,
      bind: handler.name || 'anonymous',
      tag: 'endpoint',
      attrs: { method: 'GET', path, intent: 'read' }
    });
  },
  post: (path, ...handlers) => {
    const handler = handlers[handlers.length - 1];
    const loc = callsites.get(handler) || { file: 'unknown', line: 0 };
    annotations.push({
      file: loc.file,
      bind: handler.name || 'anonymous',
      tag: 'endpoint',
      attrs: { method: 'POST', path, intent: 'write' }
    });
  },
  put: (path, ...handlers) => { /* similar */ },
  delete: (path, ...handlers) => { /* similar */ },
  use: (path, router) => {
    // Handle mounted routers with prefix
    if (router._routes) {
      router._routes.forEach(r => {
        annotations.push({
          ...r,
          attrs: { ...r.attrs, path: path + r.attrs.path }
        });
      });
    }
  },
  listen: () => {}, // No-op
};

// Mock express() factory
function express() {
  return mockApp;
}
express.Router = () => {
  const routes = [];
  return {
    _routes: routes,
    get: (path, handler) => routes.push({ /* ... */ }),
    post: (path, handler) => routes.push({ /* ... */ }),
  };
};

// Replace the real express module
require.cache[require.resolve('express')] = { exports: express };

// Now load the app - it will use our mock
require('../../src/app');

// Output annotations
console.log(JSON.stringify({ annotations }));
```

**Example: React Router Mock Extractor**

```javascript
// .config/aql/mock-react-router.js
const annotations = [];

// Mock React
global.React = {
  createElement: (type, props, ...children) => {
    if (type === Route || type.displayName === 'Route') {
      annotations.push({
        file: props.__source?.fileName || 'unknown',
        bind: props.element?.type?.name || props.component?.name || 'anonymous',
        tag: 'ui-navigation',
        attrs: {
          type: 'route',
          path: props.path,
          exact: props.exact || false,
        }
      });
    }
    // Process children recursively
    children.flat().forEach(child => {
      if (child && typeof child === 'object') {
        // Already processed by createElement
      }
    });
    return { type, props, children };
  }
};

// Mock Route component
const Route = ({ path, element, component }) => null;
Route.displayName = 'Route';

// Mock other react-router exports
module.exports = {
  BrowserRouter: ({ children }) => children,
  Routes: ({ children }) => children,
  Route,
  Link: () => null,
  Navigate: () => null,
};

require.cache[require.resolve('react-router-dom')] = { exports: module.exports };

// Load the app's router configuration
require('../../src/App');

console.log(JSON.stringify({ annotations }));
```

**Example: Flask Mock Extractor**

```python
# .config/aql/mock-flask.py
import sys
import json

annotations = []

class MockFlask:
    def __init__(self, name):
        self.name = name

    def route(self, path, methods=['GET']):
        def decorator(fn):
            for method in methods:
                annotations.append({
                    'file': fn.__code__.co_filename,
                    'bind': fn.__name__,
                    'tag': 'endpoint',
                    'attrs': {
                        'method': method,
                        'path': path,
                        'intent': 'read' if method == 'GET' else 'write'
                    }
                })
            return fn
        return decorator

    def get(self, path):
        return self.route(path, methods=['GET'])

    def post(self, path):
        return self.route(path, methods=['POST'])

    # ... other methods

# Replace Flask in sys.modules before app imports it
sys.modules['flask'] = type(sys)('flask')
sys.modules['flask'].Flask = MockFlask

# Now import the app
from app import app  # This uses our mock

print(json.dumps({'annotations': annotations}))
```

**Example: GraphQL Schema Mock Extractor**

```javascript
// .config/aql/mock-graphql.js
const annotations = [];

// Mock GraphQL schema builders
const mockGraphQL = {
  GraphQLObjectType: class {
    constructor({ name, fields }) {
      const fieldDefs = typeof fields === 'function' ? fields() : fields;
      Object.entries(fieldDefs).forEach(([fieldName, config]) => {
        annotations.push({
          file: config.resolve?.__source || 'unknown',
          bind: config.resolve?.name || fieldName,
          tag: 'endpoint',
          attrs: {
            protocol: 'graphql',
            operation: name === 'Query' ? 'query' : name === 'Mutation' ? 'mutation' : 'type',
            field: fieldName,
            intent: name === 'Mutation' ? 'write' : 'read',
          }
        });
      });
    }
  },
  GraphQLSchema: class {
    constructor({ query, mutation, subscription }) {
      // Types already registered via GraphQLObjectType
    }
  },
  GraphQLString: {},
  GraphQLInt: {},
  GraphQLID: {},
  GraphQLList: (type) => ({}),
  GraphQLNonNull: (type) => ({}),
};

require.cache[require.resolve('graphql')] = { exports: mockGraphQL };

// Load schema
require('../../src/schema');

console.log(JSON.stringify({ annotations }));
```

#### Preset-Provided Mocks

Presets can include ready-to-use mock extractors:

```yaml
# @aql/preset-express/index.yaml
name: "@aql/preset-express"
version: "1.0.0"

tags:
  endpoint:
    description: HTTP endpoint
    attrs:
      method: { type: enum, values: [GET, POST, PUT, PATCH, DELETE] }
      path: { type: string }
      intent: { type: enum, values: [read, write] }

extractors:
  - name: express-mock
    run: node node_modules/@aql/preset-express/extract.js
    # The preset ships with the mock extractor
```

Users just add the preset—no extractor code to write:

```yaml
# .config/aql.yaml
extends:
  - "@aql/preset-express"  # Includes mock extractor

# That's it! Run: aql extract
```

#### Mock Extractor Benefits

| Approach | Pros | Cons |
|----------|------|------|
| **Runtime introspection** | Sees final state | Requires full app startup, dependencies |
| **AST parsing** | No execution needed | Can't handle dynamic registration |
| **Mock-based** | Simple, no deps, captures dynamic code | Must mock all used APIs |

Mock-based extraction is the **recommended default** for most frameworks because:
1. No need to start databases, services, etc.
2. No internal API knowledge needed (`_router.stack`)
3. Works with dynamic route registration
4. Presets can ship ready-to-use mocks
5. Fast—only loads route definitions, not the whole app

### AQL (Agent Query Language)

The reference implementation exposes these operations. Examples below use TypeScript-like pseudocode for readability.

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

### MCP Server

AQL is exposed to agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). One server per project, communicating over stdio.

#### Setup

The server is configured in the MCP client (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "aql": {
      "command": "aql-mcp-server",
      "args": ["--project", "/path/to/project"]
    }
  }
}
```

Multi-project setups use multiple MCP server instances. The host app already supports this.

#### Tools

| Tool | Purpose | Needs source parsing? |
|------|---------|----------------------|
| `aql_schema` | Discover project tags, attributes, audiences, visibilities | No |
| `aql_select` | Query annotations by tag/attributes (CSS-like selectors) | No |
| `aql_select_annotated` | Query by code structure, return code + annotations | Yes (single file) |
| `aql_validate` | Check annotations against schema manifest | No |
| `aql_repair` | Detect broken selectors, suggest fixes | No (basic), Yes (source-aware) |

`aql_select` is the workhorse tool. It operates purely on the annotation index — no source parsing — making it fast for project-wide queries. The `file` parameter is optional; omit it to search all annotations.

`aql_select_annotated` requires a `file` parameter because it parses source code, which is expensive. No project-wide code parsing.

#### Performance model

At startup, the server:
1. Reads `--project` argument
2. Parses `.config/aql.yaml` into an in-memory schema
3. Globs `**/*.ann.yaml` (respecting `.gitignore`), parses all into an in-memory annotation index
4. Registers 5 MCP tools
5. Accepts requests over stdio

Annotation data is stat-checked before access. If the `.ann.yaml` file's mtime changed, it is re-parsed. Source files are parsed on demand (for `aql_select_annotated`) and cached per-file. No file watchers — MCP servers are short-lived subprocesses.

#### Example session

```
Agent → aql_schema {}
  ← { tags: { controller: {...}, react-hook: {...} }, annotationFiles: 12 }

Agent → aql_select { selector: 'controller[method="POST"]' }
  ← { results: [{ tag: "controller", attrs: { method: "POST", path: "/api/users" }, file: "src/api/users.ts" }] }

Agent → aql_select_annotated { selector: 'function[async]', file: 'src/api/users.ts' }
  ← { results: [{ codeElement: { tag: "function", name: "createUser" }, annotations: [...] }] }
```

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
  - Supporting every language requires a resolver adapter that maps existing parser ASTs to the universal element model
  - The adapter pattern <sup>[[1]](#references)</sup> reduces scope (no custom parsers), but per-language mapping from parser AST nodes to CodeElements is still per-language work
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

Each alternative is documented with full rationale in the [Decision Log](./DECISIONS.md) <sup>[[1]](#references)</sup>

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

The [walkthrough](./WALKTHROUGH.md) <sup>[[2]](#references)</sup> demonstrates the full system applied to Grafana's Go + TypeScript codebase.

## Unresolved Questions

- **Code Resolver: additional languages**
  - A Rust resolver using tree-sitter is implemented, extracting functions, structs, enums, traits, impl blocks, modules, consts, statics, type aliases, and macros into CodeElements
  - The adapter interface (`CodeResolver` trait, `ResolverRegistry`) is defined and working
  - Remaining open work: resolvers for other languages (Go, TypeScript, Python) need to be implemented using the same adapter pattern
  - Auto-detection of parser configuration from project files (`tsconfig.json`, `.babelrc`, `.flowconfig`) is not yet implemented
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
- **Schema presets**
  - Preset `extends` mechanism is defined, but governance questions remain
  - Who reviews/approves community presets for the `@aql/preset-*` namespace?
  - What version compatibility requirements should presets follow?
  - Should presets include extractors or be separate packages?
- **Advanced extension mechanisms**
  - Tag inheritance: should multiple inheritance be supported for complex scenarios?
  - Custom types: what standard formats should be built-in (`uri`, `email`, `date-time`, `uuid`)?
  - Conditional attrs: is the expression syntax expressive enough, or do we need a full predicate language?
  - References: how should circular references be handled (A references B, B references A)?
  - Computed attrs: what functions should be built-in, and can presets define custom functions?
  - Preset scoping: how do overlapping scopes resolve when multiple presets match the same file?
  - Meta-attrs: should there be a schema for meta-attrs, or are they fully free-form?
  - Expression language: should `when` clauses and `computed` expressions share the same syntax?
- **API operation modeling**
  - Path parameter normalization: should presets enforce a single format (OpenAPI `{param}`) or allow framework-native syntax?
  - Middleware composition: should middleware be flattened into endpoint attrs or represented as separate linked annotations?
  - Composite operations (read + write): should `intent` allow arrays, or should a separate `action` value exist?
  - Integration with OpenAPI/AsyncAPI: should presets reference external schema definitions for request/response types?
- **Event-driven modeling**
  - Saga/choreography patterns: how should multi-step event flows be linked across handlers?
  - Event schema references: should annotations link to schema registries (Confluent, AWS Glue)?
  - Consumer group semantics: how to model competing consumers vs fan-out patterns?
- **Background job modeling**
  - Job dependencies/workflows: how to model job chains where job A triggers job B?
  - Distributed locking: how to annotate jobs that require exclusive locks?
  - Monitoring integration: should annotations link to dashboard/alert definitions?
- **State machine modeling**
  - Hierarchical/nested states: how to represent substates (e.g., `active.pending`)?
  - Parallel regions: how to model concurrent state machines within an entity?
  - Implicit state machines: how to discover and annotate ad-hoc status fields without formal libraries?
- **Data access modeling**
  - Query plan hints: should annotations include index hints or explain analysis?
  - Cross-database transactions: how to annotate distributed transactions (2PC, sagas)?
  - Read replica routing: how to indicate which queries can use replicas?
- **Caching modeling**
  - Cache key standardization: should presets define a common key pattern syntax?
  - Invalidation graphs: how to model complex cache dependency chains?
  - Cache warming: should annotations define pre-warming strategies?
- **Resilience modeling**
  - Policy composition order: how to express that timeout wraps retry wraps circuit-breaker?
  - Chaos engineering integration: should annotations link to failure injection points?
  - Degradation modes: how to annotate graceful degradation strategies?
- **Validation modeling**
  - Schema references: should validation annotations link to JSON Schema/OpenAPI definitions?
  - Cross-field validation: how to express validation rules spanning multiple fields?
  - Async validation: how to model validations requiring external service calls?
- **Webhook modeling**
  - Webhook versioning: how to annotate webhook payload version evolution?
  - Webhook testing: should annotations include test event examples?
  - Webhook monitoring: how to link webhook handlers to delivery dashboards?
- **Observability modeling**
  - Span relationship: how to model parent-child span relationships across annotations?
  - Metric aggregation: should annotations define how metrics roll up?
  - Log correlation: how to ensure consistent correlation ID propagation is annotated?
- **Authentication & authorization modeling**
  - Policy language: should auth conditions use a standard expression syntax (CEL, Rego)?
  - Role hierarchy: how to model role inheritance across annotations?
  - Session vs token: should session management be a separate concern from auth checks?
- **Feature flag modeling**
  - Flag lifecycle: how to automate detection of stale flags from annotations?
  - Experiment metrics: should annotations link to analytics platform definitions?
  - Multi-arm experiments: how to model complex A/B/n test variants?
- **Rate limiting modeling**
  - Quota aggregation: how to model tiered limits that aggregate across endpoints?
  - Burst vs sustained: should burst limits be a separate attribute or combined formula?
  - Cost-based limiting: how to annotate endpoints with different "costs" per request?
- **Batch processing modeling**
  - Pipeline visualization: should annotations support rendering DAG visualizations?
  - Data lineage: how to model input→output data flow across batch steps?
  - SLA tracking: how to link batch job annotations to SLA dashboards?
- **Audit logging modeling**
  - Retention policies: should audit annotations define retention rules or reference external policies?
  - PII detection: how to auto-detect sensitive fields that need redaction?
  - Compliance mapping: how to map audit events to specific compliance requirements?
- **Concurrency modeling**
  - Deadlock detection: can static analysis of lock annotations detect potential deadlocks?
  - Lock ordering: should annotations enforce consistent lock acquisition order?
  - Async context: how to annotate context propagation across async boundaries?
- **Integration modeling**
  - Contract versioning: how to handle API version evolution in integration annotations?
  - Saga compensation: how to ensure all saga steps have compensation actions annotated?
  - Service discovery: should integration annotations reference service registry entries?
- **UI framework modeling**
  - State flow: how to trace data flow from global state through to UI components?
  - Platform-specific code: how to annotate code that only runs on iOS vs Android?
  - View hierarchy: should parent-child view relationships be explicit in annotations?
  - Animation sequences: how to model complex multi-step animations?
  - Accessibility coverage: can annotations help ensure accessibility compliance?
  - Native bridge safety: how to annotate which native calls are safe on which platforms?
- **Annotation versioning**
  - When the schema manifest changes (tags added, removed, renamed), how are existing annotation files migrated?
- **Performance characteristics**
  - For large codebases with thousands of annotation files, what indexing or caching strategies should the AQL implementation use?

---

## References

1. **^** ["Decision Log"](./DECISIONS.md), design decisions, alternatives considered, and rationale
2. **^** ["Walkthrough: Grafana"](./WALKTHROUGH.md), applied to Grafana's Go + TypeScript codebase
3. **^** TypeScript Interfaces, `AQL`, `AnnotatedElement`, `CodeElement` type definitions (reference implementation)
4. **^** [OpenAPI Specification](https://swagger.io/specification/), HTTP API operations (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
5. **^** [GraphQL Schema & Types](https://graphql.org/learn/schema/), Query, Mutation, Subscription
6. **^** [gRPC Core Concepts](https://grpc.io/docs/what-is-grpc/core-concepts/), Unary, Server streaming, Client streaming, Bidirectional
7. **^** [AsyncAPI Specification](https://www.asyncapi.com/docs/reference/specification/v3.0.0), protocol-agnostic send/receive on channels
8. **^** [tRPC Procedures](https://trpc.io/docs/server/procedures), query, mutation, subscription
9. **^** [ESLint Shareable Configs](https://eslint.org/docs/latest/extend/shareable-configs), `eslint-config-*` packages with `extends`
10. **^** [JSON Schema](https://json-schema.org/), type validation keywords (`pattern`, `format`, `minimum`, `maxLength`)
11. **^** [CEL (Common Expression Language)](https://github.com/google/cel-spec), expression syntax used by Kubernetes, Firebase, Google Cloud
12. **^** [ISO 8601 Durations](https://en.wikipedia.org/wiki/ISO_8601#Durations), duration format (`PT1H30M`)
13. **^** [RFC 3339](https://datatracker.ietf.org/doc/html/rfc3339), timestamp format
14. **^** [CloudEvents](https://cloudevents.io/), event format specification
15. **^** [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/), observability attribute naming
16. **^** [OAuth 2.0](https://oauth.net/2/), authorization scopes
17. **^** [OpenID Connect](https://openid.net/connect/), identity claims
