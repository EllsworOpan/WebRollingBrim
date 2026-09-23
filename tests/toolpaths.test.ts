import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boundsOf, buildFootprint, containsPoint, generateBrim, pathLength, polygonsOf, subtractPolygons } from '../src/core/geometry';
import { parseGcode } from '../src/core/gcode';
import { createInsertion } from '../src/core/export';
import { DEFAULT_BRIM, type BrimResult, type GeometryContext, type Point, type Rings } from '../src/core/types';
import { fixtureJob, rectangle } from './fixtures';

const context = (model: Rings): GeometryContext => ({ model, auxiliary: [], islands: polygonsOf(model), bounds: boundsOf(model) });
const boxContext = () => context([rectangle(20, 20, 20, 20)]);
const separation = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const retractions = (source: string) => [...source.matchAll(/^G1 E-/gm)].length;

function expectStepsInsideBrim(brim: BrimResult) {
  const polygons = polygonsOf(brim.area);
  brim.paths.forEach((path, i) => {
    if (brim.transitions[i] !== 'step') return;
    const a = brim.paths[i - 1].at(-1)!, b = path[0];
    expect(separation(a, b)).toBeLessThan(brim.settings.lineWidth * 1.6);
    for (let j = 0; j <= 20; j++) {
      const p = { x: a.x + (b.x - a.x) * j / 20, y: a.y + (b.y - a.y) * j / 20 };
      expect(polygons.some(polygon => containsPoint(p, polygon))).toBe(true);
    }
  });
}

describe('outside-to-model brim paths', () => {
  it('prints one uniformly spaced family of closed box loops, outside first', () => {
    const brim = generateBrim(boxContext(), fixtureJob(), DEFAULT_BRIM);
    expect(brim.paths).toHaveLength(11);
    expect(brim.transitions).toEqual(['travel', ...Array(10).fill('step')]);
    const bounds = brim.paths.map(path => boundsOf([path]));
    // Independent measured spacing from the user's PrusaSlicer box: 0.437 mm.
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i].minX - bounds[i - 1].minX).toBeCloseTo(0.437, 2);
      expect(bounds[i - 1].maxX - bounds[i].maxX).toBeCloseTo(0.437, 2);
      expect(separation(brim.paths[i - 1].at(-1)!, brim.paths[i][0])).toBeCloseTo(0.437, 2);
    }
    for (const path of brim.paths) expect(path.at(-1)).toEqual(path[0]);
    expect(20 - bounds.at(-1)!.minX).toBeCloseTo(0.3185, 3);
    expect(bounds[0].minX - brim.settings.lineWidth / 2).toBeGreaterThanOrEqual(20 - 5.1 - 0.01);
    expectStepsInsideBrim(brim);
  });

  it('uses unextruded XY steps with no retraction or Z moves between neighboring loops', () => {
    const job = fixtureJob(), brim = generateBrim(boxContext(), job, DEFAULT_BRIM);
    for (const mode of ['standard', 'klipper'] as const) {
      const added = createInsertion(job, brim, mode);
      expect(retractions(added)).toBe(2); // enter the brim, then return to the model
      expect([...added.matchAll(/^G1 Z/gm)]).toHaveLength(4);
      const steps = [...added.matchAll(/; BRIM_STEP\n([^\n]+)\n([^\n]+)/g)];
      expect(steps).toHaveLength(10);
      for (const [, move, extrusion] of steps) {
        expect(move).toMatch(/^G1(?: [XY][\d.-]+)+ F9000$/);
        expect(extrusion).toMatch(/^G1(?: [XY][\d.-]+)+ E[\d.]+ F1200$/);
      }
    }
    let cursor: Point = job.insertion!.state, travel = 0;
    for (const path of brim.paths) { travel += separation(cursor, path[0]); cursor = path.at(-1)!; }
    travel += separation(cursor, job.insertion!.state);
    const p = job.settings;
    const expected = brim.length / 20 + travel / p.travelSpeed + 2 * (0.8 / p.zSpeed + p.retractLength / p.retractSpeed + p.retractLength / p.unretractSpeed);
    expect(brim.minutes * 60).toBeCloseTo(expected, 8);
    expect(brim.length).toBeCloseTo(brim.paths.reduce((sum, path) => sum + pathLength(path), 0), 8);
  });

  it('finishes each separate region and retracts only on entry and final return', () => {
    const ctx = context([rectangle(20, 20, 20, 20), rectangle(80, 20, 20, 20)]);
    const brim = generateBrim(ctx, fixtureJob(), DEFAULT_BRIM);
    expect(brim.paths).toHaveLength(22);
    expect(brim.transitions).toEqual(['travel', ...Array(10).fill('step'), 'travel', ...Array(10).fill('step')]);
    expect(brim.paths.slice(0, 11).every(path => boundsOf([path]).maxX < 50)).toBe(true);
    expect(brim.paths.slice(11).every(path => boundsOf([path]).minX > 70)).toBe(true);
    expect(retractions(createInsertion(fixtureJob(), brim))).toBe(3);
    expectStepsInsideBrim(brim);
  });

  it('approaches the walls of an enclosed hole from its free interior', () => {
    const ctx = context(subtractPolygons([rectangle(20, 20, 60, 60)], [rectangle(35, 35, 30, 30)]));
    const brim = generateBrim(ctx, fixtureJob(), { ...DEFAULT_BRIM, holes: true });
    const holeLoops = brim.paths.filter(path => boundsOf([path]).minX > 30);
    expect(holeLoops).toHaveLength(11);
    for (let i = 1; i < holeLoops.length; i++) {
      expect(boundsOf([holeLoops[i - 1]]).minX - boundsOf([holeLoops[i]]).minX).toBeCloseTo(0.437, 2);
    }
    expect(brim.transitions.filter(kind => kind === 'travel')).toHaveLength(2);
    expectStepsInsideBrim(brim);
  });

  it('leaves clipped loops open instead of closing them across an existing path', () => {
    const ctx = boxContext();
    ctx.auxiliary = [rectangle(10, 29.95, 11, 0.1)];
    const brim = generateBrim(ctx, fixtureJob(), DEFAULT_BRIM);
    expect(brim.paths.some(path => separation(path[0], path.at(-1)!) > 0.1)).toBe(true);
    // Every extrusion crossing Y=30 must stay to the right of the auxiliary strip.
    for (const path of brim.paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if ((a.y < 30) === (b.y < 30)) continue;
      const x = a.x + (b.x - a.x) * (30 - a.y) / (b.y - a.y);
      expect(x).toBeGreaterThan(21 + brim.settings.lineWidth / 2);
    }
    expectStepsInsideBrim(brim);
  });

  it('keeps both extrusion and short steps within a clipped bed', () => {
    const brim = generateBrim(context([rectangle(2, 20, 20, 20)]), fixtureJob(), DEFAULT_BRIM);
    expect(brim.clippedArea).toBeGreaterThan(0);
    for (const path of brim.paths) for (const p of path) expect(p.x).toBeGreaterThanOrEqual(brim.settings.lineWidth / 2 - 0.01);
    expectStepsInsideBrim(brim);
  });

  it('does not add an overpacked extra loop to fill a fractional width remainder', () => {
    const settings = { ...DEFAULT_BRIM, width: 5.07 };
    const brim = generateBrim(boxContext(), fixtureJob(), settings);
    const previous = generateBrim(boxContext(), fixtureJob(), DEFAULT_BRIM);
    expect(brim.paths).toEqual(previous.paths);
  });

  it('prints one loop when the requested band is exactly one bead wide', () => {
    const brim = generateBrim(boxContext(), fixtureJob(), { ...DEFAULT_BRIM, width: 0.5, lineWidth: 0.5 });
    expect(brim.paths).toHaveLength(1);
    expect(brim.transitions).toEqual(['travel']);
    expect(brim.paths[0].at(-1)).toEqual(brim.paths[0][0]);
    expect(Math.abs(20 - boundsOf(brim.paths).minX - 0.3285)).toBeLessThan(0.001);
  });

  it('matches the supplied box on straight sections and bounds the remaining corner approximation', () => {
    const source = readFileSync(new URL('../examples/gcodes/Shape-Box_0.2mm_PLA_V2_40m.gcode', import.meta.url), 'utf8');
    const job = parseGcode(source), ctx = buildFootprint(job);
    expect(generateBrim(ctx, job, DEFAULT_BRIM).paths).toHaveLength(0); // existing brim is never printed twice
    const auxiliary = job.paths.filter(path => path.auxiliary && path.type === 'Skirt/Brim');
    const brimLoops = auxiliary.slice(1); // the isolated first loop is the skirt
    expect(brimLoops).toHaveLength(11);
    const sourceBounds = brimLoops.map(path => boundsOf([path.points]));
    for (let i = 1; i < sourceBounds.length; i++) expect(sourceBounds[i].minX - sourceBounds[i - 1].minX).toBeCloseTo(0.437, 3);
    const afterSkirt = source.indexOf(';WIPE_END', source.indexOf(';TYPE:Skirt/Brim'));
    const brimProgram = source.slice(afterSkirt, source.indexOf(';WIPE_START', afterSkirt));
    expect(retractions(brimProgram)).toBe(0);
    const shortMoves = brimProgram.split(/\r?\n/).filter(line => /^G1 X.* Y.* F/.test(line) && !/ [EZ]/.test(line));
    expect(shortMoves).toHaveLength(10);
    // Ignore existing deposition only for this comparison of the two planners.
    // The app continues to exclude the user's existing brim from added paths.
    const planned = generateBrim({ ...ctx, auxiliary: [] }, job, DEFAULT_BRIM);
    expect(planned.paths).toHaveLength(brimLoops.length);
    for (let i = 0; i < planned.paths.length; i++) {
      const actual = boundsOf([planned.paths[i]]);
      for (const edge of ['minX', 'minY', 'maxX', 'maxY'] as const) {
        expect(Math.abs(actual[edge] - sourceBounds[i][edge])).toBeLessThan(0.003);
      }
    }
    expect(planned.transitions).toEqual(['travel', ...Array(10).fill('step')]);
    expect(retractions(createInsertion(job, planned))).toBe(1); // entry reuses the original wipe
    function deviation(a: Point[], b: Point[]) {
      let maximum = 0;
      for (let i = 1; i < a.length; i++) {
        const begin = a[i - 1], end = a[i], count = Math.max(1, Math.ceil(separation(begin, end) / 0.1));
        for (let j = 0; j <= count; j++) {
          const p = { x: begin.x + (end.x - begin.x) * j / count, y: begin.y + (end.y - begin.y) * j / count };
          let nearest = Infinity;
          for (let k = 1; k < b.length; k++) {
            const u = b[k - 1], v = b[k], dx = v.x - u.x, dy = v.y - u.y;
            const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy || 1)));
            nearest = Math.min(nearest, Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy));
          }
          maximum = Math.max(maximum, nearest);
        }
      }
      return maximum;
    }
    const differences = planned.paths.map((path, i) => {
      const reference = [...brimLoops[i].points, brimLoops[i].points[0]];
      return Math.max(deviation(path, reference), deviation(reference, path));
    });
    // Closing the reference's tiny seam gap removes seam placement from this
    // comparison. Rounded swept beads do not recover PrusaSlicer's original
    // sharp slice corners: measure that difference instead of claiming equality.
    expect(Math.max(...differences)).toBeLessThan(0.125);
  });
});
