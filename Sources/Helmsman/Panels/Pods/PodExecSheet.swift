import SwiftUI

/// Minimal one-shot `kubectl exec` sheet. The user types a command, we run it
/// inside the pod, and we render the captured stdout/stderr below. No PTY —
/// suits diagnostic commands (`ls`, `cat /app/config`, `printenv`, `ps aux`).
struct PodExecSheet: View {
    let pod: Pod
    let context: String?
    let onClose: () -> Void

    @State private var command: String = "ls -la"
    @State private var output: String = ""
    @State private var isRunning = false
    @State private var exitCode: Int32? = nil
    @State private var runTask: Task<Void, Never>? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            inputRow
            outputView
            footer
        }
        .frame(width: 720, height: 520)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Run command in pod")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("\(pod.metadata.name) · \(pod.metadata.namespace ?? "default")")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            Text("$")
                .font(Theme.Font.mono(13, weight: .semibold))
                .foregroundStyle(Theme.Accent.primary)
            TextField("command (e.g. ls -la /etc)", text: $command)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(13))
                .foregroundStyle(Theme.Foreground.primary)
                .onSubmit { run() }
                .disabled(isRunning)
            Button(action: run) {
                HStack(spacing: 5) {
                    Image(systemName: isRunning ? "stop.fill" : "play.fill")
                        .font(.system(size: 10))
                    Text(isRunning ? "Stop" : "Run")
                        .font(Theme.Font.body(12, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(isRunning ? Theme.Status.failed : Theme.Accent.primary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var outputView: some View {
        ScrollView {
            Text(output.isEmpty ? "(no output yet)" : output)
                .font(Theme.Font.mono(11))
                .foregroundStyle(output.isEmpty ? Theme.Foreground.tertiary : Theme.Foreground.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .background(Theme.Surface.sunken)
        .overlay(
            Rectangle().fill(Theme.Border.subtle).frame(height: 1),
            alignment: .top
        )
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let code = exitCode {
                HStack(spacing: 4) {
                    Circle()
                        .fill(code == 0 ? Theme.Status.running : Theme.Status.failed)
                        .frame(width: 6, height: 6)
                    Text("exit \(code)")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.secondary)
                }
            } else if isRunning {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini).tint(Theme.Accent.primary)
                    Text("running…")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.secondary)
                }
            }
            Spacer()
            Text("read-only · stdout + stderr · no PTY")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Theme.Surface.primary)
        .overlay(
            Rectangle().fill(Theme.Border.subtle).frame(height: 1),
            alignment: .top
        )
    }

    // MARK: - Execution

    private func run() {
        if isRunning {
            runTask?.cancel()
            return
        }
        let cmd = command.trimmingCharacters(in: .whitespaces)
        guard !cmd.isEmpty else { return }

        isRunning = true
        output = ""
        exitCode = nil

        let parts = ["sh", "-c", cmd]
        let ns = pod.metadata.namespace ?? "default"
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["exec", pod.metadata.name, "-n", ns, "--"])
        args.append(contentsOf: parts)

        guard let kubectl = resolveBinary("kubectl") else {
            output = "kubectl not found on PATH"
            isRunning = false
            return
        }

        runTask = Task {
            do {
                let data = try await runProcess(kubectl, args: args)
                await MainActor.run {
                    self.output = String(data: data, encoding: .utf8) ?? ""
                    self.exitCode = 0
                    self.isRunning = false
                }
            } catch ProcessError.nonZeroExit(let code, let stderr) {
                await MainActor.run {
                    self.output = stderr
                    self.exitCode = code
                    self.isRunning = false
                }
            } catch {
                await MainActor.run {
                    self.output = "\(error)"
                    self.exitCode = -1
                    self.isRunning = false
                }
            }
        }
    }
}
