import SwiftUI

struct NavStrip: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "shippingbox.fill").font(.title2)
            Image(systemName: "text.alignleft").font(.title2).foregroundStyle(.tertiary)
            Image(systemName: "bell").font(.title2).foregroundStyle(.tertiary)
            Image(systemName: "server.rack").font(.title2).foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxHeight: .infinity)
        .padding(.vertical, 16)
        .frame(width: 60)
        .background(.thinMaterial)
    }
}
