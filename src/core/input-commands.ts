/** Input interpretation is independent of the generated-command allowlist. */
export function inheritedSetting(command: string, flavor: string): boolean {
  // Monitoring and motor current do not change XYZE coordinates or modal feed.
  return ['marlin', 'marlin2'].includes(flavor) && ['M591', 'M906'].includes(command);
}

// Opaque cleaning, parking and calibration routines are startup barriers, not
// additional generated commands. Their positions must be recovered afterward;
// unverified effects on other state require explicit acceptance at export.
export const startupRoutine = /^(G12|G27|G30|G425|G427)$/;

// These change the interpretation of coordinates/extrusion or restore opaque
// saved state. Later absolute destinations alone do not establish compatibility.
export const unsupportedTransform = /^(M92|M206|M218|M428|M501|M502|M563|M567|M568|M579|M605|M665|M666)$/;
