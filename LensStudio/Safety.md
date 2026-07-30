# SpecsRider Safety Implementation Brief

## Objective

Build an AR navigation system for electric-scooter riders that provides useful route guidance without obscuring hazards, encouraging unsafe attention, or presenting falsely precise directions.

The system must always prioritize the rider’s view of the physical environment over navigation graphics.

## Core safety principle

When the system is uncertain, visually overloaded, malfunctioning, or unable to verify route alignment, it must remove precise world-locked guidance and transition to a safer fallback.

The system must never guess where to place a route line.

---

# 1. Localization confidence system

Create a continuously updated localization-confidence score using all available signals:

* Headset visual-inertial tracking quality.
* GNSS accuracy.
* Compass and heading reliability.
* Phone IMU data.
* Scooter speed and direction, if available.
* Map-matching confidence.
* Age of the last successful localization.
* Agreement between independent pose sources.
* Visual landmark or VPS confidence.
* Tracking resets, jumps, or relocalization events.

Represent confidence using explicit states:

* `HIGH`
* `MEDIUM`
* `LOW`
* `LOST`

Do not derive presentation behavior directly from one sensor. Use a fused confidence state.

### Required behavior

* `HIGH`: World-registered route guidance may be displayed.
* `MEDIUM`: Widen, simplify, shorten, or reduce the precision of the route cue.
* `LOW`: Remove surface-registered guidance and use a general directional arrow or spatial-audio cue.
* `LOST`: Remove all world-locked navigation content. Ask the rider to stop safely for relocalization.

Use hysteresis and minimum dwell times so the interface does not rapidly flicker between states.

---

# 2. Registration-integrity monitoring

Continuously verify that the displayed route remains consistent with the physical world.

Compare:

* Local headset motion.
* GNSS displacement.
* Reported heading.
* Route geometry.
* Scooter motion.
* Expected optical flow.
* Detected road or path boundaries.
* Previous stable coordinate transforms.

Detect:

* Sudden pose jumps.
* Anchor movement.
* Heading disagreement.
* Route displacement from the expected traversable area.
* Tracking resets.
* Gradual drift.
* Impossible movement.
* Stale localization data.

If route alignment cannot be verified, immediately downgrade localization confidence.

Never continue displaying a precise path after a tracking reset without revalidating the local-to-world transform.

---

# 3. Conservative degraded modes

Implement explicit degraded modes instead of treating navigation as either fully working or unavailable.

Required presentation modes:

1. `WORLD_PATH`

   * Surface-registered route segments.
   * Allowed only at high confidence.

2. `ROUTE_CORRIDOR`

   * Broader and less precise directional corridor.
   * Used at medium confidence.

3. `DIRECTION_ONLY`

   * Head- or screen-relative arrow.
   * No claim about exact surface position.

4. `AUDIO_ONLY`

   * Brief directional or maneuver instructions.
   * Used when visual guidance would be unsafe or unreliable.

5. `STOP_AND_RELOCALIZE`

   * Remove navigation graphics.
   * Tell the rider to stop in a safe location before continuing.

Every degraded-state transition must be logged.

---

# 4. Minimal visual guidance

Do not render a large opaque ribbon across the road.

Use:

* Short route segments.
* Separated chevrons.
* Sparse ground markers.
* Limited visible distance.
* Minimal animation.
* No decorative particles.
* No unnecessary labels.
* No persistent destination panels while moving.

The route should communicate the next meaningful decision, not visualize the entire journey.

Visual styling must adapt to:

* Background luminance.
* Pavement color.
* Daylight.
* Darkness.
* Shadows.
* Glare.
* Weather.
* Display limitations.

Use outlines or halos when necessary, but do not solve poor visibility simply by making graphics increasingly large or bright.

---

# 5. Physical-world visibility and occlusion safety

The physical environment must always have visual priority.

Navigation graphics must not obscure:

* Pedestrians.
* Vehicles.
* Cyclists.
* Curbs.
* Potholes.
* Debris.
* Road markings.
* Traffic lights.
* Signs.
* Construction barriers.
* Animal hazards.
* Vehicle wheels or pedestrian feet.
* The immediate braking path.

Use depth and semantic information where available.

Prefer world-space safety logic over simple pixel-based removal.

When a relevant object overlaps the navigation cue:

* Shorten the route cue.
* Fade or suppress the affected section.
* Reduce overall route salience.
* Prioritize the physical object or hazard.

Do not create the appearance that the rider should travel through an obstacle.

---

# 6. Hazard-priority system

Navigation must never compete with a safety warning.

Define a priority hierarchy:

1. Immediate collision or braking hazard.
2. Tracking or localization failure.
3. Traffic-control information.
4. Route maneuver.
5. General route continuation.
6. Optional information.

When a hazard is active:

* Suppress or substantially dim navigation graphics.
* Present a distinct hazard warning.
* Avoid simultaneous spoken navigation instructions.
* Restore route guidance only after the hazard state has cleared.

Do not present hazards and turns using similar sounds, colors, shapes, or timing patterns.

---

# 7. Attention-management system

Prevent the interface from encouraging prolonged fixation.

Use available signals such as:

* Head orientation.
* Gaze direction, if available and consented to.
* Time spent looking at navigation content.
* Speed.
* Intersection proximity.
* Number of surrounding objects.
* Environmental complexity.
* Recent hazard activity.
* Route ambiguity.

Reduce visual guidance when:

* The rider appears visually fixated on the augmentation.
* The rider is approaching a complex intersection.
* Cross-traffic checking is expected.
* Environmental complexity increases.
* The rider is moving quickly.
* A hazard is present.
* Tracking confidence falls.

Increase salience only briefly near a necessary decision point.

The system should become quieter during high-demand riding situations, not more visually aggressive.

---

# 8. Speed-adaptive behavior

Adjust guidance according to rider speed.

At higher speeds:

* Display less information.
* Increase preview distance only when route confidence is high.
* Avoid text.
* Avoid dense graphics.
* Announce turns earlier.
* Require stronger confidence for world-registered guidance.
* Enter degraded mode more aggressively.

When stopped:

* Permit route overview.
* Permit text.
* Permit destination changes.
* Permit settings.
* Permit rerouting choices.
* Permit detailed error messages.

Complex interaction must be disabled while moving.

---

# 9. Intersection safety

Treat intersections as high-risk states.

Before an intersection:

* Provide an early, brief maneuver cue.
* Reduce general route clutter.
* Highlight only the intended exit or turn.
* Avoid drawing lines through several possible paths.
* Encourage normal traffic scanning.
* Avoid blocking signs, signals, curb geometry, or crosswalks.

At ambiguous intersections:

* Prefer a staged maneuver presentation.
* Use approach, decision point, and exit guidance.
* Use spatial audio as a secondary cue.
* Request the rider to stop when the route cannot be confidently resolved.

Do not display lane-level or curb-level precision unless the system has validated that accuracy.

---

# 10. Field-of-view management

The route may leave the display when the rider checks traffic.

When guidance is outside the display:

* Use a subtle edge indicator.
* Use spatial audio when appropriate.
* Do not encourage unnecessary head searching.
* Do not place a permanently bright arrow in the center of the display.

The system must continue functioning when the rider looks left, right, or behind.

Navigation should not punish correct safety behavior such as checking cross traffic.

---

# 11. Multimodal guidance

Use modalities for different purposes:

* Visual cues: Route geometry.
* Spatial audio: Upcoming direction and off-screen guidance.
* Speech: Rare, complex, or unusual instructions.
* Haptics: Optional supplemental confirmation only.

Do not rely solely on handlebar vibration because road vibration may mask it.

Requirements:

* Navigation and hazard signals must be clearly distinguishable.
* Audio instructions must be brief.
* Do not overload multiple modalities simultaneously.
* Respect user accessibility settings.
* Provide visual alternatives for hearing-impaired users.
* Provide audio alternatives when visual contrast is inadequate.

---

# 12. Route safety and traversability

Do not assume that a map provider’s route is suitable for scooters.

Validate routes against available information about:

* Bike lanes.
* Shared-use paths.
* Scooter restrictions.
* Sidewalk restrictions.
* One-way streets.
* Stairs.
* Curbs.
* Steep grades.
* Construction.
* Road closures.
* Surface quality.
* High-stress intersections.
* Dismount zones.
* Parking zones.

Represent route confidence separately from localization confidence.

A route can be geographically accurate but operationally unsafe.

When route legality or traversability is uncertain:

* Do not display a precise line.
* Use a caution state.
* Request rider confirmation while stopped.
* Offer a safer alternative when available.

---

# 13. Failure handling

Implement explicit handling for:

* GNSS loss.
* VPS loss.
* Camera obstruction.
* Tracking reset.
* Compass interference.
* Network loss.
* Map-service failure.
* Phone disconnection.
* Headset thermal throttling.
* Low battery.
* Audio failure.
* Sensor disagreement.
* Application crash.
* Stale route data.
* Unexpected route jumps.

Each failure state must define:

* What guidance remains available.
* What content must disappear.
* Whether the rider must stop.
* How recovery is verified.
* What event data is logged.

Never silently continue after a critical failure.

---

# 14. Battery and thermal safety

Monitor:

* Headset battery.
* Phone battery.
* Device temperature.
* Thermal throttling.
* Sensor availability.
* Estimated remaining navigation time.

Provide warnings early enough for the rider to stop safely or switch to another navigation method.

Do not allow abrupt shutdown to be the first indication of low power.

If performance degradation affects tracking reliability, downgrade the guidance state.

---

# 15. Safe user interaction

While the rider is moving, disable:

* Keyboard entry.
* Long menus.
* Detailed settings.
* Route comparison.
* Account management.
* Long text.
* Manual anchor adjustment.
* Complex troubleshooting.

Allow only minimal interactions such as:

* Repeat instruction.
* Mute or unmute.
* Cancel navigation.
* Request safe stopping guidance.
* Report a route problem through a simple action.

Destination entry and route selection should occur while stopped.

---

# 16. User trust and uncertainty communication

The interface must not appear more accurate than the underlying system.

Do not display a narrow path when estimated error is broad.

Communicate uncertainty through:

* Route width.
* Route length.
* Opacity.
* Segmentation.
* Transition to direction-only guidance.
* Audio fallback.
* Explicit stop-and-relocalize behavior.

Avoid requiring the rider to interpret numerical accuracy values while moving.

Trust must be calibrated. The user should be able to recognize when the system is degraded.

---

# 17. Privacy and security

Collect only data necessary for navigation, safety validation, and product improvement.

Requirements:

* Minimize raw video retention.
* Prefer on-device processing for scene data where practical.
* Encrypt location and telemetry data.
* Authenticate communication between phone, headset, and backend.
* Prevent unauthorized route modification.
* Define retention periods.
* Allow users to delete personal trip data.
* Separate research consent from ordinary product consent.
* Avoid storing bystander-identifying data.
* Log access to sensitive datasets.

Security failures that could alter navigation must be treated as safety failures.

---

# 18. Telemetry and incident logging

Record enough information to reconstruct failures without unnecessarily recording the user’s surroundings.

Log:

* Timestamp.
* Route segment.
* Device pose.
* Pose-confidence state.
* Route-confidence state.
* Localization source.
* Tracking-state transitions.
* Guidance mode.
* Speed.
* Head orientation.
* Hazard-state transitions.
* Network state.
* Battery and temperature.
* Map version.
* Application version.
* Sensor disagreements.
* User overrides.
* Near misses and reported incidents.

Create a replay system that can reconstruct:

* What the system believed.
* What guidance it displayed.
* Why it selected that guidance mode.
* When confidence changed.
* Whether the correct safety transition occurred.

---

# 19. Testing requirements

Do not validate the system only by checking whether users reach destinations.

Test:

* Hazard-detection rate.
* Reaction time.
* Braking behavior.
* Lateral deviation.
* Steering stability.
* Navigation errors.
* Intersection hesitation.
* Head-movement distribution.
* Physical-object recall.
* Mental workload.
* Discomfort.
* Trust calibration.
* Tracking failures.
* Recovery behavior.
* False high-confidence states.

Compare at minimum:

1. Phone navigation.
2. Audio-only navigation.
3. Persistent AR route line.
4. Adaptive SpecsRider guidance.

The adaptive AR condition should improve navigation without meaningfully reducing hazard detection or vehicle control.

---

# 20. Error-injection testing

Create automated and simulated tests that inject:

* Position offsets.
* Heading offsets.
* Gradual drift.
* Sudden anchor jumps.
* GNSS loss.
* Tracking loss.
* Delayed sensor data.
* Incorrect route geometry.
* Network latency.
* False obstacle detections.
* Missed obstacle detections.
* Low battery.
* Thermal throttling.
* Conflicting sensor readings.

For every injected error, verify that the correct degraded mode is activated within the defined safety interval.

---

# 21. Safety state machine

Implement a centralized safety state machine rather than distributing safety behavior across unrelated scripts.

Suggested states:

* `STOPPED_SAFE`
* `MOVING_NORMAL`
* `MOVING_HIGH_COMPLEXITY`
* `MANEUVER_APPROACH`
* `HAZARD_ACTIVE`
* `LOCALIZATION_DEGRADED`
* `LOCALIZATION_LOST`
* `ROUTE_UNCERTAIN`
* `SYSTEM_FAILURE`
* `LOW_POWER`
* `RELOCALIZATION_REQUIRED`

The safety state machine should determine:

* Which navigation mode is allowed.
* Which inputs are enabled.
* Which warnings have priority.
* Whether visual guidance must be suppressed.
* Whether the rider must stop.

All state transitions must be deterministic, testable, and logged.

---

# 22. Required fail-safe defaults

When a condition is unknown, use the safer interpretation.

Examples:

* Unknown tracking quality → treat as degraded.
* Unknown route legality → do not show precise guidance.
* Stale sensor data → do not reuse indefinitely.
* Conflicting pose sources → reduce confidence.
* Unavailable depth data → avoid assuming safe occlusion.
* Uncertain hazard classification → reduce navigation salience.
* Unhandled exception → remove world-locked guidance.
* Recovery without verification → remain degraded.

The system must fail visibly and conservatively.

---

# 23. Initial implementation priorities

## Priority 0: Required before riding tests

* Central safety state machine.
* Localization-confidence states.
* Registration-integrity checks.
* World-path, direction-only, audio-only, and stop modes.
* Tracking-loss handling.
* Minimal route rendering.
* Moving-versus-stopped interaction restrictions.
* Telemetry logging.
* Emergency navigation suppression.
* Battery and thermal warnings.

## Priority 1: Required before controlled human-subject testing

* Hazard-priority behavior.
* Intersection state.
* Route-confidence system.
* FOV and off-screen guidance.
* Multimodal cue vocabulary.
* Automated error injection.
* Trip replay.
* Incident-reporting workflow.
* Privacy and consent controls.

## Priority 2: Required before institutional pilots

* Scene-complexity adaptation.
* Hazard-aware route suppression.
* Scooter-specific routing.
* Accessibility settings.
* Security review.
* Cross-device and environmental testing.
* Formal release-validation process.
* Safety-review approval workflow.

---

# 24. Acceptance criteria

The system is not ready for a controlled riding study unless:

* Precise world-locked guidance disappears after localization loss.
* Tracking resets cannot silently preserve stale route alignment.
* Route graphics never remain dominant during an active hazard.
* The rider can complete navigation without interacting with menus while moving.
* Every degraded-mode transition is logged.
* Injected pose errors cause the intended safety response.
* Low battery and thermal issues are communicated before loss of functionality.
* Route and localization confidence are represented separately.
* The application can recover only after pose validity is re-established.
* A single command can immediately suppress all navigation graphics.
* The system never presents unverified lane- or curb-level precision.
* A replay can explain why each guidance mode was selected.

---

# Final development instruction

Do not optimize primarily for continuous visual guidance.

Optimize for:

1. Correct uncertainty estimation.
2. Conservative behavior under uncertainty.
3. Preservation of physical-world visibility.
4. Minimal rider attention demand.
5. Predictable and testable failure handling.
6. Complete observability of safety-relevant decisions.

When safety conflicts with navigation continuity, safety must win.

