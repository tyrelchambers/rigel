import XCTest
@testable import Helmsman

@MainActor
final class WizardSecretsTests: XCTestCase {
    private func makeApp(id: String = "demo") -> CatalogApp {
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
            installPromptTemplate: ""
        )
    }

    private func makeModel() -> CatalogInstallWizardModel {
        let fit = FitResult(perNode: [], recommended: nil)
        return CatalogInstallWizardModel(app: makeApp(), fit: fit, cache: ClusterCache(), context: "ctx")
    }

    private func decodeSpec(_ json: String) -> SecretFieldSpec {
        try! JSONDecoder().decode(SecretFieldSpec.self, from: Data(json.utf8))
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

    func test_effectiveSecretName_defaultsToInstance() {
        let m = makeModel()
        XCTAssertEqual(m.effectiveSecretName, "demo-secrets")
        m.secretName = "demo-secrets-2"
        XCTAssertEqual(m.effectiveSecretName, "demo-secrets-2")
    }
}
