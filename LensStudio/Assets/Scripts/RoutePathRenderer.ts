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
 *   - The cached path is anchored at first build using GPS + compass.
 *     Subsequent frames keep using that anchor; world tracking is what
 *     makes the line stick to the world. There is no automatic
 *     re-anchoring (we never recompute the cached vertices), so the
 *     `userArcCm` progress stays consistent across frames.
 *   - For seamless trimming, the controller's path sample spacing
 *     should stay small (the iOS bridge sends ~2 m). The visible
 *     window's start and end are linearly interpolated between dense
 *     vertices, so even a long tube transitions smoothly.
 */

interface RoutePathProviderLike {
  isRouteReady(): boolean
  getDensePathWorldPositions(): vec3[] | null
  getUserWorldPosition(): vec3 | null
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
  @ui.label("Arrow tip")
  @input
  @allowUndefined
  @hint("Optional SceneObject placed at the leading edge of the visible line each frame, oriented along the path. Use any mesh you like; pass nothing to skip.")
  public tipObject: SceneObject

  @input
  @hint("The tip's local-space forward direction, before this script drives its rotation. Lens Studio cones point along local +Y by default, so use (0,1,0) for a primitive cone. Use (0,0,-1) for a model that points along Lens Studio forward (-Z).")
  public tipForward: vec3 = new vec3(0, 0, -1)

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
  private worldPath: vec3[] = []
  // cumulativeArcCm[i] is the arc length (in cm) from worldPath[0] to
  // worldPath[i] along the polyline. cumulativeArcCm[0] = 0.
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

    const userPos = this.getUserWorldPos()
    if (userPos === null) {
      return
    }

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

    this.rebuildTube(trimmed)
    this.updateTip(trimmed, endArcCm < this.totalArcCm)
  }

  // -----------------------------------------------------------------------
  // Path caching
  // -----------------------------------------------------------------------

  /**
   * Pulls the dense polyline from the controller, applies the height
   * offset, computes the cumulative arc-length table, and creates the
   * shared `MeshBuilder` + line SceneObject. Returns true once cached.
   */
  private cachePath(): boolean {
    if (this.provider === null) {
      return false
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
          " path samples, total arc " +
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
   * there. `hasMoreRoute` is false once the visible window butts up
   * against the destination, in which case we hide the tip (the
   * destination beacon takes over as the marker).
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
    const tangent = safeNormalize(last.sub(prev), new vec3(0, 0, -1))

    const xform = this.tipObject.getTransform()
    const tipPos = new vec3(last.x, last.y + this.tipHeightOffsetCm, last.z)
    xform.setWorldPosition(tipPos)

    const localFwd = safeNormalize(this.tipForward, new vec3(0, 0, -1))
    xform.setWorldRotation(rotationFromTo(localFwd, tangent))
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
