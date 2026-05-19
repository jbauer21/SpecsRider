// Copyright © 2026 SpecsRider.
// Live address/place autocomplete backed by MKLocalSearchCompleter, with optional
// region biasing so suggestions cluster around the user's current location.

import Combine
import CoreLocation
@preconcurrency import MapKit
import Foundation

@MainActor
final class AddressCompleter: NSObject, ObservableObject {

    @Published private(set) var suggestions: [MKLocalSearchCompletion] = []

    /// The current text the user has typed. Setting this drives the completer.
    var query: String = "" {
        didSet {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                completer.queryFragment = ""
                if !suggestions.isEmpty { suggestions = [] }
            } else {
                completer.queryFragment = trimmed
            }
        }
    }

    private let completer: MKLocalSearchCompleter

    override init() {
        self.completer = MKLocalSearchCompleter()
        super.init()
        // The placeholder ("Address, place, or landmark") implies all three.
        // `.query` covers free-form natural language matches in addition to
        // strict addresses and points of interest.
        completer.resultTypes = [.address, .pointOfInterest, .query]
        completer.delegate = self
    }

    /// Clears any in-flight query and pending suggestions. Use after the user
    /// picks a result so a stale suggestion doesn't flash back into view.
    func clear() {
        completer.queryFragment = ""
        if !suggestions.isEmpty { suggestions = [] }
    }

    /// Bias autocomplete results to a square region centered on `coord`. The
    /// completer still returns results outside the region but ranks nearby
    /// matches higher.
    func setRegion(around coord: CLLocationCoordinate2D, radiusMeters: CLLocationDistance = 50_000) {
        let span = MKCoordinateRegion(
            center: coord,
            latitudinalMeters: radiusMeters * 2,
            longitudinalMeters: radiusMeters * 2
        )
        completer.region = span
    }

    /// Combines a completion's title and subtitle into a single string that
    /// `RouteService.resolveAddress` can geocode unambiguously.
    func suggestionFinalText(_ completion: MKLocalSearchCompletion) -> String {
        let title = completion.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = completion.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if subtitle.isEmpty { return title }
        return "\(title), \(subtitle)"
    }
}

// MARK: - MKLocalSearchCompleterDelegate

extension AddressCompleter: MKLocalSearchCompleterDelegate {
    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let results = completer.results
        Task { @MainActor [weak self] in
            self?.suggestions = results
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        // Transient failures while the user is mid-keystroke are normal; just
        // clear out any stale suggestions so we don't show misleading hits.
        Task { @MainActor [weak self] in
            self?.suggestions = []
        }
    }
}
