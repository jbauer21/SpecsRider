// Copyright © 2026 SpecsRider.

import SwiftUI

@main
struct SpecsRiderApp: App {
    @StateObject private var model = Model()
    // App-level @State is initialized exactly once per process launch (cold launch).
    // It is preserved across background→foreground transitions, so the splash never
    // replays on resume.
    @State private var showSplash = true

    init() {
        configureNavigationBarAppearance()
        configureTabBarAppearance()
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                RootView()
                    .environmentObject(model)
                    .preferredColorScheme(.dark)
                    .tint(.specsYellow)
                    .onOpenURL(perform: handleURL)

                if showSplash {
                    SplashView()
                        .transition(.opacity)
                        .zIndex(1)
                        .task {
                            try? await Task.sleep(nanoseconds: 1_400_000_000)
                            withAnimation(.easeInOut(duration: 0.35)) {
                                showSplash = false
                            }
                        }
                }
            }
        }
    }

    private func handleURL(_ url: URL) {
        model.pushDeeplinkURL(url: url)
    }

    private func configureNavigationBarAppearance() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Color.specsBlack)
        appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        appearance.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
        appearance.shadowColor = .clear
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
        UINavigationBar.appearance().tintColor = UIColor(Color.specsYellow)
    }

    private func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Color.specsBlack)
        appearance.shadowColor = UIColor.white.withAlphaComponent(0.06)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
        UITabBar.appearance().tintColor = UIColor(Color.specsYellow)
        UITabBar.appearance().unselectedItemTintColor = UIColor.white.withAlphaComponent(0.5)
    }
}

// MARK: - Root

struct RootView: View {
    var body: some View {
        TabView {
            NavigationStack { RideView() }
                .tabItem {
                    Label("Ride", systemImage: "bicycle")
                }

            NavigationStack { MusicView() }
                .tabItem {
                    Label("Music", systemImage: "music.note")
                }

            NavigationStack { SettingsView() }
                .tabItem {
                    Label("Glasses", systemImage: "eyeglasses")
                }
        }
    }
}

// MARK: - Settings (bonding + session)

struct SettingsView: View {
    @EnvironmentObject private var model: Model

    var body: some View {
        ZStack {
            SpecsBackground()
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Button {
                        model.bind()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "plus.circle.fill")
                            Text("Bond Spectacles")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    SpecsSectionHeader(title: "Paired Devices")
                    BondingList(bondings: $model.bondings)

                    bridgeStatusCard

                    aboutCard
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
        .navigationTitle("Glasses")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var bridgeStatusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SpecsSectionHeader(
                title: "Spectacles bridge",
                subtitle: model.sessionStarted
                    ? "Live — your route and Now Playing are streaming to your Spectacles."
                    : "Open a paired device above to start streaming."
            )
            if !model.lastDiagnostic.isEmpty {
                Text(model.lastDiagnostic)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.specsTextSecondary)
            }
        }
        .specsCard()
    }

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SpecsSectionHeader(title: "About")
            Text("SpecsRider")
                .font(.system(size: 16, weight: .heavy))
                .foregroundColor(.specsWhite)
            Text("SpecsRider turns your Snap Spectacles into a heads-up companion for everyday rides. Plan a destination on your iPhone and your cycling route appears in-lens, so you can navigate without reaching for your phone. Whatever is playing in the iOS Music app mirrors to your glasses, with track and artist details glanceable at speed. Pair once, ride often — SpecsRider keeps your eyes on the road and your hands on the bars.")
                .font(.system(size: 13))
                .foregroundColor(.specsTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .specsCard()
    }
}

// MARK: - Splash

struct SplashView: View {
    @State private var visible = false

    var body: some View {
        ZStack {
            Color.specsBlack.ignoresSafeArea()
            RadialGradient(
                colors: [Color.specsYellow.opacity(0.18), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 360
            )
            .ignoresSafeArea()

            VStack(spacing: 14) {
                Image(systemName: "eyeglasses")
                    .font(.system(size: 64, weight: .bold))
                    .foregroundColor(.specsYellow)
                Text("SpecsRider")
                    .font(.system(size: 28, weight: .heavy))
                    .foregroundColor(.specsWhite)
                    .tracking(0.5)
            }
            .opacity(visible ? 1 : 0)
            .scaleEffect(visible ? 1 : 0.92)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.45)) { visible = true }
        }
    }
}
