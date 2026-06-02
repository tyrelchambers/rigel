import SwiftUI

/// Pick a target namespace for moving a Deployment (and its related resources).
/// Submitting hands the move off to the Helmsman, which discovers the related
/// resources, recreates everything in the target namespace, and surfaces each
/// apply/delete as a confirm-gated action — there is no native k8s "move", so
/// the operation is recreate-in-new + delete-old.
struct DeploymentMoveSheet: View {
    let deployment: Deployment
    /// Existing namespaces, offered in the dropdown. A brand-new namespace can
    /// still be typed — Claude creates it as part of the move.
    let namespaces: [String]
    let onSubmit: (_ targetNamespace: String) -> Void
    let onCancel: () -> Void

    @State private var target: String = ""

    private var sourceNs: String { deployment.metadata.namespace ?? "default" }
    private var name: String { deployment.metadata.name }

    private var trimmedTarget: String { target.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSubmit: Bool {
        !trimmedTarget.isEmpty && trimmedTarget != sourceNs
    }

    /// Existing namespaces minus the source, for the quick-pick dropdown.
    private var pickable: [String] {
        namespaces.filter { $0 != sourceNs }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            content
            footer
        }
        .frame(width: 540)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Status.pending.opacity(0.5), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.left.arrow.right")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Status.pending)
            VStack(alignment: .leading, spacing: 2) {
                Text("Move deployment")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("\(sourceNs)/\(name)")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(Theme.Status.pending.opacity(0.08))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Kubernetes can't move a resource between namespaces — this recreates the deployment (and its related Services, ConfigMaps, Secrets, Ingresses, and PVCs) in the target namespace, then deletes the originals. The Helmsman runs the discovery and surfaces each change as a confirmable action.")
                .font(Theme.Font.body(12))
                .foregroundStyle(Theme.Foreground.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Status.pending)
                Text("PVC data does not migrate — a recreated PVC starts empty unless its PV is manually rebound. The Helmsman will flag this before touching storage.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Status.pending.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            VStack(alignment: .leading, spacing: 6) {
                Text("TARGET NAMESPACE")
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.3)
                    .foregroundStyle(Theme.Foreground.tertiary)
                HStack(spacing: 8) {
                    TextField("namespace", text: $target)
                        .textFieldStyle(.plain)
                        .font(Theme.Font.mono(12))
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Theme.Surface.sunken)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

                    if !pickable.isEmpty {
                        Menu {
                            ForEach(pickable, id: \.self) { ns in
                                Button(ns) { target = ns }
                            }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Theme.Foreground.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 7)
                                .background(Theme.Surface.sunken)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                                )
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .help("Pick an existing namespace")
                    }
                }
                Text("Type a new namespace name and it'll be created as part of the move.")
                    .font(Theme.Font.body(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
        .padding(18)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button(action: onCancel) {
                Text("Cancel")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.strong, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)

            Button {
                onSubmit(trimmedTarget)
            } label: {
                Text("Hand off to Helmsman…")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(canSubmit ? Theme.Status.pending : Theme.Foreground.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .opacity(canSubmit ? 1.0 : 0.4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}
