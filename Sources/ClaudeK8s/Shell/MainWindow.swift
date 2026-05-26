import SwiftUI

struct MainWindow: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    // Panel region (left, ~60%)
                    VStack {
                        Text("Pods panel goes here")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    // Chat region (right, ~40%)
                    VStack {
                        Text("Chat goes here")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
    }
}
