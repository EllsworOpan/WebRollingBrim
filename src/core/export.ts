import { extrusionPerMm } from './gcode';
import { validateBrimSettings } from './geometry';
import type { BrimResult, ExportMode, ParsedJob } from './types';

const n = (value: number, precision = 4) => {
  if (!Number.isFinite(value)) throw new Error('A generated G-code value is not finite.');
  return Number(value.toFixed(precision)).toString();
};

export function exportBlockers(job: ParsedJob, mode: ExportMode = 'standard'): string[] {
  if (mode === 'standard') return [...job.blockers, ...job.standardBlockers];
  if (mode === 'klipper') return [...job.blockers, ...job.klipperBlockers, ...(job.flavor === 'klipper' ? [] : ['Klipper state restore requires a file explicitly marked klipper.'])];
  return [...job.blockers, 'Unknown export mode.'];
}

/** A single insertion. Standard mode relies on the checked relative-E continuation. */
export function createInsertion(job: ParsedJob, brim: BrimResult, mode: ExportMode = 'standard'): string {
  const blockers = exportBlockers(job, mode);
  if (blockers.length) throw new Error(blockers.join(' '));
  if (!job.insertion || !brim.paths.length) throw new Error('Generate a printable brim before exporting.');
  validateBrimSettings(brim.settings, job);
  const s = job.insertion.state, p = job.settings;
  const bead = extrusionPerMm(p, brim.settings.lineWidth);
  const liftedZ = job.firstLayerZ + brim.settings.travelLift;
  const lines = [
    '; ROLLING_BRIM_BEGIN v1',
    `; export_mode = ${mode}`,
    `; rolling_diameter = ${n(brim.settings.diameter)}`,
    `; brim_width = ${n(brim.settings.width)}`,
    `; brim_gap = ${n(brim.settings.gap)}`,
    `; travel_lift = ${n(brim.settings.travelLift)}`,
    `; enclosed_holes = ${brim.settings.holes ? 'on' : 'off'}`,
    `; narrow_entry_pockets = ${brim.settings.pockets ? 'on' : 'off'}`,
    ';TYPE:Skirt/Brim', `;WIDTH:${n(brim.settings.lineWidth)}`, `;HEIGHT:${n(p.layerHeight)}`,
  ];
  // Startup macros can leave an unknown E origin. Klipper saves it on the printer,
  // rather than substituting the interpreter's relative-extrusion accumulator.
  if (mode === 'klipper') lines.push('SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP');
  lines.push('G90', 'M83');
  const retract = () => { if (p.retractLength > 0) lines.push(`G1 E-${n(p.retractLength, 5)} F${n(p.retractSpeed * 60)}`); };
  const unretract = () => { if (p.retractLength > 0) lines.push(`G1 E${n(p.retractLength, 5)} F${n(p.unretractSpeed * 60)}`); };
  const travel = (x: number, y: number) => {
    // Zero means no Z commands at all. Eligibility requires starting at first-layer Z.
    if (brim.settings.travelLift > 0) lines.push(`G1 Z${n(liftedZ)} F${n(p.zSpeed * 60)}`);
    lines.push(`G1 X${n(x)} Y${n(y)} F${n(p.travelSpeed * 60)}`);
    if (brim.settings.travelLift > 0) lines.push(`G1 Z${n(s.z)} F${n(p.zSpeed * 60)}`);
  };
  for (const path of brim.paths) {
    retract();
    travel(path[0].x, path[0].y);
    unretract();
    lines.push(`G1 F${n(brim.settings.speed * 60)}`);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const extrusion = Math.hypot(b.x - a.x, b.y - a.y) * bead;
      if (extrusion < 0.000005) continue;
      lines.push(`G1 X${n(b.x)} Y${n(b.y)} E${n(extrusion, 5)}`);
    }
  }
  retract();
  travel(s.x, s.y);
  unretract();
  // Do not invent/reset E in standard mode. Original relative moves are unaffected;
  // the source's next G92 E (if any) removes the counter difference.
  lines.push('G90', 'M83', `G1 F${n(s.f)}`);
  if (mode === 'klipper') lines.push('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
  lines.push(`;TYPE:${s.type}`, `;WIDTH:${n(s.width, 6)}`, `;HEIGHT:${n(s.height, 6)}`, '; ROLLING_BRIM_END');
  return lines.join(job.newline) + job.newline;
}

export function exportBytes(original: Uint8Array, job: ParsedJob, brim: BrimResult, mode: ExportMode = 'standard'): Uint8Array {
  if (original.byteLength !== job.bytes) throw new Error('The source file does not match this preview.');
  const added = new TextEncoder().encode(createInsertion(job, brim, mode));
  const offset = job.insertion!.byteOffset;
  const output = new Uint8Array(original.length + added.length);
  output.set(original.subarray(0, offset)); output.set(added, offset); output.set(original.subarray(offset), offset + added.length);
  return output;
}
