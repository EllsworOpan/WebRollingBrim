import type { AccelerationState, InsertionPlan, PrinterState } from './types';

export const unknownAcceleration = (): AccelerationState => ({ print: null, travel: null, retract: null });

/** Firmware-specific effects, including which fields a partial M204 writes. */
export function accelerationWrites(args: Record<string, number>, flavor: string): Partial<AccelerationState> {
  if (flavor === 'klipper') {
    const value = args.S ?? (args.P !== undefined && args.T !== undefined ? Math.min(args.P, args.T) : undefined);
    return value === undefined ? {} : { print: value, travel: value };
  }
  return {
    ...('S' in args ? { print: args.S, travel: args.S } : {}),
    ...('P' in args ? { print: args.P } : {}),
    ...('T' in args ? { travel: args.T } : {}),
    ...('R' in args ? { retract: args.R } : {}),
  };
}

export interface ApproachCommand {
  command: string; args: Record<string, number>;
  index: number; line: number; before: PrinterState;
  modesKnown: boolean;
}

/** Analyze the source AFTER a possible boundary. Never move original commands.
 * The recognized suffix is deliberately small: M204, one linear XY travel,
 * feed/Z setup and stationary unretraction. Other commands are barriers.
 */
export function planInsertion(source: string, approach: ApproachCommand[], model: ApproachCommand, flavor: string,
  firstLayerAcceleration: number): InsertionPlan {
  const s = model.before;
  const fallback = (reason: string): InsertionPlan => ({
    byteOffset: new TextEncoder().encode(source.slice(0, model.index)).byteLength,
    line: model.line, state: s, kind: 'model', modelLine: model.line, modelState: s, modelFeed: model.args.F > 0 ? model.args.F : s.f, printZ: s.z,
    nextMoveFeed: model.args.F > 0 ? model.args.F : null,
    handoff: { x: s.x, y: s.y, z: s.z, retracted: s.retracted },
    acceleration: { print: null, travel: null, restore: {} }, reason,
  });
  // The last XY command must establish BOTH coordinates without extrusion.
  let xyIndex = approach.length - 1;
  while (xyIndex >= 0 && !('X' in approach[xyIndex].args || 'Y' in approach[xyIndex].args)) xyIndex--;
  if (xyIndex < 0) return fallback('No supported approach travel; insert before model extrusion and return to its start.');
  const travel = approach[xyIndex], a = travel.args;
  if (!['G0', 'G1'].includes(travel.command) || !('X' in a && 'Y' in a) || 'E' in a || !travel.modesKnown
    || !travel.before.absoluteXYZ || travel.before.absoluteE || !Number.isFinite(travel.before.z)) {
    return fallback('The approach does not establish a supported absolute XY travel from a known Z; use the model start.');
  }
  // Include adjacent acceleration setup so the unchanged source can establish
  // its travel acceleration again. Comments between these commands are retained.
  let begin = xyIndex;
  while (begin > 0 && approach[begin - 1].command === 'M204') begin--;
  const entry = approach[begin], before = entry.before;
  if (!entry.modesKnown || !Number.isFinite(before.f) || before.f <= 0 || !Number.isFinite(before.retracted)) {
    return fallback('The earlier travel state is incomplete; use the model start.');
  }
  const handoffZ = a.Z ?? before.z;
  if (before.z < s.z - 0.002 || handoffZ < s.z - 0.002 || !Number.isFinite(handoffZ)) {
    return fallback('The approach height cannot provide a supported brim handoff; use the model start.');
  }
  // Pure positive E must only repay known retraction, not prime extra material.
  for (const move of approach.slice(xyIndex + 1)) {
    if (move.command === 'M204') continue;
    if (!['G0', 'G1'].includes(move.command) || 'X' in move.args || 'Y' in move.args
      || ('E' in move.args && (move.args.E < 0 || 'Z' in move.args || move.args.E > move.before.retracted + 1e-7))) {
      return fallback('The model preparation contains an unsupported movement; use the model start.');
    }
  }
  const suffix = [...approach.slice(begin), model];
  // Determine which original modal values are used before they are overwritten.
  // Fields never mentioned in this suffix also need preservation for later layers.
  const restore: Partial<AccelerationState> = {};
  for (const field of ['print', 'travel', 'retract'] as const) {
    let overwritten = false;
    for (const move of suffix) {
      if (move.command === 'M204' && field in accelerationWrites(move.args, flavor)) { overwritten = true; break; }
      const axes = move.args;
      const xyz = ['X', 'Y', 'Z'].some(axis => axis in axes);
      const physical = xyz || ('E' in axes && axes.E !== 0);
      const used = flavor === 'klipper' ? physical && field !== 'retract'
        : xyz ? field === ('E' in axes && axes.E !== 0 ? 'print' : 'travel')
          : 'E' in axes && axes.E !== 0 && field === 'retract';
      if (used) break;
    }
    if (!overwritten) restore[field] = before.acceleration[field];
  }
  const print = firstLayerAcceleration > 0 ? firstLayerAcceleration : s.acceleration.print;
  const travelAcceleration = travel.before.acceleration.travel;
  const changed = flavor === 'klipper' && (print !== null || travelAcceleration !== null)
    ? ['print', 'travel'] as const
    : (['print', 'travel'] as const).filter(field => (field === 'print' ? print : travelAcceleration) !== null);
  if (changed.some(field => field in restore && restore[field] === null)) {
    return fallback('Acceleration needed by the continuation is unknown; keep the original model-start insertion.');
  }
  let nextMoveFeed: number | null = null;
  for (const move of suffix) {
    if (!['G0', 'G1', 'G2', 'G3'].includes(move.command)) continue;
    if (move.args.F > 0) { nextMoveFeed = move.args.F; break; }
    if (['X', 'Y', 'Z', 'E'].some(axis => axis in move.args)) break;
  }
  return {
    byteOffset: new TextEncoder().encode(source.slice(0, entry.index)).byteLength,
    line: entry.line, state: before, kind: 'travel', modelLine: model.line, modelState: s, modelFeed: model.args.F > 0 ? model.args.F : s.f, printZ: s.z,
    nextMoveFeed, handoff: { x: a.X, y: a.Y, z: handoffZ, retracted: before.retracted },
    acceleration: { print, travel: travelAcceleration, restore },
    reason: `Insert before the model approach; reuse ${Number(before.retracted.toFixed(5))} mm retraction and hand back at Z${handoffZ}.`,
  };
}
