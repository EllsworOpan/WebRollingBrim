import type { Bounds, ParsedJob, Point, PrinterState, PrintPath, PrintSettings, Ring } from './types';

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const modelTypes = /^(External perimeter|Perimeter|Solid infill|Internal infill|Top solid infill|Gap fill|Overhang perimeter|Bridge infill|Internal bridge infill|Thin wall)$/i;

export function configNumber(config: Record<string, string>, key: string, fallback: number): number {
  const value = config[key]?.split(',')[0]?.trim();
  if (!value || value === 'nil' || value.includes('%')) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inherited(config: Record<string, string>, filament: string, regular: string, fallback: number) {
  return configNumber(config, filament, configNumber(config, regular, fallback));
}

export function extrusionPerMm(settings: Pick<PrintSettings, 'layerHeight' | 'filamentDiameter' | 'flow'>, width: number) {
  const h = settings.layerHeight;
  const area = h * (width - h) + Math.PI * h * h / 4;
  return area / (Math.PI * settings.filamentDiameter ** 2 / 4) * settings.flow;
}

export function parseConfig(source: string): Record<string, string> {
  const marker = source.lastIndexOf('; prusaslicer_config = begin');
  const footer = marker >= 0 ? source.slice(marker) : source.slice(-150_000);
  const config: Record<string, string> = {};
  for (const match of footer.matchAll(/^;\s*([a-z][a-z0-9_]*)\s*=\s*(.*)$/gm)) {
    config[match[1]] = match[2].trim();
  }
  return config;
}

function readSettings(config: Record<string, string>): PrintSettings {
  const height = configNumber(config, 'first_layer_height', 0.2);
  const firstHeight = config.first_layer_height?.endsWith('%')
    ? configNumber(config, 'layer_height', 0.2) * parseFloat(config.first_layer_height) / 100 : height;
  let width = configNumber(config, 'first_layer_extrusion_width', 0);
  if (config.first_layer_extrusion_width?.endsWith('%')) width = firstHeight * parseFloat(config.first_layer_extrusion_width) / 100;
  if (!width) width = configNumber(config, 'nozzle_diameter', 0.4) * 1.125;
  let speed = configNumber(config, 'first_layer_speed', 20);
  if (config.first_layer_speed?.endsWith('%')) speed = configNumber(config, 'perimeter_speed', 40) * parseFloat(config.first_layer_speed) / 100;
  return {
    layerHeight: firstHeight, lineWidth: width,
    filamentDiameter: configNumber(config, 'filament_diameter', 1.75),
    flow: configNumber(config, 'extrusion_multiplier', 1), printSpeed: speed,
    travelSpeed: configNumber(config, 'travel_speed', 150), zSpeed: configNumber(config, 'travel_speed_z', 10) || 10,
    retractLength: inherited(config, 'filament_retract_length', 'retract_length', 0.8),
    retractSpeed: inherited(config, 'filament_retract_speed', 'retract_speed', 35),
    unretractSpeed: inherited(config, 'filament_deretract_speed', 'deretract_speed', 30) || configNumber(config, 'retract_speed', 35),
    zHop: Math.max(0.4, inherited(config, 'filament_retract_lift', 'retract_lift', 0.4)),
  };
}

function readBed(config: Record<string, string>): Ring {
  return (config.bed_shape || '').split(',').map(value => {
    const [x, y] = value.split('x').map(Number);
    return { x, y };
  }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** G17 arcs, with relative I/J centres or signed R. Chord error is at most 0.01 mm. */
export function arcPoints(start: Point, end: Point, args: Record<string, number>, clockwise: boolean): Ring {
  let center: Point;
  if ('I' in args || 'J' in args) {
    center = { x: start.x + (args.I || 0), y: start.y + (args.J || 0) };
  } else if ('R' in args) {
    const dx = end.x - start.x, dy = end.y - start.y, chord = Math.hypot(dx, dy), radius = Math.abs(args.R);
    if (chord < 1e-8 || chord > 2 * radius + 0.001) throw new Error('Invalid radius-format arc in the first layer.');
    const h = Math.sqrt(Math.max(0, radius ** 2 - chord ** 2 / 4));
    const sign = (clockwise ? -1 : 1) * (args.R < 0 ? -1 : 1);
    center = { x: (start.x + end.x) / 2 - sign * dy / chord * h, y: (start.y + end.y) / 2 + sign * dx / chord * h };
  } else throw new Error('An arc is missing its I/J centre or radius.');
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (!radius || Math.abs(Math.hypot(end.x - center.x, end.y - center.y) - radius) > 0.08) throw new Error('Inconsistent arc radius in the first layer.');
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let sweep = Math.atan2(end.y - center.y, end.x - center.x) - a0;
  if (clockwise && sweep >= -1e-10) sweep -= Math.PI * 2;
  if (!clockwise && sweep <= 1e-10) sweep += Math.PI * 2;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / Math.min(Math.PI / 12, 2 * Math.acos(Math.max(-1, 1 - 0.01 / radius)))));
  if (steps > 100_000) throw new Error('Arc exceeds the supported geometry size.');
  return Array.from({ length: steps + 1 }, (_, i) => i === steps ? end : {
    x: center.x + radius * Math.cos(a0 + sweep * i / steps), y: center.y + radius * Math.sin(a0 + sweep * i / steps),
  });
}

/** Read-only interpreter. Byte offsets refer to the untouched UTF-8 input, including a BOM. */
export function parseGcode(source: string, name = 'print.gcode', byteLength?: number): ParsedJob {
  const config = parseConfig(source), settings = readSettings(config);
  const warnings = new Set<string>(), blockers = new Set<string>();
  const slicer = source.match(/generated by (PrusaSlicer [^\s]+)/)?.[1] || 'Unknown slicer';
  const flavor = config.gcode_flavor || 'unknown';
  if (!slicer.startsWith('PrusaSlicer')) blockers.add('Export currently requires PrusaSlicer text G-code.');
  if (!['klipper', 'marlin', 'marlin2'].includes(flavor)) blockers.add(`Unsupported or missing firmware flavor: ${flavor}.`);
  for (const key of ['filament_diameter', 'extrusion_multiplier', 'first_layer_height', 'first_layer_extrusion_width', 'first_layer_speed', 'retract_length', 'retract_speed', 'travel_speed']) {
    if (!(key in config)) blockers.add(`The PrusaSlicer footer is missing ${key}.`);
  }
  if (config.use_volumetric_e === '1') blockers.add('Volumetric extrusion is not supported for export.');
  if (config.use_firmware_retraction === '1') blockers.add('Firmware retraction is not supported for export.');
  if (config.complete_objects === '1') blockers.add('Sequential object printing is not supported for export.');
  if (configNumber(config, 'raft_layers', 0) > 0) blockers.add('Slice without a raft before adding a rolling brim.');
  if (config.spiral_vase === '1') blockers.add('Spiral vase G-code is not supported for export.');
  if (source.includes('; ROLLING_BRIM_BEGIN')) blockers.add('This file already contains a rolling brim. Load the original file to change it.');
  const bed = readBed(config);
  if (bed.length < 3) blockers.add('The footer has no usable bed shape.');
  if (!(settings.layerHeight > 0 && settings.layerHeight < 2 && settings.filamentDiameter >= 1 && settings.filamentDiameter <= 4 && settings.flow > 0 && settings.flow < 3)) blockers.add('The footer contains invalid extrusion settings.');

  let x = NaN, y = NaN, z = NaN, e = 0, f = NaN, retracted = 0, eKnown = false;
  let xyzModeKnown = false, eModeKnown = false;
  let absoluteXYZ = true, absoluteE = true, layer = 0, lineNo = 0, type = 'Custom';
  let width = settings.lineWidth, height = settings.layerHeight, firstLayerZ = NaN;
  let insertion: ParsedJob['insertion'] = null;
  let active: PrintPath | null = null;
  const paths: PrintPath[] = [], tools = new Set<number>();
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const newline = source.match(/\r\n|\n|\r/)?.[0] || '\n';
  const linePattern = /([^\r\n]*)(?:\r\n|\n|\r|$)/g;
  const parameterPattern = new RegExp(`([A-Z])\\s*(${NUMBER})`, 'gi');
  const addBounds = (p: Point) => {
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  };
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(source)) && match[0]) {
    lineNo++;
    const raw = match[1].replace(/^\uFEFF/, '').trim();
    if (raw === ';LAYER_CHANGE') { layer++; active = null; continue; }
    if (raw.startsWith(';TYPE:')) { type = raw.slice(6).trim(); active = null; continue; }
    if (raw.startsWith(';WIDTH:')) { const n = Number(raw.slice(7)); if (n > 0) width = n; active = null; continue; }
    if (raw.startsWith(';HEIGHT:')) { const n = Number(raw.slice(8)); if (n > 0) height = n; active = null; continue; }
    if (raw.startsWith(';Z:') && layer === 1) { firstLayerZ = Number(raw.slice(3)); continue; }
    if (!raw || raw[0] === ';') continue;
    if (/^N\d+\s/i.test(raw) || /\*\d+\s*$/.test(raw)) { blockers.add('Numbered or checksummed G-code cannot be modified by insertion alone.'); continue; }
    const code = raw.split(';')[0].trim();
    const command = code.match(/^([GMT]\d+(?:\.\d+)?)(?:\s|[XYZEFIJKRSPT]|$)/i)?.[1].toUpperCase();
    if (!command) {
      if (layer === 0 && !/^(SET_PRESSURE_ADVANCE|SET_VELOCITY_LIMIT|EXCLUDE_OBJECT_DEFINE|SET_PRINT_STATS_INFO)\b/.test(code)) {
        x = NaN; y = NaN; z = NaN; f = NaN; e = 0; eKnown = false; xyzModeKnown = false; eModeKnown = false;
      }
      if (layer === 0 && /^(PRINT_START|PURGE_LINE|START_PRINT|WARMUP)\b/.test(code)) warnings.add('Startup macros are preserved. Their purge paths and internal movements are not visible in this file.');
      if (layer === 1 && !/^(SET_PRESSURE_ADVANCE|SET_VELOCITY_LIMIT|EXCLUDE_OBJECT_START|EXCLUDE_OBJECT_END)\b/.test(code)) blockers.add('A custom macro in the first layer prevents reliable printer-state restoration.');
      continue;
    }
    const args: Record<string, number> = {};
    for (const param of code.slice(command.length).matchAll(parameterPattern)) args[param[1].toUpperCase()] = Number(param[2]);
    if (command.startsWith('T')) tools.add(Number(command.slice(1)));
    if (command === 'G20') blockers.add('Inch-based G-code is not supported.');
    if (['G18', 'G19', 'G90.1', 'G92.1', 'G92.2', 'G92.3', 'G53', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59'].includes(command)) blockers.add(`Coordinate mode ${command} is not supported for export.`);
    if (command === 'M200' && args.D !== 0) blockers.add('Volumetric extrusion is not supported.');
    if (['G10', 'G11'].includes(command)) blockers.add('Firmware retraction is not supported.');
    if (command === 'G90' || command === 'G91') {
      xyzModeKnown = true;
      absoluteXYZ = command === 'G90';
      // Prusa's legacy firmware keeps E mode intact; other Marlin variants
      // reset it here. Require an explicit M82/M83 when those readings differ.
      if (flavor.startsWith('marlin') && absoluteE !== absoluteXYZ) eModeKnown = false;
    }
    if (command === 'M82') { absoluteE = true; eModeKnown = true; }
    if (command === 'M83') { absoluteE = false; eModeKnown = true; }
    // End G-code may home an axis (including after a one-layer print). Only
    // homing within first-layer model features makes reconstruction ambiguous.
    if (command === 'G28') { x = NaN; y = NaN; z = NaN; if (layer === 1 && type !== 'Custom') blockers.add('Homing within first-layer features is not supported for export.'); }
    if (['M206', 'M218', 'G60', 'G61'].includes(command)) blockers.add(`Position-changing command ${command} is not supported for export.`);
    if (command === 'G92') {
      if (['X', 'Y', 'Z'].some(k => k in args)) blockers.add('XYZ coordinate resets need a printer-specific transform and are not supported.');
      if ('X' in args) x = args.X; if ('Y' in args) y = args.Y; if ('Z' in args) z = args.Z;
      if ('E' in args) { e = args.E; eKnown = true; }
      continue;
    }
    if (!['G0', 'G1', 'G2', 'G3'].includes(command)) continue;
    const before: PrinterState = { x, y, z, e, f, eKnown, absoluteXYZ, absoluteE, retracted, type, width, height };
    if ('F' in args) f = args.F;
    const next = (axis: string, previous: number) => axis in args ? args[axis] + (absoluteXYZ ? 0 : previous) : previous;
    const nx = next('X', x), ny = next('Y', y), nz = next('Z', z);
    const ne = 'E' in args ? args.E + (absoluteE ? 0 : e) : e;
    const de = ne - e, deposited = Math.max(0, de - retracted);
    if ('E' in args && !eModeKnown && layer === 1) blockers.add('Extrusion mode is ambiguous after G90/G91. The file needs an explicit M82/M83 before first-layer extrusion.');
    if ('E' in args && absoluteE && !eKnown && layer === 1) blockers.add('Absolute extrusion needs an explicit G92 E reference before the first layer.');
    retracted = Math.max(0, retracted - de);
    const motion = Math.hypot(nx - x, ny - y) > 0.00001 || command === 'G2' || command === 'G3';
    if (deposited > 1e-7 && motion && [x, y, nx, ny, nz].every(Number.isFinite)) {
      addBounds({ x, y }); addBounds({ x: nx, y: ny });
      if (layer === 1) {
        if (!Number.isFinite(firstLayerZ)) firstLayerZ = nz;
        if (Math.abs(nz - firstLayerZ) > 0.002 || Math.abs(z - nz) > 0.002) blockers.add('The first layer contains non-planar extrusion.');
        if (height <= 0 || width < height || width > 5) blockers.add('An extrusion width or height in the first layer is invalid.');
        if (Math.abs(height - settings.layerHeight) > 0.005) blockers.add('First-layer height annotations disagree with the configuration footer.');
        const isModel = modelTypes.test(type);
        const auxiliary = !isModel;
        if (auxiliary && !/^(Skirt\/Brim|Support material|Support material interface|Wipe tower|Custom)$/i.test(type)) blockers.add(`Unrecognized first-layer feature: ${type}.`);
        if (!insertion && isModel && xyzModeKnown && eModeKnown && before.retracted < 0.00001 && [before.x, before.y, before.z, before.f].every(Number.isFinite)) {
          insertion = { byteOffset: new TextEncoder().encode(source.slice(0, match.index)).byteLength, line: lineNo, state: before };
        }
        let points: Ring;
        if (command === 'G2' || command === 'G3') {
          try { points = arcPoints({ x, y }, { x: nx, y: ny }, args, command === 'G2'); }
          catch (error) { blockers.add((error as Error).message); points = [{ x, y }, { x: nx, y: ny }]; }
        } else points = [{ x, y }, { x: nx, y: ny }];
        const previous = active?.points.at(-1);
        if (active && previous && active.type === type && active.width === width && active.height === height && Math.hypot(previous.x - x, previous.y - y) < 0.00001) active.points.push(...points.slice(1));
        else { active = { points, type, width, height, auxiliary }; paths.push(active); }
      }
    } else if (motion || de < 0) active = null;
    x = nx; y = ny; z = nz; e = ne;
  }
  if (tools.size > 1 || [...tools].some(tool => tool !== 0)) blockers.add('Export currently supports a single T0 extruder.');
  if (!layer) blockers.add('No PrusaSlicer layer markers were found.');
  if (!paths.some(path => !path.auxiliary)) blockers.add('No model extrusion was found on the first layer.');
  if (!insertion) blockers.add('No fully specified, unretracted insertion point was found before model extrusion.');
  if (insertion && !insertion.state.eKnown && flavor !== 'klipper') blockers.add('This firmware needs an explicit G92 E reference before brim insertion.');
  if (source.includes('NAME=ROLLING_BRIM_APP')) blockers.add('The reserved Rolling Brim printer-state name is already in use.');
  if (Number.isFinite(firstLayerZ) && Math.abs(firstLayerZ - settings.layerHeight) > 0.015) blockers.add('The first-layer Z differs from its height. Z offsets and raised first layers are not supported yet.');
  if (paths.some(path => path.type === 'Skirt/Brim')) warnings.add('Existing skirt or brim paths are retained. New paths avoid their deposited material.');
  if (config.gcode_label_objects === 'disabled') warnings.add('Coverage is measured per connected first-layer island; object names are not present in this file.');
  return { name, bytes: byteLength ?? new TextEncoder().encode(source).byteLength, lineCount: lineNo, layerCount: layer, slicer, flavor, config, settings, firstLayerZ, paths, bed, bounds, insertion, warnings: [...warnings], blockers: [...blockers], newline };
}
