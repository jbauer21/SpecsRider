/**
 * NextBeaconArrow
 *
 * Rotates a cone / arrow SceneObject each frame so its tip points at the
 * world-space position of the next unvisited beacon published by a
 * `MobileRouteController` (any ScriptComponent exposing
 * `getNextBeaconWorldPosition()` works). Intended to be used with an
 * arrow prefab that sits as a child of the Main Camera (so it travels
 * with the user's head and stays on-screen), and yaws / pitches to
 * indicate which direction the next waypoint lies in.
 *
 * Hook-up:
 *   - `arrowObject`  : the cone / arrow SceneObject (usually parented to
 *                      the camera). Its world rotation is written every
 *                      frame; its position is left untouched.
 *   - `routeBeaconController` : the ScriptComponent running
 *                      `MobileRouteController`. This script calls the
 *                      controller's public `getNextBeaconWorldPosition()`.
 *   - `tipDirection` : the direction the cone's tip points along, in the
 *                      arrow's own local space, BEFORE this script starts
 *                      driving the rotation. Lens Studio's primitive
 *                      "Cone" points along local +Y, so (0, 1, 0) is the
 *                      default. Use (0, 0, -1) if your arrow points along
 *                      Lens Studio forward (-Z).
 *
 * The arrow is hidden automatically while there is no valid target (route
 * not yet computed, awaiting GPS, or the user has already arrived), which
 * you can disable via `hideWhenNoTarget`.
 */

interface NextBeaconProviderLike {
  getNextBeaconWorldPosition(): vec3 | null
}

@component
export class NextBeaconArrow extends BaseScriptComponent {
  @ui.separator
  @ui.label("Arrow")
  @input
  @hint("The cone / arrow SceneObject whose world rotation will be driven to point at the next beacon.")
  public arrowObject: SceneObject

  @input
  @hint(
    "The direction the cone's tip points along in the arrow's own local space. Default (0, 1, 0) matches Lens Studio's primitive 'Cone' which points along local +Y. Use (0, 0, -1) if your arrow points along Lens Studio forward (-Z).",
  )
  public tipDirection: vec3 = new vec3(0, 1, 0)

  @ui.separator
  @ui.label("Route")
  @input("Component.ScriptComponent")
  @hint("The MobileRouteController driving the beacons. Its next unvisited waypoint is the arrow's target.")
  public routeBeaconController: ScriptComponent

  @ui.separator
  @ui.label("Aiming")
  @input
  @hint(
    "If true, the arrow only yaws (rotates around world Y) and stays level, so it looks like a compass needle. If false, the arrow also pitches up/down toward the beacon.",
  )
  public horizontalOnly: boolean = true

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint(
    "Rotation smoothing per frame. 1 = snap instantly, lower = smoother follow. Expressed as the fraction of the remaining angle covered each frame at 60 FPS.",
  )
  public smoothing: number = 0.25

  @ui.separator
  @ui.label("Visibility")
  @input
  @hint(
    "If true, the arrow is hidden whenever there is no valid next beacon (route not built yet, no GPS fix, or route complete). Leave false while developing in preview (there's no GPS there), and turn on for production builds if you want the cone to disappear on arrival.",
  )
  public hideWhenNoTarget: boolean = false

  @input
  @hint("Minimum distance (world centimetres) from arrow to target before rotation is updated. Prevents jitter when the target is effectively on top of the arrow.")
  public minTargetDistanceCm: number = 1.0

  @input
  @hint("If true, logs a one-line status every ~1s showing whether the arrow has a target and its current bearing.")
  public verbose: boolean = false

  private arrowTransform: Transform | null = null
  private provider: NextBeaconProviderLike | null = null
  private lastLogTime: number = 0

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind((event: UpdateEvent) => this.onUpdate(event))
  }

  private onStart(): void {
    if (isNull(this.arrowObject)) {
      print("[NextBeaconArrow] arrowObject is not assigned. Arrow will be disabled.")
      return
    }
    if (isNull(this.routeBeaconController)) {
      print("[NextBeaconArrow] routeBeaconController is not assigned. Arrow will be disabled.")
      return
    }

    this.arrowTransform = this.arrowObject.getTransform()
    this.provider = this.routeBeaconController as unknown as NextBeaconProviderLike

    if (typeof this.provider.getNextBeaconWorldPosition !== "function") {
      print(
        "[NextBeaconArrow] routeBeaconController does not expose getNextBeaconWorldPosition(); is it actually a MobileRouteController?",
      )
      this.provider = null
      return
    }
  }

  private onUpdate(event: UpdateEvent): void {
    if (this.arrowTransform === null || this.provider === null) {
      return
    }

    const target = this.provider.getNextBeaconWorldPosition()
    const hasTarget = target !== null

    if (this.hideWhenNoTarget) {
      if (this.arrowObject.enabled !== hasTarget) {
        this.arrowObject.enabled = hasTarget
      }
    }

    if (!hasTarget) {
      return
    }

    const arrowPos = this.arrowTransform.getWorldPosition()
    let direction = target.sub(arrowPos)

    if (this.horizontalOnly) {
      direction = new vec3(direction.x, 0, direction.z)
    }

    const len = direction.length
    if (len < Math.max(0.0001, this.minTargetDistanceCm)) {
      return
    }
    direction = direction.uniformScale(1 / len)

    // Build a rotation that, when applied as a world rotation, maps the
    // cone's local tip direction to the world-space target direction.
    const localTip = safeNormalize(this.tipDirection, new vec3(0, 1, 0))
    const desired = rotationFromTo(localTip, direction)

    const current = this.arrowTransform.getWorldRotation()
    const dt = event.getDeltaTime()
    const alpha = computeFrameAlpha(this.smoothing, dt)
    const next = alpha >= 0.9999 ? desired : quat.slerp(current, desired, alpha)
    this.arrowTransform.setWorldRotation(next)

    if (this.verbose) {
      const now = getTime()
      if (now - this.lastLogTime > 1.0) {
        this.lastLogTime = now
        const bearingRad = Math.atan2(direction.x, -direction.z)
        const bearingDeg = (((bearingRad * 180) / Math.PI) + 360) % 360
        print(
          "[NextBeaconArrow] target dist=" +
            len.toFixed(1) +
            " cm bearing=" +
            bearingDeg.toFixed(0) +
            " deg",
        )
      }
    }
  }
}

/**
 * Returns a quaternion that rotates `from` into `to`. Both inputs are
 * expected to be non-zero; they are normalised internally. Handles the
 * anti-parallel (180°) case by picking an arbitrary perpendicular axis.
 */
function rotationFromTo(from: vec3, to: vec3): quat {
  const f = safeNormalize(from, new vec3(0, 1, 0))
  const t = safeNormalize(to, new vec3(0, 0, -1))
  const d = f.dot(t)
  if (d > 0.999999) {
    return quat.quatIdentity()
  }
  if (d < -0.999999) {
    // 180° rotation: pick any axis perpendicular to `f`.
    let axis = f.cross(vec3.up())
    if (axis.length < 1e-4) {
      axis = f.cross(vec3.right())
    }
    return quat.angleAxis(Math.PI, axis.normalize())
  }
  const axis = f.cross(t).normalize()
  const angle = Math.acos(Math.max(-1, Math.min(1, d)))
  return quat.angleAxis(angle, axis)
}

function safeNormalize(v: vec3, fallback: vec3): vec3 {
  const l = v.length
  if (l < 1e-6) {
    return fallback
  }
  return v.uniformScale(1 / l)
}

/**
 * Converts an authored per-frame smoothing factor (0..1, interpreted at
 * ~60 FPS) into a framerate-independent lerp alpha for the current
 * delta time. Smoothing of 1 always snaps; smoothing of 0 freezes.
 */
function computeFrameAlpha(smoothing: number, dt: number): number {
  const s = Math.max(0, Math.min(1, smoothing))
  if (s >= 0.9999) {
    return 1
  }
  if (s <= 0) {
    return 0
  }
  // Interpret `smoothing` as the lerp alpha used at 60 FPS, and
  // convert to an equivalent continuous rate so behaviour is stable
  // across framerates.
  const rate = -Math.log(1 - s) * 60
  return 1 - Math.exp(-rate * Math.max(0, dt))
}
