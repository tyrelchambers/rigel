# Install-Secrets Collection & Helm-Aware Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a wizard step that collects an app's sensitive values (generating random ones, prompting for user-supplied ones), creates a Kubernetes Secret in the app's namespace, and makes the installed app reference it — including actually running Helm for chart-based apps.

**Architecture:** Claude's Generating output gains two machine-readable fenced blocks (```secrets schema + ```install descriptor) parsed alongside the existing ```yaml. The wizard owns the Secret's values and name (collision-safe, decided before generation and passed to Claude as `{{secretName}}`); Claude only wires the reference. A new `.secrets` pipeline step collects values; the apply step creates the Secret first, then installs via `kubectl apply` (manifest mode) or a new `HelmCommander` (helm mode).

**Tech Stack:** Swift 6 / SwiftPM, SwiftUI, `@Observable`, XCTest. Process exec via existing `runProcess` / `resolveBinary` helpers. Cluster I/O via `kubectl` / `helm` subprocesses.

---

## File structure

**New source files**
- `Sources/Helmsman/Catalog/InstallArtifacts.swift` — `SecretFieldSpec`, `InstallDescriptor`, `WizardArtifacts.parse`.
- `Sources/Helmsman/Catalog/SecretNameResolver.swift` — `SecretNameNote`, `RandomSecret`, `SecretNameResolver`, `NamespaceSecretsProbe`.
- `Sources/Helmsman/Panels/Actions/HelmCommander.swift` — Helm command builder + executor.

**New test files**
- `Tests/HelmsmanTests/InstallArtifactsTests.swift`
- `Tests/HelmsmanTests/SecretNameResolverTests.swift`
- `Tests/HelmsmanTests/HelmCommandTests.swift`
- `Tests/HelmsmanTests/WizardSecretsTests.swift`

**Modified**
- `Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift`
- `Sources/Helmsman/Panels/Catalog/CatalogInstallWizard.swift`

Build: `swift build`. Test: `swift test --filter <TestCaseName>`.

---

## Task 1: Install-artifact types + parser

**Files:**
- Create: `Sources/Helmsman/Catalog/InstallArtifacts.swift`
- Test: `Tests/HelmsmanTests/InstallArtifactsTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// Tests/HelmsmanTests/InstallArtifactsTests.swift
import XCTest
@testable import Helmsman

final class InstallArtifactsTests: XCTestCase {
    func test_parse_extractsYamlSecretsAndInstall() {
        let text = """
        Here you go.

        ```yaml
        apiVersion: apps/v1
        kind: Deployment
        ```

        ```secrets
        [
          {"key": "SECRET_KEY", "label": "Django secret key", "description": "Signing key", "kind": "random", "length": 50},
          {"key": "SMTP_PASSWORD", "label": "SMTP password", "description": "Mail relay", "kind": "user", "required": true}
        ]
        ```

        ```install
        {"mode": "helm", "repoName": "plane", "repoURL": "https://helm.plane.so", "chart": "plane-ce", "version": "1.2.3", "releaseName": "plane"}
        ```
        """
        let r = WizardArtifacts.parse(text)
        XCTAssertTrue(r.yaml?.contains("kind: Deployment") ?? false)
        XCTAssertEqual(r.secrets.count, 2)
        XCTAssertEqual(r.secrets[0].key, "SECRET_KEY")
        XCTAssertEqual(r.secrets[0].kind, .random)
        XCTAssertEqual(r.secrets[0].length, 50)
        XCTAssertEqual(r.secrets[1].kind, .user)
        XCTAssertTrue(r.secrets[1].required)
        XCTAssertEqual(r.install?.mode, .helm)
        XCTAssertEqual(r.install?.chart, "plane-ce")
        XCTAssertEqual(r.install?.releaseName, "plane")
    }

    func test_parse_absentBlocks_yieldEmptyAndNil() {
        let text = "```yaml\nkind: Pod\n```"
        let r = WizardArtifacts.parse(text)
        XCTAssertEqual(r.yaml, "kind: Pod")
        XCTAssertTrue(r.secrets.isEmpty)
        XCTAssertNil(r.install)
    }

    func test_parse_unclosedBlock_isIgnored() {
        // A still-streaming (unterminated) secrets fence must not decode.
        let text = "```secrets\n[ {\"key\": \"X\", \"label\": \"x\", \"kind\": \"random\""
        let r = WizardArtifacts.parse(text)
        XCTAssertTrue(r.secrets.isEmpty)
    }

    func test_secretFieldSpec_defaults() throws {
        let json = #"{"key":"K","label":"L","kind":"user"}"#
        let spec = try JSONDecoder().decode(SecretFieldSpec.self, from: Data(json.utf8))
        XCTAssertTrue(spec.required)            // defaults true
        XCTAssertNil(spec.length)
        XCTAssertNil(spec.description)
    }

    func test_installDescriptor_manifestMode() throws {
        let spec = try JSONDecoder().decode(InstallDescriptor.self, from: Data(#"{"mode":"manifest"}"#.utf8))
        XCTAssertEqual(spec.mode, .manifest)
        XCTAssertNil(spec.chart)
    }
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `swift test --filter InstallArtifactsTests`
Expected: FAIL — `cannot find 'WizardArtifacts'` / `SecretFieldSpec` / `InstallDescriptor`.

- [ ] **Step 3: Implement `InstallArtifacts.swift`**

```swift
// Sources/Helmsman/Catalog/InstallArtifacts.swift
import Foundation

/// One sensitive value the install needs, declared by Claude in a ```secrets
/// block. The wizard collects (or generates) the value and folds all of them
/// into a single Kubernetes Secret the installed app references.
struct SecretFieldSpec: Decodable, Identifiable, Equatable {
    enum Kind: String, Decodable { case random, user }

    let key: String          // Secret data key, must match what the manifest/chart references
    let label: String
    let description: String?
    let kind: Kind
    let length: Int?         // random only; default applied at generation time
    let required: Bool       // user fields gate Continue; defaults true

    var id: String { key }

    private enum CodingKeys: String, CodingKey { case key, label, description, kind, length, required }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        kind = try c.decode(Kind.self, forKey: .kind)
        length = try c.decodeIfPresent(Int.self, forKey: .length)
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? true
    }
}

/// How the app should be installed, declared by Claude in an ```install block.
struct InstallDescriptor: Decodable, Equatable {
    enum Mode: String, Decodable { case manifest, helm }

    let mode: Mode
    let repoName: String?
    let repoURL: String?
    let chart: String?
    let version: String?
    let releaseName: String?
}

/// Extracts the three artifacts Claude emits in the Generating step from one
/// assistant message. Mirrors `SuggestedAction.parse`'s fenced-block handling:
/// only CLOSED fences decode, so half-streamed JSON never decodes mid-write.
enum WizardArtifacts {
    static func parse(_ text: String) -> (yaml: String?, secrets: [SecretFieldSpec], install: InstallDescriptor?) {
        guard text.contains("```") else { return (nil, [], nil) }
        let parts = text.components(separatedBy: "```")
        var lastYAML: String? = nil
        var secrets: [SecretFieldSpec] = []
        var install: InstallDescriptor? = nil
        for (i, part) in parts.enumerated() {
            guard i % 2 == 1 else { continue }      // odd indices are inside a fence
            let isClosed = (i < parts.count - 1)
            guard isClosed else { continue }
            let (lang, body) = splitFence(part)
            switch lang {
            case "yaml", "yml":
                let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { lastYAML = trimmed }
            case "secrets":
                if let arr = try? JSONDecoder().decode([SecretFieldSpec].self, from: Data(body.utf8)) {
                    secrets = arr
                }
            case "install":
                if let one = try? JSONDecoder().decode(InstallDescriptor.self, from: Data(body.utf8)) {
                    install = one
                }
            default:
                break
            }
        }
        return (lastYAML, secrets, install)
    }

    private static func splitFence(_ part: String) -> (lang: String, body: String) {
        guard let nl = part.firstIndex(of: "\n") else {
            return (part.trimmingCharacters(in: .whitespaces).lowercased(), "")
        }
        let lang = part[..<nl].trimmingCharacters(in: .whitespaces).lowercased()
        return (lang, String(part[part.index(after: nl)...]))
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `swift test --filter InstallArtifactsTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Catalog/InstallArtifacts.swift Tests/HelmsmanTests/InstallArtifactsTests.swift
git commit -m "feat(catalog): parse secrets schema + install descriptor from wizard output"
```

---

## Task 2: Random-secret generator, collision resolver, namespace probe

**Files:**
- Create: `Sources/Helmsman/Catalog/SecretNameResolver.swift`
- Test: `Tests/HelmsmanTests/SecretNameResolverTests.swift`

The probe (`NamespaceSecretsProbe`) runs `kubectl` and isn't unit-tested; the pure resolver + generator are.

- [ ] **Step 1: Write the failing tests**

```swift
// Tests/HelmsmanTests/SecretNameResolverTests.swift
import XCTest
@testable import Helmsman

final class SecretNameResolverTests: XCTestCase {
    private func secret(_ name: String, labels: [String: String], data: [String: String] = [:]) -> Secret {
        Secret.draft(name: name, namespace: "default", type: .opaque, decodedData: data, labels: labels)
    }

    func test_freeName_usesBase() {
        let r = SecretNameResolver.resolve(instance: "plane", existing: [])
        XCTAssertEqual(r.name, "plane-secrets")
        XCTAssertEqual(r.note, .fresh)
        XCTAssertTrue(r.prefill.isEmpty)
    }

    func test_ourSecret_isReusedAndPrefilled() {
        let mine = secret("plane-secrets",
                          labels: ["app.kubernetes.io/managed-by": "helmsman",
                                   "app.kubernetes.io/instance": "plane"],
                          data: ["SECRET_KEY": "abc"])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [mine])
        XCTAssertEqual(r.name, "plane-secrets")
        XCTAssertEqual(r.note, .reusing)
        XCTAssertEqual(r.prefill["SECRET_KEY"], "abc")
    }

    func test_unrelatedSecret_isSuffixed() {
        let other = secret("plane-secrets", labels: ["app": "something-else"])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [other])
        XCTAssertEqual(r.name, "plane-secrets-2")
        XCTAssertEqual(r.note, .suffixed(requested: "plane-secrets"))
        XCTAssertTrue(r.prefill.isEmpty)
    }

    func test_multipleUnrelated_findsNextFree() {
        let a = secret("plane-secrets", labels: [:])
        let b = secret("plane-secrets-2", labels: [:])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [a, b])
        XCTAssertEqual(r.name, "plane-secrets-3")
    }

    func test_randomSecret_lengthAndCharset() {
        let v = RandomSecret.generate(length: 40)
        XCTAssertEqual(v.count, 40)
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        XCTAssertTrue(v.allSatisfy { allowed.contains($0) })
    }

    func test_randomSecret_minimumLength() {
        XCTAssertEqual(RandomSecret.generate(length: 0).count, 1)
    }
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `swift test --filter SecretNameResolverTests`
Expected: FAIL — `cannot find 'SecretNameResolver'` / `RandomSecret`.

- [ ] **Step 3: Implement `SecretNameResolver.swift`**

```swift
// Sources/Helmsman/Catalog/SecretNameResolver.swift
import Foundation

/// How the wizard arrived at the Secret name — drives the Secrets-step banner.
enum SecretNameNote: Equatable {
    case fresh                          // base name was free
    case reusing                        // an existing helmsman-managed Secret for this install
    case suffixed(requested: String)    // base name was taken by an unrelated Secret
}

/// Locally-generated strong secret values (passwords, signing keys, access keys).
/// Alphanumeric only, to stay safe inside YAML scalars and shell args.
enum RandomSecret {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    static func generate(length: Int = 32) -> String {
        let n = max(1, length)
        var out = ""
        out.reserveCapacity(n)
        for _ in 0..<n {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }
}

/// Decides the Secret name for an install, keeping it collision-safe and
/// reusing a prior install's Secret when it is clearly ours.
enum SecretNameResolver {
    static let managedByLabel = "app.kubernetes.io/managed-by"
    static let instanceLabel = "app.kubernetes.io/instance"
    static let managedByValue = "helmsman"

    struct Resolution: Equatable {
        let name: String
        let note: SecretNameNote
        let prefill: [String: String]
    }

    /// `existing` = the Secrets currently in the target namespace.
    static func resolve(instance: String, existing: [Secret]) -> Resolution {
        let base = "\(instance)-secrets"
        let byName = Dictionary(existing.map { ($0.metadata.name, $0) }, uniquingKeysWith: { a, _ in a })

        if let mine = byName[base], isOurs(mine, instance: instance) {
            var prefill: [String: String] = [:]
            for k in mine.keysSorted { if let v = mine.decoded(k) { prefill[k] = v } }
            return Resolution(name: base, note: .reusing, prefill: prefill)
        }
        if byName[base] == nil {
            return Resolution(name: base, note: .fresh, prefill: [:])
        }
        // Base taken by an unrelated Secret — find the first free suffix.
        var n = 2
        while byName["\(base)-\(n)"] != nil { n += 1 }
        return Resolution(name: "\(base)-\(n)", note: .suffixed(requested: base), prefill: [:])
    }

    private static func isOurs(_ s: Secret, instance: String) -> Bool {
        let labels = s.metadata.labels ?? [:]
        return labels[managedByLabel] == managedByValue && labels[instanceLabel] == instance
    }
}

/// Best-effort read of the Secrets in a namespace, so the resolver can detect
/// name collisions / reuse. Modeled on `ClusterIssuerLoader`. Any failure
/// (kubectl missing, RBAC, no namespace) yields `[]` — the caller then treats
/// the base name as free.
enum NamespaceSecretsProbe {
    private struct SecretList: Decodable { let items: [Secret] }

    static func load(namespace: String, context: String?) async -> [Secret] {
        guard let kubectl = resolveBinary("kubectl") else { return [] }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["get", "secret", "-n", namespace, "-o", "json"])
        guard let data = try? await runProcess(kubectl, args: args),
              let list = try? JSONDecoder().decode(SecretList.self, from: data) else { return [] }
        return list.items
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `swift test --filter SecretNameResolverTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Catalog/SecretNameResolver.swift Tests/HelmsmanTests/SecretNameResolverTests.swift
git commit -m "feat(catalog): collision-safe secret-name resolver + random generator + namespace probe"
```

---

## Task 3: HelmCommander (command builder + executor)

**Files:**
- Create: `Sources/Helmsman/Panels/Actions/HelmCommander.swift`
- Test: `Tests/HelmsmanTests/HelmCommandTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// Tests/HelmsmanTests/HelmCommandTests.swift
import XCTest
@testable import Helmsman

final class HelmCommandTests: XCTestCase {
    private func helmDescriptor() -> InstallDescriptor {
        try! JSONDecoder().decode(InstallDescriptor.self, from: Data(#"""
        {"mode":"helm","repoName":"plane","repoURL":"https://helm.plane.so","chart":"plane-ce","version":"1.2.3","releaseName":"plane"}
        """#.utf8))
    }

    func test_commands_buildsRepoAddUpdateAndUpgrade() {
        let cmds = HelmCommander.commands(
            descriptor: helmDescriptor(),
            valuesPath: "/tmp/values.yaml",
            namespace: "apps",
            context: "homelab"
        )
        XCTAssertEqual(cmds.count, 3)
        XCTAssertEqual(cmds[0], ["repo", "add", "plane", "https://helm.plane.so"])
        XCTAssertEqual(cmds[1], ["repo", "update", "plane"])
        XCTAssertEqual(cmds[2], [
            "upgrade", "--install", "plane", "plane/plane-ce",
            "--version", "1.2.3",
            "-n", "apps", "--create-namespace",
            "-f", "/tmp/values.yaml",
            "--kube-context", "homelab",
        ])
    }

    func test_commands_omitsContextAndVersionWhenAbsent() {
        let d = try! JSONDecoder().decode(InstallDescriptor.self, from: Data(#"""
        {"mode":"helm","repoName":"r","repoURL":"https://x","chart":"c","releaseName":"rel"}
        """#.utf8))
        let cmds = HelmCommander.commands(descriptor: d, valuesPath: "/tmp/v.yaml", namespace: "default", context: nil)
        XCTAssertFalse(cmds[2].contains("--version"))
        XCTAssertFalse(cmds[2].contains("--kube-context"))
        XCTAssertEqual(cmds[2].first, "upgrade")
    }
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `swift test --filter HelmCommandTests`
Expected: FAIL — `cannot find 'HelmCommander'`.

- [ ] **Step 3: Implement `HelmCommander.swift`**

```swift
// Sources/Helmsman/Panels/Actions/HelmCommander.swift
import Foundation

/// Runs a Helm install for the catalog wizard. The argument vectors are built
/// from the `InstallDescriptor` + wizard-owned namespace/context/values — we
/// never execute Claude's free-form shell. Mirrors `WorkloadCommander`'s shape
/// but resolves the `helm` binary.
struct HelmCommander {
    struct Result {
        let stdout: String
        let stderr: String
        let exitCode: Int32
        var ok: Bool { exitCode == 0 }
    }

    let context: String?

    /// The ordered helm argument vectors (without the `helm` binary itself).
    /// Pure + testable. `repoName`/`repoURL`/`chart`/`releaseName` are required
    /// for helm mode; callers validate before invoking.
    static func commands(descriptor: InstallDescriptor, valuesPath: String, namespace: String, context: String?) -> [[String]] {
        let repoName = descriptor.repoName ?? ""
        let repoURL = descriptor.repoURL ?? ""
        let chart = descriptor.chart ?? ""
        let release = descriptor.releaseName ?? ""

        var upgrade: [String] = ["upgrade", "--install", release, "\(repoName)/\(chart)"]
        if let v = descriptor.version, !v.isEmpty { upgrade.append(contentsOf: ["--version", v]) }
        upgrade.append(contentsOf: ["-n", namespace, "--create-namespace", "-f", valuesPath])
        if let context, !context.isEmpty { upgrade.append(contentsOf: ["--kube-context", context]) }

        return [
            ["repo", "add", repoName, repoURL],
            ["repo", "update", repoName],
            upgrade,
        ]
    }

    /// Write `valuesYAML` to a temp file and run the helm command sequence,
    /// streaming combined stdout. `helm repo add` returning "already exists" is
    /// treated as success.
    func install(descriptor: InstallDescriptor, valuesYAML: String, namespace: String) async -> Result {
        guard let helm = resolveBinary("helm") else {
            return Result(stdout: "", stderr: "helm not found on PATH", exitCode: -1)
        }
        guard descriptor.mode == .helm,
              let repoName = descriptor.repoName, !repoName.isEmpty,
              let chart = descriptor.chart, !chart.isEmpty,
              descriptor.releaseName?.isEmpty == false,
              descriptor.repoURL?.isEmpty == false else {
            return Result(stdout: "", stderr: "incomplete helm install descriptor", exitCode: -1)
        }
        _ = chart

        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("helmsman-values-\(UUID().uuidString).yaml")
        do {
            try valuesYAML.write(to: tmp, atomically: true, encoding: .utf8)
        } catch {
            return Result(stdout: "", stderr: "couldn't write values file: \(error)", exitCode: -1)
        }
        defer { try? FileManager.default.removeItem(at: tmp) }

        var combined = ""
        let cmds = Self.commands(descriptor: descriptor, valuesPath: tmp.path, namespace: namespace, context: context)
        for (i, args) in cmds.enumerated() {
            do {
                let data = try await runProcess(helm, args: args)
                let out = String(data: data, encoding: .utf8) ?? ""
                if !out.isEmpty { combined += (combined.isEmpty ? "" : "\n") + out }
            } catch ProcessError.nonZeroExit(let code, let stderr) {
                // `repo add` (i == 0) is idempotent — an "already exists" failure is fine.
                if i == 0, stderr.localizedCaseInsensitiveContains("already exists") { continue }
                return Result(stdout: combined, stderr: stderr, exitCode: code)
            } catch {
                return Result(stdout: combined, stderr: "\(error)", exitCode: -1)
            }
        }
        return Result(stdout: combined, stderr: "", exitCode: 0)
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `swift test --filter HelmCommandTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Panels/Actions/HelmCommander.swift Tests/HelmsmanTests/HelmCommandTests.swift
git commit -m "feat(catalog): HelmCommander builds + runs helm install from descriptor"
```

---

## Task 4: Wizard model — `.secrets` step, fields, name resolution, gating

**Files:**
- Modify: `Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift`
- Test: `Tests/HelmsmanTests/WizardSecretsTests.swift`

### 4a. `.secrets` step + pipeline index shift

- [ ] **Step 1: Add the step case and renumber `pipelineIndex`**

In `CatalogInstallWizardModel.swift`, edit the `WizardStep` enum:

```swift
enum WizardStep: Hashable {
    case configure
    case generating
    case secrets
    case review
    case applying
    case verifying
    case done
    case failed(String)

    var pipelineIndex: Int {
        switch self {
        case .configure:  return 0
        case .generating: return 1
        case .secrets:    return 2
        case .review:     return 3
        case .applying:   return 4
        case .failed:     return 4
        case .verifying:  return 5
        case .done:       return 6
        }
    }
}
```

### 4b. New stored state + templateVars + artifact parsing

- [ ] **Step 2: Add stored properties**

After the `manifestYAML` declaration (around line 97), add:

```swift
// Collision-safe Secret name, resolved before generating (see resolveSecretName).
var secretName: String = ""
var secretNameNote: SecretNameNote = .fresh
// Schema + install descriptor parsed from the latest completed assistant turn.
var secretSchema: [SecretFieldSpec] = []
var installDescriptor: InstallDescriptor? = nil
// Collected secret values keyed by SecretFieldSpec.key (randoms pre-generated).
var secretValues: [String: String] = [:]
@ObservationIgnored private var secretNameResolved = false
```

- [ ] **Step 3: Add `secretName` to `templateVars`**

In `templateVars`, add the entry (the preamble in Task 5 references `{{secretName}}`):

```swift
"secretName":     secretName.isEmpty ? "\(instance)-secrets" : secretName,
```

- [ ] **Step 4: Parse artifacts on result**

Replace the body of `case .result:` inside `handle(_:)` with:

```swift
case .result:
    isStreaming = false
    if let last = transcript.last, last.role == .assistant {
        let parsed = WizardArtifacts.parse(last.text)
        if let yaml = parsed.yaml { manifestYAML = yaml }
        if let install = parsed.install { installDescriptor = install }
        applySecretSchema(parsed.secrets)
    }
```

Add this helper (folds in newly-declared keys, generating randoms and keeping any
values already collected / prefilled):

```swift
/// Merge a freshly-parsed schema into `secretSchema`, seeding `secretValues`:
/// random keys get a generated value if absent, user keys start empty. Existing
/// values (e.g. prefill from a reused Secret) are preserved.
private func applySecretSchema(_ schema: [SecretFieldSpec]) {
    secretSchema = schema
    for spec in schema where secretValues[spec.key] == nil {
        switch spec.kind {
        case .random: secretValues[spec.key] = RandomSecret.generate(length: spec.length ?? 32)
        case .user:   secretValues[spec.key] = ""
        }
    }
}
```

### 4c. Resolve the Secret name before generating

- [ ] **Step 5: Resolve the name in `advanceFromConfigure`**

Replace `advanceFromConfigure()` with:

```swift
func advanceFromConfigure() {
    guard canAdvanceFromConfigure else { return }
    rememberChosenIssuer()
    step = .generating
    Task { [weak self] in
        await self?.resolveSecretName()
        self?.startGeneratingIfNeeded()
    }
}

/// Probe the namespace and pick a collision-safe Secret name BEFORE the prompt
/// is sent, so `{{secretName}}` in the prompt always matches what we create.
/// Best-effort: probe failure falls back to the base name as `.fresh`.
private func resolveSecretName() async {
    guard !secretNameResolved else { return }
    secretNameResolved = true
    let existing = await NamespaceSecretsProbe.load(namespace: namespace, context: context)
    let res = SecretNameResolver.resolve(instance: instance, existing: existing)
    secretName = res.name
    secretNameNote = res.note
    for (k, v) in res.prefill { secretValues[k] = v }   // reuse-prefill
}
```

(`startGeneratingIfNeeded` already guards on `session == nil`, so it sends the
prompt exactly once, now with `secretName` populated.)

### 4d. Route through `.secrets`; gate + advance

- [ ] **Step 6: Route `useManifest` to `.secrets` when there are keys**

Replace the final `step = .review` line in `useManifest()` with:

```swift
    step = secretSchema.isEmpty ? .review : .secrets
```

- [ ] **Step 7: Add gating + advance for the secrets step**

Add:

```swift
/// All required user-supplied secret fields are filled. Random fields always
/// hold a generated value, so they never block.
var canAdvanceFromSecrets: Bool {
    for spec in secretSchema where spec.kind == .user && spec.required {
        if (secretValues[spec.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return false }
    }
    return true
}

func advanceFromSecrets() {
    guard canAdvanceFromSecrets else { return }
    step = .review
}

/// Regenerate one random field's value (Secrets-step "Regenerate" button).
func regenerateSecret(_ key: String) {
    guard let spec = secretSchema.first(where: { $0.key == key }), spec.kind == .random else { return }
    secretValues[key] = RandomSecret.generate(length: spec.length ?? 32)
}
```

- [ ] **Step 8: Write the model tests**

```swift
// Tests/HelmsmanTests/WizardSecretsTests.swift
import XCTest
@testable import Helmsman

@MainActor
final class WizardSecretsTests: XCTestCase {
    private func makeModel() -> CatalogInstallWizardModel {
        let app = CatalogTestFixtures.app(id: "demo")
        let fit = FitResult(recommended: nil, perNode: [])
        return CatalogInstallWizardModel(app: app, fit: fit, cache: ClusterCache(), context: "ctx")
    }

    func test_pipelineIndex_order() {
        XCTAssertEqual(WizardStep.secrets.pipelineIndex, 2)
        XCTAssertEqual(WizardStep.review.pipelineIndex, 3)
        XCTAssertEqual(WizardStep.done.pipelineIndex, 6)
    }

    func test_gating_requiresUserFields_notRandom() {
        let m = makeModel()
        m.secretSchema = [
            decodeSpec(#"{"key":"R","label":"r","kind":"random"}"#),
            decodeSpec(#"{"key":"U","label":"u","kind":"user","required":true}"#),
        ]
        m.secretValues = ["R": "generated", "U": ""]
        XCTAssertFalse(m.canAdvanceFromSecrets)
        m.secretValues["U"] = "supplied"
        XCTAssertTrue(m.canAdvanceFromSecrets)
    }

    func test_regenerate_changesRandomValue() {
        let m = makeModel()
        m.secretSchema = [decodeSpec(#"{"key":"R","label":"r","kind":"random","length":24}"#)]
        m.secretValues = ["R": ""]
        m.regenerateSecret("R")
        XCTAssertEqual(m.secretValues["R"]?.count, 24)
    }

    private func decodeSpec(_ json: String) -> SecretFieldSpec {
        try! JSONDecoder().decode(SecretFieldSpec.self, from: Data(json.utf8))
    }
}
```

> **Note for implementer:** check whether a catalog `CatalogApp` test fixture
> already exists (search `Tests/HelmsmanTests` for `CatalogApp(` or a
> `CatalogTestFixtures`/`CatalogStoreTests` helper, and `FitResult(` for its
> exact initializer). Reuse it. If none exists, add a minimal
> `CatalogTestFixtures.app(id:)` building a `CatalogApp` with the fields from
> `Sources/Helmsman/Catalog/CatalogApp.swift`, and use the real `FitResult`
> initializer from `Sources/Helmsman/Catalog/NodeFit.swift`. Adjust the
> `ClusterCache()` construction to its real initializer.

- [ ] **Step 9: Run tests, verify pass**

Run: `swift test --filter WizardSecretsTests`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift Tests/HelmsmanTests/WizardSecretsTests.swift
git commit -m "feat(catalog): .secrets wizard step — schema parsing, name resolution, value gating"
```

---

## Task 5: Apply ordering (Secret-first) + Helm branch + verify

**Files:**
- Modify: `Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift`

- [ ] **Step 1: Build the Secret and apply it before the app**

Replace `runApply()` with:

```swift
@MainActor
private func runApply() async {
    applyLog = ""

    // 1. Secret first, so the app's secretKeyRef / existingSecret resolves.
    if !secretSchema.isEmpty {
        let secret = Secret.draft(
            name: secretName.isEmpty ? "\(instance)-secrets" : secretName,
            namespace: namespace,
            type: .opaque,
            decodedData: secretValues,
            labels: [
                SecretNameResolver.managedByLabel: SecretNameResolver.managedByValue,
                SecretNameResolver.instanceLabel: instance,
            ]
        )
        let secretResult = await WorkloadCommander(context: context).run(.applySecret(secret))
        if secretResult.ok {
            applyLog = secretResult.stdout
        } else {
            step = .failed(secretResult.stderr.isEmpty ? "secret apply exited \(secretResult.exitCode)" : secretResult.stderr)
            return
        }
    }

    // 2. Install the app per descriptor (missing descriptor => manifest mode).
    switch installDescriptor?.mode ?? .manifest {
    case .manifest:
        let result = await WorkloadCommander(context: context).run(.applyManifest(yaml: manifestYAML, label: app.id))
        finishApply(ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode)
    case .helm:
        guard let descriptor = installDescriptor else {
            step = .failed("helm install requested but no descriptor was produced")
            return
        }
        let result = await HelmCommander(context: context).install(
            descriptor: descriptor, valuesYAML: manifestYAML, namespace: namespace
        )
        finishApply(ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode)
    }
}

private func finishApply(ok: Bool, stdout: String, stderr: String, exitCode: Int32) {
    if ok {
        applyLog += (applyLog.isEmpty ? "" : "\n") + stdout
        step = .verifying
        startVerifyPoll()
    } else {
        step = .failed(stderr.isEmpty ? "install exited \(exitCode)" : stderr)
    }
}
```

- [ ] **Step 2: Surface the Secret in `verifyResources`**

At the start of the `verifyResources` computed property, after `var rows: [VerifyResource] = []`, add:

```swift
        if !secretSchema.isEmpty {
            rows.append(VerifyResource(kind: "Secret",
                                       name: secretName.isEmpty ? "\(instance)-secrets" : secretName,
                                       state: .applied))
        }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `swift build`
Expected: builds clean (warnings about unused `WorkloadCommander.Result` fields are fine).

- [ ] **Step 4: Run the full wizard test set**

Run: `swift test --filter WizardSecretsTests && swift test --filter HelmCommandTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift
git commit -m "feat(catalog): apply Secret before install; run helm for chart-based apps"
```

---

## Task 6: Prompt contract — Secrets & install section in the preamble

**Files:**
- Modify: `Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift` (`buildInstallPrompt`)

- [ ] **Step 1: Append the contract to the preamble**

In `buildInstallPrompt()`, before the `let preamble = """ ... """` block, build the
contract string, then include it. Replace the `preamble` construction with:

```swift
    let secretsContract = """
    # Secrets & install contract (authoritative — overrides any <FILL_ME_IN> wording in the per-app instructions below)
    - Do NOT inline secret values. Put every sensitive value (passwords, signing keys, API keys, tokens, access keys) into ONE Kubernetes Secret named `\(secretName.isEmpty ? "\(instance)-secrets" : secretName)` in namespace `\(namespace)`. Do NOT emit that Secret resource yourself — the app creates it from values it collects. Only REFERENCE it:
      - Raw manifests: reference each value via `valueFrom.secretKeyRef` with `name: \(secretName.isEmpty ? "\(instance)-secrets" : secretName)` and `key: <the data key>`. Do NOT include the Secret object in your ```yaml.
      - Helm charts: point the chart at this Secret via its existing-secret value (e.g. `existingSecret: \(secretName.isEmpty ? "\(instance)-secrets" : secretName)`); make the Secret's data keys match what the chart expects.
    - After the manifest/values, emit a fenced ```secrets block: a JSON array of the keys to collect. Each item: {"key": "<secret data key>", "label": "<short human label>", "description": "<what it is / where to get it>", "kind": "random" | "user", "length": <int, random only, default 32>, "required": true|false}. Use "random" for values that can be machine-generated (passwords, signing keys, access keys); use "user" for values only the operator knows (OAuth client secrets, SMTP credentials, external API keys, admin email/password). If the app needs no secrets, emit `[]`.
    - Also emit a fenced ```install block describing how to install: a raw manifest => {"mode": "manifest"}; a Helm chart => {"mode": "helm", "repoName": "<repo alias>", "repoURL": "https://...", "chart": "<chart name>", "version": "<x.y.z>", "releaseName": "\(instance)"}.
    """

    let preamble = """
    # Cluster context
    \(lines.joined(separator: "\n"))

    # Node snapshot
    \(nodeSnapshot())

    \(secretsContract)

    """
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add Sources/Helmsman/Panels/Catalog/CatalogInstallWizardModel.swift
git commit -m "feat(catalog): instruct Claude to wire a referenced Secret + emit secrets/install blocks"
```

---

## Task 7: Secrets step UI + step-indicator + footer wiring

**Files:**
- Modify: `Sources/Helmsman/Panels/Catalog/CatalogInstallWizard.swift`

- [ ] **Step 1: Add `.secrets` to the step indicator order + label**

In `StepIndicator`, update `order` (line ~112) and `label(for:)` (line ~150):

```swift
    private let order: [WizardStep] = [.configure, .generating, .secrets, .review, .applying, .verifying, .done]
```

```swift
        case .secrets:    return "secrets"
```

(Add the `case .secrets` line inside `label(for:)` alongside the others.)

- [ ] **Step 2: Route the step view + footer**

In `stepView` (line ~59), add a case before `.review`:

```swift
        case .secrets:
            SecretsStep(model: model)
```

In `footer` (line ~84), add a case:

```swift
            case .secrets:
                TertiaryButton(label: "Back to Claude", action: { model.step = .generating })
                PrimaryButton(label: "Continue", systemImage: "arrow.right", action: model.advanceFromSecrets)
                    .disabled(!model.canAdvanceFromSecrets)
```

- [ ] **Step 3: Implement the `SecretsStep` view**

Add this near the other step views (e.g. after `ReviewStep`):

```swift
// MARK: - Secrets step

private struct SecretsStep: View {
    @Bindable var model: CatalogInstallWizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("Secrets")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
                Text("\(model.secretName) · \(model.namespace)")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }

            banner

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(model.secretSchema) { spec in
                        SecretFieldRow(spec: spec, model: model)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
    }

    @ViewBuilder private var banner: some View {
        switch model.secretNameNote {
        case .fresh:
            EmptyView()
        case .reusing:
            noteText("Updating the existing secret for this install.", systemImage: "arrow.triangle.2.circlepath")
        case .suffixed(let requested):
            noteText("\(requested) is already in use by another resource — creating \(model.secretName) instead.",
                     systemImage: "exclamationmark.triangle")
        }
    }

    private func noteText(_ text: String, systemImage: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage).font(.system(size: 11))
            Text(text).font(Theme.Font.body(11))
        }
        .foregroundStyle(Theme.Foreground.secondary)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct SecretFieldRow: View {
    let spec: SecretFieldSpec
    @Bindable var model: CatalogInstallWizardModel
    @State private var revealed = false

    private var binding: Binding<String> {
        Binding(
            get: { model.secretValues[spec.key] ?? "" },
            set: { model.secretValues[spec.key] = $0 }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(spec.label)
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(spec.kind == .random ? "generated" : (spec.required ? "required" : "optional"))
                    .font(Theme.Font.mono(9))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Spacer()
            }
            if let desc = spec.description, !desc.isEmpty {
                Text(desc)
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            HStack(spacing: 8) {
                Group {
                    if revealed {
                        TextField(spec.kind == .user ? "Enter value" : "", text: binding)
                    } else {
                        SecureField(spec.kind == .user ? "Enter value" : "", text: binding)
                    }
                }
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.Surface.field)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))

                Button { revealed.toggle() } label: {
                    Image(systemName: revealed ? "eye.slash" : "eye")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                .buttonStyle(.plain)
                .help(revealed ? "Hide" : "Reveal")

                if spec.kind == .random {
                    Button { model.regenerateSecret(spec.key) } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Foreground.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Regenerate")
                }
            }
        }
    }
}
```

> **Note for implementer:** confirm the exact `Theme` token names used here
> (`Theme.Surface.field`, `Theme.Border.subtle`, `Theme.Font.mono`, etc.) against
> their use elsewhere in this same file (e.g. `ConfigureStep`/`FieldRow`,
> lines ~170–286) and adjust any that differ. Match the existing field styling
> rather than inventing new tokens.

- [ ] **Step 4: Build + smoke-test the whole package**

Run: `swift build && swift test`
Expected: builds; all tests pass (including the new suites).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Panels/Catalog/CatalogInstallWizard.swift
git commit -m "feat(catalog): Secrets wizard step UI + step-indicator/footer wiring"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** §1 contract → Tasks 1, 6. §2 model state → Task 4. §3 name
  resolution → Task 2 + Task 4c. §4 Secrets UI → Task 7. §5 apply ordering +
  Helm → Tasks 3, 5. §6 error handling → Tasks 3, 5 (`.failed` paths) + approved
  manifest fallback in Task 5 Step 1. §7 testing → Tasks 1–4.
- **Type consistency:** `SecretFieldSpec`, `InstallDescriptor`, `WizardArtifacts`,
  `SecretNameResolver.Resolution`, `SecretNameNote`, `RandomSecret`,
  `NamespaceSecretsProbe`, `HelmCommander` are defined in Tasks 1–3 and used with
  the same signatures in Tasks 4–7. `secretName`/`secretSchema`/`secretValues`/
  `installDescriptor`/`secretNameNote` are introduced in Task 4 and consumed in
  Tasks 5 & 7.
- **Known integration risks to verify while implementing:** (a) real initializers
  for `ClusterCache`, `FitResult`, and `CatalogApp` in the Task 4 test fixture;
  (b) exact `Theme` token names in Task 7; (c) that `ObjectMeta.labels` is the
  property the resolver reads (it is, per `Secret.draft`). These are flagged
  inline as implementer notes.
