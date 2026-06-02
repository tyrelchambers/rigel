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
        let (display, actions, _) = SuggestedAction.parse(from: text)
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
        let (_, actions, _) = SuggestedAction.parse(from: text)
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
        let (display, actions, _) = SuggestedAction.parse(from: text)
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
        let (display, actions, _) = SuggestedAction.parse(from: text)
        XCTAssertTrue(actions.isEmpty)
        XCTAssertTrue(display.contains("kubectl get pods"))
        XCTAssertTrue(display.contains("```"))
    }

    // MARK: - Clarifying questions

    func test_parse_question_extractsAndStrips() {
        let text = """
        I need to know how to proceed.
        ```question
        {"question":"How should I proceed with the cleanup?","options":[{"label":"Both A and B","value":"Do both"},{"label":"Just A"},{"label":"Hold off"}]}
        ```
        """
        let (display, actions, questions) = SuggestedAction.parse(from: text)
        XCTAssertTrue(actions.isEmpty)
        XCTAssertEqual(questions.count, 1)
        XCTAssertEqual(questions[0].question, "How should I proceed with the cleanup?")
        XCTAssertEqual(questions[0].options.count, 3)
        // value present → sent verbatim; absent → falls back to the label.
        XCTAssertEqual(questions[0].options[0].answer, "Do both")
        XCTAssertEqual(questions[0].options[1].answer, "Just A")
        XCTAssertFalse(display.contains("```"))
        XCTAssertFalse(display.contains("Hold off"))
        XCTAssertTrue(display.contains("how to proceed"))
    }

    func test_parse_unterminatedQuestionFence_isHiddenWithNoQuestions() {
        let text = """
        Let me ask:
        ```question
        {"question":"Pick one","options":[{"label":"A"
        """
        let (display, _, questions) = SuggestedAction.parse(from: text)
        XCTAssertTrue(questions.isEmpty)
        XCTAssertFalse(display.contains("Pick one"))
        XCTAssertTrue(display.contains("Let me ask"))
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

    // MARK: - setResources (right-sizing)

    func test_parse_setResources_decodesRequestsAndLimits() {
        let action = parseOne("""
        {"label":"Right-size web","kind":"setResources","deployment":"web","namespace":"default","container":"web","requests":"cpu=250m,memory=512Mi","limits":"cpu=500m,memory=1Gi"}
        """)
        XCTAssertEqual(action.kind, .setResources)
        XCTAssertEqual(action.container, "web")
        XCTAssertEqual(action.requests, "cpu=250m,memory=512Mi")
        XCTAssertEqual(action.limits, "cpu=500m,memory=1Gi")
    }

    func test_resolve_setResources_buildsSetResourcesCommandForDeployment() {
        let dep = makeDeployment("web")
        let action = parseOne("""
        {"label":"Right-size","kind":"setResources","deployment":"web","namespace":"default","container":"web","requests":"cpu=250m,memory=512Mi","limits":"cpu=500m,memory=1Gi"}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: "default")
        XCTAssertTrue(preview.contains("set resources deployment/web -c web"), preview)
        XCTAssertTrue(preview.contains("--requests=cpu=250m,memory=512Mi"), preview)
        XCTAssertTrue(preview.contains("--limits=cpu=500m,memory=1Gi"), preview)
    }

    func test_resolve_setResources_resolvesStatefulSetWhenNotADeployment() {
        let ss = makeStatefulSet("gitea")
        let action = parseOne("""
        {"label":"Right-size","kind":"setResources","deployment":"gitea","namespace":"default","container":"gitea","requests":"cpu=100m,memory=256Mi"}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], statefulSets: [ss]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("set resources statefulset/gitea"), wa.previewCommand(context: nil))
    }

    func test_resolve_setResources_resolvesDaemonSet() {
        let ds = makeDaemonSet("fluentd")
        let action = parseOne("""
        {"label":"Right-size","kind":"setResources","deployment":"fluentd","namespace":"default","container":"fluentd","limits":"memory=512Mi"}
        """)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], statefulSets: [], daemonSets: [ds]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("set resources daemonset/fluentd"), wa.previewCommand(context: nil))
    }

    func test_resolve_setResources_withoutRequestsOrLimits_isUnresolved() {
        let dep = makeDeployment("web")
        let action = parseOne(#"{"label":"Right-size","kind":"setResources","deployment":"web","container":"web"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("requests") || reason.contains("limits"), reason)
    }

    // MARK: - Node & rollout remediation

    func test_resolve_drain_buildsDrainCommand() {
        let node = makeNode("node-1")
        let action = parseOne(#"{"label":"Drain","kind":"drain","node":"node-1"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [node]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("drain node-1"), wa.previewCommand(context: nil))
    }

    func test_resolve_drain_unknownNode_isUnresolved() {
        let action = parseOne(#"{"label":"Drain","kind":"drain","node":"ghost"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("ghost"), reason)
    }

    func test_resolve_pause_buildsPauseRollout() {
        let dep = makeDeployment("web")
        let action = parseOne(#"{"label":"Pause","kind":"pause","name":"web"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("rollout pause deployment/web"), wa.previewCommand(context: nil))
    }

    func test_resolve_resume_buildsResumeRollout() {
        let dep = makeDeployment("web")
        let action = parseOne(#"{"label":"Resume","kind":"resume","name":"web"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("rollout resume deployment/web"), wa.previewCommand(context: nil))
    }

    // MARK: - Broadened restart / scale

    func test_resolve_restart_statefulset_usesGenericRestart() {
        let ss = makeStatefulSet("gitea")
        let action = parseOne(#"{"label":"Restart","kind":"restart","name":"gitea"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], statefulSets: [ss]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("rollout restart statefulset/gitea"), wa.previewCommand(context: nil))
    }

    func test_resolve_restart_daemonset_usesGenericRestart() {
        let ds = makeDaemonSet("fluentd")
        let action = parseOne(#"{"label":"Restart","kind":"restart","name":"fluentd"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], daemonSets: [ds]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("rollout restart daemonset/fluentd"), wa.previewCommand(context: nil))
    }

    func test_resolve_scale_statefulset_usesGenericScale() {
        let ss = makeStatefulSet("gitea")
        let action = parseOne(#"{"label":"Scale","kind":"scale","name":"gitea","replicas":3}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], statefulSets: [ss]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("scale statefulset/gitea --replicas=3"), wa.previewCommand(context: nil))
    }

    func test_resolve_scale_daemonset_isUnresolved() {
        let ds = makeDaemonSet("fluentd")
        let action = parseOne(#"{"label":"Scale","kind":"scale","name":"fluentd","replicas":3}"#)
        guard case .unresolved = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], daemonSets: [ds]) else {
            return XCTFail("expected unresolved — daemonsets don't scale by replicas")
        }
    }

    // MARK: - CronJob ops

    func test_resolve_suspendCronJob_buildsPatch() {
        let cj = makeCronJob("backup")
        let action = parseOne(#"{"label":"Suspend","kind":"suspendCronJob","name":"backup"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], cronJobs: [cj]) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: nil)
        XCTAssertTrue(preview.contains("patch cronjob backup"), preview)
        XCTAssertTrue(preview.contains("suspend"), preview)
    }

    func test_resolve_triggerCronJob_buildsCreateJobFromCronJob() {
        let cj = makeCronJob("backup")
        let action = parseOne(#"{"label":"Run now","kind":"triggerCronJob","name":"backup"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], cronJobs: [cj]) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: nil)
        XCTAssertTrue(preview.contains("create job"), preview)
        XCTAssertTrue(preview.contains("--from=cronjob/backup"), preview)
    }

    func test_resolve_triggerCronJob_unknown_isUnresolved() {
        let action = parseOne(#"{"label":"Run now","kind":"triggerCronJob","name":"ghost"}"#)
        guard case .unresolved = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
    }

    // MARK: - deleteWorkload

    func test_resolve_deleteWorkload_job() {
        let job = makeJob("migrate")
        let action = parseOne(#"{"label":"Delete","kind":"deleteWorkload","name":"migrate","namespace":"default"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], jobs: [job]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("delete job migrate"), wa.previewCommand(context: nil))
    }

    func test_resolve_deleteWorkload_deployment() {
        let dep = makeDeployment("web")
        let action = parseOne(#"{"label":"Delete","kind":"deleteWorkload","name":"web"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [dep], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("delete deployment web"), wa.previewCommand(context: nil))
    }

    // MARK: - Namespace lifecycle

    func test_resolve_createNamespace_whenAbsent() {
        let action = parseOne(#"{"label":"Create","kind":"createNamespace","name":"staging"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("create namespace staging"), wa.previewCommand(context: nil))
    }

    func test_resolve_createNamespace_whenPresent_isUnresolved() {
        let ns = makeNamespace("staging")
        let action = parseOne(#"{"label":"Create","kind":"createNamespace","name":"staging"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], namespaces: [ns]) else {
            return XCTFail("expected unresolved — already exists")
        }
        XCTAssertTrue(reason.contains("staging"), reason)
    }

    func test_resolve_deleteNamespace_whenPresent() {
        let ns = makeNamespace("staging")
        let action = parseOne(#"{"label":"Delete","kind":"deleteNamespace","name":"staging"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: [], namespaces: [ns]) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("delete namespace staging"), wa.previewCommand(context: nil))
    }

    func test_resolve_deleteNamespace_whenAbsent_isUnresolved() {
        let action = parseOne(#"{"label":"Delete","kind":"deleteNamespace","name":"ghost"}"#)
        guard case .unresolved = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
    }

    // MARK: - deleteResource (generic cleanup)

    func test_resolve_deleteResource_service() {
        let action = parseOne(#"{"label":"Delete svc","kind":"deleteResource","resourceKind":"service","name":"api","namespace":"default"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        XCTAssertTrue(wa.previewCommand(context: nil).contains("delete service api -n default"), wa.previewCommand(context: nil))
    }

    func test_resolve_deleteResource_clusterRole_isClusterScoped() {
        let action = parseOne(#"{"label":"Delete cr","kind":"deleteResource","resourceKind":"clusterrole","name":"admin"}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected a resolved action")
        }
        let preview = wa.previewCommand(context: nil)
        XCTAssertTrue(preview.contains("delete clusterrole admin"), preview)
        XCTAssertFalse(preview.contains("-n "), preview)
    }

    func test_resolve_deleteResource_unknownKind_isUnresolved() {
        let action = parseOne(#"{"label":"Delete","kind":"deleteResource","resourceKind":"frobnicator","name":"x"}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("frobnicator"), reason)
    }

    // MARK: - Fixtures

    // MARK: - Generic command escape hatch

    func test_resolve_command_buildsLiteralCommand() {
        let action = parseOne(#"{"label":"Destroy pg-1","kind":"command","args":["cnpg","destroy","pg","pg-1","-n","default"]}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []),
              case .command(let args, let label, let destructive) = wa else {
            return XCTFail("expected a resolved command action")
        }
        XCTAssertEqual(args, ["cnpg", "destroy", "pg", "pg-1", "-n", "default"])
        XCTAssertEqual(label, "Destroy pg-1")
        XCTAssertTrue(destructive, "`destroy` is a destructive verb → forced destructive")
        XCTAssertTrue(wa.previewCommand(context: "default").contains("cnpg destroy pg pg-1 -n default"))
    }

    func test_resolve_command_destructiveVerbForcesAck_evenWhenClaudeSaysFalse() {
        let action = parseOne(#"{"label":"x","kind":"command","args":["delete","pod","p","-n","default"],"destructive":false}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected resolved")
        }
        XCTAssertTrue(wa.isHighRisk, "delete is a destructive verb — the app's floor wins over the hint")
        XCTAssertTrue(wa.needsAcknowledge)
    }

    func test_resolve_command_claudeCanEscalateNonDestructiveVerb() {
        let action = parseOne(#"{"label":"x","kind":"command","args":["patch","cluster","pg","-n","default"],"destructive":true}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected resolved")
        }
        XCTAssertTrue(wa.isHighRisk, "Claude can raise the caution on a non-destructive verb")
        XCTAssertTrue(wa.needsAcknowledge)
    }

    func test_resolve_command_nonDestructive_isNeutral() {
        let action = parseOne(#"{"label":"x","kind":"command","args":["annotate","pod","p","key=val","-n","default"]}"#)
        guard case .action(let wa) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected resolved")
        }
        XCTAssertFalse(wa.isHighRisk)
        XCTAssertFalse(wa.needsAcknowledge)
    }

    func test_resolve_command_emptyArgs_isUnresolved() {
        let action = parseOne(#"{"label":"x","kind":"command","args":[]}"#)
        guard case .unresolved(let reason) = SuggestedActionResolver.resolve(action, deployments: [], pods: [], nodes: []) else {
            return XCTFail("expected unresolved")
        }
        XCTAssertTrue(reason.contains("args"))
    }

    private func parseOne(_ json: String) -> SuggestedAction {
        let (_, actions, _) = SuggestedAction.parse(from: "```action\n\(json)\n```")
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

    private func makeDaemonSet(_ name: String, ns: String = "default") -> DaemonSet {
        DaemonSet(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }

    private func makeNode(_ name: String) -> Node {
        Node(
            metadata: ObjectMeta(name: name, namespace: nil, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }

    private func makeJob(_ name: String, ns: String = "default") -> Job {
        Job(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }

    private func makeCronJob(_ name: String, ns: String = "default") -> CronJob {
        CronJob(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }

    private func makeNamespace(_ name: String) -> Namespace {
        Namespace(
            metadata: ObjectMeta(name: name, namespace: nil, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
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
