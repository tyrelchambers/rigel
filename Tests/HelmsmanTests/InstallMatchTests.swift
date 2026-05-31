import XCTest
@testable import Helmsman

final class InstallMatchTests: XCTestCase {

    // MARK: - imageRepoPath normalization

    func test_imageRepoPath_stripsTag() {
        XCTAssertEqual(imageRepoPath("vaultwarden/server:latest"), "vaultwarden/server")
    }

    func test_imageRepoPath_stripsDigest() {
        XCTAssertEqual(imageRepoPath("vaultwarden/server@sha256:abc123"), "vaultwarden/server")
    }

    func test_imageRepoPath_stripsTagAndDigest() {
        XCTAssertEqual(imageRepoPath("ghcr.io/plausible/community-edition:v2.1.4@sha256:deadbeef"),
                       "ghcr.io/plausible/community-edition")
    }

    func test_imageRepoPath_keepsRegistryHostAndPort() {
        // The `:5000` here is a host port, not a tag — must be preserved.
        XCTAssertEqual(imageRepoPath("localhost:5000/team/app:v1"), "localhost:5000/team/app")
    }

    func test_imageRepoPath_singleNameImage() {
        XCTAssertEqual(imageRepoPath("nextcloud:29-apache"), "nextcloud")
    }

    // MARK: - installedAppIDs detection

    func test_emptyCluster_detectsNothing() {
        let apps = [app(id: "vaultwarden", images: ["vaultwarden/server"])]
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: [], pods: [])
        XCTAssertTrue(ids.isEmpty)
    }

    func test_matchesDeploymentImage_tagInsensitive() {
        let apps = [app(id: "vaultwarden", images: ["vaultwarden/server"])]
        let deploys = [deployment(image: "vaultwarden/server:1.30.1")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["vaultwarden"])
    }

    func test_matchesAcrossRegistryHost() {
        // Catalog stores the bare path; the running image carries a registry host.
        let apps = [app(id: "vaultwarden", images: ["vaultwarden/server"])]
        let deploys = [deployment(image: "docker.io/vaultwarden/server:latest")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["vaultwarden"])
    }

    func test_matchesWhenCatalogCarriesHostButRunningDoesNot() {
        let apps = [app(id: "plausible", images: ["ghcr.io/plausible/community-edition"])]
        let deploys = [deployment(image: "plausible/community-edition:v2.1.4")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["plausible"])
    }

    func test_matchesStatefulSetImage() {
        let apps = [app(id: "gitea", images: ["gitea/gitea"])]
        let sts = [statefulSet(image: "gitea/gitea:1.22")]
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: sts, pods: [])
        XCTAssertEqual(ids, ["gitea"])
    }

    func test_matchesLoosePodImage() {
        let apps = [app(id: "memos", images: ["neosmemo/memos"])]
        let pods = [pod(image: "neosmemo/memos:0.22")]
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: [], pods: pods)
        XCTAssertEqual(ids, ["memos"])
    }

    func test_anyMatchImageCountsAsInstalled() {
        // Multi-service app; only one of its distinctive images is running.
        let apps = [app(id: "supabase", images: ["supabase/studio", "supabase/postgres"])]
        let deploys = [deployment(image: "supabase/postgres:15.1.0.147")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["supabase"])
    }

    func test_sharedDependencyDoesNotFalseMatch() {
        // A bare `postgres` running must NOT mark an app installed — catalog
        // entries deliberately key off their OWN image, not shared deps.
        let apps = [
            app(id: "plausible", images: ["plausible/community-edition"]),
            app(id: "nextcloud", images: ["nextcloud"]),
        ]
        let deploys = [deployment(image: "postgres:16-alpine")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertTrue(ids.isEmpty)
    }

    func test_namespacedCandidateDoesNotMatchBareSharedImage() {
        // Regression: `supabase/postgres` must NOT match a standalone `postgres`
        // (an org/namespace segment is not a registry host).
        let apps = [app(id: "supabase", images: ["supabase/studio", "supabase/postgres"])]
        let deploys = [deployment(image: "postgres:16-alpine")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertTrue(ids.isEmpty)
    }

    func test_namespacedCandidateStillMatchesItsOwnImage() {
        let apps = [app(id: "supabase", images: ["supabase/studio", "supabase/postgres"])]
        let deploys = [deployment(image: "supabase/postgres:15.1.0.147")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["supabase"])
    }

    func test_matchesAcrossCustomRegistryHost() {
        // n8n is pulled from docker.n8n.io in some installs.
        let apps = [app(id: "n8n", images: ["n8nio/n8n"])]
        let deploys = [deployment(image: "docker.n8n.io/n8nio/n8n:1.70.0")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["n8n"])
    }

    func test_detectsMultipleAppsAcrossSources() {
        let apps = [
            app(id: "vaultwarden", images: ["vaultwarden/server"]),
            app(id: "gitea", images: ["gitea/gitea"]),
            app(id: "uptime-kuma", images: ["louislam/uptime-kuma"]),
        ]
        let ids = installedAppIDs(
            apps: apps,
            deployments: [deployment(image: "vaultwarden/server:latest")],
            statefulSets: [statefulSet(image: "gitea/gitea:1.22")],
            pods: [pod(image: "louislam/uptime-kuma:1")]
        )
        XCTAssertEqual(ids, ["vaultwarden", "gitea", "uptime-kuma"])
    }

    func test_singleNameImageDoesNotSuffixMatchUnrelated() {
        // `nextcloud` must not match `something/nextcloud-exporter`.
        let apps = [app(id: "nextcloud", images: ["nextcloud"])]
        let deploys = [deployment(image: "prom/nextcloud-exporter:latest")]
        let ids = installedAppIDs(apps: apps, deployments: deploys, statefulSets: [], pods: [])
        XCTAssertTrue(ids.isEmpty)
    }

    // MARK: - installedImages (running image per app)

    func test_installedImages_returnsFullRunningRef() {
        let apps = [
            app(id: "gitea", images: ["gitea/gitea"]),
            app(id: "plausible", images: ["plausible/community-edition"]),
            app(id: "absent", images: ["nobody/here"]),
        ]
        let images = installedImages(
            apps: apps,
            deployments: [deployment(image: "ghcr.io/plausible/community-edition:v2.1.4")],
            statefulSets: [statefulSet(image: "gitea/gitea:1.22")],
            pods: []
        )
        let byID = Dictionary(uniqueKeysWithValues: images.map { ($0.appID, $0.image) })
        XCTAssertEqual(byID["gitea"], "gitea/gitea:1.22")
        XCTAssertEqual(byID["plausible"], "ghcr.io/plausible/community-edition:v2.1.4")
        XCTAssertNil(byID["absent"])   // not running -> omitted
    }

    func test_installedImages_carriesRepoURL() {
        let apps = [app(id: "gitea", images: ["gitea/gitea"],
                        repoURL: URL(string: "https://github.com/go-gitea/gitea")!)]
        let images = installedImages(
            apps: apps,
            deployments: [],
            statefulSets: [statefulSet(image: "gitea/gitea:1.22")],
            pods: []
        )
        XCTAssertEqual(images.first?.repoURL,
                       URL(string: "https://github.com/go-gitea/gitea")!)
    }

    // MARK: - Fixture builders

    private func app(id: String, images: [String], repoURL: URL? = nil) -> CatalogApp {
        CatalogApp(
            id: id,
            name: id,
            tagline: "",
            description: "",
            category: .other,
            iconSystemName: "cube",
            docsURL: URL(string: "https://example.com")!,
            repoURL: repoURL,
            homepageURL: nil,
            tags: [],
            matchImages: images,
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
            installPromptTemplate: ""
        )
    }

    private func podTemplate(image: String) -> PodTemplate {
        PodTemplate(
            spec: PodSpec(
                nodeName: nil,
                containers: [Container(name: "c0", image: image, resources: nil, ports: nil)]
            )
        )
    }

    private func deployment(image: String) -> Deployment {
        Deployment(
            metadata: meta("deploy"),
            spec: DeploymentSpec(
                replicas: 1,
                selector: nil,
                template: podTemplate(image: image),
                strategy: nil,
                paused: nil
            ),
            status: nil
        )
    }

    private func statefulSet(image: String) -> StatefulSet {
        StatefulSet(
            metadata: meta("sts"),
            spec: StatefulSetSpec(replicas: 1, selector: nil, template: podTemplate(image: image)),
            status: nil
        )
    }

    private func pod(image: String) -> Pod {
        Pod(
            metadata: meta("pod"),
            spec: PodSpec(
                nodeName: nil,
                containers: [Container(name: "c0", image: image, resources: nil, ports: nil)]
            ),
            status: nil
        )
    }

    private func meta(_ prefix: String) -> ObjectMeta {
        ObjectMeta(
            name: "\(prefix)-\(UUID().uuidString)",
            namespace: "default",
            uid: UUID().uuidString,
            creationTimestamp: nil,
            labels: nil,
            annotations: nil
        )
    }
}
