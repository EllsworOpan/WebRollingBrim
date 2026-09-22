import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, exportBytes } from '../src/core/export';
import { DEFAULT_BRIM, type BrimResult, type Point } from '../src/core/types';

const bytes = readFileSync(new URL('../examples/gcodes/clearance-test-plate.gcode', import.meta.url));
const job = parseGcode(bytes.toString('utf8'), 'clearance-test-plate.gcode', bytes.length);
const footprint = buildFootprint(job);

// Independent distance-to-segment oracle checks actual deposited beads, not
// just the intermediate allowed-area polygons used to create them.
function depositedAt(brim: BrimResult, p: Point) {
  return brim.paths.some(path => path.some((b, index) => {
    if (!index) return false;
    const a = path[index - 1], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= brim.settings.lineWidth / 2;
  }));
}

describe('original PrusaSlicer clearance test plate', () => {
  it('loads a real ten-layer Marlin2 slice with four original shapes and complete settings', () => {
    expect(job.slicer).toBe('PrusaSlicer 2.9.6');
    expect(job.flavor).toBe('marlin2');
    expect(job.layerCount).toBe(10);
    expect(exportBlockers(job)).toEqual([]);
    expect(footprint.islands).toHaveLength(4);
    expect(job.settings).toMatchObject({ layerHeight: 0.2, lineWidth: 0.48, filamentDiameter: 1.75, flow: 1, printSpeed: 20, zHop: 0.4 });
  });

  it.each([
    { holes: false, pockets: false },
    { holes: true, pockets: false },
    { holes: false, pockets: true },
    { holes: true, pockets: true },
  ])('deposits the expected beads for holes=$holes, pockets=$pockets', ({ holes, pockets }) => {
    const brim = generateBrim(footprint, job, { ...DEFAULT_BRIM, holes, pockets });
    expect(brim.regions).toEqual({ outside: 1, holes: 1, pockets: 1 });
    expect(depositedAt(brim, { x: 30.5, y: 100 })).toBe(holes); // A: big enclosed hole
    expect(depositedAt(brim, { x: 90.5, y: 100 })).toBe(pockets); // B: roomy narrow-entry pocket
    expect(depositedAt(brim, { x: 38.5, y: 40 })).toBe(false); // C: too-small hole
    expect(depositedAt(brim, { x: 90.5, y: 40 })).toBe(true); // D: wide open entrance
    expect(depositedAt(brim, { x: 19.5, y: 100 })).toBe(true); // exterior
    expect(depositedAt(brim, { x: 100, y: 115 })).toBe(false); // middle of B's narrow throat
    // The same toggle-specific result must survive the actual G-code export path.
    const output = exportBytes(bytes, job, brim), offset = job.insertion!.byteOffset;
    expect(Buffer.from(output.slice(0, offset)).equals(bytes.subarray(0, offset))).toBe(true);
    expect(Buffer.from(output.slice(offset + output.length - bytes.length)).equals(bytes.subarray(offset))).toBe(true);
    expect(createInsertion(job, brim)).not.toMatch(/SAVE_GCODE_STATE|RESTORE_GCODE_STATE|G92 E/);
  });

  it('makes B reachable and C eligible when the diameter drops below their 4 mm openings', () => {
    const outside = generateBrim(footprint, job, { ...DEFAULT_BRIM, diameter: 3 });
    const holes = generateBrim(footprint, job, { ...DEFAULT_BRIM, diameter: 3, holes: true });
    expect(outside.regions).toEqual({ outside: 1, holes: 2, pockets: 0 });
    expect(depositedAt(outside, { x: 90.5, y: 100 })).toBe(true);
    expect(depositedAt(outside, { x: 38.5, y: 40 })).toBe(false);
    expect(depositedAt(holes, { x: 38.5, y: 40 })).toBe(true);
  });

  it('clears the large cavity interiors once the rolling circle cannot fit', () => {
    const brim = generateBrim(footprint, job, { ...DEFAULT_BRIM, diameter: 25, holes: true, pockets: true });
    // Spaces between the separate plates can themselves become pockets at this
    // diameter; only the two named cavity interiors must become ineligible.
    expect(brim.regions.holes).toBe(0);
    expect(depositedAt(brim, { x: 30.5, y: 100 })).toBe(false);
    expect(depositedAt(brim, { x: 90.5, y: 100 })).toBe(false);
  });
});
