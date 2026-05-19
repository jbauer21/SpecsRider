// Copyright © 2026 SpecsRider.
// Originally derived from Snap Spectacles Mobile Kit sample (Model.swift, © 2024 Snap, Inc.).
// Top-level app state. Owns SpectaclesKit bonding/session, the data services, and the bridge
// that connects them to Lens-side subscriptions and requests.

import Combine
import Foundation
import SpectaclesKit
import UIKit

final class SpecsRiderAuth: Authentication {}

/// Lens identifier used by `BondingRequest.singleLensByName(...)`.
/// The Lens project should set its display name to `SpecsRider` to match.
private let kLensName = "SpecsRider"

/// Reduced view of `NowPlayingPayload` that excludes elapsed/duration so that
/// the publishing pipeline only fires when something the Lens actually re-renders
/// has changed (track, artist, album, play state, artwork identity).
private struct LensNowPlayingKey: Equatable {
    let title: String
    let artist: String
    let album: String
    let isPlaying: Bool
    let artworkVersion: String?

    static let empty = LensNowPlayingKey(title: "", artist: "", album: "", isPlaying: false, artworkVersion: nil)
}

@MainActor
final class Model: ObservableObject {

    // MARK: - SpectaclesKit

    var (deeplinkStream, deeplinkContinuation) = AsyncStream<URL>.makeStream()
    nonisolated let bondingManager: any BondingManager
    var currentSession: SpectaclesSession?
    @Published var sessionStarted: Bool = false
    @Published var bondings: [BondingData] = []

    // MARK: - Services / bridge

    let routeService = RouteService()
    let locationProvider = LocationProvider()
    let nowPlayingService = NowPlayingService()
    let musicController = MusicController()
    let bridge: SpectaclesBridge

    // MARK: - Diagnostics

    @Published var lastDiagnostic: String = ""

    // MARK: - Internal

    private var cancellables: Set<AnyCancellable> = []
    /// Identifier for the background task that wraps the foreground→background
    /// transition. `bluetooth-central` (declared in Info.plist) is what keeps
    /// the app alive long-term while the BLE link is open; this task only
    /// provides an extra cushion around the transition so any in-flight bridge
    /// work completes before iOS would otherwise consider the app idle.
    private var bridgeBackgroundTaskID: UIBackgroundTaskIdentifier = .invalid
    private var lifecycleObservers: [NSObjectProtocol] = []

    init() {
        bondingManager = BuilderFactory.create()
            .setIdentifier(ClientIdentifier(
                clientId: Bundle.main.bundleIdentifier ?? "com.specsrider.app",
                appName: "SpecsRider"
            )!)
            .setVersion("1.0")
            .setAuth(SpecsRiderAuth())
            .build()

        bridge = SpectaclesBridge(musicController: musicController)
        bridge.onDiagnostic = { [weak self] message in
            // onDiagnostic is invoked on @MainActor (bridge is @MainActor).
            self?.lastDiagnostic = message
        }

        getAllBonding()
        wireServices()
        registerLifecycleObservers()
    }

    deinit {
        // deinit is nonisolated; hop to MainActor to clean up the observers
        // (mirrors the pattern in NowPlayingService).
        let observers = lifecycleObservers
        let center = NotificationCenter.default
        Task { @MainActor in
            observers.forEach { center.removeObserver($0) }
        }
    }

    // MARK: - Service wiring

    private func wireServices() {
        // Route service → bridge: whenever a new RoutePayload is computed, push it.
        routeService.$current
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                Task { @MainActor [weak self] in
                    self?.bridge.publishRoute(payload)
                }
            }
            .store(in: &cancellables)

        // Now-playing service → bridge: combine metadata + artwork into a single
        // update. We deliberately drop elapsed-only changes here (they fire every
        // second from the polling timer) by deduping on a "lens-meaningful" key
        // tuple. Without this, the BLE link is flooded with ~1 publish/sec which
        // both wastes bandwidth and starves the album-art `.download` request.
        nowPlayingService.$payload
            .map { payload -> LensNowPlayingKey in
                guard let payload else { return .empty }
                return LensNowPlayingKey(
                    title: payload.title,
                    artist: payload.artist,
                    album: payload.album,
                    isPlaying: payload.isPlaying,
                    artworkVersion: payload.artworkVersion
                )
            }
            .removeDuplicates()
            .combineLatest(nowPlayingService.$artworkData.removeDuplicates())
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, artworkData in
                guard let self else { return }
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.bridge.publishNowPlaying(
                        self.nowPlayingService.payload,
                        artworkData: artworkData
                    )
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    /// Subscribes to `UIApplication` background/foreground notifications so the
    /// bridge can request a short background task on suspend and re-publish
    /// the latest state on resume. `bluetooth-central` (Info.plist) keeps the
    /// app running across screen-lock as long as the BLE link is open; this
    /// hook covers the edge of that transition.
    private func registerLifecycleObservers() {
        let center = NotificationCenter.default
        // `queue: .main` guarantees the closure body runs on the main thread,
        // so we can synchronously assume MainActor isolation. Doing the work
        // synchronously matters for the background-task case: iOS gives us a
        // short, hard deadline around lifecycle transitions and warns / may
        // terminate the app if we don't finish promptly.
        let didEnter = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.beginBridgeBackgroundTask()
            }
        }
        let willEnter = center.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.endBridgeBackgroundTask(resyncing: true)
            }
        }
        lifecycleObservers = [didEnter, willEnter]
    }

    private func beginBridgeBackgroundTask() {
        // No active SpectaclesKit session → nothing to keep alive.
        guard currentSession != nil else { return }
        // Already holding a background task from a previous transition.
        guard bridgeBackgroundTaskID == .invalid else { return }

        let app = UIApplication.shared
        bridgeBackgroundTaskID = app.beginBackgroundTask(withName: "specs-bridge") { [weak self] in
            // Expiration handler is invoked on the main thread per UIKit
            // contract. We MUST end the task synchronously here — iOS does
            // not wait for async work and will otherwise log
            // "Background task still not ended after expiration handlers
            // were called" and may terminate the app. Hence the synchronous
            // `MainActor.assumeIsolated` rather than a `Task { @MainActor }`
            // hop.
            MainActor.assumeIsolated {
                self?.endBridgeBackgroundTask(resyncing: false)
            }
        }
        if bridgeBackgroundTaskID == .invalid {
            lastDiagnostic = "bridge: backgroundTask unavailable"
        } else {
            lastDiagnostic = "bridge: backgroundTask acquired"
        }
    }

    private func endBridgeBackgroundTask(resyncing: Bool) {
        let taskID = bridgeBackgroundTaskID
        // Always reset the stored id BEFORE calling endBackgroundTask so a
        // re-entrant call (e.g. expiration handler racing with a manual end)
        // never double-ends the same id.
        bridgeBackgroundTaskID = .invalid
        if taskID != .invalid {
            UIApplication.shared.endBackgroundTask(taskID)
        }
        guard resyncing, currentSession != nil else { return }
        // Re-emit current state so any subscribers see a fresh snapshot in
        // case updates were dropped while the app was idle.
        bridge.publishRoute(routeService.current)
        nowPlayingService.republish()
    }

    // MARK: - Deeplink

    nonisolated func pushDeeplinkURL(url: URL) {
        Task { @MainActor in
            self.deeplinkContinuation.yield(url)
        }
    }

    // MARK: - Bonding

    func getAllBonding() {
        bondings.removeAll()
        for bonding in bondingManager.availableBondings() {
            bondings.append(BondingData(id: bonding.id))
        }
    }

    func unbind(id: String) {
        Task { @MainActor in
            (deeplinkStream, deeplinkContinuation) = AsyncStream<URL>.makeStream()
            let result = await bondingManager.unbind(id: id, deeplinkAsyncStream: deeplinkStream)
            switch result {
            case .success:
                getAllBonding()
                lastDiagnostic = "unbind: \(id)"
            case let .failure(error):
                lastDiagnostic = "unbind error: \(error)"
            }
        }
    }

    func bind() {
        Task { @MainActor in
            (deeplinkStream, deeplinkContinuation) = AsyncStream<URL>.makeStream()
            // singleLensByName is for development; production code should use singleLens(lensId:).
            let request = BondingRequest.singleLensByName(lensName: kLensName)
            let result = await bondingManager.bind(request: request, deeplinkAsyncStream: deeplinkStream)
            switch result {
            case let .success(newBonding):
                getAllBonding()
                lastDiagnostic = "bonded: \(newBonding.id)"
            case let .failure(error):
                lastDiagnostic = "bind error: \(error)"
            }
        }
    }

    // MARK: - Session

    func startSession(binding: any Bonding) {
        do {
            currentSession = try bondingManager.createSession(
                bonding: binding,
                request: SessionRequest(
                    autoReconnect: true,
                    acceptUnfusedSpectacles: true,
                    acceptUntrustedLenses: true
                ),
                delegateBuilder: { _ in self }
            )
            sessionStarted = true
            lastDiagnostic = "session started"
            print("[SpecsRider] session started for bonding \(binding.id)")
        } catch {
            currentSession = nil
            sessionStarted = false
            lastDiagnostic = "session start failed: \(error)"
            print("[SpecsRider] createSession threw: \(error)")
            return
        }
        // Re-emit current state so freshly-subscribing Lens topics get an immediate snapshot.
        bridge.publishRoute(routeService.current)
        nowPlayingService.republish()
        // Eagerly request music access if not yet granted, so artwork is available
        // by the time the Lens asks for it.
        nowPlayingService.requestAuthorizationIfNeeded()
    }

    func stopSession() {
        currentSession?.close(reason: nil)
        currentSession = nil
        sessionStarted = false
        lastDiagnostic = "session stopped"
    }
}

// MARK: - SpectaclesRequestDelegate

extension Model: SpectaclesRequestDelegate {
    nonisolated func processServiceRequest(_ request: SpectaclesRequest) async {
        switch request {
        case let .api(apiRequest):
            switch apiRequest {
            case let .call(callRequest):
                await bridge.handle(call: callRequest)
            case let .notify(notifyRequest):
                await MainActor.run { [weak self] in
                    self?.lastDiagnostic = "notify: \(notifyRequest.method)"
                }
            }
        case let .asset(assetRequest):
            switch assetRequest {
            case let .load(asset):
                await bridge.handle(assetLoad: asset)
            }
        }
    }
}
