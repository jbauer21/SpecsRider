/**
 * MobileRouteController
 *
 * Bridge-fed replacement for the legacy `RouteBeaconController`. Instead
 * of geocoding an address and fetching a polyline from Google's Routes
 * API on-lens, this controller subscribes to the `route` topic on the
 * SpecsRider iOS app via `SpecsRiderBridge` and consumes a fully
 * pre-computed `RoutePayload` (see `Routing/RoutePayload.swift` in the
 * iOS project):
 *
 *   { address, totalMeters, sampleSpacingMeters,
 *     points: [{ lat, lon, meters }, ...] }
 *
 * The lens still owns GPS / compass anchoring: once a payload arrives,
 * the controller converts each lat/lng into a world-space vec3 using
 * the user's current GPS fix and compass bearing, then exposes the
 * resulting points + the destination beacon to the existing
 * `RoutePathRenderer` and `NextBeaconArrow` scripts via the same
 * provider interface (`isRouteReady`, `getDensePathWorldPositions`,
 * `getUserWorldPosition`, `getNextBeaconWorldPosition`).
 *
 * ENU anchoring (drift fix): in addition to the legacy one-shot world
 * conversion above, the controller maintains a local ENU frame whose
 * origin is fixed at the first valid GPS fix. The route polyline is
 * converted to ENU centimetres exactly once (`getDensePathEnuPositions`),
 * and a *live*, low-pass-filtered ENU -> world similarity transform
 * (`getEnuToWorldTransform`) is re-estimated continuously from the
 * latest GPS fix + compass bearing vs the SLAM world pose. Consumers
 * (see `RoutePathRenderer`) cache the drift-free ENU polyline and apply
 * the current transform per frame, so heading / position errors at
 * anchor time no longer freeze into the rendered path: the line keeps
 * converging onto the road as fresher fixes arrive.
 *
 * Hook-up:
 *   - `bridge`                 : the `SpecsRiderBridge` ScriptComponent.
 *   - `navigationDataComponent`: NavigationDataComponent (source of
 *                                UserPosition / GPS).
 *   - `cameraObject`           : Main Camera SceneObject.
 *   - `beaconPrefab`           : ARNavigationPrefab to spawn at the
 *                                final destination.
 *
 * Re-route handling: when a new `route` payload arrives mid-session
 * (e.g. the user changes destination on the phone), the controller
 * flips `routeReady` to false for one frame, tears down the old beacon,
 * and rebuilds from the new payload on the next frame so
 * `RoutePathRenderer` resets its cached arc-length tables cleanly.
 */

// `RawLocationModule` permission gate. Same requirement as the legacy
// `RouteBeaconController`: any script that touches `UserPosition.getGeoPosition`
// must declare this at module-top or `onAwake` errors out before firing.
require("LensStudio:RawLocationModule")

import {MovingAverageFilter} from "SpectaclesInteractionKit.lspkg/Utils/MovingAverageFilter"
import {averageVec3} from "SpectaclesInteractionKit.lspkg/Utils/mathUtils"

import {BridgeTopic, SpecsRiderBridge, JsonSubscriptionHandle} from "./SpecsRiderBridge"

type LatLng = {lat: number; lng: number}

type RoutePoint = {lat: number; lon: number; meters: number}

interface RoutePayloadJson {
  address?: string
  totalMeters?: number
  sampleSpacingMeters?: number
  points: RoutePoint[]
}

const WORLD_CM_PER_METER = 100
const METERS_PER_DEGREE_LAT = 111132.0
const EARTH_METERS_PER_DEGREE_LON_AT_EQUATOR = 111320.0

/**
 * Live ENU -> world similarity transform. World position of an ENU point
 * `p` (in cm, y ignored) is `R_y(yawRad) * p + translation`.
 */
export type EnuToWorldTransform = {
  yawRad: number
  translation: vec3
}

type Waypoint = {
  lat: number
  lng: number
  visited: boolean
  sceneObject: SceneObject | null
  posFilter: MovingAverageFilter<vec3> | null
}

interface NavUserPositionLike {
  initializeGeoLocationUpdates(accuracy: number, updateFrequencyS: number): void
  getGeoPosition(): {latitude: number; longitude: number; altitude?: number} | null | undefined
  getBearing(): number
  getRelativeTransform(): Transform
}

interface NavigationDataComponentLike {
  getUserPosition(): NavUserPositionLike
}

@component
export class MobileRouteController extends BaseScriptComponent {
  @ui.separator
  @ui.label("Bridge")
  @input("Component.ScriptComponent")
  @hint("The SpecsRiderBridge ScriptComponent. Subscribes to the 'route' topic.")
  public bridge: ScriptComponent

  @ui.separator
  @ui.label("Modules")
  @input("Component.ScriptComponent")
  @hint("The NavigationDataComponent from SpectaclesNavigationKit. Used as the source of UserPosition / GPS.")
  public navigationDataComponent: ScriptComponent

  @input
  @hint("The Main Camera SceneObject. Its world Y is read every frame to pin the destination beacon at eye level.")
  public cameraObject: SceneObject

  @ui.separator
  @ui.label("End-of-route Beacon")
  @input
  @hint("Drag the ARNavigationPrefab here. One instance is spawned at the final destination only.")
  public beaconPrefab: ObjectPrefab

  @ui.separator
  @ui.label("Arrival")
  @input
  @widget(new SliderWidget(1, 50, 1))
  @hint("Distance, in metres, at which the user is considered to have 'arrived' at the destination beacon.")
  public passDistanceMeters: number = 15

  @ui.separator
  @ui.label("Smoothing")
  @input
  @hint("If true, the destination beacon's world position is smoothed via a moving-average filter to suppress GPS / compass jitter.")
  public smoothingEnabled: boolean = true

  @input
  @widget(new SliderWidget(1, 90, 1))
  @hint("Moving-average window length (in frames) for beacon position smoothing. ~30 = 0.5s at 60 FPS.")
  public smoothingWindow: number = 30

  @ui.separator
  @ui.label("ENU anchoring")
  @input
  @hint("If true, exposes the route as a drift-free ENU polyline plus a continuously re-estimated ENU->world transform (fused from GPS + compass, low-pass filtered). RoutePathRenderer then re-anchors the line every frame instead of freezing the first GPS+compass fix.")
  public enuAnchoringEnabled: boolean = true

  @input
  @widget(new SliderWidget(1, 30, 0.5))
  @hint("Low-pass time constant (seconds) for the ENU->world translation. Larger = steadier line, slower convergence onto fresh GPS fixes.")
  public anchorTranslationTauS: number = 6

  @input
  @widget(new SliderWidget(1, 60, 0.5))
  @hint("Low-pass time constant (seconds) for the ENU->world heading. Larger = steadier line, slower correction of compass error.")
  public anchorYawTauS: number = 12

  @ui.separator
  @ui.label("Debug")
  @input
  @hint("If true, prints verbose route progress to the log.")
  public verbose: boolean = false

  @input
  @allowUndefined
  @hint("Optional Text component that displays robust live debug state (phase, GPS, route, beacon).")
  public debugText: Text | undefined

  @input
  @widget(new SliderWidget(0.1, 2.0, 0.1))
  @hint("How often (in seconds) the debug Text is refreshed.")
  public debugRefreshIntervalS: number = 0.25

  // -- Resolved bridge handle.
  private bridgeApi: SpecsRiderBridge | null = null
  private subscription: JsonSubscriptionHandle | null = null

  // -- GPS / compass.
  private userPosition: NavUserPositionLike | null = null
  private lastUserGeo: LatLng | null = null
  private lastGpsFixTime: number = -1

  // -- Active route.
  private densePath: LatLng[] = []
  private endWaypoint: Waypoint | null = null
  private routeReady: boolean = false
  private beaconSpawnDisabled: boolean = false

  // -- ENU frame. The origin is pinned at the first valid GPS fix and
  // never moves; the route polyline is converted into this frame once
  // per payload. The ENU->world transform below is what absorbs GPS /
  // compass / SLAM drift over time.
  private enuOrigin: LatLng | null = null
  private enuCmPerDegreeLon: number = 0
  private densePathEnu: vec3[] = []
  // -- Filtered ENU->world transform state.
  private anchorInitialized: boolean = false
  private filteredYawRad: number = 0
  private filteredTx: number = 0
  private filteredTz: number = 0
  private lastAnchorSampleTime: number = -1

  // -- Pending payload + rebuild flag. When a new payload arrives we
  // drop `routeReady` to false this frame and apply the payload on the
  // next `onUpdate`. That guarantees the downstream renderer sees the
  // false edge and resets its cached arc-length tables before we hand
  // it the new path.
  private pendingPayload: RoutePayloadJson | null = null
  private rebuildPending: boolean = false

  // -- Status / debug.
  private status: string = "init"
  private lastError: string = ""
  private destinationAddress: string = ""
  private routeDistanceMeters: number = 0
  private startTime: number = 0
  private debugRefreshAcc: number = 0
  // Bumped on every applied payload so we can distinguish overlapping
  // routes when re-rerouting mid-session (mostly used for logging).
  private routeVersion: number = 0

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind((event: UpdateEvent) => this.onUpdate(event))
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private onStart(): void {
    this.startTime = getTime()
    this.setStatus("checking inputs")

    if (isNull(this.bridge)) {
      this.fail("bridge is not assigned.")
      return
    }
    if (isNull(this.navigationDataComponent)) {
      this.fail("navigationDataComponent is not assigned.")
      return
    }
    if (isNull(this.beaconPrefab)) {
      this.fail("beaconPrefab is not assigned.")
      return
    }
    if (isNull(this.cameraObject)) {
      this.fail("cameraObject is not assigned.")
      return
    }

    this.bridgeApi = this.bridge as unknown as SpecsRiderBridge
    if (
      typeof this.bridgeApi.subscribeJson !== "function" ||
      typeof this.bridgeApi.addOnConnected !== "function"
    ) {
      this.fail("bridge ScriptComponent isn't a SpecsRiderBridge.")
      return
    }

    try {
      const navAny = this.navigationDataComponent as unknown as NavigationDataComponentLike
      this.userPosition = navAny.getUserPosition()
    } catch (e) {
      this.fail("getUserPosition() threw: " + (e as Error).message)
      return
    }
    if (this.userPosition === null) {
      this.fail("UserPosition is null.")
      return
    }

    try {
      const accuracyHigh =
        typeof GeoLocationAccuracy !== "undefined" && GeoLocationAccuracy !== null
          ? (GeoLocationAccuracy as any).High
          : 2
      this.userPosition.initializeGeoLocationUpdates(accuracyHigh, 1)
    } catch (e) {
      this.fail("initializeGeoLocationUpdates failed: " + (e as Error).message)
      return
    }

    this.setStatus("awaiting bridge")
    this.subscription = this.bridgeApi.subscribeJson<RoutePayloadJson>(
      BridgeTopic.route,
      (payload) => this.onRoutePayload(payload),
      (err) => {
        this.lastError = "subscription error: " + String(err)
        if (this.verbose) {
          print("[MobileRoute] " + this.lastError)
        }
      },
    )

    this.bridgeApi.addOnConnected(() => {
      if (this.verbose) {
        print("[MobileRoute] bridge connected")
      }
      if (!this.routeReady) {
        this.setStatus("awaiting route")
      }
    })
    this.bridgeApi.addOnDisconnected(() => {
      if (this.verbose) {
        print("[MobileRoute] bridge disconnected")
      }
    })
  }

  private onDestroy(): void {
    if (this.subscription !== null) {
      this.subscription.stop()
      this.subscription = null
    }
    this.resetRouteState()
  }

  // -----------------------------------------------------------------------
  // Route ingestion
  // -----------------------------------------------------------------------

  /**
   * Called whenever the bridge emits a parsed `route` payload. Stores it
   * as `pendingPayload` and drops `routeReady`; the actual swap into the
   * dense path happens in the next `onUpdate` so the renderer sees the
   * `false` edge and resets its cached state cleanly.
   */
  private onRoutePayload(payload: RoutePayloadJson): void {
    if (payload === null || payload === undefined || !Array.isArray(payload.points)) {
      this.lastError = "received malformed route payload."
      if (this.verbose) {
        print("[MobileRoute] " + this.lastError)
      }
      return
    }
    if (payload.points.length < 2) {
      this.lastError = "route payload has <2 points; ignored."
      if (this.verbose) {
        print("[MobileRoute] " + this.lastError)
      }
      return
    }
    this.pendingPayload = payload
    this.rebuildPending = true
    this.routeReady = false
    this.tearDownBeacon()
    this.setStatus("rebuilding route")
    if (this.verbose) {
      print(
        "[MobileRoute] received route: " +
          payload.points.length +
          " points, " +
          (payload.totalMeters !== undefined ? payload.totalMeters.toFixed(0) : "?") +
          " m",
      )
    }
  }

  private applyPendingPayload(): void {
    const payload = this.pendingPayload
    this.pendingPayload = null
    this.rebuildPending = false
    if (payload === null) {
      return
    }

    const path: LatLng[] = []
    for (let i = 0; i < payload.points.length; i++) {
      const p = payload.points[i]
      if (
        typeof p.lat !== "number" ||
        typeof p.lon !== "number" ||
        !isFinite(p.lat) ||
        !isFinite(p.lon)
      ) {
        continue
      }
      path.push({lat: p.lat, lng: p.lon})
    }
    if (path.length < 2) {
      this.fail("filtered route has <2 valid points.")
      return
    }

    this.densePath = path
    this.densePathEnu = []
    if (this.enuOrigin !== null) {
      this.buildDensePathEnu()
    }
    this.destinationAddress =
      typeof payload.address === "string" ? payload.address : ""
    this.routeDistanceMeters =
      typeof payload.totalMeters === "number" ? payload.totalMeters : 0
    this.beaconSpawnDisabled = false

    const last = path[path.length - 1]
    this.endWaypoint = {
      lat: last.lat,
      lng: last.lng,
      visited: false,
      sceneObject: null,
      posFilter: null,
    }
    this.routeVersion += 1
    this.routeReady = true
    this.lastError = ""
    this.setStatus("navigating")
    if (this.verbose) {
      print(
        "[MobileRoute] applied route v" +
          this.routeVersion +
          " (" +
          path.length +
          " samples, dest " +
          last.lat.toFixed(5) +
          ", " +
          last.lng.toFixed(5) +
          ")",
      )
    }
  }

  // -----------------------------------------------------------------------
  // Per-frame
  // -----------------------------------------------------------------------

  private onUpdate(event: UpdateEvent): void {
    this.debugRefreshAcc += event.getDeltaTime()
    const refresh = Math.max(0.05, this.debugRefreshIntervalS)
    const shouldRefreshDebug = this.debugRefreshAcc >= refresh

    if (this.rebuildPending) {
      // Ensure consumers see `routeReady=false` for at least one frame
      // before we apply the new payload on the next `onUpdate`.
      if (shouldRefreshDebug) {
        this.debugRefreshAcc = 0
        this.writeDebugText()
      }
      this.applyPendingPayload()
      return
    }

    if (this.userPosition !== null) {
      const userGeo = toValidLatLng(this.userPosition.getGeoPosition())
      if (userGeo !== null) {
        this.lastUserGeo = userGeo
        this.lastGpsFixTime = getTime()
        if (this.enuAnchoringEnabled) {
          this.updateEnuAnchor(userGeo, event.getDeltaTime())
        }
      }
    }

    if (!this.routeReady) {
      if (shouldRefreshDebug) {
        this.debugRefreshAcc = 0
        this.writeDebugText()
      }
      return
    }

    const wp = this.endWaypoint
    if (wp !== null && !wp.visited && this.lastUserGeo !== null) {
      this.ensureSpawned()
      if (wp.sceneObject !== null) {
        this.updateBeaconWorldPos(wp, this.lastUserGeo)
      }
      const distM = distanceMeters(this.lastUserGeo, wp)
      if (distM <= this.passDistanceMeters) {
        if (this.verbose) {
          print("[MobileRoute] arrived (" + distM.toFixed(1) + " m).")
        }
        wp.visited = true
        if (wp.sceneObject !== null) {
          wp.sceneObject.destroy()
          wp.sceneObject = null
        }
        wp.posFilter = null
        this.setStatus("arrived")
      }
    }

    if (shouldRefreshDebug) {
      this.debugRefreshAcc = 0
      this.writeDebugText()
    }
  }

  // -----------------------------------------------------------------------
  // Beacon / world anchoring
  // -----------------------------------------------------------------------

  private ensureSpawned(): void {
    if (!this.routeReady || this.beaconSpawnDisabled) {
      return
    }
    const wp = this.endWaypoint
    if (wp === null || wp.visited || wp.sceneObject !== null) {
      return
    }
    try {
      wp.sceneObject = this.beaconPrefab.instantiate(this.getSceneObject())
      wp.posFilter = new MovingAverageFilter<vec3>(
        Math.max(1, Math.floor(this.smoothingWindow)),
        vec3.zero,
        averageVec3,
      )
      if (this.lastUserGeo !== null) {
        this.updateBeaconWorldPos(wp, this.lastUserGeo)
      }
      if (this.verbose) {
        print("[MobileRoute] spawned destination beacon.")
      }
    } catch (e) {
      // Most common cause: misconfigured ARNavigationPrefab @input. Log
      // once and stop spawning so we don't spam the same exception.
      this.beaconSpawnDisabled = true
      this.fail("Failed to instantiate beacon prefab: " + (e as Error).message)
    }
  }

  private tearDownBeacon(): void {
    const wp = this.endWaypoint
    if (wp === null) {
      return
    }
    if (wp.sceneObject !== null) {
      wp.sceneObject.destroy()
      wp.sceneObject = null
    }
    wp.posFilter = null
    this.endWaypoint = null
  }

  private resetRouteState(): void {
    this.routeReady = false
    this.densePath = []
    // The ENU origin and anchor filter intentionally survive route swaps:
    // they describe the device's geo<->world relationship, not the route.
    this.densePathEnu = []
    this.tearDownBeacon()
    this.beaconSpawnDisabled = false
  }

  // -----------------------------------------------------------------------
  // ENU frame + live ENU->world transform
  // -----------------------------------------------------------------------

  /** Pins the ENU origin at the first valid GPS fix. Never moves after. */
  private ensureEnuOrigin(userGeo: LatLng): void {
    if (this.enuOrigin !== null) {
      return
    }
    this.enuOrigin = {lat: userGeo.lat, lng: userGeo.lng}
    this.enuCmPerDegreeLon =
      EARTH_METERS_PER_DEGREE_LON_AT_EQUATOR *
      Math.cos(userGeo.lat * (Math.PI / 180)) *
      WORLD_CM_PER_METER
    if (this.verbose) {
      print(
        "[MobileRoute] ENU origin pinned at " +
          userGeo.lat.toFixed(6) +
          ", " +
          userGeo.lng.toFixed(6),
      )
    }
  }

  /**
   * ENU coordinates in Lens Studio axis convention, centimetres:
   * x = east, z = -north (so ENU north lines up with Lens Studio forward
   * -Z at zero yaw), y = 0 (the transform supplies the height).
   */
  private latLngToEnuCm(p: LatLng): vec3 {
    const origin = this.enuOrigin
    if (origin === null) {
      return vec3.zero()
    }
    const eastCm = (p.lng - origin.lng) * this.enuCmPerDegreeLon
    const northCm = (p.lat - origin.lat) * METERS_PER_DEGREE_LAT * WORLD_CM_PER_METER
    return new vec3(eastCm, 0, -northCm)
  }

  private buildDensePathEnu(): void {
    if (this.enuOrigin === null || this.densePath.length === 0) {
      return
    }
    const out: vec3[] = new Array(this.densePath.length)
    for (let i = 0; i < this.densePath.length; i++) {
      out[i] = this.latLngToEnuCm(this.densePath[i])
    }
    this.densePathEnu = out
  }

  /**
   * Re-estimates the ENU->world transform from the latest GPS fix +
   * compass bearing vs the current SLAM pose, then folds the sample into
   * the low-pass-filtered state. Called once per frame while a fix is
   * available, so the transform keeps converging instead of freezing the
   * (noisy) first fix like the legacy one-shot anchor did.
   *
   * Yaw is filtered first and the translation target is computed against
   * the *already filtered* yaw: with the user far from the ENU origin, a
   * yaw/translation pair filtered independently would disagree by
   * |userEnu| * deltaYaw right at the user's position, which is exactly
   * where the line must be accurate.
   */
  private updateEnuAnchor(userGeo: LatLng, deltaTime: number): void {
    if (this.userPosition === null) {
      return
    }
    this.ensureEnuOrigin(userGeo)
    if (this.densePath.length > 0 && this.densePathEnu.length === 0) {
      this.buildDensePathEnu()
    }

    let userWorldPos: vec3
    let userForward: vec3
    let compassBearingRad: number
    try {
      const xform = this.userPosition.getRelativeTransform()
      userWorldPos = xform.getWorldPosition()
      userForward = xform.back.projectOnPlane(vec3.up())
      compassBearingRad = this.userPosition.getBearing()
    } catch (_e) {
      return
    }
    if (userForward.length < 1e-4 || !isFinite(compassBearingRad)) {
      return
    }
    userForward = userForward.normalize()

    // Compass angle of the SLAM forward in world axes (north = -Z, east = +X).
    const worldForwardAngle = Math.atan2(userForward.x, -userForward.z)
    const yawTarget = compassBearingRad - worldForwardAngle

    const userEnu = this.latLngToEnuCm(userGeo)

    if (!this.anchorInitialized) {
      this.filteredYawRad = normalizeAngle(yawTarget)
      const rotated = rotateYXZ(userEnu, this.filteredYawRad)
      this.filteredTx = userWorldPos.x - rotated.x
      this.filteredTz = userWorldPos.z - rotated.z
      this.anchorInitialized = true
      this.lastAnchorSampleTime = getTime()
      return
    }

    const kYaw = 1 - Math.exp(-Math.max(0, deltaTime) / Math.max(0.1, this.anchorYawTauS))
    const kT = 1 - Math.exp(-Math.max(0, deltaTime) / Math.max(0.1, this.anchorTranslationTauS))

    this.filteredYawRad = normalizeAngle(
      this.filteredYawRad + angleDifference(yawTarget, this.filteredYawRad) * kYaw,
    )

    const rotated = rotateYXZ(userEnu, this.filteredYawRad)
    const txTarget = userWorldPos.x - rotated.x
    const tzTarget = userWorldPos.z - rotated.z
    this.filteredTx += (txTarget - this.filteredTx) * kT
    this.filteredTz += (tzTarget - this.filteredTz) * kT
    this.lastAnchorSampleTime = getTime()
  }

  /**
   * Computes the beacon's world position from the waypoint's geo
   * coordinates and the user's current GPS + compass bearing, then snaps
   * Y to the camera's current eye-level world Y.
   *
   * Identical math to `RouteBeaconController.computeWaypointWorldPos`:
   *   - haversine distance from user to waypoint (metres);
   *   - great-circle bearing from user to waypoint (radians, CW from
   *     true north);
   *   - subtract `userPosition.getBearing()` to get the bearing relative
   *     to the user's current forward direction;
   *   - rotate the user's forward vector (projected onto the ground
   *     plane) by `-relativeBearing` around +Y;
   *   - scale by `distance_m * 100` because Lens Studio world units are
   *     centimetres.
   */
  private updateBeaconWorldPos(wp: Waypoint, userGeo: LatLng): void {
    if (wp.sceneObject === null) {
      return
    }
    const raw = this.computeWaypointWorldPos(wp, userGeo)
    if (raw === null) {
      return
    }
    const out =
      this.smoothingEnabled && wp.posFilter !== null
        ? wp.posFilter.filter(raw, getTime())
        : raw
    wp.sceneObject.getTransform().setWorldPosition(out)
  }

  private computeWaypointWorldPos(wp: Waypoint, userGeo: LatLng): vec3 | null {
    if (this.userPosition === null || isNull(this.cameraObject)) {
      return null
    }

    const distanceM = distanceMeters(userGeo, wp)
    const userXform = this.userPosition.getRelativeTransform()
    const userWorldPos = userXform.getWorldPosition()

    let finalPos: vec3
    if (distanceM < 0.01) {
      finalPos = userWorldPos
    } else {
      const absoluteBearingRad = bearingRadians(userGeo, wp)
      const userBearingRad = this.userPosition.getBearing()
      const relativeBearingRad = absoluteBearingRad - userBearingRad

      const userForward = userXform.back.projectOnPlane(vec3.up()).normalize()
      const direction = quat
        .fromEulerAngles(0, -relativeBearingRad, 0)
        .multiplyVec3(userForward)
      const offset = direction.uniformScale(distanceM * WORLD_CM_PER_METER)
      finalPos = userWorldPos.add(offset)
    }

    const eyeY = this.cameraObject.getTransform().getWorldPosition().y
    return new vec3(finalPos.x, eyeY, finalPos.z)
  }

  // -----------------------------------------------------------------------
  // RoutePathProviderLike + NextBeaconProviderLike implementation
  // -----------------------------------------------------------------------

  /** True once a route payload has been ingested and world-anchored. */
  public isRouteReady(): boolean {
    return this.routeReady
  }

  /** Dense polyline as `LatLng` samples, or null if no route is active. */
  public getDensePathLatLng(): LatLng[] | null {
    if (!this.routeReady || this.densePath.length === 0) {
      return null
    }
    return this.densePath
  }

  /**
   * Dense polyline transformed into Lens-Studio world space using the
   * latest GPS fix + compass bearing. Each sample's Y is the camera's
   * current eye-level world Y; consumers are expected to apply their
   * own height offset on top.
   */
  public getDensePathWorldPositions(): vec3[] | null {
    if (!this.routeReady || this.lastUserGeo === null) {
      return null
    }
    if (this.densePath.length === 0) {
      return null
    }
    const out: vec3[] = []
    for (let i = 0; i < this.densePath.length; i++) {
      const wp: Waypoint = {
        lat: this.densePath[i].lat,
        lng: this.densePath[i].lng,
        visited: false,
        sceneObject: null,
        posFilter: null,
      }
      const p = this.computeWaypointWorldPos(wp, this.lastUserGeo)
      if (p === null) {
        return null
      }
      out.push(p)
    }
    return out
  }

  /**
   * Drift-free route polyline in the fixed ENU frame (centimetres,
   * x = east, z = -north, y = 0). Cache-safe: the values never change for
   * a given route + ENU origin. Null until the route and the first GPS
   * fix are both available, or when ENU anchoring is disabled.
   */
  public getDensePathEnuPositions(): vec3[] | null {
    if (!this.enuAnchoringEnabled || !this.routeReady) {
      return null
    }
    if (this.densePathEnu.length < 2) {
      return null
    }
    return this.densePathEnu
  }

  /**
   * Current low-pass-filtered ENU->world transform. The translation's Y is
   * the camera's live eye-level world Y (matching the legacy conversion's
   * vertical behaviour); consumers apply their own height offset on top.
   * Null until the first anchor sample, or when ENU anchoring is disabled.
   */
  public getEnuToWorldTransform(): EnuToWorldTransform | null {
    if (!this.enuAnchoringEnabled || !this.anchorInitialized) {
      return null
    }
    if (isNull(this.cameraObject)) {
      return null
    }
    const eyeY = this.cameraObject.getTransform().getWorldPosition().y
    return {
      yawRad: this.filteredYawRad,
      translation: new vec3(this.filteredTx, eyeY, this.filteredTz),
    }
  }

  /** Current world-space position of the user, or null if no GPS fix. */
  public getUserWorldPosition(): vec3 | null {
    if (this.userPosition === null) {
      return null
    }
    try {
      return this.userPosition.getRelativeTransform().getWorldPosition()
    } catch (_e) {
      return null
    }
  }

  /**
   * World-space position of the (single) destination beacon, or null
   * if the route isn't ready, GPS hasn't fixed, or the user has
   * already arrived. If the beacon is currently spawned, that
   * SceneObject's live world position is returned to keep the
   * `NextBeaconArrow` pointing at exactly what the user sees.
   */
  public getNextBeaconWorldPosition(): vec3 | null {
    if (!this.routeReady || this.lastUserGeo === null) {
      return null
    }
    const wp = this.endWaypoint
    if (wp === null || wp.visited) {
      return null
    }
    if (wp.sceneObject !== null) {
      return wp.sceneObject.getTransform().getWorldPosition()
    }
    return this.computeWaypointWorldPos(wp, this.lastUserGeo)
  }

  // -----------------------------------------------------------------------
  // Debug
  // -----------------------------------------------------------------------

  private setStatus(next: string): void {
    this.status = next
    if (this.verbose) {
      print("[MobileRoute] status -> " + next)
    }
  }

  private fail(msg: string): void {
    this.lastError = msg
    this.status = "error"
    print("[MobileRoute] " + msg)
    this.writeDebugText()
  }

  private writeDebugText(): void {
    if (this.debugText === undefined || isNull(this.debugText)) {
      return
    }
    const now = getTime()
    const uptime = this.startTime > 0 ? Math.max(0, now - this.startTime) : 0

    const lines: string[] = []
    lines.push("MobileRoute | " + this.status + " | t+" + uptime.toFixed(1) + "s")

    if (this.lastError.length > 0) {
      lines.push("err: " + truncate(this.lastError, 80))
    }

    if (this.lastUserGeo !== null && this.lastGpsFixTime >= 0) {
      const age = now - this.lastGpsFixTime
      lines.push(
        "gps: " +
          this.lastUserGeo.lat.toFixed(6) +
          ", " +
          this.lastUserGeo.lng.toFixed(6) +
          " (" +
          age.toFixed(1) +
          "s ago)",
      )
    } else {
      lines.push("gps: no fix yet")
    }

    if (this.routeReady) {
      const distKm =
        this.routeDistanceMeters > 0
          ? (this.routeDistanceMeters / 1000).toFixed(2) + " km"
          : "-"
      lines.push(
        "route v" +
          this.routeVersion +
          ": " +
          distKm +
          " | " +
          this.densePath.length +
          " pts | dest " +
          truncate(this.destinationAddress, 40),
      )
    } else {
      lines.push("route: not built")
    }

    const wp = this.endWaypoint
    if (this.routeReady && wp !== null && !wp.visited && this.lastUserGeo !== null) {
      const d = distanceMeters(this.lastUserGeo, wp)
      const bearing = bearingDegrees(this.lastUserGeo, wp)
      lines.push("end: " + d.toFixed(1) + " m | " + bearing.toFixed(0) + " deg")
    } else if (this.routeReady && wp !== null && wp.visited) {
      lines.push("end: arrived")
    } else {
      lines.push("end: -")
    }

    const beaconAlive = wp !== null && wp.sceneObject !== null ? "alive" : "off"
    lines.push("beacon: " + beaconAlive)

    if (this.enuAnchoringEnabled) {
      if (this.anchorInitialized) {
        const age =
          this.lastAnchorSampleTime >= 0 ? now - this.lastAnchorSampleTime : -1
        lines.push(
          "enu: yaw " +
            ((this.filteredYawRad * 180) / Math.PI).toFixed(1) +
            " deg | " +
            this.densePathEnu.length +
            " pts | sample " +
            (age >= 0 ? age.toFixed(1) + "s ago" : "-"),
        )
      } else {
        lines.push("enu: awaiting first anchor")
      }
    }

    this.debugText.text = lines.join("\n")
  }
}

// -----------------------------------------------------------------------
// Geo helpers (ported verbatim from RouteBeaconController for parity)
// -----------------------------------------------------------------------

function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371008.8
  const toRad = Math.PI / 180
  const lat1 = a.lat * toRad
  const lat2 = b.lat * toRad
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
  return R * c
}

function bearingRadians(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180
  const lat1 = a.lat * toRad
  const lat2 = b.lat * toRad
  const dLng = (b.lng - a.lng) * toRad
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return Math.atan2(y, x)
}

function bearingDegrees(a: LatLng, b: LatLng): number {
  const brng = (bearingRadians(a, b) * 180) / Math.PI
  return (brng + 360) % 360
}

function toValidLatLng(geo: any): LatLng | null {
  if (geo === null || geo === undefined) {
    return null
  }
  const lat = geo.latitude
  const lng = geo.longitude
  if (typeof lat !== "number" || typeof lng !== "number") {
    return null
  }
  if (!isFinite(lat) || !isFinite(lng)) {
    return null
  }
  if (lat === 0 && lng === 0) {
    return null
  }
  return {lat, lng}
}

/** Rotates `v` around world +Y by `yawRad` (same convention as quat.fromEulerAngles(0, yaw, 0)). */
function rotateYXZ(v: vec3, yawRad: number): vec3 {
  const c = Math.cos(yawRad)
  const s = Math.sin(yawRad)
  return new vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

/** Wraps an angle into (-pi, pi]. */
function normalizeAngle(a: number): number {
  let out = a
  while (out > Math.PI) {
    out -= 2 * Math.PI
  }
  while (out <= -Math.PI) {
    out += 2 * Math.PI
  }
  return out
}

/** Signed smallest difference `a - b`, wrapped into (-pi, pi]. */
function angleDifference(a: number, b: number): number {
  return normalizeAngle(a - b)
}

function truncate(s: string, max: number): string {
  if (typeof s !== "string") {
    return ""
  }
  if (s.length <= max) {
    return s
  }
  return s.substr(0, Math.max(0, max - 1)) + "…"
}
