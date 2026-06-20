# Registry Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user add registry (pull) accounts in Rigel and have a default account automatically authenticate catalog installs, fixing Docker Hub 429 rate-limit failures.

**Architecture:** A `RegistryAccount` value (metadata only) persists per kube-context in `SessionStore`; the credential lives only in a cluster `dockerconfigjson` Secret (create path) or a Secret the user already manages (reference path). A pure `RegistryCredentialBuilder` produces the `dockerconfigjson`; `RegistryAccountReconciler` performs the cluster side effects (create Secret, copy it into a target namespace, union it into that namespace's `default` ServiceAccount `imagePullSecrets`). A new Accounts panel manages accounts; the install wizard runs `ensureAccess` before applying.

**Tech Stack:** Swift 5.9 / SwiftUI, `@Observable`, XCTest, `swift build` / `swift test`, kubectl via the existing `WorkloadCommander` + `KubectlClient`/`runProcess` plumbing.

---

## Shared API surface (defined here; referenced by all tasks)

```swift
// RegistryAccount.swift
struct RegistryAccount: Codable, Hashable, Identifiable {
    let id: UUID
    var registry: String         // "docker.io", "ghcr.io", "quay.io", or a custom host
    var username: String
    var secretName: String       // k8s Secret name, e.g. "rigel-dockerhub"
    var sourceNamespace: String  // namespace the Secret lives in (default "default")
    var managed: Bool            // true = Rigel created the Secret; false = referenced existing
    var isDefault: Bool          // the account auto-attached to installs (≤1 true per context)
}

// SessionStore additions
func registryAccounts(for context: String) -> [RegistryAccount]
func setRegistryAccounts(_ accounts: [RegistryAccount], for context: String)
func defaultRegistryAccount(for context: String) -> RegistryAccount?

// RegistryCredentialBuilder.swift (pure)
enum RegistryCredentialBuilder {
    static func authsKey(for registry: String) -> String      // docker.io -> https://index.docker.io/v1/
    static func dockerConfigJSON(registry: String, username: String, token: String) -> String
}

// RegistryAccountReconciler.swift
enum ReconcileOutcome: Equatable { case ok, failed(String) }
struct RegistryAccountReconciler {
    let context: String?
    static func unionImagePullSecrets(existing: [String], adding: String) -> [String]
    static func saMergePatch(secretNames: [String]) -> String
    func create(registry: String, username: String, token: String,
                secretName: String, namespace: String) async -> ReconcileOutcome
    func verifyReference(secretName: String, namespace: String) async -> ReconcileOutcome
    func ensureAccess(account: RegistryAccount, namespace: String) async -> ReconcileOutcome
}

// Secret.swift extension (pure)
extension Secret { func copied(toNamespace ns: String) -> Secret }
```

**File structure**
- Create: `Sources/Rigel/Accounts/RegistryAccount.swift`
- Create: `Sources/Rigel/Accounts/RegistryCredentialBuilder.swift`
- Create: `Sources/Rigel/Accounts/RegistryAccountReconciler.swift`
- Create: `Sources/Rigel/Panels/Accounts/AccountsViewModel.swift`
- Create: `Sources/Rigel/Panels/Accounts/AccountsPanel.swift`
- Modify: `Sources/Rigel/State/SessionStore.swift` (add per-context account map + accessors)
- Modify: `Sources/Rigel/Cluster/Secret.swift` (add `copied(toNamespace:)`)
- Modify: `Sources/Rigel/Panels/PanelKind.swift` (add `.accounts`)
- Modify: `Sources/Rigel/Shell/MainWindow.swift` (wire the panel)
- Modify: `Sources/Rigel/Panels/Catalog/CatalogInstallWizardModel.swift` (account binding + ensureAccess)
- Modify: `Sources/Rigel/Panels/Catalog/CatalogInstallWizard.swift` (pull-credentials control)
- Tests: `Tests/RigelTests/RegistryAccountTests.swift`, `RegistryCredentialBuilderTests.swift`, `RegistryAccountReconcilerTests.swift`, plus additions to `WizardSecretsTests.swift`.

---

## Task 1: `RegistryAccount` model + SessionStore persistence

**Files:**
- Create: `Sources/Rigel/Accounts/RegistryAccount.swift`
- Modify: `Sources/Rigel/State/SessionStore.swift` (Storage struct ~line 27-41; add accessors after the self-host block ~line 136)
- Test: `Tests/RigelTests/RegistryAccountTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/RigelTests/RegistryAccountTests.swift
import XCTest
@testable import Rigel

@MainActor
final class RegistryAccountTests: XCTestCase {
    func test_registryAccount_codableRoundTrips() throws {
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "tyrel",
                                secretName: "rigel-dockerhub", sourceNamespace: "default",
                                managed: true, isDefault: true)
        let data = try JSONEncoder().encode(a)
        let back = try JSONDecoder().decode(RegistryAccount.self, from: data)
        XCTAssertEqual(back, a)
    }

    func test_defaultRegistryAccount_returnsTheFlaggedOne() {
        let store = SessionStore.shared
        let ctx = "test-ctx-\(UUID().uuidString)"
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "u",
                                secretName: "s", sourceNamespace: "default",
                                managed: true, isDefault: false)
        let b = RegistryAccount(id: UUID(), registry: "ghcr.io", username: "u",
                                secretName: "s2", sourceNamespace: "default",
                                managed: true, isDefault: true)
        store.setRegistryAccounts([a, b], for: ctx)
        XCTAssertEqual(store.defaultRegistryAccount(for: ctx)?.id, b.id)
        XCTAssertEqual(store.registryAccounts(for: ctx).count, 2)
        store.setRegistryAccounts([], for: ctx)   // cleanup
        XCTAssertNil(store.defaultRegistryAccount(for: ctx))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter RegistryAccountTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'RegistryAccount' in scope` / `value of type 'SessionStore' has no member 'setRegistryAccounts'`.

- [ ] **Step 3: Create the model**

```swift
// Sources/Rigel/Accounts/RegistryAccount.swift
import Foundation

/// A registry/pull-credential account the user manages in Rigel. Persisted
/// per kube-context in `SessionStore` — METADATA ONLY. The credential never lives
/// on disk: for `managed` accounts it's in the cluster `dockerconfigjson` Secret
/// Rigel created; for referenced accounts (`managed == false`) Rigel never
/// sees it. The model is shaped to extend to other account types later.
struct RegistryAccount: Codable, Hashable, Identifiable {
    let id: UUID
    var registry: String         // "docker.io", "ghcr.io", "quay.io", or a custom host
    var username: String
    var secretName: String       // k8s Secret name, e.g. "rigel-dockerhub"
    var sourceNamespace: String  // namespace the Secret lives in (default "default")
    var managed: Bool            // true = Rigel created the Secret; false = referenced existing
    var isDefault: Bool          // the account auto-attached to installs (≤1 true per context)
}
```

- [ ] **Step 4: Add per-context persistence to SessionStore**

In `Sources/Rigel/State/SessionStore.swift`, add a field to the `private struct Storage` (right after `selfHostDefaultsByContext`, ~line 40):

```swift
        // Per-context registry/pull accounts (metadata only — no credential).
        // Optional for back-compat with sessions.json written before this field.
        var registryAccountsByContext: [String: [RegistryAccount]]? = nil
```

Add accessors after `setSelfHostDefaults(_:for:)` (~line 136):

```swift
    // MARK: - Registry accounts (per-context)

    func registryAccounts(for context: String) -> [RegistryAccount] {
        storage.registryAccountsByContext?[context] ?? []
    }

    func setRegistryAccounts(_ accounts: [RegistryAccount], for context: String) {
        var map = storage.registryAccountsByContext ?? [:]
        map[context] = accounts
        storage.registryAccountsByContext = map
        persist()
    }

    /// The account flagged as default for this context (≤1; first wins if a
    /// malformed file ever has more). nil when none is marked.
    func defaultRegistryAccount(for context: String) -> RegistryAccount? {
        registryAccounts(for: context).first { $0.isDefault }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `swift test --filter RegistryAccountTests 2>&1 | tail -20`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Accounts/RegistryAccount.swift Sources/Rigel/State/SessionStore.swift Tests/RigelTests/RegistryAccountTests.swift
git commit -m "feat(accounts): RegistryAccount model + per-context persistence"
```

---

## Task 2: `RegistryCredentialBuilder` (pure dockerconfigjson)

**Files:**
- Create: `Sources/Rigel/Accounts/RegistryCredentialBuilder.swift`
- Test: `Tests/RigelTests/RegistryCredentialBuilderTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/RigelTests/RegistryCredentialBuilderTests.swift
import XCTest
@testable import Rigel

final class RegistryCredentialBuilderTests: XCTestCase {
    func test_authsKey_dockerHubUsesV1Endpoint() {
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "docker.io"), "https://index.docker.io/v1/")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: ""), "https://index.docker.io/v1/")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "ghcr.io"), "ghcr.io")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "quay.io"), "quay.io")
    }

    func test_dockerConfigJSON_hasAuthsWithBase64Auth() throws {
        let json = RegistryCredentialBuilder.dockerConfigJSON(registry: "ghcr.io", username: "tyrel", token: "secret")
        let obj = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        let auths = obj["auths"] as! [String: Any]
        let entry = auths["ghcr.io"] as! [String: Any]
        XCTAssertEqual(entry["username"] as? String, "tyrel")
        XCTAssertEqual(entry["password"] as? String, "secret")
        XCTAssertEqual(entry["auth"] as? String, Data("tyrel:secret".utf8).base64EncodedString())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter RegistryCredentialBuilderTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'RegistryCredentialBuilder' in scope`.

- [ ] **Step 3: Implement the builder**

```swift
// Sources/Rigel/Accounts/RegistryCredentialBuilder.swift
import Foundation

/// Builds the `.dockerconfigjson` payload for a registry pull Secret. Pure — holds
/// no state and performs no I/O. Encodes the well-known Docker Hub quirk that its
/// auths key is `https://index.docker.io/v1/`, not `docker.io`.
enum RegistryCredentialBuilder {
    static func authsKey(for registry: String) -> String {
        let r = registry.trimmingCharacters(in: .whitespaces).lowercased()
        if r.isEmpty || r == "docker.io" || r == "index.docker.io" || r == "registry-1.docker.io" {
            return "https://index.docker.io/v1/"
        }
        return registry.trimmingCharacters(in: .whitespaces)
    }

    /// `{"auths":{"<key>":{"username":..,"password":..,"auth":base64("user:token")}}}`.
    /// Sorted keys for deterministic output (testability).
    static func dockerConfigJSON(registry: String, username: String, token: String) -> String {
        let auth = Data("\(username):\(token)".utf8).base64EncodedString()
        let entry: [String: String] = ["username": username, "password": token, "auth": auth]
        let payload: [String: [String: [String: String]]] = ["auths": [authsKey(for: registry): entry]]
        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter RegistryCredentialBuilderTests 2>&1 | tail -20`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add Sources/Rigel/Accounts/RegistryCredentialBuilder.swift Tests/RigelTests/RegistryCredentialBuilderTests.swift
git commit -m "feat(accounts): pure dockerconfigjson credential builder"
```

---

## Task 3: `Secret.copied(toNamespace:)` + reconciler pure helpers

**Files:**
- Modify: `Sources/Rigel/Cluster/Secret.swift` (add extension method near `draft`/`toYAML`, ~line 106)
- Create: `Sources/Rigel/Accounts/RegistryAccountReconciler.swift` (pure statics only in this task; async methods added in Task 4's prerequisite below — actually added here too)
- Test: `Tests/RigelTests/RegistryAccountReconcilerTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/RigelTests/RegistryAccountReconcilerTests.swift
import XCTest
@testable import Rigel

final class RegistryAccountReconcilerTests: XCTestCase {
    func test_unionImagePullSecrets_appendsWithoutDuplicates_preservingExisting() {
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: ["other"], adding: "rigel-dockerhub"),
            ["other", "rigel-dockerhub"])
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: ["rigel-dockerhub"], adding: "rigel-dockerhub"),
            ["rigel-dockerhub"])   // idempotent
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: [], adding: "a"),
            ["a"])
    }

    func test_saMergePatch_emitsFullList() {
        let patch = RegistryAccountReconciler.saMergePatch(secretNames: ["a", "b"])
        XCTAssertEqual(patch, #"{"imagePullSecrets":[{"name":"a"},{"name":"b"}]}"#)
    }

    func test_secretCopied_retargetsNamespaceAndStripsServerMetadata() {
        let original = Secret.draft(name: "regcred", namespace: "default", type: .dockerconfigjson,
                                    decodedData: [".dockerconfigjson": #"{"auths":{}}"#])
        let copy = original.copied(toNamespace: "media")
        XCTAssertEqual(copy.metadata.namespace, "media")
        XCTAssertEqual(copy.metadata.name, "regcred")
        XCTAssertEqual(copy.metadata.uid, "")          // server metadata dropped
        XCTAssertEqual(copy.data, original.data)        // base64 payload preserved verbatim
        XCTAssertTrue(copy.toYAML().contains("namespace: 'media'"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter RegistryAccountReconcilerTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'RegistryAccountReconciler'` / `value of type 'Secret' has no member 'copied'`.

- [ ] **Step 3: Add `Secret.copied(toNamespace:)`**

In `Sources/Rigel/Cluster/Secret.swift`, inside the existing `extension Secret { … }` (after `draft`, ~line 106):

```swift
    /// A copy of this Secret retargeted to another namespace, with server-assigned
    /// metadata (uid, creationTimestamp, annotations) dropped so it applies cleanly
    /// via `kubectl apply -f -`. The base64 `data` payload is preserved verbatim,
    /// so this works for copying a pull Secret across namespaces without decoding it.
    func copied(toNamespace ns: String) -> Secret {
        let meta = ObjectMeta(
            name: metadata.name,
            namespace: ns,
            uid: "",
            creationTimestamp: nil,
            labels: metadata.labels,
            annotations: nil
        )
        return Secret(metadata: meta, type: type, data: data)
    }
```

- [ ] **Step 4: Create the reconciler with pure statics**

```swift
// Sources/Rigel/Accounts/RegistryAccountReconciler.swift
import Foundation

/// Outcome of a reconciler operation. Carries a human-readable message on failure
/// only — NEVER a Secret body (see the no-logging note in the design spec).
enum ReconcileOutcome: Equatable { case ok, failed(String) }

/// Performs the cluster side effects for registry accounts via kubectl: create the
/// pull Secret, copy it into a target namespace, and union it into that namespace's
/// `default` ServiceAccount `imagePullSecrets`. Reads/writes go through the existing
/// `KubectlClient` + `WorkloadCommander` plumbing.
///
/// SECURITY: `ensureAccess` reads a Secret's JSON (which contains the base64 token)
/// to copy it across namespaces. That payload is handled in memory only and is never
/// returned in a `ReconcileOutcome` or logged.
struct RegistryAccountReconciler {
    let context: String?

    /// Append `adding` to `existing` unless already present. Order preserved so we
    /// never reorder pull secrets another tool put on the SA.
    static func unionImagePullSecrets(existing: [String], adding: String) -> [String] {
        existing.contains(adding) ? existing : existing + [adding]
    }

    /// A JSON merge-patch body that REPLACES `imagePullSecrets` with the full list.
    /// (A merge patch replaces arrays, so callers must pass the complete unioned set.)
    static func saMergePatch(secretNames: [String]) -> String {
        let items = secretNames.map { #"{"name":"\#($0)"}"# }.joined(separator: ",")
        return #"{"imagePullSecrets":[\#(items)]}"#
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `swift test --filter RegistryAccountReconcilerTests 2>&1 | tail -20`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Cluster/Secret.swift Sources/Rigel/Accounts/RegistryAccountReconciler.swift Tests/RigelTests/RegistryAccountReconcilerTests.swift
git commit -m "feat(accounts): secret copy + reconciler pure helpers (SA union, merge patch)"
```

---

## Task 4: Reconciler async operations (create / verify / ensureAccess)

**Files:**
- Modify: `Sources/Rigel/Accounts/RegistryAccountReconciler.swift` (add async methods + a private kubectl read helper)

These methods perform live kubectl I/O, so they're exercised via the manual verification at the end of the plan rather than unit tests (the pure pieces they call are already tested in Task 3). No new test file.

- [ ] **Step 1: Add a private kubectl read helper**

Append inside `struct RegistryAccountReconciler`:

```swift
    /// Run a read-only kubectl command, returning (stdout, ok). Mirrors the
    /// `runKubectl` pattern in MainWindow. The caller must treat stdout as
    /// potentially secret and never log it.
    private func read(_ args: [String]) async -> (out: String, ok: Bool) {
        guard let ctx = context else { return ("", false) }
        let kubectl: String
        do { kubectl = try KubectlClient(context: ctx).kubectl }
        catch { return ("\(error)", false) }
        do {
            let data = try await runProcess(kubectl, args: ["--context", ctx] + args)
            return (String(data: data, encoding: .utf8) ?? "", true)
        } catch ProcessError.nonZeroExit(_, let stderr) {
            return (stderr, false)
        } catch {
            return ("\(error)", false)
        }
    }
```

- [ ] **Step 2: Add `create`**

```swift
    /// Build the dockerconfigjson Secret from credentials and apply it to
    /// `namespace`. Returns `.ok` on success; the token is not retained after this.
    func create(registry: String, username: String, token: String,
                secretName: String, namespace: String) async -> ReconcileOutcome {
        let json = RegistryCredentialBuilder.dockerConfigJSON(registry: registry, username: username, token: token)
        let secret = Secret.draft(
            name: secretName,
            namespace: namespace,
            type: .dockerconfigjson,
            decodedData: [".dockerconfigjson": json],
            labels: ["app.kubernetes.io/managed-by": "rigel"]
        )
        let result = await WorkloadCommander(context: context).run(.applySecret(secret))
        return result.ok ? .ok : .failed(result.stderr.isEmpty ? "kubectl exited \(result.exitCode)" : result.stderr)
    }
```

- [ ] **Step 3: Add `verifyReference`**

```swift
    /// Confirm a referenced Secret exists (used by the "reference existing" path).
    func verifyReference(secretName: String, namespace: String) async -> ReconcileOutcome {
        let (out, ok) = await read(["get", "secret", secretName, "-n", namespace, "-o", "name"])
        if ok { return .ok }
        return .failed(out.isEmpty ? "secret \(secretName) not found in \(namespace)" : out)
    }
```

- [ ] **Step 4: Add `ensureAccess`**

```swift
    /// Ensure `account`'s Secret exists in `namespace`, then union it into that
    /// namespace's `default` ServiceAccount imagePullSecrets. Idempotent.
    func ensureAccess(account: RegistryAccount, namespace: String) async -> ReconcileOutcome {
        // 1. Ensure the Secret is present in the target namespace.
        if namespace != account.sourceNamespace {
            // Read the source Secret's JSON (contains the base64 token) — kept in
            // memory only, never logged.
            let (json, ok) = await read(["get", "secret", account.secretName, "-n", account.sourceNamespace, "-o", "json"])
            guard ok else { return .failed("couldn't read \(account.secretName) in \(account.sourceNamespace): \(json)") }
            guard let src = try? JSONDecoder().decode(Secret.self, from: Data(json.utf8)) else {
                return .failed("couldn't parse \(account.secretName)")
            }
            let copy = src.copied(toNamespace: namespace)
            let applied = await WorkloadCommander(context: context).run(.applySecret(copy))
            guard applied.ok else { return .failed(applied.stderr.isEmpty ? "kubectl exited \(applied.exitCode)" : applied.stderr) }
        }

        // 2. Read the target namespace default SA's current imagePullSecrets.
        let (names, ok) = await read(["get", "serviceaccount", "default", "-n", namespace,
                                      "-o", "jsonpath={.imagePullSecrets[*].name}"])
        guard ok else { return .failed("couldn't read default ServiceAccount in \(namespace): \(names)") }
        let existing = names.split(separator: " ").map(String.init)
        let union = Self.unionImagePullSecrets(existing: existing, adding: account.secretName)
        if union == existing { return .ok }   // already present — nothing to do

        // 3. Write the full unioned list back via a merge patch.
        let patch = Self.saMergePatch(secretNames: union)
        let patched = await WorkloadCommander(context: context).run(
            .command(args: ["patch", "serviceaccount", "default", "-n", namespace, "--type=merge", "-p", patch],
                     label: "Attach pull secret to default ServiceAccount", destructive: false))
        return patched.ok ? .ok : .failed(patched.stderr.isEmpty ? "kubectl exited \(patched.exitCode)" : patched.stderr)
    }
```

- [ ] **Step 5: Build to verify it compiles**

Run: `swift build 2>&1 | tail -5`
Expected: `Build complete!` (resolves `KubectlClient`, `runProcess`, `ProcessError`, `WorkloadCommander`, `.command`).

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Accounts/RegistryAccountReconciler.swift
git commit -m "feat(accounts): reconciler create/verify/ensureAccess via kubectl"
```

---

## Task 5: `AccountsViewModel`

**Files:**
- Create: `Sources/Rigel/Panels/Accounts/AccountsViewModel.swift`
- Test: add to `Tests/RigelTests/RegistryAccountTests.swift`

- [ ] **Step 1: Write the failing test (append to RegistryAccountTests)**

```swift
    func test_accountsViewModel_setDefault_makesExactlyOneDefault() {
        let ctx = "vm-ctx-\(UUID().uuidString)"
        let vm = AccountsViewModel(context: ctx)
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "u", secretName: "s",
                                sourceNamespace: "default", managed: false, isDefault: true)
        let b = RegistryAccount(id: UUID(), registry: "ghcr.io", username: "u", secretName: "s2",
                                sourceNamespace: "default", managed: false, isDefault: false)
        vm.accounts = [a, b]
        vm.persist()
        vm.setDefault(b.id)
        XCTAssertEqual(vm.accounts.filter(\.isDefault).map(\.id), [b.id])
        XCTAssertEqual(SessionStore.shared.defaultRegistryAccount(for: ctx)?.id, b.id)
        SessionStore.shared.setRegistryAccounts([], for: ctx)   // cleanup
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter RegistryAccountTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'AccountsViewModel' in scope`.

- [ ] **Step 3: Implement the view model**

```swift
// Sources/Rigel/Panels/Accounts/AccountsViewModel.swift
import Foundation
import Observation

@MainActor
@Observable
final class AccountsViewModel {
    private(set) var context: String
    var accounts: [RegistryAccount] = []
    /// Non-nil while an add/verify is running; drives a spinner + disables the form.
    var busy = false
    var errorMessage: String?

    init(context: String) {
        self.context = context
        self.accounts = SessionStore.shared.registryAccounts(for: context)
    }

    func load(context: String?) {
        self.context = context ?? ""
        self.accounts = SessionStore.shared.registryAccounts(for: self.context)
        errorMessage = nil
    }

    func persist() {
        SessionStore.shared.setRegistryAccounts(accounts, for: context)
    }

    /// Flip the default flag so exactly the given account is default (others off).
    func setDefault(_ id: UUID) {
        accounts = accounts.map { var a = $0; a.isDefault = (a.id == id); return a }
        persist()
    }

    func delete(_ id: UUID) {
        accounts.removeAll { $0.id == id }
        persist()
    }

    /// Create path: build + apply the Secret, then record metadata. Token is not
    /// retained. `makeDefault` marks this the context default on success.
    func addManaged(registry: String, username: String, token: String,
                    secretName: String, namespace: String, makeDefault: Bool) async {
        busy = true; errorMessage = nil
        defer { busy = false }
        let outcome = await RegistryAccountReconciler(context: context).create(
            registry: registry, username: username, token: token,
            secretName: secretName, namespace: namespace)
        guard case .ok = outcome else {
            if case let .failed(msg) = outcome { errorMessage = msg }
            return
        }
        var account = RegistryAccount(id: UUID(), registry: registry, username: username,
                                      secretName: secretName, sourceNamespace: namespace,
                                      managed: true, isDefault: false)
        if makeDefault || accounts.isEmpty { account.isDefault = true }
        appendEnforcingSingleDefault(account)
    }

    /// Reference path: verify the existing Secret, then record metadata only.
    func addReference(registry: String, username: String, secretName: String,
                      namespace: String, makeDefault: Bool) async {
        busy = true; errorMessage = nil
        defer { busy = false }
        let outcome = await RegistryAccountReconciler(context: context).verifyReference(
            secretName: secretName, namespace: namespace)
        guard case .ok = outcome else {
            if case let .failed(msg) = outcome { errorMessage = msg }
            return
        }
        var account = RegistryAccount(id: UUID(), registry: registry, username: username,
                                      secretName: secretName, sourceNamespace: namespace,
                                      managed: false, isDefault: false)
        if makeDefault || accounts.isEmpty { account.isDefault = true }
        appendEnforcingSingleDefault(account)
    }

    private func appendEnforcingSingleDefault(_ account: RegistryAccount) {
        if account.isDefault { accounts = accounts.map { var a = $0; a.isDefault = false; return a } }
        accounts.append(account)
        persist()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter RegistryAccountTests 2>&1 | tail -20`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add Sources/Rigel/Panels/Accounts/AccountsViewModel.swift Tests/RigelTests/RegistryAccountTests.swift
git commit -m "feat(accounts): AccountsViewModel (add/reference/default/delete)"
```

---

## Task 6: Accounts panel UI + nav wiring

**Files:**
- Create: `Sources/Rigel/Panels/Accounts/AccountsPanel.swift`
- Modify: `Sources/Rigel/Panels/PanelKind.swift` (add case + icon/title/subtitle/flags)
- Modify: `Sources/Rigel/Shell/MainWindow.swift` (VM state + nav group + panel switch + load)

- [ ] **Step 1: Add the `.accounts` PanelKind**

In `Sources/Rigel/Panels/PanelKind.swift`:
- Add `case accounts` after `case settings` (line 23).
- In `navGroups` (line 46) change the System group to:
  `NavGroup(title: "System", panels: [.accounts, .settings]),`
- In `icon` add: `case .accounts: return "person.badge.key.fill"`
- In `title` add: `case .accounts: return "Accounts"`
- In `subtitle` add: `case .accounts: return "Registry credentials"`
- In `hasHeavyList` add `.accounts` to the `false` (light) branch alongside `.settings`.
- In `isNamespaceScoped` add `.accounts` to the `false` branch alongside `.settings`.

- [ ] **Step 2: Build to confirm the enum is exhaustive**

Run: `swift build 2>&1 | tail -15`
Expected: FAIL — `switch must be exhaustive` in `MainWindow.panelView` (the missing `.accounts` case). This confirms the next step is needed.

- [ ] **Step 3: Create the panel**

```swift
// Sources/Rigel/Panels/Accounts/AccountsPanel.swift
import SwiftUI

struct AccountsPanel: View {
    @Bindable var viewModel: AccountsViewModel
    @State private var addingAccount = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Registry accounts")
                            .font(Theme.Font.body(15, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.primary)
                        Text("Credentials Rigel uses to pull images for catalog installs. Stored as a standard Kubernetes Secret (base64 in etcd) — not encrypted at rest.")
                            .font(Theme.Font.body(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button { addingAccount = true } label: {
                        Label("Add account", systemImage: "plus")
                            .font(Theme.Font.body(12, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                }

                if viewModel.accounts.isEmpty {
                    Text("No accounts yet. Add a Docker Hub (or ghcr/quay) account so installs pull authenticated and avoid rate limits.")
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .padding(.vertical, 8)
                } else {
                    VStack(spacing: 8) {
                        ForEach(viewModel.accounts) { account in
                            AccountRow(account: account,
                                       onSetDefault: { viewModel.setDefault(account.id) },
                                       onDelete: { viewModel.delete(account.id) })
                        }
                    }
                }
            }
            .padding(20)
        }
        .sheet(isPresented: $addingAccount) {
            AddAccountSheet(viewModel: viewModel, onClose: { addingAccount = false })
        }
    }
}

private struct AccountRow: View {
    let account: RegistryAccount
    let onSetDefault: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "shippingbox.fill")
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(account.registry)
                        .font(Theme.Font.mono(12, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.primary)
                    if account.isDefault {
                        Text("default")
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Accent.primary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.Accent.primaryDim)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    if !account.managed {
                        Text("referenced")
                            .font(Theme.Font.mono(9))
                            .foregroundStyle(Theme.Foreground.tertiary)
                    }
                }
                Text("\(account.username) · secret/\(account.secretName) in \(account.sourceNamespace)")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
            if !account.isDefault {
                Button("Set default", action: onSetDefault)
                    .font(Theme.Font.body(11))
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.Accent.primary)
            }
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "trash").foregroundStyle(Theme.Status.failed)
            }
            .buttonStyle(.plain)
            .help("Remove account (does not delete the cluster Secret)")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct AddAccountSheet: View {
    @Bindable var viewModel: AccountsViewModel
    let onClose: () -> Void

    @State private var mode: Mode = .create
    @State private var registry = "docker.io"
    @State private var username = ""
    @State private var token = ""
    @State private var secretName = "rigel-dockerhub"
    @State private var namespace = "default"
    @State private var makeDefault = true

    private enum Mode: String, CaseIterable { case create = "Create", reference = "Reference existing" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add registry account")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)

            Picker("", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            field("Registry") { TextField("docker.io", text: $registry).onChange(of: registry) { _, _ in syncDefaults() } }
            field("Username") { TextField("dockerhub user", text: $username) }
            if mode == .create {
                field("Access token") { SecureField("personal access token", text: $token) }
            }
            field("Secret name") { TextField("rigel-dockerhub", text: $secretName) }
            field("Namespace") { TextField("default", text: $namespace) }
            Toggle("Use as the default for installs", isOn: $makeDefault)
                .font(Theme.Font.body(12))

            if let err = viewModel.errorMessage {
                Text(err).font(Theme.Font.mono(10)).foregroundStyle(Theme.Status.failed)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button("Cancel", action: onClose).buttonStyle(.plain)
                Button(viewModel.busy ? "Working…" : "Add") { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.busy || !canSubmit)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private var canSubmit: Bool {
        guard !registry.trimmingCharacters(in: .whitespaces).isEmpty,
              !secretName.trimmingCharacters(in: .whitespaces).isEmpty,
              !namespace.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return mode == .reference || !token.isEmpty
    }

    private func syncDefaults() {
        // Convenience: derive a sensible secret name from a fresh docker.io entry.
        if registry == "docker.io" && secretName.isEmpty { secretName = "rigel-dockerhub" }
    }

    private func submit() async {
        if mode == .create {
            await viewModel.addManaged(registry: registry, username: username, token: token,
                                       secretName: secretName, namespace: namespace, makeDefault: makeDefault)
        } else {
            await viewModel.addReference(registry: registry, username: username,
                                         secretName: secretName, namespace: namespace, makeDefault: makeDefault)
        }
        if viewModel.errorMessage == nil { onClose() }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
            content()
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.Surface.field)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        }
    }
}
```

- [ ] **Step 4: Wire it into MainWindow**

In `Sources/Rigel/Shell/MainWindow.swift`:
- Add a stored VM near the others (after `settingsVM`, line 27): `@State private var accountsVM: AccountsViewModel`
- In `init()` after `_settingsVM = …` (line 77): `_accountsVM = State(initialValue: AccountsViewModel(context: ""))`
- In `panelView` add a case (next to `.settings`, ~line 600):

```swift
        case .accounts:
            AccountsPanel(viewModel: accountsVM)
```

- In `startPanelViewModels(context:)` (~line 611) add: `accountsVM.load(context: context)`

- [ ] **Step 5: Build + run the existing suite**

Run: `swift build 2>&1 | tail -3 && swift test --filter RegistryAccountTests 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1`
Expected: `Build complete!` and the account tests still pass.

- [ ] **Step 6: Commit**

```bash
git add Sources/Rigel/Panels/Accounts/AccountsPanel.swift Sources/Rigel/Panels/PanelKind.swift Sources/Rigel/Shell/MainWindow.swift
git commit -m "feat(accounts): Accounts panel + nav wiring"
```

---

## Task 7: Bind the default account to installs

**Files:**
- Modify: `Sources/Rigel/Panels/Catalog/CatalogInstallWizardModel.swift` (account selection + ensureAccess in runApply)
- Modify: `Sources/Rigel/Panels/Catalog/CatalogInstallWizard.swift` (pull-credentials control in ConfigureStep)
- Test: add to `Tests/RigelTests/WizardSecretsTests.swift`

- [ ] **Step 1: Write the failing test (append to WizardSecretsTests)**

```swift
    func test_install_defaultsToContextDefaultAccount() {
        let ctx = "wiz-ctx-\(UUID().uuidString)"
        let acct = RegistryAccount(id: UUID(), registry: "docker.io", username: "u",
                                   secretName: "rigel-dockerhub", sourceNamespace: "default",
                                   managed: true, isDefault: true)
        SessionStore.shared.setRegistryAccounts([acct], for: ctx)
        let fit = FitResult(perNode: [], recommended: nil)
        let m = CatalogInstallWizardModel(app: makeApp(), fit: fit, cache: ClusterCache(), context: ctx)
        XCTAssertEqual(m.selectedRegistryAccountID, acct.id, "wizard should preselect the context default account")
        XCTAssertEqual(m.registryAccountOptions.map(\.id), [acct.id])
        SessionStore.shared.setRegistryAccounts([], for: ctx)  // cleanup
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter WizardSecretsTests 2>&1 | tail -20`
Expected: FAIL — `value of type 'CatalogInstallWizardModel' has no member 'selectedRegistryAccountID'`.

- [ ] **Step 3: Add account state to the wizard model**

In `CatalogInstallWizardModel.swift`, add stored state near `secretValues` (~line 173):

```swift
    /// Registry accounts available in this context (for the "Pull credentials"
    /// control). Empty when none are configured.
    var registryAccountOptions: [RegistryAccount] = []
    /// The account whose pull secret will be ensured in the target namespace before
    /// apply. nil = none (no authenticated pulls). Defaults to the context default.
    var selectedRegistryAccountID: UUID? = nil
```

In `init(...)` (after `self.nodePin = initialNodePin`, ~line 209) add:

```swift
        self.registryAccountOptions = SessionStore.shared.registryAccounts(for: context ?? "")
        self.selectedRegistryAccountID = registryAccountOptions.first { $0.isDefault }?.id
```

Add a resolver computed property near `effectiveInstallDescriptor` (~line 119):

```swift
    /// The account selected for this install, if any.
    var selectedRegistryAccount: RegistryAccount? {
        guard let id = selectedRegistryAccountID else { return nil }
        return registryAccountOptions.first { $0.id == id }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter WizardSecretsTests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Run ensureAccess before applying**

In `runApply()` (`CatalogInstallWizardModel.swift` ~line 590), immediately after `applyLog = ""` and before the placeholder substitution, insert:

```swift
        // Ensure registry auth in the target namespace BEFORE applying, so image
        // pulls are authenticated (covers app + bundled Postgres/Redis). No-op when
        // no account is selected. The reconciler never logs the secret payload.
        if let account = selectedRegistryAccount {
            let outcome = await RegistryAccountReconciler(context: context).ensureAccess(account: account, namespace: namespace)
            if case let .failed(msg) = outcome {
                step = .failed("Couldn't set up registry credentials in \(namespace): \(msg)")
                return
            }
        }
```

- [ ] **Step 6: Add the pull-credentials control to ConfigureStep**

In `CatalogInstallWizard.swift`, inside `ConfigureStep`'s `Group { … }` (after the "Node pin" `FieldRow`, ~line 248), add:

```swift
                    if !model.registryAccountOptions.isEmpty {
                        FieldRow(label: "Pull credentials") {
                            Picker("", selection: $model.selectedRegistryAccountID) {
                                Text("None (anonymous pulls)").tag(UUID?.none)
                                ForEach(model.registryAccountOptions) { acct in
                                    Text("\(acct.registry) — \(acct.username)").tag(UUID?.some(acct.id))
                                }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .font(Theme.Font.mono(12))
                            .tint(Theme.Foreground.primary)
                        }
                    }
```

- [ ] **Step 7: Build + full suite**

Run: `swift build 2>&1 | tail -3 && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1`
Expected: `Build complete!` and the full suite passes (0 failures).

- [ ] **Step 8: Commit**

```bash
git add Sources/Rigel/Panels/Catalog/CatalogInstallWizardModel.swift Sources/Rigel/Panels/Catalog/CatalogInstallWizard.swift Tests/RigelTests/WizardSecretsTests.swift
git commit -m "feat(accounts): bind default registry account to catalog installs"
```

---

## Manual verification (end-to-end, requires a reachable cluster)

1. Build and run: `swift run Rigel`.
2. Open **Accounts** (System group) → **Add account** → Create: registry `docker.io`, your Docker Hub username, a personal access token, secret name `rigel-dockerhub`, namespace `default`, "Use as default" on → **Add**. Confirm the row appears with the `default` badge and no error.
3. Verify the cluster Secret exists and the token isn't anywhere local:
   - `kubectl get secret rigel-dockerhub -n default -o jsonpath='{.type}'` → `kubernetes.io/dockerconfigjson`.
   - `grep -r "<your-token>" ~/Library/Application\ Support/com.tyrelchambers.rigel/` → no matches (only metadata persisted).
4. Install **Outline** into a namespace: the Configure step shows "Pull credentials" defaulting to your account. Apply.
5. Confirm authentication wired up:
   - `kubectl get serviceaccount default -n <ns> -o jsonpath='{.imagePullSecrets[*].name}'` includes `rigel-dockerhub`.
   - Pods pull without a 429; `kubectl get pods -n <ns>` reaches Running/Ready.
6. Confirm the secret never leaked into the wizard UI: the Applying/verify logs show kubectl status lines only — no base64 `dockerconfigjson` body.

---

## Self-Review

**Spec coverage:**
- Data model + per-context persistence → Task 1. ✓
- Create-or-reference storage (cluster holds secret; metadata-only local) → Tasks 4 (`create`/`verifyReference`) + 5 (VM). ✓
- `dockerconfigjson` builder + Docker Hub key quirk → Task 2. ✓
- Attachment via ensure-Secret-in-ns + SA union patch → Tasks 3 (pure) + 4 (`ensureAccess`). ✓
- Default account per context, overridable per install → Tasks 1 (`defaultRegistryAccount`), 7 (wizard select). ✓
- Dedicated Accounts panel → Task 6. ✓
- Encryption/exposure: at-rest base64 UI note → Task 6 panel header; no-secret-logging → Task 3/4 doc + `ReconcileOutcome` design (never returns Secret body) + Task 7 comment + manual step 6. ✓
- Backward compat (no accounts → unchanged) → `registryAccountOptions` empty hides the control; ensureAccess skipped when none selected (Task 7); supersede note: with a default account selected it is used; the existing `selfHostDefaults.imagePullSecret` path is untouched when no account is configured. ✓
- Testing items (Codable round-trip, single-default invariant, builder, SA union, secret copy, wizard binding, back-compat) → Tasks 1,2,3,5,7. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**Type consistency:** `RegistryAccount` fields identical across tasks; `ReconcileOutcome` used uniformly; `ensureAccess(account:namespace:)`, `create(registry:username:token:secretName:namespace:)`, `verifyReference(secretName:namespace:)`, `unionImagePullSecrets(existing:adding:)`, `saMergePatch(secretNames:)`, `Secret.copied(toNamespace:)`, `defaultRegistryAccount(for:)`, `selectedRegistryAccount(ID)` all consistent. ✓

**Note on `.command`:** Task 4 uses `WorkloadAction.command(args:label:destructive:)` which exists (`WorkloadAction.swift:445`). If its label/argument names differ at implementation time, adjust the call to match the actual case signature.
