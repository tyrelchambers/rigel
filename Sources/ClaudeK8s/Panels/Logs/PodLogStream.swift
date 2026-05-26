import Foundation

actor PodLogStream {
    nonisolated let podKey: String          // "namespace/name"
    nonisolated let kubectl: String
    nonisolated let context: String?
    nonisolated let namespace: String
    nonisolated let podName: String
    nonisolated let colorIndex: Int
    private var proc: Process?

    init(namespace: String, podName: String, context: String?, colorIndex: Int) throws {
        guard let path = resolveBinary("kubectl") else { throw KubectlClientError.kubectlNotFound }
        self.kubectl = path
        self.context = context
        self.namespace = namespace
        self.podName = podName
        self.podKey = "\(namespace)/\(podName)"
        self.colorIndex = colorIndex
    }

    /// Starts the subprocess and returns a stream of LogLine values.
    nonisolated func stream() -> AsyncStream<LogLine> {
        AsyncStream { continuation in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: kubectl)
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: ["logs", "-f", "--timestamps", "-n", namespace, podName])
            p.arguments = args

            let outPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = Pipe()

            var parser = LogLineStreamParser(sourcePod: podKey, colorIndex: colorIndex)
            outPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    return
                }
                parser.feed(chunk) { line in continuation.yield(line) }
            }

            p.terminationHandler = { _ in
                outPipe.fileHandleForReading.readabilityHandler = nil
                continuation.finish()
            }

            continuation.onTermination = { _ in
                if p.isRunning { p.terminate() }
            }

            do {
                try p.run()
                Task { await self.setProc(p) }
            } catch {
                continuation.finish()
            }
        }
    }

    private func setProc(_ p: Process) { self.proc = p }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
    }
}
