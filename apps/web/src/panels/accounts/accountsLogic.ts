import type { Secret } from "@helmsman/k8s";
import {
  DOCKERCONFIGJSON_TYPE,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  extractRegistryFromSecret,
  dockerconfigjsonToSecret,
  isValidDNS1123Subdomain,
} from "@helmsman/k8s";

/**
 * Pure, framework-free logic for the Accounts panel (registry credentials).
 * Mirrors `docs/parity/accounts.md`. Everything testable lives here so the
 * React component stays a thin shell; the panel's vitest suite exercises this
 * module directly (the repo has no jsdom/testing-library, so component logic is
 * tested as pure functions — same convention as the other panels).
 *
 * SECURITY: nothing here logs, and no function returns or embeds a password.
 * The only place a token appears is the `yaml` produced by `applyYAML`, which
 * is sent straight to `/api/apply`; the on-screen preview uses `previewYAML`,
 * which masks `.dockerconfigjson` as `[hidden]`.
 */

/** A registry account as displayed in the list (derived from a cluster Secret). */
export interface RegistryAccount {
  /** Stable client id — `${namespace}/${secretName}`. */
  id: string;
  registry: string;
  username: string;
  secretName: string;
  sourceNamespace: string;
  /** true = Secret carries the helmsman managed-by label; false = referenced. */
  managed: boolean;
  /** Auto-attached to installs; at most one per context (local display state). */
  isDefault: boolean;
}

export type AddMode = "create" | "reference";

export const DEFAULT_REGISTRY = "docker.io";
export const DEFAULT_SECRET_NAME = "helmsman-dockerhub";
export const DEFAULT_NAMESPACE = "default";

export const EMPTY_STATE_MESSAGE =
  "No accounts yet. Add a Docker Hub (or ghcr/quay) account so installs pull authenticated and avoid rate limits.";

/** The form state shared by both add modes. */
export interface AccountForm {
  mode: AddMode;
  registry: string;
  username: string;
  /** Access token / password — create mode only. NEVER logged or previewed. */
  password: string;
  secretName: string;
  namespace: string;
  makeDefault: boolean;
}

export function emptyForm(): AccountForm {
  return {
    mode: "create",
    registry: DEFAULT_REGISTRY,
    username: "",
    password: "",
    secretName: DEFAULT_SECRET_NAME,
    namespace: DEFAULT_NAMESPACE,
    makeDefault: false,
  };
}

// ---------------------------------------------------------------------------
// Derivation: cluster Secrets -> account list.
// ---------------------------------------------------------------------------

/**
 * Build the account list from the secrets watch map. Keeps only
 * `kubernetes.io/dockerconfigjson` Secrets whose `.dockerconfigjson` decodes to
 * at least one auth entry. `defaultId` (local state) marks which row is the
 * default. Sorted by namespace then secret name for stable display.
 */
export function accountsFromSecrets(
  secretsByName: Record<string, Secret>,
  defaultId: string | null,
): RegistryAccount[] {
  const accounts: RegistryAccount[] = [];
  for (const secret of Object.values(secretsByName)) {
    if (secret.type !== DOCKERCONFIGJSON_TYPE) continue;
    const extracted = extractRegistryFromSecret(secret);
    if (!extracted) continue;
    const secretName = secret.metadata.name;
    const sourceNamespace = secret.metadata.namespace ?? DEFAULT_NAMESPACE;
    const id = accountId(secretName, sourceNamespace);
    accounts.push({
      id,
      registry: extracted.registry,
      username: extracted.username,
      secretName,
      sourceNamespace,
      managed: secret.metadata.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
      isDefault: id === defaultId,
    });
  }
  return accounts.sort((a, b) => {
    const ns = a.sourceNamespace.localeCompare(b.sourceNamespace);
    return ns !== 0 ? ns : a.secretName.localeCompare(b.secretName);
  });
}

/** Stable id for an account row: `${namespace}/${secretName}`. */
export function accountId(secretName: string, namespace: string): string {
  return `${namespace}/${secretName}`;
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

export interface FieldErrors {
  registry?: string;
  username?: string;
  password?: string;
  secretName?: string;
  namespace?: string;
}

/**
 * Per-field validation. Registry/secretName/namespace must be non-empty
 * (trimmed); the access token is required only in create mode; the secret name
 * must be a valid DNS-1123 subdomain. Returns an empty object when valid.
 */
export function validateForm(form: AccountForm): FieldErrors {
  const errors: FieldErrors = {};
  if (form.registry.trim() === "") errors.registry = "Registry cannot be empty";
  if (form.secretName.trim() === "") {
    errors.secretName = "Secret name cannot be empty";
  } else if (!isValidDNS1123Subdomain(form.secretName.trim())) {
    errors.secretName = "Must be a valid DNS-1123 subdomain (lowercase letters, digits, '-', '.')";
  }
  if (form.namespace.trim() === "") errors.namespace = "Namespace cannot be empty";
  if (form.mode === "create" && form.password.trim() === "") {
    errors.password = "Access token is required";
  }
  return errors;
}

export function isFormValid(form: AccountForm): boolean {
  return Object.keys(validateForm(form)).length === 0;
}

// ---------------------------------------------------------------------------
// YAML for preview (masked) and apply (unmasked).
// ---------------------------------------------------------------------------

/**
 * Render the Secret manifest as YAML. When `mask` is true the
 * `.dockerconfigjson` value is replaced with `[hidden]` (for the on-screen
 * preview); when false it carries the real base64 credential (for `/api/apply`).
 */
function secretYAML(form: AccountForm, mask: boolean): string {
  const name = form.secretName.trim();
  const namespace = form.namespace.trim();
  const payload = mask
    ? "[hidden]"
    : dockerconfigjsonToSecret(
        form.registry.trim(),
        form.username,
        form.password,
        name,
        namespace,
      ).data![".dockerconfigjson"]!;
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "  labels:",
    `    ${MANAGED_BY_LABEL}: ${MANAGED_BY_VALUE}`,
    "type: kubernetes.io/dockerconfigjson",
    "data:",
    `  .dockerconfigjson: ${payload}`,
    "",
  ].join("\n");
}

/** YAML for the preview pane — `.dockerconfigjson` masked as `[hidden]`. */
export function previewYAML(form: AccountForm): string {
  return secretYAML(form, true);
}

/** YAML for `/api/apply` — `.dockerconfigjson` carries the real credential. */
export function applyYAML(form: AccountForm): string {
  return secretYAML(form, false);
}

// ---------------------------------------------------------------------------
// Default-account toggling (metadata only — no kubectl).
// ---------------------------------------------------------------------------

/**
 * Compute the next default id when "Set default" is pressed on `targetId`. The
 * caller stores this; `accountsFromSecrets` then re-derives `isDefault` flags.
 */
export function setDefaultId(_current: string | null, targetId: string): string {
  return targetId;
}

/**
 * Resolve the default id after an add succeeds. The new account becomes default
 * when the user toggled it, or when it would be the only account in the list.
 */
export function defaultIdAfterAdd(
  current: string | null,
  newId: string,
  makeDefault: boolean,
  existingCount: number,
): string | null {
  if (makeDefault || existingCount === 0) return newId;
  return current;
}

/** Drop the default when its account is removed from the list. */
export function defaultIdAfterDelete(current: string | null, removedId: string): string | null {
  return current === removedId ? null : current;
}
