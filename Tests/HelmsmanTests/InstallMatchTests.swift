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

    // MARK: - Annotation-first detection (catalog-link-workload)

    func test_annotation_marksDeploymentInstalled_evenWithNoImageMatch() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        // Running image is a private-mirror path that doesn't match foo/foo.
        let d = deployment(image: "registry.internal/mirror/something:1", appAnnotation: "foo")
        let ids = installedAppIDs(apps: apps, deployments: [d], statefulSets: [], pods: [])
        XCTAssertEqual(ids, ["foo"])
    }

    func test_annotation_marksStatefulSetInstalled() {
        let apps = [app(id: "foo", images: ["nope/nope"])]
        let s = statefulSet(image: "mirror/x:1", appAnnotation: "foo")
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: [s], pods: [])
        XCTAssertEqual(ids, ["foo"])
    }

    func test_annotation_marksDaemonSetInstalled() {
        let apps = [app(id: "foo", images: ["nope/nope"])]
        let ds = daemonSet(image: "mirror/x:1", appAnnotation: "foo")
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: [], daemonSets: [ds], pods: [])
        XCTAssertEqual(ids, ["foo"])
    }

    func test_noAnnotation_imageMatchOnDaemonSet() {
        // An app whose image runs ONLY on a DaemonSet is now detected.
        let apps = [app(id: "node-exporter", images: ["prom/node-exporter"])]
        let ds = daemonSet(image: "prom/node-exporter:v1.8.1")
        let ids = installedAppIDs(apps: apps, deployments: [], statefulSets: [], daemonSets: [ds], pods: [])
        XCTAssertEqual(ids, ["node-exporter"])
    }

    func test_annotation_unknownAppID_doesNotCrash() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        let d = deployment(image: "foo/foo:1", appAnnotation: "ghost-app")
        // ghost-app isn't in the catalog; it's added verbatim but corresponds to
        // no card. foo is image-matched. No crash.
        let ids = installedAppIDs(apps: apps, deployments: [d], statefulSets: [], pods: [])
        XCTAssertTrue(ids.contains("foo"))
        XCTAssertTrue(ids.contains("ghost-app"))
    }

    // MARK: - updateTargets (annotation-first, DaemonSets)

    func test_updateTargets_annotationWinsOverImageMatch() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        // One image-matched deployment, plus an annotated statefulset on a
        // mirror image. Annotation wins.
        let imgMatch = deployment(image: "foo/foo:1")
        let bound = statefulSet(image: "mirror/foo:2", appAnnotation: "foo")
        let targets = updateTargets(apps: apps, deployments: [imgMatch], statefulSets: [bound], pods: [])
        XCTAssertEqual(targets.count, 1)
        XCTAssertEqual(targets[0].workloadKind, "statefulset")
        XCTAssertEqual(targets[0].image, "mirror/foo:2")
    }

    func test_updateTargets_daemonsetKind() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        let ds = daemonSet(image: "mirror/foo:2", appAnnotation: "foo")
        let targets = updateTargets(apps: apps, deployments: [], statefulSets: [], daemonSets: [ds], pods: [])
        XCTAssertEqual(targets.first?.workloadKind, "daemonset")
    }

    func test_updateTargets_containerAnnotationSelectsContainer() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        let d = multiContainerDeployment(
            containers: [("side", "busybox:1"), ("main", "foo/foo:1")],
            appAnnotation: "foo", containerAnnotation: "side"
        )
        let targets = updateTargets(apps: apps, deployments: [d], statefulSets: [], pods: [])
        XCTAssertEqual(targets.first?.container, "side")
        XCTAssertEqual(targets.first?.image, "busybox:1")
    }

    func test_updateTargets_multiContainerNoAnnotation_picksMatchImageContainer() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        let d = multiContainerDeployment(
            containers: [("side", "busybox:1"), ("main", "foo/foo:1")],
            appAnnotation: "foo", containerAnnotation: nil
        )
        let targets = updateTargets(apps: apps, deployments: [d], statefulSets: [], pods: [])
        // No container annotation → first matchImage-matching container.
        XCTAssertEqual(targets.first?.container, "main")
        XCTAssertEqual(targets.first?.image, "foo/foo:1")
    }

    func test_updateTargets_singleContainer_noAnnotationNeeded() {
        let apps = [app(id: "foo", images: ["nope/nope"])]
        let d = deployment(image: "mirror/x:1", appAnnotation: "foo")
        let targets = updateTargets(apps: apps, deployments: [d], statefulSets: [], pods: [])
        XCTAssertEqual(targets.first?.container, "c0")
    }

    func test_updateTargets_twoWorkloadsSameAnnotation_deterministicScanOrder() {
        let apps = [app(id: "foo", images: ["foo/foo"])]
        // Both a deployment and a statefulset carry catalog-app=foo. The
        // deployment (earlier in scan order) wins.
        let d = deployment(image: "mirror/d:1", appAnnotation: "foo")
        let s = statefulSet(image: "mirror/s:1", appAnnotation: "foo")
        let targets = updateTargets(apps: apps, deployments: [d], statefulSets: [s], pods: [])
        XCTAssertEqual(targets.count, 1)
        XCTAssertEqual(targets[0].workloadKind, "deployment")
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

    private func podTemplate(containers: [Container]) -> PodTemplate {
        PodTemplate(spec: PodSpec(nodeName: nil, containers: containers))
    }

    private func deployment(image: String, appAnnotation: String? = nil) -> Deployment {
        Deployment(
            metadata: meta("deploy", appAnnotation: appAnnotation),
            spec: DeploymentSpec(
                replicas: 1,
                selector: nil,
                template: podTemplate(containers: [Container(name: "c0", image: image, resources: nil, ports: nil)]),
                strategy: nil,
                paused: nil
            ),
            status: nil
        )
    }

    private func multiContainerDeployment(
        containers: [(name: String, image: String)],
        appAnnotation: String?,
        containerAnnotation: String?
    ) -> Deployment {
        Deployment(
            metadata: meta("deploy", appAnnotation: appAnnotation, containerAnnotation: containerAnnotation),
            spec: DeploymentSpec(
                replicas: 1,
                selector: nil,
                template: podTemplate(containers: containers.map { Container(name: $0.name, image: $0.image, resources: nil, ports: nil) }),
                strategy: nil,
                paused: nil
            ),
            status: nil
        )
    }

    private func statefulSet(image: String, appAnnotation: String? = nil) -> StatefulSet {
        StatefulSet(
            metadata: meta("sts", appAnnotation: appAnnotation),
            spec: StatefulSetSpec(replicas: 1, selector: nil,
                                  template: podTemplate(containers: [Container(name: "c0", image: image, resources: nil, ports: nil)])),
            status: nil
        )
    }

    private func daemonSet(image: String, appAnnotation: String? = nil) -> DaemonSet {
        DaemonSet(
            metadata: meta("ds", appAnnotation: appAnnotation),
            spec: DaemonSet.Spec(selector: nil,
                                 template: podTemplate(containers: [Container(name: "c0", image: image, resources: nil, ports: nil)])),
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

    private func meta(_ prefix: String, appAnnotation: String? = nil, containerAnnotation: String? = nil) -> ObjectMeta {
        var annotations: [String: String] = [:]
        if let appAnnotation { annotations[CATALOG_APP_ANNOTATION] = appAnnotation }
        if let containerAnnotation { annotations[CATALOG_CONTAINER_ANNOTATION] = containerAnnotation }
        return ObjectMeta(
            name: "\(prefix)-\(UUID().uuidString)",
            namespace: "default",
            uid: UUID().uuidString,
            creationTimestamp: nil,
            labels: nil,
            annotations: annotations.isEmpty ? nil : annotations
        )
    }
}
