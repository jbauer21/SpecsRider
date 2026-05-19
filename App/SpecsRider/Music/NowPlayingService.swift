// Copyright © 2026 SpecsRider.
// Observes MPMusicPlayerController.systemMusicPlayer and publishes the current
// Now Playing metadata + artwork as Codable payloads suitable for the Spectacles
// bridge. Artwork is delivered as JPEG bytes (see `updateArtwork` for rationale).

import Combine
import Foundation
import MediaPlayer
import UIKit

@MainActor
final class NowPlayingService: ObservableObject {

    enum AuthState: Equatable {
        case unknown
        case authorized
        case denied
        case restricted
        case notDetermined
    }

    @Published private(set) var payload: NowPlayingPayload?
    @Published private(set) var artworkImage: UIImage?
    /// JPEG-encoded album artwork bytes ready for transport to the lens.
    /// `nil` until `updateArtwork(for:)` successfully encodes a frame.
    @Published private(set) var artworkData: Data?
    @Published private(set) var authState: AuthState = .unknown

    private let player: MPMusicPlayerController = .systemMusicPlayer
    private let notifier = NotificationCenter.default
    private var observers: [NSObjectProtocol] = []
    private var pollingTimer: Timer?
    private var lastPersistentID: MPMediaEntityPersistentID = 0
    private var artworkVersionTag: String?
    private var isObserving = false

    init() {
        refreshAuthState()
        // Best-effort: attempt a snapshot even before authorization in case the system
        // is happy to surface limited info; we'll re-snapshot once authorized.
        snapshot()
    }

    deinit {
        // Cleanup must happen on main; since deinit isn't @MainActor, schedule a hop.
        let observers = self.observers
        let pollingTimer = self.pollingTimer
        let isObserving = self.isObserving
        let player = self.player
        let center = self.notifier
        Task { @MainActor in
            observers.forEach { center.removeObserver($0) }
            pollingTimer?.invalidate()
            if isObserving {
                player.endGeneratingPlaybackNotifications()
            }
        }
    }

    // MARK: - Public

    func requestAuthorizationIfNeeded() {
        let current = MPMediaLibrary.authorizationStatus()
        if current == .notDetermined {
            MPMediaLibrary.requestAuthorization { [weak self] _ in
                Task { @MainActor in
                    self?.refreshAuthState()
                    self?.startObservingIfPossible()
                    self?.snapshot()
                }
            }
        } else {
            refreshAuthState()
            startObservingIfPossible()
            snapshot()
        }
    }

    /// Re-emit the current payload so that fresh subscribers (e.g. a Lens topic) get an
    /// initial value without waiting for the next track change.
    func republish() {
        snapshot()
    }

    // MARK: - Setup

    private func refreshAuthState() {
        switch MPMediaLibrary.authorizationStatus() {
        case .authorized:    authState = .authorized
        case .denied:        authState = .denied
        case .restricted:    authState = .restricted
        case .notDetermined: authState = .notDetermined
        @unknown default:    authState = .unknown
        }
    }

    private func startObservingIfPossible() {
        guard !isObserving else { return }
        guard authState == .authorized else { return }

        player.beginGeneratingPlaybackNotifications()
        isObserving = true

        let nowPlayingObs = notifier.addObserver(
            forName: .MPMusicPlayerControllerNowPlayingItemDidChange,
            object: player, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.snapshot() } }

        let stateObs = notifier.addObserver(
            forName: .MPMusicPlayerControllerPlaybackStateDidChange,
            object: player, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.snapshot() } }

        observers = [nowPlayingObs, stateObs]

        // Refresh elapsed time periodically so the Lens can display a smooth progress bar.
        // Also retry artwork capture here: Apple Music streaming often returns a nil
        // `MPMediaItem.artwork` at the exact moment a track begins playing and only
        // fills it in a few seconds later once the image download completes. When the
        // retry finally succeeds, we issue a full `snapshot()` so the payload's
        // version tag changes from `<id>-noart` → `<id>-<hash>`, which trips the
        // throttled Combine pipeline and pushes a fresh `nowPlaying` to the lens —
        // prompting it to re-issue the asset request.
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.artworkData == nil, let item = self.player.nowPlayingItem {
                    self.updateArtwork(for: item)
                    if self.artworkData != nil {
                        self.snapshot()
                        return
                    }
                }
                self.snapshotElapsedOnly()
            }
        }
    }

    // MARK: - Snapshot

    private func snapshot() {
        let item = player.nowPlayingItem
        let persistentID = item?.persistentID ?? 0

        // Capture artwork on track change OR whenever we still don't have any
        // for the current track (Apple Music streaming often returns a nil
        // `MPMediaItem.artwork` at the moment a track begins and only fills it
        // in a few seconds later once the image download completes).
        let trackChanged = persistentID != lastPersistentID
        let needsArtworkRetry = persistentID != 0 && artworkData == nil
        if trackChanged {
            lastPersistentID = persistentID
            artworkVersionTag = nil
            artworkData = nil
            artworkImage = nil
            updateArtwork(for: item)
        } else if needsArtworkRetry {
            updateArtwork(for: item)
        }

        let isPlaying = player.playbackState == .playing
        let durationSeconds = item?.playbackDuration ?? 0
        let elapsedSeconds = player.currentPlaybackTime.isFinite ? player.currentPlaybackTime : 0

        let title = item?.title ?? (item == nil ? "Nothing playing" : "Unknown title")
        let artist = item?.artist ?? ""
        let album = item?.albumTitle ?? ""

        // Encode "did we successfully grab artwork for this track?" into the
        // version tag so the lens sees a fresh version when artwork transitions
        // nil → present and re-issues the asset request.
        let version: String? = {
            guard persistentID != 0 else { return nil }
            if let tag = artworkVersionTag { return "\(persistentID)-\(tag)" }
            return "\(persistentID)-noart"
        }()

        let payload = NowPlayingPayload(
            title: title,
            artist: artist,
            album: album,
            isPlaying: isPlaying,
            artworkVersion: version,
            durationMs: Int((durationSeconds * 1000).rounded()),
            elapsedMs: Int((max(elapsedSeconds, 0) * 1000).rounded())
        )

        self.payload = payload
    }

    private func snapshotElapsedOnly() {
        guard let existing = payload else { return }
        let elapsedSeconds = player.currentPlaybackTime.isFinite ? player.currentPlaybackTime : 0
        let isPlaying = player.playbackState == .playing
        let updated = NowPlayingPayload(
            title: existing.title,
            artist: existing.artist,
            album: existing.album,
            isPlaying: isPlaying,
            artworkVersion: existing.artworkVersion,
            durationMs: existing.durationMs,
            elapsedMs: Int((max(elapsedSeconds, 0) * 1000).rounded())
        )
        // Avoid re-publishing identical payloads to keep SwiftUI updates minimal.
        if updated != existing {
            payload = updated
        }
    }

    /// Tries to capture artwork for the current item. Safe to call repeatedly:
    /// it never overwrites existing `artworkData` with nil (a transient nil
    /// during a retry should not wipe out a good cached image — only
    /// `snapshot()` clears state on track change).
    ///
    /// Encoding choices:
    ///   - We force-redraw the image at `Self.artworkTargetSize` because
    ///     `MPMediaItemArtwork.image(at:)` does NOT guarantee the requested
    ///     size — for Apple Music streamed artwork it routinely returns the
    ///     original (e.g. 1284×1284) cached image regardless of what was
    ///     asked for, blowing up to ~700KB after PNG encoding and saturating
    ///     the BLE link (`WARNING: Unknown error: 431`, force-close after
    ///     5s, then `autoReconnect` stomping on itself with
    ///     `reentrantL2CAPRequest`).
    ///   - We encode JPEG instead of PNG because BLE is a precious shared
    ///     resource here. A 384×384 album cover at quality 0.85 is ~30–60KB
    ///     vs ~150KB+ for PNG, with no perceptible quality loss for the
    ///     lens-side display.
    private func updateArtwork(for item: MPMediaItem?) {
        guard let artwork = item?.artwork else {
            print("[NowPlaying] artwork: MPMediaItem.artwork is nil")
            return
        }

        // Try the API-provided rendering first; fall back to the native bounds
        // (some streamed tracks only expose one cached size).
        let raw =
            artwork.image(at: Self.artworkTargetSize)
            ?? artwork.image(at: artwork.bounds.size)
        guard let raw else {
            print("[NowPlaying] artwork: image(at:) returned nil for both target & bounds")
            return
        }

        let resized = Self.resize(raw, to: Self.artworkTargetSize)
        guard let bytes = resized.jpegData(compressionQuality: 0.85), !bytes.isEmpty else {
            print("[NowPlaying] artwork: jpegData encoding failed")
            return
        }

        artworkImage = resized
        artworkData = bytes
        artworkVersionTag = String(bytes.sha256Hash().prefix(8))
        print(
            "[NowPlaying] artwork captured: "
            + "\(bytes.count)B JPEG (\(Int(resized.size.width))x\(Int(resized.size.height))) "
            + "tag=\(artworkVersionTag ?? "nil") rawNative=\(Int(raw.size.width))x\(Int(raw.size.height))"
        )
    }

    /// Target dimensions for the album-art delivered to the lens. Chosen so
    /// the resulting JPEG fits comfortably in a single BLE-friendly transfer
    /// while still looking sharp on the Spectacles display.
    private static let artworkTargetSize = CGSize(width: 384, height: 384)

    /// Forces a hard redraw of `image` at `size` (guaranteed output dimensions),
    /// because `MPMediaItemArtwork.image(at:)` returns the closest cached
    /// representation rather than honoring the requested size. We use the
    /// non-Retina renderer (`scale = 1`) so the resulting bitmap is exactly
    /// `size` pixels — otherwise on a @3x device we'd get 1152×1152 back.
    private static func resize(_ image: UIImage, to size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
