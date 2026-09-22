import { describe, expect, it } from 'vitest';
import { boundsOf, classifyRegions, containsPoint, generateBrim, polygonsOf, subtractPolygons, totalArea } from '../src/core/geometry';
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
});
