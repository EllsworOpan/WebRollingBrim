import { describe, expect, it } from 'vitest';
import { validateGeneratedGcode } from '../src/core/generated-gcode';
import { createInsertion, exportBytes } from '../src/core/export';
import { prepareExport } from '../src/core/export-review';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

describe('runtime generated-command allowlist', () => {
  it('allows motion/acceleration and ignores blank lines and semicolon comments', () => {
    const block = '\r\n  ; M104 S250 is only a comment\n\tG1 X10 E0.2 F1200 ; M107\rM204 P300\nM204 T4000\r\nM204 S300';
    for (const mode of ['standard', 'klipper'] as const) expect(() => validateGeneratedGcode(block, mode)).not.toThrow();
  });

  it('allows native state commands only in Klipper state restore mode', () => {
    for (const command of ['SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP', 'RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0']) {
      expect(() => validateGeneratedGcode(command, 'klipper')).not.toThrow();
      expect(() => validateGeneratedGcode(command, 'standard')).toThrow(/disallowed command/);
    }
  });

  it('rejects every unlisted command, including names that only start with an allowed command', () => {
    for (const command of [
      'M104 S250', 'M109 S250', 'M140 S80', 'M190 S80', 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=250',
      'M106 S255', 'M107', 'M220 S80', 'M221 S110', 'M205 X8', 'M900 K0.04',
      'SET_PRESSURE_ADVANCE ADVANCE=0.04', 'SET_VELOCITY_LIMIT ACCEL=4000',
      'G28', 'G90', 'M83', 'G92 E0', 'G10', 'M2040 S300', 'G1_EXTRA', 'SAVE_GCODE_STATE_EXTRA', 'UNEXPECTED_MACRO',
    ]) {
      for (const mode of ['standard', 'klipper'] as const) {
        expect(() => validateGeneratedGcode(`; header\nG1 X10\n  ${command}`, mode)).toThrow(`generated brim line 3 uses disallowed command "${command.split(' ')[0]}"`);
      }
    }
  });

  it('reports the first offending generated line with LF, CRLF, CR, or mixed line endings', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      expect(() => validateGeneratedGcode(['; header', '', 'G1 X10', 'M104 S250', 'M107'].join(newline), 'standard'))
        .toThrow('generated brim line 4 uses disallowed command "M104"');
    }
    expect(() => validateGeneratedGcode('; header\r\n\rG1 X10\nM107', 'standard'))
      .toThrow('generated brim line 4 uses disallowed command "M107"');
  });

  it('checks the final block in both assembly paths, including commands introduced by extracted annotations', () => {
    const source = fixtureSource(), bytes = new TextEncoder().encode(source), original = bytes.slice();
    const file = new File([source], 'test.gcode'), job = parseGcode(source);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    // Simulate a future extraction bug that introduces a command into an
    // annotation added at the very end of generation, after all motion setup.
    job.insertion!.state.type = 'External perimeter\r\nM104 S250';
    for (const mode of ['standard', 'klipper'] as const) {
      const added = createInsertion(job, brim, mode);
      expect(added).toContain(';TYPE:External perimeter\r\nM104 S250');
      const line = added.split(/\r\n|\n|\r/).indexOf('M104 S250') + 1;
      const error = `generated brim line ${line} uses disallowed command "M104"`;
      expect(() => exportBytes(bytes, job, brim, mode)).toThrow(error);
      expect(() => prepareExport(file, job, brim, mode)).toThrow(error);
    }
    expect(bytes).toEqual(original);
  });

  it('checks only the added block and preserves original temperature commands in both output paths', async () => {
    const source = fixtureSource().replace('G21\n', 'M104 S200\nM109 S200\nG21\n');
    const bytes = new TextEncoder().encode(source), job = parseGcode(source);
    const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
    for (const mode of ['standard', 'klipper'] as const) {
      const output = exportBytes(bytes, job, brim, mode);
      const review = prepareExport(new File([source], 'test.gcode'), job, brim, mode);
      expect(new Uint8Array(await review.output.arrayBuffer())).toEqual(output);
      const offset = job.insertion!.byteOffset, addedLength = output.length - bytes.length;
      expect(output.slice(0, offset)).toEqual(bytes.slice(0, offset));
      expect(output.slice(offset + addedLength)).toEqual(bytes.slice(offset));
      expect(review.addedLines.some(line => /^M10[49]\b/.test(line))).toBe(false);
    }
  });
});
