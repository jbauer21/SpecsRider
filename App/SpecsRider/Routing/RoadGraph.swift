// Copyright © 2026 SpecsRider.
// In-memory index of OSM road geometry. Ways are projected onto a local
// planar frame and their segments bucketed into a coarse spatial grid so
// nearest-edge / snap queries stay cheap during map matching.

import CoreLocation
import Foundation

/// Result of snapping a coordinate onto the nearest road segment.
struct RoadSnap {
    /// The snapped point back in WGS84.
    let coordinate: CLLocationCoordinate2D
    /// Planar distance from the query point to the snapped point (meters).
    let distanceMeters: Double
    /// OSM way id owning the segment (for continuity scoring).
    let wayID: Int64
    /// Index into `RoadGraph.ways`.
    let wayIndex: Int
    /// Segment index within the way: the segment runs from node
    /// `segmentIndex` to node `segmentIndex + 1`.
    let segmentIndex: Int
    /// Interpolation parameter within the segment, 0...1.
    let t: Double
    /// Distance along the way from its first node to the snapped point (meters).
    let alongWayMeters: Double
}

/// Planar road-segment index over a set of Overpass ways.
///
/// All internal math uses a local equirectangular projection (meters east /
/// north of the graph's reference point). Accurate to well under a meter at
/// corridor scale, which is all the matcher needs.
struct RoadGraph {

    /// Projected point: meters east (x) / north (y) of `origin`.
    struct PlanarPoint {
        var x: Double
        var y: Double
    }

    private struct Segment {
        let wayIndex: Int
        let segmentIndex: Int
        let a: PlanarPoint
        let b: PlanarPoint
        /// Cumulative along-way meters at node `a`.
        let alongWayStartMeters: Double
    }

    /// Source ways, retained so the matcher can walk node sequences.
    let ways: [OverpassWay]

    private let origin: CLLocationCoordinate2D
    private let metersPerDegreeLon: Double
    private var segments: [Segment] = []
    private var grid: [Int64: [Int]] = [:]
    /// Projected node polylines, parallel to `ways`.
    private var wayPlanar: [[PlanarPoint]] = []
    /// Cumulative along-way distance per node, parallel to `ways`.
    private var wayCumulative: [[Double]] = []

    private static let cellSizeMeters: Double = 50
    private static let metersPerDegreeLat: Double = 111_132.0

    var isEmpty: Bool { segments.isEmpty }

    /// Builds the graph. `referencePoint` fixes the projection origin; pass
    /// any coordinate near the route (e.g. its first sample).
    init(ways: [OverpassWay], referencePoint: CLLocationCoordinate2D) {
        self.ways = ways
        self.origin = referencePoint
        self.metersPerDegreeLon = 111_320.0 * cos(referencePoint.latitude * .pi / 180)

        wayPlanar.reserveCapacity(ways.count)
        wayCumulative.reserveCapacity(ways.count)

        for (wayIndex, way) in ways.enumerated() {
            var planar: [PlanarPoint] = []
            planar.reserveCapacity(way.geometry.count)
            for node in way.geometry {
                planar.append(project(lat: node.lat, lon: node.lon))
            }

            var cumulative: [Double] = [0]
            cumulative.reserveCapacity(planar.count)
            for i in 1..<planar.count {
                cumulative.append(cumulative[i - 1] + Self.distance(planar[i - 1], planar[i]))
            }

            wayPlanar.append(planar)
            wayCumulative.append(cumulative)

            for i in 0..<(planar.count - 1) {
                let segment = Segment(
                    wayIndex: wayIndex,
                    segmentIndex: i,
                    a: planar[i],
                    b: planar[i + 1],
                    alongWayStartMeters: cumulative[i]
                )
                let segIdx = segments.count
                segments.append(segment)
                insertIntoGrid(segment: segment, index: segIdx)
            }
        }
    }

    // MARK: - Queries

    /// Snaps `coordinate` to the closest road segment within
    /// `maxDistanceMeters`, or nil when no road is near enough.
    func snap(
        _ coordinate: CLLocationCoordinate2D,
        maxDistanceMeters: Double
    ) -> RoadSnap? {
        candidateSnaps(for: coordinate, maxDistanceMeters: maxDistanceMeters)
            .min { $0.distanceMeters < $1.distanceMeters }
    }

    /// All snap candidates within `maxDistanceMeters`, at most one (the
    /// closest) per way. Multiple candidates let the matcher trade pure
    /// proximity against way continuity.
    func candidateSnaps(
        for coordinate: CLLocationCoordinate2D,
        maxDistanceMeters: Double
    ) -> [RoadSnap] {
        let p = project(lat: coordinate.latitude, lon: coordinate.longitude)
        let cellRadius = Int(ceil(maxDistanceMeters / Self.cellSizeMeters))
        let centerCX = Int(floor(p.x / Self.cellSizeMeters))
        let centerCY = Int(floor(p.y / Self.cellSizeMeters))

        var bestPerWay: [Int: RoadSnap] = [:]

        for cx in (centerCX - cellRadius)...(centerCX + cellRadius) {
            for cy in (centerCY - cellRadius)...(centerCY + cellRadius) {
                guard let bucket = grid[Self.cellKey(cx: cx, cy: cy)] else { continue }
                for segIdx in bucket {
                    let seg = segments[segIdx]
                    let (proj, t, dist) = Self.projectOntoSegment(p, seg.a, seg.b)
                    guard dist <= maxDistanceMeters else { continue }
                    if let existing = bestPerWay[seg.wayIndex],
                       existing.distanceMeters <= dist {
                        continue
                    }
                    let segLen = Self.distance(seg.a, seg.b)
                    bestPerWay[seg.wayIndex] = RoadSnap(
                        coordinate: unproject(proj),
                        distanceMeters: dist,
                        wayID: ways[seg.wayIndex].id,
                        wayIndex: seg.wayIndex,
                        segmentIndex: seg.segmentIndex,
                        t: t,
                        alongWayMeters: seg.alongWayStartMeters + t * segLen
                    )
                }
            }
        }

        return Array(bestPerWay.values)
    }

    /// Node coordinates of `wayIndex` strictly between two along-way
    /// positions, ordered from `fromMeters` toward `toMeters`. This is the
    /// true curve geometry between two snapped positions on the same way.
    func nodesBetween(
        wayIndex: Int,
        fromMeters: Double,
        toMeters: Double
    ) -> [CLLocationCoordinate2D] {
        guard wayIndex >= 0, wayIndex < ways.count else { return [] }
        let cumulative = wayCumulative[wayIndex]
        let geometry = ways[wayIndex].geometry
        let lo = min(fromMeters, toMeters)
        let hi = max(fromMeters, toMeters)

        var result: [CLLocationCoordinate2D] = []
        for i in 0..<geometry.count where cumulative[i] > lo && cumulative[i] < hi {
            result.append(CLLocationCoordinate2D(
                latitude: geometry[i].lat, longitude: geometry[i].lon
            ))
        }
        if toMeters < fromMeters {
            result.reverse()
        }
        return result
    }

    // MARK: - Projection helpers

    private func project(lat: Double, lon: Double) -> PlanarPoint {
        PlanarPoint(
            x: (lon - origin.longitude) * metersPerDegreeLon,
            y: (lat - origin.latitude) * Self.metersPerDegreeLat
        )
    }

    private func unproject(_ p: PlanarPoint) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: origin.latitude + p.y / Self.metersPerDegreeLat,
            longitude: origin.longitude + p.x / metersPerDegreeLon
        )
    }

    private static func distance(_ a: PlanarPoint, _ b: PlanarPoint) -> Double {
        let dx = b.x - a.x
        let dy = b.y - a.y
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Projects `p` onto segment `ab`; returns (projected point, clamped t,
    /// distance from p to the projection).
    private static func projectOntoSegment(
        _ p: PlanarPoint, _ a: PlanarPoint, _ b: PlanarPoint
    ) -> (PlanarPoint, Double, Double) {
        let abx = b.x - a.x
        let aby = b.y - a.y
        let lenSq = abx * abx + aby * aby
        var t = 0.0
        if lenSq > 1e-9 {
            t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
            t = min(1, max(0, t))
        }
        let proj = PlanarPoint(x: a.x + abx * t, y: a.y + aby * t)
        return (proj, t, distance(p, proj))
    }

    // MARK: - Grid

    private static func cellKey(cx: Int, cy: Int) -> Int64 {
        (Int64(cx) << 32) ^ (Int64(cy) & 0xFFFF_FFFF)
    }

    private mutating func insertIntoGrid(segment: Segment, index: Int) {
        // Insert into every cell the segment's bbox touches. Segments are
        // short (OSM node spacing), so this over-approximation is cheap.
        let minCX = Int(floor(min(segment.a.x, segment.b.x) / Self.cellSizeMeters))
        let maxCX = Int(floor(max(segment.a.x, segment.b.x) / Self.cellSizeMeters))
        let minCY = Int(floor(min(segment.a.y, segment.b.y) / Self.cellSizeMeters))
        let maxCY = Int(floor(max(segment.a.y, segment.b.y) / Self.cellSizeMeters))
        for cx in minCX...maxCX {
            for cy in minCY...maxCY {
                grid[Self.cellKey(cx: cx, cy: cy), default: []].append(index)
            }
        }
    }
}
