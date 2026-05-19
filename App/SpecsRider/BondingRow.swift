// Copyright © 2026 SpecsRider.
// Originally derived from Snap Spectacles Mobile Kit sample (BondingRow.swift, © 2024 Snap, Inc.).

import SpectaclesKit
import SwiftUI

struct BondingRow: View {
    @EnvironmentObject private var model: Model
    var bonding: BondingData

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Color.specsYellowMuted).frame(width: 36, height: 36)
                Image(systemName: "eyeglasses")
                    .foregroundColor(.specsYellow)
                    .font(.system(size: 16, weight: .bold))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Spectacles")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.specsWhite)
                Text(bonding.id)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundColor(.specsTextSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            Button("Unbind") {
                model.unbind(id: bonding.id)
            }
            .buttonStyle(DestructiveButtonStyle())
        }
        .specsCard(padding: 14)
    }
}

struct BondingData: Bonding, Identifiable {
    let id: String
}

#Preview {
    ZStack {
        SpecsBackground()
        BondingRow(bonding: BondingData(id: "ID-12345-XYZ"))
            .environmentObject(Model())
            .padding()
    }
}
