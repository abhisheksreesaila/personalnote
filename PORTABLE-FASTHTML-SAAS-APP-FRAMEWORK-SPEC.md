# Portable FastHTML SaaS Application Framework

**Status:** Canonical reusable specification  
**Version:** 1.0  
**Reference implementation:** FINXPLORER 2026  
**Purpose:** Reproduce the proven application architecture and design language in new products without copying FINXPLORER's financial domain, purple palette, providers, or product content.

## How To Use This Specification

Copy this document into a new repository before implementation. Give it to the coding agent as the controlling product-engineering specification.

The specification uses three requirement levels:

- **MUST**: An architectural or experience invariant. Do not change without an explicit decision.
- **SHOULD**: The proven default. Change only when the new product has a concrete reason.
- **MAY**: Optional or product-specific.

The framework deliberately separates:

1. **Reusable system rules**: backend ownership, tenant isolation, route organization, logging, async behavior, token roles, component grammar, accessibility, performance, and validation.
2. **Project substitutions**: product name, logo, colors, domain schema, navigation labels, providers, pricing, copy, and business workflows.

This is not a directive to copy the reference application verbatim. It is a contract for reproducing its engineering discipline and visual character.

---

## 1. Target Product Shape

The framework is intended for a production SaaS application with:

- Server-rendered public, authentication, billing, and status pages.
- A persistent authenticated application shell.
- A dense, responsive JavaScript application for repeated operational work.
- JSON APIs owned by the application backend.
- Multi-tenant data isolation.
- OAuth authentication and sliding sessions.
- Subscription billing and enforcement when required.
- External provider integrations, webhooks, and asynchronous jobs.
- Structured operational logging and explicit failure states.
- Desktop top navigation and mobile bottom navigation.
- Dark-first theming with an optional complete light theme.

### Non-goals

- A marketing-only landing page.
- A component-library showcase.
- A generic admin template full of disconnected cards.
- A frontend framework requirement such as React, Vue, or Angular.
- `fh-matui` or another runtime UI package.
- Business logic embedded in browser markup.

---

## 2. System Architecture

```mermaid
flowchart LR
    Browser[Browser] --> SSR[FastHTML SSR routes]
    Browser --> Shell[Static application shell]
    Shell --> API[/api/app/* JSON API]
    SSR --> Auth[fh_saas auth and sessions]
    API --> Auth
    Auth --> Host[(Host database)]
    API --> Tenant[(Tenant database)]
    Webhook[External webhooks] --> Verify[Verify and acknowledge]
    Verify --> Audit[(Webhook audit)]
    Verify --> Jobs[Background jobs]
    Jobs --> Tenant
    Jobs --> Provider[External provider]
```

### 2.1 Ownership Boundaries

The application MUST preserve these ownership boundaries:

| Layer | Owns | Must not own |
|---|---|---|
| FastHTML | App factory, routes, middleware attachment, static responses, HTML responses | Domain persistence rules |
| `fh_saas` | OAuth/session primitives, host/tenant access, billing orchestration, background job primitives, shared email utilities | Product UI, domain entities, provider semantics |
| Application backend | Domain schema, domain services, API semantics, provider adapters, webhook behavior | Browser presentation state |
| Browser application | View state, rendering, interactions, local caching, loading/error feedback | Secrets, authorization decisions, tenant selection |
| External provider package | API transport, mapping, sync mechanics, signature verification helpers | Core application identity or UI |

### 2.2 Rendering Split

The application MUST use the following split:

- **Server-rendered HTML:** public pages, login/error pages, pricing, billing, checkout pending/success, subscription walls, and simple status pages.
- **Static authenticated shell:** one HTML document for the main application experience.
- **JSON APIs:** all tenant-domain reads and writes used by the authenticated shell.
- **Redirect compatibility routes:** old page URLs MAY redirect to new shell URLs during migrations.

Do not introduce a server-rendered component dependency solely for presentation. FastHTML primitives or controlled `HTMLResponse` templates are sufficient for compact public and billing surfaces.

---

## 3. Recommended Repository Structure

```text
project/
  main.py                     # Runtime entrypoint only
  routes.py                   # App factory and route registration
  app_schema.py               # Tenant-domain models and idempotent schema setup
  services.py                 # Domain and cross-route services
  job_tasks.py                # Background job lifecycle
  email_service.py            # Product email boundary
  requirements.txt
  public/
    routes.py                 # Public SSR route registrar
    app/
      index.html              # Authenticated shell and markup
      manifest.json
      service-worker.js
      js/
        api.js                # Only browser network gateway
        app.js                # Namespace, routing, bootstrap, shared behavior
        <domain>.js           # Domain view modules
        analytics-state.js
        analytics-ui.js
        analytics-charts.js
  providers/
    <provider>/
      api.py
      session.py
      mappers.py
      sync.py
      webhooks.py
  assets/
    logo/
    favicon/
  migrations/
    host/
    tenant/
  templates/
    email/
  docs/
  tests/
    unit/
    integration/
    browser/
```

Large route files SHOULD eventually be split by route family, but route registration MUST remain deterministic and traceable from one app factory.

---

## 4. Backend Specification

### 4.1 Application Factory

The application MUST expose one deterministic `create_app()` factory.

The factory SHOULD perform work in this order:

1. Load and validate configuration.
2. Initialize host database access.
3. Configure billing/provider adapters.
4. Construct FastHTML with authentication beforeware.
5. Attach request lifecycle middleware.
6. Register billing routes and billing enforcement hooks.
7. Register public routes.
8. Register authentication routes.
9. Register shell/static routes.
10. Register application APIs.
11. Register webhook routes.
12. Wrap the complete ASGI app in sliding-session middleware.

The session wrapper MUST be outermost so authentication and billing middleware can read the session before FastHTML beforeware runs.

### 4.2 Configuration

Configuration MUST come from environment variables or a secret store. Production MUST fail fast when required values are absent or unsafe.

Recommended categories:

```text
ENVIRONMENT
PORT
BASE_URL
SESSION_SECRET
DATABASE_URL / host database settings
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_<PLAN>
EMAIL provider settings
External provider credentials
ASSET_VERSION
REQUEST_TIMING_ENABLED
```

Rules:

- Never commit credentials or connection strings.
- Never use a development session-secret fallback in production.
- Pin dependency versions where upstream changes can break auth, billing, or webhook behavior.
- Validate callback URLs against `BASE_URL`.
- Keep display prices configurable independently from provider price IDs.

### 4.3 Middleware and Request Lifecycle

The application MUST provide:

- Authentication beforeware with an explicit public skip list.
- Lazy tenant database resolution.
- Per-request tenant connection cleanup in `finally`.
- Request timing with `Server-Timing` and `X-Response-Time` headers.
- Central exception logging without exposing internals to users.
- Any provider-specific safety middleware only when its retry/idempotency contract is understood.

Public skip lists MUST explicitly include:

- Landing/public content routes.
- Login and OAuth callback.
- Error and logout routes.
- Pricing and checkout completion routes.
- Signed webhook ingress.
- Static assets, manifest, favicon, and service worker.

Protected APIs MUST never be added to the public skip list for convenience.

### 4.4 Authentication and Session Contract

Required flow:

1. `/login` begins OAuth or serves the authentication shell.
2. `/auth/callback` validates OAuth state and completes authentication.
3. The callback resolves membership and tenant identity.
4. Tenant schema initialization runs idempotently.
5. First-login onboarding runs idempotently.
6. Session stores only safe identity/cache values.
7. `/logout` clears the session and performs a full redirect.

Identity resolution MUST prefer request-scoped authenticated state and MAY fall back to session state where middleware ordering requires it.

Sessions MUST be:

- Signed with a strong environment secret.
- Secure and HTTP-only in production.
- SameSite constrained.
- Sliding only for authenticated activity.
- Free of provider secrets except short-lived tokens when package constraints require them.

### 4.5 Host and Tenant Data Planes

The framework MUST use explicit two-plane ownership.

**Host database owns:**

- Global users.
- Tenant memberships.
- Tenant registry and connection metadata.
- Billing plans and subscriptions.
- Cross-tenant audit records.
- Invitations and onboarding state.

**Tenant database owns:**

- Product-domain entities.
- User-created records.
- Provider-synchronized domain data.
- Tenant settings.
- Tenant-scoped jobs and notifications.
- Webhook audit data when it contains tenant-domain details.

Rules:

- Every domain query MUST scope to authenticated user/tenant selectors.
- Never trust tenant IDs from browser payloads.
- Tenant schema setup MUST be idempotent.
- Schema evolution SHOULD be additive and migration-driven.
- Broad aggregation subqueries MUST be scoped before grouping.
- Parameterized SQL or structured query APIs MUST be used.

### 4.6 Route Families

Use predictable namespaces:

```text
/                         public landing
/about, /privacy, ...     public SSR pages
/login
/auth/*
/logout
/pricing
/settings/billing
/checkout/*
/billing-portal
/app                      authenticated shell
/app/{view}               deep-link shell routes
/api/app/*                authenticated product API
/api/webhooks/<provider>  webhook ingress
/health                   public operational health
```

The actual `/app` and `/api/app` prefixes MAY change, but the separation MUST remain clear.

API rules:

- Return stable JSON shapes.
- Use correct status codes.
- Validate request bodies.
- Return user-safe errors.
- Log full exceptions server-side.
- Preserve omitted fields during partial updates.
- Commit mutations explicitly where the database wrapper requires it.
- Keep API and view concerns separate.

### 4.7 External Provider Adapter Contract

Each provider SHOULD expose narrow functions such as:

```python
async def create_or_get_session(identity) -> ProviderSession: ...
async def refresh_resource(...) -> int: ...
async def sync_records(...) -> int: ...
def map_provider_record(record) -> DomainRecord: ...
def verify_webhook_signature(body, headers) -> VerificationResult: ...
```

Provider identifiers MUST be persisted in an indexed host membership field when they are used to resolve a tenant from a webhook.

Provider modules MUST NOT decide tenant authorization. They receive resolved identity and database dependencies from application services.

### 4.8 Webhook Contract

Webhook processing MUST be secure, idempotent, and observable.

Required lifecycle:

1. Read raw body.
2. Verify signature and timestamp before acknowledgement in production.
3. Parse payload.
4. Persist event with provider event ID as an idempotency key.
5. Mark event `PROCESSING`.
6. Route to a typed event handler.
7. Mark `COMPLETED` only after all required work succeeds.
8. Mark `FAILED` and persist a safe error summary when an exception occurs.
9. Return batch counts for processed, failed, skipped, and duplicate events.

Handlers MUST re-raise failures. A caught-and-logged exception MUST NOT be interpreted as success.

Raw webhook payload retention MUST have an explicit access and retention policy.

### 4.9 Background Jobs

Long-running provider sync, enrichment, report generation, or bulk operations MUST execute as jobs rather than block an HTTP request.

Job states:

```text
queued -> running -> completed
                  -> failed
```

Each job MUST record:

- Job ID and type.
- Source (`manual`, `webhook`, `scheduled`, etc.).
- Created, started, and completed timestamps.
- Retry count.
- Safe input summary.
- Result counts.
- Error class and diagnostic log.

The UI SHOULD poll a status endpoint with a bounded retry window and surface a local progress state.

### 4.10 Logging and Observability

Use standard Python logging with machine-searchable `key=value` lifecycle messages.

Canonical fields:

```text
event=<domain.action>
outcome=<started|queued|succeeded|failed|skipped|duplicate>
request_id=<id>
tenant_id=<safe-id>
user_id=<safe-id>
job_id=<id>
webhook_event_id=<id>
connection_id=<id>
source=<manual|webhook|scheduled>
duration_ms=<number>
count=<number>
error_class=<type>
```

Example:

```python
logger.info(
    "event=sync.job outcome=succeeded job_id=%s duration_ms=%.1f record_count=%d",
    job_id,
    duration_ms,
    record_count,
)
```

INFO MUST NOT contain:

- Email addresses.
- Access/session tokens.
- Raw payloads or form bodies.
- Financial or health details.
- User-entered descriptions.
- Category names when they reveal private activity.
- Database connection strings.

Use DEBUG for low-level provider/session mechanics, WARNING for recoverable anomalies, and ERROR/exception for actual failed operations.

### 4.11 Security Baseline

The framework MUST include:

- Strong session-secret validation.
- OAuth state validation.
- Secure production cookies.
- Webhook signature and freshness validation.
- Tenant authorization on every protected operation.
- Parameterized SQL.
- Escaping for values inserted into server-rendered HTML.
- No secrets in browser JavaScript.
- User-safe error responses.
- Rate-limit/retry handling for external providers.
- Dependency vulnerability review before release.

Recommended additions:

- Content Security Policy.
- CSRF protection for cookie-authenticated mutations.
- Request correlation IDs.
- Secret-store integration.
- Retention rules for payload and job diagnostics.

---

## 5. Frontend Design System

### 5.1 Design Intent

The product SHOULD feel like a precise, modern instrument:

- Quiet and work-focused.
- Dense without becoming cramped.
- Technically literate without looking like a developer demo.
- Strong brand signal through typography, mark, and one accent family.
- Thin ruled boundaries instead of floating rounded cards.
- Fast local feedback for repeated actions.

Landing/public surfaces MAY be more cinematic. Authenticated operational views MUST prioritize scanning, comparison, and repeated action.

### 5.2 Fixed Visual Invariants

These rules carry between projects even when colors change:

1. Dark-first layered substrate with an optional complete light theme.
2. Dual typography: readable sans for prose; mono for labels, navigation, metrics, controls, and status.
3. Compact symbol-plus-wordmark lockup with one accented word fragment.
4. One-pixel borders as the main separation system.
5. Low-radius or square panels; default radius between 0 and 6px.
6. Uppercase micro-labels with positive letter spacing.
7. Dense data surfaces and stable dimensions.
8. Semantic colors reserved for success, warning, and failure.
9. Motion is brief and meaningful, never continuous decoration.
10. Every async surface has loading, empty, error, and success behavior.

### 5.3 Configurable Token Roles

Every new project MUST define these semantic CSS variables. Hex values are project-specific.

```css
:root {
  --bg: #...;
  --surface: #...;
  --surface-2: #...;
  --surface-3: #...;
  --border: #...;
  --border-hi: #...;

  --accent: #...;
  --accent-hi: #...;
  --accent-dim: color-mix(...);
  --accent-glow: color-mix(...);

  --success: #...;
  --success-dim: #...;
  --warning: #...;
  --warning-dim: #...;
  --danger: #...;
  --danger-dim: #...;

  --text: #...;
  --text-mid: #...;
  --text-dim: #...;

  --font-mono: '<chosen mono>', monospace;
  --font-sans: '<chosen sans>', sans-serif;
  --nav-height: 58px;
}
```

Light mode MUST redefine every surface, structure, text, accent, and semantic token. Do not implement light mode as an inversion filter.

### 5.4 Color Selection Rules

- Choose one primary brand accent and one brighter interaction variant.
- The product MUST remain readable in grayscale except for semantic status meaning.
- Do not let one hue dominate every surface.
- Status colors MUST not be reused as general decoration.
- Text and controls MUST meet practical contrast requirements.
- Dim text remains readable; it is not placeholder-gray decoration.

### 5.5 Typography

Recommended role split:

| Role | Typeface | Treatment |
|---|---|---|
| Body/prose | Sans | 14-16px, line-height 1.5-1.7 |
| Navigation | Mono | 9-11px, uppercase, spaced |
| Field labels | Mono | 8-10px, uppercase, spaced |
| Metrics | Mono | 18-44px, 700-800 weight |
| Headings | Sans or mono by context | No negative letter spacing |
| Table data | Sans/mono by data type | Stable tabular alignment |

Do not scale font sizes directly with viewport width. Use discrete responsive breakpoints and `clamp()` only for genuine display headings.

### 5.6 Spacing and Shape

Use an 4px base with the practical rhythm:

```text
4, 8, 12, 16, 20, 24, 28, 32, 40, 48
```

Rules:

- Compact controls: 7-10px vertical padding.
- Panel padding: 16-24px.
- Major section spacing: 28-48px.
- Cards/panels: 0-6px radius.
- Modals: no more than 8px radius unless the product explicitly changes the language.
- Do not nest decorative cards.
- Page sections are unframed bands; cards are individual repeated items or real tools.

### 5.7 Brand Lockup

The brand lockup MUST be reused across landing, login, app navigation, pricing, billing, and status pages.

```html
<a class="brand-lockup" href="/">
  <img class="brand-mark" src="/assets/logo/icon.svg" alt="PRODUCT logo">
  <span class="brand-wordmark"><span class="brand-accent">PREFIX</span>SUFFIX</span>
</a>
```

The mark, wordmark, and accented fragment are project substitutions. Their arrangement is invariant.

### 5.8 Navigation

Desktop authenticated navigation:

- Sticky top bar.
- Brand lockup at the start.
- Compact tab-style primary destinations.
- Visible current-state treatment.
- Theme/profile/logout controls at the end.

Mobile authenticated navigation:

- Fixed bottom navigation for 4-5 primary destinations.
- Familiar icons plus short labels.
- Safe-area padding.
- Stable height so dynamic content never shifts it.

Landing navigation:

- Sticky top bar.
- Full links on desktop.
- Menu button and drawer on narrow screens.
- One clear primary CTA.

Browser history and direct URLs MUST restore the correct view.

### 5.9 Component Grammar

Required primitives:

- Accent, outline, ghost, and danger buttons.
- Icon buttons with tooltips.
- Status badges and pills.
- Dense data panels.
- KPI/summary blocks.
- Inputs, selects, toggles, segmented controls, and sliders as appropriate.
- Toasts and inline error regions.
- Skeleton/loading placeholders.
- Empty states with a direct recovery action.
- Modal dialogs and side drawers.
- Desktop tables and mobile-safe responsive alternatives.

Rules:

- Use icons for familiar actions such as close, edit, delete, download, and navigation.
- Keep button dimensions stable across loading states.
- Secondary row actions MAY appear on hover on desktop but MUST remain accessible on touch.
- Never rely on color alone for state.
- Do not put explanatory marketing copy inside operational screens.

### 5.10 Modal and Drawer Contract

Every dialog MUST provide:

- `role="dialog"` and `aria-modal="true"`.
- An accessible label or labelled heading.
- Initial focus inside the dialog.
- Focus trap.
- Escape-to-close unless destructive work is in progress.
- Backdrop click only when accidental dismissal is safe.
- Explicit close/cancel control.
- Focus return to the opener.
- Local loading and error states.

Async modal rules:

- Paint the modal immediately.
- Load secondary data after first paint.
- Cache stable catalogs/options.
- Use `AbortController` or sequence tokens to ignore stale responses.
- Do not refetch a collection already present in application state solely to prefill a form.

### 5.11 Charts

ECharts SHOULD be the default chart engine for dense dashboards.

- Prefer SVG rendering for clarity and exportability.
- Animate each chart only on first render.
- Updates and filtering SHOULD use zero-duration or very brief transitions.
- Chart clicks SHOULD drill into a filtered detail surface.
- Resize handlers MUST be guarded and debounced where appropriate.
- Tooltips use the same token and typography system.
- Charts need adjacent text summaries for accessibility and comprehension.

### 5.12 Responsive Behavior

The implementation MUST be verified at minimum at:

```text
390 x 844    mobile
768 x 1024   tablet
1440 x 900   desktop
1920 x 1080  wide desktop
```

Requirements:

- No horizontal page overflow.
- Text does not overlap or clip controls.
- Fixed-format elements use stable dimensions or aspect ratios.
- Tables provide a deliberate narrow-screen strategy.
- Modals fit within the viewport and scroll internally.
- Bottom navigation does not cover content.
- Touch targets are at least approximately 40px where practical.

---

## 6. Browser Application Runtime

### 6.1 Namespace and Module Pattern

For an unbundled implementation, use one product namespace:

```javascript
window.APP = window.APP || {};
```

Recommended script ownership:

- `api.js`: network requests, normalization, cache, invalidation.
- `app.js`: bootstrap, routing, shared namespace, theme, global UI behavior.
- `<domain>.js`: domain rendering and interactions.
- `<feature>-state.js`: serializable feature state and URL synchronization.
- `<feature>-ui.js`: DOM rendering and interaction orchestration.
- `<feature>-charts.js`: chart instance ownership.

Classic scripts MUST load in a documented order and avoid duplicate global declarations. A future project MAY use ESM, but ownership boundaries remain the same.

### 6.2 Data Layer

All browser network calls MUST go through `APP.api`.

The data layer owns:

- `fetch()` calls.
- Same-origin credentials.
- Status handling.
- JSON parsing.
- Response normalization.
- Short-lived cache.
- Mutation invalidation.
- Optional request cancellation.

Views MUST consume normalized records rather than raw backend shapes.

### 6.3 Bootstrap

Application bootstrap SHOULD:

1. Start independent requests concurrently.
2. Hydrate persisted UI configuration concurrently with domain data.
3. Use expensive fallback endpoints only after the normal source fails.
4. Assign normalized state once.
5. Render the active route.
6. Start non-critical maintenance work without blocking first interaction.

Avoid serial request waterfalls.

### 6.4 State and URLs

- Primary view state MUST be represented in the URL.
- Filters that users may bookmark SHOULD use query parameters.
- Back/forward navigation MUST restore state.
- Ephemeral modal state MAY remain local.
- Server-persisted custom layouts SHOULD hydrate before their tabs are rendered, but hydration must run concurrently with unrelated data loading.

### 6.5 Async Safety

Every mutable async surface MUST address stale responses.

Use one or more:

- `AbortController`.
- Monotonic request sequence counters.
- Route/view identity checks after `await`.
- Cache keys that include all relevant selectors.

Polling MUST have a maximum duration and terminal failure state.

### 6.6 Performance Defaults

- Cache stable catalogs in memory.
- Invalidate cache after mutations.
- Virtualize long lists.
- Avoid rebuilding large DOM trees on every keystroke.
- Debounce search/filter inputs.
- Keep chart instances and update options.
- Avoid repeated intro animations.
- Serve shell and active JS with cache policy appropriate to deployment/versioning.
- Use server-side aggregation and pagination for large data.
- Measure first-open workflows, not only warm interactions.

---

## 7. Accessibility Requirements

The template MUST include:

- Semantic landmarks and headings.
- Labels for all form controls.
- Visible `:focus-visible` states.
- Keyboard-operable navigation and actions.
- Dialog focus management.
- `aria-busy` on async containers.
- Accessible names for icon-only buttons.
- Text/status labels in addition to color.
- Reduced-motion support.
- Sufficient text and control contrast.
- Meaningful image alt text and empty alt text for decorative images.

Automated checks do not replace keyboard and screen-reader smoke tests.

---

## 8. Validation Contract

### 8.1 Backend

- Compile all active Python.
- Construct the app in a clean process.
- Assert required routes exist.
- Test public/protected route behavior.
- Test tenant isolation.
- Test webhook signature, duplicate, success, and failure paths.
- Prove failed work is never marked successful.
- Test job state transitions and retries.
- Run SQL migration/idempotency checks.
- Run `git diff --check`.

### 8.2 Frontend

- Syntax-check every JavaScript file.
- Verify script load order.
- Verify no duplicate exported function definitions.
- Test loading, empty, failure, and recovery states.
- Test rapid input/selection changes under throttled networking.
- Confirm no duplicate bootstrap requests.
- Confirm first-open modal responsiveness.
- Verify direct URLs and browser history.

### 8.3 Browser

Use Playwright or equivalent to verify:

- Desktop, tablet, and mobile screenshots.
- No horizontal overflow.
- No overlapping text or controls.
- Logo and referenced assets load.
- Dialog keyboard behavior.
- Primary workflows complete.
- Charts are nonblank and resize correctly.
- Authenticated and unauthenticated route behavior.
- Console contains no errors.

---

## 9. New-Project Substitution Worksheet

Complete this before asking an agent to scaffold a project.

```text
Product name:
Product category:
Primary user:
Core repeated workflow:
Public pages required:
Authenticated views:
Domain entities:
External providers:
Authentication provider:
Billing required? Plans/prices:
Host database:
Tenant database strategy:
Brand mark path:
Wordmark and accented fragment:
Primary accent color:
Dark surface palette:
Light surface palette:
Success/warning/danger colors:
Sans font:
Mono font:
Desktop navigation destinations:
Mobile navigation destinations:
Required charts:
Deployment target:
Required environment variables:
Compliance/privacy constraints:
```

An agent MUST ask for missing decisions rather than silently copying FINXPLORER-specific values.

---

## 10. Implementation Phases

### Phase 1: Foundation

- Create project structure.
- Add typed/fail-fast configuration.
- Construct app factory and middleware ordering.
- Add host/tenant database boundaries.
- Add logging configuration and health endpoint.

### Phase 2: Identity and Billing

- Implement OAuth/session flow.
- Implement tenant resolution and schema bootstrap.
- Add pricing, checkout, portal, and enforcement when required.
- Validate callback, cookie, and skip-list behavior.

### Phase 3: Design System and Shell

- Define tokens and themes.
- Add brand lockup.
- Build landing/login/status SSR surfaces.
- Build desktop top navigation and mobile bottom navigation.
- Add component primitives and accessibility behavior.

### Phase 4: Domain API and Views

- Define stable API contracts.
- Build `APP.api` normalization/cache layer.
- Implement domain modules one workflow at a time.
- Add local loading/error/empty states.

### Phase 5: Providers and Async Work

- Add provider package.
- Add verified/idempotent webhook pipeline.
- Add durable background jobs and polling UI.
- Add correlated logs and failure tests.

### Phase 6: Hardening

- Profile first-open workflows.
- Add cancellation/race protection.
- Add SQL scoping and aggregation tests.
- Run responsive/browser/accessibility validation.
- Complete deployment and troubleshooting documentation.

---

## 11. Anti-patterns

An implementation is out of spec if it:

- Adds `fh-matui` or another UI runtime merely to render basic pages.
- Mixes host and tenant data ownership.
- Trusts tenant/user IDs from browser payloads.
- Marks webhook or job work successful after catching an exception.
- Logs secrets, emails, raw payloads, or private domain values at INFO.
- Performs browser requests outside the shared data layer.
- Serializes independent bootstrap requests.
- Refetches existing collections to prefill a modal.
- Allows stale async responses to overwrite newer state.
- Reanimates every chart after every filter change.
- Uses giant marketing typography inside operational panels.
- Uses nested decorative cards or excessive rounded containers.
- Omits mobile navigation, dialog focus management, or failure states.
- Declares completion without executable and browser validation.

---

## 12. Definition of Done

A derived application is complete when:

- Architecture boundaries are documented and respected.
- Authentication, session, tenancy, and billing flows are deterministic.
- Host and tenant data are isolated.
- Public SSR and authenticated shell routes are clearly separated.
- APIs have stable contracts and authorization.
- Webhooks are verified, idempotent, audited, and failure-correct.
- Jobs expose durable lifecycle states.
- Operational logs are correlated and privacy-safe.
- The design uses semantic tokens and the specified component grammar.
- Desktop and mobile navigation are complete.
- All async surfaces handle loading, empty, error, success, and stale responses.
- Accessibility requirements are implemented.
- Python, JavaScript, route, test, and browser validations pass.
- Project-specific substitutions are documented.

---

## 13. Copy-Paste Agent Brief

Use this short brief when the full specification has already been copied into the target repository:

> Build this project according to `docs/PORTABLE-FASTHTML-SAAS-APP-FRAMEWORK-SPEC.md`. Treat every MUST as binding and every SHOULD as the default. First inspect the repository and complete the New-Project Substitution Worksheet with me. Do not copy FINXPLORER-specific colors, financial entities, providers, route prefixes, or content. Preserve the framework's FastHTML + `fh_saas` ownership boundaries, host/tenant isolation, SSR/public versus authenticated-shell split, structured logging, verified/idempotent webhooks, durable jobs, semantic token system, compact technical design language, shared browser data layer, race-safe async behavior, accessibility requirements, and executable/browser validation contract. Produce a staged plan before editing, implement in small validated slices, and do not add product features outside the stated scope.
