import XCTest
@testable import Helmsman

final class CatalogStoreTests: XCTestCase {

    func test_loadCatalog_parsesBundledEntries() {
        // No bundle arg — CatalogStore's default resolves `.module` in the
        // Helmsman target's context (where catalog.json actually lives).
        let store = CatalogStore()
        XCTAssertNil(store.loadError, "catalog.json should load cleanly: \(store.loadError ?? "")")
        XCTAssertGreaterThan(store.apps.count, 0, "expected at least one seeded app")
    }

    func test_filtered_byQuery_isCaseInsensitive() {
        let store = makeStore(apps: [
            sampleApp(id: "vaultwarden", name: "Vaultwarden", tagline: "Password manager", category: .productivity),
            sampleApp(id: "supabase", name: "Supabase", tagline: "Open-source Firebase", category: .database),
        ])
        XCTAssertEqual(store.filtered(query: "VAULT").map(\.id), ["vaultwarden"])
        XCTAssertEqual(store.filtered(query: "supa").map(\.id), ["supabase"])
        XCTAssertEqual(Set(store.filtered(query: "").map(\.id)), ["vaultwarden", "supabase"])
    }

    func test_filtered_byCategoryAndQuery_combined() {
        let store = makeStore(apps: [
            sampleApp(id: "vaultwarden", name: "Vaultwarden", category: .productivity, tags: ["password"]),
            sampleApp(id: "memos", name: "Memos", category: .productivity, tags: ["notes"]),
            sampleApp(id: "supabase", name: "Supabase", category: .database, tags: ["password"]),
        ])
        let result = store.filtered(query: "password", category: .productivity).map(\.id)
        XCTAssertEqual(result, ["vaultwarden"])
    }

    func test_filtered_matchesTagsAndDescription() {
        let store = makeStore(apps: [
            sampleApp(id: "gitea", name: "Gitea", tagline: "Self-hosted git", description: "Code forge with built-in CI runners", tags: ["scm", "git"]),
        ])
        XCTAssertEqual(store.filtered(query: "forge").map(\.id), ["gitea"])
        XCTAssertEqual(store.filtered(query: "scm").map(\.id), ["gitea"])
    }

    func test_categories_areUniqueAndSorted() {
        let store = makeStore(apps: [
            sampleApp(id: "a", category: .productivity),
            sampleApp(id: "b", category: .database),
            sampleApp(id: "c", category: .productivity),
            sampleApp(id: "d", category: .observability),
        ])
        XCTAssertEqual(store.categories, [.database, .observability, .productivity])
    }

    func test_renderPrompt_substitutesPlaceholders() {
        let app = sampleApp(
            id: "vault",
            installPromptTemplate: "Install {{instance}} in {{namespace}} at https://{{hostname}}"
        )
        let rendered = app.renderPrompt(vars: [
            "instance": "vault",
            "namespace": "default",
            "hostname": "vault.example.com",
        ])
        XCTAssertEqual(rendered, "Install vault in default at https://vault.example.com")
    }

    func test_renderPrompt_leavesUnknownPlaceholdersIntact() {
        let app = sampleApp(installPromptTemplate: "x={{instance}} y={{notes}}")
        let rendered = app.renderPrompt(vars: ["instance": "foo"])
        XCTAssertEqual(rendered, "x=foo y={{notes}}", "missing vars must remain as literal placeholders — no silent fallback")
    }

    func test_decode_entryWithHelmInstall_populatesDescriptor() throws {
        let json = """
        {
          "id": "plane", "name": "Plane", "tagline": "PM", "description": "d",
          "category": "productivity", "iconSystemName": "cube",
          "docsURL": "https://example.com/docs", "repoURL": null, "homepageURL": null,
          "tags": [], "matchImages": [],
          "requirements": {"cpuRequest": "100m", "memoryRequest": "128Mi"},
          "persistence": false, "exposesIngress": false, "notes": null,
          "installPromptTemplate": "x",
          "install": {"mode": "helm", "repoName": "plane", "repoURL": "https://helm.plane.so", "chart": "plane-ce", "version": "1.2.3", "releaseName": "plane"}
        }
        """
        let app = try JSONDecoder().decode(CatalogApp.self, from: Data(json.utf8))
        XCTAssertEqual(app.install?.mode, .helm)
        XCTAssertEqual(app.install?.chart, "plane-ce")
        XCTAssertEqual(app.install?.releaseName, "plane")
    }

    func test_bundledOutline_isBaked_andRendersWithoutMarkers() throws {
        let store = CatalogStore()
        let outline = try XCTUnwrap(store.apps.first { $0.id == "outline" }, "outline should be in the catalog")
        XCTAssertTrue(outline.isBaked, "outline is the deterministic-install pilot")
        XCTAssertEqual(outline.install?.mode, .manifest)
        let specs = try XCTUnwrap(outline.install?.secrets)
        XCTAssertEqual(Array(specs.map(\.key).prefix(3)), ["SECRET_KEY", "UTILS_SECRET", "POSTGRES_PASSWORD"])

        // Render with configure-step vars, then fill every declared secret key —
        // exactly what the wizard does. Nothing should remain unresolved.
        let rendered = try XCTUnwrap(outline.renderInstallArtifact(vars: [
            "instance": "wiki", "namespace": "default", "hostname": "wiki.example.com",
            "nodeName": "", "storage": "10",
            "clusterIssuer": "letsencrypt-prod", "redirectMiddleware": "default-redirect-https@kubernetescrd",
        ]))
        let filled = PlaceholderScanner.substitute(rendered, values: Dictionary(uniqueKeysWithValues: specs.map { ($0.key, "x") }))
        XCTAssertFalse(filled.contains("<FILL_ME_IN>"), "all declared secrets must substitute away")
        XCTAssertFalse(filled.contains("{{"), "all template vars must substitute away")
        XCTAssertTrue(filled.contains("wiki.example.com"), "hostname should be substituted")
    }

    func test_decode_entryWithoutInstall_yieldsNilDescriptor() throws {
        let json = """
        {
          "id": "memos", "name": "Memos", "tagline": "notes", "description": "d",
          "category": "productivity", "iconSystemName": "cube",
          "docsURL": "https://example.com/docs", "repoURL": null, "homepageURL": null,
          "tags": [], "matchImages": [],
          "requirements": {"cpuRequest": "100m", "memoryRequest": "128Mi"},
          "persistence": false, "exposesIngress": false, "notes": null,
          "installPromptTemplate": "x"
        }
        """
        let app = try JSONDecoder().decode(CatalogApp.self, from: Data(json.utf8))
        XCTAssertNil(app.install)
    }

    // MARK: - Helpers

    private func makeStore(apps: [CatalogApp]) -> CatalogStore {
        CatalogStore(apps: apps)
    }

    private func sampleApp(
        id: String = "test",
        name: String = "Test App",
        tagline: String = "tagline",
        description: String = "description",
        category: AppCategory = .other,
        tags: [String] = [],
        matchImages: [String] = [],
        installPromptTemplate: String = "prompt"
    ) -> CatalogApp {
        CatalogApp(
            id: id,
            name: name,
            tagline: tagline,
            description: description,
            category: category,
            iconSystemName: "cube",
            docsURL: URL(string: "https://example.com/docs")!,
            repoURL: nil,
            homepageURL: nil,
            tags: tags,
            matchImages: matchImages,
            requirements: AppRequirements(
                cpuRequest: "100m",
                cpuLimit: nil,
                memoryRequest: "128Mi",
                memoryLimit: nil,
                storageGiB: nil
            ),
            persistence: false,
            exposesIngress: false,
            notes: nil,
            installPromptTemplate: installPromptTemplate
        )
    }
}

