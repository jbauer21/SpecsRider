// Copyright © 2026 SpecsRider.
// JSON payload that the Lens consumes via the "nowPlaying" subscription topic.

import Foundation

struct NowPlayingPayload: Codable, Hashable, Sendable {
    let title: String
    let artist: String
    let album: String
    let isPlaying: Bool
    /// Stable identifier for the current track + artwork pair. The lens uses
    /// this as the cache version when fetching the album-art JPEG over
    /// `spectacleskit://albumArt.jpg`. The format is `"<persistentID>-<tag>"`
    /// where `tag` is either `noart` (artwork not yet captured) or the first
    /// 8 hex chars of the SHA-256 of the JPEG bytes; the transition from
    /// `noart` → `<hash>` is what tells the lens to re-issue the asset
    /// download once iOS finishes streaming the artwork.
    let artworkVersion: String?
    let durationMs: Int
    let elapsedMs: Int

    func toJSONData() throws -> Data {
        try JSONEncoder().encode(self)
    }

    func toJSONString() -> String {
        guard let data = try? toJSONData(),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}
