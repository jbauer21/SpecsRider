import {SpecsRiderBridge} from "./SpecsRiderBridge"

/**
 * MobilePairingPrompt
 *
 * Shows a "please pair your phone" warning whenever the SpecsRider iOS
 * companion app is not connected to the lens. The script listens to the
 * `SpecsRiderBridge` lifecycle:
 *
 *   - On start the prompt is enabled (assume not paired until the bridge
 *     reports otherwise).
 *   - When the bridge fires `onConnected`, the prompt is hidden. The
 *     bridge synchronously fires `onConnected` at registration time if
 *     the session is already up, so this also handles late initialisers.
 *   - When the bridge fires `onDisconnected`, the prompt is shown again.
 *     The bridge auto-reconnects, so the prompt will hide on its own as
 *     soon as the phone reappears.
 *
 * Wire `warningObject` to the SceneObject holding the warning Text (or
 * the whole banner, if the banner contains other decorations as well).
 * The default `message` matches the copy requested in the design spec;
 * point `messageText` at a Text component to have this script overwrite
 * its content on start, or leave it unassigned if the prefab already
 * has the copy baked in.
 */
@component
export class MobilePairingPrompt extends BaseScriptComponent {
  @ui.separator
  @ui.label("Bridge")
  @input("Component.ScriptComponent")
  @hint("The SpecsRiderBridge ScriptComponent. Used to detect when the iOS companion app is connected.")
  public bridge: ScriptComponent

  @ui.separator
  @ui.label("Warning UI")
  @input
  @hint("SceneObject toggled on/off based on pairing state. Enabled while the phone is NOT connected, disabled once it is.")
  public warningObject: SceneObject

  @input
  @allowUndefined
  @hint("Optional Text component whose .text is set to 'message' on start. Leave empty if your prefab already has the copy baked in.")
  public messageText: Text | undefined

  @input
  @hint("Copy shown to the user while the phone is not paired.")
  public message: string =
    "Mobile device is not connected! Make sure to pair the Spectacles within SpecsRider to continue!"

  @ui.separator
  @ui.label("Behaviour")
  @input
  @hint("If true, prints pairing state transitions to the log.")
  public verbose: boolean = false

  private bridgeApi: SpecsRiderBridge | null = null

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart(): void {
    if (this.messageText !== undefined && !isNull(this.messageText)) {
      this.messageText.text = this.message
    }

    this.setWarningVisible(true)

    if (isNull(this.bridge)) {
      print("[MobilePairingPrompt] bridge is not assigned. Warning will stay visible.")
      return
    }

    const api = this.bridge as unknown as SpecsRiderBridge
    if (
      typeof api.addOnConnected !== "function" ||
      typeof api.addOnDisconnected !== "function"
    ) {
      print("[MobilePairingPrompt] bridge ScriptComponent isn't a SpecsRiderBridge.")
      return
    }
    this.bridgeApi = api

    this.bridgeApi.addOnConnected(() => this.onBridgeConnected())
    this.bridgeApi.addOnDisconnected(() => this.onBridgeDisconnected())
  }

  private onBridgeConnected(): void {
    if (this.verbose) {
      print("[MobilePairingPrompt] phone connected - hiding warning.")
    }
    this.setWarningVisible(false)
  }

  private onBridgeDisconnected(): void {
    if (this.verbose) {
      print("[MobilePairingPrompt] phone disconnected - showing warning.")
    }
    this.setWarningVisible(true)
  }

  private setWarningVisible(visible: boolean): void {
    if (isNull(this.warningObject)) {
      return
    }
    this.warningObject.enabled = visible
  }
}
