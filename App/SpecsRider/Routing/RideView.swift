// Copyright © 2026 SpecsRider.
// Address entry, route preview map, and "Send to Spectacles" UI.

import CoreLocation
import MapKit
import SwiftUI

struct RideView: View {
    @EnvironmentObject private var model: Model

    @State private var address: String = ""
    @State private var errorMessage: String?
    @State private var isSending: Bool = false

    @StateObject private var completer = AddressCompleter()
    @FocusState private var addressFocused: Bool
    @State private var suppressNextCompletion: Bool = false

    var body: some View {
        ZStack {
            SpecsBackground()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    header

                    addressCard

                    if let payload = model.routeService.current {
                        routeSummaryCard(payload: payload)
                        mapPreview
                        sendCard
                    } else {
                        emptyStateCard
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
        .task {
            // Bias autocomplete to the user's vicinity, but only if location is
            // already authorized — we don't want to prompt purely for typing.
            let status = model.locationProvider.authorizationStatus
            guard status == .authorizedWhenInUse || status == .authorizedAlways else { return }
            if let loc = try? await model.locationProvider.requestCurrentLocation() {
                completer.setRegion(around: loc.coordinate)
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ride")
                .font(.system(size: 34, weight: .heavy))
                .foregroundColor(.specsWhite)
            Text("Plan a cycling route and send it to your Spectacles.")
                .font(.system(size: 14))
                .foregroundColor(.specsTextSecondary)
        }
    }

    private var addressCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SpecsSectionHeader(title: "Destination")

            TextField("", text: $address, prompt: Text("Address, place, or landmark").foregroundColor(.specsTextTertiary))
                .textFieldStyle(SpecsTextFieldStyle())
                .submitLabel(.go)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .focused($addressFocused)
                .onSubmit { Task { await computeRoute() } }
                .onChange(of: address) { newValue in
                    if suppressNextCompletion {
                        suppressNextCompletion = false
                        return
                    }
                    completer.query = newValue
                }

            if addressFocused && !completer.suggestions.isEmpty {
                suggestionsList
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.specsYellow)
            }

            Button {
                Task { await computeRoute() }
            } label: {
                HStack(spacing: 8) {
                    if model.routeService.isComputing {
                        ProgressView().tint(.specsBlack)
                    } else {
                        Image(systemName: "bicycle")
                    }
                    Text(model.routeService.isComputing ? "Calculating route…" : "Get Cycling Route")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.routeService.isComputing)
        }
        .specsCard()
    }

    private func routeSummaryCard(payload: RoutePayload) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SpecsSectionHeader(title: "Route")
            Text(payload.address)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.specsWhite)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(formatKilometers(payload.totalMeters))
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundColor(.specsYellow)
                Text("total")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.specsTextSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .specsCard()
    }

    private var mapPreview: some View {
        ZStack(alignment: .topLeading) {
            RoutePreviewMap(
                polyline: model.routeService.lastPolyline,
                destination: model.routeService.lastDestination
            )
            .frame(height: 220)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            Text("ROUTE PREVIEW")
                .font(.system(size: 10, weight: .bold))
                .tracking(1.4)
                .foregroundColor(.specsBlack)
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .background(Capsule().fill(Color.specsYellow))
                .padding(12)
        }
    }

    private var sendCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SpecsSectionHeader(
                title: "Send to Spectacles",
                subtitle: model.sessionStarted ? "Session active — Lens will receive on its next subscription update." : "Start a session in Settings first."
            )
            Button {
                isSending = true
                model.bridge.publishRoute(model.routeService.current)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { isSending = false }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isSending ? "checkmark.circle.fill" : "paperplane.fill")
                    Text(isSending ? "Sent" : "Send Route")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!model.sessionStarted || model.routeService.current == nil)
        }
        .specsCard()
    }

    private var emptyStateCard: some View {
        VStack(alignment: .center, spacing: 8) {
            Image(systemName: "map")
                .font(.system(size: 28, weight: .light))
                .foregroundColor(.specsYellow)
            Text("No route yet")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.specsWhite)
            Text("Enter an address above to compute a cycling route.")
                .font(.system(size: 13))
                .foregroundColor(.specsTextSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 26)
        .frame(maxWidth: .infinity)
        .specsCard()
    }

    // MARK: - Suggestions

    private var suggestionsList: some View {
        let visible = Array(completer.suggestions.prefix(6))
        return VStack(spacing: 0) {
            ForEach(Array(visible.enumerated()), id: \.offset) { index, completion in
                Button {
                    select(completion)
                } label: {
                    suggestionRow(completion)
                }
                .buttonStyle(.plain)

                if index < visible.count - 1 {
                    Rectangle()
                        .fill(Color.specsBorder)
                        .frame(height: 1)
                        .padding(.leading, 44)
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.specsSurfaceElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.specsBorder, lineWidth: 1)
        )
    }

    private func suggestionRow(_ completion: MKLocalSearchCompletion) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "mappin.circle.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(.specsYellow)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(completion.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.specsWhite)
                    .lineLimit(1)
                if !completion.subtitle.isEmpty {
                    Text(completion.subtitle)
                        .font(.system(size: 13))
                        .foregroundColor(.specsTextSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func select(_ completion: MKLocalSearchCompletion) {
        suppressNextCompletion = true
        address = completer.suggestionFinalText(completion)
        completer.clear()
        addressFocused = false
    }

    // MARK: - Helpers

    private func formatKilometers(_ meters: Double) -> String {
        let km = meters / 1000
        return String(format: "%.2f km", km)
    }

    private func computeRoute() async {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        errorMessage = nil
        do {
            // Walking/cycling directions only resolve when origin and destination are
            // realistically reachable on foot, so we always anchor the route at the
            // user's current location instead of a hardcoded fallback.
            let origin = try await model.locationProvider.requestCurrentLocation().coordinate
            let payload = try await model.routeService.computeRoute(address: trimmed, origin: origin)
            // Auto-publish so the Lens gets it as soon as a session is connected.
            model.bridge.publishRoute(payload)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - MapKit preview

private struct RoutePreviewMap: UIViewRepresentable {
    let polyline: MKPolyline?
    let destination: CLLocationCoordinate2D?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.showsCompass = false
        map.overrideUserInterfaceStyle = .dark
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        map.removeOverlays(map.overlays)
        map.removeAnnotations(map.annotations)

        if let polyline {
            map.addOverlay(polyline)
            map.setVisibleMapRect(
                polyline.boundingMapRect,
                edgePadding: UIEdgeInsets(top: 36, left: 36, bottom: 36, right: 36),
                animated: false
            )
        }
        if let destination {
            let pin = MKPointAnnotation()
            pin.coordinate = destination
            map.addAnnotation(pin)
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let polyline = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: polyline)
                renderer.strokeColor = UIColor(red: 1.0, green: 0.831, blue: 0.0, alpha: 1.0)
                renderer.lineWidth = 5
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            let id = "destPin"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id) as? MKMarkerAnnotationView
                ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            view.markerTintColor = UIColor(red: 1.0, green: 0.831, blue: 0.0, alpha: 1.0)
            view.glyphImage = UIImage(systemName: "flag.checkered")
            view.glyphTintColor = .black
            return view
        }
    }
}
