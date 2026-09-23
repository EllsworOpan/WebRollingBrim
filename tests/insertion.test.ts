import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, exportBytes } from '../src/core/export';
import { DEFAULT_BRIM, type ExportMode } from '../src/core/types';
import { fixtureSource } from './fixtures';

const forbidden = /^(?:M10[4679]|M1[49]0|M19[01]|M20[15]|M22[01]|M572|M900|SET_PRESSURE_ADVANCE|SET_VELOCITY_LIMIT|SET_FAN_SPEED|SET_HEATER_TEMPERATURE)\b/m;
const sample = readFileSync(new URL('../examples/gcodes/clearance-test-plate.gcode', import.meta.url), 'utf8');
const approachSource = () => fixtureSource().replace('G1 X20 Y20 Z0.2 F1200', [
  'G1 X5 Y5 Z0.2 F600', 'M204 S1000', 'G1 E-0.8 F2100', 'G1 Z0.6 F600',
  'M204 S4000', 'G1 X20 Y20 F9000', 'G1 Z0.2 F600', 'G1 E0.8 F1800',
  'M204 S300', 'G1 F1200',
].join('\n'));

// Independent linear replay. Deliberately does not import the interpreter's
// state/acceleration helpers. Unknown physical startup XY stays unknown.
function replay(source: string, flavor: string) {
  const state = { x: NaN, y: NaN, z: NaN, e: 0, f: NaN, debt: 0, xyzAbsolute: true, relativeE: false,
    print: null as number | null, travel: null as number | null, retract: null as number | null,
    type: 'Custom', width: 0.48, height: 0.2 };
  let saved: Pick<typeof state, 'e' | 'f' | 'xyzAbsolute' | 'relativeE'> | undefined;
  const movements: { x: number; y: number; z: number; fromZ: number; e: number; f: number; debt: number }[] = [];
  for (const line of source.split(/\r\n|\n|\r/)) {
    if (line.startsWith(';TYPE:')) state.type = line.slice(6);
    if (line.startsWith(';WIDTH:')) state.width = Number(line.slice(7));
    if (line.startsWith(';HEIGHT:')) state.height = Number(line.slice(8));
    const [cmd, ...words] = line.split(';')[0].trim().split(/\s+/);
    const a = Object.fromEntries(words.map(word => [word[0], Number(word.slice(1))]));
    if (cmd === 'SAVE_GCODE_STATE') saved = { e: state.e, f: state.f, xyzAbsolute: state.xyzAbsolute, relativeE: state.relativeE };
    if (cmd === 'RESTORE_GCODE_STATE' && saved) Object.assign(state, saved);
    if (cmd === 'G90') state.xyzAbsolute = true;
    if (cmd === 'G91') state.xyzAbsolute = false;
    if (cmd === 'M83') state.relativeE = true;
    if (cmd === 'M82') state.relativeE = false;
    if (cmd === 'G92' && 'E' in a) state.e = a.E;
    if (cmd === 'M204') {
      if (flavor === 'klipper') {
        if ('S' in a) state.print = state.travel = a.S;
        else if ('P' in a && 'T' in a) state.print = state.travel = Math.min(a.P, a.T);
      } else {
        if ('S' in a) state.print = state.travel = a.S;
        if ('P' in a) state.print = a.P;
        if ('T' in a) state.travel = a.T;
        if ('R' in a) state.retract = a.R;
      }
    }
    if (cmd === 'SET_VELOCITY_LIMIT') {
      const accel = words.find(word => word.startsWith('ACCEL='));
      if (accel) state.print = state.travel = Number(accel.slice(6));
    }
    if (cmd !== 'G0' && cmd !== 'G1') continue;
    const fromZ = state.z;
    if ('X' in a) state.x = (state.xyzAbsolute ? 0 : state.x) + a.X;
    if ('Y' in a) state.y = (state.xyzAbsolute ? 0 : state.y) + a.Y;
    if ('Z' in a) state.z = (state.xyzAbsolute ? 0 : state.z) + a.Z;
    if ('F' in a) state.f = a.F;
    const de = 'E' in a ? a.E - (state.relativeE ? 0 : state.e) : 0;
    state.e += de;
    state.debt = Math.max(0, state.debt - de);
    if (['X', 'Y', 'Z', 'E'].some(key => key in a)) movements.push({ x: state.x, y: state.y, z: state.z, fromZ, e: de, f: state.f, debt: state.debt });
  }
  return { state, movements };
}

function prepare(source: string, mode: ExportMode = 'standard', lift = 0.4) {
  const job = parseGcode(source);
  expect(exportBlockers(job, mode)).toEqual([]);
  const brim = generateBrim(buildFootprint(job), job, { ...DEFAULT_BRIM, travelLift: lift });
  const added = createInsertion(job, brim, mode), bytes = new TextEncoder().encode(source);
  const prefix = new TextDecoder().decode(bytes.slice(0, job.insertion!.byteOffset));
  const modelPrefix = source.split(/\r\n|\n|\r/).slice(0, job.insertion!.modelLine - 1).join('\n') + '\n';
  // Normalize only in this independent oracle; output byte preservation is
  // checked separately against the exact original buffer.
  const continuation = source.split(/\r\n|\n|\r/).slice(job.insertion!.line - 1, job.insertion!.modelLine - 1).join('\n') + '\n';
  const original = replay(modelPrefix, job.flavor).state;
  const after = replay(prefix + added, job.flavor);
  const resumed = replay(prefix + added + continuation, job.flavor).state;
  expect(resumed).toEqual({ ...original, e: resumed.e, debt: expect.closeTo(original.debt, 8) });
  if (mode === 'klipper') expect(resumed.e).toBeCloseTo(original.e, 8);
  expect(added).not.toMatch(forbidden);
  expect(added).not.toMatch(/NaN|Infinity/);
  return { job, brim, added, after, prefix, bytes };
}

describe('insertion planning and original continuation', () => {
  it('inserts in the included sample before XY positioning, reusing its lift and retraction', () => {
    const { job, added, after } = prepare(sample);
    expect(job.insertion).toMatchObject({ kind: 'travel', line: 31, modelLine: 37, printZ: 0.2,
      state: { z: 0.6, retracted: 0.8 }, handoff: { x: 42.478, y: 37.52, z: 0.6, retracted: 0.8 } });
    expect(Number.isNaN(job.insertion!.state.x)).toBe(true);
    const entry = added.split('; BRIM_TRAVEL')[1].split('; BRIM_STEP')[0];
    expect(entry.trimStart()).toMatch(/^G1 X[\d.]+ Y[\d.]+ F9000\nG1 Z0.2 F600\nG1 E0.8 F1800/);
    expect(after.state).toMatchObject({ z: 0.6, debt: expect.closeTo(0.8, 8) });
    expect(added.slice(added.indexOf('; BRIM_HANDOFF'))).not.toMatch(/^G1 .*\b[XY]/m);
    expect(added).not.toMatch(/^M204/m); // unknown firmware acceleration is inherited
  });

  for (const mode of ['standard', 'klipper'] as const) {
    it(`uses lookahead and leaves original approach settings to resume (${mode})`, () => {
      const { job, added } = prepare(approachSource(), mode);
      expect(job.insertion).toMatchObject({ kind: 'travel', modelFeed: 1200, nextMoveFeed: 9000,
        acceleration: { print: 300, travel: 4000 } });
      expect(added).toContain('M204 S300');
      expect(added).toContain('M204 S4000');
      expect(added).not.toMatch(/^G1 F/m);
    });

    it(`restores settings needed before a later original reset (${mode})`, () => {
      const source = approachSource().replace('M204 S4000\n', 'G1 F720\n').replace('G1 X20 Y20 F9000', 'G1 X20 Y20');
      const { job, added, after } = prepare(source, mode);
      expect(job.insertion!.nextMoveFeed).toBeNull();
      expect(job.insertion!.acceleration.restore).toMatchObject({ print: 1000, travel: 1000 });
      expect(after.state).toMatchObject({ f: 720, print: 1000, travel: 1000 });
      if (mode === 'standard') expect(added).toMatch(/^G1 F720$/m);
    });
  }

  for (const amount of [0, 0.3, 0.8, 1.2]) it(`balances an existing ${amount} mm retraction without double priming`, () => {
    const source = approachSource().replace('G1 E-0.8', `G1 E-${amount}`).replace('G1 E0.8', `G1 E${amount}`);
    const { after } = prepare(source);
    expect(after.state.debt).toBeCloseTo(amount, 8);
  });

  for (const lift of [0, 0.1, 0.4, 1]) it(`handles a ${lift} mm brim lift with the original combined XYZ approach`, () => {
    const source = approachSource().replace('G1 Z0.6 F600\n', '').replace('G1 X20 Y20 F9000', 'G1 X20 Y20 Z0.998 F9000');
    const { job, after } = prepare(source, 'standard', lift);
    expect(job.insertion).toMatchObject({ kind: 'travel', handoff: { z: 0.998 } });
    expect(after.state.z).toBe(0.998);
    const exit = after.movements.at(-1)!;
    if (lift > 0.798) {
      expect(after.state).toMatchObject({ x: 20, y: 20 });
      expect(exit.fromZ).toBe(1.2); // XY finishes at clearance before lowering
    }
  });

  it('retains required source heights even when brim lift is disabled', () => {
    const { after } = prepare(sample, 'standard', 0);
    expect(after.state.z).toBe(0.6);
  });

  it('tracks separate Marlin acceleration fields and never changes retract acceleration', () => {
    const source = approachSource().replace('gcode_flavor = klipper', 'gcode_flavor = marlin2')
      .replace('M204 S1000', 'M204 P1000 T1500 R700').replace('M204 S4000', 'M204 T4000').replace('M204 S300', 'M204 P300');
    const { job, added, after } = prepare(source);
    expect(job.insertion!.kind).toBe('travel');
    expect(added).toContain('M204 P300');
    expect(added).toContain('M204 T4000');
    expect(added).not.toMatch(/^M204 .*\b[RS]/m);
    expect(after.state.retract).toBe(700);
  });

  it('honors Klipper P/T semantics instead of treating them as independent settings', () => {
    const source = approachSource().replace('M204 S4000', 'M204 P6000 T4000').replace('M204 S300', 'M204 P300 T900');
    const { job } = prepare(source);
    expect(job.insertion!.acceleration).toMatchObject({ print: 300, travel: 4000 });
    const onlyP = prepare(source.replace('M204 P300 T900', 'M204 P300'));
    expect(onlyP.job.insertion!.acceleration.print).toBe(4000);
  });

  it('uses an explicit first-layer acceleration without treating footer machine limits as runtime state', () => {
    const { job } = prepare(approachSource() + '; first_layer_acceleration = 250\n; machine_max_acceleration_travel = 9999\n');
    expect(job.insertion!.acceleration).toMatchObject({ print: 250, travel: 4000 });
  });

  it('falls back when an unknown acceleration would need restoration', () => {
    const source = approachSource().replace('M204 S1000\n', '').replace('M204 S4000\n', '');
    const { job } = prepare(source);
    expect(job.insertion!.kind).toBe('model');
    expect(job.insertion!.reason).toMatch(/Acceleration.*unknown/);
  });

  it('tracks a preceding Klipper ACCEL limit without emitting velocity-limit commands', () => {
    const source = approachSource().replace('M204 S1000', 'SET_VELOCITY_LIMIT ACCEL=1400 SQUARE_CORNER_VELOCITY=5').replace('M204 S4000\n', '');
    const { job, after } = prepare(source);
    expect(job.insertion!.acceleration.travel).toBe(1400);
    expect(after.state.travel).toBe(1400);
  });

  it('invalidates acceleration hidden by a startup macro or an ambiguous ACCEL value', () => {
    const source = approachSource().replace('M204 S1000\n', '').replace('M204 S4000\n', '');
    const macro = source.replace('G21\n', 'M204 S1000\nPRINT_START\nG21\n');
    expect(parseGcode(macro).insertion!.kind).toBe('model');
    for (const value of ['{printer.toolhead.max_accel}', '1000 ACCEL=2000', '9'.repeat(320)]) {
      const changed = source.replace('G1 E-0.8', `SET_VELOCITY_LIMIT ACCEL=${value}\nG1 E-0.8`);
      expect(parseGcode(changed).insertion!.kind).toBe('model');
    }
  });

  for (const command of ['M107', 'M104 S205', 'M221 S97', 'M220 S95', 'M205 X8 Y8', 'SET_PRESSURE_ADVANCE ADVANCE=0.04']) {
    it(`keeps ${command} in place without copying it into generated code`, () => {
      const source = approachSource().replace('G1 Z0.2 F600\n', `G1 Z0.2 F600\n${command}\n`);
      const { job } = prepare(source);
      expect(job.insertion!.kind).toBe('model');
    });
  }

  for (const move of ['G1 X20 F9000', 'G1 X20 Y20 E0 F9000']) it(`falls back for unsupported approach: ${move}`, () => {
    const { job } = prepare(approachSource().replace('G1 X20 Y20 F9000', move));
    expect(job.insertion!.kind).toBe('model');
  });

  it('does not mistake a feed in a comment for an original feed assignment', () => {
    const { job } = prepare(approachSource().replace('G1 X20 Y20 F9000', 'G1 X20 Y20 ; F9000'));
    expect(job.insertion!.nextMoveFeed).toBeNull();
  });

  it('preserves every source byte at the earlier boundary for all supported line endings', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = '\uFEFF' + approachSource().trimEnd().replaceAll('\n', newline);
      const { job, brim, bytes } = prepare(source);
      const output = exportBytes(bytes, job, brim), offset = job.insertion!.byteOffset;
      expect(output.slice(0, offset)).toEqual(bytes.slice(0, offset));
      expect(output.slice(offset + output.length - bytes.length)).toEqual(bytes.slice(offset));
    }
  });

  for (const command of ['M204 SNaN', 'M204 S4000 S300', 'M204 S4000 M107', 'M204 P-3', 'M204 S0']) {
    it(`rejects ambiguous acceleration instead of guessing: ${command}`, () => {
      expect(exportBlockers(parseGcode(approachSource().replace('M204 S4000', command))).length).toBeGreaterThan(0);
    });
  }
});
