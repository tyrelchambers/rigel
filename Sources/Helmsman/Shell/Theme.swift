import SwiftUI
import AppKit

enum Theme {
    enum Surface {
        static let primary  = Color(hex: 0x0A0A0A)
        static let elevated = Color(hex: 0x141417)
        static let sunken   = Color(hex: 0x050505)
        /// Fill for editable inputs — raised above the body so fields read as
        /// interactive rather than blending into the surface behind them.
        static let field    = Color(hex: 0x1C1C22)
    }

    enum Foreground {
        static let primary   = Color(hex: 0xFFFFFF)
        static let secondary = Color(hex: 0xA1A1AA)
        static let tertiary  = Color(hex: 0x6B6B73)
        static let inverse   = Color(hex: 0x0A0A0A)
    }

    enum Border {
        static let subtle = Color(hex: 0x1A1A1A)
        static let strong = Color(hex: 0x2A2A2A)
    }

    enum Accent {
        static let primary    = Color(hex: 0xA855F7)
        static let primaryDim = Color(hex: 0xA855F7, alpha: 0.15)
    }

    enum Status {
        static let running = Color(hex: 0x10B981)
        static let pending = Color(hex: 0xF59E0B)
        static let failed  = Color(hex: 0xEF4444)
    }

    enum Radius {
        static let sm: CGFloat = 4
        static let md: CGFloat = 6
        static let lg: CGFloat = 8
    }

    enum Pod {
        static let palette: [Color] = [
            Color(hex: 0x60A5FA),
            Color(hex: 0x34D399),
            Color(hex: 0xFB923C),
            Color(hex: 0xA855F7),
            Color(hex: 0xEC4899),
            Color(hex: 0x22D3EE),
            Color(hex: 0xFACC15),
            Color(hex: 0x2DD4BF),
        ]
    }

    enum Font {
        /// Resolved body family if installed, else nil (caller should use system).
        static let bodyFamilyName: String? = {
            for candidate in ["Geist", "Geist Regular"] {
                if NSFont(name: candidate, size: 12) != nil { return candidate }
            }
            return nil
        }()

        /// Resolved monospace family if installed, else nil.
        static let monoFamilyName: String? = {
            for candidate in ["Geist Mono", "GeistMono NF", "GeistMono Nerd Font", "SF Mono"] {
                if NSFont(name: candidate, size: 12) != nil { return candidate }
            }
            return nil
        }()

        static func body(_ size: CGFloat, weight: SwiftUI.Font.Weight = .regular) -> SwiftUI.Font {
            if let name = bodyFamilyName {
                return .custom(name, size: size).weight(weight)
            }
            return .system(size: size, weight: weight)
        }

        static func mono(_ size: CGFloat, weight: SwiftUI.Font.Weight = .regular) -> SwiftUI.Font {
            if let name = monoFamilyName {
                return .custom(name, size: size).weight(weight)
            }
            return .system(size: size, weight: weight, design: .monospaced)
        }
    }
}

extension View {
    /// Visual chrome that makes a control read as an editable input against
    /// the app's dark surfaces: a raised fill plus a defined border that turns
    /// accent-colored while focused.
    func inputChrome(focused: Bool = false) -> some View {
        self
            .background(Theme.Surface.field)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(focused ? Theme.Accent.primary : Theme.Border.strong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8)  & 0xFF) / 255
        let b = Double( hex        & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

struct StatusPill: View {
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label)
                .font(Theme.Font.body(11, weight: .medium))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
