# Recognized input commands

The input catalog in [`src/core/input-commands.ts`](../src/core/input-commands.ts) identifies commands whose effects the interpreter can account for, or whose settings the brim inherits. It is separate from the [generated G-code allowlist](../README.md#generated-g-code-allowlist). Recognizing an input command never authorizes generating it.

The catalog contains 130 exact command names: the existing 47 numeric compatibility entries, 51 Marlin/Prusa entries, and 32 Klipper built-ins. This adds 75 names to the original catalog. Motion, homing, coordinate resets, unsupported transforms and opaque startup routines also have dedicated handling outside this catalog.

## How recognition affects export

- Inherited commands retain their original position and bytes. Their settings remain active; the brim does not replay or restore them.
- Known settings do not erase established position, extrusion/retraction state, feed or acceleration. `M204` and Klipper `SET_VELOCITY_LIMIT ACCEL=...` update tracked acceleration through dedicated interpreter logic.
- Settings remain boundaries for insertion planning. The planner does not move the brim ahead of a setting between the approach and model extrusion merely because the command is recognized.
- Matching uses complete command names, case-insensitively. `M300` does not admit `M3000` or `M300.1`; `SET_LED` does not admit `SET_LED_CUSTOM` or `SET_LED.CUSTOM`. Compact numeric syntax such as `M150B255` is recognized.
- Firmware-specific additions use the slicer's `gcode_flavor`. Printer names, model IDs and startup template names are not used. The existing numeric compatibility set remains accepted for the supported flavors; its dedicated mode and parameter checks still apply.
- The catalog describes documented firmware behavior. It cannot inspect a printer's custom replacement for a built-in command. Arbitrary macros do not become recognized just because their names resemble known commands.

## Numeric compatibility set

These entries were already recognized. Several change state, so catalog membership does not bypass their checks: for example, `M200` still requires non-volumetric extrusion, `M82` cannot establish a relative-extrusion handoff, and `M204` parameters are validated and interpreted by firmware flavor.

| Purpose | Exact commands |
| --- | --- |
| Dwell, plane, units, arc mode | `G4`, `G17`, `G21`, `G91.1` |
| Progress, firmware info, messages | `M73`, `M115`, `M117`, `M118` |
| Extrusion modes and selected tool | `M82`, `M83`, `M200`, `T0` |
| Temperature and fans | `M104`, `M105`, `M106`, `M107`, `M109`, `M140`, `M141`, `M190`, `M191` |
| Motion limits, acceleration, retraction parameters, overrides | `M201`, `M203`, `M204`, `M205`, `M207`, `M208`, `M220`, `M221` |
| Synchronization, leveling, objects, print area | `M400`, `M420`, `M486`, `M555` |
| Driver mode, pressure advance, input shaping | `M569`, `M572`, `M593`, `M900` |
| Existing Prusa compatibility entries | `M862`, `M862.1`, `M862.2`, `M862.3`, `M862.4`, `M862.5`, `M862.6`, `M862.7`, `M862.8`, `M862.9` |

## Inherited Marlin/Prusa settings and reports

These entries apply to `marlin` and `marlin2`. They do not issue XYZE movement or change the coordinate interpretation, modal motion feed or tracked print/travel/retract acceleration. Numeric parameters such as `E` in a PID/current command or `F` in a material preset are not extrusion or movement commands.

| Purpose | Exact commands |
| --- | --- |
| Printer check, print status/timers, keepalive, sensor/configuration reports | `M16`, `M27`, `M31`, `M75`, `M76`, `M77`, `M78`, `M113`, `M119`, `M123`, `M155`, `M503`, `M504` |
| Display, LEDs, sound, case lighting | `M150`, `M151`, `M250`, `M255`, `M256`, `M300`, `M355`, `M414`, `M7219` |
| Thermal timeout, cooling, presets, temperature units, PID, thermistor, controller fan | `M86`, `M87`, `M142`, `M145`, `M149`, `M192`, `M301`, `M302`, `M304`, `M305`, `M309`, `M710` |
| Motor enabling, current, current reports, driver thresholds/timing | `M17`, `M906`, `M907`, `M908`, `M909`, `M911`, `M912`, `M913`, `M914`, `M919`, `M920` |
| Filament material/monitoring, homing speed, software endstops | `M403`, `M407`, `M412`, `M591`, `M210`, `M211` |

`M149` selects **temperature** units; it does not establish millimetres for motion. `G21` remains required, and any `G20` still blocks export. `M210` changes homing feed, not the active `G1 F` feed. `M403` configures an MMU material type; its `E` and `F` parameters do not extrude or set motion feed. See [Marlin M403](https://marlinfw.org/docs/gcode/M403.html).

The additions follow the [Marlin command reference](https://marlinfw.org/meta/gcode/), [Prusa Buddy command reference](https://help.prusa3d.com/article/buddy-firmware-specific-g-code-commands_633112), and [legacy Prusa i3 command reference](https://help.prusa3d.com/article/prusa-firmware-specific-g-code-commands_112173). These firmware families sometimes assign different meanings to the same number. The slicer's `marlin`/`marlin2` flavor alone cannot distinguish all of them. In particular, `M603` and `M910` are excluded because the legacy Prusa meanings include stopping a print and reinitializing drivers, respectively; the original catalog expansion incorrectly assumed only their upstream Marlin meanings.

## Inherited Klipper built-ins

These entries apply to `klipper`. The first row was already recognized; the remaining rows expand support. `SET_VELOCITY_LIMIT` still receives dedicated acceleration parsing.

| Purpose | Exact commands |
| --- | --- |
| Pressure advance, velocity limits, object annotations, print statistics | `SET_PRESSURE_ADVANCE`, `SET_VELOCITY_LIMIT`, `EXCLUDE_OBJECT_DEFINE`, `EXCLUDE_OBJECT_START`, `EXCLUDE_OBJECT_END`, `SET_PRINT_STATS_INFO` |
| Thermal and fan controls | `SET_HEATER_TEMPERATURE`, `TEMPERATURE_WAIT`, `TURN_OFF_HEATERS`, `SET_TEMPERATURE_FAN_TARGET`, `SET_FAN_SPEED` |
| Shaping, current, timeout, sensor and retraction settings | `SET_INPUT_SHAPER`, `SET_TMC_CURRENT`, `SET_IDLE_TIMEOUT`, `SET_FILAMENT_SENSOR`, `SET_RETRACTION` |
| Display, LEDs, messages | `SET_DISPLAY_GROUP`, `SET_DISPLAY_TEXT`, `SET_LED`, `SET_LED_TEMPLATE`, `RESPOND` |
| Sensor, driver, retraction and mesh reports; help/status | `QUERY_FILAMENT_SENSOR`, `QUERY_FILAMENT_WIDTH`, `QUERY_ENDSTOPS`, `QUERY_PROBE`, `QUERY_ADC`, `DUMP_TMC`, `GET_RETRACTION`, `BED_MESH_OUTPUT`, `BED_MESH_MAP`, `HELP`, `STATUS` |

These are documented in the [Klipper G-code reference](https://www.klipper3d.org/G-Codes.html). `SET_RETRACTION` configures firmware retraction but does not execute it; actual `G10`/`G11` retraction remains unsupported. Mesh reporting does not imply acceptance of arbitrary mesh calibration or movement commands.

## Commands that still require other handling

This expansion does not relax unknown-command handling. Unverified startup M commands still require explicit review of their assumptions and invalidate known acceleration. Unknown commands inside model geometry still block recovery. Cleaning/parking/calibration routines (`G12`, `G27`, `G30`, `G425`, `G427`) still require explicit recovery of position, feed and modes, plus review of their hidden effects.

Names alone are not always enough to classify a command as an inherited setting. Examples deliberately excluded from this expansion:

| Command | Why it is not classified as an inherited setting |
| --- | --- |
| `M111` | Debug flags can disable extrusion in dry-run mode. See [Marlin M111](https://marlinfw.org/docs/gcode/M111.html). |
| `M122` | Includes driver reinitialization as well as reporting. See [Marlin M122](https://marlinfw.org/docs/gcode/M122.html). |
| `M209` | Automatic retraction changes the physical meaning of E-only moves. See [Marlin M209](https://marlinfw.org/docs/gcode/M209.html). |
| `M217` | Its `Q` form primes the active tool. See [Marlin M217](https://marlinfw.org/docs/gcode/M217.html). |
| `M240`, `M600`, `M701`, `M702` | Camera/filament routines can move or extrude. |
| `M603`, `M910` | Meanings conflict between supported firmware families. Legacy Prusa uses them to stop a print and reinitialize drivers; they are not universally inherited settings. |
| `M92`, `M350`, `M351`, `M501`, `M502` | Axis scaling, driver microsteps or configuration restoration need separate interpretation. |
| `SET_PIN`, `SET_SERVO`, `SET_TMC_FIELD`, `UPDATE_DELAYED_GCODE` | General hardware or macro controls have effects that depend on configuration/parameters. |
| `M114`, `M154`, `GET_POSITION`, `SAVE_GCODE_STATE`, `RESTORE_GCODE_STATE` | Position reporting or saved state can expose/depend on the changed E counter. Existing counter-dependency and state-recovery checks remain in force. |
| `M573`, `M574` | Their meanings are not established for every supported firmware by this catalog. A meaning from another firmware family is insufficient to mark them as inherited settings. |

An excluded command is not automatically a hard error everywhere: the existing startup-concern, state-recovery and continuation rules determine its outcome. Future support for a restricted parameter form should have an explicit interpreter rule and regression tests, rather than admitting every form of the command.

### INDX sample: source evidence checked September 22, 2026

The legacy Prusa i3 article and Buddy reference do not document the sample's `M573 R` or `M574 S0 V35 T260 F6.76977` forms. The [RepRap M573 entry](https://reprap.org/wiki/G-code#M573:_Report_heater_PWM) describes a heater-PWM report using `P`, and its support table marks Prusa/Buddy unsupported. That is not evidence for the sample's `R` form.

Current [PrusaSlicer source](https://github.com/prusa3d/PrusaSlicer/blob/30ef59195e0f3ee6f270b185bb5f9fb5f349f81f/src/libslic3r/src/libslic3r/GCode/GCodeWriter.cpp#L664-L672) emits `M573 R` from `emit_automatic_pressure_advance_calibration()` for the Buddy flavor. This establishes its intended purpose in the slicer, but does not establish a firmware implementation or its effects on motion/retraction.

The [current INDX printer profile](https://github.com/prusa3d/PrusaSlicer/blob/30ef59195e0f3ee6f270b185bb5f9fb5f349f81f/resources/presets/prusa-research-fff/PrusaResearch/preset-printer-coreone-indx.yaml#L376-L398) emits `M574` for used non-FLEX tools, with a tool index, configured temperature and a filament-speed value derived from the flow limit. It uses `V90` where the included sample has `V35`; the profile does not explain that parameter's meaning. The template establishes how values are chosen, not how the firmware executes them.

Neither command has a handler in the public Buddy command dispatchers checked at `v6.9.1-beta` ([Prusa extensions](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/v6.9.1-beta/src/marlin_stubs/gcode.cpp), [Marlin dispatcher](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/v6.9.1-beta/lib/Marlin/Marlin/src/gcode/gcode.cpp)) or master commit `1ce23f33ed3b94e26aa33a44557d6c4a4be11eb6`. Their startup concerns therefore remain; absence from these versions is not a promise about other firmware builds.

Other sample commands do have source documentation: [G12](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/v6.9.1-beta/src/marlin_stubs/G12.cpp) documents cleaning-sequence selection and optional automatic retraction, while [G427](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/v6.9.1-beta/src/marlin_stubs/G427.cpp) documents full tool-offset calibration. They retain the generic startup-routine recovery rules. None of these source findings authorize adding the commands to generated brim code.

## Verification

`tests/input-commands.test.ts` places the inherited commands both before the selected approach and within model geometry. It checks unchanged state, acceleration planning, footprint, generated brim and original source bytes in both export modes. Regressions also cover firmware scope, compact/lowercase spelling, exact-token matching, continued rejection of unmodeled effects, units, and acceleration changes among inherited settings. Existing output-allowlist and binary roundtrip tests continue to apply.
