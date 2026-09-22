import { describe, expect, it } from 'vitest';
import { boundsOf, classifyRegions, containsPoint, generateBrim, polygonsOf, subtractPolygons, totalArea, unionPolygons } from '../src/core/geometry';
import { DEFAULT_BRIM, type GeometryContext, type Rings } from '../src/core/types';
import { fixtureJob, rectangle } from './fixtures';

function context(model: Rings): GeometryContext { return { model, auxiliary: [], islands: polygonsOf(model), bounds: boundsOf(model) }; }
function hasPoint(rings: Rings, x: number, y: number) { return polygonsOf(rings).some(poly => containsPoint({ x, y }, poly)); }
const pocketModel = () => subtractPolygons([rectangle(20, 20, 40, 40)], [rectangle(30, 30, 20, 20), rectangle(38, 49, 4, 12)]);

describe('rolling-circle reachability', () => {
  it('classifies a roomy narrow-entry pocket separately from an original enclosed hole', () => {
    const model = [...pocketModel(), ...subtractPolygons([rectangle(80, 20, 40, 40)], [rectangle(90, 30, 20, 20)])];
    const regions = classifyRegions(model, 10);
    expect(regions.counts).toEqual({ outside: 1, holes: 1, pockets: 1 });
    expect(hasPoint(regions.pockets, 32, 40)).toBe(true);
    expect(hasPoint(regions.outside, 32, 40)).toBe(false);
    expect(hasPoint(regions.holes, 92, 40)).toBe(true);
    expect(hasPoint(regions.pockets, 92, 40)).toBe(false);
  });

  it('excludes a hole too small to hold the disk even with both toggles on', () => {
    const model = subtractPolygons([rectangle(20, 20, 40, 40)], [rectangle(38, 38, 4, 4)]);
    const result = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, holes: true, pockets: true });
    expect(result.regions.holes).toBe(0);
    expect(hasPoint(result.area, 39, 39)).toBe(false);
  });

  it('allows teleporting into a pocket without enabling true holes', () => {
    const model = [...pocketModel(), ...subtractPolygons([rectangle(80, 20, 40, 40)], [rectangle(90, 30, 20, 20)])];
    const result = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, pockets: true, holes: false });
    expect(hasPoint(result.area, 32, 40)).toBe(true);
    expect(hasPoint(result.area, 92, 40)).toBe(false);
    expect(hasPoint(result.area, 40, 56)).toBe(false); // narrow throat remains out of reach
    const holeOnly = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, pockets: false, holes: true });
    expect(hasPoint(holeOnly.area, 32, 40)).toBe(false);
    expect(hasPoint(holeOnly.area, 92, 40)).toBe(true);
  });

  it('treats a large mouth as reachable and keeps width independent of diameter', () => {
    const model = subtractPolygons([rectangle(20, 20, 40, 40)], [rectangle(30, 30, 20, 31)]);
    expect(classifyRegions(model, 10).counts.pockets).toBe(0);
    const narrow = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, width: 2 });
    const wide = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, width: 7 });
    expect(wide.regions).toEqual(narrow.regions);
    expect(wide.areaMm2).toBeGreaterThan(narrow.areaMm2);
  });

  it('preserves a positive gap and clips deposited paths to the bed and existing skirt', () => {
    const ctx = context([rectangle(2, 20, 20, 20)]);
    ctx.auxiliary = [rectangle(1, 18, 23, 0.5)];
    const result = generateBrim(ctx, fixtureJob(), { ...DEFAULT_BRIM, gap: 0.2 });
    expect(result.clippedArea).toBeGreaterThan(0);
    expect(result.avoidedArea).toBeGreaterThan(0);
    expect(hasPoint(result.area, 2.1, 25)).toBe(false);
    expect(hasPoint(result.area, 1.9, 25)).toBe(false);
    expect(hasPoint(result.area, 10, 18.2)).toBe(false);
    for (const path of result.paths) for (const p of path) expect(p.x).toBeGreaterThanOrEqual(result.settings.lineWidth / 2 - 0.01);
    expect(totalArea(result.area)).toBeGreaterThan(0);
  });

  it.each([
    { diameter: 3.9, pocket: false },
    { diameter: 4, pocket: true },
    { diameter: 4.1, pocket: true },
  ])('requires positive neck clearance at diameter $diameter', ({ diameter, pocket }) => {
    const regions = classifyRegions(pocketModel(), diameter);
    expect(hasPoint(regions.outside, 32, 40)).toBe(!pocket);
    expect(hasPoint(regions.pockets, 32, 40)).toBe(pocket);
    expect(regions.counts.holes).toBe(0);
  });

  it.each([
    { diameter: 19.9, count: 1 },
    { diameter: 20, count: 0 },
    { diameter: 20.1, count: 0 },
  ])('requires room inside a 20 mm enclosed hole at diameter $diameter', ({ diameter, count }) => {
    const model = subtractPolygons([rectangle(20, 20, 40, 40)], [rectangle(30, 30, 20, 20)]);
    expect(classifyRegions(model, diameter).counts.holes).toBe(count);
  });

  it('keeps a narrow-neck chamber inside an enclosed hole classified as a hole', () => {
    const voids = unionPolygons([rectangle(30, 30, 20, 20), rectangle(70, 30, 20, 20), rectangle(49, 38, 22, 4)]);
    const model = subtractPolygons([rectangle(20, 20, 80, 40)], voids);
    const regions = classifyRegions(model, 10);
    expect(regions.counts).toEqual({ outside: 1, holes: 2, pockets: 0 });
    const pockets = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, pockets: true });
    const holes = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, holes: true });
    for (const x of [32, 72]) {
      expect(hasPoint(pockets.area, x, 40)).toBe(false);
      expect(hasPoint(holes.area, x, 40)).toBe(true);
    }
    expect(hasPoint(holes.area, 60, 40)).toBe(false);
  });

  it('covers an island inside a large hole only when enclosed holes are enabled', () => {
    const model = [...subtractPolygons([rectangle(20, 20, 80, 80)], [rectangle(30, 30, 60, 60)]), rectangle(55, 55, 10, 10)];
    const ctx = context(model);
    expect(ctx.islands).toHaveLength(2);
    const outside = generateBrim(ctx, fixtureJob(), DEFAULT_BRIM);
    const pockets = generateBrim(ctx, fixtureJob(), { ...DEFAULT_BRIM, pockets: true });
    const holes = generateBrim(ctx, fixtureJob(), { ...DEFAULT_BRIM, holes: true });
    expect(outside.unserved).toHaveLength(1);
    expect(pockets.unserved).toHaveLength(1);
    expect(holes.unserved).toHaveLength(0);
    expect(hasPoint(holes.area, 54, 60)).toBe(true);
    expect(hasPoint(holes.area, 60, 60)).toBe(false); // island itself remains material
  });

  it('classifies a cavity enclosed collectively by separate parts as a narrow-entry pocket', () => {
    const model = [rectangle(20, 20, 40, 8), rectangle(20, 52, 40, 8), rectangle(20, 30, 8, 20), rectangle(52, 30, 8, 20)];
    const regions = classifyRegions(model, 10);
    expect(regions.counts).toEqual({ outside: 1, holes: 0, pockets: 1 });
    const off = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, holes: true });
    const on = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, pockets: true });
    expect(hasPoint(off.area, 30, 40)).toBe(false);
    expect(hasPoint(on.area, 30, 40)).toBe(true);
  });

  it('does not let a wide brim or negative gap make an undersized hole eligible', () => {
    const model = subtractPolygons([rectangle(20, 20, 40, 40)], [rectangle(38, 38, 4, 4)]);
    const result = generateBrim(context(model), fixtureJob(), { ...DEFAULT_BRIM, width: 20, gap: -0.2, holes: true, pockets: true });
    expect(result.regions.holes).toBe(0);
    expect(hasPoint(result.area, 40, 40)).toBe(false);
  });

  it('reproduces the original paths after toggles are turned back off without changing the model', () => {
    const ctx = context(pocketModel()), original = structuredClone(ctx), job = fixtureJob();
    const before = generateBrim(ctx, job, DEFAULT_BRIM);
    generateBrim(ctx, job, { ...DEFAULT_BRIM, pockets: true, holes: true });
    const after = generateBrim(ctx, job, DEFAULT_BRIM);
    expect(after.paths).toEqual(before.paths);
    expect(after.area).toEqual(before.area);
    expect(ctx).toEqual(original);
  });
});
