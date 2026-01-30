# Examples

[← Home](../README.md)

---

Source files in three languages with `.ann.yaml` sidecar annotation files. Each annotation carries metadata that cannot be derived from reading the source code — ownership, performance SLAs, cache recipes, architectural context.

## Schema Manifest

| File | Description |
|------|-------------|
| [.annotations/schema.yaml](./.annotations/schema.yaml) | Project-level tag vocabulary — defines every tag and attribute available for annotations |

## Annotated Source Files

| Source | Annotations | Language |
|--------|-------------|----------|
| [TodoList.tsx](./TodoList.tsx) | [TodoList.tsx.ann.yaml](./TodoList.tsx.ann.yaml) | TypeScript/React |
| [UserController.go](./UserController.go) | [UserController.go.ann.yaml](./UserController.go.ann.yaml) | Go |
| [user_routes.py](./user_routes.py) | [user_routes.py.ann.yaml](./user_routes.py.ann.yaml) | Python |

See the [Walkthrough](../docs/walkthrough.md) for a real-world example applied to Grafana's codebase.
