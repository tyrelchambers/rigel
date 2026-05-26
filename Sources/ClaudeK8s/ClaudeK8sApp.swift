import SwiftUI

@main
struct ClaudeK8sApp: App {
    var body: some Scene {
        WindowGroup("claude-k8s") {
            MainWindow()
                .frame(minWidth: 1000, minHeight: 600)
        }
        .windowResizability(.contentSize)
    }
}
