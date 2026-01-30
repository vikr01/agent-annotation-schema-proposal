# Documentation

[← Home](../README.md)

---

## Specification

The full technical specification — annotation format, selector syntax, code elements, schema manifests, and the query API.

**[RFC: Agent Annotation Schema](../text/0001-agent-annotation-schema.md)**

## Walkthrough

The annotation schema applied to [Grafana](https://github.com/grafana/grafana)'s Go backend and TypeScript/React frontend. Covers ownership, cross-boundary flows, performance contracts, and authorization scopes.

**[Real-World Walkthrough: Grafana](./walkthrough.md)**

## Decision Log

Every major design decision — what we chose, what we ruled out, and why. Inline vs external, CSS vs SQL, sidecar vs centralized, and more.

**[Decision Log](./decisions.md)**

---

## Reference

| Resource | Description |
|----------|-------------|
| [Example Files](../examples/) | Source files (Go, TS, Python) with `.ann.yaml` sidecars |
| [Example Schema Manifest](../examples/.annotations/schema.yaml) | Project-level tag vocabulary definition |
