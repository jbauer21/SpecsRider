// Copyright © 2026 SpecsRider.
// Map-matches a MapKit route polyline onto OSM road centerlines and
// rebuilds the true curve geometry between matched positions, emitting a
// curvature-adaptively densified point list for the Lens.

import CoreLocation
import Foundation

/// Snaps route samples to a `RoadGraph` and reconstructs road-accurate
/// geometry. Stateless; all knobs live in `Config`.
struct RouteMatcher {

    struct Config {
        /// Samples farther than this from any road pass through unsnapped.
        var maxSnapDistanceMeters: Double = 30
        /// Extra cost (in meters-equivalent) for jumping to a different OSM
        /// way than the previous sample matched. Keeps the match glued to
        /// one road through intersections instead of ping-ponging between
        /// crossing streets.
        var waySwitchPenaltyMeters: Double = 12
        /// Minimum fraction of samples that must snap for the match to be
        /// trusted. Below this the caller should fall back to the raw
        /// MapKit polyline.
        var minMatchedRatio: Double = 0.5
        /// Densification: spacing through curves.
        var minSpacingMeters: Double = 2.5
        /// Densification: spacing on straights.
        var maxSpacingMeters: Double = 15
        /// Heading change (degrees) that forces a point at `minSpacing`.
        var curvatureAngleDegrees: Double = 4

        init() {}
    }

    let config: Config

    init(config: Config = Config()) {
        self.config = config
    }

    /// Matches `samples` against `graph` and returns road-snapped, adaptively
    /// densified points with recomputed cumulative meters. Returns nil when
    /// too few samples land on a road (caller falls back to `samples`).
    func match(samples: [RoutePoint], graph: RoadGraph) -> [RoutePoint]? {
        guard samples.count >= 2, !graph.isEmpty else { return nil }

        // -- Pass 1: pick a snap per sample with way-continuity scoring.
        var snaps: [RoadSnap?] = []
        snaps.reserveCapacity(samples.count)
        var previousWayID: Int64?
        var matchedCount = 0

        for sample in samples {
            let coordinate = CLLocationCoordinate2D(latitude: sample.lat, longitude: sample.lon)
            let candidates = graph.candidateSnaps(
                for: coordinate,
                maxDistanceMeters: config.maxSnapDistanceMeters
            )
            guard !candidates.isEmpty else {
                snaps.append(nil)
                previousWayID = nil
                continue
            }
            let best = candidates.min { lhs, rhs in
                cost(of: lhs, previousWayID: previousWayID)
                    < cost(of: rhs, previousWayID: previousWayID)
            }!
            snaps.append(best)
            previousWayID = best.wayID
            matchedCount += 1
        }

        let ratio = Double(matchedCount) / Double(samples.count)
        guard ratio >= config.minMatchedRatio else { return nil }

        // -- Pass 2: rebuild geometry. Between consecutive snaps on the same
        // way, splice in the OSM node run so curves follow the real road
        // instead of chording between 25 m samples.
        var polyline: [CLLocationCoordinate2D] = []
        for i in 0..<samples.count {
            let point: CLLocationCoordinate2D
            if let snap = snaps[i] {
                point = snap.coordinate
            } else {
                point = CLLocationCoordinate2D(latitude: samples[i].lat, longitude: samples[i].lon)
            }

            if i > 0, let prev = snaps[i - 1], let curr = snaps[i],
               prev.wayIndex == curr.wayIndex {
                polyline.append(contentsOf: graph.nodesBetween(
                    wayIndex: curr.wayIndex,
                    fromMeters: prev.alongWayMeters,
                    toMeters: curr.alongWayMeters
                ))
            }

            if let last = polyline.last {
                let dLat = abs(last.latitude - point.latitude)
                let dLon = abs(last.longitude - point.longitude)
                if dLat < 1e-7 && dLon < 1e-7 {
                    continue
                }
            }
            polyline.append(point)
        }
        guard polyline.count >= 2 else { return nil }

        // -- Pass 3: curvature-adaptive densification.
        let densified = Self.adaptiveDensify(
            polyline,
            minSpacing: config.minSpacingMeters,
            maxSpacing: config.maxSpacingMeters,
            curvatureAngleDegrees: config.curvatureAngleDegrees
        )
        guard densified.count >= 2 else { return nil }

        // -- Pass 4: cumulative meters.
        var result: [RoutePoint] = []
        result.reserveCapacity(densified.count)
        var cumulative = 0.0
        for (i, coord) in densified.enumerated() {
            if i > 0 {
                cumulative += Self.haversineMeters(densified[i - 1], coord)
            }
            result.append(RoutePoint(
                lat: coord.latitude, lon: coord.longitude, meters: cumulative
            ))
        }
        return result
    }

    private func cost(of snap: RoadSnap, previousWayID: Int64?) -> Double {
        var cost = snap.distanceMeters
        if let previousWayID, snap.wayID != previousWayID {
            cost += config.waySwitchPenaltyMeters
        }
        return cost
    }

    // MARK: - Adaptive densification

    /// Resamples `polyline` so spacing shrinks to `minSpacing` through
    /// curves and stretches to `maxSpacing` on straights. Works in two
    /// steps: a fine uniform resample (at `minSpacing`), then a decimation
    /// pass that keeps a fine point whenever the heading has turned by more
    /// than `curvatureAngleDegrees` or `maxSpacing` has elapsed.
    static func adaptiveDensify(
        _ polyline: [CLLocationCoordinate2D],
        minSpacing: Double,
        maxSpacing: Double,
        curvatureAngleDegrees: Double
    ) -> [CLLocationCoordinate2D] {
        guard polyline.count >= 2 else { return polyline }
        let fine = resampleUniform(polyline, spacing: max(0.5, minSpacing))
        guard fine.count > 2 else { return fine }

        let angleThresholdRad = curvatureAngleDegrees * .pi / 180
        var kept: [CLLocationCoordinate2D] = [fine[0]]
        var distanceSinceKept = 0.0
        var headingAtKept = headingRadians(fine[0], fine[1])

        for i in 1..<(fine.count - 1) {
            let stepMeters = haversineMeters(fine[i - 1], fine[i])
            distanceSinceKept += stepMeters
            let headingHere = headingRadians(fine[i], fine[i + 1])
            let turn = abs(angleDifference(headingHere, headingAtKept))

            let curveForces = turn >= angleThresholdRad && distanceSinceKept >= minSpacing
            let straightForces = distanceSinceKept >= maxSpacing
            if curveForces || straightForces {
                kept.append(fine[i])
                distanceSinceKept = 0
                headingAtKept = headingHere
            }
        }
        kept.append(fine[fine.count - 1])
        return kept
    }

    /// Uniform linear resample along the polyline at `spacing` meters.
    /// Original vertices are preserved so sharp corners are never rounded off.
    static func resampleUniform(
        _ polyline: [CLLocationCoordinate2D],
        spacing: Double
    ) -> [CLLocationCoordinate2D] {
        guard polyline.count >= 2 else { return polyline }
        var out: [CLLocationCoordinate2D] = [polyline[0]]
        for i in 1..<polyline.count {
            let a = polyline[i - 1]
            let b = polyline[i]
            let segMeters = haversineMeters(a, b)
            if segMeters > spacing {
                let steps = Int(segMeters / spacing)
                for s in 1...steps {
                    let t = Double(s) * spacing / segMeters
                    guard t < 1 else { break }
                    out.append(CLLocationCoordinate2D(
                        latitude: a.latitude + (b.latitude - a.latitude) * t,
                        longitude: a.longitude + (b.longitude - a.longitude) * t
                    ))
                }
            }
            out.append(b)
        }
        return out
    }

    // MARK: - Geo helpers

    static func haversineMeters(
        _ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D
    ) -> Double {
        let r = 6_371_008.8
        let toRad = Double.pi / 180
        let dLat = (b.latitude - a.latitude) * toRad
        let dLon = (b.longitude - a.longitude) * toRad
        let lat1 = a.latitude * toRad
        let lat2 = b.latitude * toRad
        let s = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return r * 2 * atan2(s.squareRoot(), (1 - s).squareRoot())
    }

    static func headingRadians(
        _ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D
    ) -> Double {
        let toRad = Double.pi / 180
        let lat1 = a.latitude * toRad
        let lat2 = b.latitude * toRad
        let dLon = (b.longitude - a.longitude) * toRad
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        return atan2(y, x)
    }

    /// Signed smallest difference between two angles, in (-pi, pi].
    static func angleDifference(_ a: Double, _ b: Double) -> Double {
        var d = a - b
        while d > .pi { d -= 2 * .pi }
        while d <= -.pi { d += 2 * .pi }
        return d
    }
}
