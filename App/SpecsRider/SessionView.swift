// Copyright © 2026 SpecsRider.
// Originally derived from Snap Spectacles Mobile Kit sample (SessionView.swift, © 2024 Snap, Inc.).

import SwiftUI

struct SessionView: View {
    @EnvironmentObject private var model: Model
    var bonding: BondingData

    var body: some View {
        ZStack {
            SpecsBackground()
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    headerCard

                    Button(model.sessionStarted ? "Stop Session" : "Start Session") {
                        if model.sessionStarted {
                            model.stopSession()
                        } else {
                            model.startSession(binding: bonding)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    diagnosticsSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
        .navigationTitle("Glasses")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(model.sessionStarted ? Color.specsYellow : Color.specsTextTertiary)
                    .frame(width: 10, height: 10)
                Text(model.sessionStarted ? "Connected" : "Idle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.specsWhite)
                Spacer()
            }
            Text(bonding.id)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(.specsTextSecondary)
                .lineLimit(2)
                .truncationMode(.middle)
        }
        .specsCard()
    }

    @ViewBuilder
    private var diagnosticsSection: some View {
        if !model.lastDiagnostic.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SpecsSectionHeader(title: "Last bridge event")
                Text(model.lastDiagnostic)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.specsTextSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .specsCard()
        }
    }
}
