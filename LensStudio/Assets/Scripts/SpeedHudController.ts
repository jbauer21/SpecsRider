import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"

// Lens Studio world-space units are centimeters.
// 1 cm/s -> km/h  : (cm/s) * 0.036
// 1 cm/s -> mph   : (cm/s) * 0.0223693629
const CM_PER_S_TO_KMH = 0.036
const CM_PER_S_TO_MPH = 0.0223693629
const KMH_TO_CM_PER_S = 1 / CM_PER_S_TO_KMH

/**
 * SpeedHudController
 *
 * Measures the user's current velocity by sampling the change in world-space
 * position over time, then writes a formatted speed value to the HUD's
 * `Speed` Text component. The calculation is performed locally on-device.
 *
 * The tracked point is the world camera (i.e. the user's head). If the world
 * camera cannot be located, the script falls back to tracking its own
 * SceneObject so it still behaves sanely in preview.
 */
@component
export class SpeedHudController extends BaseScriptComponent {
  @input
  @hint("Text component on the HUD that will display the current speed.")
  public speedText: Text

  @ui.separator
  @ui.label("Units")
  @input
  @label("Use mph")
  @hint("When enabled, the HUD shows miles per hour. When disabled, it shows kilometers per hour.")
  public useMph: boolean = false

  @ui.separator
  @ui.label("Sampling")
  @input
  @widget(new SliderWidget(0.05, 2.0, 0.05))
  @hint("How often (in seconds) to sample the user's world position. Lower = more responsive, higher = smoother.")
  public pollIntervalS: number = 0.5

  @input
  @widget(new SliderWidget(0.0, 1.0, 0.01))
  @hint("Exponential moving-average factor applied to the displayed speed. 1 = no smoothing, 0 = frozen.")
  public outputSmoothAlpha: number = 0.25

  @ui.separator
  @ui.label("Display")
  @input
  @hint("Speeds (in km/h) below this threshold are displayed as 0 to eliminate tracking jitter at rest.")
  public minDisplaySpeedKmh: number = 1.0

  @input
  @hint("Maximum speed (in km/h) that will be displayed. Values above this are clamped.")
  public maxSpeedKmh: number = 80.0

  @input
  @hint("If no new sample arrives within this many seconds, the HUD falls back to 0 (safety against stalled tracking).")
  public staleTimeoutS: number = 3.0

  private cameraProvider: WorldCameraFinderProvider | null = null
  private fallbackTransform: Transform | null = null

  private hasLastSample: boolean = false
  private lastSamplePosition: vec3 = vec3.zero()
  private timeSinceLastSample: number = 0
  private timeSinceLastValidReading: number = 0
  private smoothedSpeedCmPerS: number = 0

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind((event: UpdateEvent) => this.onUpdate(event))
  }

  private onStart(): void {
    try {
      this.cameraProvider = WorldCameraFinderProvider.getInstance()
    } catch (e) {
      // No world camera in the scene (e.g. running the lens in a non-AR
      // preview). Fall back to sampling this script's own SceneObject.
      this.cameraProvider = null
      this.fallbackTransform = this.getTransform()
      print("[SpeedHudController] World camera not found; falling back to local transform for velocity sampling.")
    }

    this.hasLastSample = false
    this.timeSinceLastSample = 0
    this.timeSinceLastValidReading = 0
    this.smoothedSpeedCmPerS = 0
    this.writeSpeedText(0)
  }

  private onUpdate(event: UpdateEvent): void {
    const dt = event.getDeltaTime()
    if (dt <= 0) {
      return
    }

    this.timeSinceLastSample += dt
    this.timeSinceLastValidReading += dt

    const interval = Math.max(0.05, this.pollIntervalS)
    if (this.timeSinceLastSample < interval) {
      if (this.timeSinceLastValidReading > this.staleTimeoutS) {
        this.smoothedSpeedCmPerS = 0
        this.writeSpeedText(0)
      }
      return
    }

    const elapsed = this.timeSinceLastSample
    this.timeSinceLastSample = 0

    const currentPosition = this.readTrackedWorldPosition()
    if (currentPosition === null) {
      return
    }

    if (!this.hasLastSample) {
      this.lastSamplePosition = currentPosition
      this.hasLastSample = true
      return
    }

    const deltaCm = currentPosition.distance(this.lastSamplePosition)
    this.lastSamplePosition = currentPosition

    const instantaneousCmPerS = deltaCm / elapsed

    const alpha = Math.max(0, Math.min(1, this.outputSmoothAlpha))
    this.smoothedSpeedCmPerS = alpha * instantaneousCmPerS + (1 - alpha) * this.smoothedSpeedCmPerS

    this.timeSinceLastValidReading = 0
    this.writeSpeedText(this.smoothedSpeedCmPerS)
  }

  private readTrackedWorldPosition(): vec3 | null {
    if (this.cameraProvider !== null) {
      return this.cameraProvider.getWorldPosition()
    }
    if (this.fallbackTransform !== null) {
      return this.fallbackTransform.getWorldPosition()
    }
    return null
  }

  private writeSpeedText(speedCmPerS: number): void {
    if (isNull(this.speedText)) {
      return
    }

    const speedKmh = speedCmPerS * CM_PER_S_TO_KMH
    const displayKmh = speedKmh < this.minDisplaySpeedKmh ? 0 : Math.min(speedKmh, this.maxSpeedKmh)

    let displayValue: number
    let units: string
    if (this.useMph) {
      // Convert the already-clamped km/h value back to the native speed so
      // clamp/min thresholds (defined in km/h) stay consistent across units.
      const clampedCmPerS = displayKmh * KMH_TO_CM_PER_S
      displayValue = clampedCmPerS * CM_PER_S_TO_MPH
      units = "mph"
    } else {
      displayValue = displayKmh
      units = "km/h"
    }

    this.speedText.text = `${displayValue.toFixed(0)} ${units}`
  }
}
