import { extrusionPerMm } from './gcode';
import { validateBrimSettings } from './geometry';
import type { BrimResult, ParsedJob } from './types';

const n = (value: number, precision = 4) => {
  if (!Number.isFinite(value)) throw new Error('A generated G-code value is not finite.');
  return Number(value.toFixed(precision)).toString();
};

/** A single self-contained insertion. No original commands, comments, or line endings are rewritten. */
export function createInsertion(job: ParsedJob, brim: BrimResult): string {
  if (job.blockers.length) throw new Error(job.blockers.join(' '));
  if (!job.insertion || !brim.paths.length) throw new Error('Generate a printable brim before exporting.');
  validateBrimSettings(brim.settings, job);
  const s = job.insertion.state, p = job.settings;
  const bead = extrusionPerMm(p, brim.settings.lineWidth);
  const liftedZ = Math.max(s.z, job.firstLayerZ) + Math.max(p.zHop, p.layerHeight * 2);
  const lines = [
    '; ROLLING_BRIM_BEGIN v1',
    `; rolling_diameter = ${n(brim.settings.diameter)}`,
    `; brim_width = ${n(brim.settings.width)}`,
    `; brim_gap = ${n(brim.settings.gap)}`,
    `; enclosed_holes = ${brim.settings.holes ? 'on' : 'off'}`,
    `; narrow_entry_pockets = ${brim.settings.pockets ? 'on' : 'off'}`,
    ';TYPE:Skirt/Brim', `;WIDTH:${n(brim.settings.lineWidth)}`, `;HEIGHT:${n(p.layerHeight)}`,
  ];
  // Startup macros can leave an unknown E origin. Klipper saves it on the printer,
  // rather than substituting the interpreter's relative-extrusion accumulator.
  if (job.flavor === 'klipper') lines.push('SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP');
  lines.push('G90', 'M83');
  const retract = () => { if (p.retractLength > 0) lines.push(`G1 E-${n(p.retractLength, 5)} F${n(p.retractSpeed * 60)}`); };
  const unretract = () => { if (p.retractLength > 0) lines.push(`G1 E${n(p.retractLength, 5)} F${n(p.unretractSpeed * 60)}`); };
  for (const path of brim.paths) {
    retract();
    lines.push(`G1 Z${n(liftedZ)} F${n(p.zSpeed * 60)}`, `G1 X${n(path[0].x)} Y${n(path[0].y)} F${n(p.travelSpeed * 60)}`, `G1 Z${n(job.firstLayerZ)} F${n(p.zSpeed * 60)}`);
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
  lines.push(`G1 Z${n(liftedZ)} F${n(p.zSpeed * 60)}`, `G1 X${n(s.x)} Y${n(s.y)} F${n(p.travelSpeed * 60)}`, `G1 Z${n(s.z)} F${n(p.zSpeed * 60)}`);
  unretract();
  if (s.eKnown) lines.push(`G92 E${n(s.e, 7)}`);
  lines.push(s.absoluteXYZ ? 'G90' : 'G91', s.absoluteE ? 'M82' : 'M83', `G1 F${n(s.f)}`);
  if (job.flavor === 'klipper') lines.push('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
  lines.push(`;TYPE:${s.type}`, `;WIDTH:${n(s.width, 6)}`, `;HEIGHT:${n(s.height, 6)}`, '; ROLLING_BRIM_END');
  return lines.join(job.newline) + job.newline;
}

export function exportBytes(original: Uint8Array, job: ParsedJob, brim: BrimResult): Uint8Array {
  if (original.byteLength !== job.bytes) throw new Error('The source file does not match this preview.');
  const added = new TextEncoder().encode(createInsertion(job, brim));
  const offset = job.insertion!.byteOffset;
  const output = new Uint8Array(original.length + added.length);
  output.set(original.subarray(0, offset)); output.set(added, offset); output.set(original.subarray(offset), offset + added.length);
  return output;
}
