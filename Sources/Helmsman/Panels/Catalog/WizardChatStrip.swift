import SwiftUI
import MarkdownUI

/// Compact chat surface inside the install wizard. Top: scrolling transcript
/// of user/assistant turns; bottom: input field + Send + "Use this manifest".
/// Used by Generating / Failed / Verifying steps.
struct WizardChatStrip: View {
    @Bindable var model: CatalogInstallWizardModel
    /// When true, surface a "Use this manifest" button next to Send.
    var useThisManifestEnabled: Bool = false
    /// When true, fenced manifest blocks in assistant turns are replaced by a
    /// compact note — used on the generate step where the visual summary
    /// already shows the manifest, so the transcript stays prose-only.
    var collapseManifest: Bool = false
    @State private var input: String = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            transcriptView
            inputBar
        }
    }

    private var transcriptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(model.transcript) { turn in
                        TurnBubble(turn: turn, collapseManifest: collapseManifest)
                            .id(turn.id)
                    }
                    Color.clear.frame(height: 1).id("__bottom__")
                }
                .padding(12)
            }
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .onChange(of: model.transcript.last?.text) { _, _ in
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
            .onChange(of: model.transcript.count) { _, _ in
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Ask Claude to revise, clarify, or explain…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Theme.Font.body(12))
                .focused($inputFocused)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .inputChrome(focused: inputFocused)
                .onSubmit { submit() }
            Button {
                submit()
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(input.isEmpty ? Theme.Foreground.tertiary : Theme.Foreground.inverse)
                    .frame(width: 30, height: 28)
                    .background(input.isEmpty ? Theme.Surface.sunken : Theme.Accent.primary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Send (⌘↩)")

            if useThisManifestEnabled {
                Button {
                    model.useManifest()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                        Text("Use this manifest").font(Theme.Font.body(12, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.Accent.primary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
                .help("Advance to Review with the latest YAML block")
            }
        }
    }

    private func submit() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.sendFollowup(text)
        input = ""
    }

    /// Replace fenced manifest blocks (```yaml … ``` or any fence containing
    /// `apiVersion:`/`kind:`) with a one-line note. Leaves prose and other code
    /// fences intact. An unterminated trailing fence (mid-stream) is collapsed
    /// too so half-written YAML never flashes in the transcript.
    static func collapseManifestBlocks(_ text: String) -> String {
        guard text.contains("```") else { return text }
        let parts = text.components(separatedBy: "```")
        var out = ""
        for (i, part) in parts.enumerated() {
            let insideFence = (i % 2 == 1)
            guard insideFence else { out += part; continue }
            let firstLine = part.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                .first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
            let looksManifest = firstLine == "yaml" || firstLine == "yml"
                || part.contains("apiVersion:") || part.contains("\nkind:") || part.hasPrefix("kind:")
            let isClosed = (i < parts.count - 1)
            if looksManifest {
                out += "📄 _manifest — shown in the summary above_"
            } else if isClosed {
                out += "```\(part)```"
            } else {
                out += "```\(part)"
            }
        }
        return out
    }
}

private struct TurnBubble: View {
    let turn: WizardChatTurn
    var collapseManifest: Bool = false

    private var displayText: String {
        guard collapseManifest, turn.role == .assistant else { return turn.text }
        return WizardChatStrip.collapseManifestBlocks(turn.text)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: turn.role == .user ? "person.fill" : "sparkles")
                .font(.system(size: 10))
                .foregroundStyle(turn.role == .user ? Theme.Foreground.tertiary : Theme.Accent.primary)
                .frame(width: 18, alignment: .center)
                .padding(.top, 2)
            Group {
                if turn.role == .assistant {
                    Markdown(displayText)
                        .markdownTextStyle {
                            FontSize(11.5)
                            ForegroundColor(Theme.Foreground.primary)
                        }
                        .markdownTextStyle(\.code) {
                            FontFamilyVariant(.monospaced)
                            FontSize(10.5)
                            ForegroundColor(Theme.Accent.primary)
                            BackgroundColor(Theme.Accent.primaryDim)
                        }
                        .textSelection(.enabled)
                } else {
                    Text(turn.text)
                        .font(Theme.Font.body(11.5))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }
}
