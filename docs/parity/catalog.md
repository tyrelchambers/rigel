# Catalog Panel — Normative Behavior Spec

Port of `Sources/Helmsman/Panels/Catalog/` (Swift/SwiftUI) to web (React/TypeScript).

## Overview

The Catalog panel provides guided installation of 54 pre-curated Kubernetes applications. The panel discovers **installed** apps by matching container image refs against running Deployments, StatefulSets, and Pods, surfaces a searchable/category-filterable grid, and drives multi-step install wizards for **baked** (deterministic YAML-templating) and **not-yet-baked** (Claude-generated) installs.

### Source Files
- Swift panel: `Sources/Helmsman/Panels/Catalog/{CatalogPanel,CatalogViewModel,CatalogInstallWizard,CatalogInstallWizardModel}.swift`
- Swift domain: `Sources/Helmsman/Catalog/{CatalogApp,PlaceholderScanner,InstallMatch,InstallArtifacts,ManifestShape}.swift`
- Catalog data: `Sources/Helmsman/Resources/catalog.json` (54 apps, 2549 lines)
- Install executors: `Sources/Helmsman/Panels/Actions/{WorkloadCommander,HelmCommander}.swift`

---

## Catalog Schema (catalog.json)

Each app in the top-level `"apps"` array:

```
{
  "id":                    string (slug; doubles as default Helm release name)
  "name":                  string (display name)
  "tagline":               string (one-liner)
  "description":           string (multi-paragraph description)
  "category":              string (enum: database, observability, productivity, dev-tools, media, network, other)
  "iconSystemName":        string (SF Symbol name, e.g. "lock.circle.fill")
  "docsURL":               string (URL)
  "repoURL":               string | null (GitHub/project repo URL)
  "homepageURL":           string | null
  "tags":                  string[] (searchable tags)
  
  "matchImages":           string[] (container image refs to detect installation)
                           Example: ["docker.io/vaultwarden/server", "ghcr.io/plausible/community-edition"]
                           Matching is tag- and registry-host insensitive.
  
  "requirements": {
    "cpuRequest":          string (Kubernetes quantity, e.g. "250m")
    "cpuLimit":            string | null
    "memoryRequest":       string (e.g. "512Mi")
    "memoryLimit":         string | null
    "storageGiB":          integer | null (nil = stateless; surfaces Storage field in wizard)
  }
  
  "persistence":           boolean (true = needs PVC; surfaces "Storage" field in Configure)
  "exposesIngress":        boolean (true = surfaces "Ingress hostname" field in Configure)
  "notes":                 string | null (caveats / gotchas shown in detail sheet)
  "installPromptTemplate": string (prompt sent to Claude; supports {{instance}}, {{namespace}}, 
                                   {{hostname}}, {{nodeName}}, {{storage}}, {{notes}}, 
                                   {{clusterIssuer}}, {{redirectMiddleware}} placeholders)
  
  "install": {  (absent => manifest mode as default)
    "mode":      string ("manifest" | "helm")
    
    // Manifest mode:
    "manifest":  string (multi-doc YAML with {{vars}} and <FILL_ME_IN> placeholders; nil = not baked)
    
    // Helm mode:
    "repoName":  string (Helm repo alias, e.g. "sentry")
    "repoURL":   string (Helm repository URL)
    "chart":     string (chart name)
    "version":   string | null (optional semver pin)
    "values":    string ({{var}}-templated Helm values YAML; nil = not baked)
    "releaseName":string (Helm release name; overridden per-install with instance value)
    
    // Baked installs only:
    "secrets": [
      {
        "key":          string (Secret data key)
        "label":        string (form field label)
        "description":  string | null
        "kind":         string ("random" | "user")
        "length":       integer | null (random only; generation length)
        "format":       string (random only; e.g. "alphanumeric")
        "required":     boolean (user fields gate Continue)
      }
    ]
  }
}
```

### Catalog Entry Examples

**Manifest mode (vaultwarden, 54 apps default)**:
```json
{
  "id": "vaultwarden",
  "install": {
    "mode": "manifest",
    "manifest": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: {{instance}}-secrets\n  namespace: {{namespace}}\n..."
  }
}
```

**Helm mode (sentry)**:
```json
{
  "id": "sentry",
  "install": {
    "mode": "helm",
    "repoName": "sentry",
    "repoURL": "https://sentry-kubernetes.github.io/charts",
    "chart": "sentry",
    "version": "31.7.1",
    "values": "user:\n  create: true\n  email: <FILL_ME_IN>\n..."
  }
}
```

---

## Grid & Discovery Panel

### Layout
- **Header**: Title "Catalog" with app count, All/Installed scope toggle, search field, "Check for updates" button
- **Category bar**: Horizontal scrollable pill bar (all, database, observability, …)
- **Grid**: Responsive multi-column card grid (adaptive 260–360px, spacing 12px)
- **Cards**: Show icon, name, tagline, category + resource requirements (cpu, memory, storage), installed badge if detected

### State & Filtering
- **Search**: Case-insensitive substring match on name, tagline, description, tags
- **Category**: Filter by single category (click to toggle on/off)
- **Scope**: All (default) or Installed only
- **Installed detection**: Predicate `installedAppIDs(apps, deployments, statefulSets, pods)` reads live cluster state

### User Actions
1. **Tap a card** → Open detail sheet
2. **Click "All" / "Installed"** → Toggle scope (UI scope, not a kubectl call)
3. **Type search / click category** → Filter apps live (UI only)
4. **Click card's "Update" button** (if update check found newer version) → Hand off to main chat with `onUpdate(app)`
5. **Click card's recheck icon** → Invoke `onCheckApp(app)` (update check only; no cluster mutation)
6. **Click header "Check for updates"** → Invoke `onCheckNow()` (update check; no cluster mutation)

### Installed App Detection

**`installedAppIDs(apps: [CatalogApp], deployments: [Deployment], statefulSets: [StatefulSet], pods: [Pod]) -> Set<String>`**

Pure function, no side effects; recompute freely on every render to track watch stream.

1. Collect normalized repo paths from all running containers in Deployments, StatefulSets, and Pods
   - Normalization: drop registry host (if it looks like a host — contains `.` or `:`, or is `localhost`) and drop `library/` prefix
   - Example: `docker.io/library/nextcloud:29` normalizes to `nextcloud`
2. For each catalog app, check if ANY of its `matchImages` matches ANY running container image (after normalization)
3. Return set of installed app IDs

**Matching logic**:
```
repoPathsMatch(running: String, candidate: String) -> Bool:
  canonicalRepoPath(running) == canonicalRepoPath(candidate)
  
canonicalRepoPath(path: String) -> String:
  - drop leading registry-host segment if it contains `.`, `:`, or is `localhost`
  - drop leading `library/` prefix
  - Example: "docker.io/vaultwarden/server" -> "vaultwarden/server"
  - Example: "vaultwarden/server" -> "vaultwarden/server" (identical)
```

Result: An app is installed if *any* of its `matchImages` matches *any* running image, host- and tag-insensitively.

### Empty/Error States
- **Catalog load error**: Banner below category bar shows error text (mono font, red/error styling)
- **No apps found** (search/category): Grid shows no cards (no "no results" message in source; UI may add one)
- **Installed scope with no matches**: Grid shows no cards

---

## Detail Sheet

**User action**: Tap a card → Opens modal/sheet showing:
- App icon + name + tagline
- Description (plain text, multi-paragraph)
- Resource requirements (formatted: cpu request/limit, memory request/limit, storage)
- Matched runtime instance (if installed): full image ref, tag/version
- Links: Docs, Repo, Homepage (open externally)
- Tags: Displayed as pills
- Notes: If present, shown in a separate section
- **Install button** (or "Reinstall"): Opens install wizard

---

## Install Wizard Flow

Drives multi-step supervised installation with state machine `WizardStep` enum:

```
.configure → .generating / .secrets → .review → .applying → .verifying → .done
                                   ↘ .failed (any step can fail) ↗
```

### Step 1: Configure

**UI**: Form with fields (controlled inputs, no react-hook-form required):

- **Instance name**: text input; auto-filled with app.id; used as Helm release name
- **Namespace**: dropdown (seeded from cluster namespaces); default "default"
- **Ingress hostname** (if `app.exposesIngress`): text input; example placeholder from context defaults
- **Storage size (GiB)** (if `app.persistence`): number input; default from `app.requirements.storageGiB`
- **Node pin** (optional): dropdown of fitting node names or "Any"; affects manifest substitution
- **ClusterIssuer** (if `app.exposesIngress`): dropdown of discovered ClusterIssuers or free-text fallback
- **Pull secret account** (if any available in context): dropdown or "none"
- **Notes** (optional): text area; included in install prompt for Claude

**Gate to continue**:
- instance non-empty
- namespace non-empty
- hostname non-empty (if exposesIngress)
- storageGiB > 0 (if persistence)

**Action**: Click "Continue" (baked apps) or "Generate manifest" (not-yet-baked):
- Collect field values into `templateVars: [String: String]`
- **Baked path**: Substitute into artifact, jump to Secrets step
- **Not-yet-baked path**: Start Claude session with `installPromptTemplate` (substituted), jump to Generating

### Step 2: Generating (not-yet-baked only)

**UI**: Chat-like transcript, showing user prompt and Claude's replies as they stream in.

**Action**: After Claude responds with YAML + optional secrets schema:
- Parse closing ````yaml` fence to extract manifest (or helm values for Helm mode)
- Parse closing ````secrets` JSON fence (if present) to extract `SecretFieldSpec[]`
- Store manifest in `manifestYAML` and secret specs in `secretSpecs`
- Auto-advance to Secrets step if placeholders found; otherwise to Review

**Error states**:
- **Claude error**: Button to retry or hand off to main chat
- **No YAML generated**: Show error, allow retry

### Step 3: Secrets (conditional)

Shown if manifest contains:
- `<FILL_ME_IN>` markers
- Empty values inside a `Secret`'s `data` / `stringData` block

**UI**: 
- Form with a field per placeholder / empty secret value
- **User-filled fields** (kind=user): text input; required gates Continue
- **Auto-generated fields** (kind=random): pre-filled with strong random value; copy button; can manually override
- Display `label` and `description` per `SecretFieldSpec`

**Action**: Click "Continue":
- Validate all required fields non-empty
- Fill placeholders in manifest using `PlaceholderScanner.substitute(manifest, values: [String: String])`
- Refuse to apply if any `<FILL_ME_IN>` marker remains
- Advance to Review

### Step 4: Review

**UI**:
- **Manifest preview** (scrollable, mono font):
  - For manifest mode: the final filled YAML
  - For Helm mode: `helm template` preview (live rendered from values + chart)
- **Resource summary**: Parsed resources from manifest (Deployments, Services, ConfigMaps, Secrets, PVCs, …) with their declared counts
- Installation summary: instance name, namespace, ingress hostname, storage

**Action**: Click "Install":
- For **manifest mode**: POST filled YAML to `/api/apply` (via HTTP)
- For **Helm mode**: POST to `/api/helm` with descriptor + values (via HTTP)
- Advance to Applying

**Preview generation (Helm mode)**:
- Live `helm template [release] [repo/chart] -n [namespace] -f [values-file]`
- No-op outside Helm mode
- Degradation only; actual Apply runs real helm command

### Step 5: Applying

**UI**: Streaming log output from kubectl/helm process (mono font)

**Execution**:

#### Manifest mode: POST `/api/apply`
```
POST /api/apply
Content-Type: application/json

{
  "yaml": "<multi-doc YAML payload>"  // or raw YAML body if server prefers stdin
}

200 OK
{
  "code": 0,
  "stdout": "<kubectl output>",
  "stderr": ""
}
```

**Server-side**:
```bash
kubectl --context [ctx] apply -f - <<< "$YAML_PAYLOAD"
```

Never interpolate YAML into shell; always pipe via stdin.

#### Helm mode: POST `/api/helm`
```
POST /api/helm
Content-Type: application/json

{
  "repoName": "sentry",
  "repoURL": "https://...",
  "chart": "sentry",
  "version": "31.7.1",
  "releaseName": "my-sentry",
  "namespace": "apps",
  "values": "<YAML values>"
}

200 OK
{
  "code": 0,
  "stdout": "<helm output>",
  "stderr": ""
}
```

**Server-side** (ordered steps):
1. `helm repo add [repoName] [repoURL]` (idempotent: "already exists" is ok)
2. `helm repo update [repoName]`
3. `helm upgrade --install [releaseName] [repoName]/[chart] --version [version] -n [namespace] --create-namespace -f [values-file]`

All with `--kube-context [ctx]` prepended.

**Registry auth reconciliation** (pre-apply, both modes):
- If `selectedRegistryAccount` is set, ensure its pull secret exists in target namespace before apply
- Idempotent: no-op if secret already exists
- Failure aborts to Failed step with error message

**Result handling**:
- If exit code 0: Advance to Verifying
- If non-zero: Advance to Failed step with stderr message

### Step 6: Verifying

**UI**: Checklist of expected resources (Deployments, Services, ConfigMaps, PVCs, …) with their readiness state:
- **Applied** (non-workload): green checkmark, done
- **Creating**: yellow indicator, waiting for first pods
- **Starting**: yellow, "[ready pods] / [total pods]"
- **Ready**: green checkmark, all pods Running + Ready
- **Failed**: red, reason from pod status

**Polling** (live from cluster cache):
- Scan `cache.pods` for pods matching `namespace` + label `app.kubernetes.io/instance` = instance name
- Poll every 1.5 seconds for up to **soft timeout** (5 minutes): show "taking a while" affordance but keep polling
- **Hard timeout** (10 minutes): stop polling and hand off to main chat with context
- Advance to Done when all expected pods report Ready

**Handoff to chat** (on trouble):
- If a pod restarts ≥3 times during verify, or soft timeout elapses without all pods Ready: auto-hand off to main chat
- Provide: app name, namespace, instance, ingress hostname, pod statuses, recent events, manifest YAML
- Breadcrumb: "Continue installing [app name]"

### Step 7: Done

**UI**: Success message, app name, installation summary (namespace, instance, ingress hostname).
**Action**: Click "Close" → Close wizard, optionally refresh grid to show installed badge.

### Step 8: Failed

**UI**: Error message, buttons:
- "Back" → Return to previous step (only if user explicitly clicked back; error doesn't auto-block back)
- "Retry" → Re-enter the failed step (Applying or Verifying, depending on where error occurred)
- "Hand off to chat" → Copy transcript + context and jump to main chat with a breadcrumb

---

## Template Substitution

**Variables** (from Configure step):

| Variable | Source | Example |
|----------|--------|---------|
| `{{instance}}` | Instance name field | `my-vaultwarden` |
| `{{namespace}}` | Namespace dropdown | `apps` |
| `{{hostname}}` | Ingress hostname field | `vw.example.com` |
| `{{nodeName}}` | Node pin dropdown (or empty) | `worker-1` or `` |
| `{{storage}}` | Storage GiB field (numeric) | `100` |
| `{{clusterIssuer}}` | ClusterIssuer dropdown | `letsencrypt-prod` |
| `{{redirectMiddleware}}` | Derived traefik middleware name | `${instance}-redirect` |
| `{{notes}}` | Notes text area | `(user input or empty)` |

**Substitution** (`CatalogApp.substitute(text: String, vars: [String: String]) -> String`):
```swift
// Replace {{key}} with vars[key]; missing keys left as literal {{key}}
for (key, value) in vars {
    text = text.replacingOccurrences(of: "{{\(key)}}", with: value)
}
```

Unknown variables remain as `{{unknown}}` so gaps surface in the manifest preview rather than silently disappearing.

---

## Placeholder Scanning & Validation

### <FILL_ME_IN> Markers

Literal string `<FILL_ME_IN>` anywhere in the manifest signals a required user fill-in.

**Detection**: Simple substring match.
**Refusal**: Never apply a manifest with unfilled markers.

### Empty Secret Values

Inside a Secret's `data:` or `stringData:` block, any empty value (e.g., `key: ""` or `key:`) is treated as a placeholder.

**Scanner** (`PlaceholderScanner`):
1. Walk YAML line-by-line
2. Track when inside a Secret resource (by kind) and at what indentation the `data:`/`stringData:` block starts
3. Any key-value at that indentation+2 with empty value is a placeholder
4. Return list of placeholder keys (deduplicated)

**Examples**:
```yaml
kind: Secret
data:
  ADMIN_PASSWORD: ""  # <- placeholder
  RABBIT_DEFAULT_USER: "guest"  # <- NOT a placeholder (non-empty)
```

### Manifest Shape Validation

Before apply, validate the filled YAML structure:

**ManifestShape.validationError(yaml: String) -> String?**:
1. Split on `---` document separator
2. For each non-empty document:
   - Check for top-level `apiVersion:` line
   - Check for top-level `kind:` line
3. Return nil if all docs are valid; otherwise human-readable error ("document 2 is missing top-level apiVersion")

---

## Catalog Loader (packages/catalog)

### package.json Structure

```
packages/catalog/
├── package.json
├── src/
│   ├── index.ts
│   ├── loader.ts          # loadCatalog(): Promise<CatalogApp[]>
│   ├── substitute.ts       # substitute(text, vars): string
│   ├── detection.ts        # installedAppIDs(apps, deployments, …): Set<string>
│   ├── placeholder.ts      # PlaceholderScanner, validate manifest
│   └── types.ts            # CatalogApp, AppCategory, AppRequirements, InstallDescriptor, SecretFieldSpec
└── catalog.json            # (copied from Sources/Helmsman/Resources/)
```

### Types

```typescript
enum AppCategory {
  database = "database",
  observability = "observability",
  productivity = "productivity",
  devTools = "dev-tools",
  media = "media",
  network = "network",
  other = "other"
}

interface AppRequirements {
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  storageGiB?: number;
}

interface SecretFieldSpec {
  key: string;
  label: string;
  description?: string;
  kind: "random" | "user";
  length?: number;
  format?: "alphanumeric" | "hex" | "url-safe";
  required?: boolean;
}

enum InstallMode {
  manifest = "manifest",
  helm = "helm"
}

interface InstallDescriptor {
  mode: InstallMode;
  manifest?: string;           // manifest mode only
  repoName?: string;           // helm mode only
  repoURL?: string;            // helm mode only
  chart?: string;              // helm mode only
  version?: string;            // helm mode only
  values?: string;             // helm mode only
  releaseName?: string;        // helm mode only
  secrets?: SecretFieldSpec[];
}

interface CatalogApp {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: AppCategory;
  iconSystemName: string;
  docsURL: string;
  repoURL?: string;
  homepageURL?: string;
  tags: string[];
  matchImages: string[];
  requirements: AppRequirements;
  persistence: boolean;
  exposesIngress: boolean;
  notes?: string;
  installPromptTemplate: string;
  install?: InstallDescriptor;
}
```

### Loader

```typescript
async function loadCatalog(): Promise<CatalogApp[]> {
  // Read catalog.json from the package, parse JSON, return typed array
  // Throws on parse errors; caller handles gracefully
}
```

### Substitution

```typescript
function substitute(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
  }
  return result;
}
```

Unknown variables remain as `{{unknown}}`.

### Installation Detection

```typescript
function installedAppIDs(
  apps: CatalogApp[],
  deployments: Deployment[],
  statefulSets: StatefulSet[],
  pods: Pod[]
): Set<string> {
  // Pure function; recompute freely on every render
  // Returns set of app.id for which any matchImage matches any running container
}

function imageRepoPath(image: string): string {
  // Normalize: drop registry host (if it contains . or : or is localhost) 
  //           and drop library/ prefix
  // Example: "docker.io/library/nextcloud:29" -> "nextcloud"
}

function repoPathsMatch(running: string, candidate: string): boolean {
  // Canonicalize both, compare
}
```

### Placeholder Scanning

```typescript
interface ManifestPlaceholder {
  key: string;  // Name of the placeholder
}

function scanPlaceholders(yaml: string): ManifestPlaceholder[] {
  // Find all <FILL_ME_IN> markers and empty Secret values
  // Return deduplicated list
}

function substitutePlaceholders(
  yaml: string,
  values: Record<string, string>
): string {
  // Replace markers and empty values with provided values
  // Leave unfilled markers as literal <FILL_ME_IN>
}

function hasUnfilledMarkers(yaml: string): boolean {
  // True if <FILL_ME_IN> substring present
}

function validateManifestShape(yaml: string): string | null {
  // Return null if valid; otherwise human-readable error
}
```

### Testing (vitest)

```typescript
// TDD: test substitution, detection, placeholder scanning
describe("substitute", () => {
  it("replaces {{instance}} with value", () => {
    expect(substitute("{{instance}}-secret", { instance: "foo" })).toBe("foo-secret");
  });
  it("leaves unknown variables as literal", () => {
    expect(substitute("{{instance}}-{{unknown}}", { instance: "foo" })).toBe("foo-{{unknown}}");
  });
});

describe("installedAppIDs", () => {
  it("matches apps by normalizing repo paths", () => {
    // Test with docker.io/library/nextcloud matching standalone nextcloud
  });
});

describe("scanPlaceholders", () => {
  it("finds <FILL_ME_IN> markers", () => {
    // Test YAML with markers
  });
  it("finds empty Secret values", () => {
    // Test YAML with empty data block
  });
});

describe("validateManifestShape", () => {
  it("returns null for valid manifests", () => {
    // Valid: apiVersion + kind at top level
  });
  it("rejects missing apiVersion", () => {
    // Returns error message
  });
});
```

---

## Server Routes (apps/server)

### POST /api/apply

**Request**:
```json
{
  "yaml": "<multi-doc YAML>"
}
```

**Execution**:
```bash
kubectl --context [from config or request] apply -f - <<< "$yaml"
```

**Response**:
```json
{
  "code": 0,
  "stdout": "<command output>",
  "stderr": ""
}
```

**Edge cases**:
- Unfound kubectl: `code: -1, stderr: "kubectl not found"`
- Exit code 1: `code: 1, stderr: "<error from kubectl>"`
- Both stdout and stderr may be present

### POST /api/helm

**Request**:
```json
{
  "repoName": "sentry",
  "repoURL": "https://...",
  "chart": "sentry",
  "version": "31.7.1",
  "releaseName": "my-sentry",
  "namespace": "apps",
  "values": "<YAML values>"
}
```

**Execution** (ordered, idempotent):
1. `helm repo add [repoName] [repoURL]`
2. `helm repo update [repoName]`
3. `helm upgrade --install [releaseName] [repoName]/[chart] --version [version] -n [namespace] --create-namespace -f [values-file]`

All with `--kube-context [ctx]` prepended.

**Response**:
```json
{
  "code": 0,
  "stdout": "<helm output>",
  "stderr": ""
}
```

**Hard constraints**:
- YAML piped via stdin, never interpolated into shell
- Helm commands built from typed struct, never free-form
- All existing server tests stay green

---

## Web Panel (apps/web)

### File Structure

```
apps/web/src/panels/catalog/
├── CatalogPanel.tsx           # Main panel, grid, filtering
├── CatalogDetailSheet.tsx     # Modal showing app details + Install button
├── CatalogInstallWizard.tsx   # Multi-step wizard (Configure, Generating, Secrets, Review, Applying, Verifying, Done, Failed)
├── steps/
│   ├── ConfigureStep.tsx
│   ├── GeneratingStep.tsx      # Chat-like transcript (not-yet-baked only)
│   ├── SecretsStep.tsx         # Form for secret values
│   ├── ReviewStep.tsx          # Manifest preview + resource summary
│   ├── ApplyingStep.tsx        # Streaming log
│   ├── VerifyingStep.tsx       # Pod readiness checklist
│   ├── DoneStep.tsx
│   └── FailedStep.tsx
├── hooks/
│   ├── useCatalog.ts           # Load catalog, search/filter
│   ├── useInstallWizard.ts     # Wizard state machine
│   └── useInstallDetection.ts  # Track installed apps from cache
├── utils/
│   ├── manifestUtils.ts        # PlaceholderScanner, validation
│   ├── helmUtils.ts            # helm template preview
│   └── imageMatch.ts           # Installation detection
└── types.ts                    # TypeScript interfaces (re-export from @helmsman/catalog)
```

### CatalogPanel.tsx

```typescript
interface CatalogPanelProps {
  // From store/cache
  cache: ClusterCache;
  context: string | null;
}

export function CatalogPanel({ cache, context }: CatalogPanelProps) {
  // State
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<AppCategory | null>(null);
  const [scope, setScope] = useState<"all" | "installed">("all");
  const [selectedApp, setSelectedApp] = useState<CatalogApp | null>(null);
  const [wizardApp, setWizardApp] = useState<CatalogApp | null>(null);
  
  // Catalog loading
  const { catalog, loadError } = useCatalog();
  
  // Installation detection (recompute on cache change)
  const installedIDs = useInstallDetection(catalog, cache);
  
  // Filtering
  const filtered = catalog.filter(app => {
    if (scope === "installed" && !installedIDs.has(app.id)) return false;
    if (selectedCategory && app.category !== selectedCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        app.name.toLowerCase().includes(q) ||
        app.tagline.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q) ||
        app.tags.some(tag => tag.toLowerCase().includes(q))
      );
    }
    return true;
  });
  
  const availableCategories = useMemo(() => {
    const cats = new Set<AppCategory>();
    catalog.forEach(app => cats.add(app.category));
    return Array.from(cats).sort((a, b) => 
      AppCategory[a].localeCompare(AppCategory[b])
    );
  }, [catalog]);
  
  return (
    <div className="catalog-panel">
      <div className="header">
        <h1>Catalog</h1>
        <span className="count">{filtered.length}</span>
        
        <div className="scope-toggle">
          <button
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >All</button>
          <button
            className={scope === "installed" ? "active" : ""}
            onClick={() => setScope("installed")}
          >{installedIDs.size}</button>
        </div>
        
        <input
          type="text"
          placeholder="search apps, tags…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          maxLength={280}
        />
      </div>
      
      {loadError && <div className="load-error">{loadError}</div>}
      
      <div className="category-bar">
        <button
          className={selectedCategory === null ? "active" : ""}
          onClick={() => setSelectedCategory(null)}
        >all</button>
        {availableCategories.map(cat => (
          <button
            key={cat}
            className={selectedCategory === cat ? "active" : ""}
            onClick={() => setSelectedCategory(
              selectedCategory === cat ? null : cat
            )}
          >{AppCategory[cat]}</button>
        ))}
      </div>
      
      <div className="grid">
        {filtered.map(app => (
          <CatalogCard
            key={app.id}
            app={app}
            isInstalled={installedIDs.has(app.id)}
            onSelect={() => setSelectedApp(app)}
            onInstall={() => setWizardApp(app)}
          />
        ))}
      </div>
      
      {selectedApp && (
        <CatalogDetailSheet
          app={selectedApp}
          isInstalled={installedIDs.has(selectedApp.id)}
          onClose={() => setSelectedApp(null)}
          onInstall={() => {
            setWizardApp(selectedApp);
            setSelectedApp(null);
          }}
        />
      )}
      
      {wizardApp && (
        <CatalogInstallWizard
          app={wizardApp}
          cache={cache}
          context={context}
          onClose={() => setWizardApp(null)}
        />
      )}
    </div>
  );
}
```

### CatalogInstallWizard.tsx

State machine driven by `WizardStep` enum. Each step is a sub-component or ViewBuilder pattern.

```typescript
export function CatalogInstallWizard({
  app,
  cache,
  context,
  onClose,
}: {
  app: CatalogApp;
  cache: ClusterCache;
  context: string | null;
  onClose: () => void;
}) {
  // Full wizard state
  const [step, setStep] = useState<WizardStep>("configure");
  const [instance, setInstance] = useState(app.id);
  const [namespace, setNamespace] = useState("default");
  const [hostname, setHostname] = useState("");
  const [nodePin, setNodePin] = useState<string | null>(null);
  const [storageGiB, setStorageGiB] = useState(app.requirements.storageGiB ?? 0);
  const [notes, setNotes] = useState("");
  const [clusterIssuer, setClusterIssuer] = useState("");
  
  const [manifestYAML, setManifestYAML] = useState("");
  const [secretSpecs, setSecretSpecs] = useState<SecretFieldSpec[]>([]);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [applyLog, setApplyLog] = useState("");
  
  const canAdvanceFromConfigure =
    instance.trim() &&
    namespace.trim() &&
    (!app.exposesIngress || hostname.trim()) &&
    (!app.persistence || storageGiB > 0);
  
  const handleAdvanceFromConfigure = async () => {
    if (!canAdvanceFromConfigure) return;
    
    const vars: Record<string, string> = {
      instance,
      namespace,
      hostname,
      nodeName: nodePin ?? "",
      storage: String(storageGiB),
      clusterIssuer,
      notes,
    };
    
    if (app.install?.manifest) {
      // Baked manifest mode
      const filled = substitute(app.install.manifest, vars);
      setManifestYAML(filled);
      const placeholders = scanPlaceholders(filled);
      if (placeholders.length > 0) {
        setSecretSpecs(app.install.secrets ?? []);
        setStep("secrets");
      } else {
        setStep("review");
      }
    } else {
      // Not-yet-baked: start Claude session
      setStep("generating");
      // Call claude session + parse response
    }
  };
  
  const handleApply = async () => {
    setStep("applying");
    
    try {
      let result;
      if (app.install?.mode === "helm") {
        // POST /api/helm
        result = await fetch("/api/helm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoName: app.install.repoName,
            repoURL: app.install.repoURL,
            chart: app.install.chart,
            version: app.install.version,
            releaseName: instance,
            namespace,
            values: manifestYAML,
          }),
        }).then(r => r.json());
      } else {
        // POST /api/apply
        result = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yaml: manifestYAML }),
        }).then(r => r.json());
      }
      
      setApplyLog(result.stdout);
      
      if (result.code === 0) {
        setStep("verifying");
        startVerifyPoll();
      } else {
        setStep("failed");
      }
    } catch (error) {
      setStep("failed");
      setApplyLog(`Error: ${error}`);
    }
  };
  
  const startVerifyPoll = () => {
    // Poll cache.pods for pods matching namespace + app.kubernetes.io/instance = instance
    // Advance to "done" when all pods Ready
  };
  
  return (
    <Modal onClose={onClose}>
      <div className="wizard-header">
        <h2>Install {app.name}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      
      <div className="wizard-body">
        {step === "configure" && (
          <ConfigureStep
            app={app}
            instance={instance}
            setInstance={setInstance}
            namespace={namespace}
            setNamespace={setNamespace}
            hostname={hostname}
            setHostname={setHostname}
            storageGiB={storageGiB}
            setStorageGiB={setStorageGiB}
            nodePin={nodePin}
            setNodePin={setNodePin}
            canAdvance={canAdvanceFromConfigure}
            onContinue={handleAdvanceFromConfigure}
          />
        )}
        {step === "secrets" && (
          <SecretsStep
            secretSpecs={secretSpecs}
            secretValues={secretValues}
            setSecretValues={setSecretValues}
            manifestYAML={manifestYAML}
            setManifestYAML={setManifestYAML}
            onContinue={() => setStep("review")}
          />
        )}
        {step === "review" && (
          <ReviewStep
            manifestYAML={manifestYAML}
            app={app}
            instance={instance}
            namespace={namespace}
            hostname={hostname}
            onInstall={handleApply}
          />
        )}
        {step === "applying" && (
          <ApplyingStep applyLog={applyLog} />
        )}
        {step === "verifying" && (
          <VerifyingStep
            instance={instance}
            namespace={namespace}
            cache={cache}
            onDone={() => setStep("done")}
            onFailed={msg => setStep("failed")}
          />
        )}
        {step === "done" && (
          <DoneStep onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}
```

### ConfigureStep.tsx

Controlled form inputs for instance, namespace, hostname, storage, node pin, cluster issuer.

### SecretsStep.tsx

Form for each placeholder/secret value. User-filled fields required to advance. Auto-generated fields pre-filled; copy button.

### ReviewStep.tsx

- **Manifest preview**: Scrollable mono-font YAML
- **Resource summary**: Parsed counts of Deployments, Services, ConfigMaps, Secrets, PVCs, etc.
- **Install summary**: instance, namespace, hostname, storage
- **Install button**: Calls `handleApply`

### ApplyingStep.tsx

Streaming log display (mono font, scrollable).

### VerifyingStep.tsx

- Checklist of expected resources
- Poll `cache.pods` every 1.5s for pods matching `namespace` + `app.kubernetes.io/instance` = `instance`
- Show readiness state (creating, starting [X/Y], ready, failed)
- Advance to done when all pods Ready
- On soft timeout (5 min): show "taking a while" button to hand off to chat
- On hard timeout (10 min): auto hand off or close

### DoneStep.tsx

Success message, close button.

### Icon Mapping

`iconSystemName` (SF Symbol name) → Lucide icon or fallback:
- `lock.circle.fill` → `Lock` (lucide-react)
- `database.fill` → `Database`
- `megaphone.fill` → `Megaphone`
- `chart.bar.fill` → `BarChart3`
- Unknown → generic fallback (e.g., `Package`)

### Styling

- Use existing shadcn + Tailwind patterns from the app
- Cards: responsive grid (adaptive 260–360px, 12px spacing)
- Search/filters: integrated header bar
- Modal: 960x680px (approx; responsive on smaller screens)
- Manifest preview: mono font (e.g., `font-mono`), line numbers optional

### Hooks

```typescript
function useCatalog() {
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  useEffect(() => {
    loadCatalog()
      .then(setCatalog)
      .catch(err => setLoadError(err.message));
  }, []);
  
  return { catalog, loadError };
}

function useInstallDetection(catalog: CatalogApp[], cache: ClusterCache) {
  // Recompute installedAppIDs on every cache or catalog change
  // Returns Set<string> of installed app IDs
}
```

### React Query Mutations

```typescript
const applyMutation = useMutation({
  mutationFn: async (yaml: string) =>
    fetch("/api/apply", {
      method: "POST",
      body: JSON.stringify({ yaml }),
      headers: { "Content-Type": "application/json" },
    }).then(r => r.json()),
});

const helmMutation = useMutation({
  mutationFn: async (params: HelmInstallParams) =>
    fetch("/api/helm", {
      method: "POST",
      body: JSON.stringify(params),
      headers: { "Content-Type": "application/json" },
    }).then(r => r.json()),
});
```

---

## Testing Acceptance Criteria

All the following must pass:

### 1. Catalog Loader (packages/catalog)

```bash
pnpm --filter @helmsman/catalog test
```

- ✓ Loads catalog.json and parses 54 apps with correct types
- ✓ `substitute()` replaces {{var}} placeholders; leaves unknown variables literal
- ✓ `installedAppIDs()` matches apps by normalized image repo paths
- ✓ `scanPlaceholders()` finds <FILL_ME_IN> markers and empty Secret values
- ✓ `validateManifestShape()` rejects missing apiVersion/kind; accepts valid YAML

### 2. Server (apps/server)

```bash
pnpm --filter @helmsman/server test
```

- ✓ All existing tests stay green
- ✓ POST /api/apply feeds YAML via stdin to `kubectl apply -f -`; returns {code, stdout, stderr}
- ✓ POST /api/helm runs `helm upgrade --install` with repo add/update; returns {code, stdout, stderr}
- ✓ Unfound binaries return code -1 with descriptive error
- ✓ Exit codes propagated correctly

### 3. Web (apps/web)

```bash
pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test
```

- ✓ TypeScript compilation succeeds
- ✓ Build succeeds
- ✓ All existing tests stay green
- ✓ CatalogPanel renders grid from catalog.json
- ✓ Search filters by name, tagline, description, tags (case-insensitive)
- ✓ Category filter works; toggle on/off
- ✓ Scope toggle (All / Installed) works
- ✓ Installed badge detection works (installedAppIDs matched against cache.deployments, cache.statefulSets, cache.pods)
- ✓ Detail sheet shows app description, links, notes, Install button
- ✓ Install wizard: Configure step gates on required fields, substitutes variables, saves to state
- ✓ Install wizard: Secrets step (for placeholders) forms allow user input, validate required fields
- ✓ Install wizard: Review step shows final manifest preview (substituted) and parsed resources
- ✓ Install wizard: Applying step POSTs to /api/apply (manifest) or /api/helm (helm) with correct payloads
- ✓ Install wizard: Verifying step polls cache for pods and transitions to done when all Ready
- ✓ Icon mapping: iconSystemName → lucide icon (or fallback)

### 4. Parity

- ✓ Catalog entry schema (54 apps, all fields) loaded and displayed identically to Swift
- ✓ Grid layout, search, category filter, installed detection identical to Swift
- ✓ Install wizard flow (Configure → Generating/Secrets → Review → Applying → Verifying → Done) matches Swift
- ✓ Manifest substitution and placeholder scanning identical to Swift logic
- ✓ Kubernetes commands (kubectl apply -f -, helm upgrade --install) match Swift invocations exactly
- ✓ No new npm dependencies beyond shadcn + (optional react-hook-form)

---

## Migration Notes

### Dropped Features (Out of Scope)

- **Update checks**: Update checking (cloud API polling, latest version detection) is Helmsman-specific macOS feature. Web port tracks installed image tags but doesn't check for newer versions.
- **Chat assistant**: Helmsman allows Claude-generated installs (not-yet-baked apps). Web port initially supports baked apps (deterministic YAML + secrets). Claude-generated path deferred (requires MCP hook).
- **Node fit calculation**: Helmsman shows "fits / tight / no fit" indicators based on cluster capacity. Web port deferred.

### Wired-In Simplifications

1. **Icons**: SF Symbols → Lucide icons (best-effort mapping; generic fallback)
2. **Helm template preview**: Uses native helm binary; no alternative (no go-helmfile library)
3. **ClusterIssuer discovery**: Reads from cluster via read-only kubectl; no fallback list
4. **Registry account management**: Assumes SessionStore integration; no direct UI for new accounts

---

## Glossary

- **Baked app**: Catalog entry with `install.manifest` or `install.values` pre-filled (deterministic YAML/values). Install wizard substitutes variables, collects secrets, applies directly. No Claude required.
- **Not-yet-baked app**: Catalog entry with no `install.manifest` / `install.values`. Install wizard sends `installPromptTemplate` to Claude, parses response for YAML + optional secrets schema, then proceeds as above.
- **matchImages**: Container image refs (registry/repo:tag) used to detect if an app is already installed by matching against running pods/deployments. Matching is host- and tag-insensitive.
- **Placeholders**: User-fillable gaps in generated manifests: `<FILL_ME_IN>` markers and empty Secret values.
- **Secrets**: In the install context, `SecretFieldSpec` objects that model form fields for sensitive values (random-generated or user-supplied).
- **Ingress hostname**: Fully qualified domain name for the app's HTTP(S) endpoint, used in Ingress and cert-manager TLS configuration.
- **Node pin**: Optional node affinity constraint (pod.spec.nodeName); used in Deployments to pin workloads to specific nodes.
- **Verify poll**: Continuous check during Verifying step to track pod readiness; transitions to Done when all matched pods report Ready.
