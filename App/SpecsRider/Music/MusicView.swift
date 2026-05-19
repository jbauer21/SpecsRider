// Copyright © 2026 SpecsRider.
// Now-playing card and transport controls. Reads from NowPlayingService and acts via MusicController.

import MediaPlayer
import SwiftUI

struct MusicView: View {
    @EnvironmentObject private var model: Model

    var body: some View {
        ZStack {
            SpecsBackground()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    header

                    switch model.nowPlayingService.authState {
                    case .authorized:
                        nowPlayingCard
                        transportCard
                    case .denied, .restricted:
                        deniedCard
                    case .notDetermined, .unknown:
                        permissionPromptCard
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
        .onAppear {
            model.nowPlayingService.requestAuthorizationIfNeeded()
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Music")
                .font(.system(size: 34, weight: .heavy))
                .foregroundColor(.specsWhite)
            Text("Mirror what's playing in the iOS Music app to your Spectacles.")
                .font(.system(size: 14))
                .foregroundColor(.specsTextSecondary)
        }
    }

    private var nowPlayingCard: some View {
        let payload = model.nowPlayingService.payload
        let artwork = model.nowPlayingService.artworkImage

        return HStack(alignment: .top, spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.specsSurfaceElevated)
                if let artwork {
                    Image(uiImage: artwork)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "music.note")
                        .font(.system(size: 28, weight: .light))
                        .foregroundColor(.specsTextSecondary)
                }
            }
            .frame(width: 96, height: 96)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.specsBorder, lineWidth: 1)
            )

            VStack(alignment: .leading, spacing: 6) {
                Text(payload?.title ?? "Nothing playing")
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundColor(.specsWhite)
                    .lineLimit(2)
                Text(payload?.artist.isEmpty == false ? payload!.artist : "—")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.specsTextSecondary)
                    .lineLimit(1)
                Text(payload?.album.isEmpty == false ? payload!.album : "")
                    .font(.system(size: 12))
                    .foregroundColor(.specsTextTertiary)
                    .lineLimit(1)

                if let payload, payload.durationMs > 0 {
                    progressBar(elapsed: payload.elapsedMs, duration: payload.durationMs)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .specsCard()
    }

    private func progressBar(elapsed: Int, duration: Int) -> some View {
        let fraction = duration > 0 ? min(1.0, max(0, Double(elapsed) / Double(duration))) : 0
        return VStack(spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.specsBorder)
                    Capsule().fill(Color.specsYellow)
                        .frame(width: geo.size.width * fraction)
                }
            }
            .frame(height: 3)
            HStack {
                Text(Self.formatTime(ms: elapsed))
                Spacer()
                Text(Self.formatTime(ms: duration))
            }
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundColor(.specsTextSecondary)
        }
    }

    private var transportCard: some View {
        let isPlaying = model.nowPlayingService.payload?.isPlaying ?? false
        return HStack(spacing: 18) {
            Spacer()
            Button { model.musicController.previous() } label: {
                Image(systemName: "backward.fill")
            }
            .buttonStyle(IconButtonStyle())

            Button { model.musicController.toggle() } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
            .buttonStyle(IconButtonStyle(size: 72, emphasize: true))

            Button { model.musicController.next() } label: {
                Image(systemName: "forward.fill")
            }
            .buttonStyle(IconButtonStyle())
            Spacer()
        }
        .specsCard()
    }

    private var permissionPromptCard: some View {
        VStack(spacing: 10) {
            Image(systemName: "music.note.list")
                .font(.system(size: 28))
                .foregroundColor(.specsYellow)
            Text("Allow access to your Music library")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.specsWhite)
            Text("SpecsRider mirrors what's playing in the iOS Music app to your glasses.")
                .font(.system(size: 13))
                .foregroundColor(.specsTextSecondary)
                .multilineTextAlignment(.center)
            Button("Allow") {
                model.nowPlayingService.requestAuthorizationIfNeeded()
            }
            .buttonStyle(PrimaryButtonStyle())
        }
        .padding(.vertical, 8)
        .specsCard()
    }

    private var deniedCard: some View {
        VStack(spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.system(size: 28))
                .foregroundColor(.specsYellow)
            Text("Music access is off")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.specsWhite)
            Text("Open Settings → Privacy → Media & Apple Music and enable SpecsRider.")
                .font(.system(size: 13))
                .foregroundColor(.specsTextSecondary)
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(SecondaryButtonStyle(fullWidth: true))
        }
        .padding(.vertical, 8)
        .specsCard()
    }

    private static func formatTime(ms: Int) -> String {
        let totalSeconds = ms / 1000
        let m = totalSeconds / 60
        let s = totalSeconds % 60
        return String(format: "%d:%02d", m, s)
    }
}
