# Real-World Walkthrough: Grafana

[← Home](./README.md)

---

This walkthrough demonstrates the [Agent Annotation Schema](./SPEC.md) applied to [Grafana](https://github.com/grafana/grafana) (65k+ stars), a large-scale observability platform with a **Go backend** and a **TypeScript/React frontend** in the same monorepo

The focus is on non-derivable metadata <sup>[[1]](#references)</sup>:
- Ownership
- Cross-boundary flows
- Performance contracts
- Authorization scopes
- Deprecation intent
- Architectural context

## Contents

- [Repository Structure](#repository-structure-relevant-parts)
- [Step 1: Define the Schema Manifest](#step-1-define-the-schema-manifest)
- [Step 2: Annotate the Go Backend](#step-2-annotate-the-go-backend)
- [Step 3: Annotate the TypeScript Frontend](#step-3-annotate-the-typescript-frontend)
- [Step 4: Query Across Both Languages](#step-4-query-across-both-languages)
- [What This Demonstrates](#what-this-demonstrates)
- [References](#references)

---

## Repository Structure (relevant parts)

```
grafana/
  pkg/                              ← Go backend
    api/
      api.go                        ← Route registration
      dashboard.go                  ← Dashboard HTTP handlers
    services/
      dashboards/                   ← Dashboard business logic
  public/app/                       ← TypeScript/React frontend
    features/
      dashboard/
        api/
          dashboard_api.ts           ← API client factory
        components/
          SaveDashboard/
            SaveDashboardDrawer.tsx   ← Save UI component
            useDashboardSave.tsx      ← Save hook (API call)
  .config/
    aql.schema                       ← Schema manifest
```

---

## Step 1: Define the Schema Manifest

The manifest defines only tags carrying non-derivable metadata: ownership, flows, contracts, and architectural context

```xml
<!-- .config/aql.schema -->
<schema version="1.0">
  <define tag="controller" description="HTTP handler — documents routing, auth, and ownership">
    <attr name="method" type="enum" values="GET,POST,PUT,DELETE,PATCH" required="true" />
    <attr name="path" type="string" required="true" />
    <attr name="auth" type="enum" values="required,optional,none" default="required" />
    <attr name="deprecated" type="boolean" />
    <attr name="deprecation-target" type="string" description="Version or date when this endpoint will be removed" />
  </define>

  <define tag="api-client" description="Frontend code that calls a backend endpoint">
    <attr name="endpoint" type="string" required="true" description="Backend path this client calls" />
    <attr name="method" type="enum" values="GET,POST,PUT,DELETE,PATCH" required="true" />
  </define>

  <define tag="component" description="UI component with ownership metadata">
    <attr name="id" type="string" required="true" />
  </define>

  <define tag="react-hook" description="React hook with non-obvious behavior or cache interactions">
    <attr name="boundary" type="string" description="Required ancestor boundary" />
    <attr name="preload" type="expression" description="How to prefetch this hook's data" />
    <attr name="invalidate-key" type="expression" description="Cache key for invalidation" />
    <attr name="error-handling" type="enum" values="throws,catches,propagates" />
  </define>

  <define tag="middleware" description="Middleware — documents authorization scope">
    <attr name="name" type="string" required="true" />
    <attr name="scope" type="string" description="Authorization scope expression" />
  </define>

  <define tag="perf-critical" description="Performance-sensitive code with SLA">
    <attr name="sla" type="string" />
    <attr name="traced" type="boolean" />
  </define>

  <define tag="event" description="Event in async data flow">
    <attr name="name" type="string" required="true" />
    <attr name="direction" type="enum" values="publish,subscribe" />
  </define>

  <audiences>
    <audience name="product" description="Product engineers building dashboard features" />
    <audience name="infra" description="Platform team maintaining API infrastructure" />
    <audience name="security" description="Security team reviewing access control" />
  </audiences>

  <visibilities>
    <visibility name="public" description="Stable API, safe for plugins and external integrations" />
    <visibility name="internal" description="Implementation detail, may change between releases" />
    <visibility name="deprecated" description="Scheduled for removal in a future version" />
  </visibilities>
</schema>
```

---

## Step 2: Annotate the Go Backend

### Dashboard HTTP Handlers

The Go source shows function signatures, request parsing, and response construction. The annotations add what source can't tell you: routing paths, auth requirements, ownership, performance contracts, and deprecation intent.

```go
// pkg/api/dashboard.go (actual Grafana code, simplified)

func (hs *HTTPServer) GetDashboard(c *contextmodel.ReqContext) response.Response {
	ctx, span := tracer.Start(c.Req.Context(), "api.GetDashboard")
	defer span.End()

	uid := web.Params(c.Req)[":uid"]
	dash, rsp := hs.getDashboardHelper(ctx, c.GetOrgID(), 0, uid)
	if rsp != nil {
		return rsp
	}
	// ... build and return dashboard DTO
}

func (hs *HTTPServer) PostDashboard(c *contextmodel.ReqContext) response.Response {
	ctx, span := tracer.Start(c.Req.Context(), "api.PostDashboard")
	defer span.End()

	cmd := dashboards.SaveDashboardCommand{}
	if err := web.Bind(c.Req, &cmd); err != nil {
		return response.Error(http.StatusBadRequest, "bad request data", err)
	}
	return hs.postDashboard(c, cmd)
}

func (hs *HTTPServer) DeleteDashboardByUID(c *contextmodel.ReqContext) response.Response {
	// ...
}
```

An agent reading this source sees Go methods that take `ReqContext` and return `response.Response`. It **cannot** see:
- What URL path maps to each handler (that's in `api.go`)
- What authorization scope is required (that's in the route registration)
- What team owns this code
- What the performance SLA is
- That `GetDashboard` is being considered for deprecation in favor of a Kubernetes-native API

The sidecar annotation file captures all of this:

```xml
<!-- pkg/api/dashboard.aql -->
<controller bind="GetDashboard" method="GET" path="/api/dashboards/uid/{uid}"
            auth="required" owner="@grafana/dashboards-squad" audience="product"
            visibility="public" note="Primary dashboard retrieval endpoint — used by plugins and external integrations">
  <perf-critical bind="getDashboardHelper" sla="200ms p99" traced="true"
                 note="Core lookup — hits dashboard store and checks permissions. Must stay under SLA." />
</controller>

<controller bind="PostDashboard" method="POST" path="/api/dashboards/db"
            auth="required" owner="@grafana/dashboards-squad" visibility="public"
            note="Dashboard save endpoint. Handles both create and update." />

<controller bind="DeleteDashboardByUID" method="DELETE" path="/api/dashboards/uid/{uid}"
            auth="required" owner="@grafana/dashboards-squad" visibility="public"
            audience="security" />
```

### Route Registration: Authorization Scopes

The route registration in `api.go` wires handlers to paths with authorization middleware. An agent can see `authorize(ac.EvalPermission(...))` in source, but the **scope expression** and its meaning aren't obvious without domain knowledge.

```go
// pkg/api/api.go (route registration, simplified)
apiRoute.Group("/dashboards", func(dashboardRoute routing.RouteRegister) {
	dashboardRoute.Get("/uid/:uid", authorize(ac.EvalPermission(dashboards.ActionDashboardsRead, dashUIDScope)),
		routing.Wrap(hs.GetDashboard))
	dashboardRoute.Delete("/uid/:uid", authorize(ac.EvalPermission(dashboards.ActionDashboardsDelete, dashUIDScope)),
		routing.Wrap(hs.DeleteDashboardByUID))
})

apiRoute.Post("/dashboards/db", authorize(ac.EvalPermission(dashboards.ActionDashboardsWrite)),
	routing.Wrap(hs.PostDashboard))
```

```xml
<!-- pkg/api/api.aql -->
<middleware bind="Get" name="authorization" scope="dashboards:read"
           audience="security" note="RBAC check via ac.EvalPermission with dashboard UID scope" />

<middleware bind="Delete" name="authorization" scope="dashboards:delete"
           audience="security" />

<middleware bind="Post" name="authorization" scope="dashboards:write"
           audience="security" note="Write scope covers both create and update operations" />
```

---

## Step 3: Annotate the TypeScript Frontend

### API Client

The source shows a factory function returning versioned clients. The annotation documents the **cross-boundary flow**: which backend endpoint this frontend code connects to

```typescript
// public/app/features/dashboard/api/dashboard_api.ts (simplified)

export function getDashboardAPI(version?: 'v1' | 'v2') {
  if (!clients) {
    const apiVersion = getDashboardsApiVersion();
    clients = {
      legacy: new LegacyDashboardAPI(),
      v1: new K8sDashboardAPI(),
      v2: new K8sDashboardV2API(),
      unified: new UnifiedDashboardAPI(apiVersion),
    };
  }
  // ... return appropriate client
}
```

```xml
<!-- public/app/features/dashboard/api/dashboard_api.aql -->
<api-client bind="getDashboardAPI" endpoint="/api/dashboards" method="GET"
            owner="@grafana/dashboards-squad" visibility="internal"
            note="Factory returning versioned API clients. The unified client auto-selects between legacy and k8s backends based on feature flags. Changing client selection logic requires coordination with backend team." />
```

### Save Dashboard Hook

The source shows a hook that calls a mutation and publishes an event. The annotations add: cache interaction recipes, cross-boundary flow, and event documentation.

```typescript
// public/app/features/dashboard/components/SaveDashboard/useDashboardSave.tsx (simplified)

export const useDashboardSave = (dashboard: DashboardModel, isCopy: boolean) => {
  const [saveDashboardRTK] = useSaveDashboardMutation();
  const dispatch = useDispatch();

  const [state, onDashboardSave] = useAsyncFn(
    async (clone: Dashboard, options: SaveDashboardOptions) => {
      const result = await saveDashboard(saveDashboardRTK, clone, options);

      dashboard.version = result.version;
      dashboard.clearUnsavedChanges();
      appEvents.publish(new DashboardSavedEvent());

      // analytics tracking, redirect, starred name update
      return result;
    },
    [dashboard, dispatch, isCopy, saveDashboardRTK]
  );

  return { state, onDashboardSave };
};
```

```xml
<!-- public/app/features/dashboard/components/SaveDashboard/useDashboardSave.aql -->
<react-hook bind="useDashboardSave" error-handling="catches"
            owner="@grafana/dashboards-squad" visibility="internal"
            note="Orchestrates dashboard save: API call, version bump, event publish, analytics">
  <api-client bind="useSaveDashboardMutation" endpoint="/api/dashboards/db" method="POST"
              note="RTK Query mutation calling PostDashboard Go handler" />
  <event bind="publish" name="DashboardSavedEvent" direction="publish"
         audience="product" note="Notifies other components that a save completed — subscribers refresh their data" />
</react-hook>
```

### Save Dashboard UI Component

```typescript
// public/app/features/dashboard/components/SaveDashboard/SaveDashboardDrawer.tsx (simplified)

export const SaveDashboardDrawer = ({
  dashboard,
  onDismiss,
  onSaveSuccess,
  isCopy,
}: SaveDashboardModalProps) => {
  const { state, onDashboardSave } = useDashboardSave(dashboard, isCopy);
  const [options, setOptions] = useState<SaveDashboardOptions>({});

  const isProvisioned = dashboard.meta.provisioned;
  const isNew = dashboard.version === 0;

  // renders different forms based on state
};
```

```xml
<!-- public/app/features/dashboard/components/SaveDashboard/SaveDashboardDrawer.aql -->
<component bind="SaveDashboardDrawer" id="SaveDashboardDrawer"
           owner="@grafana/dashboards-squad" visibility="internal"
           note="Drawer UI for saving dashboards. Provisioned dashboards show a read-only form (infra concern). New dashboards show save-as. Contact dashboards-squad before changing form logic." />
```

---

## Step 4: Query Across Both Languages

Every annotation above carries information that isn't in source code. Here's what queries can answer:

### "What does the dashboards squad own?"

```typescript
const owned = aql.select('[owner="@grafana/dashboards-squad"]');
// → All annotated code across Go and TypeScript owned by this team
```

No source scanning. No grep for team names in comments.

### "What POST endpoints exist and what frontend code calls them?"

```typescript
// Backend handlers
const handlers = aql.select('controller[method="POST"]');
// → [{ attrs: { path: "/api/dashboards/db", owner: "@grafana/dashboards-squad" }, code: PostDashboard }]

// Frontend clients that call POST endpoints
const clients = aql.select('api-client[method="POST"]');
// → [{ attrs: { endpoint: "/api/dashboards/db" }, code: useSaveDashboardMutation() }]
```

The agent matched frontend to backend by endpoint path, a cross-boundary flow that exists implicitly across an HTTP boundary but is never expressed in either codebase

### "What authorization does the dashboard save endpoint require?"

```typescript
const auth = aql.select('middleware[scope*="dashboards:write"]');
// → [{ attrs: { name: "authorization", scope: "dashboards:write" } }]
```

The scope expression `"dashboards:write"` and what it means isn't obvious from reading `authorize(ac.EvalPermission(dashboards.ActionDashboardsWrite))`. The annotation makes it queryable.

### "What's performance-critical and what's the SLA?"

```typescript
const critical = aql.select('perf-critical[sla]');
// → [{ attrs: { sla: "200ms p99", traced: true }, code: getDashboardHelper }]
```

Performance targets are business requirements, not code facts. An agent reading the source sees a function call, not that it has a 200ms p99 contract

### "Show me the full save flow from UI to database"

```typescript
// 1. Find the UI component
const drawer = aql.select('component[id="SaveDashboardDrawer"]')[0];

// 2. Find the hook it uses (architectural context from annotation)
const hook = aql.select('react-hook[owner="@grafana/dashboards-squad"]')
  .find(h => h.selectWithin('api-client[endpoint="/api/dashboards/db"]').length > 0);

// 3. Find the API client inside the hook — cross-boundary flow
const client = hook.selectWithin('api-client')[0];
// → { attrs: { endpoint: "/api/dashboards/db", method: "POST" } }

// 4. Find the Go handler for that endpoint
const handler = aql.select(`controller[method="POST",path="${client.attr('endpoint')}"]`)[0];
// → { tag: "controller", code: PostDashboard in pkg/api/dashboard.go }

// 5. Find what middleware guards it
const middleware = aql.select('middleware[scope*="dashboards:write"]');
// → authorization with dashboards:write scope
```

The agent traced the entire flow (React component → custom hook → API call → Go handler → authorization middleware) using only annotation queries. Every piece of information (endpoint paths, auth scopes, ownership, performance targets) came from annotations, not source scanning

### "What code is relevant to the security team?"

```typescript
const security = aql.select('[audience="security"]');
// → All middleware annotations, delete handlers, etc.
```

---

## What This Demonstrates

1. **Every annotation carries non-derivable information**
   - Ownership, authorization scopes, cross-boundary flows, deprecation intent, architectural notes
   - None of this exists in source code
2. **Same query syntax across Go and TypeScript**
   - `aql.select('[owner="@grafana/dashboards-squad"]')` returns results from both languages in the same shape
3. **Cross-language flow tracing**
   - Agent follows a user action from React through an HTTP boundary into Go using endpoint path matching
   - No source reading required
4. **Tag discovery via manifest**
   - Agent read `.config/aql.schema` once and knew every queryable tag before touching any source file
5. **External annotations, clean source**
   - Every `.go` and `.tsx` file is annotation-free
   - Metadata lives in sidecar files
6. **Audience-based filtering**
   - Security, infrastructure, and product teams each see only what's relevant to them

## References

1. **^** ["Agent Annotation Schema — RFC"](./SPEC.md), full specification (scope principle, selectors, AQL)
2. **^** ["Decision Log"](./DECISIONS.md), design decisions and alternatives considered
