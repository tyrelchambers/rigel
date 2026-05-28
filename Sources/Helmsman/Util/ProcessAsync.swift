import Foundation

enum ProcessError: Error, CustomStringConvertible {
    case nonZeroExit(code: Int32, stderr: String)
    case launchFailed(underlying: Error)
    case stdoutClosed

    var description: String {
        switch self {
        case .nonZeroExit(let code, let stderr):
            return "process exited with code \(code): \(stderr)"
        case .launchFailed(let err):
            return "process launch failed: \(err)"
        case .stdoutClosed:
            return "process stdout closed unexpectedly"
        }
    }
}

/// Thread-safe accumulator for subprocess pipe drainage.
/// Pipe readability handlers fire on a serial dispatch queue, but we still want
/// to coordinate with the termination handler (which runs on a different queue).
final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        _data.append(chunk)
    }

    var data: Data {
        lock.lock(); defer { lock.unlock() }
        return _data
    }
}

/// Thread-safe holder so the Task-cancellation handler can SIGTERM the running process.
final class ProcessHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var proc: Process?

    func set(_ p: Process) {
        lock.lock(); defer { lock.unlock() }
        proc = p
    }

    func terminate() {
        lock.lock(); defer { lock.unlock() }
        if let p = proc, p.isRunning { p.terminate() }
    }
}

/// Run a one-shot subprocess and collect its full stdout. Throws if exit != 0.
///
/// Important:
/// - Pipes are drained incrementally via `readabilityHandler` to avoid pipe-buffer
///   deadlock when the child writes more than ~64 KB before exiting
///   (e.g. `kubectl get pods -A -o json` against a busy cluster).
/// - The subprocess is SIGTERM'd if the enclosing Task is cancelled, so in-flight
///   one-shot kubectl calls don't outlive their owner (e.g. on context switch).
/// - When `stdin` is non-nil, the data is written to the child's stdin and the
///   write end is closed so the child sees EOF (`kubectl apply -f -` needs this).
func runProcess(_ launchPath: String, args: [String], env: [String: String]? = nil, stdin: Data? = nil) async throws -> Data {
    try Task.checkCancellation()

    let holder = ProcessHolder()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: launchPath)
            proc.arguments = args
            if let env { proc.environment = env }

            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = errPipe

            let inPipe: Pipe? = (stdin != nil) ? Pipe() : nil
            if let inPipe { proc.standardInput = inPipe }

            let outBox = OutputBox()
            let errBox = OutputBox()

            outPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    outBox.append(chunk)
                }
            }
            errPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    errBox.append(chunk)
                }
            }

            proc.terminationHandler = { p in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let trailingOut = (try? outPipe.fileHandleForReading.readToEnd()) ?? Data()
                outBox.append(trailingOut)
                let trailingErr = (try? errPipe.fileHandleForReading.readToEnd()) ?? Data()
                errBox.append(trailingErr)

                if p.terminationStatus == 0 {
                    cont.resume(returning: outBox.data)
                } else {
                    let errStr = String(data: errBox.data, encoding: .utf8) ?? ""
                    cont.resume(throwing: ProcessError.nonZeroExit(code: p.terminationStatus, stderr: errStr))
                }
            }

            holder.set(proc)
            do {
                try proc.run()
                if let inPipe, let stdin {
                    try inPipe.fileHandleForWriting.write(contentsOf: stdin)
                    try inPipe.fileHandleForWriting.close()
                }
            } catch {
                cont.resume(throwing: ProcessError.launchFailed(underlying: error))
            }
        }
    } onCancel: {
        holder.terminate()
    }
}

/// Resolve a binary on PATH (e.g. "kubectl", "claude") to an absolute path.
func resolveBinary(_ name: String) -> String? {
    let env = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    for dir in env.split(separator: ":") {
        let candidate = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}
