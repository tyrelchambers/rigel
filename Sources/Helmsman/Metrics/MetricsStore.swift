import Foundation
import SQLite3

/// One hourly usage rollup for a single (workload, container).
struct MetricsBucket: Sendable, Hashable {
    let namespace: String
    let workloadKind: String   // "deployment" | "statefulset" | "daemonset"
    let workloadName: String
    let container: String
    let hourEpoch: Int         // floor(unixTime / 3600)
    let cpuAvg: Double         // cores
    let cpuP95: Double
    let cpuMax: Double
    let memAvg: Double         // bytes
    let memP95: Double
    let memMax: Double
}

/// Aggregated usage for a (workload, container) over the retained window.
struct WindowStats: Sendable, Hashable {
    let container: String
    let cpuPeak: Double        // cores — max over all buckets
    let cpuTypical: Double     // cores — mean of hourly p95s
    let memPeak: Double        // bytes — max over all buckets
    let memTypical: Double     // bytes — mean of hourly p95s
    let hoursCovered: Int      // number of hourly buckets recorded
}

/// SQLite-backed rolling store of hourly per-container usage, one DB file per
/// kube-context. Wraps raw libsqlite3 (no package dependency) behind an actor so
/// all disk I/O stays off the main thread. Retention is 30 days.
///
/// The low-level SQL helpers are `nonisolated static` taking the `db` handle, so
/// the (nonisolated) actor `init` can build the schema without hopping isolation.
actor MetricsStore {
    static let retentionDays = 30
    private static let secondsPerHour = 3600

    private var db: OpaquePointer?
    private let path: String

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// `directory` overrides the default Application Support location (tests pass
    /// a temp dir to avoid touching the user's Library).
    init(context: String, directory: URL? = nil) throws {
        let dir = try directory ?? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Helmsman/metrics", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = context.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }
        let file = dir.appendingPathComponent("metrics-\(String(safe)).sqlite")
        self.path = file.path

        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw MetricsStoreError.open(Self.msg(handle))
        }
        self.db = handle
        try Self.runSQL(handle, """
        CREATE TABLE IF NOT EXISTS buckets (
            namespace TEXT NOT NULL,
            workloadKind TEXT NOT NULL,
            workloadName TEXT NOT NULL,
            container TEXT NOT NULL,
            hourEpoch INTEGER NOT NULL,
            cpuAvg REAL, cpuP95 REAL, cpuMax REAL,
            memAvg REAL, memP95 REAL, memMax REAL,
            PRIMARY KEY (namespace, workloadKind, workloadName, container, hourEpoch)
        );
        """)
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    /// Upsert a batch of completed hourly buckets, then sweep anything past retention.
    func writeBuckets(_ buckets: [MetricsBucket], now: Date = Date()) throws {
        guard !buckets.isEmpty else { return }
        try Self.runSQL(db, "BEGIN IMMEDIATE;")
        do {
            let sql = """
            INSERT OR REPLACE INTO buckets
            (namespace, workloadKind, workloadName, container, hourEpoch, cpuAvg, cpuP95, cpuMax, memAvg, memP95, memMax)
            VALUES (?,?,?,?,?,?,?,?,?,?,?);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw MetricsStoreError.prepare(Self.msg(db)) }
            defer { sqlite3_finalize(stmt) }
            for b in buckets {
                sqlite3_reset(stmt)
                Self.bindText(stmt, 1, b.namespace)
                Self.bindText(stmt, 2, b.workloadKind)
                Self.bindText(stmt, 3, b.workloadName)
                Self.bindText(stmt, 4, b.container)
                sqlite3_bind_int64(stmt, 5, Int64(b.hourEpoch))
                sqlite3_bind_double(stmt, 6, b.cpuAvg)
                sqlite3_bind_double(stmt, 7, b.cpuP95)
                sqlite3_bind_double(stmt, 8, b.cpuMax)
                sqlite3_bind_double(stmt, 9, b.memAvg)
                sqlite3_bind_double(stmt, 10, b.memP95)
                sqlite3_bind_double(stmt, 11, b.memMax)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw MetricsStoreError.step(Self.msg(db)) }
            }
            try Self.runSQL(db, "COMMIT;")
        } catch {
            try? Self.runSQL(db, "ROLLBACK;")
            throw error
        }
        try sweep(now: now)
    }

    /// Aggregate stats per container for one workload over the retained window.
    func aggregate(namespace: String, kind: String, name: String) throws -> [WindowStats] {
        let sql = """
        SELECT container, MAX(cpuMax), AVG(cpuP95), MAX(memMax), AVG(memP95), COUNT(*)
        FROM buckets
        WHERE namespace = ? AND workloadKind = ? AND workloadName = ?
        GROUP BY container;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw MetricsStoreError.prepare(Self.msg(db)) }
        defer { sqlite3_finalize(stmt) }
        Self.bindText(stmt, 1, namespace)
        Self.bindText(stmt, 2, kind)
        Self.bindText(stmt, 3, name)

        var out: [WindowStats] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let container = String(cString: sqlite3_column_text(stmt, 0))
            out.append(WindowStats(
                container: container,
                cpuPeak: sqlite3_column_double(stmt, 1),
                cpuTypical: sqlite3_column_double(stmt, 2),
                memPeak: sqlite3_column_double(stmt, 3),
                memTypical: sqlite3_column_double(stmt, 4),
                hoursCovered: Int(sqlite3_column_int64(stmt, 5))
            ))
        }
        return out
    }

    /// Test/inspection helper: total row count.
    func rowCount() throws -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM buckets;", -1, &stmt, nil) == SQLITE_OK else { throw MetricsStoreError.prepare(Self.msg(db)) }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    // MARK: - Private

    private func sweep(now: Date) throws {
        let cutoff = Int(now.timeIntervalSince1970) / Self.secondsPerHour - Self.retentionDays * 24
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM buckets WHERE hourEpoch < ?;", -1, &stmt, nil) == SQLITE_OK else { throw MetricsStoreError.prepare(Self.msg(db)) }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(cutoff))
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw MetricsStoreError.step(Self.msg(db)) }
    }

    /// Run a single no-result statement via prepare/step (avoids sqlite3's
    /// one-shot C helper). `nonisolated static` so `init` can call it.
    private nonisolated static func runSQL(_ db: OpaquePointer?, _ sql: String) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw MetricsStoreError.prepare(msg(db)) }
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw MetricsStoreError.step(msg(db)) }
    }

    private nonisolated static func bindText(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String) {
        sqlite3_bind_text(stmt, idx, value, -1, transient)
    }

    private nonisolated static func msg(_ db: OpaquePointer?) -> String {
        String(cString: sqlite3_errmsg(db))
    }
}

enum MetricsStoreError: Error, CustomStringConvertible {
    case open(String), prepare(String), step(String)
    var description: String {
        switch self {
        case .open(let m): return "sqlite open failed: \(m)"
        case .prepare(let m): return "sqlite prepare failed: \(m)"
        case .step(let m): return "sqlite step failed: \(m)"
        }
    }
}
