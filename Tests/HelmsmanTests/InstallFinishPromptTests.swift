import XCTest
@testable import Helmsman

final class InstallFinishPromptTests: XCTestCase {
    private let scope = InstallScope(namespace: "personal", instance: "plane")

    // MARK: - secret redaction (safety)

    func test_redactSecrets_masksSecretDataButNotOtherDocs() {
        let yaml = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: plane-secrets
        stringData:
          JWT_SECRET: supersecretvalue
          POSTGRES_PASSWORD: hunter2
        ---
        apiVersion: v1
        kind: ConfigMap
        metadata:
          name: plane-vars
        data:
          WEB_URL: https://plane.example.com
        """
        let red = InstallFinishPrompt.redactSecrets(yaml)
        XCTAssertFalse(red.contains("supersecretvalue"), "secret value leaked")
        XCTAssertFalse(red.contains("hunter2"), "secret value leaked")
        XCTAssertTrue(red.contains("JWT_SECRET: ••••redacted••••"))
        // ConfigMap data is NOT a secret and must stay intact.
        XCTAssertTrue(red.contains("WEB_URL: https://plane.example.com"))
    }

    func test_redactSecrets_dedentEndsSecretBlock() {
        // A non-Secret value after the Secret doc's data block stays intact.
        let yaml = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: s
        stringData:
          KEY: secrethere
        ---
        apiVersion: apps/v1
        kind: Deployment
        spec:
          replicas: 1
        """
        let red = InstallFinishPrompt.redactSecrets(yaml)
        XCTAssertFalse(red.contains("secrethere"))
        XCTAssertTrue(red.contains("replicas: 1"))
    }

    // MARK: - prompt assembly

    func test_build_includesScopeDoneBoundaryAndState() {
        let (prompt, breadcrumb) = InstallFinishPrompt.build(
            appName: "Plane", scope: scope, hostname: "plane.example.com",
            exposesIngress: true,
            manifestYAML: "kind: Secret\nstringData:\n  K: leaky\n",
            pods: [
                InstallPodState(name: "plane-web", phase: "Running", ready: true, restarts: 0, reason: nil),
                InstallPodState(name: "plane-live", phase: "Running", ready: false, restarts: 4, reason: "CrashLoopBackOff"),
            ],
            events: ["Unhealthy plane-live: readiness probe failed"],
            failingLogs: [(pod: "plane-live", tail: "LIVE_SERVER_SECRET_KEY: Required")],
            notes: "Multi-service."
        )
        XCTAssertTrue(prompt.contains("namespace `personal`"))
        XCTAssertTrue(prompt.contains("instance `plane`"))
        XCTAssertTrue(prompt.contains("TLS cert has issued"))          // done criteria (ingress)
        XCTAssertTrue(prompt.contains("never touch neighbours"))       // scope fence
        XCTAssertTrue(prompt.contains("plane-live"))                    // failing pod surfaced
        XCTAssertTrue(prompt.contains("LIVE_SERVER_SECRET_KEY"))        // failing log surfaced
        XCTAssertFalse(prompt.contains("leaky"), "manifest secret leaked into prompt")
        XCTAssertTrue(breadcrumb.contains("Finishing Plane"))
        XCTAssertTrue(breadcrumb.contains("1 component"))               // one unhealthy pod
    }

    func test_build_nonIngressApp_omitsCertCriterion() {
        let (prompt, _) = InstallFinishPrompt.build(
            appName: "Adminer", scope: InstallScope(namespace: "default", instance: "adminer"),
            hostname: "adminer.example.com", exposesIngress: false,
            manifestYAML: "kind: Deployment\n", pods: [], events: [], failingLogs: [], notes: ""
        )
        XCTAssertFalse(prompt.contains("TLS cert"))
        XCTAssertTrue(prompt.contains("answers on its Service"))
    }
}
