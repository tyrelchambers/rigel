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
    func test_manifestNeverGrantsSecretsAccess() {
        let yaml = AssistantInstaller.manifestYAML(config())
        XCTAssertFalse(yaml.lowercased().contains("secrets"))
    }

    func test_secretManifestCarriesTokenButIsSeparate() {
        let secret = AssistantInstaller.secretYAML(token: "sk-test-123")
        XCTAssertTrue(secret.contains("kind: Secret"))
        XCTAssertTrue(secret.contains("sk-test-123"))
        // The token must never appear in the previewable (non-secret) manifest.
        XCTAssertFalse(AssistantInstaller.manifestYAML(config()).contains("sk-test-123"))
    }
}
