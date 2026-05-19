// Copyright © 2026 SpecsRider.
// Lightweight CoreLocation wrapper that requests when-in-use authorization and
// returns a single fresh fix as the route origin.

import CoreLocation
import Foundation

@MainActor
final class LocationProvider: NSObject, ObservableObject {

    enum LocationError: LocalizedError {
        case authorizationDenied
        case authorizationRestricted
        case unavailable
        case underlying(Error)

        var errorDescription: String? {
            switch self {
            case .authorizationDenied:
                return "Location access is off for SpecsRider. Enable it in Settings to route from your current location."
            case .authorizationRestricted:
                return "Location access is restricted on this device."
            case .unavailable:
                return "Couldn't determine your current location. Try again with a clear view of the sky."
            case .underlying(let error):
                return error.localizedDescription
            }
        }
    }

    @Published private(set) var authorizationStatus: CLAuthorizationStatus

    private let manager = CLLocationManager()
    private var pendingContinuations: [CheckedContinuation<CLLocation, Error>] = []
    private var authorizationContinuations: [CheckedContinuation<CLAuthorizationStatus, Never>] = []

    override init() {
        self.authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// Requests when-in-use authorization (if not yet determined) and returns a single
    /// recent location fix. Throws a `LocationError` if the user declined or no fix can
    /// be obtained.
    func requestCurrentLocation() async throws -> CLLocation {
        let status = await ensureAuthorization()
        switch status {
        case .denied:
            throw LocationError.authorizationDenied
        case .restricted:
            throw LocationError.authorizationRestricted
        case .authorizedAlways, .authorizedWhenInUse:
            break
        case .notDetermined:
            throw LocationError.authorizationDenied
        @unknown default:
            throw LocationError.unavailable
        }

        return try await withCheckedThrowingContinuation { continuation in
            pendingContinuations.append(continuation)
            manager.requestLocation()
        }
    }

    // MARK: - Authorization

    private func ensureAuthorization() async -> CLAuthorizationStatus {
        let current = manager.authorizationStatus
        guard current == .notDetermined else { return current }

        return await withCheckedContinuation { continuation in
            authorizationContinuations.append(continuation)
            manager.requestWhenInUseAuthorization()
        }
    }

    private func deliverLocation(_ result: Result<CLLocation, Error>) {
        let waiters = pendingContinuations
        pendingContinuations.removeAll()
        for continuation in waiters {
            continuation.resume(with: result)
        }
    }

    private func deliverAuthorization(_ status: CLAuthorizationStatus) {
        let waiters = authorizationContinuations
        authorizationContinuations.removeAll()
        for continuation in waiters {
            continuation.resume(returning: status)
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension LocationProvider: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.authorizationStatus = status
            if status != .notDetermined {
                self.deliverAuthorization(status)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor [weak self] in
            self?.deliverLocation(.success(location))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.deliverLocation(.failure(LocationProvider.LocationError.underlying(error)))
        }
    }
}
