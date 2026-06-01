import Foundation

/// A management operation offered for a database instance. UI-facing; the
/// view model maps each to an existing flow (port-forward / secret reveal /
/// clipboard) or to a `WorkloadAction`.
enum DatabaseAction: Hashable, Identifiable {
    case backupNow
    case switchover(to: String)        // target standby instance/pod name
    case hibernate
    case resume
    case scale(current: Int, to: Int)
    case portForward
    case revealCredentials
    case copyDSN

    var id: String {
        switch self {
        case .backupNow:         return "backupNow"
        case .switchover:        return "switchover"
        case .hibernate:         return "hibernate"
        case .resume:            return "resume"
        case .scale:             return "scale"
        case .portForward:       return "portForward"
        case .revealCredentials: return "revealCredentials"
        case .copyDSN:           return "copyDSN"
        }
    }

    var label: String {
        switch self {
        case .backupNow:         return "Back up"
        case .switchover:        return "Switch over"
        case .hibernate:         return "Hibernate"
        case .resume:            return "Resume"
        case .scale:             return "Scale"
        case .portForward:       return "Port-forward"
        case .revealCredentials: return "Credentials"
        case .copyDSN:           return "Copy DSN"
        }
    }

    var systemImage: String {
        switch self {
        case .backupNow:         return "arrow.down.doc"
        case .switchover:        return "arrow.triangle.2.circlepath"
        case .hibernate:         return "moon.zzz"
        case .resume:            return "sun.max"
        case .scale:             return "arrow.up.arrow.down"
        case .portForward:       return "arrow.left.arrow.right"
        case .revealCredentials: return "key"
        case .copyDSN:           return "doc.on.doc"
        }
    }
}

/// One action plus whether it is currently usable (e.g. plugin missing, or no
/// standby to switch over to). The action bar renders disabled items with a tooltip.
struct DatabaseActionItem: Identifiable, Hashable {
    let action: DatabaseAction
    let enabled: Bool
    let disabledReason: String?
    var id: String { action.id }
}

/// How to connect to a database. `secretName` is nil when no credential secret
/// is discoverable (the credentials action is then hidden).
struct ConnectionInfo: Hashable {
    let targetKind: String     // "svc" | "pod"
    let targetName: String
    let namespace: String
    let port: Int
    let scheme: String         // "postgresql" | "mysql" | "redis" | ...
    let secretName: String?
    let username: String?      // CNPG: from the -app secret; generic: nil
    let dbName: String?
}

/// Backup/WAL health shown in the panel's "Backups & health" subsection.
struct BackupInfo: Hashable {
    let lastBackup: String?       // RFC3339 timestamp, nil if none yet
    let schedule: String?         // cron string, nil if no ScheduledBackup
    let walArchivingHealthy: Bool?  // nil if no ContinuousArchiving condition
}

/// The full set of management affordances an operator exposes for an instance.
struct DatabaseCapabilities {
    var actions: [DatabaseActionItem]
    var backupInfo: BackupInfo?
    var connection: ConnectionInfo?
}
