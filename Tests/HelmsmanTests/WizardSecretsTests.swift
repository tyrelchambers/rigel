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

    func test_regenerate_fillsAStrongValue() {
        let m = makeModel()
        m.placeholders = [ManifestPlaceholder(key: "SECRET_KEY")]
        m.secretValues = ["SECRET_KEY": ""]
        m.regenerateSecret("SECRET_KEY")
        XCTAssertEqual(m.secretValues["SECRET_KEY"]?.count, 32)
    }
}
