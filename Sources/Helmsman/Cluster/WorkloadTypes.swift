import Foundation

// MARK: - Job (batch/v1)

struct Job: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let completions: Int?
        let parallelism: Int?
        let suspend: Bool?
    }

    struct Status: Codable, Hashable {
        let succeeded: Int?
        let failed: Int?
        let active: Int?
        let startTime: Date?
        let completionTime: Date?
        let conditions: [Condition]?
    }

    struct Condition: Codable, Hashable {
        let type: String?      // Complete | Failed | Suspended
        let status: String?    // "True" | "False"
    }

    var succeeded: Int { status?.succeeded ?? 0 }
    var desiredCompletions: Int { spec?.completions ?? 1 }
    var completionsLabel: String { "\(succeeded)/\(desiredCompletions)" }

    /// Complete | Failed | Suspended | Running | Pending — derived from conditions/counts.
    var phase: String {
        if spec?.suspend == true { return "Suspended" }
        if let conds = status?.conditions {
            if conds.contains(where: { $0.type == "Failed" && $0.status == "True" }) { return "Failed" }
            if conds.contains(where: { $0.type == "Complete" && $0.status == "True" }) { return "Complete" }
        }
        if (status?.active ?? 0) > 0 { return "Running" }
        return "Pending"
    }

    /// Wall-clock run time (completed jobs only), e.g. "42s", "5m".
    var duration: String? {
        guard let start = status?.startTime else { return nil }
        let end = status?.completionTime ?? Date()
        let dt = end.timeIntervalSince(start)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        return "\(Int(dt/3600))h"
    }
}

// MARK: - CronJob (batch/v1)

struct CronJob: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let schedule: String?
        let suspend: Bool?
    }

    struct Status: Codable, Hashable {
        let active: [ObjectRef]?
        let lastScheduleTime: Date?
    }

    struct ObjectRef: Codable, Hashable {
        let name: String?
    }

    var schedule: String { spec?.schedule ?? "—" }
    var isSuspended: Bool { spec?.suspend == true }
    var activeCount: Int { status?.active?.count ?? 0 }

    var lastScheduleAgo: String? {
        guard let t = status?.lastScheduleTime else { return nil }
        let dt = Date().timeIntervalSince(t)
        if dt < 60 { return "\(Int(dt))s ago" }
        if dt < 3600 { return "\(Int(dt/60))m ago" }
        if dt < 86400 { return "\(Int(dt/3600))h ago" }
        return "\(Int(dt/86400))d ago"
    }

    /// A unique-enough name for a manual run created via `kubectl create job
    /// --from=cronjob/<name>`. Computed at the call site so the confirm-sheet
    /// preview matches what's executed.
    static func manualRunName(for cronName: String) -> String {
        let stamp = Int(Date().timeIntervalSince1970) % 100000
        let base = cronName.count > 40 ? String(cronName.prefix(40)) : cronName
        return "\(base)-manual-\(stamp)"
    }
}

// MARK: - DaemonSet (apps/v1)

struct DaemonSet: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let selector: LabelSelector?
        let template: PodTemplate?
    }

    struct Status: Codable, Hashable {
        let desiredNumberScheduled: Int?
        let currentNumberScheduled: Int?
        let numberReady: Int?
        let updatedNumberScheduled: Int?
        let numberAvailable: Int?
    }

    var desired: Int { status?.desiredNumberScheduled ?? 0 }
    var ready: Int { status?.numberReady ?? 0 }
    var readyLabel: String { "\(ready)/\(desired)" }
    var isHealthy: Bool { desired > 0 && ready == desired }
}
