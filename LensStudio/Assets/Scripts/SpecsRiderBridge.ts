/**
 * SpecsRiderBridge
 *
 * Single owner of the SpectaclesMobileKit session that the lens uses to
 * talk to the SpecsRider iOS companion app. All other lens scripts
 * (`MobileRouteController`, `MobileNowPlayingController`, ...) consume
 * this bridge instead of touching `LensStudio:SpectaclesMobileKitModule`
 * themselves so the lens always opens exactly one BLE session.
 *
 * iOS counterpart: `SpectaclesBridge.swift` in the SpecsRider Xcode
 * project. The Swift side defines the topic strings that this script
 * mirrors (see {@link BridgeTopic}), publishes `route` and `nowPlaying`
 * via subscriptions, accepts `media/play|pause|next|previous|toggle`
 * requests, and serves `spectacleskit://albumArt.jpg` as an asset
 * (artwork is JPEG-encoded on iOS to keep BLE transfers small).
 *
 * Project requirements:
 *   - **Extended Permissions / Spectacles Mobile Kit** experimental API
 *     enabled in Project Settings (lens-api.md notes that
 *     `SpectaclesMobileKitModule` plus the Internet permission requires
 *     Extended Permissions; lenses using them cannot be published).
 *   - The lens display name must be **SpecsRider** so the iOS app's
 *     `BondingRequest.singleLensByName(lensName: "SpecsRider")` finds
 *     this lens.
 *   - This script should live on a single, top-level "Bridge"
 *     SceneObject. Other scripts reference it via a
 *     `Component.ScriptComponent` inspector input.
 *
 * Lifecycle:
 *   1. `onAwake` creates a session via the global mobile-kit module.
 *   2. `onStart` wires `onConnected` / `onDisconnected` listeners,
 *      registers any pending feature subscriptions, then calls
 *      `session.start()`.
 *   3. On disconnect, the bridge schedules a single delayed restart
 *      after `reconnectDelayS`. Feature scripts don't have to opt in
 *      to reconnect; their queued subscriptions are re-attached
 *      automatically.
 *
 * Public API used by feature scripts:
 *   - `addOnConnected(cb)` / `addOnDisconnected(cb)` - lifecycle hooks.
 *     `addOnConnected` fires `cb` immediately if the session is already
 *     connected at subscribe time, so late callers don't miss the edge.
 *   - `subscribeJson<T>(topic, onJson, onError?)` - subscribes to a
 *     topic and parses each incoming string payload into JSON before
 *     handing it to `onJson`. Survives reconnects: when the session
 *     drops and re-connects, the subscription is re-armed transparently.
 *   - `sendRequest<T>(method, body?)` - thin Promise wrapper around
 *     `session.sendRequest(...)`. Rejects with an Error when the session
 *     isn't connected yet.
 *
 * Logging:
 *   - All `print(...)` lines are prefixed with `[SpecsRiderBridge]`.
 *   - Setting `debugText` to a Text component renders a one-line status
 *     summary (state + last error + reconnect generation) so the user
 *     can verify connectivity in-headset.
 */

/** Topic / request strings shared with the iOS app's `BridgeTopic` enum. */
export const BridgeTopic = {
  route: "route",
  nowPlaying: "nowPlaying",
  mediaPlay: "media/play",
  mediaPause: "media/pause",
  mediaNext: "media/next",
  mediaPrevious: "media/previous",
  mediaToggle: "media/toggle",
  /// Lens-facing URI for the now-playing album-art asset. Bytes are JPEG
  /// (see iOS `NowPlayingService.updateArtwork`); `RemoteMediaModule`
  /// decodes by content rather than by extension, so the `.jpg` here is
  /// purely cosmetic / honest.
  albumArtURI: "spectacleskit://albumArt.jpg",
} as const

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error"

/**
 * Handle returned by `subscribeJson`. The caller can `stop()` it to
 * tear down the underlying mobile-kit subscription. While the bridge is
 * disconnected the handle is dormant; it re-arms automatically when the
 * session re-connects.
 */
export interface JsonSubscriptionHandle {
  readonly topic: string
  stop(): void
}

interface PendingSubscription<T> {
  topic: string
  onJson: (payload: T) => void
  onError: ((err: any) => void) | null
  active: boolean
  underlying: any | null
}

/**
 * Loose structural type for the mobile-kit Session. The real interface is
 * defined inside the closed-source `LensStudio:SpectaclesMobileKitModule`;
 * we describe only the methods we call so this script type-checks without
 * an explicit module import.
 */
interface MobileKitSessionLike {
  onConnected: {add(cb: () => void): void}
  onDisconnected: {add(cb: () => void): void}
  start(): void
  close?(): void
  sendData?(data: string): void
  sendRequest(method: string, body?: string): Promise<string>
  startSubscription(topic: string, onError: (err: any) => void): {
    add(cb: (payload: string) => void): void
  }
  stopSubscription?(subscription: any): void
}

interface MobileKitModuleLike {
  createSession(): MobileKitSessionLike
}

@component
export class SpecsRiderBridge extends BaseScriptComponent {
  @ui.separator
  @ui.label("Reconnection")
  @input
  @hint("If true, the bridge automatically reopens the session after a disconnect.")
  public autoReconnect: boolean = true

  @input
  @widget(new SliderWidget(0.5, 30, 0.5))
  @hint("Delay (seconds) before retrying the session after a disconnect.")
  public reconnectDelayS: number = 2

  @ui.separator
  @ui.label("Debug")
  @input
  @hint("If true, prints lifecycle / subscription messages to the log.")
  public verbose: boolean = false

  @input
  @allowUndefined
  @hint("Optional Text component that displays a one-line bridge status (state + last error).")
  public debugText: Text | undefined

  // The static `require()` is the same idiom used by the SDK sample
  // (`SpectaclesMobileKitTest_TS.ts`). Wrapped in a try because the call
  // throws synchronously when the experimental API isn't enabled in the
  // project; we want to surface a clean error instead of crashing the
  // whole lens.
  private mobileKitModule: MobileKitModuleLike | null = null
  private session: MobileKitSessionLike | null = null
  private state: ConnectionState = "idle"
  private lastError: string = ""

  private onConnectedListeners: Array<() => void> = []
  private onDisconnectedListeners: Array<() => void> = []
  private pendingSubscriptions: Array<PendingSubscription<any>> = []

  // Bumped on every disconnect so a stale `DelayedCallbackEvent` from a
  // previous incarnation can detect it shouldn't actually reconnect.
  private reconnectGen: number = 0

  public onAwake(): void {
    try {
      const mod = require("LensStudio:SpectaclesMobileKitModule") as MobileKitModuleLike
      this.mobileKitModule = mod
    } catch (e) {
      this.fail("require('LensStudio:SpectaclesMobileKitModule') failed: " + (e as Error).message)
      return
    }

    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private onStart(): void {
    this.openSession()
    this.writeDebug()
  }

  private onDestroy(): void {
    if (this.session !== null && typeof this.session.close === "function") {
      try {
        this.session.close()
      } catch (_e) {
        // Ignore - we're tearing down anyway.
      }
    }
    this.session = null
    this.state = "idle"
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** True once the underlying mobile-kit session has connected at least once. */
  public isConnected(): boolean {
    return this.state === "connected"
  }

  /**
   * Registers a callback fired whenever the session connects (including
   * after a reconnect). If the session is already connected at the time
   * of the call, `cb` is invoked synchronously once.
   */
  public addOnConnected(cb: () => void): void {
    this.onConnectedListeners.push(cb)
    if (this.state === "connected") {
      this.safeCall(cb)
    }
  }

  /** Registers a callback fired whenever the session disconnects. */
  public addOnDisconnected(cb: () => void): void {
    this.onDisconnectedListeners.push(cb)
  }

  /**
   * Subscribes to a string topic and parses each payload as JSON. The
   * subscription is queued internally so it survives session restarts.
   * Returns a handle whose `stop()` removes the subscription on the
   * next reconnect cycle (the underlying mobile-kit API has no per-call
   * `stopSubscription` we can rely on, but we mark the slot inactive so
   * inbound payloads are dropped).
   */
  public subscribeJson<T>(
    topic: string,
    onJson: (payload: T) => void,
    onError?: (err: any) => void,
  ): JsonSubscriptionHandle {
    const slot: PendingSubscription<T> = {
      topic: topic,
      onJson: onJson,
      onError: onError === undefined ? null : onError,
      active: true,
      underlying: null,
    }
    this.pendingSubscriptions.push(slot)
    if (this.state === "connected" && this.session !== null) {
      this.armSubscription(slot)
    }
    // Repaint so the `subs:` counter reflects the new slot even when the
    // bridge state itself didn't change (e.g. still "connecting").
    this.writeDebug()
    const self = this
    return {
      topic: topic,
      stop(): void {
        slot.active = false
        if (slot.underlying !== null && self.session !== null) {
          const stopFn = (self.session as any).stopSubscription
          if (typeof stopFn === "function") {
            try {
              stopFn.call(self.session, slot.underlying)
            } catch (_e) {
              // Ignore - inactive slots already drop payloads.
            }
          }
        }
        slot.underlying = null
        self.writeDebug()
      },
    }
  }

  /**
   * Sends a request and resolves with the raw string response. Mirrors
   * `session.sendRequest` from `lens-api.md`; rejects with an Error if
   * the bridge isn't connected when the call is made.
   */
  public async sendRequest(method: string, body?: string): Promise<string> {
    if (this.session === null || this.state !== "connected") {
      throw new Error("SpecsRiderBridge not connected")
    }
    if (this.verbose) {
      print("[SpecsRiderBridge] -> " + method + (body !== undefined ? " (" + body.length + "b)" : ""))
    }
    if (body === undefined) {
      return await this.session.sendRequest(method)
    }
    return await this.session.sendRequest(method, body)
  }

  // -----------------------------------------------------------------------
  // Session plumbing
  // -----------------------------------------------------------------------

  private openSession(): void {
    if (this.mobileKitModule === null) {
      return
    }
    let session: MobileKitSessionLike
    try {
      session = this.mobileKitModule.createSession()
    } catch (e) {
      this.fail("createSession failed: " + (e as Error).message)
      this.scheduleReconnect()
      return
    }
    this.session = session
    this.state = "connecting"
    this.lastError = ""
    if (this.verbose) {
      print("[SpecsRiderBridge] connecting...")
    }

    const myGen = this.reconnectGen
    session.onConnected.add(() => {
      if (myGen !== this.reconnectGen || this.session !== session) {
        return
      }
      this.handleConnected()
    })
    session.onDisconnected.add(() => {
      if (myGen !== this.reconnectGen || this.session !== session) {
        return
      }
      this.handleDisconnected()
    })

    try {
      session.start()
    } catch (e) {
      this.fail("session.start() threw: " + (e as Error).message)
      this.scheduleReconnect()
    }
    this.writeDebug()
  }

  private handleConnected(): void {
    this.state = "connected"
    this.lastError = ""
    if (this.verbose) {
      print("[SpecsRiderBridge] connected")
    }

    for (const slot of this.pendingSubscriptions) {
      if (slot.active) {
        this.armSubscription(slot)
      }
    }

    for (const cb of this.onConnectedListeners) {
      this.safeCall(cb)
    }
    this.writeDebug()
  }

  private handleDisconnected(): void {
    const wasConnected = this.state === "connected"
    this.state = "disconnected"
    if (this.verbose) {
      print("[SpecsRiderBridge] disconnected")
    }

    for (const slot of this.pendingSubscriptions) {
      slot.underlying = null
    }

    if (wasConnected) {
      for (const cb of this.onDisconnectedListeners) {
        this.safeCall(cb)
      }
    }

    this.session = null
    this.scheduleReconnect()
    this.writeDebug()
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect) {
      return
    }
    const myGen = ++this.reconnectGen
    const delay = Math.max(0.1, this.reconnectDelayS)
    const ev = this.createEvent("DelayedCallbackEvent")
    ev.bind(() => {
      if (myGen !== this.reconnectGen) {
        return
      }
      this.openSession()
    })
    ev.reset(delay)
  }

  private armSubscription<T>(slot: PendingSubscription<T>): void {
    if (this.session === null) {
      return
    }
    let underlying: any
    try {
      underlying = this.session.startSubscription(slot.topic, (err: any) => {
        if (!slot.active) {
          return
        }
        if (slot.onError !== null) {
          slot.onError(err)
        } else {
          print("[SpecsRiderBridge] subscription error on '" + slot.topic + "': " + String(err))
        }
      })
    } catch (e) {
      this.fail("startSubscription('" + slot.topic + "') threw: " + (e as Error).message)
      return
    }
    slot.underlying = underlying
    underlying.add((payload: string) => {
      if (!slot.active) {
        return
      }
      let parsed: T
      try {
        parsed = JSON.parse(payload) as T
      } catch (e) {
        print(
          "[SpecsRiderBridge] non-JSON payload on '" +
            slot.topic +
            "': " +
            (e as Error).message,
        )
        return
      }
      try {
        slot.onJson(parsed)
      } catch (e) {
        print(
          "[SpecsRiderBridge] handler for '" +
            slot.topic +
            "' threw: " +
            (e as Error).message,
        )
      }
    })
    if (this.verbose) {
      print("[SpecsRiderBridge] subscribed: " + slot.topic)
    }
  }

  private safeCall(cb: () => void): void {
    try {
      cb()
    } catch (e) {
      print("[SpecsRiderBridge] listener threw: " + (e as Error).message)
    }
  }

  private fail(msg: string): void {
    this.lastError = msg
    this.state = "error"
    print("[SpecsRiderBridge] " + msg)
    this.writeDebug()
  }

  private writeDebug(): void {
    if (this.debugText === undefined || isNull(this.debugText)) {
      return
    }
    const subs = this.pendingSubscriptions.filter((s) => s.active).length
    const parts: string[] = ["bridge: " + this.state, "subs: " + subs]
    if (this.lastError.length > 0) {
      parts.push("err: " + this.lastError.substr(0, 80))
    }
    this.debugText.text = parts.join(" | ")
  }
}
