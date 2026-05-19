import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import {BaseHand} from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/BaseHand"

/**
 * LeftPalmMenuAnchor
 *
 * Pins a menu SceneObject to the user's left palm and toggles its visibility
 * based on whether the palm (or back of the hand, see useBackOfHand) is
 * facing the camera. Designed for classic palm-up menu interactions, plus a
 * "handlebar grip" variant that triggers when the user looks down at the
 * back of their hand:
 *
 *   - Menu appears (fades + scales in) when the targeted side of the hand
 *     faces the user for a short dwell time.
 *   - Menu disappears (fades + scales out) when the hand turns away or the
 *     hand is lost by tracking.
 *   - Open / close angles use hysteresis so the menu doesn't flicker while
 *     the hand hovers near the threshold.
 *
 * The menu's world position is driven by SIK's palm center estimate each
 * frame, with an offset expressed in the palm's local basis (right / up /
 * forward of the middle knuckle joint). Rotation optionally follows the
 * palm so the menu rolls with the hand.
 *
 * This script does not re-parent the menu SceneObject, it simply writes its
 * world transform each frame. Keep the menu root outside any other tracked
 * rigs to avoid double-parenting.
 */
@component
export class LeftPalmMenuAnchor extends BaseScriptComponent {
  @ui.separator
  @ui.label("Menu Target")
  @input
  @hint("The root SceneObject to anchor above the left palm.")
  public menuObject!: SceneObject

  @ui.separator
  @ui.label("Placement")
  @input
  @hint("Offset from the palm center, expressed in the palm's local basis (x=right, y=up, z=forward relative to the middle knuckle).")
  public localOffset: vec3 = new vec3(0, 3, 0)

  @input
  @hint("If true, the menu rotates with the palm. If false, the menu keeps its current world rotation (useful if you billboard it elsewhere).")
  public matchPalmRotation: boolean = true

  @input
  @hint("Extra rotation (Euler angles in degrees) applied on top of the palm rotation. Interpreted in the palm's local frame: x=pitch around palm-right, y=yaw around palm-up, z=roll around palm-forward.")
  public rotationOffsetDeg: vec3 = vec3.zero()

  @ui.separator
  @ui.label("Facing Detection")
  @input
  @hint("If true, the menu opens when the BACK of the hand faces the camera (looking down at the dorsal side, e.g. handlebar grip pose). If false, it opens when the PALM faces the camera (classic palm-up menu).")
  public useBackOfHand: boolean = false

  @input
  @widget(new SliderWidget(0, 60, 1))
  @hint("Hand-to-camera angle (degrees) at or below which the menu begins to open. Measured against the palm by default; against the back of the hand when useBackOfHand is enabled.")
  public openAngleDeg: number = 25

  @input
  @widget(new SliderWidget(0, 90, 1))
  @hint("Hand-to-camera angle (degrees) at or above which the menu begins to close. Should be greater than openAngleDeg for hysteresis.")
  public closeAngleDeg: number = 45

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("How long (seconds) the palm must stay facing the camera before the menu opens. Prevents accidental glances.")
  public openDwellS: number = 0.15

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Grace period (seconds) during which brief tracking hiccups won't close the menu.")
  public closeDelayS: number = 0.1

  @ui.separator
  @ui.label("Transition")
  @input
  @widget(new SliderWidget(0.01, 1, 0.01))
  @hint("Seconds to fully fade/scale in.")
  public fadeInS: number = 0.18

  @input
  @widget(new SliderWidget(0.01, 1, 0.01))
  @hint("Seconds to fully fade/scale out.")
  public fadeOutS: number = 0.15

  @input
  @hint("When enabled, the menu root is scaled between minScale and its authored scale to create a pop-in effect.")
  public useScale: boolean = true

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Starting scale (as a fraction of authored scale) at alpha 0. 1 disables the scale effect.")
  public minScale: number = 0.2

  private hand: BaseHand | null = null
  private menuTransform: Transform | null = null

  private authoredScale: vec3 = vec3.one()

  private isOpen: boolean = false
  private facingSinceT: number | null = null
  private notFacingSinceT: number | null = null

  private currentAlpha: number = 0
  private targetAlpha: number = 0

  private handLost: boolean = false

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind((event: UpdateEvent) => this.onUpdate(event))
  }

  private onStart(): void {
    if (isNull(this.menuObject)) {
      print("[LeftPalmMenu] menuObject is not assigned. Anchor will be disabled.")
      return
    }

    this.menuTransform = this.menuObject.getTransform()
    this.authoredScale = this.menuTransform.getLocalScale()

    this.currentAlpha = 0
    this.targetAlpha = 0
    this.isOpen = false
    this.facingSinceT = null
    this.notFacingSinceT = null

    this.menuObject.enabled = false
    this.applyScale(0)

    try {
      this.hand = SIK.HandInputData.getHand("left")
    } catch (e) {
      this.hand = null
      print("[LeftPalmMenu] Unable to get left hand from SIK.HandInputData; menu will stay hidden.")
      return
    }

    if (this.hand === null) {
      print("[LeftPalmMenu] Left hand is not available; menu will stay hidden.")
      return
    }

    this.hand.onHandLost.add(() => {
      this.handLost = true
    })
    this.hand.onHandFound.add(() => {
      this.handLost = false
    })
  }

  private onUpdate(event: UpdateEvent): void {
    if (this.menuTransform === null) {
      return
    }

    const dt = event.getDeltaTime()
    if (dt <= 0) {
      return
    }

    this.targetAlpha = this.computeTargetAlpha()

    const fadeDuration = this.targetAlpha > this.currentAlpha
      ? Math.max(0.001, this.fadeInS)
      : Math.max(0.001, this.fadeOutS)
    const step = dt / fadeDuration
    this.currentAlpha = moveToward(this.currentAlpha, this.targetAlpha, step)

    const shouldBeEnabled = this.currentAlpha > 0.001
    if (this.menuObject.enabled !== shouldBeEnabled) {
      this.menuObject.enabled = shouldBeEnabled
    }

    if (shouldBeEnabled) {
      this.followPalm()
      this.applyScale(this.currentAlpha)
    }
  }

  /**
   * Runs the hysteresis + dwell state machine against the current facing
   * angle and returns the target alpha (0 hidden, 1 visible). Also updates
   * isOpen / dwell timers as a side effect.
   */
  private computeTargetAlpha(): number {
    if (this.hand === null || this.handLost || !this.hand.isTracked()) {
      this.isOpen = false
      this.facingSinceT = null
      this.notFacingSinceT = null
      return 0
    }

    const rawAngle = this.hand.getFacingCameraAngle()
    if (rawAngle === null) {
      this.isOpen = false
      this.facingSinceT = null
      this.notFacingSinceT = null
      return 0
    }

    // SIK's getFacingCameraAngle returns the palm-to-camera angle. When the
    // back of the hand is what the user looks at (e.g. resting on handlebars),
    // the palm is pointing away from the camera, so the relevant angle is the
    // supplement.
    const angle = this.useBackOfHand ? 180 - rawAngle : rawAngle

    const now = getTime()

    if (!this.isOpen) {
      if (angle <= this.openAngleDeg) {
        if (this.facingSinceT === null) {
          this.facingSinceT = now
        }
        if (now - this.facingSinceT >= this.openDwellS) {
          this.isOpen = true
          this.notFacingSinceT = null
        }
      } else {
        this.facingSinceT = null
      }
    } else {
      if (angle >= this.closeAngleDeg) {
        if (this.notFacingSinceT === null) {
          this.notFacingSinceT = now
        }
        if (now - this.notFacingSinceT >= this.closeDelayS) {
          this.isOpen = false
          this.facingSinceT = null
        }
      } else {
        this.notFacingSinceT = null
      }
    }

    return this.isOpen ? 1 : 0
  }

  private followPalm(): void {
    if (this.hand === null || this.menuTransform === null) {
      return
    }

    const palmCenter = this.hand.getPalmCenter()
    if (palmCenter === null) {
      return
    }

    const kp = this.hand.middleKnuckle
    // In back-of-hand mode, "up" is the dorsal side, so we flip the y/z basis
    // so that a positive localOffset.y still pushes the menu *toward* the side
    // the user is currently looking at.
    const sideSign = this.useBackOfHand ? -1 : 1
    const offsetWorld = kp.right.uniformScale(this.localOffset.x)
      .add(kp.up.uniformScale(this.localOffset.y * sideSign))
      .add(kp.forward.uniformScale(this.localOffset.z))

    this.menuTransform.setWorldPosition(palmCenter.add(offsetWorld))

    if (this.matchPalmRotation) {
      const offsetRot = this.getRotationOffsetQuat()
      // In back-of-hand mode the menu's authored facing direction is now
      // pointing away from the user (and would render mirrored). The user is
      // expected to compensate with rotationOffsetDeg (typically y=180).
      if (offsetRot === null) {
        this.menuTransform.setWorldRotation(kp.rotation)
      } else {
        this.menuTransform.setWorldRotation(kp.rotation.multiply(offsetRot))
      }
    }
  }

  private getRotationOffsetQuat(): quat | null {
    const r = this.rotationOffsetDeg
    if (r.x === 0 && r.y === 0 && r.z === 0) {
      return null
    }
    const DEG_TO_RAD = Math.PI / 180
    return quat.fromEulerVec(new vec3(r.x * DEG_TO_RAD, r.y * DEG_TO_RAD, r.z * DEG_TO_RAD))
  }

  private applyScale(alpha: number): void {
    if (this.menuTransform === null) {
      return
    }
    if (!this.useScale) {
      this.menuTransform.setLocalScale(this.authoredScale)
      return
    }

    const eased = smoothstep(alpha)
    const min = Math.max(0, Math.min(1, this.minScale))
    const factor = min + (1 - min) * eased
    this.menuTransform.setLocalScale(this.authoredScale.uniformScale(factor))
  }
}

function moveToward(current: number, target: number, maxStep: number): number {
  if (current < target) {
    return Math.min(current + maxStep, target)
  }
  if (current > target) {
    return Math.max(current - maxStep, target)
  }
  return current
}

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * (3 - 2 * clamped)
}
