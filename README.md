<div align="center">

<!-- Header -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=FFD400&height=160&section=header&text=SpecsRider&fontSize=52&fontColor=0A0A0A&animation=fadeIn" alt="SpecsRider" />

<br />

**Heads-up navigation and music for Snap Spectacles — paired with a companion iOS app.**

<br />

[![Platform](https://img.shields.io/badge/Platform-Snap%20Spectacles-FFD400?style=for-the-badge&labelColor=0A0A0A)](https://www.spectacles.com/)
[![iOS](https://img.shields.io/badge/iOS-Companion%20App-FFFFFF?style=for-the-badge&labelColor=0A0A0A&logo=apple&logoColor=0A0A0A)](App/)
[![Lens Studio](https://img.shields.io/badge/Lens%20Studio-5.15%2B-FFD400?style=for-the-badge&labelColor=0A0A0A)](LensStudio/)
[![SwiftUI](https://img.shields.io/badge/SwiftUI-F05138?style=for-the-badge&logo=swift&logoColor=white)](App/SpecsRider/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](LensStudio/Assets/Scripts/)

<br />


</div>

---

## Overview

SpecsRider turns your **Snap Spectacles** into a cycling companion. Plan a destination on your iPhone and the route appears in-lens, so you can navigate without reaching for your phone. Whatever is playing in the iOS Music app mirrors to your glasses — track, artist, and artwork glanceable at speed.

Pair once, ride often. SpecsRider keeps your eyes on the road and your hands on the bars.

---

## Features

| | |
|---|---|
| **In-lens navigation** | Cycling routes stream from the iOS app to the Spectacles lens over the Spectacles Mobile Kit. |
| **Now Playing** | Track, artist, album, play state, and artwork sync to the lens in real time. |
| **Media controls** | Play, pause, skip, and toggle playback from the lens via BLE requests. |
| **Device bonding** | Pair Spectacles once through the companion app; reconnect automatically on future rides. |
| **Unified bridge** | A single BLE session shared across all lens scripts — no duplicate connections. |

---

## Architecture

```text
┌─────────────────────┐         Spectacles Mobile Kit          ┌─────────────────────┐
│   iOS Companion     │ ◄────────── BLE / QLIC ──────────────► │   Spectacles Lens   │
│   (SwiftUI)         │   route · nowPlaying · media requests  │   (Lens Studio)     │
│                     │                                        │                     │
│  RouteService       │                                        │  MobileRouteController
│  NowPlayingService  │                                        │  MobileNowPlayingController
│  SpectaclesBridge   │                                        │  SpecsRiderBridge   │
└─────────────────────┘                                        └─────────────────────┘
```

The iOS app owns routing, location, and music state. `SpectaclesBridge.swift` publishes topics that the lens-side `SpecsRiderBridge.ts` subscribes to. Feature scripts consume the bridge — they never open their own Mobile Kit sessions.



## Repository layout

```text
SpecsRider/
├── LensStudio/                  Snap Lens Studio project
│   ├── Assets/
│   │   └── Scripts/             TypeScript bridge + feature controllers
│   ├── Packages/
│   ├── Spectacles.esproj
│   ├── jsconfig.json
│   └── tsconfig.json
│
└── App/                         iOS companion app
    ├── SpecsRider/              SwiftUI sources, assets, entitlements
    ├── SpecsRider.xcodeproj/
    └── SpectaclesKit/           Local Swift package (Spectacles Mobile Kit SDK)
```

---

## Getting started

### Prerequisites

- [Lens Studio 5.15+](https://ar.snap.com/lens-studio) (version recorded in `Spectacles.esproj`)
- [Xcode](https://developer.apple.com/xcode/) with a valid Apple development team
- Snap Spectacles hardware for on-device testing

### Lens Studio

1. Open **`LensStudio/Spectacles.esproj`** in Lens Studio.
2. Confirm **Extended Permissions → Spectacles Mobile Kit** is enabled in Project Settings.
3. Set the lens display name to **`SpecsRider`** so iOS bonding can find it.
4. On first launch, Lens Studio may regenerate `Cache/` and `PluginsUserPreferences/` — both are gitignored.

### iOS companion app

1. Open **`App/SpecsRider.xcodeproj`** in Xcode.
2. The project references the local Swift package at `App/SpectaclesKit/` — no extra package resolution needed.
3. Set your **development team** under Signing & Capabilities (`SpecsRider.entitlements`, `Info.plist`).
4. Select the **SpecsRider** scheme and build to a device or simulator.

### First ride

1. Launch the lens on your Spectacles.
2. Open the SpecsRider iOS app → **Glasses** tab → **Bond Spectacles**.
3. Select your paired device to start a session.
4. Use the **Ride** tab to set a destination; use **Music** to control playback.

---

## Lens scripts

| Script | Role |
|--------|------|
| [`SpecsRiderBridge.ts`](LensStudio/Assets/Scripts/SpecsRiderBridge.ts) | Single owner of the Mobile Kit session |
| [`MobileRouteController.ts`](LensStudio/Assets/Scripts/MobileRouteController.ts) | Renders the cycling route in-lens |
| [`MobileNowPlayingController.ts`](LensStudio/Assets/Scripts/MobileNowPlayingController.ts) | Displays Now Playing metadata and artwork |
| [`SpeedHudController.ts`](LensStudio/Assets/Scripts/SpeedHudController.ts) | Speed readout HUD |
| [`NextBeaconArrow.ts`](LensStudio/Assets/Scripts/NextBeaconArrow.ts) | Turn-by-turn beacon arrow |
| [`LeftPalmMenuAnchor.ts`](LensStudio/Assets/Scripts/LeftPalmMenuAnchor.ts) | Palm-anchored menu placement |
| [`MobilePairingPrompt.ts`](LensStudio/Assets/Scripts/MobilePairingPrompt.ts) | Pairing prompt UI |

---

## Publishing note

Lenses that use **Spectacles Mobile Kit** require Extended Permissions and **cannot be published** to the public Lens ecosystem at this time. SpecsRider is intended for personal / sideloaded use on Spectacles hardware.

---

<div align="center">

<br />

**SpecsRider** · *Navigate in-lens. Ride hands-free.*

<br />

<sub>© 2026 SpecsRider</sub>

</div>
