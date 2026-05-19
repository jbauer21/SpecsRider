// Copyright © 2026 SpecsRider.
// Thin wrapper around MPMusicPlayerController.systemMusicPlayer for transport actions
// triggered both from the in-app UI and from the Spectacles Lens.

import Foundation
import MediaPlayer

@MainActor
final class MusicController {

    enum Command: String, Sendable {
        case play, pause, next, previous, toggle
    }

    private let player: MPMusicPlayerController = .systemMusicPlayer

    func handle(_ command: Command) {
        switch command {
        case .play:     play()
        case .pause:    pause()
        case .next:     next()
        case .previous: previous()
        case .toggle:   toggle()
        }
    }

    func play()     { player.play() }
    func pause()    { player.pause() }
    func next()     { player.skipToNextItem() }
    func previous() {
        // If the track is already a few seconds in, the conventional behavior is to
        // restart it; only jump to the previous track when very near the start.
        if player.currentPlaybackTime > 3 {
            player.skipToBeginning()
        } else {
            player.skipToPreviousItem()
        }
    }
    func toggle() {
        if player.playbackState == .playing { pause() } else { play() }
    }
}
