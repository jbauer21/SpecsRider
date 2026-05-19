// Copyright © 2026 SpecsRider.
// Centralized theme: colors, typography, button styles, and view modifiers
// for the SpecsRider black / white / yellow look-and-feel.

import SwiftUI

// MARK: - Palette

extension Color {
    static let specsBlack = Color(red: 0.040, green: 0.040, blue: 0.040)      // #0A0A0A app background
    static let specsSurface = Color(red: 0.078, green: 0.078, blue: 0.078)    // #141414 cards / fields
    static let specsSurfaceElevated = Color(red: 0.117, green: 0.117, blue: 0.117) // #1E1E1E
    static let specsYellow = Color(red: 1.000, green: 0.831, blue: 0.000)     // #FFD400 primary accent
    static let specsYellowMuted = Color(red: 1.000, green: 0.831, blue: 0.000).opacity(0.18)
    static let specsWhite = Color.white
    static let specsTextSecondary = Color.white.opacity(0.6)
    static let specsTextTertiary = Color.white.opacity(0.35)
    static let specsBorder = Color.white.opacity(0.10)
}

// MARK: - Button styles

struct PrimaryButtonStyle: ButtonStyle {
    var fullWidth: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .bold))
            .foregroundColor(.specsBlack)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.vertical, 14)
            .padding(.horizontal, 22)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(configuration.isPressed ? Color.specsYellow.opacity(0.78) : Color.specsYellow)
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    var fullWidth: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(.specsWhite)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.vertical, 12)
            .padding(.horizontal, 20)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.specsBorder, lineWidth: 1)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(configuration.isPressed ? Color.specsSurfaceElevated : Color.specsSurface)
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct DestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundColor(.specsWhite.opacity(0.85))
            .padding(.vertical, 8)
            .padding(.horizontal, 14)
            .background(
                Capsule().stroke(Color.specsBorder, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.6 : 1.0)
    }
}

struct IconButtonStyle: ButtonStyle {
    var size: CGFloat = 56
    var emphasize: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: emphasize ? 28 : 22, weight: .bold))
            .foregroundColor(emphasize ? .specsBlack : .specsWhite)
            .frame(width: size, height: size)
            .background(
                Circle()
                    .fill(emphasize ? Color.specsYellow : Color.specsSurface)
                    .overlay(
                        Circle().stroke(emphasize ? Color.clear : Color.specsBorder, lineWidth: 1)
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.94 : 1.0)
            .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
    }
}

// MARK: - Card

struct CardModifier: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.specsSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.specsBorder, lineWidth: 1)
            )
    }
}

extension View {
    func specsCard(padding: CGFloat = 16) -> some View {
        modifier(CardModifier(padding: padding))
    }
}

// MARK: - TextField style

struct SpecsTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(size: 16, weight: .medium))
            .foregroundColor(.specsWhite)
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.specsSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.specsBorder, lineWidth: 1)
            )
    }
}

// MARK: - Section header

struct SpecsSectionHeader: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.specsYellow)
                .tracking(1.4)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.specsTextSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Background

struct SpecsBackground: View {
    var body: some View {
        ZStack {
            Color.specsBlack.ignoresSafeArea()
            // Subtle radial yellow glow at top to add depth without overpowering.
            RadialGradient(
                colors: [Color.specsYellow.opacity(0.10), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 320
            )
            .ignoresSafeArea()
        }
    }
}
