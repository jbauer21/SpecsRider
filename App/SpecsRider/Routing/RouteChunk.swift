// Copyright © 2026 SpecsRider.
// Spatial corridor chunking: splits a sampled route polyline into ~400 m
// chunks, each carrying a corridor-expanded bounding box suitable for a
// per-tile Overpass road-data fetch.

import CoreLocation
import Foundation

/// Axis-aligned geographic bounding box (WGS84 degrees).
struct GeoBoundingBox: Hashable, Sendable {
    var minLat: Double
    var minLon: Double
    var maxLat: Double
    var maxLon: Double

    /// Meters per degree of latitude (WGS84 mean).
    static let metersPerDegreeLat: Double = 111_132.0

    init(minLat: Double, minLon: Double, maxLat: Double, maxLon: Double) {
        self.minLat = minLat
        self.minLon = minLon
        self.maxLat = maxLat
        self.maxLon = maxLon
    }

    /// Tight box containing all `coordinates`. Returns nil for an empty input.
    init?(containing coordinates: [CLLocationCoordinate2D]) {
        guard let first = coordinates.first else { return nil }
        var box = GeoBoundingBox(
            minLat: first.latitude, minLon: first.longitude,
            maxLat: first.latitude, maxLon: first.longitude
        )
        for coord in coordinates.dropFirst() {
            box.expand(toInclude: coord)
        }
        self = box
    }

    var midLatitude: Double { (minLat + maxLat) / 2 }

    mutating func expand(toInclude coord: CLLocationCoordinate2D) {
        minLat = min(minLat, coord.latitude)
        maxLat = max(maxLat, coord.latitude)
        minLon = min(minLon, coord.longitude)
        maxLon = max(maxLon, coord.longitude)
    }

    /// Returns the box grown by `meters` on every side (corridor padding).
    func expanded(byMeters meters: Double) -> GeoBoundingBox {
        let dLat = meters / Self.metersPerDegreeLat
        let metersPerDegreeLon = 111_320.0 * cos(midLatitude * .pi / 180)
        let dLon = meters / max(metersPerDegreeLon, 1)
        return GeoBoundingBox(
            minLat: minLat - dLat,
            minLon: minLon - dLon,
            maxLat: maxLat + dLat,
            maxLon: maxLon + dLon
        )
    }

    /// True when `other` lies entirely inside this box.
    func contains(_ other: GeoBoundingBox) -> Bool {
        other.minLat >= minLat && other.maxLat <= maxLat
            && other.minLon >= minLon && other.maxLon <= maxLon
    }

    /// Overpass QL bbox order: (south, west, north, east).
    var overpassString: String {
        String(format: "%.6f,%.6f,%.6f,%.6f", minLat, minLon, maxLat, maxLon)
    }

    /// Cache key with enough precision (~1 m) to de-duplicate repeat fetches.
    var cacheKey: String { overpassString }
}

/// One corridor tile along the route: the contiguous slice of samples it
/// covers plus the padded bounding box to fetch OSM road data for.
struct RouteChunk: Sendable {
    /// Sequential index along the route (after de-duplication).
    let index: Int
    /// Indices into the original sample array covered by this chunk.
    /// Adjacent chunks share their boundary sample so matching stitches
    /// cleanly across tile edges.
    let sampleRange: ClosedRange<Int>
    /// Corridor-expanded bounding box for the Overpass fetch.
    let boundingBox: GeoBoundingBox

    /// Default arc length of one chunk before corridor padding.
    static let defaultChunkLengthMeters: Double = 400
    /// Default padding applied around each chunk's tight bbox. Covers GPS
    /// error plus the offset between a MapKit polyline and the OSM centerline.
    static let defaultCorridorRadiusMeters: Double = 40

    /// Splits `samples` (which carry cumulative `meters`) into corridor
    /// chunks of roughly `chunkLengthMeters` arc length each. Consecutive
    /// chunks whose padded bbox is contained in the previous chunk's bbox
    /// (e.g. switchbacks, dense loops) are merged away.
    static func corridorChunks(
        for samples: [RoutePoint],
        chunkLengthMeters: Double = RouteChunk.defaultChunkLengthMeters,
        corridorRadiusMeters: Double = RouteChunk.defaultCorridorRadiusMeters
    ) -> [RouteChunk] {
        guard samples.count >= 2 else {
            guard let only = samples.first else { return [] }
            let coord = CLLocationCoordinate2D(latitude: only.lat, longitude: only.lon)
            guard let box = GeoBoundingBox(containing: [coord]) else { return [] }
            return [RouteChunk(
                index: 0,
                sampleRange: 0...0,
                boundingBox: box.expanded(byMeters: corridorRadiusMeters)
            )]
        }

        var raw: [(range: ClosedRange<Int>, box: GeoBoundingBox)] = []
        var startIndex = 0
        var chunkStartMeters = samples[0].meters

        for i in 1..<samples.count {
            let isLast = i == samples.count - 1
            let lengthSoFar = samples[i].meters - chunkStartMeters
            guard lengthSoFar >= chunkLengthMeters || isLast else { continue }

            let range = startIndex...i
            let coords = samples[range].map {
                CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon)
            }
            if let tight = GeoBoundingBox(containing: coords) {
                raw.append((range, tight.expanded(byMeters: corridorRadiusMeters)))
            }
            // Share the boundary sample with the next chunk.
            startIndex = i
            chunkStartMeters = samples[i].meters
        }

        // De-duplicate: a chunk fully inside its predecessor's box adds no
        // new road data, so fold its sample range into the predecessor.
        var merged: [(range: ClosedRange<Int>, box: GeoBoundingBox)] = []
        for entry in raw {
            if let last = merged.last, last.box.contains(entry.box) {
                merged[merged.count - 1] = (
                    range: last.range.lowerBound...entry.range.upperBound,
                    box: last.box
                )
            } else {
                merged.append(entry)
            }
        }

        return merged.enumerated().map { offset, entry in
            RouteChunk(index: offset, sampleRange: entry.range, boundingBox: entry.box)
        }
    }
}
