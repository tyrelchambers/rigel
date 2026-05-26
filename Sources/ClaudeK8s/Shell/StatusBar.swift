import SwiftUI

struct StatusBar: View {
    var body: some View {
        HStack(spacing: 12) {
            Text("context: —").font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text("claude: idle").font(.caption2).foregroundStyle(.secondary)
            Text("kubectl: ok").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(height: 18)
        .background(.thinMaterial)
    }
}
