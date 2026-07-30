/**
 * RoutePathRenderer
 *
 * Renders the dense polyline produced by `MobileRouteController` (or any
 * ScriptComponent implementing `RoutePathProviderLike`) as a short tube
 * whose visible window slides along the route as the user walks. The
 * line never extends behind the user (de-rendered as they pass each
 * segment) and is capped at the front by an optional arrowhead
 * `tipObject`. The result feels like a path being painted in real time
 * just ahead of the user.
 *
 * Design summary:
 *   - On the first ready frame, the controller's dense world-space path
 *     is cached along with a cumulative arc-length table.
 *   - Every frame we project the user's current world position onto the
 *     cached path, find the closest segment, and convert that into an
 *     arc-length value `userArcCm`. `userArcCm` is monotonically
 *     non-decreasing so backtracking does not "un-pass" old segments.
 *   - We sample the cached path between
 *     `[userArcCm - visibleBehindM, userArcCm + visibleAheadM]` (with
 *     interpolated endpoints), and rebuild a small tube mesh from that
 *     trimmed slice into a reused `MeshBuilder`.
 *   - The optional `tipObject` is positioned at the leading edge of the
 *     visible window and rotated so its `tipForward` axis aligns with
 *     the path tangent there. It conceals the otherwise-hard front cut.
 *
 * Hook-up:
 *   - `routeBeaconController` : the ScriptComponent running
 *                               `MobileRouteController`. The renderer
 *                               calls `getDensePathWorldPositions()`,
 *                               `getUserWorldPosition()`, and
 *                               `isRouteReady()`.
 *   - `cameraObject`          : the Main Camera SceneObject. Its world
 *                               position is read every frame as a
 *                               fallback when the controller can't
 *                               provide a user position yet.
 *   - `pathMaterial`          : a Material for the tube. Cloned at
 *                               runtime. With this script, the material
 *                               can be a simple solid emissive color -
 *                               geometry trimming handles visibility,
 *                               so no proximity-fade shader is required.
 *   - `tipObject`             : optional SceneObject (e.g. an arrow
 *                               mesh) repositioned + rotated each frame
 *                               at the leading edge of the visible
 *                               window. Pass `null` to skip.
 *
 * Notes:
 *   - Anchoring runs in one of two modes:
 *       ENU mode (preferred): when the provider exposes
 *       `getDensePathEnuPositions()` + `getEnuToWorldTransform()`, the
 *       renderer caches the drift-free ENU polyline (plus its arc-length
 *       table, which is invariant under rigid transforms) and applies the
 *       provider's *live*, low-pass-filtered ENU->world transform to the
 *       visible slice every frame. The line therefore keeps converging
 *       onto the road as fresh GPS/compass fixes arrive instead of
 *       freezing the first anchor.
 *       Legacy mode: the world-space path is cached once at first build
 *       using a single GPS + compass fix and never re-anchored.
 *   - The iOS bridge sends curvature-adaptive spacing (roughly 2-15 m);
 *     the optional Catmull-Rom smoothing pass below subdivides the
 *     visible slice so curves render smoothly regardless of the incoming
 *     sample spacing. The visible window's start and end are linearly
 *     interpolated between dense vertices, so even a long tube
 *     transitions smoothly.
 */

type EnuToWorldTransformLike = {
  yawRad: number
  translation: vec3
}

interface RoutePathProviderLike {
  isRouteReady(): boolean
  getDensePathWorldPositions(): vec3[] | null
  getUserWorldPosition(): vec3 | null
  // Optional ENU anchoring API (see MobileRouteController).
  getDensePathEnuPositions?(): vec3[] | null
  getEnuToWorldTransform?(): EnuToWorldTransformLike | null
}

const WORLD_CM_PER_METER = 100

@component
export class RoutePathRenderer extends BaseScriptComponent {
  @ui.separator
  @ui.label("Route source")
  @input("Component.ScriptComponent")
  @hint("The MobileRouteController providing the dense polyline and user world position.")
  public routeBeaconController: ScriptComponent

  @input
  @hint("The Main Camera SceneObject. Its world position is used as a fallback when the controller can't provide a user position yet.")
  public cameraObject: SceneObject

  @ui.separator
  @ui.label("Material")
  @input
  @hint("Material assigned to the tube. Cloned at runtime so each renderer instance owns its uniforms. With this script, a simple solid emissive color is enough; geometry trimming handles visibility.")
  public pathMaterial: Material

  @ui.separator
  @ui.label("Tube geometry")
  @input
  @widget(new SliderWidget(0.5, 30, 0.5))
  @hint("Tube radius in world centimetres. The tube's apparent thickness on screen.")
  public tubeRadiusCm: number = 5

  @input
  @widget(new SliderWidget(3, 16, 1))
  @hint("Number of sides on each ring of the tube. Higher = rounder, more vertices.")
  public tubeSides: number = 6

  @input
  @hint("Vertical offset (world centimetres) applied to every polyline point relative to the controller's eye-level baseline. Default ~ -150 cm puts the line on the floor for a standing user.")
  public heightOffsetCm: number = -150

  @ui.separator
  @ui.label("Visibility window (metres)")
  @input
  @widget(new SliderWidget(0, 10, 0.1))
  @hint("How far behind the user's current path progress the line is still drawn (metres). 0 = the line ends exactly under the user.")
  public visibleBehindM: number = 1

  @input
  @widget(new SliderWidget(1, 100, 1))
  @hint("How far ahead of the user's current path progress the line is drawn (metres). The arrowhead 'tipObject' caps the line at this distance.")
  public visibleAheadM: number = 20

  @ui.separator
  @ui.label("Curve smoothing")
  @input
  @hint("If true, the visible slice is subdivided with a centripetal Catmull-Rom spline before meshing, so curved roads render as smooth arcs instead of straight chords between route samples.")
  public curveSmoothingEnabled: boolean = true

  @input
  @widget(new SliderWidget(10, 200, 5))
  @hint("Target spacing (world centimetres) between subdivided points on the smoothed curve. Smaller = rounder curves, more vertices per frame.")
  public subdivisionLengthCm: number = 40

  @ui.separator
  @ui.label("Arrow tip")
  @input
  @allowUndefined
  @hint("Optional SceneObject placed at the leading edge of the visible line each frame, oriented along the path. Use any mesh you like; pass nothing to skip.")
  public tipObject: SceneObject

  @input
  @hint("The tip's local-space forward direction, before this script drives its rotation. Lens Studio cones point along local +Y by default, so use (0,1,0) for a primitive cone. Use (0,0,-1) for a model that points along Lens Studio forward (-Z).")
  public tipForward: vec3 = new vec3(0, 0, -1)

  @input
  @hint("The tip's local-space up direction. Used together with tipForward to lock the tip's roll so it stays upright (its base sits orthogonal to world up) as the path direction changes. Must not be parallel to tipForward. For a Lens Studio cone with axis along +Y, any side direction works, e.g. (0,0,1).")
  public tipUp: vec3 = new vec3(0, 0, 1)

  @input
  @hint("Vertical offset (world centimetres) applied to the tip's world position on top of the line's height offset. Useful if the tip mesh has its origin at its base / centre.")
  public tipHeightOffsetCm: number = 0

  @input
  @hint("If true, the tip is hidden when the route isn't ready, the user has arrived, or the visible window has zero length.")
  public hideTipWhenInactive: boolean = true

  @ui.separator
  @input
  @hint("If true, prints one-line status messages on build / disable.")
  public verbose: boolean = false

  // --- Cached path data (built once on first ready frame) -----------------
  private provider: RoutePathProviderLike | null = null
  private materialInstance: Material | null = null
  // In ENU mode this holds the drift-free ENU polyline (y = 0, transform
  // applied per frame); in legacy mode it holds frozen world positions
  // with `heightOffsetCm` baked in.
  private worldPath: vec3[] = []
  // True when the provider exposes the ENU anchoring API and the path was
  // cached in the ENU frame.
  private enuMode: boolean = false
  // cumulativeArcCm[i] is the arc length (in cm) from worldPath[0] to
  // worldPath[i] along the polyline. cumulativeArcCm[0] = 0. Arc length is
  // invariant under the rigid ENU->world transform, so the table is valid
  // in both modes.
  private cumulativeArcCm: number[] = []
  private totalArcCm: number = 0

  // --- Per-frame state ----------------------------------------------------
  // User's progress along the path in cm. Monotonically non-decreasing so
  // backtracking can never re-show a segment the user already passed.
  private userArcCm: number = 0
  // Previous winning segment index, used as a search hint for the next
  // closest-point projection (forward-biased local search).
  private searchHintIdx: number = 0

  // --- Mesh / scene state -------------------------------------------------
  private meshBuilder: MeshBuilder | null = null
  private mesh: RenderMesh | null = null
  private lineObject: SceneObject | null = null
  private renderMeshVisual: RenderMeshVisual | null = null
  private disabled: boolean = false
  private builtPath: boolean = false

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
  }

  private onStart(): void {
    if (isNull(this.routeBeaconController)) {
      print("[RoutePathRenderer] routeBeaconController is not assigned. Renderer disabled.")
      this.disabled = true
      return
    }
    if (isNull(this.cameraObject)) {
      print("[RoutePathRenderer] cameraObject is not assigned. Renderer disabled.")
      this.disabled = true
      return
    }
    if (isNull(this.pathMaterial)) {
      print("[RoutePathRenderer] pathMaterial is not assigned. Renderer disabled.")
      this.disabled = true
      return
    }

    const provider = this.routeBeaconController as unknown as RoutePathProviderLike
    if (
      typeof provider.isRouteReady !== "function" ||
      typeof provider.getDensePathWorldPositions !== "function" ||
      typeof provider.getUserWorldPosition !== "function"
    ) {
      print(
        "[RoutePathRenderer] routeBeaconController doesn't expose the expected RoutePathProviderLike API; is it the right script?",
      )
      this.disabled = true
      return
    }
    this.provider = provider

    this.materialInstance = this.pathMaterial.clone()
  }

  private onUpdate(): void {
    if (this.disabled || this.provider === null || this.materialInstance === null) {
      return
    }

    if (!this.provider.isRouteReady()) {
      // Route was either never built or has been ended (e.g. the iOS
      // bridge published a payload swap, which `MobileRouteController`
      // surfaces as a transient `isRouteReady() === false` edge). Drop
      // the cached polyline and empty the tube mesh so a stale line
      // doesn't linger when the user ends navigation.
      if (this.builtPath) {
        this.resetCachedPath()
      }
      this.setTipEnabled(false)
      return
    }

    if (!this.builtPath) {
      if (!this.cachePath()) {
        return
      }
    }

    if (this.worldPath.length < 2) {
      this.setTipEnabled(false)
      return
    }

    // In ENU mode, fetch the provider's current (filtered) transform once
    // per frame; both the user projection and the rendered slice use it.
    let enuXf: EnuToWorldTransformLike | null = null
    if (this.enuMode) {
      enuXf = this.provider.getEnuToWorldTransform!()
      if (enuXf === null) {
        return
      }
    }

    const userWorldPos = this.getUserWorldPos()
    if (userWorldPos === null) {
      return
    }
    // Project progress in the same frame the path is cached in.
    const userPos =
      this.enuMode && enuXf !== null ? worldToEnu(userWorldPos, enuXf) : userWorldPos

    this.advanceUserArc(userPos)

    const halfBehindCm = Math.max(0, this.visibleBehindM) * WORLD_CM_PER_METER
    const halfAheadCm = Math.max(0, this.visibleAheadM) * WORLD_CM_PER_METER
    const startArcCm = Math.max(0, this.userArcCm - halfBehindCm)
    const endArcCm = Math.min(this.totalArcCm, this.userArcCm + halfAheadCm)

    // No remaining route in front: hide line + tip.
    if (endArcCm <= startArcCm + 1) {
      this.clearMesh()
      this.setTipEnabled(false)
      return
    }

    const trimmed = this.samplePathBetween(startArcCm, endArcCm)
    if (trimmed.length < 2) {
      this.clearMesh()
      this.setTipEnabled(false)
      return
    }

    // ENU -> world for the visible slice (legacy mode is already world).
    let renderPath = trimmed
    if (this.enuMode && enuXf !== null) {
      renderPath = new Array(trimmed.length)
      for (let i = 0; i < trimmed.length; i++) {
        renderPath[i] = enuToWorld(trimmed[i], enuXf, this.heightOffsetCm)
      }
    }

    if (this.curveSmoothingEnabled && renderPath.length >= 3) {
      renderPath = catmullRomSubdivide(renderPath, Math.max(5, this.subdivisionLengthCm))
    }

    this.rebuildTube(renderPath)
    this.updateTip(renderPath, endArcCm < this.totalArcCm)
  }

  // -----------------------------------------------------------------------
  // Path caching
  // -----------------------------------------------------------------------

  /**
   * Pulls the dense polyline from the controller, computes the cumulative
   * arc-length table, and creates the shared `MeshBuilder` + line
   * SceneObject. Returns true once cached.
   *
   * Prefers the provider's ENU API: the cached polyline is then the
   * drift-free ENU path (y = 0; the live transform + `heightOffsetCm`
   * are applied per frame). Falls back to the legacy one-shot world
   * conversion (height offset baked in) when the ENU API is unavailable.
   */
  private cachePath(): boolean {
    if (this.provider === null) {
      return false
    }

    if (
      typeof this.provider.getDensePathEnuPositions === "function" &&
      typeof this.provider.getEnuToWorldTransform === "function"
    ) {
      const enuPath = this.provider.getDensePathEnuPositions()
      const enuXf = this.provider.getEnuToWorldTransform()
      if (enuPath !== null && enuPath.length >= 2 && enuXf !== null) {
        this.worldPath = enuPath
        this.enuMode = true
        return this.finishCachePath()
      }
    }

    const raw = this.provider.getDensePathWorldPositions()
    if (raw === null || raw.length < 2) {
      return false
    }

    const path: vec3[] = new Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i]
      path[i] = new vec3(p.x, p.y + this.heightOffsetCm, p.z)
    }
    this.worldPath = path
    this.enuMode = false
    return this.finishCachePath()
  }

  /** Shared tail of `cachePath`: arc table + mesh scaffold + logging. */
  private finishCachePath(): boolean {
    const path = this.worldPath

    const arc: number[] = new Array(path.length)
    arc[0] = 0
    for (let i = 1; i < path.length; i++) {
      arc[i] = arc[i - 1] + path[i].distance(path[i - 1])
    }
    this.cumulativeArcCm = arc
    this.totalArcCm = arc[arc.length - 1]
    this.userArcCm = 0
    this.searchHintIdx = 0

    if (!this.ensureMeshScaffold()) {
      return false
    }
    this.builtPath = true

    if (this.verbose) {
      print(
        "[RoutePathRenderer] Cached " +
          path.length +
          " path samples (" +
          (this.enuMode ? "ENU" : "legacy world") +
          " mode), total arc " +
          (this.totalArcCm / WORLD_CM_PER_METER).toFixed(1) +
          " m.",
      )
    }
    return true
  }

  /**
   * Lazily creates the shared MeshBuilder, the empty line SceneObject,
   * and its RenderMeshVisual. Mesh contents are filled per frame inside
   * `rebuildTube`.
   */
  private ensureMeshScaffold(): boolean {
    if (this.materialInstance === null) {
      return false
    }
    if (this.meshBuilder === null) {
      try {
        this.meshBuilder = new MeshBuilder([
          {name: "position", components: 3},
          {name: "normal", components: 3},
          {name: "texture0", components: 2},
        ])
        this.meshBuilder.topology = MeshTopology.Triangles
        this.meshBuilder.indexType = MeshIndexType.UInt16
      } catch (e) {
        print("[RoutePathRenderer] MeshBuilder construction failed: " + (e as Error).message)
        this.disabled = true
        return false
      }
    }
    if (this.lineObject === null) {
      this.lineObject = global.scene.createSceneObject("RoutePath_Line")
      this.lineObject.setParent(this.getSceneObject())
      const xform = this.lineObject.getTransform()
      xform.setWorldPosition(vec3.zero())
      xform.setWorldRotation(quat.quatIdentity())
      xform.setWorldScale(new vec3(1, 1, 1))
    }
    if (this.renderMeshVisual === null) {
      this.renderMeshVisual = this.lineObject.createComponent(
        "Component.RenderMeshVisual",
      ) as RenderMeshVisual
      this.renderMeshVisual.mainMaterial = this.materialInstance
    }
    return true
  }

  // -----------------------------------------------------------------------
  // User progress
  // -----------------------------------------------------------------------

  private getUserWorldPos(): vec3 | null {
    if (this.provider === null) {
      return null
    }
    const fromCtrl = this.provider.getUserWorldPosition()
    if (fromCtrl !== null) {
      return fromCtrl
    }
    if (!isNull(this.cameraObject)) {
      return this.cameraObject.getTransform().getWorldPosition()
    }
    return null
  }

  /**
   * Projects the user's world position onto the cached polyline,
   * searching a window of segments centred on the last winning segment
   * (`searchHintIdx`). Updates `userArcCm` to the maximum of its current
   * value and the projected arc length so progress is monotone forward.
   */
  private advanceUserArc(userPos: vec3): void {
    if (this.worldPath.length < 2) {
      return
    }
    const N = this.worldPath.length
    // Window: a few segments behind the hint to absorb interpolation
    // jitter, plus a generous lookahead since the user moves forward.
    const lookBack = 8
    const lookAhead = 64
    const startSeg = Math.max(0, this.searchHintIdx - lookBack)
    const endSeg = Math.min(N - 2, this.searchHintIdx + lookAhead)

    let bestSeg = this.searchHintIdx
    let bestT = 0
    let bestDistSq = Number.POSITIVE_INFINITY

    for (let i = startSeg; i <= endSeg; i++) {
      const a = this.worldPath[i]
      const b = this.worldPath[i + 1]
      const ab = b.sub(a)
      const ap = userPos.sub(a)
      const segLenSq = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z
      if (segLenSq < 1e-6) {
        continue
      }
      let t = (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / segLenSq
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const projX = a.x + ab.x * t
      const projY = a.y + ab.y * t
      const projZ = a.z + ab.z * t
      const dx = userPos.x - projX
      const dy = userPos.y - projY
      const dz = userPos.z - projZ
      const dSq = dx * dx + dy * dy + dz * dz
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        bestSeg = i
        bestT = t
      }
    }

    this.searchHintIdx = bestSeg
    const segArc = this.cumulativeArcCm[bestSeg + 1] - this.cumulativeArcCm[bestSeg]
    const arc = this.cumulativeArcCm[bestSeg] + bestT * segArc
    if (arc > this.userArcCm) {
      this.userArcCm = arc
    }
  }

  // -----------------------------------------------------------------------
  // Path slicing
  // -----------------------------------------------------------------------

  /**
   * Returns a small array of vec3 samples covering the cached path
   * between `startCm` and `endCm`, with linearly-interpolated start and
   * end points so the trimmed slice transitions smoothly as the window
   * slides.
   */
  private samplePathBetween(startCm: number, endCm: number): vec3[] {
    const N = this.worldPath.length
    const arc = this.cumulativeArcCm
    if (N === 0) {
      return []
    }

    // Find first index `i` with arc[i] >= startCm.
    let i = this.firstIndexAtOrAfter(startCm)
    const out: vec3[] = []

    // Interpolated start (if startCm strictly before arc[i]).
    if (i > 0 && arc[i] > startCm) {
      const a = this.worldPath[i - 1]
      const b = this.worldPath[i]
      const denom = arc[i] - arc[i - 1]
      const t = denom > 1e-6 ? (startCm - arc[i - 1]) / denom : 0
      out.push(lerpVec3(a, b, t))
    } else if (i === 0) {
      // startCm <= arc[0]: emit the first vertex directly.
      out.push(this.worldPath[0])
      i = 1
    }

    // All dense vertices strictly between startCm and endCm.
    while (i < N && arc[i] <= endCm) {
      out.push(this.worldPath[i])
      i++
    }

    // Interpolated end (if endCm strictly between arc[i-1] and arc[i]).
    if (i < N && arc[i] > endCm) {
      const a = this.worldPath[i - 1]
      const b = this.worldPath[i]
      const denom = arc[i] - arc[i - 1]
      const t = denom > 1e-6 ? (endCm - arc[i - 1]) / denom : 0
      const interp = lerpVec3(a, b, t)
      // Avoid duplicating a vertex if the previous push already landed
      // exactly on endCm.
      if (out.length === 0 || interp.distance(out[out.length - 1]) > 0.01) {
        out.push(interp)
      }
    }

    return out
  }

  private firstIndexAtOrAfter(arcCm: number): number {
    const arc = this.cumulativeArcCm
    let lo = 0
    let hi = arc.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arc[mid] < arcCm) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  // -----------------------------------------------------------------------
  // Tube mesh (rebuilt every frame)
  // -----------------------------------------------------------------------

  private clearMesh(): void {
    if (this.meshBuilder === null) {
      return
    }
    const v = this.meshBuilder.getVerticesCount()
    if (v > 0) {
      this.meshBuilder.eraseVertices(0, v)
    }
    const idx = this.meshBuilder.getIndicesCount()
    if (idx > 0) {
      this.meshBuilder.eraseIndices(0, idx)
    }
    if (this.meshBuilder.isValid()) {
      this.meshBuilder.updateMesh()
      if (this.renderMeshVisual !== null && this.mesh === null) {
        this.mesh = this.meshBuilder.getMesh()
        this.renderMeshVisual.mesh = this.mesh
      }
    }
  }

  /**
   * Drops the cached polyline + arc tables and empties the tube mesh so
   * the renderer is back to its pre-`cachePath()` state. Called when
   * the upstream `MobileRouteController` flips `isRouteReady()` off
   * mid-frame (e.g. while a new bridged route payload is being
   * applied). The mesh scaffold (line SceneObject + RenderMeshVisual)
   * is left in place; `cachePath()` will reuse it on the next route.
   */
  private resetCachedPath(): void {
    this.worldPath = []
    this.enuMode = false
    this.cumulativeArcCm = []
    this.totalArcCm = 0
    this.userArcCm = 0
    this.searchHintIdx = 0
    this.builtPath = false
    this.clearMesh()
  }

  /**
   * Builds a tube mesh from the trimmed path slice and pushes it to the
   * shared `MeshBuilder`. Vertex layout matches the one declared in
   * `ensureMeshScaffold` (position 3, normal 3, texture0 2). UVs:
   * `u = sideIndex / sides`, `v = ringIndex / (rings - 1)` so a shader
   * can address position-along-window if it wants to.
   */
  private rebuildTube(trimmed: vec3[]): void {
    if (this.meshBuilder === null || this.renderMeshVisual === null) {
      return
    }
    const sides = Math.max(3, Math.floor(this.tubeSides))
    const radius = Math.max(0.01, this.tubeRadiusCm)
    const ringCount = trimmed.length

    const vertexData: number[] = []
    const indices: number[] = []

    let refUp = new vec3(0, 1, 0)
    for (let i = 0; i < ringCount; i++) {
      let tangent: vec3
      if (i === 0) {
        tangent = trimmed[1].sub(trimmed[0])
      } else if (i === ringCount - 1) {
        tangent = trimmed[i].sub(trimmed[i - 1])
      } else {
        const inSeg = trimmed[i].sub(trimmed[i - 1])
        const outSeg = trimmed[i + 1].sub(trimmed[i])
        tangent = inSeg.add(outSeg)
      }
      tangent = safeNormalize(tangent, new vec3(0, 0, -1))

      let binormal = tangent.cross(refUp)
      if (binormal.length < 1e-3) {
        binormal = tangent.cross(new vec3(1, 0, 0))
        if (binormal.length < 1e-3) {
          binormal = tangent.cross(new vec3(0, 0, 1))
        }
      }
      binormal = binormal.normalize()
      const normal = binormal.cross(tangent).normalize()
      refUp = normal

      const center = trimmed[i]
      const v = ringCount > 1 ? i / (ringCount - 1) : 0
      for (let s = 0; s < sides; s++) {
        const theta = (s / sides) * Math.PI * 2
        const cs = Math.cos(theta)
        const sn = Math.sin(theta)
        const dirX = normal.x * cs + binormal.x * sn
        const dirY = normal.y * cs + binormal.y * sn
        const dirZ = normal.z * cs + binormal.z * sn
        const px = center.x + dirX * radius
        const py = center.y + dirY * radius
        const pz = center.z + dirZ * radius
        // Outward normal (the radial direction is already unit-length
        // because (normal, binormal) are unit and orthogonal).
        const u = s / sides
        vertexData.push(px, py, pz, dirX, dirY, dirZ, u, v)
      }
    }

    for (let i = 0; i < ringCount - 1; i++) {
      const ringA = i * sides
      const ringB = (i + 1) * sides
      for (let s = 0; s < sides; s++) {
        const sNext = (s + 1) % sides
        const a0 = ringA + s
        const a1 = ringA + sNext
        const b0 = ringB + s
        const b1 = ringB + sNext
        indices.push(a0, b0, b1)
        indices.push(a0, b1, a1)
      }
    }

    const oldVerts = this.meshBuilder.getVerticesCount()
    if (oldVerts > 0) {
      this.meshBuilder.eraseVertices(0, oldVerts)
    }
    const oldIdx = this.meshBuilder.getIndicesCount()
    if (oldIdx > 0) {
      this.meshBuilder.eraseIndices(0, oldIdx)
    }
    this.meshBuilder.appendVerticesInterleaved(vertexData)
    this.meshBuilder.appendIndices(indices)

    if (!this.meshBuilder.isValid()) {
      // Don't propagate - just leave the previous mesh on screen.
      return
    }
    this.meshBuilder.updateMesh()

    if (this.mesh === null) {
      this.mesh = this.meshBuilder.getMesh()
      this.renderMeshVisual.mesh = this.mesh
    }
  }

  // -----------------------------------------------------------------------
  // Tip placement
  // -----------------------------------------------------------------------

  /**
   * Drops the tip at the leading edge of the visible window and
   * orients its `tipForward` axis along the path's forward tangent
   * there. The tangent is projected onto the horizontal plane so the
   * tip always sits orthogonal to world up - the line on the floor
   * never pitches the tip up or down even if the path's vertices
   * have any vertical jitter. The tip's roll is also locked so its
   * `tipUp` axis points toward world up; this prevents the cone /
   * arrowhead from twisting around its own axis as the path turns,
   * which would otherwise leave its base looking skewed instead of
   * orthogonal to the line. `hasMoreRoute` is false once the visible
   * window butts up against the destination, in which case we hide
   * the tip (the destination beacon takes over as the marker).
   */
  private updateTip(trimmed: vec3[], hasMoreRoute: boolean): void {
    if (isNull(this.tipObject)) {
      return
    }
    if (!hasMoreRoute && this.hideTipWhenInactive) {
      this.setTipEnabled(false)
      return
    }
    if (trimmed.length < 2) {
      this.setTipEnabled(false)
      return
    }
    this.setTipEnabled(true)

    const last = trimmed[trimmed.length - 1]
    const prev = trimmed[trimmed.length - 2]
    const horizontalTangent = safeNormalize(
      new vec3(last.x - prev.x, 0, last.z - prev.z),
      new vec3(0, 0, -1),
    )

    const xform = this.tipObject.getTransform()
    const tipPos = new vec3(last.x, last.y + this.tipHeightOffsetCm, last.z)
    xform.setWorldPosition(tipPos)

    const localFwd = safeNormalize(this.tipForward, new vec3(0, 1, 0))
    const localUp = safeNormalize(this.tipUp, new vec3(0, 0, 1))
    xform.setWorldRotation(
      orthogonalLookRotation(localFwd, localUp, horizontalTangent, vec3.up()),
    )
  }

  private setTipEnabled(enabled: boolean): void {
    if (isNull(this.tipObject)) {
      return
    }
    if (this.hideTipWhenInactive) {
      if (this.tipObject.enabled !== enabled) {
        this.tipObject.enabled = enabled
      }
    } else if (!this.tipObject.enabled) {
      this.tipObject.enabled = true
    }
  }
}

/**
 * Applies the ENU->world transform to an ENU point (cm):
 * `world = R_y(yaw) * p + T`, plus the renderer's floor offset. ENU path
 * points have y = 0, so the vertical comes entirely from the transform's
 * translation (camera eye level) + `heightOffsetCm`.
 */
function enuToWorld(p: vec3, xf: EnuToWorldTransformLike, heightOffsetCm: number): vec3 {
  const c = Math.cos(xf.yawRad)
  const s = Math.sin(xf.yawRad)
  return new vec3(
    p.x * c + p.z * s + xf.translation.x,
    xf.translation.y + p.y + heightOffsetCm,
    -p.x * s + p.z * c + xf.translation.z,
  )
}

/**
 * Inverse of `enuToWorld` (ignoring height): brings a world position into
 * the ENU frame so user progress can be projected onto the cached ENU
 * polyline. Y is zeroed because the ENU path is flat; this keeps the
 * closest-segment projection purely horizontal.
 */
function worldToEnu(w: vec3, xf: EnuToWorldTransformLike): vec3 {
  const c = Math.cos(xf.yawRad)
  const s = Math.sin(xf.yawRad)
  const dx = w.x - xf.translation.x
  const dz = w.z - xf.translation.z
  return new vec3(dx * c - dz * s, 0, dx * s + dz * c)
}

/**
 * Subdivides a polyline with a centripetal Catmull-Rom spline so segments
 * render as smooth arcs. Centripetal parameterisation (alpha = 0.5) never
 * produces loops or overshoot even with the uneven 2-15 m sample spacing
 * the iOS bridge sends. Each source segment is split into
 * `ceil(len / targetStepCm)` pieces (capped to keep per-frame vertex
 * counts bounded). Endpoints are preserved exactly, which matters because
 * the slice's first/last points are the interpolated visible-window edges.
 */
function catmullRomSubdivide(points: vec3[], targetStepCm: number): vec3[] {
  const n = points.length
  if (n < 3) {
    return points
  }
  const out: vec3[] = [points[0]]
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(n - 1, i + 2)]
    const segLen = p1.distance(p2)
    if (segLen < 1e-3) {
      continue
    }
    const divisions = Math.max(1, Math.min(24, Math.ceil(segLen / targetStepCm)))
    for (let d = 1; d < divisions; d++) {
      out.push(catmullRomCentripetal(p0, p1, p2, p3, d / divisions))
    }
    out.push(p2)
  }
  return out
}

/**
 * Evaluates the centripetal Catmull-Rom spline through p1..p2 at
 * `t` in [0, 1]. Degenerate knot intervals (duplicated points) fall back
 * to linear interpolation.
 */
function catmullRomCentripetal(p0: vec3, p1: vec3, p2: vec3, p3: vec3, t: number): vec3 {
  const eps = 1e-4
  const t0 = 0
  const t1 = t0 + Math.max(eps, Math.sqrt(p0.distance(p1)))
  const t2 = t1 + Math.max(eps, Math.sqrt(p1.distance(p2)))
  const t3 = t2 + Math.max(eps, Math.sqrt(p2.distance(p3)))
  const tt = t1 + (t2 - t1) * t

  const a1 = lerpVec3(p0, p1, (tt - t0) / (t1 - t0))
  const a2 = lerpVec3(p1, p2, (tt - t1) / (t2 - t1))
  const a3 = lerpVec3(p2, p3, (tt - t2) / (t3 - t2))
  const b1 = lerpVec3(a1, a2, (tt - t0) / (t2 - t0))
  const b2 = lerpVec3(a2, a3, (tt - t1) / (t3 - t1))
  return lerpVec3(b1, b2, (tt - t1) / (t2 - t1))
}

function safeNormalize(v: vec3, fallback: vec3): vec3 {
  const l = v.length
  if (l < 1e-6) {
    return fallback
  }
  return v.uniformScale(1 / l)
}

function lerpVec3(a: vec3, b: vec3, t: number): vec3 {
  return new vec3(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t,
  )
}

/**
 * Returns a quaternion that rotates `from` into `to`. Both inputs are
 * expected to be non-zero; they are normalised internally. Handles the
 * anti-parallel (180°) case by picking an arbitrary perpendicular axis.
 */
function rotationFromTo(from: vec3, to: vec3): quat {
  const f = safeNormalize(from, new vec3(0, 0, -1))
  const t = safeNormalize(to, new vec3(0, 0, -1))
  const d = f.dot(t)
  if (d > 0.999999) {
    return quat.quatIdentity()
  }
  if (d < -0.999999) {
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

/**
 * Builds a rotation that maps `localFwd` onto `worldFwd` AND
 * `localUp` onto `worldUp` (or onto the closest direction to
 * `worldUp` that is orthogonal to `worldFwd`). Two-axis alignment
 * removes the arbitrary roll that `rotationFromTo` would otherwise
 * pick from the cross product, so an asymmetric tip mesh stays
 * visually upright and its base sits orthogonal to world up
 * regardless of which way the path turns.
 */
function orthogonalLookRotation(
  localFwd: vec3,
  localUp: vec3,
  worldFwd: vec3,
  worldUp: vec3,
): quat {
  const wf = safeNormalize(worldFwd, new vec3(0, 0, -1))
  const q1 = rotationFromTo(localFwd, wf)

  // After q1 the local-up axis lands somewhere on the unit sphere;
  // we want to twist around `wf` so it points the same way as
  // `worldUp`. Project both onto the plane perpendicular to `wf`
  // and rotate the projected local-up onto the projected world-up.
  const lu1 = q1.multiplyVec3(localUp)
  const lu1p = safeNormalize(
    lu1.sub(wf.uniformScale(lu1.dot(wf))),
    new vec3(0, 1, 0),
  )
  const wupp = safeNormalize(
    worldUp.sub(wf.uniformScale(worldUp.dot(wf))),
    new vec3(0, 1, 0),
  )

  const dot = Math.max(-1, Math.min(1, lu1p.dot(wupp)))
  if (dot > 0.999999) {
    return q1
  }
  let angle = Math.acos(dot)
  if (lu1p.cross(wupp).dot(wf) < 0) {
    angle = -angle
  }
  const q2 = quat.angleAxis(angle, wf)
  return q2.multiply(q1)
}
