import { union, difference, intersect, inflatePaths, simplifyPaths, Clipper64, ClipType, FillRule, JoinType, EndType } from 'clipper2-ts';
import { extrusionPerMm } from './gcode';
import type { Bounds, BrimResult, BrimSettings, GeometryContext, ParsedJob, Point, Polygon, Ring, Rings } from './types';

// One integer unit is 1 micrometre. Rounding stays well inside JS's safe integer range.
const SCALE = 1000;
const ARC_TOLERANCE = 6; // 0.006 mm
const RULE = FillRule.NonZero;
const toInt = (rings: Rings): Rings => rings.map(ring => ring.map(p => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) })));
const toMm = (rings: Rings): Rings => rings.map(ring => ring.map(p => ({ x: p.x / SCALE, y: p.y / SCALE })));
const clean = (rings: Rings): Rings => simplifyPaths(rings, 2, true).filter(ring => ring.length >= 3 && Math.abs(signedArea(ring)) > 100);
const offset = (rings: Rings, amount: number, end = EndType.Polygon): Rings => rings.length ? clean(inflatePaths(rings, amount, JoinType.Round, end, 2, ARC_TOLERANCE)) : [];
const merge = (rings: Rings): Rings => rings.length ? clean(union(rings, RULE)) : [];
const subtract = (a: Rings, b: Rings): Rings => a.length ? clean(difference(a, b, RULE)) : [];
const intersection = (a: Rings, b: Rings): Rings => a.length && b.length ? clean(intersect(a, b, RULE)) : [];

export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
export function totalArea(rings: Rings): number { return Math.max(0, rings.reduce((sum, ring) => sum + signedArea(ring), 0)); }
export function boundsOf(rings: Rings): Bounds {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) for (const p of ring) {
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  }
  return bounds;
}
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function containsPoint(p: Point, polygon: Polygon): boolean {
  return pointInRing(p, polygon.outer) && !polygon.holes.some(hole => pointInRing(p, hole));
}

/** Clipper returns positive outer boundaries and negative holes, including nested islands. */
export function polygonsOf(rings: Rings): Polygon[] {
  const polygons = rings.filter(ring => signedArea(ring) > 0).map(outer => ({ outer, holes: [] as Rings }));
  const ordered = [...polygons].sort((a, b) => signedArea(a.outer) - signedArea(b.outer));
  for (const hole of rings.filter(ring => signedArea(ring) < 0)) {
    ordered.find(poly => pointInRing(hole[0], poly.outer))?.holes.push(hole);
  }
  return polygons;
}
const flatten = (polygon: Polygon): Rings => [polygon.outer, ...polygon.holes];
export const unionPolygons = (rings: Rings): Rings => toMm(merge(toInt(rings)));
export const offsetPolygons = (rings: Rings, mm: number): Rings => toMm(offset(toInt(rings), mm * SCALE));
export const subtractPolygons = (a: Rings, b: Rings): Rings => toMm(subtract(toInt(a), toInt(b)));

function unionBatches(rings: Rings): Rings {
  const batches: Rings = [];
  for (let i = 0; i < rings.length; i += 150) batches.push(...merge(rings.slice(i, i + 150)));
  return merge(batches);
}

export function buildFootprint(job: ParsedJob): GeometryContext {
  const model: Rings = [], auxiliary: Rings = [];
  for (const path of job.paths) {
    if (path.points.length < 2) continue;
    const outline = offset(toInt([path.points]), path.width * SCALE / 2, EndType.Round);
    (path.auxiliary ? auxiliary : model).push(...outline);
  }
  // Close microscopic bead seams, not real model gaps. 0.02 mm is below a normal brim gap.
  const solid = offset(offset(unionBatches(model), 20), -20);
  const modelMm = toMm(solid), auxiliaryMm = toMm(unionBatches(auxiliary));
  return { model: modelMm, auxiliary: auxiliaryMm, islands: polygonsOf(modelMm), bounds: boundsOf(modelMm) };
}

export interface ReachableRegions { outside: Rings; holes: Rings; pockets: Rings; counts: BrimResult['regions'] }

/**
 * Configuration space: a radius-r disk centre must lie outside offset(model, r).
 * Classify connected centre regions against the ORIGINAL free space. This is
 * essential: a narrow-neck pocket becomes enclosed after inflation, but is not a hole.
 * Dilating each selected centre region by r recovers the area a disk can cover.
 */
export function classifyRegions(modelMm: Rings, diameter: number, overlap = 0): ReachableRegions {
  if (!modelMm.length) return { outside: [], holes: [], pockets: [], counts: { outside: 0, holes: 0, pockets: 0 } };
  const model = toInt(modelMm), radius = diameter * SCALE / 2;
  const b = boundsOf(model), margin = Math.max(radius * 5, 100 * SCALE);
  const frame: Ring = [
    { x: b.minX - margin, y: b.minY - margin }, { x: b.maxX + margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.maxY + margin }, { x: b.minX - margin, y: b.maxY + margin },
  ];
  const isOutside = (p: Polygon) => boundsOf([p.outer]).minX <= frame[0].x + 2;
  const originalHoles = polygonsOf(subtract([frame], model)).filter(poly => !isOutside(poly));
  // The extra micron eliminates zero-clearance, just-touching passages.
  const centers = polygonsOf(subtract([frame], offset(model, radius + 1)));
  const result: ReachableRegions = { outside: [], holes: [], pockets: [], counts: { outside: 0, holes: 0, pockets: 0 } };
  for (const component of centers) {
    const kind = isOutside(component) ? 'outside'
      : originalHoles.some(hole => containsPoint(component.outer[0], hole)) ? 'holes' : 'pockets';
    result.counts[kind]++;
    result[kind].push(...offset(flatten(component), radius + Math.max(0, overlap) * SCALE));
  }
  return { outside: toMm(merge(result.outside)), holes: toMm(merge(result.holes)), pockets: toMm(merge(result.pockets)), counts: result.counts };
}

export function pathLength(path: Ring): number {
  let distance = 0;
  for (let i = 1; i < path.length; i++) distance += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return distance;
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const samePoint = (a: Point, b: Point) => distance(a, b) < 0.0001;

/** Open clipping must not add a closing extrusion across excluded material. */
function clipLines(paths: Rings, area: Rings, operation = ClipType.Intersection): Rings {
  if (!paths.length) return [];
  const clipper = new Clipper64(), result: Rings = [];
  clipper.addOpenSubject(paths); clipper.addClip(area);
  if (!clipper.execute(operation, RULE, [], result)) throw new Error('Could not clip brim toolpaths.');
  return result;
}

/** Join fragments split only at the arbitrary starting vertex of a closed loop. */
function stitchPaths(paths: Rings): Rings {
  const remaining = paths.map(path => path.slice()), result: Rings = [];
  while (remaining.length) {
    let path = remaining.pop()!;
    for (let i = remaining.length - 1; i >= 0 && !samePoint(path[0], path.at(-1)!); i--) {
      let next = remaining[i];
      if (samePoint(path.at(-1)!, next.at(-1)!)) next = next.slice().reverse();
      if (samePoint(path.at(-1)!, next[0])) path.push(...next.slice(1));
      else {
        if (samePoint(path[0], next[0])) next = next.slice().reverse();
        if (!samePoint(path[0], next.at(-1)!)) continue;
        path = [...next.slice(0, -1), ...path];
      }
      remaining.splice(i, 1); i = remaining.length;
    }
    result.push(path);
  }
  return result;
}

/** Project the seam onto an edge, so adjacent loops need only a normal step. */
function startNear(path: Ring, cursor: Point): Ring {
  if (!samePoint(path[0], path.at(-1)!)) return distance(cursor, path[0]) <= distance(cursor, path.at(-1)!) ? path : path.slice().reverse();
  const ring = path.slice(0, -1);
  if (signedArea(ring) < 0) ring.reverse();
  let best = 0, closest = ring[0], bestDistance = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const point = { x: a.x + t * dx, y: a.y + t * dy }, d = distance(cursor, point);
    if (d < bestDistance) { best = i; closest = point; bestDistance = d; }
  }
  const rotated = [closest, ...ring.slice(best + 1), ...ring.slice(0, best + 1), closest];
  return rotated.filter((point, i) => !i || !samePoint(point, rotated[i - 1]));
}

interface Contour { points: Ring; level: number }

function planContours(free: Rings, area: Rings, width: number, lineWidth: number, spacing: number, start: Point) {
  const paths: Rings = [], transitions: BrimResult['transitions'] = [];
  // PrusaSlicer defines brim width and the inner loop using flow spacing.
  // Keep one grid, including its half-spacing phase, instead of squeezing an
  // extra contour into the fractional remainder at the outside edge.
  const count = Math.max(0, Math.floor((width + 1e-8) / spacing));
  if (count > 600) throw new Error('The brim needs too many extrusion passes. Increase line width or reduce brim width.');
  // A small clipping tolerance accounts for the rounded polygon engine's 6 µm
  // chord error. It prevents artificial fragments at coincident offset edges.
  const safeArea = offset(area, -lineWidth * SCALE / 2 + ARC_TOLERANCE + 2);
  const components = polygonsOf(safeArea).map(polygon => ({
    clip: flatten(polygon), contours: [] as Contour[],
  }));
  let numberOfPaths = 0;
  for (let level = 0; level < count; level++) {
    // Erode the unrestricted allowed free space, NOT the bounded brim band.
    // This gives one family of contours from the model/rolling boundary, with
    // no second front advancing from the opposite edge of the band.
    const contours = offset(free, -(level + 0.5) * spacing * SCALE);
    for (const component of components) {
      const clipped = stitchPaths(clipLines(contours.map(ring => [...ring, ring[0]]), component.clip));
      for (const points of toMm(clipped)) {
        if (pathLength(points) < lineWidth * (samePoint(points[0], points.at(-1)!) ? 3 : 1)) continue;
        component.contours.push({ points, level });
        if (++numberOfPaths > 10_000) throw new Error('The brim has too many disconnected toolpaths. Increase the rolling diameter.');
      }
    }
  }
  let cursor = start;
  const remaining = components.filter(component => component.contours.length);
  while (remaining.length) {
    // Finish each separate printable region before travelling to another one.
    const choices = remaining.map((component, index) => {
      const level = Math.max(...component.contours.map(contour => contour.level));
      const d = Math.min(...component.contours.filter(contour => contour.level === level).map(contour => distance(cursor, startNear(contour.points, cursor)[0])));
      return { index, d };
    });
    choices.sort((a, b) => a.d - b.d);
    const component = remaining.splice(choices[0].index, 1)[0];
    let previousLevel = -1;
    while (component.contours.length) {
      const candidates = component.contours.map((contour, index) => {
        const points = startNear(contour.points, cursor);
        return { ...contour, points, index, d: distance(cursor, points[0]) };
      });
      const steps = candidates.filter(candidate => candidate.level === previousLevel - 1 && candidate.d <= spacing * 1.5 + 0.01).sort((a, b) => a.d - b.d);
      const nextStep = steps.find(candidate => !clipLines(toInt([[cursor, candidate.points[0]]]), component.clip, ClipType.Difference).some(path => pathLength(path) > 2));
      const highest = Math.max(...candidates.map(candidate => candidate.level));
      const next = nextStep || candidates.filter(candidate => candidate.level === highest).sort((a, b) => a.d - b.d)[0];
      paths.push(next.points); transitions.push(nextStep ? 'step' : 'travel');
      component.contours.splice(next.index, 1);
      cursor = next.points.at(-1)!; previousLevel = next.level;
    }
  }
  return { paths, transitions };
}

export function validateBrimSettings(settings: BrimSettings, job: ParsedJob) {
  const ranges: [keyof BrimSettings, number, number][] = [
    ['diameter', 0.5, 100], ['width', 0.5, 40], ['gap', -0.2, 3],
    ['lineWidth', Math.max(job.settings.layerHeight, 0.2), 1.5], ['speed', 1, 150],
    ['travelLift', 0, 100],
  ];
  for (const [key, min, max] of ranges) {
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (typeof settings.holes !== 'boolean' || typeof settings.pockets !== 'boolean') throw new Error('Invalid region switches.');
}

export function generateBrim(context: GeometryContext, job: ParsedJob, settings: BrimSettings): BrimResult {
  const start = performance.now();
  validateBrimSettings(settings, job);
  if (!context.model.length) throw new Error('No first-layer model footprint is available.');
  const model = toInt(context.model), regions = classifyRegions(context.model, settings.diameter, -settings.gap);
  const allowed = merge(toInt([
    ...regions.outside, ...(settings.holes ? regions.holes : []), ...(settings.pockets ? regions.pockets : []),
  ]));
  const spacing = settings.lineWidth - job.settings.layerHeight * (1 - Math.PI / 4);
  // The displayed/deposited bead is wider than its flow spacing. Preserve the
  // half-spacing phase used by PrusaSlicer while clipping the FULL bead to the
  // bed and existing material. Gap is nominal, as it is in PrusaSlicer.
  const beadOverlap = (settings.lineWidth - spacing) / 2;
  const free = subtract(allowed, offset(model, settings.gap * SCALE));
  let area = intersection(offset(model, (settings.width + settings.gap + beadOverlap) * SCALE), offset(free, beadOverlap * SCALE));
  const originalArea = totalArea(area);
  if (job.bed.length >= 3) {
    const bed = toInt([job.bed]);
    if (signedArea(bed[0]) < 0) bed[0].reverse();
    area = intersection(area, bed);
  }
  const clippedArea = (originalArea - totalArea(area)) / SCALE ** 2;
  const bedArea = totalArea(area);
  if (context.auxiliary.length) area = subtract(area, offset(toInt(context.auxiliary), 30));
  const avoidedArea = (bedArea - totalArea(area)) / SCALE ** 2;
  const { paths, transitions } = planContours(free, area, settings.width, settings.lineWidth, spacing, job.insertion?.state || context.model[0][0]);
  const length = paths.reduce((sum, path) => sum + pathLength(path), 0);
  const filament = length * extrusionPerMm(job.settings, settings.lineWidth);
  // Test actual generated beads, including the configured gap, rather than the ideal polygon.
  const strokes = unionBatches(paths.flatMap(path => offset(toInt([path]), settings.lineWidth * SCALE / 2, EndType.Round)));
  const reach = offset(strokes, (Math.max(settings.gap, 0) + 0.06) * SCALE);
  const unserved = context.islands.filter(island => totalArea(intersection(toInt(flatten(island)), reach)) < 0.0001 * SCALE ** 2).map(island => island.outer);
  let travel = 0, cursor: Point = job.insertion?.state || paths[0]?.[0] || { x: 0, y: 0 };
  for (const path of paths) { travel += Math.hypot(path[0].x - cursor.x, path[0].y - cursor.y); cursor = path.at(-1)!; }
  if (job.insertion) travel += Math.hypot(cursor.x - job.insertion.state.x, cursor.y - job.insertion.state.y);
  const minutes = (length / settings.speed + travel / job.settings.travelSpeed
    + (transitions.filter(kind => kind === 'travel').length + 1) * (2 * settings.travelLift / job.settings.zSpeed
      + job.settings.retractLength / job.settings.retractSpeed + job.settings.retractLength / job.settings.unretractSpeed)) / 60;
  const warnings: string[] = [];
  if (settings.travelLift === 0) warnings.push('Travel lift is disabled. Added travel moves stay at first-layer Z.');
  else if (settings.travelLift < job.settings.layerHeight) warnings.push('Travel lift is smaller than the first-layer height. Inspect crossings of existing material.');
  if (!paths.length) warnings.push('No printable brim fits these settings. Try a smaller rolling diameter or a wider brim.');
  if (clippedArea > 0.05) warnings.push(`${clippedArea.toFixed(1)} mm² of brim was clipped to the printable bed.`);
  if (avoidedArea > 0.05) warnings.push('New brim paths avoid existing skirt, brim, and support material.');
  if (unserved.length) warnings.push(`${unserved.length} first-layer ${unserved.length === 1 ? 'island has' : 'islands have'} no adjacent generated brim at the selected gap.`);
  return { settings: { ...settings }, area: toMm(area), paths, transitions, unserved, length, filament, minutes, areaMm2: totalArea(area) / SCALE ** 2, regions: regions.counts, clippedArea, avoidedArea, warnings, computeMs: performance.now() - start };
}
