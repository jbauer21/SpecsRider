// Copyright © 2026 SpecsRider.
// Resolves an address into a cycling route via MapKit and samples it every 25 m.

import Combine
import CoreLocation
import Foundation
@preconcurrency import MapKit

@MainActor
final class RouteService: ObservableObject {

    enum RoutingError: LocalizedError {
        case addressNotFound
        case noRouteFound
        case destinationUnreachable
        case underlying(Error)

        var errorDescription: String? {
            switch self {
            case .addressNotFound:
                return "Couldn't find that address. Please double-check the spelling."
            case .noRouteFound:
                return "No cycling route is available between those points."
            case .destinationUnreachable:
                return "That destination is too far from your current location to route on foot. Try an address closer by."
            case .underlying(let e):
                return e.localizedDescription
            }
        }
    }

    /// Default sampling spacing in meters.
    static let defaultSpacingMeters: CLLocationDistance = 25

    @Published private(set) var current: RoutePayload?
    @Published private(set) var lastPolyline: MKPolyline?
    @Published private(set) var lastDestination: CLLocationCoordinate2D?
    @Published private(set) var isComputing: Bool = false

    /// Computes a cycling route from `origin` (or San Francisco as a sensible fallback) to the
    /// resolved destination of `address`, samples it every `spacing` meters, and stores the
    /// resulting payload on `current`.
    @discardableResult
    func computeRoute(
        address: String,
        origin: CLLocationCoordinate2D? = nil,
        spacing: CLLocationDistance = RouteService.defaultSpacingMeters
    ) async throws -> RoutePayload {
        isComputing = true
        defer { isComputing = false }

        let destinationPlacemark = try await resolveAddress(address)
        guard let destination = destinationPlacemark.location?.coordinate else {
            throw RoutingError.addressNotFound
        }

        // The caller is expected to supply the device's current location. We fall back to
        // San Francisco only as a last resort for demos/previews where no fix is available;
        // walking-directions calls otherwise tend to fail with `directionsNotFound` because
        // the hardcoded origin is nowhere near the user.
        let originCoord = origin ?? CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194)

        let route = try await computeBicycleRoute(from: originCoord, to: destination)
        let polyline = route.polyline
        let samples = Self.samplePolyline(polyline, every: spacing)
        let total = route.distance

        let payload = RoutePayload(
            address: address,
            totalMeters: total,
            sampleSpacingMeters: spacing,
            points: samples
        )

        self.current = payload
        self.lastPolyline = polyline
        self.lastDestination = destination
        return payload
    }

    func clear() {
        current = nil
        lastPolyline = nil
        lastDestination = nil
    }

    // MARK: - Address resolution

    private func resolveAddress(_ address: String) async throws -> CLPlacemark {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = address
        let search = MKLocalSearch(request: request)
        do {
            let response = try await search.start()
            if let mapItem = response.mapItems.first {
                return mapItem.placemark
            }
        } catch {
            // Fall through to CLGeocoder on failure.
        }

        let geocoder = CLGeocoder()
        do {
            let placemarks = try await geocoder.geocodeAddressString(address)
            if let first = placemarks.first { return first }
            throw RoutingError.addressNotFound
        } catch let routingError as RoutingError {
            throw routingError
        } catch {
            throw RoutingError.underlying(error)
        }
    }

    // MARK: - Routing

    private func computeBicycleRoute(
        from origin: CLLocationCoordinate2D,
        to destination: CLLocationCoordinate2D
    ) async throws -> MKRoute {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        // Apple Maps does not expose dedicated cycling directions through MKDirections —
        // cycling routes are only surfaced in the Maps app UI. Walking is the closest
        // analogue available via the public API and produces a sensible polyline that the
        // Lens can consume as a coarse cycling guide.
        request.transportType = .walking
        request.requestsAlternateRoutes = false

        let directions = MKDirections(request: request)
        do {
            let response = try await directions.calculate()
            guard let best = response.routes.first else {
                throw RoutingError.noRouteFound
            }
            return best
        } catch let routingError as RoutingError {
            throw routingError
        } catch let mkError as MKError where mkError.code == .directionsNotFound {
            // MKDirections reports "directions not available" when origin and destination
            // are too far apart for walking. Surface a more helpful message instead of the
            // raw system string.
            throw RoutingError.destinationUnreachable
        } catch {
            throw RoutingError.underlying(error)
        }
    }

    // MARK: - Polyline sampling

    /// Walks the polyline's points (in projected map space) and emits a sample every
    /// `spacing` meters. The first and last points of the route are always emitted.
    /// Each emitted sample carries its cumulative distance from the start in meters.
    static func samplePolyline(
        _ polyline: MKPolyline,
        every spacing: CLLocationDistance
    ) -> [RoutePoint] {
        guard polyline.pointCount > 0 else { return [] }
        let count = polyline.pointCount
        let pointsBuffer = polyline.points()
        var mapPoints = [MKMapPoint](repeating: MKMapPoint(), count: count)
        for i in 0..<count { mapPoints[i] = pointsBuffer[i] }

        var samples: [RoutePoint] = []
        let firstCoord = mapPoints[0].coordinate
        samples.append(RoutePoint(lat: firstCoord.latitude, lon: firstCoord.longitude, meters: 0))

        var cumulative: CLLocationDistance = 0
        var nextThreshold: CLLocationDistance = spacing

        for i in 1..<count {
            let a = mapPoints[i - 1]
            let b = mapPoints[i]
            let segmentMeters = a.distance(to: b)
            guard segmentMeters > 0 else { continue }

            // Emit a sample at every multiple of `spacing` that falls inside this segment.
            while nextThreshold <= cumulative + segmentMeters {
                let into = nextThreshold - cumulative
                let t = into / segmentMeters
                let mp = MKMapPoint(
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t
                )
                let coord = mp.coordinate
                samples.append(RoutePoint(
                    lat: coord.latitude,
                    lon: coord.longitude,
                    meters: nextThreshold
                ))
                nextThreshold += spacing
            }

            cumulative += segmentMeters
        }

        // Ensure the final route point is always represented so the Lens can see the destination.
        let lastCoord = mapPoints[count - 1].coordinate
        if let last = samples.last {
            let dLat = abs(last.lat - lastCoord.latitude)
            let dLon = abs(last.lon - lastCoord.longitude)
            if dLat > 1e-7 || dLon > 1e-7 {
                samples.append(RoutePoint(
                    lat: lastCoord.latitude,
                    lon: lastCoord.longitude,
                    meters: cumulative
                ))
            }
        }

        return samples
    }
}
