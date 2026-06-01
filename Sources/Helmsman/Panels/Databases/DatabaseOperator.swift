import Foundation

/// Read-only snapshot the operators consult to compute capabilities. Built by
/// the view model from the live `ClusterCache` each render.
struct DatabaseContext {
    let cnpgPluginAvailable: Bool
    let scheduledBackups: [CNPGScheduledBackup]
    let cnpgClusters: [CNPGCluster]
    let secrets: [Secret]
    let pods: [Pod]
}

/// Maps a detected database instance to the management affordances it supports.
/// Add a conformer + registry entry to support a new operator — no UI changes.
protocol DatabaseOperator {
    var id: String { get }
    func owns(_ instance: DatabaseInstance) -> Bool
    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities
}

struct DatabaseOperatorRegistry {
    let operators: [DatabaseOperator]
    init(operators: [DatabaseOperator] = [CNPGOperator(), NoOperator()]) {
        self.operators = operators
    }
    func `operator`(for instance: DatabaseInstance) -> DatabaseOperator {
        operators.first { $0.owns(instance) } ?? NoOperator()
    }
    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        `operator`(for: instance).capabilities(for: instance, context: context)
    }
}

// MARK: - CNPG

struct CNPGOperator: DatabaseOperator {
    let id = "cnpg"
    func owns(_ instance: DatabaseInstance) -> Bool { instance.source == .cnpg }

    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        let pluginMissing = !context.cnpgPluginAvailable
        let pluginReason = "Requires the kubectl-cnpg plugin"

        let pods = context.pods.filter { pod in
            pod.metadata.namespace == instance.namespace &&
            (pod.metadata.labels?["cnpg.io/cluster"] == instance.name) &&
            pod.status?.phase == "Running"
        }
        // A switchover only makes sense once a primary is elected — otherwise
        // every pod would falsely look like a promotable standby.
        let standby = instance.cnpgPrimary.flatMap { primary in
            pods.map(\.metadata.name).filter { $0 != primary }.sorted().first
        }

        var items: [DatabaseActionItem] = []
        items.append(DatabaseActionItem(action: .backupNow, enabled: !pluginMissing,
                                        disabledReason: pluginMissing ? pluginReason : nil))
        if let standby {
            items.append(DatabaseActionItem(action: .switchover(to: standby),
                                            enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        } else {
            items.append(DatabaseActionItem(action: .switchover(to: ""), enabled: false,
                                            disabledReason: "No ready standby to promote"))
        }
        if instance.readyReplicas == 0 {
            items.append(DatabaseActionItem(action: .resume, enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        } else {
            items.append(DatabaseActionItem(action: .hibernate, enabled: !pluginMissing,
                                            disabledReason: pluginMissing ? pluginReason : nil))
        }
        items.append(DatabaseActionItem(action: .scale(current: instance.desiredReplicas,
                                                        to: instance.desiredReplicas),
                                        enabled: true, disabledReason: nil))
        items.append(DatabaseActionItem(action: .portForward, enabled: true, disabledReason: nil))
        items.append(DatabaseActionItem(action: .revealCredentials, enabled: true, disabledReason: nil))
        items.append(DatabaseActionItem(action: .copyDSN, enabled: true, disabledReason: nil))

        let cluster = context.cnpgClusters.first { $0.metadata.name == instance.name
            && $0.metadata.namespace == instance.namespace }
        let schedule = context.scheduledBackups.first {
            $0.spec?.cluster?.name == instance.name && $0.metadata.namespace == instance.namespace
        }?.spec?.schedule
        let walCond = cluster?.status?.conditions?.first { $0.type == "ContinuousArchiving" }
        let backupInfo = BackupInfo(
            lastBackup: cluster?.status?.lastSuccessfulBackup,
            schedule: schedule,
            walArchivingHealthy: walCond.map { $0.status == "True" }
        )
        let connection = ConnectionInfo(
            targetKind: "svc", targetName: "\(instance.name)-rw", namespace: instance.namespace,
            port: 5432, scheme: "postgresql", secretName: "\(instance.name)-app",
            username: nil, dbName: "app"
        )
        return DatabaseCapabilities(actions: items, backupInfo: backupInfo, connection: connection)
    }
}

// MARK: - Generic (no operator)

struct NoOperator: DatabaseOperator {
    let id = "none"
    func owns(_ instance: DatabaseInstance) -> Bool {
        instance.source == .deployment || instance.source == .statefulset
    }

    func capabilities(for instance: DatabaseInstance, context: DatabaseContext) -> DatabaseCapabilities {
        let pods = context.pods.filter { pod in
            pod.metadata.namespace == instance.namespace &&
            instance.labelSelector.allSatisfy { (pod.metadata.labels ?? [:])[$0.key] == $0.value }
        }
        let secretName = Self.discoverSecret(in: pods)
        let port = Self.defaultPort(for: instance.kind)
        let target = pods.first(where: { $0.status?.phase == "Running" }) ?? pods.first

        var items: [DatabaseActionItem] = []
        items.append(DatabaseActionItem(action: .scale(current: instance.desiredReplicas,
                                                        to: instance.desiredReplicas),
                                        enabled: true, disabledReason: nil))
        if target != nil {
            items.append(DatabaseActionItem(action: .portForward, enabled: true, disabledReason: nil))
        }
        if secretName != nil {
            items.append(DatabaseActionItem(action: .revealCredentials, enabled: true, disabledReason: nil))
        }
        items.append(DatabaseActionItem(action: .copyDSN, enabled: true, disabledReason: nil))

        let connection = target.map { t in
            ConnectionInfo(targetKind: "pod", targetName: t.metadata.name, namespace: instance.namespace,
                           port: port, scheme: Self.scheme(for: instance.kind),
                           secretName: secretName, username: nil, dbName: nil)
        }
        return DatabaseCapabilities(actions: items, backupInfo: nil, connection: connection)
    }

    static func discoverSecret(in pods: [Pod]) -> String? {
        for pod in pods {
            for ct in pod.spec?.containers ?? [] {
                if let n = ct.envFrom?.compactMap({ $0.secretRef?.name }).first { return n }
                if let n = ct.env?.compactMap({ $0.valueFrom?.secretKeyRef?.name }).first { return n }
            }
        }
        return nil
    }

    static func defaultPort(for kind: DatabaseKind) -> Int {
        switch kind {
        case .postgres:                       return 5432
        case .mysql, .mariadb:                return 3306
        case .mongo:                          return 27017
        case .redis, .valkey, .keydb, .dragonfly: return 6379
        case .clickhouse:                     return 9000
        case .elasticsearch, .opensearch:     return 9200
        case .cassandra, .scylla:             return 9042
        }
    }

    static func scheme(for kind: DatabaseKind) -> String {
        switch kind {
        case .postgres:                       return "postgresql"
        case .mysql, .mariadb:                return "mysql"
        case .mongo:                          return "mongodb"
        case .redis, .valkey, .keydb, .dragonfly: return "redis"
        case .clickhouse:                     return "clickhouse"
        case .elasticsearch, .opensearch:     return "http"
        case .cassandra, .scylla:             return "cassandra"
        }
    }
}
