import SwiftUI

/// Sheet to install a metrics backend (VictoriaMetrics or Prometheus) into the
/// cluster. The manifest preview is the review step; Install applies it via the
/// same path as the catalog wizard.
struct MetricsInstallSheet: View {
    @Bindable var model: MetricsInstallModel
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro
                    backendBlock
                    storageBlock
                    manifestPreview
                    if case .failed(let msg) = model.step { errorBlock(msg) }
                    if case .done = model.step { doneBlock }
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 720, height: 680)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.strong, lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.system(size: 13)).foregroundStyle(Theme.Accent.primary)
            Text("Set up a metrics backend")
                .font(Theme.Font.mono(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
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

    private var intro: some View {
        Text("Installs a lightweight, PromQL-compatible store that scrapes container usage continuously — so right-sizing has real history even when Helmsman isn't running. Both options speak the same query API.")
            .font(Theme.Font.body(12))
            .foregroundStyle(Theme.Foreground.secondary)
    }

    private var backendBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("BACKEND")
            Picker("", selection: $model.backend) {
                ForEach(MetricsInstallManifests.Backend.allCases) { b in
                    Text(b.title).tag(b)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text(model.backend == .victoriaMetrics
                 ? "VictoriaMetrics single-node — lightest footprint (~tens of MB)."
                 : "Bare Prometheus — familiar, a few hundred MB.")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
            HStack(spacing: 8) {
                sectionTitle("NAMESPACE")
                field(text: $model.namespace, width: 220, valid: model.namespaceValid)
            }
        }
    }

    private var storageBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("STORAGE")
            Toggle(isOn: $model.persistent) {
                Text("Persist to a PersistentVolume (survives pod restarts)")
                    .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.primary)
            }
            .toggleStyle(.switch)
            if model.persistent {
                HStack(spacing: 8) {
                    Text("Size").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                    Stepper(value: $model.sizeGiB, in: 1...200) {
                        Text("\(model.sizeGiB) Gi").font(Theme.Font.mono(12)).foregroundStyle(Theme.Foreground.primary)
                    }
                    .fixedSize()
                }
                if !model.hasDefaultStorageClass {
                    warn("No default StorageClass detected — the PVC may stay Pending. Consider ephemeral, or set a default StorageClass first.")
                }
            } else {
                warn("Ephemeral storage: history resets if the backend pod restarts.")
            }
        }
    }

    private var manifestPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("MANIFEST (applied with kubectl apply -f -)")
            ScrollView {
                Text(model.manifest)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(height: 200)
            .background(Theme.Surface.field)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
    }

    private func errorBlock(_ msg: String) -> some View {
        Text(msg)
            .font(Theme.Font.mono(11)).foregroundStyle(Theme.Status.failed)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Status.failed.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var doneBlock: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running)
            Text("Installed. Right-sizing now reads from \(model.namespace)/\(MetricsInstallManifests.serviceName). It needs a little while to scrape before verdicts appear.")
                .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Status.running.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button(model.step == .done ? "Done" : "Cancel", action: onClose)
                .buttonStyle(.plain)
                .font(Theme.Font.body(13))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
            if model.step != .done {
                Button {
                    Task { await model.install() }
                } label: {
                    HStack(spacing: 5) {
                        if model.step == .applying { ProgressView().controlSize(.small) }
                        Text(model.step == .applying ? "Installing…" : "Install")
                            .font(Theme.Font.body(13, weight: .semibold))
                    }
                    .foregroundStyle(canInstall ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(canInstall ? Theme.Accent.primary : Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
                .disabled(!canInstall)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var canInstall: Bool {
        model.namespaceValid && model.step != .applying
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t).font(Theme.Font.body(11, weight: .semibold)).tracking(0.5).foregroundStyle(Theme.Foreground.tertiary)
    }

    private func field(text: Binding<String>, width: CGFloat, valid: Bool) -> some View {
        TextField("", text: text)
            .textFieldStyle(.plain)
            .font(Theme.Font.mono(12))
            .foregroundStyle(Theme.Foreground.primary)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Theme.Surface.sunken)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(valid ? Theme.Border.subtle : Theme.Status.failed, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .frame(width: width)
    }

    private func warn(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Theme.Status.pending)
            Text(text).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }
}
