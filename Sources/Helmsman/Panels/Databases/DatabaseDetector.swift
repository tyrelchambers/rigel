import SwiftUI

/// What kind of database a workload is running.
enum DatabaseKind: String, Hashable {
    case postgres, mysql, mariadb, mongo, redis, valkey, keydb
    case clickhouse, elasticsearch, opensearch, cassandra, scylla, dragonfly

    var displayName: String {
        switch self {
        case .postgres:      return "Postgres"
        case .mysql:         return "MySQL"
        case .mariadb:       return "MariaDB"
        case .mongo:         return "Mongo"
        case .redis:         return "Redis"
        case .valkey:        return "Valkey"
        case .keydb:         return "KeyDB"
        case .clickhouse:    return "ClickHouse"
        case .elasticsearch: return "Elasticsearch"
        case .opensearch:    return "OpenSearch"
        case .cassandra:     return "Cassandra"
        case .scylla:        return "ScyllaDB"
        case .dragonfly:     return "Dragonfly"
        }
    }

    var accent: Color {
        switch self {
        case .postgres:                return Color(hex: 0x60A5FA)   // blue
        case .mysql, .mariadb:         return Color(hex: 0xFB923C)   // orange
        case .mongo:                   return Color(hex: 0x34D399)   // green
        case .redis, .valkey, .keydb,
             .dragonfly:               return Color(hex: 0xEF4444)   // red
        case .clickhouse:              return Color(hex: 0xFACC15)   // yellow
        case .elasticsearch, .opensearch: return Color(hex: 0xA855F7) // purple
        case .cassandra, .scylla:      return Color(hex: 0x22D3EE)   // cyan
        }
    }
}

enum DatabaseDetector {
    /// Returns the kind if the image looks like a known database, else nil.
    /// Matches only on the image "name" (final path segment without tag/digest)
    /// so workload names like `postgres-exporter` running an OTel image aren't
    /// misclassified as Postgres.
    static func detect(image: String) -> DatabaseKind? {
        let name = imageName(image).lowercased()

        // Explicit exclusions for ambiguous adjacent images.
        if name.hasSuffix("-operator") || name.hasSuffix("-exporter") { return nil }
        if name == "pgbouncer" || name == "pgpool" { return nil }
        if name == "tailscale" { return nil }

        switch name {
        case "postgres", "postgresql":          return .postgres
        case "mysql":                           return .mysql
        case "mariadb":                         return .mariadb
        case "mongo", "mongodb":                return .mongo
        case "redis":                           return .redis
        case "valkey":                          return .valkey
        case "keydb":                           return .keydb
        case "clickhouse-server", "clickhouse": return .clickhouse
        case "elasticsearch":                   return .elasticsearch
        case "opensearch":                      return .opensearch
        case "cassandra":                       return .cassandra
        case "scylla", "scylladb":              return .scylla
        case "dragonfly", "dragonflydb":        return .dragonfly
        default:                                return nil
        }
    }

    /// Strip registry path + tag/digest from a container image reference.
    /// `ghcr.io/cloudnative-pg/pgbouncer:1.25.1` -> `pgbouncer`
    /// `redis:8-alpine` -> `redis`
    /// `clickhouse/clickhouse-server:25.5.6` -> `clickhouse-server`
    static func imageName(_ image: String) -> String {
        // Drop tag or digest.
        var s = image
        if let at = s.firstIndex(of: "@") { s = String(s[..<at]) }
        if let colon = s.lastIndex(of: ":") { s = String(s[..<colon]) }
        // Drop registry/path.
        if let slash = s.lastIndex(of: "/") { s = String(s[s.index(after: slash)...]) }
        return s
    }
}
