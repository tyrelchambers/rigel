import XCTest
@testable import Helmsman

@MainActor
final class WizardHelmModeTests: XCTestCase {
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

    private func makeModel(install: InstallDescriptor? = nil) -> CatalogInstallWizardModel {
        let fit = FitResult(perNode: [], recommended: nil)
        return CatalogInstallWizardModel(app: makeApp(install: install), fit: fit, cache: ClusterCache(), context: "ctx")
    }

    private func helmDescriptor() -> InstallDescriptor {
        try! JSONDecoder().decode(InstallDescriptor.self, from: Data(#"""
        {"mode":"helm","repoName":"harbor","repoURL":"https://helm.goharbor.io","chart":"harbor"}
        """#.utf8))
    }

    private let manifestFixture = """
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: web
    spec:
      replicas: 2
      template:
        spec:
          containers:
            - name: web
              image: nginx:1.27
    ---
    apiVersion: v1
    kind: Service
    metadata:
      name: web
    spec:
      ports:
        - port: 80
    """

    func test_mode_defaultsToManifestWhenNoInstall() {
        let m = makeModel(install: nil)
        XCTAssertEqual(m.mode, .manifest)
    }

    func test_mode_reflectsHelmDescriptor() {
        let m = makeModel(install: helmDescriptor())
        XCTAssertEqual(m.mode, .helm)
    }

    func test_effectiveDescriptor_setsReleaseNameToInstance() {
        let m = makeModel(install: helmDescriptor())
        m.instance = "harbor-prod"
        let eff = m.effectiveInstallDescriptor
        XCTAssertNotNil(eff)
        XCTAssertEqual(eff?.releaseName, "harbor-prod")
        XCTAssertEqual(eff?.repoName, "harbor")
        XCTAssertEqual(eff?.chart, "harbor")
    }

    func test_effectiveDescriptor_nilWhenNoInstall() {
        let m = makeModel(install: nil)
        XCTAssertNil(m.effectiveInstallDescriptor)
    }

    func test_resourceSummary_manifestMode_parsesManifestYAML() {
        let m = makeModel(install: nil)
        m.manifestYAML = manifestFixture
        let summary = m.resourceSummary
        XCTAssertNotNil(summary)
        XCTAssertEqual(summary?.workloads.count, 1)
        XCTAssertEqual(summary?.services.count, 1)
    }

    func test_resourceSummary_helmMode_nilUntilRendered() {
        let m = makeModel(install: helmDescriptor())
        m.manifestYAML = manifestFixture   // values; ignored in helm mode for summary
        XCTAssertEqual(m.helmRender, .idle)
        XCTAssertNil(m.resourceSummary)
        m.helmRender = .rendering
        XCTAssertNil(m.resourceSummary)
        m.helmRender = .failed("boom")
        XCTAssertNil(m.resourceSummary)
    }

    func test_resourceSummary_helmMode_parsesRenderedYAML() {
        let m = makeModel(install: helmDescriptor())
        m.helmRender = .rendered(manifestFixture)
        let summary = m.resourceSummary
        XCTAssertNotNil(summary)
        XCTAssertEqual(summary?.workloads.count, 1)
        XCTAssertEqual(summary?.services.count, 1)
    }
}
