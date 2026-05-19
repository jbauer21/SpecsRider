// Copyright © 2026 SpecsRider.
// Owns the subscription/request fan-out between the iOS data sources
// (RouteService, NowPlayingService, MusicController) and the Spectacles Lens.

import CryptoKit
import Foundation
import SpectaclesKit
import UIKit

/// Topic names used over the BLE bridge. The Lens uses these as the `method`
/// argument to `session.startSubscription(...)` or `session.sendRequest(...)`.
enum BridgeTopic {
    static let route = "route"
    static let nowPlaying = "nowPlaying"
    static let mediaPlay = "media/play"
    static let mediaPause = "media/pause"
    static let mediaNext = "media/next"
    static let mediaPrevious = "media/previous"
    static let mediaToggle = "media/toggle"

    /// Lens-facing URI for the now-playing album-art asset. The bytes are
    /// JPEG (see `NowPlayingService.updateArtwork`); the `.jpg` extension
    /// keeps the URI honest, even though `RemoteMediaModule` decodes by
    /// content rather than by extension.
    static let albumArtURI = "spectacleskit://albumArt.jpg"
    /// Bare filename the SpectaclesKit SDK actually surfaces in `SMKPMessage.path`
    /// for download requests. The lens sends the full `spectacleskit://albumArt.jpg`
    /// URI, but by the time it reaches `handle(assetLoad:)` the scheme has been
    /// stripped; matching against the bare filename is the only reliable form.
    static let albumArtPath = "albumArt.jpg"
}

/// Wrapper around an open subscription so we can track + tear it down by identity.
/// Marked `@unchecked Sendable` because all access flows through the @MainActor-isolated
/// `SpectaclesBridge.subscribers` map.
private final class SubscriberHandle: @unchecked Sendable {
    let topic: String
    let continuation: AsyncStream<Data>.Continuation

    init(topic: String, continuation: AsyncStream<Data>.Continuation) {
        self.topic = topic
        self.continuation = continuation
    }
}

@MainActor
final class SpectaclesBridge {

    // MARK: - Inputs

    let musicController: MusicController

    // MARK: - Latest state

    private(set) var lastRoutePayload: RoutePayload?
    private(set) var lastNowPlaying: NowPlayingPayload?
    /// JPEG bytes for the most recently captured album artwork. Mirrored
    /// here so that lens asset-download requests can be served synchronously
    /// without going back through `NowPlayingService`.
    private(set) var lastArtworkData: Data?
    private(set) var lastArtworkVersion: String?

    /// Surface of recent bridge events for diagnostics in the UI.
    var onDiagnostic: ((String) -> Void)?

    // MARK: - Subscribers

    private var subscribers: [String: [SubscriberHandle]] = [:]

    init(musicController: MusicController) {
        self.musicController = musicController
    }

    // MARK: - Publish

    func publishRoute(_ payload: RoutePayload?) {
        lastRoutePayload = payload
        guard let payload, let data = try? payload.toJSONData() else { return }
        broadcast(topic: BridgeTopic.route, data: data)
        onDiagnostic?("→ route: \(payload.points.count) points, \(Int(payload.totalMeters)) m")
    }

    func publishNowPlaying(_ payload: NowPlayingPayload?, artworkData: Data?) {
        lastNowPlaying = payload
        lastArtworkData = artworkData
        lastArtworkVersion = payload?.artworkVersion
        guard let payload, let data = try? payload.toJSONData() else { return }
        broadcast(topic: BridgeTopic.nowPlaying, data: data)
        let artBytes = artworkData?.count ?? 0
        let versionTag = payload.artworkVersion?.prefix(8) ?? "nil"
        onDiagnostic?("→ nowPlaying: \(payload.title) — \(payload.artist) [art=\(artBytes)B v=\(versionTag)]")
    }

    private func broadcast(topic: String, data: Data) {
        guard let listeners = subscribers[topic] else { return }
        for listener in listeners {
            listener.continuation.yield(data)
        }
    }

    // MARK: - Lens-initiated calls

    /// Routes an incoming `SpectaclesApiCallRequestProtocol` based on its `method`.
    /// Subscriptions hold the call open and yield updates as they arrive; transport
    /// commands complete immediately; anything else is treated as an echo for debug.
    ///
    /// The lens-side SDK encodes every Call request with one of two literal `path`
    /// values; the actual topic / method name is carried in the body:
    ///   - `session.startSubscription(topic, ...)`  → path = "subscribe", body = topic
    ///   - `session.sendRequest(method, body?)`     → path = "request",   body = method
    /// We normalise both into a single `effectiveMethod` (the topic / method string)
    /// so the dispatch switch can stay declarative. Anything else is left as-is.
    nonisolated func handle(call: any SpectaclesApiCallRequestProtocol) async {
        let rawMethod = call.method
        let effectiveMethod: String
        if rawMethod == "request" || rawMethod == "subscribe" {
            effectiveMethod = String(data: call.params, encoding: .utf8) ?? ""
        } else {
            effectiveMethod = rawMethod
        }

        switch effectiveMethod {
        case BridgeTopic.route:
            await runSubscription(topic: BridgeTopic.route, call: call) { @MainActor [weak self] in
                guard let payload = self?.lastRoutePayload else { return nil }
                return try? payload.toJSONData()
            }

        case BridgeTopic.nowPlaying:
            await runSubscription(topic: BridgeTopic.nowPlaying, call: call) { @MainActor [weak self] in
                guard let payload = self?.lastNowPlaying else { return nil }
                return try? payload.toJSONData()
            }

        case BridgeTopic.mediaPlay,
             BridgeTopic.mediaPause,
             BridgeTopic.mediaNext,
             BridgeTopic.mediaPrevious,
             BridgeTopic.mediaToggle:
            await runMediaCommand(method: effectiveMethod, call: call)

        default:
            // Reject unknown methods explicitly instead of echoing the method name
            // back as a string. Echoing produces non-JSON payloads on the Lens which
            // its `subscribeJson` parser then logs as `Unexpected character`. A clean
            // `.notFound` lets the Lens see the failure directly via its onError path.
            await MainActor.run { [weak self] in
                self?.onDiagnostic?("← unknown call: \(effectiveMethod) (raw method=\(rawMethod))")
            }
            call.finish(throwing: .notFound)
        }
    }

    /// Routes an asset load request. Returns the latest album art when the URI matches,
    /// otherwise falls back to bundled resources (`test.png` / `test.glb`) so existing
    /// demo Lens code continues to work unchanged.
    ///
    /// IMPORTANT: by the time the request reaches us, `asset.uri` may be either the
    /// full `spectacleskit://albumArt.jpg` form (lens-issued URI) or the bare path
    /// `albumArt.jpg` (what the SMKP wire actually carries — see device logs:
    /// `type: download, path: "albumArt.jpg"`). We normalise both forms here so the
    /// album-art branch fires regardless of which surface the SDK exposes.
    nonisolated func handle(assetLoad asset: any SpectaclesLoadAssetRequest) async {
        let uri = asset.uri
        let normalized = Self.stripScheme(uri)
        if uri == BridgeTopic.albumArtURI || normalized == BridgeTopic.albumArtPath {
            await MainActor.run { [weak self] in
                guard let self else {
                    asset.complete(throwing: .notFound)
                    return
                }
                if let bytes = self.lastArtworkData, !bytes.isEmpty {
                    let version = self.lastArtworkVersion ?? bytes.sha256Hash()
                    asset.complete(returning: SpectaclesAssetRequest.Asset(
                        name: BridgeTopic.albumArtPath, version: version, data: bytes
                    ))
                    self.onDiagnostic?("→ asset: \(BridgeTopic.albumArtPath) (v=\(version.prefix(8)), \(bytes.count)B, uri=\(uri))")
                } else {
                    asset.complete(throwing: .notFound)
                    self.onDiagnostic?("← asset: \(BridgeTopic.albumArtPath) unavailable (lastArtworkData=nil, uri=\(uri))")
                }
            }
            return
        }

        if let data = Self.bundledData(uri: uri) {
            let key = data.sha256Hash()
            asset.complete(returning: SpectaclesAssetRequest.Asset(name: key, version: key, data: data))
            await MainActor.run { [weak self] in self?.onDiagnostic?("→ asset: \(uri) (\(data.count) bytes)") }
        } else {
            asset.complete(throwing: .notFound)
            await MainActor.run { [weak self] in self?.onDiagnostic?("← asset not found: \(uri)") }
        }
    }

    private nonisolated static func stripScheme(_ uri: String) -> String {
        guard let range = uri.range(of: "://") else { return uri }
        return String(uri[range.upperBound...])
    }

    // MARK: - Subscription plumbing

    private nonisolated func runSubscription(
        topic: String,
        call: any SpectaclesApiCallRequestProtocol,
        initialSnapshot: @MainActor @escaping () -> Data?
    ) async {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        let handle = await MainActor.run { @MainActor [weak self] () -> SubscriberHandle in
            let h = SubscriberHandle(topic: topic, continuation: continuation)
            self?.subscribers[topic, default: []].append(h)
            self?.onDiagnostic?("← subscribe: \(topic) (active=\(self?.subscribers[topic]?.count ?? 0))")
            return h
        }

        let snapshot = await initialSnapshot()
        if let snapshot {
            call.yield(snapshot, isComplete: false)
        }

        // Drain stream until the underlying request is torn down (task cancellation).
        for await data in stream {
            call.yield(data, isComplete: false)
        }

        await MainActor.run { @MainActor [weak self] in
            self?.subscribers[topic]?.removeAll { $0 === handle }
            self?.onDiagnostic?("← unsubscribe: \(topic)")
        }
    }

    private nonisolated func runMediaCommand(method: String, call: any SpectaclesApiCallRequestProtocol) async {
        let command: MusicController.Command? = {
            switch method {
            case BridgeTopic.mediaPlay:     return .play
            case BridgeTopic.mediaPause:    return .pause
            case BridgeTopic.mediaNext:     return .next
            case BridgeTopic.mediaPrevious: return .previous
            case BridgeTopic.mediaToggle:   return .toggle
            default: return nil
            }
        }()

        guard let command else {
            call.finish(throwing: .badRequest)
            return
        }

        await MainActor.run { [weak self] in
            self?.musicController.handle(command)
            self?.onDiagnostic?("← media: \(command.rawValue)")
        }
        let ack = "ok".data(using: .utf8) ?? Data()
        call.yield(ack, isComplete: true)
    }

    // MARK: - Bundle fallback (preserves SDK demo behavior)

    private nonisolated static func bundledData(uri: String) -> Data? {
        // Strip an optional `spectacleskit://` scheme — the existing sample uses raw filenames.
        let cleaned: String
        if uri.hasPrefix("spectacleskit://") {
            cleaned = String(uri.dropFirst("spectacleskit://".count))
        } else {
            cleaned = uri
        }
        guard let dot = cleaned.lastIndex(of: ".") else { return nil }
        let base = String(cleaned[..<dot])
        let ext = String(cleaned[cleaned.index(after: dot)...])

        if ext.lowercased() == "png" {
            return UIImage(named: base + "." + ext)?.pngData()
        }
        guard let url = Bundle.main.url(forResource: base, withExtension: ext) else { return nil }
        return try? Data(contentsOf: url)
    }
}

// MARK: - Data hashing helper

extension Data {
    func sha256Hash() -> String {
        SHA256.hash(data: self).map { String(format: "%02hhx", $0) }.joined()
    }
}
