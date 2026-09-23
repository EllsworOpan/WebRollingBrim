/** Input interpretation is independent of the generated-command allowlist.
 * Exact tokens only: adding M300 must not implicitly recognize M3000/M300.1.
 * Sources, scopes and exclusions are documented in docs/input-commands.md.
 */
const commands = (tokens: string) => new Set(tokens.trim().split(/\s+/));

// Existing numeric compatibility set. State-changing entries (e.g. M204,
// M82/M83, G21, M200) still pass through the interpreter's dedicated checks.
const interpreted = commands(`
  G4 G17 G21 G91.1 M73 M82 M83 M104 M105 M106 M107 M109 M115 M117 M118
  M140 M141 M190 M191 M200 M201 M203 M204 M205 M207 M208 M220 M221 M400
  M420 M486 M555 M569 M572 M593 M862 M862.1 M862.2 M862.3 M862.4 M862.5
  M862.6 M862.7 M862.8 M862.9 M900 T0
`);

// These settings and reports neither move XYZE nor change their interpretation,
// modal feed, or the print/travel/retract acceleration tracked by the app.
// Firmware limits, thermal controls and overrides remain active and inherited.
const marlinInherited = commands(`
  M16 M27 M31 M75 M76 M77 M78 M113 M119 M123 M155 M503 M504
  M150 M151 M250 M255 M256 M300 M355 M414 M7219
  M86 M87 M142 M145 M149 M192 M301 M302 M304 M305 M309 M710
  M17 M906 M907 M908 M909 M911 M912 M913 M914 M919 M920
  M403 M407 M412 M591 M210 M211
`);

// Do not infer a narrower firmware family from a printer name or marlin/marlin2.
// M603 stops prints in legacy Prusa firmware; M910 reinitializes its drivers.
// Their different upstream Marlin meanings do not make them inherited settings.

const klipperInherited = commands(`
  SET_PRESSURE_ADVANCE SET_VELOCITY_LIMIT
  EXCLUDE_OBJECT_DEFINE EXCLUDE_OBJECT_START EXCLUDE_OBJECT_END SET_PRINT_STATS_INFO
  SET_HEATER_TEMPERATURE TEMPERATURE_WAIT TURN_OFF_HEATERS SET_TEMPERATURE_FAN_TARGET SET_FAN_SPEED
  SET_INPUT_SHAPER SET_TMC_CURRENT SET_IDLE_TIMEOUT SET_FILAMENT_SENSOR SET_RETRACTION
  SET_DISPLAY_GROUP SET_DISPLAY_TEXT SET_LED SET_LED_TEMPLATE RESPOND
  QUERY_FILAMENT_SENSOR QUERY_FILAMENT_WIDTH QUERY_ENDSTOPS QUERY_PROBE QUERY_ADC
  DUMP_TMC GET_RETRACTION BED_MESH_OUTPUT BED_MESH_MAP HELP STATUS
`);

export function knownInputCommand(command: string, flavor: string): boolean {
  return interpreted.has(command)
    || (['marlin', 'marlin2'].includes(flavor) && marlinInherited.has(command));
}

export function knownInputMacro(code: string, flavor: string): boolean {
  // A word boundary also matches punctuation, which could incorrectly bless a
  // different custom macro such as SET_LED.CUSTOM. Require the entire token.
  return flavor === 'klipper' && klipperInherited.has(code.split(/\s/, 1)[0].toUpperCase());
}

// Opaque cleaning, parking and calibration routines are startup barriers, not
// additional generated commands. Their positions must be recovered afterward;
// unverified effects on other state require explicit acceptance at export.
export const startupRoutine = /^(G12|G27|G30|G425|G427)$/;

// These change the interpretation of coordinates/extrusion or restore opaque
// saved state. Later absolute destinations alone do not establish compatibility.
export const unsupportedTransform = /^(M92|M206|M218|M428|M501|M502|M563|M567|M568|M579|M605|M665|M666)$/;
