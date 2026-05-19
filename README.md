# SpecsRider

Unified repository for the **SpecsRider** experience: a Snap Spectacles Lens
paired with a companion iOS app that communicate over the Spectacles Mobile Kit.

## Repository layout

```
SpecsRider/
├── LensStudio/        Snap Lens Studio project (.esproj)
│   ├── Assets/
│   ├── Packages/
│   ├── Workspaces/
│   ├── Spectacles.esproj
│   ├── jsconfig.json
│   └── tsconfig.json
│
└── App/               iOS companion app
    ├── SpecsRider/                 SwiftUI sources, assets, entitlements
    ├── SpecsRider.xcodeproj/       Xcode project
    └── SpectaclesKit/              Local Swift package (Spectacles Mobile Kit SDK)
```

## LensStudio project

1. Open **Lens Studio 5.15+** (the project records its studio version in
   `Spectacles.esproj`).
2. Open `LensStudio/Spectacles.esproj`.
3. The first launch may regenerate `Cache/` and `PluginsUserPreferences/` —
   these are ignored by git on purpose.

## iOS app

1. Open `App/SpecsRider.xcodeproj` in Xcode.
2. The project depends on the local Swift package at `App/SpectaclesKit/`
   (referenced via `XCLocalSwiftPackageReference` with `relativePath = SpectaclesKit`).
   No additional package resolution is required.
3. Select the `SpecsRider` scheme and build for an iOS device or simulator.

### Entitlements / signing

`App/SpecsRider/SpecsRider.entitlements` and `App/SpecsRider/Info.plist`
contain the bundle configuration. You will need to set your own development
team in Xcode's Signing & Capabilities tab before building to a device.
