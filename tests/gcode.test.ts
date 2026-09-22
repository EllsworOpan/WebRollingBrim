import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGcode, arcPoints } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, exportBytes } from '../src/core/export';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

/** Independent, deliberately small modal replay oracle for the insertion contract. */
function replay(source: string) {
  let x = 0, y = 0, z = 0, e = 0, f = 0, xyzAbs = true, eAbs = true;
  let saved: { e: number; f: number; xyzAbs: boolean; eAbs: boolean } | null = null;
  for (const line of source.split(/\r\n|\n|\r/)) {
    const tokens = line.split(';')[0].trim().split(/\s+/), cmd = tokens.shift();
    const args = Object.fromEntries(tokens.map(token => [token[0], Number(token.slice(1))]));
    if (cmd === 'SAVE_GCODE_STATE') saved = { e, f, xyzAbs, eAbs };
    if (cmd === 'RESTORE_GCODE_STATE' && saved) ({ e, f, xyzAbs, eAbs } = saved);
    if (cmd === 'G90') xyzAbs = true; if (cmd === 'G91') xyzAbs = false;
    if (cmd === 'M82') eAbs = true; if (cmd === 'M83') eAbs = false;
    if (cmd === 'G92' && 'E' in args) e = args.E;
    if (cmd !== 'G0' && cmd !== 'G1') continue;
    if ('X' in args) x = (xyzAbs ? 0 : x) + args.X;
    if ('Y' in args) y = (xyzAbs ? 0 : y) + args.Y;
    if ('Z' in args) z = (xyzAbs ? 0 : z) + args.Z;
    if ('E' in args) e = (eAbs ? 0 : e) + args.E;
    if ('F' in args) f = args.F;
  }
  return { x, y, z, e, f, xyzAbs, eAbs };
}

describe('G-code preservation and state', () => {
  it('standard mode preserves motion state and subsequent relative extrusion without resetting E', () => {
    const source = fixtureSource(), job = parseGcode(source);
    expect(job.blockers).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    const prefix = new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset));
    const original = replay(prefix), modified = replay(prefix + added);
    expect(modified).toEqual({ ...original, e: modified.e });
    expect(modified.e).toBeGreaterThan(original.e);
    const next = '\nG1 X40 Y20 E1';
    expect(replay(prefix + added + next).e - modified.e).toBeCloseTo(replay(prefix + next).e - original.e, 8);
    expect(added).not.toMatch(/G92|SAVE_GCODE_STATE|RESTORE_GCODE_STATE/);
    expect(added).toContain(';TYPE:External perimeter');
    expect(added).not.toMatch(/NaN|Infinity/);
  });

  it('preserves every byte, including UTF-8, BOM, CRLF and an unterminated last line', () => {
    const source = '\uFEFF' + fixtureSource().trimEnd().replaceAll('\n', '\r\n');
    const original = new TextEncoder().encode(source), job = parseGcode(source);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const output = exportBytes(original, job, brim), offset = job.insertion!.byteOffset;
    const length = output.byteLength - original.byteLength;
    const restored = new Uint8Array(original.length);
    restored.set(output.slice(0, offset)); restored.set(output.slice(offset + length), offset);
    expect(restored).toEqual(original);
    expect(new TextDecoder().decode(output.slice(offset, offset + length))).not.toMatch(/(?<!\r)\n/);
  });

  it('only changes modal feed when needed and never reasserts the established modes', () => {
    const job = parseGcode(fixtureSource()), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    for (const mode of ['standard', 'klipper'] as const) {
      const added = createInsertion(job, brim, mode);
      expect(added).not.toMatch(/^(G90|G91|M82|M83|G92)\b/m);
      let feed = job.insertion!.state.f;
      const position: Record<string, number> = { X: job.insertion!.state.x, Y: job.insertion!.state.y, Z: job.insertion!.state.z };
      for (const line of added.split('\n').filter(line => line.startsWith('G1 '))) {
        for (const [, axis, raw] of line.matchAll(/\b([XYZF])([-\d.]+)/g)) {
          const value = Number(raw);
          if (axis === 'F') { expect(value).not.toBe(feed); feed = value; }
          else { expect(value).not.toBe(position[axis]); position[axis] = value; }
        }
      }
      const feedOnly = added.split('\n').filter(line => /^G1 F/.test(line));
      expect(feedOnly).toEqual(mode === 'standard' ? [`G1 F${job.insertion!.state.f}`] : []);
      expect(added).toContain('; ROLLING_BRIM_BEGIN');
      expect(added).toContain('; ROLLING_BRIM_END');
    }
  });

  for (const next of ['G1 X40 Y20 E1 F950', 'G1 X40 Y20 E1 F1200', 'G1X40Y20E1F950']) {
    it(`leaves the next original move to set its own feed: ${next}`, () => {
      const source = fixtureSource().replace('G1 X40 Y20 E1', next);
      const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
      const expectedFeed = next.endsWith('1200') ? 1200 : 950;
      expect(job.insertion!.state.f).toBe(1200);
      expect(job.insertion!.nextMoveFeed).toBe(expectedFeed);
      const added = createInsertion(job, brim);
      expect(added).not.toMatch(/^G1 F/m);
      const offset = job.insertion!.byteOffset, originalBytes = new TextEncoder().encode(source);
      const prefix = new TextDecoder().decode(originalBytes.slice(0, offset));
      // Canonical spelling of the same original command lets the independent
      // replay oracle check both spaced and compact input without sharing parsing code.
      const continuation = `G1 X40 Y20 E1 F${expectedFeed}\nG1 X40 Y40 E1\n`;
      const afterBrim = replay(prefix + added), original = replay(prefix + continuation);
      const resumed = replay(prefix + added + continuation);
      expect(afterBrim.f).not.toBe(job.insertion!.state.f);
      expect(resumed).toEqual({ ...original, e: resumed.e });
      expect(resumed.f).toBe(expectedFeed);
      expect(resumed.e - afterBrim.e).toBeCloseTo(2, 8);
      const output = exportBytes(originalBytes, job, brim);
      expect(output.slice(0, offset)).toEqual(originalBytes.slice(0, offset));
      expect(output.slice(offset + output.length - originalBytes.length)).toEqual(originalBytes.slice(offset));
    });
  }

  for (const next of ['G1 X40 Y20 E1 ; F950 is only a comment', 'G1 X40 Y20 E1\nG1 F950']) {
    it(`restores the feed when the first resumed motion still needs it: ${next}`, () => {
      const source = fixtureSource().replace('G1 X40 Y20 E1', next);
      const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
      expect(job.insertion!.nextMoveFeed).toBeNull();
      const added = createInsertion(job, brim);
      expect(added).toMatch(/^G1 F1200$/m);
      const prefix = new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset));
      const original = replay(prefix + 'G1 X40 Y20 E1');
      const resumed = replay(prefix + added + 'G1 X40 Y20 E1');
      expect(resumed).toEqual({ ...original, e: resumed.e });
    });
  }

  it('does not treat a zero or negative feed as proof that restoration can be skipped', () => {
    for (const feed of [0, -500]) {
      const job = parseGcode(fixtureSource().replace('G1 X40 Y20 E1', `G1 X40 Y20 E1 F${feed}`));
      expect(job.insertion!.nextMoveFeed).toBeNull();
    }
  });

  it('keeps the optional native snapshot intact when the next move has a feed', () => {
    const source = fixtureSource().replace('G1 X40 Y20 E1', 'G1 X40 Y20 E1 F950');
    const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim, 'klipper');
    expect(added).not.toMatch(/^G1 F/m);
    expect(added).toContain('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
    const prefix = new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset));
    expect(replay(prefix + added)).toEqual(replay(prefix));
    const next = 'G1 X40 Y20 E1 F950';
    expect(replay(prefix + added + next)).toEqual(replay(prefix + next));
  });

  it('omits all feed commands when every motion already uses the active speed, preserving repeated relative actions', () => {
    const source = fixtureSource(), job = parseGcode(source);
    Object.assign(job.settings, { printSpeed: 20, travelSpeed: 20, zSpeed: 20, retractSpeed: 20, unretractSpeed: 20 });
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    expect(added).not.toMatch(/^G1.*\bF/m);
    // Both trips must retract/unretract, even when the commands are identical.
    expect(added.match(/^G1 E-0.8$/gm)).toHaveLength(2);
    expect(added.match(/^G1 E0.8$/gm)).toHaveLength(2);
    const prefix = source.slice(0, source.indexOf('G1 X40'));
    const after = replay(prefix + added);
    expect(after).toEqual({ ...replay(prefix), e: after.e });
  });

  it('skips a stationary entry/return without retracting or lifting and restores precise source coordinates', () => {
    const source = fixtureSource().replace('G1 X20 Y20 Z0.2 F1200', 'G1 X20.123456 Y0.0000001 Z0.2 F1200');
    const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim), prefix = source.slice(0, source.indexOf('G1 X40'));
    const after = replay(prefix + added);
    expect(after).toEqual({ ...replay(prefix), e: after.e });
    expect(added).toContain('Y0.0000001');
    expect(added).not.toMatch(/^G1.*\d[eE][-+]?\d/m);

    const simpleJob = parseGcode(fixtureSource());
    const loop = { ...brim, paths: [[{ x: 20, y: 20 }, { x: 19, y: 20 }, { x: 19, y: 19 }, { x: 20, y: 20 }]], transitions: ['travel'] as const };
    const stationary = createInsertion(simpleJob, { ...loop, transitions: [...loop.transitions] });
    expect(stationary).not.toMatch(/^G1 E-|^G1 Z/m);
    expect(stationary).not.toMatch(/^G1 F/m);
  });

  it('rejects repeat processing, unsupported modes and incomplete metadata', () => {
    expect(parseGcode('; ROLLING_BRIM_BEGIN\n' + fixtureSource()).blockers.join()).toMatch(/already contains/);
    expect(parseGcode(fixtureSource().replace('G21', 'G20')).blockers.join()).toMatch(/Inch/);
    expect(parseGcode(fixtureSource().replace('; gcode_flavor = klipper', '')).blockers.join()).toMatch(/firmware flavor/);
    expect(parseGcode(fixtureSource().replace('G21', 'M200 D1.75')).blockers.join()).toMatch(/Volumetric/);
  });

  it('restores a Klipper E origin hidden inside a startup macro', () => {
    const source = fixtureSource().replace('G92 E0\n', ''), job = parseGcode(source);
    expect(job.insertion!.state.eKnown).toBe(false);
    expect(job.blockers).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim, 'klipper');
    const prefix = 'G92 E123.45\n' + source.slice(0, source.indexOf('G1 X40'));
    expect(replay(prefix + added)).toEqual(replay(prefix));
    expect(added).not.toContain('G92 E');
    expect(added).toContain('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
  });

  it('rejects absolute model extrusion in both export modes without losing the preview', () => {
    const job = parseGcode(fixtureSource(true));
    expect(job.paths.length).toBeGreaterThan(0);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    expect(() => createInsertion(job, brim)).toThrow(/relative extrusion/i);
    expect(() => createInsertion(job, brim, 'klipper')).toThrow(/relative extrusion/i);
  });

  for (const flavor of ['marlin', 'marlin2']) it(`exports Prusa-style startup and shutdown using only standard commands (${flavor})`, () => {
    const source = fixtureSource()
      .replace('G92 E0\n', 'G28 W\nG80\nG1 X0 Y-3 Z0.2 F1000\nG92 E0\nG1 X60 E9 F1000\nG1 X100 E12.5 F1000\nG92 E0\n')
      .replace(';LAYER_CHANGE\n;Z:0.4\nG1 Z0.4', ';TYPE:Custom\nG1 E-0.8 F2100\nG1 Z10 F600\nM104 S0\nM140 S0\nG28 X0\nM84')
      .replace('gcode_flavor = klipper', `gcode_flavor = ${flavor}\n; printer_model = MK3S`);
    const job = parseGcode(source);
    expect(job.flavor).toBe(flavor);
    expect(job.blockers).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    expect(added).not.toMatch(/SAVE_GCODE_STATE|RESTORE_GCODE_STATE/);
    const commands = added.split('\n').filter(line => line && !line.startsWith(';')).map(line => line.split(' ')[0]);
    expect(commands.every(command => ['G1', 'G90', 'G92', 'M83'].includes(command))).toBe(true);
    const prefix = new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset));
    const after = replay(prefix + added), end = replay(prefix + added + source.slice(prefix.length));
    expect(after).toEqual({ ...replay(prefix), e: after.e });
    expect(end).toEqual({ ...replay(source), e: end.e });
    expect(parseGcode(source.replaceAll('G92 E0\n', '')).blockers).toEqual([]);
    expect(exportBlockers(job, 'klipper').join()).toMatch(/explicitly marked klipper/);
  });

  it('handles compact commands without treating E as a numeric exponent', () => {
    const source = fixtureSource().replace('G1 X40 Y20 E1', 'G1X40Y20E1');
    const job = parseGcode(source);
    expect(job.paths[0].points[1]).toEqual({ x: 40, y: 20 });
  });

  it('does not guess when Prusa and generic Marlin would interpret E mode differently', () => {
    const source = fixtureSource().replace('gcode_flavor = klipper', 'gcode_flavor = marlin');
    expect(parseGcode(source.replace('M83', 'M83\nG90')).blockers.join()).toMatch(/Extrusion mode is ambiguous/);
    expect(parseGcode(source.replace('M83', 'M83\nG90\nM83')).blockers).toEqual([]);
  });

  it('tessellates clockwise, counterclockwise and full-circle XY arcs', () => {
    const arc = arcPoints({ x: 10, y: 0 }, { x: 0, y: 10 }, { I: -10, J: 0 }, false);
    expect(arc.at(-1)).toEqual({ x: 0, y: 10 });
    expect(arc.every(p => Math.abs(Math.hypot(p.x, p.y) - 10) < 0.001)).toBe(true);
    const full = arcPoints({ x: 10, y: 0 }, { x: 10, y: 0 }, { I: -10 }, true);
    expect(full.some(p => p.x < -9.9)).toBe(true);
  });
});

describe('strict insertion and standard-G-code continuation checks', () => {
  const withEnding = (ending: string) => fixtureSource().replace('; prusaslicer_config = begin', `;TYPE:Custom\n${ending}\n; prusaslicer_config = begin`);

  it('takes the snapshot after skirt-specific changes and before the exact first model move', () => {
    const source = fixtureSource().replace(';TYPE:External perimeter', ';TYPE:Skirt/Brim\nG1 X18 Y20 E0.2\nG1 X20 Y20 F1800\nM221 S97\nM204 S500\nG1 F1370\n;TYPE:External perimeter');
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(job.insertion!.state).toMatchObject({ x: 20, y: 20, z: 0.2, f: 1370, absoluteXYZ: true, absoluteE: false, retracted: 0 });
    expect(job.insertion!.byteOffset).toBe(new TextEncoder().encode(source.slice(0, source.indexOf('G1 X40'))).length);
    const added = createInsertion(job, generateBrim(buildFootprint(job), job, DEFAULT_BRIM));
    expect(added).toContain('G1 F1370');
    expect(added).not.toMatch(/M221|M204/);
  });

  it('does not move insertion later when the first model move lacks a known start position', () => {
    const source = fixtureSource().replace('G1 X20 Y20 Z0.2 F1200', 'G1 Z0.2 F1200');
    const job = parseGcode(source);
    expect(job.insertion!.byteOffset).toBe(new TextEncoder().encode(source.slice(0, source.indexOf('G1 X40'))).length);
    expect(job.blockers.join()).toMatch(/XYZ position and feed rate must be known/);
  });

  it('requires millimetres, absolute positioning and an unretracted insertion point', () => {
    expect(parseGcode(fixtureSource().replace('G21\n', '')).blockers.join()).toMatch(/explicit G21/);
    expect(parseGcode(fixtureSource().replace(';WIDTH:0.48', ';WIDTH:0.48\nG91')).blockers.join()).toMatch(/Absolute XYZ/);
    expect(parseGcode(fixtureSource().replace(';WIDTH:0.48', ';WIDTH:0.48\nG1 E-0.8')).blockers.join()).toMatch(/outstanding retraction/);
    expect(parseGcode(fixtureSource().replace('G1 X20 Y20 Z0.2 F1200', 'G1 X20 Y20 Z0.4 F1200')).blockers.join()).toMatch(/already be at first-layer Z/);
  });

  it('does not assume an opaque startup macro preserved the established modes', () => {
    const source = fixtureSource().replace('G92 E0\n', 'PRINT_START\n');
    expect(parseGcode(source).blockers.join()).toMatch(/explicit G21/);
    const restored = source.replace('PRINT_START\n', 'PRINT_START\nG21\nG90\nM83\n');
    expect(exportBlockers(parseGcode(restored))).toEqual([]);
  });

  it('blocks E-dependent continuations in standard mode but allows an eligible Klipper snapshot', () => {
    for (const ending of ['M82\nG1 E100', 'CUSTOM_FINISH', 'SAVE_GCODE_STATE NAME=AFTER_PRINT', 'M810']) {
      const job = parseGcode(withEnding(ending));
      expect(job.blockers).toEqual([]);
      expect(job.standardBlockers.length).toBeGreaterThan(0);
      expect(exportBlockers(job, 'klipper')).toEqual([]);
      const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
      expect(() => createInsertion(job, brim)).toThrow();
      expect(createInsertion(job, brim, 'klipper')).toContain('SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP');
    }
  });

  it('accepts an original E reset before later absolute custom extrusion and restores the same resulting state', () => {
    const source = withEnding('G92 E0\nM82\nG1 E2.5 F400');
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(job.extrusionResetLine).toBeGreaterThan(job.insertion!.line);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const result = new TextDecoder().decode(exportBytes(new TextEncoder().encode(source), job, brim));
    expect(replay(result)).toEqual(replay(source));
    expect(exportBlockers(parseGcode(withEnding('G92 E0\nCUSTOM_FINISH')))).toEqual([]);
  });

  it('checks E use after Marlin positioning-mode changes and permits a subsequent explicit M83', () => {
    const ambiguous = withEnding('G90\nG1 E1').replace('gcode_flavor = klipper', 'gcode_flavor = marlin2');
    expect(parseGcode(ambiguous).standardBlockers.join()).toMatch(/relative extrusion is not established/);
    expect(exportBlockers(parseGcode(ambiguous.replace('G90\nG1 E1', 'G90\nM83\nG1 E1')))).toEqual([]);
  });

  it('protects the native snapshot name without preventing a compatible standard export', () => {
    const source = fixtureSource().replace('G21', 'SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP\nG21');
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(exportBlockers(job, 'klipper').join()).toMatch(/reserved/);
  });
});

describe('explicit brim travel lift', () => {
  it('reads zero and sub-0.4 mm values exactly, including filament overrides', () => {
    expect(parseGcode(fixtureSource().replace('retract_lift = 0.4', 'retract_lift = 0')).settings.zHop).toBe(0);
    expect(parseGcode(fixtureSource().replace('retract_lift = 0.4', 'retract_lift = 0.1')).settings.zHop).toBe(0.1);
    expect(parseGcode(fixtureSource() + '; filament_retract_lift = 0\n').settings.zHop).toBe(0);
    expect(parseGcode(fixtureSource() + '; filament_retract_lift = nil\n').settings.zHop).toBe(0.4);
  });

  it('emits no Z moves at zero and applies the exact selected positive lift without hidden minimums', () => {
    const job = parseGcode(fixtureSource()), context = buildFootprint(job);
    const zero = generateBrim(context, job, { ...DEFAULT_BRIM, travelLift: 0 });
    const small = generateBrim(context, job, { ...DEFAULT_BRIM, travelLift: 0.1 });
    for (const mode of ['standard', 'klipper'] as const) {
      expect(createInsertion(job, zero, mode)).not.toMatch(/^G[01].*\bZ/m);
      const zMoves = [...createInsertion(job, small, mode).matchAll(/^G1 Z([\d.]+)/gm)].map(match => Number(match[1]));
      expect(new Set(zMoves)).toEqual(new Set([0.2, 0.3]));
    }
    expect(small.paths).toEqual(zero.paths);
    expect(small.minutes).toBeGreaterThan(zero.minutes);
    expect(zero.warnings.join()).toMatch(/lift is disabled/);
  });
});

describe('optional local PrusaSlicer fixture', () => {
  it.skipIf(!process.env.ROLLING_BRIM_TEST_GCODE)('generates a brim for a private file and preserves its original bytes', () => {
    const bytes = readFileSync(process.env.ROLLING_BRIM_TEST_GCODE!);
    const start = performance.now();
    const job = parseGcode(bytes.toString('utf8'), 'private-sample.gcode', bytes.byteLength);
    expect(job.layerCount).toBeGreaterThan(0);
    expect(job.blockers).toEqual([]);
    expect(job.standardBlockers).toEqual([]);
    expect(job.insertion).not.toBeNull();
    const context = buildFootprint(job);
    const brim = generateBrim(context, job, DEFAULT_BRIM);
    expect(brim.paths.length).toBeGreaterThan(0);
    expect(brim.length).toBeGreaterThan(100);
    const output = exportBytes(bytes, job, brim), offset = job.insertion!.byteOffset;
    expect(createInsertion(job, brim)).not.toMatch(/SAVE_GCODE_STATE|RESTORE_GCODE_STATE|G92 E/);
    expect(Buffer.from(output.slice(0, offset)).equals(bytes.subarray(0, offset))).toBe(true);
    expect(Buffer.from(output.slice(offset + output.length - bytes.length)).equals(bytes.subarray(offset))).toBe(true);
    console.info(JSON.stringify({ sampleMs: Math.round(performance.now() - start), islands: context.islands.length, brimPaths: brim.paths.length, brimMm: Math.round(brim.length), unserved: brim.unserved.length, regionCounts: brim.regions }));
  });
});

describe('large generated program', () => {
  it('checks a 400,000-move file without retaining later layers in the footprint', () => {
    const base = fixtureSource();
    const secondLayer = base.indexOf(';LAYER_CHANGE', base.indexOf(';LAYER_CHANGE') + 1);
    const prefix = base.slice(0, secondLayer);
    const footer = base.slice(base.indexOf('; prusaslicer_config = begin'));
    const moves = 'G1 X40 Y20 E0.001\nG1 X40 Y40 E0.001\nG1 X20 Y40 E0.001\nG1 X20 Y20 E0.001\n'.repeat(1000);
    const layers = Array.from({ length: 100 }, (_, i) => {
      const z = ((i + 2) * 0.2).toFixed(1);
      return `;LAYER_CHANGE\n;Z:${z}\nG92 E0\nG1 Z${z}\n${moves}`;
    }).join('');
    const source = prefix + layers + footer, bytes = new TextEncoder().encode(source);
    const job = parseGcode(source);
    expect(job.lineCount).toBeGreaterThan(400_000);
    expect(job.layerCount).toBe(101);
    expect(job.paths).toEqual(parseGcode(base).paths);
    expect(exportBlockers(job)).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const result = exportBytes(bytes, job, brim), offset = job.insertion!.byteOffset;
    expect(Buffer.from(result.slice(0, offset)).equals(Buffer.from(bytes.slice(0, offset)))).toBe(true);
    expect(Buffer.from(result.slice(offset + result.length - bytes.length)).equals(Buffer.from(bytes.slice(offset)))).toBe(true);
  });
});
