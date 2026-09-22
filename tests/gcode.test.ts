import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGcode, arcPoints } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBytes } from '../src/core/export';
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
  for (const absolute of [false, true]) it(`restores all changed state with ${absolute ? 'absolute' : 'relative'} extrusion`, () => {
    const source = fixtureSource(absolute), job = parseGcode(source);
    expect(job.blockers).toEqual([]);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    const prefix = new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset));
    expect(replay(prefix + added)).toEqual(replay(prefix));
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
    const added = createInsertion(job, brim);
    const prefix = 'G92 E123.45\n' + source.slice(0, source.indexOf('G1 X40'));
    expect(replay(prefix + added)).toEqual(replay(prefix));
    expect(added).not.toContain('G92 E');
    expect(added).toContain('RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0');
  });

  it('restores Marlin coordinate and extrusion modes in the right order', () => {
    const source = fixtureSource(true).replace('gcode_flavor = klipper', 'gcode_flavor = marlin2');
    const job = parseGcode(source), brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    const prefix = source.slice(0, source.indexOf('G1 X40'));
    expect(replay(prefix + added)).toEqual(replay(prefix));
    expect(added).toContain('G90\nM82\nG1 F1200');
    expect(added).not.toMatch(/SAVE_GCODE_STATE|RESTORE_GCODE_STATE/);
    expect(parseGcode(source.replace('G92 E0\n', '')).blockers.join()).toMatch(/G92 E reference/);
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
    expect(replay(prefix + added)).toEqual(replay(prefix));
    expect(replay(prefix + added + source.slice(prefix.length))).toEqual(replay(source));
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

describe('provided PrusaSlicer flexi-print fixture', () => {
  it('parses 62 real layers, generates a brim and leaves the original program intact', () => {
    const bytes = readFileSync(new URL('../examples/gcodes/Lagarto_v5.1_0.2mm_PLA_V2_1h7m.gcode', import.meta.url));
    const start = performance.now();
    const job = parseGcode(bytes.toString('utf8'), 'Lagarto.gcode', bytes.byteLength);
    expect(job.layerCount).toBe(62);
    expect(job.blockers).toEqual([]);
    expect(job.settings.lineWidth).toBe(0.48);
    expect(job.paths.some(path => path.width > 0.6)).toBe(true);
    expect(job.insertion!.state.type).toBe('External perimeter');
    const context = buildFootprint(job);
    const brim = generateBrim(context, job, DEFAULT_BRIM);
    expect(brim.paths.length).toBeGreaterThan(0);
    expect(brim.length).toBeGreaterThan(100);
    const output = exportBytes(bytes, job, brim), offset = job.insertion!.byteOffset;
    expect(Buffer.from(output.slice(0, offset)).equals(bytes.subarray(0, offset))).toBe(true);
    expect(Buffer.from(output.slice(offset + output.length - bytes.length)).equals(bytes.subarray(offset))).toBe(true);
    console.info(JSON.stringify({ sampleMs: Math.round(performance.now() - start), islands: context.islands.length, brimPaths: brim.paths.length, brimMm: Math.round(brim.length), unserved: brim.unserved.length, regionCounts: brim.regions }));
  });
});
