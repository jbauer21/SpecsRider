// Copyright © 2026 SpecsRider.
// Originally derived from Snap Spectacles Mobile Kit sample (BondingList.swift, © 2024 Snap, Inc.).

import SpectaclesKit
import SwiftUI

struct BondingList: View {
    @EnvironmentObject private var model: Model
    @Binding var bondings: [BondingData]

    var body: some View {
        VStack(spacing: 12) {
            if bondings.isEmpty {
                EmptyBondingState()
            } else {
                ForEach(bondings) { bonding in
                    NavigationLink(destination: SessionView(bonding: bonding)) {
                        BondingRow(bonding: bonding)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct EmptyBondingState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "eyeglasses.slash")
                .font(.system(size: 32, weight: .light))
                .foregroundColor(.specsTextSecondary)
            Text("No bonded Spectacles yet")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.specsWhite)
            Text("Tap Bond Spectacles to pair a device.")
                .font(.system(size: 13))
                .foregroundColor(.specsTextSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .specsCard()
    }
}
