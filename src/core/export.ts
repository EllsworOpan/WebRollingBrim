import { extrusionPerMm } from './gcode';
import { validateBrimSettings } from './geometry';
import type { BrimResult, ExportMode, ParsedJob } from './types';

const decimal = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error('A generated G-code value is not finite.');
  const [coefficient, exponent] = String(value).split('e');
  if (exponent === undefined) return coefficient;
  // Source coordinates/feed can have more precision than generated geometry.
  // Restore them without rounding or emitting scientific notation into G-code.
  const sign = coefficient.startsWith('-') ? '-' : '';
  const [whole, fraction = ''] = coefficient.replace('-', '').split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};
const n = (value: number, precision = 4) => decimal(Number(value.toFixed(precision)));

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
  if (brim.transitions.length !== brim.paths.length || brim.transitions[0] !== 'travel' || brim.transitions.some(kind => kind !== 'step' && kind !== 'travel')) throw new Error('The brim travel plan is incomplete. Regenerate the brim.');
  validateBrimSettings(brim.settings, job);
  const s = job.insertion.state, p = job.settings;
  const bead = extrusionPerMm(p, brim.settings.lineWidth);
  const liftedZ = s.z + brim.settings.travelLift;
  const lines = [
    '; ROLLING_BRIM_BEGIN v1',
    `; export_mode = ${mode}`,
    `; rolling_diameter = ${n(brim.settings.diameter)}`,
    `; brim_width = ${n(brim.settings.width)}`,
    `; brim_gap = ${n(brim.settings.gap)}`,
    '; path_order = outside_to_model',
    `; travel_lift = ${n(brim.settings.travelLift)}`,
    `; enclosed_holes = ${brim.settings.holes ? 'on' : 'off'}`,
    `; narrow_entry_pockets = ${brim.settings.pockets ? 'on' : 'off'}`,
    ';TYPE:Skirt/Brim', `;WIDTH:${n(brim.settings.lineWidth)}`, `;HEIGHT:${n(p.layerHeight)}`,
  ];
  // Startup macros can leave an unknown E origin. Klipper saves it on the printer,
  // rather than substituting the interpreter's relative-extrusion accumulator.
  if (mode === 'klipper') lines.push('SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP');
  // Eligibility already establishes G90 / M83. Leave these modes alone.
  const position = { X: s.x, Y: s.y, Z: s.z };
  let feed = s.f;
  const move = (axes: Partial<Record<'X' | 'Y' | 'Z' | 'E', number>>, speed: number, exact = false) => {
    const words: string[] = [];
    for (const axis of ['X', 'Y', 'Z', 'E'] as const) {
      if (axes[axis] === undefined) continue;
      const value = exact ? axes[axis]! : Number(n(axes[axis]!, axis === 'E' ? 5 : 4));
      if (!Number.isFinite(value)) throw new Error('A generated G-code value is not finite.');
      // E is a relative action, never a modal value to deduplicate.
      if (axis === 'E') { if (value !== 0) words.push(`E${decimal(value)}`); }
      else if (position[axis] !== value) { words.push(`${axis}${decimal(value)}`); position[axis] = value; }
    }
    if (!words.length) return;
    const nextFeed = Number(n(speed * 60));
    if (feed !== nextFeed) { words.push(`F${decimal(nextFeed)}`); feed = nextFeed; }
    lines.push(`G1 ${words.join(' ')}`);
  };
  const retract = () => move({ E: -p.retractLength }, p.retractSpeed);
  const unretract = () => move({ E: p.retractLength }, p.unretractSpeed);
  const travel = (x: number, y: number, exact = false) => {
    const target = { X: exact ? x : Number(n(x)), Y: exact ? y : Number(n(y)) };
    if (position.X === target.X && position.Y === target.Y) return;
    retract();
    // Zero means no Z commands at all. Eligibility requires starting at first-layer Z.
    if (brim.settings.travelLift > 0) move({ Z: liftedZ }, p.zSpeed);
    move(target, p.travelSpeed, true);
    if (brim.settings.travelLift > 0) move({ Z: s.z }, p.zSpeed, true);
    unretract();
  };
  for (const [index, path] of brim.paths.entries()) {
    if (brim.transitions[index] === 'step') {
      // Geometry has checked this entire short connector against the printable
      // region. It adds no extrusion and does not change Z or retraction state.
      lines.push('; BRIM_STEP');
      move({ X: path[0].x, Y: path[0].y }, p.travelSpeed);
    } else {
      lines.push('; BRIM_TRAVEL');
      travel(path[0].x, path[0].y);
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const extrusion = Math.hypot(b.x - a.x, b.y - a.y) * bead;
      if (extrusion < 0.000005 || (position.X === Number(n(b.x)) && position.Y === Number(n(b.y)))) continue;
      move({ X: b.x, Y: b.y, E: extrusion }, brim.settings.speed);
    }
  }
  lines.push('; BRIM_RETURN');
  travel(s.x, s.y, true);
  // Do not invent/reset E in standard mode. Original relative moves are unaffected;
  // the source's next G92 E (if any) removes the counter difference.
  if (mode === 'klipper') lines.push('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
  // The next original move can establish its own speed. Do not restore a feed
  // that it immediately replaces; otherwise preserve the feed it inherits.
  else {
    const nextFeed = job.insertion.nextMoveFeed;
    const setsOwnFeed = typeof nextFeed === 'number' && Number.isFinite(nextFeed) && nextFeed > 0;
    if (feed !== s.f && !setsOwnFeed) lines.push(`G1 F${decimal(s.f)}`);
  }
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
