import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, exportBytes, hardExportBlockers } from '../src/core/export';
import { assertReviewAccepted, prepareExport } from '../src/core/export-review';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

const encode = (source: string) => new TextEncoder().encode(source);
const brimFor = (source: string) => {
  const job = parseGcode(source);
  return { job, brim: generateBrim(buildFootprint(job), job, DEFAULT_BRIM) };
};
const restartSource = (retract: number, restart: number, fallback = false) => fixtureSource()
  .replace(';LAYER_CHANGE', `G1 X5 Y5 Z0.6 F9000\nG1 E-${retract} F2100\n;LAYER_CHANGE`)
  .replace('G1 X20 Y20 Z0.2 F1200', `G1 X20 Y20 F9000\nG1 Z0.2 F600\nG1 E${restart} F1800${fallback ? '\nM107' : ''}`)
  .replace('G1 X40 Y20 E1', 'G1 X40 Y20 E0.01');

// Independent relative-E replay of physical retract balance. The logical E
// coordinate may change by the brim's deposition; its retraction must not.
function debtAfter(source: string) {
  let debt = 0;
  for (const line of source.split('\n')) {
    if (!/^G[01]\s/.test(line)) continue;
    const e = line.split(';')[0].match(/\bE([-+\d.]+)/)?.[1];
    if (e !== undefined) debt = Math.max(0, debt - Number(e));
  }
  return debt;
}

describe('reviewable export concerns', () => {
  it('keeps inherited settings in the source and out of the generated block', () => {
    const source = fixtureSource().replace('gcode_flavor = klipper', 'gcode_flavor = marlin2')
      .replace('G21', 'M591 S0\nM906 P1\nM906 P0\nG21');
    const { job, brim } = brimFor(source);
    expect(job.concerns).toEqual([]);
    expect(exportBlockers(job)).toEqual([]);
    expect(createInsertion(job, brim)).not.toMatch(/M591|M906/);
  });

  it('requires exact, individual acceptance at every export entry point', () => {
    const source = fixtureSource().replace('G21', 'M573 R\nM574 S0 V35 T260 F6\nG21');
    const { job, brim } = brimFor(source), file = new File([source], 'part.gcode');
    const ids = job.concerns.map(issue => issue.id);
    expect(hardExportBlockers(job)).toEqual([]);
    expect(job.concerns.map(issue => issue.line)).toEqual([3, 4]);
    for (const accepted of [[], ['all'], ids.slice(0, 1)]) {
      expect(exportBlockers(job, 'standard', accepted)).not.toEqual([]);
      expect(() => createInsertion(job, brim, 'standard', accepted)).toThrow(/acceptance/);
      expect(() => exportBytes(encode(source), job, brim, 'standard', accepted)).toThrow(/acceptance/);
      expect(() => prepareExport(file, job, brim, 'standard', accepted)).toThrow(/acceptance/);
    }
    const review = prepareExport(file, job, brim, 'standard', ids);
    expect(() => assertReviewAccepted(review, [])).toThrow(/confirm/);
    expect(() => assertReviewAccepted(review, ids)).not.toThrow();
    expect(review.concerns).toEqual(job.concerns);
    expect(review.concerns).not.toBe(job.concerns);
    expect(createInsertion(job, brim, 'standard', ids)).not.toMatch(/M573|M574/);
    // Preparing another file never carries acceptance into that file's export.
    const next = brimFor(source.replace('M573 R', 'M573 S1'));
    expect(() => createInsertion(next.job, next.brim, 'standard', ids)).toThrow(/acceptance/);
  });

  for (const command of ['G20', 'M206 X5', 'M92 E90', 'M501', 'G10', 'G54']) {
    it(`cannot override units, transforms or unsupported extrusion: ${command}`, () => {
      const source = fixtureSource().replace('G21', `M573 R\n${command}\nG21`);
      const { job, brim } = brimFor(source), ids = job.concerns.map(issue => issue.id);
      expect(hardExportBlockers(job).length).toBeGreaterThan(0);
      expect(() => createInsertion(job, brim, 'standard', ids)).toThrow();
    });
  }

  it('cannot override absent units, missing geometry or a missing insertion point', () => {
    for (const source of [fixtureSource().replace('G21', 'M573 R'), fixtureSource().replace(/;TYPE:External perimeter/, ';TYPE:Custom')]) {
      const job = parseGcode(source), valid = brimFor(fixtureSource());
      expect(() => createInsertion(job, valid.brim, 'standard', job.concerns.map(issue => issue.id))).toThrow();
    }
  });

  for (const routine of ['G12 S91', 'G427 R2 P3']) {
    it(`recovers position and modes after opaque startup ${routine}, independent of printer identity`, () => {
      const source = fixtureSource().replace('G21', `G1 X90 Y90 Z90 F600\n${routine}\nG21`) + '; printer_model = GENERIC\n';
      const { job, brim } = brimFor(source);
      expect(hardExportBlockers(job)).toEqual([]);
      expect(job.concerns).toHaveLength(1);
      expect(job.insertion!.modelState).toMatchObject({ x: 20, y: 20, z: 0.2, f: 1200 });
      expect(createInsertion(job, brim, 'standard', job.concerns.map(issue => issue.id))).not.toContain(routine);
      const unknown = parseGcode(source.replace('G1 X20 Y20 Z0.2 F1200', 'G1 Z0.2 F1200'));
      expect(exportBlockers(unknown, 'standard', unknown.concerns.map(issue => issue.id)).join()).toMatch(/XYZ position/);
      const modes = parseGcode(source.replace(`${routine}\nG21`, `G21\n${routine}`));
      expect(exportBlockers(modes, 'standard', modes.concerns.map(issue => issue.id)).join()).toMatch(/explicit G21/);
    });
  }

  it('does not assume an unfamiliar startup command preserved acceleration', () => {
    const source = fixtureSource().replace('G21', 'M204 S900\nM573 R\nG21');
    const { job, brim } = brimFor(source);
    expect(job.insertion!.state.acceleration.print).toBeNull();
    expect(createInsertion(job, brim, 'standard', job.concerns.map(issue => issue.id))).not.toContain('M204');
    const recovered = brimFor(source.replace('M573 R\n', 'M573 R\nM204 S700\n'));
    expect(recovered.job.insertion!.state.acceleration.print).toBe(700);
  });

  it('does not downgrade unmodelled commands in model geometry', () => {
    const job = parseGcode(fixtureSource().replace('G1 X40 Y40 E1', 'G12 S91\nM573 R\nG1 X40 Y40 E1'));
    expect(hardExportBlockers(job).join()).toMatch(/geometry recovery/);
  });

  for (const [retract, restart] of [[0.84, 0.8], [1.27, 1.1], [2.6, 0.6]]) for (const fallback of [false, true]) {
    it(`preserves measured startup difference ${retract} - ${restart}, fallback=${fallback}`, () => {
      const source = restartSource(retract, restart, fallback);
      const { job, brim } = brimFor(source);
      expect(hardExportBlockers(job)).toEqual([]);
      expect(job.concerns).toHaveLength(1);
      expect(job.concerns[0].message).toContain(`${Number((retract - restart).toFixed(7))} mm difference`);
      expect(job.paths[0].points.slice(0, 2)).toEqual([{ x: 20, y: 20 }, { x: 40, y: 20 }]);
      expect(job.insertion!.kind).toBe(fallback ? 'model' : 'travel');
      const ids = job.concerns.map(issue => issue.id);
      for (const mode of ['standard', 'klipper'] as const) {
        const added = createInsertion(job, brim, mode, ids);
        const prefix = source.split('\n').slice(0, job.insertion!.line - 1).join('\n') + '\n';
        const continuation = source.split('\n').slice(job.insertion!.line - 1, job.insertion!.modelLine - 1).join('\n') + '\n';
        expect(debtAfter(prefix + added + continuation)).toBeCloseTo(debtAfter(prefix + continuation), 8);
        const output = new TextDecoder().decode(exportBytes(encode(source), job, brim, mode, ids));
        expect(output.replace(added, '')).toBe(source);
      }
    });
  }

  it('does not invent a restart when none exists, and accepts balanced restarts normally', () => {
    const absent = parseGcode(restartSource(0.84, 0));
    expect(hardExportBlockers(absent).join()).toMatch(/separate unretract/i);
    const balanced = parseGcode(restartSource(0.8, 0.8));
    expect(balanced.concerns).toEqual([]);
    expect(exportBlockers(balanced)).toEqual([]);
  });

  it('detects the same difference in first-layer preparation after auxiliary paths', () => {
    const source = fixtureSource().replace(';TYPE:External perimeter', ';TYPE:Skirt/Brim\nG1 X18 Y20 E0.2\nG1 E-0.97\nG1 X20 Y20\nG1 E0.8\n;TYPE:External perimeter');
    const job = parseGcode(source);
    expect(hardExportBlockers(job)).toEqual([]);
    expect(job.concerns[0].message).toContain('0.17 mm difference');
  });

  it('enforces the late generated-code allowlist even with every concern accepted', () => {
    const source = fixtureSource().replace('G21', 'M573 R\nG21');
    const { job, brim } = brimFor(source);
    job.insertion!.state.type = 'Custom\nM104 S280';
    const ids = job.concerns.map(issue => issue.id);
    expect(() => exportBytes(encode(source), job, brim, 'standard', ids)).toThrow(/disallowed command/);
    expect(() => prepareExport(new File([source], 'part.gcode'), job, brim, 'standard', ids)).toThrow(/disallowed command/);
  });
});
