// Copyright © 2026 SpecsRider.
// Minimal async client for the OpenStreetMap Overpass API. Fetches highway
// ways (with inline node geometry) inside a bounding box, one corridor tile
// at a time, with an in-memory cache keyed by tile bbox.

import Foundation

/// One OSM way as returned by Overpass `out geom;`: an ordered node
/// polyline plus its tags.
struct OverpassWay: Sendable {
    let id: Int64
    let tags: [String: String]
    /// Ordered node coordinates (the road centerline geometry).
    let geometry: [OverpassCoordinate]
}

/// Lightweight lat/lon pair (avoids importing CoreLocation into decode types).
struct OverpassCoordinate: Sendable {
    let lat: Double
    let lon: Double
}

/// Errors surfaced by `OverpassClient`. All are non-fatal to routing: the
/// caller is expected to fall back to the raw MapKit polyline.
enum OverpassError: LocalizedError {
    case badStatus(Int)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .badStatus(let code):
            return "Overpass API returned HTTP \(code)."
        case .malformedResponse:
            return "Overpass API returned an unreadable response."
        }
    }
}

/// Async HTTPS client for the Overpass API.
///
/// Queries are scoped to `way["highway"]` so only road-like geometry is
/// returned. Results are cached in memory per bbox so overlapping /
/// re-computed routes don't re-fetch identical tiles within a session.
actor OverpassClient {

    /// Public Overpass instance. Configurable for tests / self-hosting.
    private let endpoint: URL
    private let session: URLSession
    private var cache: [String: [OverpassWay]] = [:]

    /// Highway classes that can never carry a cycling route; excluded to
    /// keep responses small and to stop the matcher snapping to motorways.
    private static let excludedHighwayValues = [
        "motorway", "motorway_link", "proposed", "construction", "raceway", "abandoned",
    ]

    init(
        endpoint: URL = URL(string: "https://overpass-api.de/api/interpreter")!,
        timeout: TimeInterval = 20
    ) {
        self.endpoint = endpoint
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout * 2
        self.session = URLSession(configuration: config)
    }

    /// Fetches all candidate road ways inside `box`, using the cache when
    /// the exact tile has been fetched before in this session.
    func fetchRoadWays(in box: GeoBoundingBox) async throws -> [OverpassWay] {
        if let cached = cache[box.cacheKey] {
            return cached
        }

        let query = Self.buildQuery(for: box)
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(
            "application/x-www-form-urlencoded; charset=utf-8",
            forHTTPHeaderField: "Content-Type"
        )
        request.setValue("SpecsRider/1.0 (cycling AR companion)", forHTTPHeaderField: "User-Agent")
        let body = "data=" + (query.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? query)
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw OverpassError.badStatus(http.statusCode)
        }

        let ways = try Self.decodeWays(from: data)
        cache[box.cacheKey] = ways
        return ways
    }

    /// Convenience: fetch and concatenate ways for every chunk, de-duplicating
    /// ways that appear in multiple overlapping tiles.
    func fetchRoadWays(for chunks: [RouteChunk]) async throws -> [OverpassWay] {
        var seen = Set<Int64>()
        var all: [OverpassWay] = []
        for chunk in chunks {
            let ways = try await fetchRoadWays(in: chunk.boundingBox)
            for way in ways where !seen.contains(way.id) {
                seen.insert(way.id)
                all.append(way)
            }
        }
        return all
    }

    // MARK: - Query construction

    static func buildQuery(for box: GeoBoundingBox) -> String {
        let exclusion = excludedHighwayValues.joined(separator: "|")
        return """
        [out:json][timeout:20];
        way["highway"]["highway"!~"^(\(exclusion))$"](\(box.overpassString));
        out geom;
        """
    }

    // MARK: - Response decoding

    private struct OverpassResponse: Decodable {
        let elements: [Element]

        struct Element: Decodable {
            let type: String
            let id: Int64
            let tags: [String: String]?
            let geometry: [Point]?

            struct Point: Decodable {
                let lat: Double
                let lon: Double
            }
        }
    }

    static func decodeWays(from data: Data) throws -> [OverpassWay] {
        let decoded: OverpassResponse
        do {
            decoded = try JSONDecoder().decode(OverpassResponse.self, from: data)
        } catch {
            throw OverpassError.malformedResponse
        }
        return decoded.elements.compactMap { element in
            guard element.type == "way",
                  let geometry = element.geometry,
                  geometry.count >= 2 else { return nil }
            return OverpassWay(
                id: element.id,
                tags: element.tags ?? [:],
                geometry: geometry.map { OverpassCoordinate(lat: $0.lat, lon: $0.lon) }
            )
        }
    }
}
