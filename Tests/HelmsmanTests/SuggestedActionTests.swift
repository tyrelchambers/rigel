import XCTest
@testable import Helmsman

final class SuggestedActionTests: XCTestCase {

    // MARK: - Parsing

    func test_parse_singleObject_extractsAndStrips() {
        let text = """
        memos is on the wrong port. I can fix that:
        ```action
        {"label":"Set MEMOS_PORT=5230 & restart memos","kind":"setEnv","deployment":"memos","namespace":"default","env":{"MEMOS_PORT":"5230"}}
        ```
        Want me to go ahead?
        """
        let (display, actions) = SuggestedAction.parse(from: text)
        XCTAssertEqual(actions.count, 1)
        XCTAssertEqual(actions[0].kind, .setEnv)
        XCTAssertEqual(actions[0].label, "Set MEMOS_PORT=5230 & restart memos")
        XCTAssertEqual(actions[0].env?["MEMOS_PORT"], "5230")
        XCTAssertFalse(display.contains("```"))
        XCTAssertFalse(display.contains("MEMOS_PORT"))
        XCTAssertTrue(display.contains("wrong port"))
        XCTAssertTrue(display.contains("Want me to go ahead?"))
    }

    func test_parse_array_extractsMultiple() {
        let text = """
        Two options:
        ```action
        [{"label":"Restart memos","kind":"restart","deployment":"memos"},
         {"label":"Scale memos to 2","kind":"scale","deployment":"memos","replicas":2}]
        ```
        """
        let (_, actions) = SuggestedAction.parse(from: text)
        XCTAssertEqual(actions.count, 2)
        XCTAssertEqual(actions[0].kind, .restart)
        XCTAssertEqual(actions[1].kind, .scale)
        XCTAssertEqual(actions[1].replicas, 2)
    }

    func test_parse_unterminatedFence_isHiddenWithNoActions() {
        // Mid-stream: the action fence hasn't closed yet.
        let text = """
        Here's a fix:
        ```action
        {"label":"Restart memos","kind":"restart","deployment":"memos"
        """
        let (display, actions) = SuggestedAction.parse(from: text)
        XCTAssertTrue(actions.isEmpty)
        XCTAssertFalse(display.contains("Restart memos"))
        XCTAssertTrue(display.contains("Here's a fix"))
    }

    func test_parse_nonActionFence_isLeftIntact() {
        let text = """
        Run this yourself if you prefer:
        ```bash
        kubectl get pods
        ```
        """
        let (display, actions) = SuggestedAction.parse(from: text)
        XCTAssertTrue(actions.isEmpty)
        XCTAssertTrue(display.contains("kubectl get pods"))
        XCTAssertTrue(display.contains("```"))
    }

    // MARK: - Resolution

    func test_resolve_setEnv_buildsSetEnvCommand() {
        let dep = makeDeployment("memos")
        let action = parseOne("""
        {"label":"Set port","kind":"setEnv","deployment":"memos","namespace":"default","env":{"MEMOS_PORT":"5230"}}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: "default")
        XCTAssertTrue(preview.contains("set env deployment/memos -n default MEMOS_PORT=5230"), preview)
    }

    func test_resolve_restart_buildsRestartAction() {
        let dep = makeDeployment("memos")
        let action = parseOne(#"{"label":"Restart","kind":"restart","deployment":"memos"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertEqual(wa.title, "Restart memos")
    }

    func test_resolve_scaleWithoutReplicas_isUnresolved() {
        let dep = makeDeployment("memos")
        let action = parseOne(#"{"label":"Scale","kind":"scale","deployment":"memos"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("replicas"))
    }

    func test_resolve_unknownDeployment_isUnresolved() {
        let action = parseOne(#"{"label":"Restart","kind":"restart","deployment":"ghost","namespace":"default"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("ghost"))
    }

    func test_resolve_deletePod_resolvesByNamespacedName() {
        let pod = makePod("memos-abc", ns: "default")
        let action = parseOne(#"{"label":"Delete pod","kind":"deletePod","pod":"memos-abc","namespace":"default"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [pod], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertEqual(wa.title, "Delete pod memos-abc")
    }

    // MARK: - setImage (app upgrade)

    func test_parse_setImage_decodesImageAndContainer() {
        let action = parseOne("""
        {"label":"Upgrade plausible to v3.2.1","kind":"setImage","deployment":"plausible","namespace":"default","container":"app","image":"ghcr.io/plausible/community-edition:v3.2.1"}
        """)
        XCTAssertEqual(action.kind, .setImage)
        XCTAssertEqual(action.container, "app")
        XCTAssertEqual(action.image, "ghcr.io/plausible/community-edition:v3.2.1")
    }

    func test_resolve_setImage_buildsSetImageCommandForDeployment() {
        let dep = makeDeployment("plausible")
        let action = parseOne("""
        {"label":"Upgrade","kind":"setImage","deployment":"plausible","namespace":"default","container":"app","image":"ghcr.io/plausible/community-edition:v3.2.1"}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: "default")
        XCTAssertTrue(preview.contains("set image deployment/plausible app=ghcr.io/plausible/community-edition:v3.2.1 -n default"), preview)
    }

    func test_resolve_setImage_resolvesStatefulSetWhenNotADeployment() {
        let ss = makeStatefulSet("gitea")
        let action = parseOne("""
        {"label":"Upgrade","kind":"setImage","deployment":"gitea","namespace":"default","container":"gitea","image":"gitea/gitea:1.22"}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], statefulSets: [ss]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("set image statefulset/gitea"), wa.previewCommand(context: nil))
    }

    func test_resolve_setImage_withoutImage_isUnresolved() {
        let dep = makeDeployment("plausible")
        let action = parseOne(#"{"label":"Upgrade","kind":"setImage","deployment":"plausible","container":"app"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("image"), reason)
    }

    // MARK: - Fixtures

    private func parseOne(_ json: String) -> SuggestedAction {
        let (_, actions) = SuggestedAction.parse(from: "```action\n\(json)\n```")
        return actions[0]
    }

    private func makeDeployment(_ name: String, ns: String = "default") -> Deployment {
        Deployment(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: DeploymentSpec(replicas: 1, selector: nil, template: nil, strategy: nil, paused: nil),
            status: nil
        )
    }

    private func makeStatefulSet(_ name: String, ns: String = "default") -> StatefulSet {
        StatefulSet(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: StatefulSetSpec(replicas: 1, selector: nil, template: nil),
            status: nil
        )
    }

    private func makePod(_ name: String, ns: String = "default") -> Pod {
        Pod(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }
}
