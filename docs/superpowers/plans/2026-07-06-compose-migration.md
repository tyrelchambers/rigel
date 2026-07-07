# Docker Compose to Kubernetes Migration Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert a pasted/uploaded `docker-compose.yml` into reviewable, apply-ready Kubernetes manifests, fully deterministically (no AI), surfaced in a new Tools panel plus a first-run onboarding entry.

**Architecture:** A pure-function engine in a new `packages/compose` package parses compose with the `yaml` package, builds a JS object per Kubernetes resource, and serializes to YAML, returning `{ manifests, warnings, catalogHints }`. A new `ComposeMigratePanel` in `apps/web` feeds compose text to the engine and hands the combined manifest to the existing guarded apply path (`applyManifest` → `/api/apply` → ConfirmSheet). Catalog hints reuse `repoPathsMatch`/`matchImages` from `packages/catalog`.

**Tech Stack:** TypeScript, vitest ^4.1.8, the `yaml` package (eemeli/yaml, monorepo's first YAML-lib dep), React 19 + Vite, `@rigel/catalog`.

**Spec:** `docs/superpowers/specs/2026-07-06-compose-migration-design.md`

**Open decisions carried in from brainstorming (confirm before or during execution):**
1. YAML library: this plan uses the `yaml` package. (Chosen autonomously; user was away when asked. Swap to js-yaml or hand-rolled only if the user prefers.)
2. Panel visual design: DONE. Designed in Pencil as frame `mPsEp` ("Migrate from Compose — main") in `clankerlocal.pen`, midnight palette, using the shared Button component and surface/border/accent tokens. Task 11 reproduces that frame screen-for-screen with Tailwind utilities/tokens (no inline hex).

---

## File Structure

New package `packages/compose/`:
- `package.json` — `@rigel/compose`, depends on `yaml` and `@rigel/catalog`.
- `tsconfig.json` — mirrors `packages/catalog`.
- `src/types.ts` — `ComposeModel`, `ComposeService`, `ConversionResult`, `ManifestDoc`, `Warning`, `CatalogHint`, `ConvertOptions`.
- `src/names.ts` — `sanitizeName`.
- `src/env.ts` — `isSecretEnvKey`.
- `src/parse.ts` — `parseCompose`.
- `src/resources.ts` — `buildDeployment`, `buildPvc`, `buildService`.
- `src/hints.ts` — `catalogHints`.
- `src/convert.ts` — `convert` (orchestrator) + `combineManifests`.
- `src/index.ts` — public exports.
- `src/*.test.ts` — one test file per module.

Modified in `apps/web`:
- `src/panels/compose/ComposeMigratePanel.tsx` (create).
- `src/shell/NavStrip.tsx` (add `PANEL_META` entry + `NAV_GROUPS` "Tools" membership).
- `src/App.tsx` (add `/compose` route).
- The onboarding/empty-state component (locate in Task 16) gets a "Migrate from Compose" card.

---

## Task 1: Scaffold `packages/compose`

**Files:**
- Create: `packages/compose/package.json`
- Create: `packages/compose/tsconfig.json`
- Create: `packages/compose/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@rigel/compose",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "^4.1.8"
  },
  "dependencies": {
    "yaml": "latest",
    "@rigel/catalog": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (copy `packages/catalog/tsconfig.json` verbatim; if that file does not exist, use this)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create a placeholder `src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes; `@rigel/compose` and `yaml` appear installed.

- [ ] **Step 5: Commit**

```bash
git add packages/compose
git commit -m "chore(compose): scaffold @rigel/compose package"
```

---

## Task 2: Types

**Files:**
- Create: `packages/compose/src/types.ts`

- [ ] **Step 1: Write the types** (no test; consumed by later tasks)

```ts
export interface ComposePort {
  containerPort: number;
  /** Host-side port from `"HOST:CONTAINER"`; undefined when only a container port is given. */
  publishedPort?: number;
}

export interface ComposeVolume {
  /** Sanitized volume name (named volumes only). */
  name: string;
  mountPath: string;
  kind: "named" | "bind";
  /** Raw source token (named volume name or host path). */
  source: string;
}

export interface ComposeService {
  /** Raw service key from compose. */
  name: string;
  image?: string;
  ports: ComposePort[];
  environment: Record<string, string>;
  volumes: ComposeVolume[];
  command?: string[];
  replicas: number;
  /** Directive names present on this service that are not translated (e.g. "privileged"). */
  unsupported: string[];
}

export interface ComposeModel {
  services: ComposeService[];
  /** Top-level keys recognized but intentionally ignored (e.g. "networks"). */
  ignoredTopLevel: string[];
}

export type Severity = "info" | "warning";

export interface Warning {
  severity: Severity;
  service?: string;
  directive?: string;
  message: string;
}

export interface CatalogHint {
  service: string;
  appId: string;
  appName: string;
}

export interface ManifestDoc {
  kind: string;
  name: string;
  yaml: string;
}

export interface ConversionResult {
  manifests: ManifestDoc[];
  warnings: Warning[];
  catalogHints: CatalogHint[];
}

export interface ConvertOptions {
  /** Target namespace stamped onto every namespaced resource. */
  namespace: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/compose/src/types.ts
git commit -m "feat(compose): resource and result types"
```

---

## Task 3: Name sanitization

**Files:**
- Create: `packages/compose/src/names.ts`
- Create: `packages/compose/src/names.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { sanitizeName } from "./names";

describe("sanitizeName", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(sanitizeName("My_App")).toBe("my-app");
    expect(sanitizeName("web")).toBe("web");
  });
  it("trims and collapses leading/trailing/repeated dashes", () => {
    expect(sanitizeName("_svc_")).toBe("svc");
    expect(sanitizeName("a__b")).toBe("a-b");
  });
  it("falls back to 'app' for empty results", () => {
    expect(sanitizeName("___")).toBe("app");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./names`.

- [ ] **Step 3: Implement**

```ts
/** RFC 1123-ish name: lowercase, alphanumeric + single dashes, no leading/trailing dash. */
export function sanitizeName(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/names.ts packages/compose/src/names.test.ts
git commit -m "feat(compose): RFC1123 name sanitization"
```

---

## Task 4: Secret-env heuristic

**Files:**
- Create: `packages/compose/src/env.ts`
- Create: `packages/compose/src/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isSecretEnvKey } from "./env";

describe("isSecretEnvKey", () => {
  it("flags password/secret/token/apikey/_key keys, case-insensitive", () => {
    for (const k of ["POSTGRES_PASSWORD", "API_TOKEN", "MY_SECRET", "APIKEY", "TLS_KEY", "db_password"]) {
      expect(isSecretEnvKey(k)).toBe(true);
    }
  });
  it("does not flag ordinary keys", () => {
    for (const k of ["HOST", "PORT", "KEYCLOAK_URL", "LOG_LEVEL"]) {
      expect(isSecretEnvKey(k)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./env`.

- [ ] **Step 3: Implement**

```ts
/** True when an env var name looks like it carries a secret value. */
export function isSecretEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return (
    k.includes("PASSWORD") ||
    k.includes("SECRET") ||
    k.includes("TOKEN") ||
    k.includes("APIKEY") ||
    k.endsWith("_KEY")
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS. (`KEYCLOAK_URL` → false: no substring match, does not end with `_KEY`.)

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/env.ts packages/compose/src/env.test.ts
git commit -m "feat(compose): secret-env key heuristic"
```

---

## Task 5: Compose parser

**Files:**
- Create: `packages/compose/src/parse.ts`
- Create: `packages/compose/src/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseCompose } from "./parse";

const SAMPLE = `
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    environment:
      LOG_LEVEL: info
      API_TOKEN: abc
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=secret
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./local:/host
    deploy:
      replicas: 2
    privileged: true
networks:
  default: {}
`;

describe("parseCompose", () => {
  it("parses services, ports, env (map and array), volumes, replicas", () => {
    const m = parseCompose(SAMPLE);
    const web = m.services.find((s) => s.name === "web")!;
    expect(web.image).toBe("nginx:1.27");
    expect(web.ports).toEqual([{ containerPort: 80, publishedPort: 8080 }]);
    expect(web.environment).toEqual({ LOG_LEVEL: "info", API_TOKEN: "abc" });

    const db = m.services.find((s) => s.name === "db")!;
    expect(db.environment).toEqual({ POSTGRES_PASSWORD: "secret" });
    expect(db.replicas).toBe(2);
    expect(db.volumes).toContainEqual({ name: "dbdata", mountPath: "/var/lib/postgresql/data", kind: "named", source: "dbdata" });
    expect(db.volumes).toContainEqual({ name: "", mountPath: "/host", kind: "bind", source: "./local" });
    expect(db.unsupported).toContain("privileged");
  });

  it("records ignored top-level keys", () => {
    expect(parseCompose(SAMPLE).ignoredTopLevel).toContain("networks");
  });

  it("throws on invalid YAML", () => {
    expect(() => parseCompose(":\n  - [unbalanced")).toThrow();
  });

  it("returns no services for empty input", () => {
    expect(parseCompose("services: {}").services).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./parse`.

- [ ] **Step 3: Implement**

```ts
import { parse as parseYaml } from "yaml";
import { sanitizeName } from "./names";
import type { ComposeModel, ComposeService, ComposePort, ComposeVolume } from "./types";

const UNSUPPORTED_KEYS = ["privileged", "network_mode", "devices", "cap_add", "pid", "userns_mode"];
const IGNORED_TOP_LEVEL = ["configs", "secrets", "networks"];

function toEnvRecord(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(env)) {
    for (const item of env) {
      const s = String(item);
      const eq = s.indexOf("=");
      if (eq === -1) out[s] = "";
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      out[k] = v == null ? "" : String(v);
    }
  }
  return out;
}

function toPorts(ports: unknown): ComposePort[] {
  if (!Array.isArray(ports)) return [];
  const out: ComposePort[] = [];
  for (const p of ports) {
    if (typeof p === "number") {
      out.push({ containerPort: p });
      continue;
    }
    if (typeof p === "string") {
      // Strip an optional /tcp|/udp protocol suffix, then split HOST:CONTAINER.
      const bare = p.split("/")[0]!;
      const parts = bare.split(":");
      const container = Number(parts[parts.length - 1]);
      if (!Number.isFinite(container)) continue;
      const host = parts.length > 1 ? Number(parts[parts.length - 2]) : NaN;
      out.push(Number.isFinite(host) ? { containerPort: container, publishedPort: host } : { containerPort: container });
      continue;
    }
    if (p && typeof p === "object") {
      const obj = p as { target?: number; published?: number | string };
      if (typeof obj.target === "number") {
        const host = obj.published != null ? Number(obj.published) : NaN;
        out.push(Number.isFinite(host) ? { containerPort: obj.target, publishedPort: host } : { containerPort: obj.target });
      }
    }
  }
  return out;
}

function isBindSource(src: string): boolean {
  return src.startsWith(".") || src.startsWith("/") || src.startsWith("~");
}

function toVolumes(volumes: unknown): ComposeVolume[] {
  if (!Array.isArray(volumes)) return [];
  const out: ComposeVolume[] = [];
  for (const v of volumes) {
    if (typeof v === "string") {
      const parts = v.split(":");
      if (parts.length < 2) continue;
      const source = parts[0]!;
      const mountPath = parts[1]!;
      if (isBindSource(source)) {
        out.push({ name: "", mountPath, kind: "bind", source });
      } else {
        out.push({ name: sanitizeName(source), mountPath, kind: "named", source });
      }
      continue;
    }
    if (v && typeof v === "object") {
      const obj = v as { type?: string; source?: string; target?: string };
      if (!obj.target) continue;
      if (obj.type === "bind" || (obj.source && isBindSource(obj.source))) {
        out.push({ name: "", mountPath: obj.target, kind: "bind", source: obj.source ?? "" });
      } else if (obj.source) {
        out.push({ name: sanitizeName(obj.source), mountPath: obj.target, kind: "named", source: obj.source });
      }
    }
  }
  return out;
}

function toCommand(cmd: unknown): string[] | undefined {
  if (typeof cmd === "string") return cmd.length ? cmd.split(/\s+/) : undefined;
  if (Array.isArray(cmd)) return cmd.map(String);
  return undefined;
}

export function parseCompose(text: string): ComposeModel {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  const root = doc && typeof doc === "object" ? doc : {};

  const servicesRaw = (root.services as Record<string, unknown> | undefined) ?? {};
  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries(servicesRaw)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    const deploy = (svc.deploy as { replicas?: number } | undefined) ?? {};
    services.push({
      name,
      image: typeof svc.image === "string" ? svc.image : undefined,
      ports: toPorts(svc.ports),
      environment: toEnvRecord(svc.environment),
      volumes: toVolumes(svc.volumes),
      command: toCommand(svc.command),
      replicas: typeof deploy.replicas === "number" ? deploy.replicas : 1,
      unsupported: UNSUPPORTED_KEYS.filter((k) => k in svc),
    });
  }

  const ignoredTopLevel = IGNORED_TOP_LEVEL.filter((k) => k in root);
  return { services, ignoredTopLevel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS. (`yaml.parse` throws on the malformed input, satisfying the throw test.)

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/parse.ts packages/compose/src/parse.test.ts
git commit -m "feat(compose): compose-file parser to typed model"
```

---

## Task 6: Resource builders (Deployment, PVC, Service)

**Files:**
- Create: `packages/compose/src/resources.ts`
- Create: `packages/compose/src/resources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildDeployment, buildPvc, buildService } from "./resources";
import type { ComposeService } from "./types";

function svc(over: Partial<ComposeService>): ComposeService {
  return { name: "web", image: "nginx:1.27", ports: [], environment: {}, volumes: [], replicas: 1, unsupported: [], ...over };
}

describe("buildDeployment", () => {
  it("builds a Deployment with sanitized name, namespace, image, replicas, env", () => {
    const d = buildDeployment(svc({ name: "My_Web", environment: { LOG_LEVEL: "info" }, replicas: 3 }), "apps");
    expect(d.kind).toBe("Deployment");
    expect(d.metadata.name).toBe("my-web");
    expect(d.metadata.namespace).toBe("apps");
    expect(d.spec.replicas).toBe(3);
    const c = d.spec.template.spec.containers[0];
    expect(c.image).toBe("nginx:1.27");
    expect(c.env).toContainEqual({ name: "LOG_LEVEL", value: "info" });
  });

  it("routes secret env through secretKeyRef and mounts named volumes", () => {
    const d = buildDeployment(
      svc({ environment: { POSTGRES_PASSWORD: "x" }, volumes: [{ name: "data", mountPath: "/data", kind: "named", source: "data" }] }),
      "apps",
    );
    const c = d.spec.template.spec.containers[0];
    expect(c.env).toContainEqual({ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "web", key: "POSTGRES_PASSWORD" } } });
    expect(c.volumeMounts).toContainEqual({ name: "data", mountPath: "/data" });
    expect(d.spec.template.spec.volumes).toContainEqual({ name: "data", persistentVolumeClaim: { claimName: "web-data" } });
  });

  it("uses command as args", () => {
    const d = buildDeployment(svc({ command: ["nginx", "-g", "daemon off;"] }), "apps");
    expect(d.spec.template.spec.containers[0].args).toEqual(["nginx", "-g", "daemon off;"]);
  });
});

describe("buildPvc", () => {
  it("builds an RWO PVC named <service>-<volume>", () => {
    const p = buildPvc({ name: "data", mountPath: "/data", kind: "named", source: "data" }, svc({}), "apps");
    expect(p.kind).toBe("PersistentVolumeClaim");
    expect(p.metadata.name).toBe("web-data");
    expect(p.metadata.namespace).toBe("apps");
    expect(p.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });
});

describe("buildService", () => {
  it("builds a ClusterIP Service for exposed ports", () => {
    const s = buildService(svc({ ports: [{ containerPort: 80, publishedPort: 8080 }] }), "apps");
    expect(s!.kind).toBe("Service");
    expect(s!.spec.type).toBe("ClusterIP");
    expect(s!.spec.ports).toContainEqual({ name: "p80", port: 80, targetPort: 80 });
  });
  it("returns null when the service has no ports", () => {
    expect(buildService(svc({ ports: [] }), "apps")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./resources`.

- [ ] **Step 3: Implement**

```ts
import { sanitizeName } from "./names";
import { isSecretEnvKey } from "./env";
import type { ComposeService, ComposeVolume } from "./types";

/** Loose typing: these objects are serialized straight to YAML, so exact k8s types add no value. */
type Obj = Record<string, any>;

function pvcName(service: ComposeService, vol: ComposeVolume): string {
  return `${sanitizeName(service.name)}-${sanitizeName(vol.name || vol.mountPath)}`;
}

function envEntries(service: ComposeService): Obj[] {
  const secretName = sanitizeName(service.name);
  return Object.entries(service.environment).map(([name, value]) =>
    isSecretEnvKey(name)
      ? { name, valueFrom: { secretKeyRef: { name: secretName, key: name } } }
      : { name, value },
  );
}

export function buildDeployment(service: ComposeService, namespace: string): Obj {
  const name = sanitizeName(service.name);
  const named = service.volumes.filter((v) => v.kind === "named");
  const container: Obj = {
    name,
    image: service.image ?? "",
    ...(service.command ? { args: service.command } : {}),
    ...(Object.keys(service.environment).length ? { env: envEntries(service) } : {}),
    ...(service.ports.length ? { ports: service.ports.map((p) => ({ containerPort: p.containerPort })) } : {}),
    ...(named.length ? { volumeMounts: named.map((v) => ({ name: v.name, mountPath: v.mountPath })) } : {}),
  };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      replicas: service.replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [container],
          ...(named.length
            ? { volumes: named.map((v) => ({ name: v.name, persistentVolumeClaim: { claimName: pvcName(service, v) } })) }
            : {}),
        },
      },
    },
  };
}

export function buildPvc(vol: ComposeVolume, service: ComposeService, namespace: string): Obj {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: pvcName(service, vol), namespace },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
  };
}

export function buildService(service: ComposeService, namespace: string): Obj | null {
  if (!service.ports.length) return null;
  const name = sanitizeName(service.name);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      type: "ClusterIP",
      selector: { app: name },
      ports: service.ports.map((p) => ({ name: `p${p.containerPort}`, port: p.containerPort, targetPort: p.containerPort })),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/resources.ts packages/compose/src/resources.test.ts
git commit -m "feat(compose): Deployment/PVC/Service builders"
```

---

## Task 7: Catalog hints

**Files:**
- Create: `packages/compose/src/hints.ts`
- Create: `packages/compose/src/hints.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { catalogHints } from "./hints";
import type { ComposeService } from "./types";

function svc(name: string, image: string): ComposeService {
  return { name, image, ports: [], environment: {}, volumes: [], replicas: 1, unsupported: [] };
}

describe("catalogHints", () => {
  it("matches a known image to a catalog app (host/tag-insensitive)", () => {
    const hints = catalogHints([svc("db", "postgres:16")]);
    expect(hints.some((h) => h.service === "db")).toBe(true);
  });
  it("produces no hint for an unknown image", () => {
    expect(catalogHints([svc("web", "example.com/nobody/unknown-thing:1")])).toEqual([]);
  });
  it("ignores services without an image", () => {
    expect(catalogHints([{ ...svc("x", ""), image: undefined }])).toEqual([]);
  });
});
```

Note: the first assertion depends on the catalog actually containing a Postgres entry whose `matchImages` includes `postgres`. Confirm with `grep -i '"postgres"' packages/catalog/catalog.json`; if the catalog uses a different canonical image, adjust the test image to a confirmed entry (e.g. `redis`, `nextcloud`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./hints`.

- [ ] **Step 3: Implement**

```ts
import { CATALOG, imageRepoPath, repoPathsMatch } from "@rigel/catalog";
import type { ComposeService, CatalogHint } from "./types";

/** For each service whose image matches a catalog app, a hint (deduped per service). */
export function catalogHints(services: ComposeService[]): CatalogHint[] {
  const out: CatalogHint[] = [];
  for (const service of services) {
    if (!service.image) continue;
    const running = imageRepoPath(service.image);
    const app = CATALOG.find((a) => a.matchImages.some((raw) => repoPathsMatch(running, imageRepoPath(raw))));
    if (app) out.push({ service: service.name, appId: app.id, appName: app.name });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/hints.ts packages/compose/src/hints.test.ts
git commit -m "feat(compose): catalog-app hints from service images"
```

---

## Task 8: Orchestrator (`convert`) + warnings + serialization

**Files:**
- Create: `packages/compose/src/convert.ts`
- Create: `packages/compose/src/convert.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { convert, combineManifests } from "./convert";

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      API_TOKEN: abc
    depends_on: [db]
  db:
    image: postgres:16
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./backups:/backups
    network_mode: host
networks:
  default: {}
`;

describe("convert", () => {
  const r = convert(COMPOSE, { namespace: "apps" });

  it("emits Deployments, a Service, and a PVC", () => {
    const kinds = r.manifests.map((m) => m.kind).sort();
    expect(kinds).toEqual(["Deployment", "Deployment", "PersistentVolumeClaim", "Service"]);
  });

  it("stamps the target namespace into every manifest", () => {
    for (const m of r.manifests) expect(m.yaml).toContain("namespace: apps");
  });

  it("warns about host networking, host bind mount, secret env, depends_on ordering, ignored top-level", () => {
    const msgs = r.warnings.map((w) => `${w.directive ?? ""}:${w.message}`).join("\n");
    expect(msgs).toMatch(/network_mode/);
    expect(msgs).toMatch(/backups/);
    expect(msgs).toMatch(/API_TOKEN/);
    expect(msgs).toMatch(/depends_on/);
    expect(msgs).toMatch(/networks/);
  });

  it("produces a catalog hint for postgres", () => {
    expect(r.catalogHints.some((h) => h.service === "db")).toBe(true);
  });

  it("combineManifests joins docs with separators", () => {
    expect(combineManifests(r.manifests)).toContain("\n---\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/compose test`
Expected: FAIL, cannot find `./convert`.

- [ ] **Step 3: Implement**

```ts
import { stringify as stringifyYaml } from "yaml";
import { parseCompose } from "./parse";
import { buildDeployment, buildPvc, buildService } from "./resources";
import { catalogHints } from "./hints";
import { isSecretEnvKey } from "./env";
import type { ConversionResult, ConvertOptions, ManifestDoc, Warning } from "./types";

function doc(obj: Record<string, any>): ManifestDoc {
  return { kind: obj.kind, name: obj.metadata?.name ?? "", yaml: stringifyYaml(obj) };
}

export function convert(composeText: string, opts: ConvertOptions): ConversionResult {
  const model = parseCompose(composeText);
  const manifests: ManifestDoc[] = [];
  const warnings: Warning[] = [];

  for (const key of model.ignoredTopLevel) {
    warnings.push({ severity: "info", directive: key, message: `Top-level "${key}" is not translated and was ignored.` });
  }

  for (const service of model.services) {
    if (!service.image) {
      warnings.push({ severity: "warning", service: service.name, message: `Service "${service.name}" has no image; skipped.` });
      continue;
    }

    manifests.push(doc(buildDeployment(service, opts.namespace)));

    const svcObj = buildService(service, opts.namespace);
    if (svcObj) manifests.push(doc(svcObj));

    for (const vol of service.volumes) {
      if (vol.kind === "named") {
        manifests.push(doc(buildPvc(vol, service, opts.namespace)));
      } else {
        warnings.push({
          severity: "warning",
          service: service.name,
          directive: "volumes",
          message: `Host bind mount "${vol.source}:${vol.mountPath}" is not translated. Use a PVC or configure storage manually.`,
        });
      }
    }

    for (const p of service.ports) {
      if (p.publishedPort != null) {
        warnings.push({
          severity: "info",
          service: service.name,
          directive: "ports",
          message: `Published port ${p.publishedPort}:${p.containerPort} became a ClusterIP Service. To expose it outside the cluster, add an Ingress.`,
        });
      }
    }

    for (const name of Object.keys(service.environment)) {
      if (isSecretEnvKey(name)) {
        warnings.push({
          severity: "warning",
          service: service.name,
          directive: name,
          message: `Env "${name}" looks like a secret and now references Secret "${service.name}". Create that Secret before applying.`,
        });
      }
    }

    if (service.replicas > 1 && service.volumes.some((v) => v.kind === "named")) {
      warnings.push({
        severity: "warning",
        service: service.name,
        message: `Service "${service.name}" has ${service.replicas} replicas and a volume; consider a StatefulSet instead of Deployment + RWO PVC.`,
      });
    }

    for (const directive of service.unsupported) {
      warnings.push({
        severity: "warning",
        service: service.name,
        directive,
        message: `"${directive}" is not translated to Kubernetes and was dropped.`,
      });
    }
  }

  if (/\bdepends_on\b/.test(composeText)) {
    warnings.push({
      severity: "info",
      directive: "depends_on",
      message: `depends_on ordering has no Kubernetes equivalent. Pods start in parallel; make services resilient to startup order.`,
    });
  }

  return { manifests, warnings, catalogHints: catalogHints(model.services) };
}

export function combineManifests(docs: ManifestDoc[]): string {
  return docs.map((d) => d.yaml.trimEnd()).join("\n---\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/convert.ts packages/compose/src/convert.test.ts
git commit -m "feat(compose): convert() orchestrator with warnings and serialization"
```

---

## Task 9: Public exports + golden end-to-end fixture

**Files:**
- Modify: `packages/compose/src/index.ts`
- Create: `packages/compose/src/golden.test.ts`

- [ ] **Step 1: Replace `src/index.ts`**

```ts
export { convert, combineManifests } from "./convert";
export { parseCompose } from "./parse";
export type {
  ComposeModel,
  ComposeService,
  ConversionResult,
  ConvertOptions,
  ManifestDoc,
  Warning,
  CatalogHint,
  Severity,
} from "./types";
```

- [ ] **Step 2: Write the golden test**

```ts
import { describe, it, expect } from "vitest";
import { convert, combineManifests } from "./index";

const STACK = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      APP_SECRET_KEY: change-me
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=secret
    volumes:
      - dbdata:/var/lib/postgresql/data
  cache:
    image: redis:7
`;

describe("golden: web + postgres + redis", () => {
  const r = convert(STACK, { namespace: "default" });

  it("emits 3 Deployments, 1 Service, 1 PVC", () => {
    const counts = r.manifests.reduce<Record<string, number>>((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {});
    expect(counts).toEqual({ Deployment: 3, Service: 1, PersistentVolumeClaim: 1 });
  });

  it("routes both secret-looking env values through secretKeyRef", () => {
    const combined = combineManifests(r.manifests);
    expect(combined).toContain("secretKeyRef");
    expect(r.warnings.filter((w) => w.directive === "APP_SECRET_KEY" || w.directive === "POSTGRES_PASSWORD").length).toBe(2);
  });

  it("hints postgres and redis from the catalog", () => {
    const services = r.catalogHints.map((h) => h.service).sort();
    expect(services).toContain("db");
    expect(services).toContain("cache");
  });
});
```

Note: adjust the `db`/`cache` hint assertions to whichever of postgres/redis the catalog actually ships (verify via `grep -iE '"redis"|"postgres"' packages/catalog/catalog.json`). Keep at least one confirmed hint.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @rigel/compose test`
Expected: PASS.

- [ ] **Step 4: Typecheck the package**

Run: `pnpm --filter @rigel/compose typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/compose/src/index.ts packages/compose/src/golden.test.ts
git commit -m "feat(compose): public exports and golden end-to-end fixture"
```

---

## Task 10: Web dependency wiring

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Add the dependency**

Add `"@rigel/compose": "workspace:*"` to `apps/web/package.json` `dependencies` (alongside `@rigel/catalog`).

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: completes, `@rigel/compose` linked into `apps/web`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): depend on @rigel/compose"
```

---

## Task 11: ComposeMigratePanel

> Reproduce Pencil frame `mPsEp` ("Migrate from Compose — main", `clankerlocal.pen`) screen-for-screen: header (title + subtitle, Namespace pill, outline Upload button, accent Apply button), two-pane body (compose left, generated manifests right with a resource-count pill), a warnings/hints strip (accent info hints, amber warnings), and a footer (resource tally). Use Tailwind utilities and the design tokens (surface/border/accent/foreground, Geist + Geist Mono), no inline hex. The code below is the functional skeleton; match it to the frame's spacing and colors.

**Files:**
- Create: `apps/web/src/panels/compose/ComposeMigratePanel.tsx`

- [ ] **Step 1: Create the panel**

```tsx
import { useMemo, useRef, useState } from "react";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import type { ActionBlock } from "@/lib/api";
import { convert, combineManifests, type ConversionResult } from "@rigel/compose";
import { isYamlFilename, readYamlFile } from "@/panels/apply/readYamlFile";
import { AlertTriangle, Info, Play, Upload } from "lucide-react";

const PLACEHOLDER = `# Paste your docker-compose.yml here, or upload a file.
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
`;

export default function ComposeMigratePanel() {
  const [compose, setCompose] = useState(PLACEHOLDER);
  const [namespace, setNamespace] = useState("default");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: schema } = useClusterYamlSchema();

  const result = useMemo<ConversionResult | null>(() => {
    if (!compose.trim()) return null;
    try {
      setParseError(null);
      return convert(compose, { namespace });
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [compose, namespace]);

  const manifestYaml = result ? combineManifests(result.manifests) : "";

  function handleApply() {
    if (!manifestYaml.trim()) return;
    setPendingAction({ kind: "applyManifest", label: "Apply migrated manifests", manifest: manifestYaml });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    try {
      setCompose(await readYamlFile(file));
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Migrate from Compose" subtitle="Turn a docker-compose.yml into Kubernetes manifests you can review and apply">
        <input ref={fileInput} type="file" accept=".yaml,.yml,text/yaml" hidden
          onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }} />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" /> Upload
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!manifestYaml.trim()}>
          <Play className="size-3.5 fill-current" /> Apply…
        </Button>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 gap-3 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">docker-compose.yml</span>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
            <YamlEditor value={compose} onChange={setCompose} schema={null} />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Generated manifests</span>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
            <YamlEditor value={manifestYaml} onChange={() => {}} schema={schema ?? null} />
          </div>
        </div>
      </div>

      {parseError && (
        <p className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{parseError}</p>
      )}
      {result && (result.warnings.length > 0 || result.catalogHints.length > 0) && (
        <div className="mx-4 mb-3 max-h-40 space-y-1 overflow-auto rounded-lg border border-border p-2 text-xs">
          {result.catalogHints.map((h, i) => (
            <p key={`h${i}`} className="flex items-center gap-2 text-muted-foreground">
              <Info className="size-3.5 shrink-0 text-[var(--accent-primary)]" />
              <span><span className="font-mono">{h.service}</span> looks like {h.appName}. The catalog has a hardened version.</span>
            </p>
          ))}
          {result.warnings.map((w, i) => (
            <p key={`w${i}`} className="flex items-center gap-2 text-muted-foreground">
              <AlertTriangle className={`size-3.5 shrink-0 ${w.severity === "warning" ? "text-amber-400" : "text-muted-foreground"}`} />
              <span>{w.service ? <span className="font-mono">{w.service}: </span> : null}{w.message}</span>
            </p>
          ))}
        </div>
      )}

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}
```

Note on namespace: this panel keeps a simple `namespace` string state defaulting to `"default"`. Per the user's "namespace input = dropdown" rule, replace the plain default with the shared NamespaceBar/namespace dropdown used elsewhere before shipping. Locate it via `grep -rl "NamespaceBar\|namespaceFilter" apps/web/src` and wire `namespace`/`setNamespace` to it. Flagged for the executor.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors (confirm `readYamlFile` is importable from `@/panels/apply/readYamlFile`; adjust the import path if it differs).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/compose/ComposeMigratePanel.tsx
git commit -m "feat(web): ComposeMigratePanel"
```

---

## Task 12: Nav + route registration

**Files:**
- Modify: `apps/web/src/shell/NavStrip.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add a `PANEL_META` entry** in `NavStrip.tsx` (near the `apply` entry, ~line 93). Use an appropriate lucide icon (e.g. `Container` or `FileInput`), imported alongside the other icons:

```ts
compose: { route: "/compose", title: "Migrate from Compose", subtitle: "Convert a docker-compose.yml to Kubernetes manifests", icon: FileInput },
```

- [ ] **Step 2: Add `"compose"` to the Tools group** in `NAV_GROUPS` (~line 118):

```ts
{ title: "Tools", panels: ["apply", "compose", "gitops"] },
```

- [ ] **Step 3: Add the route** in `App.tsx` (import the panel at top alongside `ApplyYamlPanel`, add the route near `/apply`):

```tsx
import ComposeMigratePanel from "@/panels/compose/ComposeMigratePanel";
// ...
<Route path="/compose" element={<ComposeMigratePanel />} />
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: no errors; `/compose` is reachable and appears in the Tools nav group and command palette.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/NavStrip.tsx apps/web/src/App.tsx
git commit -m "feat(web): register Migrate from Compose in Tools nav + route"
```

---

## Task 13: Onboarding entry card

**Files:**
- Modify: the first-run / empty-cluster component (locate first)

- [ ] **Step 1: Locate the onboarding/empty state**

Run: `grep -rliE "onboarding|empty.?state|first.?run|get started" apps/web/src | head`
Identify the component that renders on an empty cluster / first run.

- [ ] **Step 2: Add a card/button** that routes to `/compose`, worded "Coming from Docker Compose? Import your stack." Use the app's existing card/button primitives and `useNavigate()` (React Router v7) or a `<Link to="/compose">`. Match the surrounding cards' markup exactly (do not introduce new inline styles).

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): onboarding entry for Compose migration"
```

---

## Task 14: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `pnpm -r test`
Expected: all packages pass, including `@rigel/compose`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: no errors.

- [ ] **Step 3: Build web**

Run: `pnpm --filter web build`
Expected: success.

- [ ] **Step 4: Manual smoke (optional, per feedback do not start a dev server unless asked)**

If the user asks to see it live: `pnpm --filter desktop dev`, open Tools → Migrate from Compose, paste a compose file, confirm manifests render and Apply opens the ConfirmSheet.

- [ ] **Step 5: Final commit if anything is outstanding**

```bash
git add -A
git commit -m "chore(compose): verification pass" || true
```

---

## Self-Review Notes (author)

- **Spec coverage:** engine + mapping table (Tasks 3-9), catalog hints hint-only (Task 7), panel + apply reuse (Task 11), nav + onboarding (Tasks 12-13), namespace stamping (Task 8 `convert` writes `metadata.namespace`; Task 11 supplies it), testing incl. golden fixture + parse-error/empty (Tasks 5, 8, 9). Covered.
- **Deliberate deviations flagged for the executor:** (1) `yaml` dependency choice; (2) Pencil design for the panel; (3) namespace dropdown per the user's rule (Task 11 note). None block the engine work, which is the bulk of the value.
- **Catalog-dependent assertions** (Tasks 7, 9) must be reconciled against the real `catalog.json` image names; instructions to verify are inline.
