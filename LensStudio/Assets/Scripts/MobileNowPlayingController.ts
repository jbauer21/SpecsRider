import {RectangleButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton"

import {BridgeTopic, SpecsRiderBridge, JsonSubscriptionHandle} from "./SpecsRiderBridge"

/**
 * MobileNowPlayingController
 *
 * Bridge-fed replacement for the legacy `MusicPlaybackController` and
 * `SpotifyPlaylistMenuController`. Mirrors the now-playing card the
 * SpecsRider iOS app exposes via `MPNowPlayingInfoCenter` over the
 * SpectaclesMobileKit bridge:
 *
 *   1. Subscribes to the `nowPlaying` topic. The payload (see
 *      `Music/NowPlayingPayload.swift` in the iOS project) carries:
 *        { title, artist, album, isPlaying, artworkVersion,
 *          durationMs, elapsedMs }
 *      The controller writes title / artist / album into Text
 *      components, swaps play / pause icons based on `isPlaying`, and
 *      reloads the album-art Image whenever `artworkVersion` changes.
 *
 *   2. The album-art image is served by the iOS app at the well-known
 *      asset URI `spectacleskit://albumArt.jpg` (JPEG bytes, sized for
 *      BLE bandwidth — see iOS `NowPlayingService.updateArtwork`). We
 *      load it via `RemoteMediaModule.loadResourceAsImageTexture`,
 *      exactly as the legacy `SpotifyPlaylistMenuController.loadImageInto`
 *      did with Spotify CDN URLs — except now the bytes come from the
 *      phone.
 *
 *   3. The pause/play, skip, and (optional) previous buttons send
 *      `media/toggle`, `media/next`, and `media/previous` requests on
 *      the bridge. The button presses are *optimistic*: the local
 *      `isPlaying` state flips immediately so the icon swap feels
 *      instantaneous, and the next `nowPlaying` payload from the phone
 *      reconciles authoritative state.
 *
 * The controller is a drop-in for the existing pause/play and skip
 * RectangleButtons + the existing title / artist Text components. No
 * new prefab is required; just rewire the inspector inputs to whichever
 * SceneObjects already host the now-playing UI.
 */
@component
export class MobileNowPlayingController extends BaseScriptComponent {
  @ui.separator
  @ui.label("Bridge")
  @input("Component.ScriptComponent")
  @hint("The SpecsRiderBridge ScriptComponent. Subscribes to the 'nowPlaying' topic and sends 'media/*' requests.")
  public bridge: ScriptComponent

  @ui.separator
  @ui.label("Modules")
  @input
  @hint("Drag the Internet Module asset from the Asset Browser here. Required to mint the spectacleskit:// album-art resource.")
  public internetModule: InternetModule

  @input
  @hint("Drag the Remote Media Module asset from the Asset Browser here. Used to decode the album-art JPEG bytes streamed from the iOS app.")
  public remoteMediaModule: RemoteMediaModule

  @ui.separator
  @ui.label("Transport buttons")
  @input
  @hint("RectangleButton (SpectaclesUIKit) the user taps to toggle play/pause. Sends 'media/toggle'.")
  public pausePlayButton: RectangleButton

  @input
  @allowUndefined
  @hint("Child SceneObject of the pause/play button showing the 'play' icon. Enabled while paused.")
  public playIcon: SceneObject | undefined

  @input
  @allowUndefined
  @hint("Child SceneObject of the pause/play button showing the 'pause' icon. Enabled while playing.")
  public pauseIcon: SceneObject | undefined

  @input
  @hint("RectangleButton (SpectaclesUIKit) the user taps to skip to the next track. Sends 'media/next'.")
  public skipButton: RectangleButton

  @input
  @allowUndefined
  @hint("Optional RectangleButton (SpectaclesUIKit) for previous track. Sends 'media/previous' if assigned.")
  public prevButton: RectangleButton | undefined

  @ui.separator
  @ui.label("Now Playing UI")
  @input
  @allowUndefined
  @hint("Image component receiving album art. Its mainPass.baseTex is overwritten when the bridged artwork version changes.")
  public albumArtImage: Image | undefined

  @input
  @allowUndefined
  @hint("Text component showing the current track title.")
  public titleText: Text | undefined

  @input
  @allowUndefined
  @hint("Text component showing the current track artist(s).")
  public artistText: Text | undefined

  @input
  @allowUndefined
  @hint("Text component showing the current track album.")
  public albumText: Text | undefined

  @ui.separator
  @ui.label("Behaviour")
  @input
  @hint("If true, prints verbose now-playing updates to the log.")
  public verbose: boolean = false

  @input
  @hint("Optional fallback text used when the bridge has not yet supplied a value (e.g. while disconnected).")
  public placeholderTitle: string = ""

  // -- internal state --

  private bridgeApi: SpecsRiderBridge | null = null
  private subscription: JsonSubscriptionHandle | null = null

  private isPlaying: boolean = false
  // Resolved version of the album art currently shown in `albumArtImage`.
  // Compared against incoming `artworkVersion` to decide whether to
  // refetch the texture. An empty string means "no art loaded yet".
  private currentArtworkVersion: string = ""
  // Tracks the resource currently being loaded so that callbacks from
  // older fetches can be ignored when the user skips quickly.
  private inFlightArtId: number = 0
  // Whether we've already swapped `albumArtImage.mainMaterial` for a
  // per-instance clone. We only need to clone once per controller; after
  // that, the cloned material's `baseTex` can be updated for every track.
  private albumArtMaterialCloned: boolean = false

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private onStart(): void {
    this.applyIconState()
    this.setText(this.titleText, this.placeholderTitle)
    this.setText(this.artistText, "")
    this.setText(this.albumText, "")

    if (isNull(this.bridge)) {
      print("[MobileNowPlaying] bridge is not assigned. Controller disabled.")
      return
    }
    if (isNull(this.internetModule) || isNull(this.remoteMediaModule)) {
      print("[MobileNowPlaying] internetModule and remoteMediaModule must both be assigned.")
      return
    }

    this.bridgeApi = this.bridge as unknown as SpecsRiderBridge
    if (
      typeof this.bridgeApi.subscribeJson !== "function" ||
      typeof this.bridgeApi.sendRequest !== "function"
    ) {
      print("[MobileNowPlaying] bridge ScriptComponent isn't a SpecsRiderBridge.")
      this.bridgeApi = null
      return
    }

    if (!isNull(this.pausePlayButton)) {
      this.pausePlayButton.onTriggerUp.add(() => this.onPausePlayPressed())
    } else {
      print("[MobileNowPlaying] pausePlayButton is not assigned. Pause/play taps will be ignored.")
    }
    if (!isNull(this.skipButton)) {
      this.skipButton.onTriggerUp.add(() => this.onSkipPressed())
    } else {
      print("[MobileNowPlaying] skipButton is not assigned. Skip taps will be ignored.")
    }
    if (this.prevButton !== undefined && !isNull(this.prevButton as unknown as ScriptComponent)) {
      ;(this.prevButton as RectangleButton).onTriggerUp.add(() => this.onPrevPressed())
    }

    this.subscription = this.bridgeApi.subscribeJson<NowPlayingPayload>(
      BridgeTopic.nowPlaying,
      (payload) => this.onNowPlaying(payload),
      // Subscription errors are NOT gated behind verbose: a dropped
      // subscription is the kind of failure mode that masquerades as
      // "the iOS app stopped sending updates" — exactly the symptom we
      // had to diagnose by hand. Always surface it.
      (err) => print("[MobileNowPlaying] subscription error: " + String(err)),
    )
  }

  private onDestroy(): void {
    if (this.subscription !== null) {
      this.subscription.stop()
      this.subscription = null
    }
  }

  // ---------------------------------------------------------------------
  //  Subscription handler
  // ---------------------------------------------------------------------

  private onNowPlaying(payload: NowPlayingPayload): void {
    if (payload === null || payload === undefined) {
      print("[MobileNowPlaying] received null/undefined payload")
      return
    }
    const title = typeof payload.title === "string" ? payload.title : ""
    const artist = typeof payload.artist === "string" ? payload.artist : ""
    const album = typeof payload.album === "string" ? payload.album : ""
    this.setText(this.titleText, title)
    this.setText(this.artistText, artist)
    this.setText(this.albumText, album)

    const wasPlaying = this.isPlaying
    this.isPlaying = payload.isPlaying === true
    if (this.isPlaying !== wasPlaying) {
      this.applyIconState()
    }

    const incomingVersion =
      typeof payload.artworkVersion === "string" ? payload.artworkVersion : ""
    const artChanged =
      incomingVersion.length > 0 && incomingVersion !== this.currentArtworkVersion
    if (artChanged) {
      this.loadAlbumArt(incomingVersion)
    }

    // Always heartbeat each delivery so it's obvious from device logs whether
    // updates have stopped flowing in. Cheap and the only line we see when
    // the user reports "title/artist no longer updating".
    print(
      "[MobileNowPlaying] " +
        (this.isPlaying ? "▶ " : "⏸ ") +
        title +
        (artist.length > 0 ? " — " + artist : "") +
        " (v=" +
        incomingVersion.substr(0, 16) +
        (artChanged ? " *new*" : "") +
        ")",
    )
  }

  /**
   * Re-fetches `spectacleskit://albumArt.jpg` and writes the resulting
   * Texture into `albumArtImage.mainPass.baseTex`. The iOS bridge serves
   * the same URI for every track but bumps the asset version (returned
   * via the iOS asset request `version` field) whenever the underlying
   * JPEG bytes change, which is what gives RemoteMediaModule a reliable
   * cache key. This script in turn matches that cadence by guarding on
   * `artworkVersion` from the JSON payload before each refetch.
   */
  private loadAlbumArt(version: string): void {
    if (this.albumArtImage === undefined || isNull(this.albumArtImage)) {
      this.currentArtworkVersion = version
      return
    }
    if (isNull(this.internetModule) || isNull(this.remoteMediaModule)) {
      print("[MobileNowPlaying] cannot fetch album art: internetModule/remoteMediaModule missing")
      return
    }
    const requestedId = ++this.inFlightArtId
    const resource = this.internetModule.makeResourceFromUrl(BridgeTopic.albumArtURI)
    print("[MobileNowPlaying] requesting album art (v=" + version.substr(0, 16) + ")")
    this.remoteMediaModule.loadResourceAsImageTexture(
      resource,
      (texture: Texture) => {
        if (requestedId !== this.inFlightArtId) {
          return
        }
        if (this.albumArtImage === undefined || isNull(this.albumArtImage)) {
          return
        }
        // Clone the material before writing `baseTex` so we don't mutate the
        // shared Image material asset (which would either silently no-op or
        // re-skin every other Image in the scene that points at the same
        // material). Mirrors the pattern SpectaclesUIKit's `FrameButton` uses.
        // Cloning is idempotent enough for our use-case: we only do it once,
        // then keep updating `baseTex` on the cloned instance for every
        // subsequent track.
        if (!this.albumArtMaterialCloned) {
          this.albumArtImage.mainMaterial = this.albumArtImage.mainMaterial.clone()
          this.albumArtMaterialCloned = true
        }
        this.albumArtImage.mainPass.baseTex = texture
        this.currentArtworkVersion = version
        print("[MobileNowPlaying] album art applied (v=" + version.substr(0, 16) + ")")
      },
      (err: string) => {
        if (requestedId !== this.inFlightArtId) {
          return
        }
        print("[MobileNowPlaying] album art load failed (v=" + version.substr(0, 16) + "): " + err)
      },
    )
  }

  // ---------------------------------------------------------------------
  //  Button handlers
  // ---------------------------------------------------------------------

  private onPausePlayPressed(): void {
    // Optimistic local flip so the icon swaps the moment the user taps.
    // The next `nowPlaying` payload reconciles authoritative state.
    this.isPlaying = !this.isPlaying
    this.applyIconState()
    this.send(BridgeTopic.mediaToggle)
  }

  private onSkipPressed(): void {
    this.send(BridgeTopic.mediaNext)
  }

  private onPrevPressed(): void {
    this.send(BridgeTopic.mediaPrevious)
  }

  private send(method: string): void {
    if (this.bridgeApi === null) {
      return
    }
    this.bridgeApi.sendRequest(method).catch((err: any) => {
      if (this.verbose) {
        print("[MobileNowPlaying] " + method + " failed: " + String(err))
      }
    })
  }

  // ---------------------------------------------------------------------
  //  UI helpers
  // ---------------------------------------------------------------------

  private applyIconState(): void {
    if (this.playIcon !== undefined && !isNull(this.playIcon)) {
      this.playIcon.enabled = !this.isPlaying
    }
    if (this.pauseIcon !== undefined && !isNull(this.pauseIcon)) {
      this.pauseIcon.enabled = this.isPlaying
    }
  }

  private setText(target: Text | undefined, value: string): void {
    if (target === undefined || isNull(target)) {
      return
    }
    target.text = value
  }
}

type NowPlayingPayload = {
  title?: string
  artist?: string
  album?: string
  isPlaying?: boolean
  artworkVersion?: string
  durationMs?: number
  elapsedMs?: number
}
