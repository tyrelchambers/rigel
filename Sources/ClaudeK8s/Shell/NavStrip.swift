import SwiftUI

struct NavStrip: View {
    @Binding var selection: PanelKind

    var body: some View {
        VStack(spacing: 16) {
            ForEach(PanelKind.allCases) { kind in
                Button {
                    selection = kind
                } label: {
                    Image(systemName: kind.icon)
                        .font(.title2)
                        .frame(width: 32, height: 32)
                        .foregroundStyle(selection == kind ? Color.accentColor : Color.secondary)
                        .background(selection == kind ? Color.accentColor.opacity(0.15) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .help(kind.title)
            }
            Spacer()
        }
        .frame(maxHeight: .infinity)
        .padding(.vertical, 16)
        .frame(width: 60)
        .background(.thinMaterial)
    }
}
