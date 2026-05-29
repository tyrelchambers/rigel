import XCTest
@testable import Helmsman

final class AssistantInstallerTests: XCTestCase {
    private func config() -> AssistantInstallConfig {
        AssistantInstallConfig(
            image: "ghcr.io/acme/helmsman-assistant:latest",
            namespaces: "",
            workerModel: "claude-sonnet-4-6",
            supervisorModel: "claude-opus-4-8",
            spendCapUsd: 50,
            pollIntervalMs: 30000,
            maxPerResourcePerHour: 3,
            maxPerNight: 20,
            maxAttemptsPerIncident: 3,
            confirmPolls: 2
        )
    }

    func test_manifestContainsCoreObjects() {
        let yaml = AssistantInstaller.manifestYAML(config())
        XCTAssertTrue(yaml.contains("kind: ServiceAccount"))
        XCTAssertTrue(yaml.contains("kind: ClusterRole"))
        XCTAssertTrue(yaml.contains("kind: ClusterRoleBinding"))
        XCTAssertTrue(yaml.contains("kind: Deployment"))
        XCTAssertTrue(yaml.contains("kind: ConfigMap"))
    }

    func test_manifestSubstitutesImageAndKnobs() {
        let yaml = AssistantInstaller.manifestYAML(config())
        XCTAssertTrue(yaml.contains("ghcr.io/acme/helmsman-assistant:latest"))
        XCTAssertTrue(yaml.contains("claude-sonnet-4-6"))
        XCTAssertTrue(yaml.contains("claude-opus-4-8"))
    }

    func test_killSwitchStartsEnabled() {
        let yaml = AssistantInstaller.manifestYAML(config())
        XCTAssertTrue(yaml.contains("enabled: \"true\""))
    }

    /// The RBAC cage invariant: the agent's permissions never reference secrets,
    /// so it can neither read nor mutate them. If this ever fails, the cage leaks.
    /// (imagePullSecrets is a legitimate, unrelated use of the word — strip it
    /// before checking so the invariant stays about RBAC.)
    func test_manifestNeverGrantsSecretsAccess() {
        var cfg = config()
        cfg.imagePullSecretName = "ghcr-pull"
        let yaml = AssistantInstaller.manifestYAML(cfg)
            .replacingOccurrences(of: "imagePullSecrets", with: "")
        XCTAssertFalse(yaml.lowercased().contains("secrets"))
    }

    func test_deploymentReferencesImagePullSecretWhenSet() {
        var cfg = config()
        cfg.imagePullSecretName = "ghcr-pull"
        let yaml = AssistantInstaller.manifestYAML(cfg)
        XCTAssertTrue(yaml.contains("imagePullSecrets"))
        XCTAssertTrue(yaml.contains("ghcr-pull"))
    }

    func test_noImagePullSecretWhenUnset() {
        let yaml = AssistantInstaller.manifestYAML(config()) // imagePullSecretName == ""
        XCTAssertFalse(yaml.contains("imagePullSecrets"))
    }

    /// Regression: imagePullSecrets must sit at the same 6-space indent as its
    /// sibling serviceAccountName under template.spec. A 14-space indent (the
    /// original bug) produced "mapping values are not allowed in this context".
    func test_imagePullSecretIndentationMatchesServiceAccountName() {
        var cfg = config()
        cfg.imagePullSecretName = "ghcr-pull"
        let yaml = AssistantInstaller.manifestYAML(cfg)
        XCTAssertTrue(yaml.contains("\n      imagePullSecrets:\n        - name: ghcr-pull"))
        XCTAssertFalse(yaml.contains("\n              imagePullSecrets:"))
    }

    func test_dockerConfigSecretEncodesAuth() {
        let yaml = AssistantInstaller.dockerConfigSecretYAML(
            name: "ghcr-pull", registry: "ghcr.io", username: "u", token: "t"
        )
        XCTAssertTrue(yaml.contains("kind: Secret"))
        XCTAssertTrue(yaml.contains("kubernetes.io/dockerconfigjson"))
        XCTAssertTrue(yaml.contains("ghcr.io"))
        let expectedAuth = Data("u:t".utf8).base64EncodedString()
        XCTAssertTrue(yaml.contains(expectedAuth))
    }

    func test_secretManifestCarriesTokenButIsSeparate() {
        let secret = AssistantInstaller.secretYAML(token: "sk-test-123")
        XCTAssertTrue(secret.contains("kind: Secret"))
        XCTAssertTrue(secret.contains("sk-test-123"))
        // The token must never appear in the previewable (non-secret) manifest.
        XCTAssertFalse(AssistantInstaller.manifestYAML(config()).contains("sk-test-123"))
    }
}
