# Release safety review — 2026-09-22

This review covers the app's insertion/export behavior, input interpretation, geometry, browser file handling, and installed JavaScript dependencies. It is a code review with automated and browser checks, not a physical print test or a guarantee of machine safety.

## Issues fixed

- The old review's unchanged-line banner could appear while further pages still contained added commands. The replacement uses continuous virtualized scrolling and explicitly labels folds as added or unchanged. Counts and line ranges refer to the fold immediately at that position. Review and download continue to use the same prepared output.
- Invalid numeric footer text could silently become a default filament, flow, or motion setting. Present but malformed values now block export. Valid percentage settings and `nil` filament overrides retain their documented behavior.
- A search-based parameter parser could accept duplicate parameters, partial numbers, parentheses, or a second command inside a motion line. Motion and relevant state commands now require complete, unambiguous numeric parameters; unsupported axes and arc options are rejected.
- Unknown numeric commands later in the first layer could escape geometry validation after an extrusion reset or in Klipper mode. The shared checks now reject them, including within custom features, while retaining recognized shutdown commands.
- Explicit startup coordinate/extruder transforms could outlive the position reset in the interpreter. They now block export. Known invalid, degenerate or self-intersecting bed polygons are also rejected instead of partially interpreted.
- Lift now starts from the exact saved nozzle Z rather than the nominal layer annotation. Generation and export check the lifted height against `max_print_height` when supplied by the footer.
- Updated Vitest to 4.1.11 to resolve [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9). This concerned a development-server mock interceptor, not the deployed static site. Development/preview servers now default to loopback, like the Docker port binding.

## Verification

- Regression tests preserve every original byte for UTF-8/BOM, LF/CRLF/CR, and an unterminated last line, and compare the reviewed rows with the exact download.
- An independent command replay checks position, extrusion, feed, mode and continuation behavior. Box-reference tests compare PrusaSlicer spacing, extrusion quantities, loop order, short steps, acceleration inheritance, and restoration.
- Geometry tests cover holes and narrow-entry pockets independently, small inaccessible regions, gap/width controls, clipping to the configured bed, existing material, separate regions and open contours.
- New rejection tests cover malformed motion/settings, unmodelled first-layer behavior after an E reset, both export modes, explicit transforms, and invalid bed shapes. Export itself enforces blockers; it does not rely solely on disabled UI buttons.
- Diff tests cover fold accounting, boundary reads, full-file mapping, continuous ranges, and line navigation on files large enough to exceed browser element-height limits. Only the scrollbar is compressed for extreme row counts; displayed lines keep their normal height.
- All 113 tests passed with the optional large private G-code fixture enabled (112 pass and one skips without it). The production Docker build passed. Browser checks covered compact/expanded folds, both diff layouts, continuous keyboard scrolling, hidden-line jumps, EOF navigation, download, and a 390 × 844 mobile viewport. The 18,612-line sample export rendered only 20 rows near EOF.
- The dependency audit returned zero known advisories after the test-runner update. This is a point-in-time result, not a permanent assertion. Repeat `npm run check`, `npm audit`, production build and browser checks for future releases.

## What remains outside these checks

- Printer firmware configuration, calibration, hardware condition, bed clips/fixtures, thermal protection, motor/extruder limits, and commands hidden inside startup macros are not available in the file. Firmware may also redefine a command or apply runtime offsets/overrides. An eligible file cannot establish those physical facts.
- The configured bed polygon constrains deposited brim material. Travels between disconnected regions use direct XY moves and the selected lift, not obstacle-aware routing. A zero lift disables brim hops; required source entry/handoff heights still apply. The app cannot prove clearance from clips, purge material hidden in macros, or nozzle hardware.
- The footprint is reconstructed from deposited G-code paths rather than original slice polygons. It is an approximation, including the documented box corner difference. Displayed bead shapes and time estimates do not simulate molten plastic or firmware acceleration.
- The app preserves original commands, including any unsafe commands already present. It does not repair or certify input files. Temperature, fan, flow/speed overrides, pressure advance and jerk are inherited and never emitted in the added block. The earlier insertion plans print/travel acceleration separately and restores changed fields before the source needs them.
- Browser memory and input complexity can still cause slowdowns or failures even within the 200 MB cap. A failed parse/generation does not permit export of that result. Neither the browser preview nor automated tests replace reviewing and testing on the intended printer.

Before a first print, keep the original, check the insertion and its return in the diff, inspect the downloaded file in an independent G-code viewer, verify the printer/profile and clearances, and supervise the test. If the tool reports an unsupported state, re-slice with supported settings instead of deleting the blocking commands to force acceptance.

Firmware references used to check supported semantics: [Marlin XY arcs](https://marlinfw.org/docs/gcode/G002-G003.html), [Klipper offsets and saved state](https://www.klipper3d.org/G-Codes.html#gcode_move). Support is deliberately narrower than those firmware command sets.

## Insertion planning update

The earlier entry recognizes a bounded linear approach after completed startup/auxiliary printing and wipes. It reads through model preparation before deciding what the added block must establish and restore. The clearance sample inserts before its first XY travel; the box inserts after its final wipe and before travel acceleration setup. Unsupported approaches retain the model-start fallback and report why. The original first-model eligibility checks remain in force.

Independent replay regressions cover both samples, reused/partial retraction, unknown incoming XY, combined XYZ approaches, zero and larger selected lifts, feed read before a later reset, separate Marlin acceleration fields, Klipper acceleration semantics, prohibited generated setting commands, and exact byte preservation at the earlier boundary. The box replay checks all remaining first-layer model movements, including their extrusion amounts, feeds and acceleration. The existing historical release verification above predates this update.

The [generated G-code allowlist](../README.md#generated-g-code-allowlist) specifies every permitted command and parameter in the added block. Tests enforce that positive list across insertion/continuation cases and reject redundant feed and acceleration assignments. Acceleration setup now happens only after a generated motion survives stationary-move omission; regressions cover a stationary step and a handoff requiring no generated motion, where unnecessary Klipper acceleration changes could previously appear.

A runtime command-name allowlist also checks the finalized generated block immediately before each output assembly path joins it to the source. Unknown commands block export with the generated line number. Tests inject a temperature command through a late-generated annotation to verify rejection by both the review/download path and the byte exporter, in both export modes. Original source commands remain outside this check and are preserved unchanged.
