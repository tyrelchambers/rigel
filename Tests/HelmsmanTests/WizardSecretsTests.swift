import XCTest
@testable import Helmsman

@MainActor
final class WizardSecretsTests: XCTestCase {
    private func makeApp(id: String = "demo", install: InstallDescriptor? = nil) -> CatalogApp {
        CatalogApp(
            id: id,
            name: "Demo",
            tagline: "",
            description: "",
            category: .other,
            iconSystemName: "cube",
            docsURL: URL(string: "https://example.com")!,
            repoURL: nil,
            homepageURL: nil,
            tags: [],
            matchImages: [],
            requirements: AppRequirements(
                cpuRequest: "100m", cpuLimit: nil,
                memoryRequest: "128Mi", memoryLimit: nil,
                storageGiB: nil
            ),
            persistence: false,
            exposesIngress: false,
            notes: nil,
            installPromptTemplate: "",
            install: install
        )
    }

    private func makeModel(app: CatalogApp? = nil) -> CatalogInstallWizardModel {
        let fit = FitResult(perNode: [], recommended: nil)
        return CatalogInstallWizardModel(app: app ?? makeApp(), fit: fit, cache: ClusterCache(), context: "ctx")
    }

    func test_pipelineIndex_order() {
        XCTAssertEqual(WizardStep.secrets.pipelineIndex, 2)
        XCTAssertEqual(WizardStep.review.pipelineIndex, 3)
        XCTAssertEqual(WizardStep.done.pipelineIndex, 6)
    }

    func test_gating_requiresEveryPlaceholderFilled() {
        let m = makeModel()
        m.placeholders = [ManifestPlaceholder(key: "SECRET_KEY"), ManifestPlaceholder(key: "SMTP_PASSWORD")]
        m.secretValues = ["SECRET_KEY": "generated", "SMTP_PASSWORD": ""]
        XCTAssertFalse(m.canAdvanceFromSecrets)
        m.secretValues["SMTP_PASSWORD"] = "hunter2"
        XCTAssertTrue(m.canAdvanceFromSecrets)
    }

    func test_unfilledPlaceholderKeys_listsOnlyTheBlankOnes() {
        let m = makeModel()
        m.manifestYAML = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: demo-secrets
        stringData:
          JWT_SECRET: <FILL_ME_IN>
          POSTGRES_PASSWORD: <FILL_ME_IN>
          DASHBOARD_USER: <FILL_ME_IN>
        """
        m.placeholders = PlaceholderScanner.scan(m.manifestYAML)
        m.secretValues = ["JWT_SECRET": "filled", "POSTGRES_PASSWORD": "", "DASHBOARD_USER": ""]
        XCTAssertEqual(m.unfilledPlaceholderKeys, ["POSTGRES_PASSWORD", "DASHBOARD_USER"])
    }

    func test_unfilledPlaceholderKeys_emptyWhenAllFilled() {
        let m = makeModel()
        m.manifestYAML = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: demo-secrets
        stringData:
          JWT_SECRET: <FILL_ME_IN>
        """
        m.placeholders = PlaceholderScanner.scan(m.manifestYAML)
        m.secretValues = ["JWT_SECRET": "filled"]
        XCTAssertTrue(m.unfilledPlaceholderKeys.isEmpty)
    }

    func test_maskedManifestYAML_masksFilledLeavesUnfilledAndHidesSecret() {
        let m = makeModel()
        m.manifestYAML = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: demo-secrets
        stringData:
          JWT_SECRET: <FILL_ME_IN>
          POSTGRES_PASSWORD: <FILL_ME_IN>
        """
        m.placeholders = PlaceholderScanner.scan(m.manifestYAML)
        m.secretValues = ["JWT_SECRET": "super-secret-value", "POSTGRES_PASSWORD": ""]
        let masked = m.maskedManifestYAML
        XCTAssertTrue(masked.contains(CatalogInstallWizardModel.secretMask), "filled field should show the mask")
        XCTAssertFalse(masked.contains("super-secret-value"), "the real secret must never appear in the preview")
        XCTAssertTrue(masked.contains("<FILL_ME_IN>"), "unfilled fields keep their marker so they stand out")
        // The actual manifest (what we apply) is untouched.
        XCTAssertTrue(m.manifestYAML.contains("<FILL_ME_IN>"))
    }

    func test_regenerate_fillsAStrongValue() {
        let m = makeModel()
        m.placeholders = [ManifestPlaceholder(key: "SECRET_KEY")]
        m.secretValues = ["SECRET_KEY": ""]
        m.regenerateSecret("SECRET_KEY")
        XCTAssertEqual(m.secretValues["SECRET_KEY"]?.count, 32)
    }

    // The deterministic install path: the secret field list comes from the baked
    // schema, NOT from scraping the manifest. This is the regression guard for the
    // bug where a `value: ""` line and a comment leaked in as fields.
    func test_bakedInstall_secretFieldsFromSchema_notScrape() {
        let specs = [
            SecretFieldSpec(key: "SECRET_KEY", label: "Secret key", kind: .random, length: 64, format: .hex),
            SecretFieldSpec(key: "OIDC_CLIENT_ID", label: "OIDC client ID", kind: .user),
        ]
        // A manifest that ALSO carries the exact traps the old scraper tripped on:
        // a comment containing the marker, and a literal `value: ""` line.
        let manifest = """
        kind: Secret
        stringData:
          # Fill every <FILL_ME_IN> before applying
          SECRET_KEY: <FILL_ME_IN>
          OIDC_CLIENT_ID: <FILL_ME_IN>
          value: ""
        """
        let app = makeApp(install: InstallDescriptor(
            mode: .manifest, repoName: nil, repoURL: nil, chart: nil, version: nil, releaseName: nil,
            manifest: manifest, values: nil, secrets: specs
        ))
        let m = makeModel(app: app)
        XCTAssertTrue(m.app.isBaked)
        m.advanceFromConfigure()

        XCTAssertEqual(m.step, .secrets)
        // Exactly the declared keys — no `value`, no comment line.
        XCTAssertEqual(m.placeholders.map(\.key), ["SECRET_KEY", "OIDC_CLIENT_ID"])
        // random hex field is pre-seeded with a 64-char hex value
        let key = m.secretValues["SECRET_KEY"] ?? ""
        XCTAssertEqual(key.count, 64)
        XCTAssertTrue(key.allSatisfy { "0123456789abcdef".contains($0) }, "SECRET_KEY must be hex")
        // user field starts blank and gates Continue until supplied
        XCTAssertEqual(m.secretValues["OIDC_CLIENT_ID"], "")
        XCTAssertFalse(m.canAdvanceFromSecrets)
        m.secretValues["OIDC_CLIENT_ID"] = "client-abc"
        XCTAssertTrue(m.canAdvanceFromSecrets)
    }

    // A baked entry with no secrets skips straight to Review (no Claude, no Secrets).
    func test_bakedInstall_noSecrets_goesToReview() {
        let app = makeApp(install: InstallDescriptor(
            mode: .manifest, repoName: nil, repoURL: nil, chart: nil, version: nil, releaseName: nil,
            manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{instance}}-cfg\n",
            values: nil, secrets: []
        ))
        let m = makeModel(app: app)
        m.advanceFromConfigure()
        XCTAssertEqual(m.step, .review)
        XCTAssertTrue(m.placeholders.isEmpty)
        XCTAssertTrue(m.manifestYAML.contains("demo-cfg"), "{{instance}} should be substituted into the baked manifest")
    }

    func test_install_defaultsToContextDefaultAccount() {
        let ctx = "wiz-ctx-\(UUID().uuidString)"
        let acct = RegistryAccount(id: UUID(), registry: "docker.io", username: "u",
                                   secretName: "helmsman-dockerhub", sourceNamespace: "default",
                                   managed: true, isDefault: true)
        SessionStore.shared.setRegistryAccounts([acct], for: ctx)
        let fit = FitResult(perNode: [], recommended: nil)
        let m = CatalogInstallWizardModel(app: makeApp(), fit: fit, cache: ClusterCache(), context: ctx)
        XCTAssertEqual(m.selectedRegistryAccountID, acct.id, "wizard should preselect the context default account")
        XCTAssertEqual(m.registryAccountOptions.map(\.id), [acct.id])
        SessionStore.shared.setRegistryAccounts([], for: ctx)  // cleanup
    }
}
