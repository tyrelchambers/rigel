# Cloud-connect error guidance — Design

**Goal:** When a cloud connect/list step fails (e.g. an AWS IAM `AccessDeniedException` on `eks:ListClusters`), replace the raw red stderr dump with a friendly, actionable panel: a plain-English title, concrete fix steps, a provider-docs link, and the raw error tucked into a collapsible "Error details" block. Descriptor-driven so AWS/GCP/Azure each get tailored guidance; an unmatched error falls back to a clean generic panel that still shows the raw error.

**Pencil:** `Modal — EKS connect error (guidance)` (frame `PWP0E` in clankerlocal.pen). Approved 2026-06-25.

## Package (`@rigel/cloud-connect`)

### Type (`types.ts`)
```ts
export interface ErrorHint {
  /** Lowercased substrings; the hint matches if ANY is present in the stderr. */
  match: string[];
  title: string;           // friendly, plain-English
  steps: string[];         // numbered fix steps
  docsUrl?: string;
  docsLabel?: string;      // e.g. "EKS permissions docs"
}
```
Add `errorHints?: ErrorHint[]` to `ProviderDescriptor`.

### Helper (`descriptors.ts`, exported via index)
```ts
export function diagnoseError(descriptor: ProviderDescriptor, stderr: string): ErrorHint | null {
  const lc = stderr.toLowerCase();
  return descriptor.errorHints?.find((h) => h.match.some((m) => lc.includes(m.toLowerCase()))) ?? null;
}
```
First match wins, so order hints most-specific first.

### Hints (one per provider descriptor)

**AWS** (`aws.errorHints`):
1. `match: ["not authorized to perform", "accessdenied", "access denied", "is not authorized"]`
   `title: "Your AWS identity can't access EKS"`
   steps: ["Attach an IAM policy that allows eks:ListClusters and eks:DescribeCluster (for example the managed AmazonEKSClusterPolicy).", "To use a cluster, add an EKS access entry mapping your IAM principal to a Kubernetes group."]
   docsUrl `https://docs.aws.amazon.com/eks/latest/userguide/security-iam.html`, docsLabel "EKS permissions docs"
2. `match: ["expiredtoken", "the security token included in the request is expired", "token has expired"]`
   `title: "Your AWS session expired"`
   steps: ["Re-authenticate with the AWS CLI: run aws sso login, or aws configure for static keys.", "Then try again."]
   docsUrl `https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html`, docsLabel "AWS CLI auth docs"

**GCP** (`gcp.errorHints`, api-not-enabled first):
1. `match: ["api has not been used", "is not enabled", "accessnotconfigured", "container.googleapis.com"]`
   `title: "The Kubernetes Engine API isn't enabled"`
   steps: ["Enable the Kubernetes Engine API for this project in the Google Cloud console.", "Wait a minute for it to propagate, then try again."]
   docsUrl `https://console.cloud.google.com/apis/library/container.googleapis.com`, docsLabel "Enable the API"
2. `match: ["permission denied", "caller does not have permission", "permission_denied", "does not have permission"]`
   `title: "Your Google account can't list GKE clusters"`
   steps: ["Grant your account container.clusters.list and container.clusters.get (for example the Kubernetes Engine Viewer role).", "Confirm the Kubernetes Engine API is enabled on the project."]
   docsUrl `https://cloud.google.com/kubernetes-engine/docs/how-to/iam`, docsLabel "GKE IAM docs"

**Azure** (`azure.errorHints`):
1. `match: ["authorizationfailed", "does not have authorization to perform", "not authorized", "forbidden"]`
   `title: "Your Azure account can't list AKS clusters"`
   steps: ["Ask an admin to grant your account the Azure Kubernetes Service Cluster User (or Reader) role on the subscription or resource group.", "Then try again."]
   docsUrl `https://learn.microsoft.com/azure/aks/control-kubeconfig-access`, docsLabel "AKS access docs"
2. `match: ["no subscription found", "no subscriptions found", "please run 'az login'"]`
   `title: "No active Azure subscription"`
   steps: ["Run az login and select a subscription that has AKS clusters.", "Then try again."]
   docsUrl `https://learn.microsoft.com/cli/azure/authenticate-azure-cli`, docsLabel "Azure CLI auth docs"

(DigitalOcean keeps no hints for now → generic fallback; easy follow-up.)

## Web (`apps/web/src/shell/ConnectWizard.tsx`)

Replace the bare `error` phase render with an `ErrorPanel` sub-component (matching the existing CommandField/CopyChip/PlatformCard pattern): `ErrorPanel({ descriptor, error, onRetry })`.

Layout (per Pencil `PWP0E`), all inline-styles with CSS-var tokens (no hex):
- **Head** — a danger icon square (36×36, radius 8; `ShieldAlert` from lucide in `var(--status-failed)`; square bg a faint danger token if one exists in index.css, else `var(--surface-elevated)`) + a text column: title (`var(--fg-primary)`, 15/600) = `hint ? hint.title : "Couldn't reach " + descriptor.displayName`; sub (`var(--fg-secondary)`, 13, lineHeight 1.5) = `hint ? "Grant the access below, then try again." : "This is usually a permissions or configuration issue on the " + descriptor.displayName + " side."`.
- **How to fix card** (only when `hint`) — `var(--surface-elevated)` bg, `var(--border-subtle)`, radius 12, padding 14: a "HOW TO FIX" mono label (`var(--fg-tertiary)`), then `hint.steps.map` as numbered rows: a 18×18 circle badge (`var(--accent-dim)` bg, `var(--accent-primary)` number) + step text (`var(--fg-secondary)`, 13, lineHeight 1.5).
- **Error details** — a toggle row: a button (chevron + "Error details", `var(--fg-secondary)`) toggling `showDetails`; a "Copy"/"Copied" affordance (`var(--accent-primary)`) that copies the raw `error`. When `showDetails`, a `var(--surface-sunken)` block (`var(--border-subtle)`, radius 8) with the raw `error` in `var(--font-mono)`, 11.5, `var(--fg-secondary)`, wrapped. Default `showDetails = !hint` (generic → expanded; guided → collapsed).
- **Footer** — `hint?.docsUrl` → an external-link anchor labelled `hint.docsLabel ?? "Docs"` (`var(--accent-primary)`); right side `<Button onClick={onRetry}>` with a `RefreshCw` icon + "Try again".

A small `Step({ n, text })` sub-component renders the numbered fix rows.

## Testing
- Package: `diagnoseError` returns the right hint for representative AWS/GCP/Azure stderrs (the AccessDenied example, GCP api-not-enabled, Azure AuthorizationFailed), `null` for an unrecognized string and for a provider with no hints; descriptor tests assert each provider's hints are present and ordered.
- Web: ErrorPanel shows the friendly title + steps + docs for a recognized AWS AccessDenied error and hides the raw block until "Error details" is clicked; shows the generic title + the raw error (expanded) for an unrecognized error; "Try again" calls `onRetry`.

## Out of scope
- Parsing the specific IAM action/ARN out of the error (the raw block already shows it).
- DigitalOcean hints (follow-up).
- Auto-routing an expired-session list failure back to the needs-login step (the hint guides re-auth; the user clicks Try again).
