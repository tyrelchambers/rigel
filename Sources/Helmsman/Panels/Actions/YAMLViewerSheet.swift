import SwiftUI

/// Read-only YAML viewer for a single cluster resource. Fetches live via
/// `kubectl get <kind>/<name> -n <ns> -o yaml` so the manifest reflects what's
/// actually applied, including server-managed fields.
struct YAMLViewerSheet: View {
    let kind: String          // "pod", "deployment", "node", "statefulset", ...
    let name: String
    let namespace: String?    // nil for cluster-scoped (nodes)
    let context: String?
    let onClose: () -> Void

    @State private var yaml: String = ""
    @State private var error: String? = nil
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            content
        }
        .frame(width: 760, height: 600)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text("YAML — \(kind)/\(name)")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(namespace ?? "cluster-scoped")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(yaml, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(width: 24, height: 24)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Copy YAML to clipboard")
            .disabled(yaml.isEmpty)
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

    @ViewBuilder private var content: some View {
        if isLoading {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
                Text("Loading…").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.Surface.sunken)
        } else if let error {
            ScrollView {
                Text(error)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
            .background(Theme.Surface.sunken)
        } else {
            YAMLDisplay(yaml: .constant(yaml), editable: false)
        }
    }

    private func load() async {
        guard let kubectl = resolveBinary("kubectl") else {
            await MainActor.run { error = "kubectl not found on PATH"; isLoading = false }
            return
        }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["get", "\(kind)/\(name)"])
        if let namespace { args.append(contentsOf: ["-n", namespace]) }
        args.append(contentsOf: ["-o", "yaml"])

        do {
            let data = try await runProcess(kubectl, args: args)
            let text = String(data: data, encoding: .utf8) ?? ""
            await MainActor.run {
                yaml = text
                isLoading = false
            }
        } catch ProcessError.nonZeroExit(let code, let stderr) {
            await MainActor.run {
                error = "kubectl exited \(code):\n\(stderr)"
                isLoading = false
            }
        } catch {
            await MainActor.run {
                self.error = "\(error)"
                isLoading = false
            }
        }
    }
}

/// Minimal "what do we want to view YAML for" descriptor — used as a single
/// `@State` slot in MainWindow to drive the sheet.
struct YAMLTarget: Identifiable, Equatable {
    let id = UUID()
    let kind: String
    let name: String
    let namespace: String?
}

/// Reusable YAML pane: monospace, selectable, optionally editable. Used by
/// the read-only `YAMLViewerSheet` and the editable Review step in the
/// catalog install wizard.
struct YAMLDisplay: View {
    @Binding var yaml: String
    var editable: Bool = false

    var body: some View {
        Group {
            if editable {
                TextEditor(text: $yaml)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
                    .scrollContentBackground(.hidden)
                    .background(Theme.Surface.sunken)
                    .padding(8)
            } else {
                ScrollView([.vertical, .horizontal]) {
                    Text(yaml)
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Foreground.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
            }
        }
        .background(Theme.Surface.sunken)
    }
}
