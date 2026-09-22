// Original test geometry: four 2 mm tall plates, drawn here from rectangles.
// No downloaded model, mesh, or slicer profile is used.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Shape, Path, ExtrudeGeometry, Mesh, Group } from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
function outline(points, Type = Shape) {
  const path = new Type();
  points.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
  path.closePath();
  return path;
}
function plate(points, holes = []) {
  const shape = outline(points);
  shape.holes = holes.map(points => outline(points, Path));
  return new Mesh(new ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false, steps: 1 }));
}
const model = new Group();
// A: sealed 20 x 20 hole.
model.add(plate(rectangle(20, 80, 40, 40), [rectangle(30, 90, 20, 20)]));
// B: 20 x 20 chamber, open to the outside through a 4 mm wide, 10 mm long neck.
model.add(plate([[80,80],[120,80],[120,120],[102,120],[102,110],[110,110],
  [110,90],[90,90],[90,110],[98,110],[98,120],[80,120]]));
// C: sealed 4 x 4 hole, too small for the default 10 mm rolling circle.
model.add(plate(rectangle(20, 20, 40, 40), [rectangle(38, 38, 4, 4)]));
// D: 20 mm wide opening, reachable from the outside at the default diameter.
model.add(plate([[80,20],[120,20],[120,60],[110,60],[110,30],[90,30],[90,60],[80,60]]));
model.updateMatrixWorld(true);
const destination = new URL('../examples/models/', import.meta.url);
mkdirSync(destination, { recursive: true });
const stl = new STLExporter().parse(model, { binary: true });
writeFileSync(new URL('clearance-test-plate.stl', destination), Buffer.from(stl.buffer, stl.byteOffset, stl.byteLength));
console.info(`Wrote ${fileURLToPath(new URL('clearance-test-plate.stl', destination))}`);
