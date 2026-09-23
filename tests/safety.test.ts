import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/core/gcode';
import { exportBlockers, createInsertion } from '../src/core/export';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

describe('conservative export eligibility', () => {
  for (const move of [
    'G1 X40 Y20 E1 (X90)', 'G1 X40 Y20 E1 G91', 'G1 X40 X90 Y20 E1',
    'G1 X40 Y20 E1 F900 F0', 'G1 X40 Y20 E1 FNaN', 'G1 X40 Y20 E1 F0',
    'G1 X40 Y20 E1 X', 'G1 X40.2.3 Y20 E1', 'G1 X40 Y20 E1 A5',
    'G1 X40 Y20 E1 F' + '9'.repeat(320),
  ]) it(`blocks ambiguous motion: ${move.slice(0, 60)}`, () => {
    const job = parseGcode(fixtureSource().replace('G1 X40 Y20 E1', move));
    for (const mode of ['standard', 'klipper'] as const) expect(exportBlockers(job, mode).join()).toMatch(/syntax|feed rates/);
  });

  for (const command of ['G5 X50 Y30 I1 J1 P1 Q1 E1', 'M206 X5', 'G29', 'G2 X40 Y20 I10 J0 R10 E1', 'G2 X40 Y20 I10 J0 P2 E1']) {
    it(`rejects unmodelled first-layer behavior even after an original E reset: ${command}`, () => {
      const source = fixtureSource().replace('G1 X40 Y40 E1', `G92 E0\n${command}\nG1 X40 Y40 E1`);
      const job = parseGcode(source);
      for (const mode of ['standard', 'klipper'] as const) expect(exportBlockers(job, mode).length).toBeGreaterThan(0);
    });
  }

  it('does not let a Custom feature label hide unknown numeric first-layer motion', () => {
    const job = parseGcode(fixtureSource().replace('G1 X40 Y40 E1', ';TYPE:Custom\nG5 X50 Y30 E1\n;TYPE:External perimeter\nG1 X40 Y40 E1'));
    expect(job.blockers.join()).toMatch(/geometry recovery/);
  });

  for (const [key, value] of [
    ['filament_diameter', 'garbage'], ['extrusion_multiplier', '1.2junk'],
    ['travel_speed', 'Infinity'], ['retract_speed', ''], ['first_layer_height', '20junk%'],
    ['first_layer_extrusion_width', 'nil'], ['filament_retract_length', 'NaN'],
  ]) it(`does not silently default a corrupt ${key}`, () => {
    const job = parseGcode(fixtureSource() + `; ${key} = ${value}\n`);
    expect(job.blockers.join()).toMatch(new RegExp(`invalid numeric setting: ${key}`));
  });

  it('retains legitimate percentage, automatic-width, and inherited filament settings', () => {
    const source = fixtureSource() + '; first_layer_height = 100%\n; layer_height = 0.2\n; first_layer_extrusion_width = 240%\n; first_layer_speed = 50%\n; perimeter_speed = 40\n; filament_retract_length = nil\n';
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(job.settings).toMatchObject({ layerHeight: 0.2, lineWidth: 0.48, printSpeed: 20, retractLength: 0.8 });
    expect(parseGcode(source + '; first_layer_extrusion_width = 0\n').blockers).toEqual([]);
  });

  for (const bed of ['0x0,200x0,broken,200x200,0x200', '0x0,0x0,200x200', '0x0,200x200,200x0,0x200', '0x0,100x0,200x0', '0x0,200x0,200x200,x200']) {
    it(`rejects invalid bed geometry: ${bed}`, () => {
      expect(parseGcode(fixtureSource() + `; bed_shape = ${bed}\n`).blockers.join()).toMatch(/usable bed shape/);
    });
  }

  it('blocks explicit persistent coordinate transforms despite later position commands', () => {
    const source = fixtureSource().replace('G21', 'SET_GCODE_OFFSET X=20\nG21');
    const job = parseGcode(source);
    expect(job.insertion!.state.x).toBe(20);
    expect(job.blockers.join()).toMatch(/transforms/);
  });

  it('blocks invalid first-layer annotations and compact numbered/checksummed input', () => {
    expect(parseGcode(fixtureSource().replace(';WIDTH:0.48', ';WIDTH:Infinity')).blockers.join()).toMatch(/WIDTH/);
    expect(parseGcode(fixtureSource().replace(';HEIGHT:0.2', ';HEIGHT:bad')).blockers.join()).toMatch(/HEIGHT/);
    expect(parseGcode(fixtureSource().replace('G1 X40 Y20 E1', 'N17G1 X40 Y20 E1*20 ; note')).blockers.join()).toMatch(/Numbered/);
  });

  it('enforces shared blockers at export rather than relying on disabled UI controls', () => {
    const valid = parseGcode(fixtureSource()), brim = generateBrim(buildFootprint(valid), valid, DEFAULT_BRIM);
    const invalid = parseGcode(fixtureSource() + '; filament_diameter = broken\n');
    for (const mode of ['standard', 'klipper'] as const) expect(() => createInsertion(invalid, brim, mode)).toThrow(/invalid numeric/);
  });

  it('lifts from the exact saved nozzle height and checks the configured Z limit', () => {
    const job = parseGcode(fixtureSource().replace('G1 X20 Y20 Z0.2 F1200', 'G1 X20 Y20 Z0.201 F1200') + '; max_print_height = 20\n');
    expect(exportBlockers(job)).toEqual([]);
    const geometry = buildFootprint(job), brim = generateBrim(geometry, job, DEFAULT_BRIM);
    const added = createInsertion(job, brim);
    expect(added).toContain('G1 Z0.601');
    expect(added).toContain('G1 Z0.201');
    expect(() => generateBrim(geometry, job, { ...DEFAULT_BRIM, travelLift: 20 })).toThrow(/maximum print height/);
    expect(() => createInsertion(job, { ...brim, settings: { ...brim.settings, travelLift: 20 } })).toThrow(/maximum print height/);
    expect(parseGcode(fixtureSource() + '; max_print_height = 0\n').blockers.join()).toMatch(/maximum print height/);
  });
});
