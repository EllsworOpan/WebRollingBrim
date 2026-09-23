import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInsertion, exportBytes } from '../src/core/export';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { DEFAULT_BRIM, type BrimResult } from '../src/core/types';

/** Independent replay of the linear commands used by this fixture, including
 * M204 S and slicer annotations. Startup macros are opaque; comparison starts
 * after the source has explicitly established the modes, position and feeds. */
function trace(source: string, initial?: ReturnType<typeof initialState>) {
  const state = { ...(initial ?? initialState()) };
  const moves: {
    command: string; x: number; y: number; z: number; xy: number; dz: number;
    e: number; f: number; acceleration: number; type: string; width: number; height: number;
  }[] = [];
  for (const line of source.split(/\r\n|\n|\r/)) {
    if (line.startsWith(';TYPE:')) state.type = line.slice(6);
    if (line.startsWith(';WIDTH:')) state.width = Number(line.slice(7));
    if (line.startsWith(';HEIGHT:')) state.height = Number(line.slice(8));
    const command = line.split(';')[0].trim();
    const [op, ...words] = command.split(/\s+/);
    const args = Object.fromEntries(words.map(word => [word[0], Number(word.slice(1))]));
    if (op === 'G90') state.absoluteXYZ = true;
    if (op === 'G91') state.absoluteXYZ = false;
    if (op === 'M82') state.absoluteE = true;
    if (op === 'M83') state.absoluteE = false;
    if (op === 'G92' && 'E' in args) state.e = args.E;
    if (op === 'M204' && 'S' in args) state.acceleration = args.S;
    if (op !== 'G0' && op !== 'G1') continue;
    const previous = { ...state };
    if ('X' in args) state.x = (state.absoluteXYZ ? 0 : state.x) + args.X;
    if ('Y' in args) state.y = (state.absoluteXYZ ? 0 : state.y) + args.Y;
    if ('Z' in args) state.z = (state.absoluteXYZ ? 0 : state.z) + args.Z;
    if ('F' in args) state.f = args.F;
    const e = 'E' in args ? args.E - (state.absoluteE ? state.e : 0) : 0;
    state.e += e;
    moves.push({ command, x: state.x, y: state.y, z: state.z,
      xy: Math.hypot(state.x - previous.x, state.y - previous.y), dz: state.z - previous.z,
      e, f: state.f, acceleration: state.acceleration, type: state.type, width: state.width, height: state.height });
  }
  return { state, moves };
}

function initialState() {
  return { x: NaN, y: NaN, z: NaN, e: 0, f: NaN, acceleration: NaN,
    absoluteXYZ: true, absoluteE: true, type: '', width: NaN, height: NaN };
}

const source = readFileSync(new URL('../examples/gcodes/Shape-Box_0.2mm_PLA_V2_40m.gcode', import.meta.url), 'utf8');
const job = parseGcode(source), geometry = buildFootprint(job);
const settings = { ...DEFAULT_BRIM, width: Number(job.config.brim_width), gap: Number(job.config.brim_separation),
  lineWidth: job.settings.lineWidth, speed: job.settings.printSpeed, travelLift: job.settings.zHop };
const bytes = new TextEncoder().encode(source), offset = job.insertion!.byteOffset;
const prefix = new TextDecoder().decode(bytes.slice(0, offset));
const suffix = new TextDecoder().decode(bytes.slice(offset));
const originalState = trace(prefix).state;
const brimStart = source.indexOf(';WIPE_END', source.indexOf(';TYPE:Skirt/Brim'));
const brimEnd = source.indexOf(';WIPE_START', brimStart);
const reference = trace(source.slice(brimStart, brimEnd), trace(source.slice(0, brimStart)).state).moves;
let brim: BrimResult, added: string, generated: ReturnType<typeof trace>;

beforeAll(() => {
  // Only this comparison ignores the existing skirt/brim. Normal app generation
  // protects it; tests/toolpaths.test.ts checks that it produces no duplicate brim.
  brim = generateBrim({ ...geometry, auxiliary: [] }, job, settings);
  added = createInsertion(job, brim);
  generated = trace(added, originalState);
});

describe('PrusaSlicer box command reference', () => {
  it('matches brim/step feeds and uses no retract or lift between neighboring loops', () => {
    const deposition = (moves: typeof reference) => moves.filter(move => move.e > 0 && move.xy > 0);
    expect(deposition(reference).length).toBeGreaterThan(40);
    expect(deposition(generated.moves).length).toBeGreaterThan(40);
    expect(new Set(deposition(reference).map(move => move.f))).toEqual(new Set([1200]));
    expect(new Set(deposition(generated.moves).map(move => move.f))).toEqual(new Set([1200]));
    const referenceSteps = reference.filter(move => move.xy > 0 && move.dz === 0 && move.e === 0);
    expect(referenceSteps).toHaveLength(10);
    expect(new Set(referenceSteps.map(move => move.f))).toEqual(new Set([18000]));
    expect(referenceSteps.every(move => move.xy > 0.43 && move.xy < 0.45)).toBe(true);
    const loops = added.slice(added.indexOf('; BRIM_STEP'), added.indexOf('; BRIM_HANDOFF'));
    const steps = [...loops.matchAll(/; BRIM_STEP\r?\nM204 S4000\r?\n([^\r\n]+)\r?\nM204 S286\r?\n([^\r\n]+)/g)];
    expect(steps).toHaveLength(referenceSteps.length);
    for (const [, step, extrusion] of steps) {
      expect(step).toMatch(/^G1(?: [XY][-\d.]+)+ F18000$/);
      expect(extrusion).toMatch(/^G1(?: [XY][-\d.]+)+ E[\d.]+ F1200$/);
    }
    expect(loops).not.toMatch(/\bZ[-\d.]|\bE-/);
  });

  it('hands back to the original approach and preserves all subsequent model movements', () => {
    expect(originalState).toMatchObject({ x: 161.345, y: 157.381, z: 0.2, f: 14400,
      acceleration: 1714, absoluteXYZ: true, absoluteE: false, type: 'Skirt/Brim', width: 0.48, height: 0.2 });
    expect(prefix.trimEnd()).toMatch(/;WIPE_END$/);
    expect(job.insertion!.nextMoveFeed).toBe(18000);
    expect(suffix.split(/\r?\n/)[0]).toBe('M204 S4000');
    expect(added.split(/\r?\n/).filter(line => /^G1 F/.test(line))).toEqual([]);
    expect(generated.state.z).toBe(0.998);
    expect(generated.state.e).toBeGreaterThan(originalState.e);
    const preparation = suffix.slice(0, suffix.indexOf('G1 X158.377 Y191.623 E1.14785'));
    const originalModel = trace(preparation, originalState).state;
    const resumedModel = trace(preparation, generated.state).state;
    expect(resumedModel).toEqual({ ...originalModel, e: resumedModel.e });
    const resumedApproach = trace(preparation, generated.state).moves[0];
    expect(resumedApproach).toMatchObject({ x: 191.623, y: 191.623, z: 0.998, dz: 0, e: 0, f: 18000, acceleration: 4000 });
    // Replay through the perimeter -> external perimeter -> infill transitions.
    const restOfFirstLayer = suffix.slice(preparation.length, suffix.indexOf(';LAYER_CHANGE'));
    const originalMoves = trace(restOfFirstLayer, originalModel).moves;
    const resumedMoves = trace(restOfFirstLayer, resumedModel).moves;
    expect(resumedMoves).toEqual(originalMoves);
    expect(originalMoves[0]).toMatchObject({ f: 1200, acceleration: 286, e: 1.14785 });
    expect(originalMoves.find(move => move.type === 'Solid infill' && move.e > 0)).toMatchObject({ f: 6000 });
    const output = exportBytes(bytes, job, brim), insertionLength = output.length - bytes.length;
    expect(output.slice(0, offset)).toEqual(bytes.slice(0, offset));
    expect(output.slice(offset + insertionLength)).toEqual(bytes.slice(offset));
  });

  it('uses the source print/travel accelerations and reuses the completed wipe retraction', () => {
    const referenceSteps = reference.filter(move => move.xy > 0 && move.dz === 0 && move.e === 0);
    expect(new Set(referenceSteps.map(move => move.acceleration))).toEqual(new Set([4000]));
    expect(new Set(reference.filter(move => move.e > 0 && move.xy > 0).map(move => move.acceleration))).toEqual(new Set([286]));
    expect(new Set(generated.moves.filter(move => move.e > 0 && move.xy > 0).map(move => move.acceleration))).toEqual(new Set([286]));
    expect(new Set(generated.moves.filter(move => move.xy > 0 && move.e === 0).map(move => move.acceleration))).toEqual(new Set([4000]));
    const retracts = generated.moves.filter(move => move.e < 0);
    expect(retracts).toHaveLength(1); // source already retracted on entry
    expect(retracts.every(move => move.e === -0.8 && move.xy === 0 && move.f === 3000)).toBe(true);
    expect(generated.moves.filter(move => move.e > 0 && move.xy === 0).every(move => move.e === 0.8 && move.f === 1800)).toBe(true);
    const lifts = generated.moves.filter(move => move.dz !== 0);
    expect(lifts.map(move => move.z)).toEqual([0.6, 0.2, 0.998]);
    expect(lifts.every(move => move.f === 600)).toBe(true);
  });

  it('matches the reference bead width and measured extrusion per mm on straight sections', () => {
    expect(job.settings).toMatchObject({ lineWidth: 0.48, layerHeight: 0.2, flow: 0.95, filamentDiameter: 1.75 });
    const longExtrusions = (moves: typeof reference) => moves.filter(move => move.e > 0 && move.xy > 10);
    const original = longExtrusions(reference), actual = longExtrusions(generated.moves);
    expect(original.length).toBeGreaterThan(30);
    expect(actual.length).toBeGreaterThan(30);
    expect(new Set(original.map(move => move.width))).toEqual(new Set([0.48]));
    expect(new Set(actual.map(move => move.width))).toEqual(new Set([0.48]));
    const measuredFlow = (moves: typeof reference) => moves.reduce((sum, move) => sum + move.e, 0) / moves.reduce((sum, move) => sum + move.xy, 0);
    // Independent measurements from the source's E and XY, not our flow formula.
    expect(Math.abs(measuredFlow(actual) - measuredFlow(original))).toBeLessThan(0.000001);
  });

  it('does not misapply infill/perimeter overlap to brim spacing or extrusion', () => {
    expect(job.config.infill_overlap).toBe('15%');
    for (const overlap of ['0%', '50%']) {
      const changed = parseGcode(source.replace('; infill_overlap = 15%', `; infill_overlap = ${overlap}`));
      expect(changed.config.infill_overlap).toBe(overlap);
      const planned = generateBrim({ ...geometry, auxiliary: [] }, changed, settings);
      expect(planned.paths).toEqual(brim.paths);
      expect(createInsertion(changed, planned)).toBe(added);
    }
  });
});
