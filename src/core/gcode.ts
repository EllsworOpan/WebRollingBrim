import type { Bounds, ExportConcern, ParsedJob, Point, PrinterState, PrintPath, PrintSettings, Ring } from './types';
import { accelerationWrites, planInsertion, unknownAcceleration, type ApproachCommand } from './insertion';
import { inheritedSetting, startupRoutine, unsupportedTransform } from './input-commands';

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const modelTypes = /^(External perimeter|Perimeter|Solid infill|Internal infill|Top solid infill|Gap fill|Overhang perimeter|Bridge infill|Internal bridge infill|Thin wall)$/i;
// These commands do not read or alter the extrusion position. Other macros may
// capture an E counter, even if they do not immediately extrude anything.
const neutralMacro = /^(SET_PRESSURE_ADVANCE|SET_VELOCITY_LIMIT|EXCLUDE_OBJECT_DEFINE|EXCLUDE_OBJECT_START|EXCLUDE_OBJECT_END|SET_PRINT_STATS_INFO)\b/;
const neutralCommand = /^(G4|G17|G21|G91\.1|M73|M82|M83|M104|M105|M106|M107|M109|M115|M117|M118|M140|M141|M190|M191|M200|M201|M203|M204|M205|M207|M208|M220|M221|M400|M420|M486|M555|M569|M572|M593|M862(?:\.[1-9])?|M900|T0)$/;

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
    zHop: inherited(config, 'filament_retract_lift', 'retract_lift', 0),
  };
}

function readBed(config: Record<string, string>): Ring {
  const values = (config.bed_shape || '').split(','), point = new RegExp(`^(${NUMBER})x(${NUMBER})$`);
  if (values.some(value => !point.test(value.trim()))) return [];
  return values.map(value => { const [x, y] = value.trim().split('x').map(Number); return { x, y }; });
}

function usableBed(bed: Ring): boolean {
  if (bed.length < 3 || bed.length > 1000 || bed.some(p => ![p.x, p.y].every(v => Number.isFinite(v) && Math.abs(v) <= 100_000))) return false;
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const on = (a: Point, b: Point, c: Point) => Math.abs(cross(a, b, c)) < 1e-9 && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y);
  let area = 0;
  for (let i = 0; i < bed.length; i++) {
    const a = bed[i], b = bed[(i + 1) % bed.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.001) return false;
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 2; j < bed.length; j++) {
      if (i === 0 && j === bed.length - 1) continue;
      const c = bed[j], d = bed[(j + 1) % bed.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return false;
    }
  }
  return Math.abs(area) > 0.001;
}

/** G17 arcs, with relative I/J centres or signed R. Chord error is at most 0.01 mm. */
export function arcPoints(start: Point, end: Point, args: Record<string, number>, clockwise: boolean): Ring {
  if ('R' in args && ('I' in args || 'J' in args)) throw new Error('Mixed radius/centre arc formats are not supported.');
  if (Object.keys(args).some(key => !'XYZEFIJR'.includes(key))) throw new Error('Unsupported arc parameters in the first layer.');
  if (!Object.values(args).every(Number.isFinite)) throw new Error('An arc contains a non-finite value.');
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
  const concerns: ExportConcern[] = [];
  const standardBlockers = new Set<string>();
  // Report the first few actionable failures, not thousands of repeated moves.
  const standardProblem = (message: string) => { if (standardBlockers.size < 5) standardBlockers.add(message); };
  const klipperBlockers = /\bNAME\s*=\s*["']?ROLLING_BRIM_APP\b/i.test(source) ? ['The reserved Rolling Brim printer-state name is already in use.'] : [];
  const slicer = source.match(/generated by (PrusaSlicer [^\s]+)/)?.[1] || 'Unknown slicer';
  const flavor = config.gcode_flavor || 'unknown';
  if (!slicer.startsWith('PrusaSlicer')) blockers.add('Export currently requires PrusaSlicer G-code.');
  if (!['klipper', 'marlin', 'marlin2'].includes(flavor)) blockers.add(`Unsupported or missing firmware flavor: ${flavor}.`);
  for (const key of ['filament_diameter', 'extrusion_multiplier', 'first_layer_height', 'first_layer_extrusion_width', 'first_layer_speed', 'retract_length', 'retract_speed', 'travel_speed']) {
    if (!(key in config)) blockers.add(`The PrusaSlicer footer is missing ${key}.`);
  }
  // Missing optional values may use documented defaults. Present but corrupt
  // settings must never silently become a different printer's defaults.
  const percentKeys = ['first_layer_height', 'first_layer_extrusion_width', 'first_layer_speed'];
  const numericKeys = [...percentKeys, 'filament_diameter', 'extrusion_multiplier', 'layer_height', 'nozzle_diameter', 'perimeter_speed', 'travel_speed', 'travel_speed_z', 'retract_length', 'retract_speed', 'deretract_speed', 'retract_lift', 'filament_retract_length', 'filament_retract_speed', 'filament_deretract_speed', 'filament_retract_lift', 'raft_layers', 'max_print_height', 'first_layer_acceleration'];
  for (const key of numericKeys) {
    if (!(key in config)) continue;
    const value = config[key].split(',')[0].trim();
    if (key.startsWith('filament_') && key !== 'filament_diameter' && value === 'nil') continue;
    if (!new RegExp(`^${NUMBER}${percentKeys.includes(key) ? '%?' : ''}$`).test(value) || !Number.isFinite(Number(value.replace(/%$/, '')))) blockers.add(`The footer contains an invalid numeric setting: ${key}.`);
  }
  if (config.use_volumetric_e === '1') blockers.add('Volumetric extrusion is not supported for export.');
  if (config.use_firmware_retraction === '1') blockers.add('Firmware retraction is not supported for export.');
  if (config.complete_objects === '1') blockers.add('Sequential object printing is not supported for export.');
  if (configNumber(config, 'raft_layers', 0) > 0) blockers.add('Slice without a raft before adding a rolling brim.');
  if (config.spiral_vase === '1') blockers.add('Spiral vase G-code is not supported for export.');
  if (source.includes('; ROLLING_BRIM_BEGIN')) blockers.add('This file already contains a rolling brim. Load the original file to change it.');
  const bed = readBed(config);
  if (!usableBed(bed)) blockers.add('The footer has no usable bed shape: a finite, simple polygon is required.');
  if (!(settings.layerHeight > 0 && settings.layerHeight < 2 && settings.filamentDiameter >= 1 && settings.filamentDiameter <= 4 && settings.flow > 0 && settings.flow < 3)) blockers.add('The footer contains invalid extrusion settings.');
  if (![settings.travelSpeed, settings.zSpeed, settings.retractSpeed, settings.unretractSpeed, settings.printSpeed].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(settings.retractLength) || settings.retractLength < 0 || settings.zHop < 0 || !Number.isFinite(settings.zHop)) blockers.add('The footer contains invalid travel or retraction settings.');
  if (!(settings.lineWidth >= settings.layerHeight && settings.lineWidth <= 5)) blockers.add('The footer contains an invalid first-layer extrusion width.');
  if ('max_print_height' in config && !(Number(config.max_print_height) > 0)) blockers.add('The footer contains an invalid maximum print height.');
  if ('first_layer_acceleration' in config && Number(config.first_layer_acceleration) < 0) blockers.add('The footer contains an invalid first-layer acceleration.');
  if (!('retract_lift' in config) && !('filament_retract_lift' in config)) warnings.add('Travel lift is not specified in the footer. The brim starts with lift disabled; adjust it in Print settings.');

  let x = NaN, y = NaN, z = NaN, e = 0, f = NaN, retracted = 0, eKnown = false;
  let xyzModeKnown = false, eModeKnown = false, unitsKnown = false;
  let firstModelSeen = false, checkExtrusionCounter = false;
  let preModelRetract = false, restart: { line: number; command: string } | null = null;
  let annotatedRestart = false;
  let extrusionResetLine: number | null = null;
  let absoluteXYZ = true, absoluteE = true, layer = 0, lineNo = 0, type = 'Custom';
  let width = settings.lineWidth, height = settings.layerHeight, firstLayerZ = NaN;
  let insertion: ParsedJob['insertion'] = null;
  let acceleration = unknownAcceleration();
  let approach: ApproachCommand[] = [];
  const snapshot = (): PrinterState => ({ x, y, z, e, f, eKnown, absoluteXYZ, absoluteE, retracted, type, width, height, acceleration });
  let active: PrintPath | null = null;
  const paths: PrintPath[] = [], tools = new Set<number>();
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const newline = source.match(/\r\n|\n|\r/)?.[0] || '\n';
  const linePattern = /([^\r\n]*)(?:\r\n|\n|\r|$)/g;
  const parameterPattern = new RegExp(`([A-Z])\\s*(${NUMBER})`, 'gi');
  const strictWord = new RegExp(`([A-Z])\\s*(${NUMBER})`, 'iy');
  const syntaxProblem = () => blockers.add('Ambiguous or unsupported motion syntax. Use ordinary numeric PrusaSlicer commands, one per line, without duplicate parameters or parenthesized comments.');
  const addBounds = (p: Point) => {
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  };
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(source)) && match[0]) {
    lineNo++;
    const raw = match[1].replace(/^\uFEFF/, '').trim();
    if (raw === ';LAYER_CHANGE') { layer++; active = null; approach = []; continue; }
    if (raw.startsWith(';TYPE:')) { type = raw.slice(6).trim(); active = null; continue; }
    if (raw.startsWith(';WIDTH:')) { const n = Number(raw.slice(7)); if (n > 0 && Number.isFinite(n)) width = n; else if (layer === 1) blockers.add('Invalid first-layer WIDTH annotation.'); active = null; continue; }
    if (raw.startsWith(';HEIGHT:')) { const n = Number(raw.slice(8)); if (n > 0 && Number.isFinite(n)) height = n; else if (layer === 1) blockers.add('Invalid first-layer HEIGHT annotation.'); active = null; continue; }
    if (raw.startsWith(';Z:') && layer === 1) { firstLayerZ = Number(raw.slice(3)); continue; }
    if (!raw || raw[0] === ';') continue;
    if (/^N\d+/i.test(raw) || /\*\d+\s*$/.test(raw.split(';')[0])) { blockers.add('Numbered or checksummed G-code cannot be modified by insertion alone.'); continue; }
    const code = raw.split(';')[0].trim();
    const command = code.match(/^([GMT]\d+(?:\.\d+)?)(?:\s|[XYZEFIJKRSPT]|$)/i)?.[1].toUpperCase();
    if (!command) {
      approach = [];
      if (/^SET_VELOCITY_LIMIT\b/i.test(code) && /\bACCEL\s*=/i.test(code)) {
        const value = code.match(new RegExp(`\\bACCEL=(${NUMBER})(?:\\s|$)`, 'i'));
        const numeric = value ? Number(value[1]) : NaN;
        const known = (code.match(/\bACCEL\s*=/gi)?.length === 1) && Number.isFinite(numeric) && numeric > 0 ? numeric : null;
        acceleration = { ...acceleration, print: known, travel: known };
      }
      if (!firstModelSeen && /^(SET_GCODE_OFFSET|SET_KINEMATIC_POSITION|SET_STEPPER_CARRIAGES|FORCE_MOVE|SET_EXTRUDER_ROTATION_DISTANCE|SYNC_EXTRUDER_MOTION|ACTIVATE_EXTRUDER)\b/i.test(code)) blockers.add('Explicit printer transforms or extruder changes before insertion are not supported for export.');
      if (checkExtrusionCounter && !neutralMacro.test(code)) standardProblem(`Line ${lineNo}: ${code.split(/\s/)[0]} may use the E counter before the original file resets it. Choose Klipper state restore for a Klipper file, or re-slice without this dependency.`);
      if (!firstModelSeen && !neutralMacro.test(code) && !/^SAVE_GCODE_STATE\b/.test(code)) {
        x = NaN; y = NaN; z = NaN; f = NaN; e = 0; eKnown = false; retracted = 0; xyzModeKnown = false; eModeKnown = false; unitsKnown = false;
        acceleration = unknownAcceleration();
      }
      if (layer === 0 && /^(PRINT_START|PURGE_LINE|START_PRINT|WARMUP)\b/.test(code)) warnings.add('Startup macros are preserved. Their purge paths and internal movements are not visible in this file.');
      if (layer === 1 && !neutralMacro.test(code) && !/^SAVE_GCODE_STATE\b/.test(code)) blockers.add('A custom macro in the first layer prevents reliable geometry and position recovery.');
      continue;
    }
    const args: Record<string, number> = {};
    for (const param of code.slice(command.length).matchAll(parameterPattern)) args[param[1].toUpperCase()] = Number(param[2]);
    const motionCommand = ['G0', 'G1', 'G2', 'G3'].includes(command);
    const neutral = neutralCommand.test(command) || inheritedSetting(command, flavor);
    const routine = layer === 0 && startupRoutine.test(command);
    if (!['G0', 'G1', 'M204'].includes(command)) approach = [];
    // Consume the entire motion tail. Regex searches alone can interpret text in
    // comments, duplicate axes, or a second command as if it were valid motion.
    if (motionCommand || ['G92', 'G90', 'G91', 'G21', 'M82', 'M83', 'M204'].includes(command)) {
      const tail = code.slice(command.length), seen = new Set<string>();
      const allowed = command === 'M204' ? 'SPRT' : command === 'G2' || command === 'G3' ? 'XYZEFIJR' : command === 'G92' ? 'XYZE' : motionCommand ? 'XYZEF' : '';
      let cursor = 0;
      while (cursor < tail.length) {
        if (/\s/.test(tail[cursor])) { cursor++; continue; }
        strictWord.lastIndex = cursor;
        const word = strictWord.exec(tail);
        if (!word) { syntaxProblem(); break; }
        const key = word[1].toUpperCase();
        if (!allowed.includes(key) || seen.has(key) || !Number.isFinite(Number(word[2]))) syntaxProblem();
        seen.add(key); cursor = strictWord.lastIndex;
      }
      if ('F' in args && args.F <= 0) blockers.add('Motion feed rates must be positive.');
      if (command === 'M204' && Object.values(args).some(value => value <= 0)) blockers.add('Explicit acceleration values must be positive.');
    }
    if (command === 'M204') {
      if (!firstModelSeen && layer === 1) approach.push({ command, args, index: match.index, line: lineNo, before: snapshot(), modesKnown: xyzModeKnown && eModeKnown && unitsKnown });
      acceleration = { ...acceleration, ...accelerationWrites(args, flavor) };
    }
    if (checkExtrusionCounter && !motionCommand && !neutral && !['G90', 'G91', 'G92'].includes(command)) {
      // Shutdown commands do not depend on the logical E counter.
      if (!['G28', 'M18', 'M84', 'M2'].includes(command)) standardProblem(`Line ${lineNo}: cannot establish that ${command} is independent of the E counter before its next reset.`);
    }
    const unknownStartup = !firstModelSeen && !motionCommand && !neutral && !['G90', 'G91', 'G92', 'G28', 'G29', 'G80', 'M18', 'M84'].includes(command);
    const assumableStartup = unknownStartup && (command.startsWith('M') || routine) && !unsupportedTransform.test(command);
    if (assumableStartup) {
      concerns.push({ id: `startup:${lineNo}:${code}`, line: lineNo, command: code,
        message: `${command} has unverified startup effects.`,
        assumption: routine
          ? 'Startup completes with the selected tool ready to print. Its settings stay inherited, the retraction balance from explicit E moves remains usable, and no untracked deposition obstructs the brim. Position, feed and modes must be established again afterward.'
          : 'This command preserves the established units, positioning/extrusion modes, coordinate system, active tool and tracked retraction balance. It does not add untracked deposition in the print area.',
        consequence: 'If that assumption is wrong, the brim position, extrusion or clearance can be wrong. Acceleration is treated as unknown until explicitly set again; unknown acceleration is inherited, never guessed or restored.' });
      acceleration = unknownAcceleration();
    } else if (unknownStartup) blockers.add(`Command ${command} before model extrusion is not supported for state recovery.`);
    if (unsupportedTransform.test(command)) blockers.add(`Printer transform ${command} is not supported for export.`);
    if (layer === 1 && !motionCommand && !neutral && !assumableStartup && !['G90', 'G91', 'G92'].includes(command) && !(type === 'Custom' && ['G28', 'M18', 'M84', 'M2'].includes(command))) blockers.add(`Command ${command} within first-layer features is not supported for geometry recovery.`);
    if (routine) {
      // Keep the selected tool's configuration active, without simulating or
      // replaying the routine. Explicit commands must recover required state.
      x = NaN; y = NaN; z = NaN; f = NaN;
      e = 0; eKnown = false; xyzModeKnown = false; eModeKnown = false; unitsKnown = false;
      continue;
    }
    if (command.startsWith('T')) tools.add(Number(command.slice(1)));
    if (command === 'G20') blockers.add('Inch-based G-code is not supported.');
    if (command === 'G21') unitsKnown = true;
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
    if (checkExtrusionCounter && command === 'M82') standardProblem(`Line ${lineNo}: M82 switches to absolute extrusion before an original G92 E reset.`);
    // End G-code may home an axis (including after a one-layer print). Only
    // homing within first-layer model features makes reconstruction ambiguous.
    if (command === 'G28') { x = NaN; y = NaN; z = NaN; f = NaN; if (layer === 1 && type !== 'Custom') blockers.add('Homing within first-layer features is not supported for export.'); }
    if (command === 'G29' || command === 'G80') { x = NaN; y = NaN; z = NaN; f = NaN; }
    if (['M18', 'M84'].includes(command) && !('S' in args) && (!/\bE\b/.test(code) || /\b[XYZ]\b/.test(code))) { x = NaN; y = NaN; z = NaN; }
    if (['M206', 'M218', 'G60', 'G61'].includes(command)) blockers.add(`Position-changing command ${command} is not supported for export.`);
    if (command === 'G92') {
      if (!Object.keys(args).length) blockers.add('G92 without explicit axes is not supported for position recovery.');
      if (['X', 'Y', 'Z'].some(k => k in args)) blockers.add('XYZ coordinate resets need a printer-specific transform and are not supported.');
      if ('X' in args) x = args.X; if ('Y' in args) y = args.Y; if ('Z' in args) z = args.Z;
      if ('E' in args) {
        e = args.E; eKnown = true;
        if (checkExtrusionCounter) { checkExtrusionCounter = false; extrusionResetLine = lineNo; }
      }
      continue;
    }
    if (!motionCommand) continue;
    const before = snapshot();
    if ('F' in args) f = args.F;
    const next = (axis: string, previous: number) => axis in args ? args[axis] + (absoluteXYZ ? 0 : previous) : previous;
    const nx = next('X', x), ny = next('Y', y), nz = next('Z', z);
    const ne = 'E' in args ? args.E + (absoluteE ? 0 : e) : e;
    const de = ne - e, deposited = Math.max(0, de - retracted);
    if (checkExtrusionCounter && 'E' in args && (absoluteE || !eModeKnown)) standardProblem(`Line ${lineNo}: relative extrusion is not established before the original file resets E.`);
    if (layer >= 1 && modelTypes.test(type) && 'E' in args && (absoluteE || !eModeKnown)) blockers.add('Model extrusion must use explicit relative extrusion (M83). Enable relative E distances in PrusaSlicer and re-slice.');
    if ('E' in args && !eModeKnown && layer === 1) blockers.add('Extrusion mode is ambiguous after G90/G91. The file needs an explicit M82/M83 before first-layer extrusion.');
    if ('E' in args && absoluteE && !eKnown && layer === 1) blockers.add('Absolute extrusion needs an explicit G92 E reference before the first layer.');
    retracted = Math.max(0, retracted - de);
    if (de < 0) { preModelRetract = !firstModelSeen; restart = null; }
    else if (de > 0 && before.retracted > 0 && !['X', 'Y', 'Z'].some(axis => axis in args)) restart = { line: lineNo, command: code };
    const motion = Math.hypot(nx - x, ny - y) > 0.00001 || command === 'G2' || command === 'G3';
    if (!firstModelSeen && layer === 1 && modelTypes.test(type) && de > 1e-7 && ('X' in args || 'Y' in args || command === 'G2' || command === 'G3') && (motion || ![x, y].every(Number.isFinite))) {
      firstModelSeen = true;
      if (!Number.isFinite(firstLayerZ)) firstLayerZ = nz;
      // The first model move remains the eligibility anchor. Only now do we
      // have enough lookahead to plan an earlier entry and its continuation.
      insertion = planInsertion(source, approach, { command, args, index: match.index, line: lineNo, before,
        modesKnown: xyzModeKnown && eModeKnown && unitsKnown }, flavor, configNumber(config, 'first_layer_acceleration', 0));
      checkExtrusionCounter = true;
      if (!unitsKnown) blockers.add('An explicit G21 is required before model extrusion; millimetres cannot be assumed.');
      if (!xyzModeKnown || !before.absoluteXYZ) blockers.add('Absolute XYZ positioning (G90) must be established before the first model extrusion.');
      if (!eModeKnown || before.absoluteE) blockers.add('Relative extrusion (M83) must be established before the first model extrusion.');
      if (![before.x, before.y, before.z, before.f].every(Number.isFinite) || before.f <= 0) blockers.add('XYZ position and feed rate must be known before the first model extrusion.');
      if (before.retracted > 0.00001) {
        if (preModelRetract && restart) {
          annotatedRestart = true;
          const remainder = Number(before.retracted.toFixed(7));
          concerns.push({ id: `restart:${restart.line}:${remainder}`, line: restart.line, command: restart.command,
            message: `The startup retract and explicit restart leave a ${remainder} mm difference.`,
            assumption: 'The separate restart completes startup preparation and this remaining difference is intentional. Positive extrusion in annotated model features is treated as deposited material.',
            consequence: 'The brim preserves the original retraction balance. If model moves are still only unretracting, the footprint may overestimate deposited material.' });
        } else blockers.add('The first model extrusion starts with outstanding retraction. A separate unretract move is required before it.');
      }
      if (Math.abs(before.z - firstLayerZ) > 0.002) blockers.add('The nozzle must already be at first-layer Z before model extrusion.');
    }
    if (!firstModelSeen && layer === 1) {
      // Wipes (including their final negative E) must finish before insertion.
      // Retain only a bounded, non-depositing transition for lookahead.
      if (de < 0 || (('X' in args || 'Y' in args) && 'E' in args) || !['G0', 'G1'].includes(command)) approach = [];
      else {
        approach.push({ command, args, index: match.index, line: lineNo, before, modesKnown: xyzModeKnown && eModeKnown && unitsKnown });
        if (approach.length > 1000) approach = [];
      }
    }
    if ((deposited > 1e-7 || (annotatedRestart && modelTypes.test(type) && de > 1e-7)) && motion && [x, y, nx, ny, nz].every(Number.isFinite)) {
      addBounds({ x, y }); addBounds({ x: nx, y: ny });
      if (layer === 1) {
        if (!Number.isFinite(firstLayerZ)) firstLayerZ = nz;
        if (Math.abs(nz - firstLayerZ) > 0.002 || Math.abs(z - nz) > 0.002) blockers.add('The first layer contains non-planar extrusion.');
        if (height <= 0 || width < height || width > 5) blockers.add('An extrusion width or height in the first layer is invalid.');
        if (Math.abs(height - settings.layerHeight) > 0.005) blockers.add('First-layer height annotations disagree with the configuration footer.');
        const isModel = modelTypes.test(type);
        const auxiliary = !isModel;
        if (auxiliary && !/^(Skirt\/Brim|Support material|Support material interface|Wipe tower|Custom)$/i.test(type)) blockers.add(`Unrecognized first-layer feature: ${type}.`);
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
    if (retracted < 1e-7) annotatedRestart = false;
    x = nx; y = ny; z = nz; e = ne;
  }
  if (tools.size > 1 || [...tools].some(tool => tool !== 0)) blockers.add('Export currently supports a single T0 extruder.');
  if (!layer) blockers.add('No PrusaSlicer layer markers were found.');
  if (!paths.some(path => !path.auxiliary)) blockers.add('No model extrusion was found on the first layer.');
  if (!insertion) blockers.add('No first model extrusion was found for brim insertion.');
  else if (insertion.kind === 'model') warnings.add(insertion.reason);
  if (Number.isFinite(firstLayerZ) && Math.abs(firstLayerZ - settings.layerHeight) > 0.015) blockers.add('The first-layer Z differs from its height. Z offsets and raised first layers are not supported yet.');
  if (paths.some(path => path.type === 'Skirt/Brim')) warnings.add('Existing skirt or brim paths are retained. New paths avoid their deposited material.');
  if (config.gcode_label_objects === 'disabled') warnings.add('Coverage is measured per connected first-layer island; object names are not present in this file.');
  return { name, bytes: byteLength ?? new TextEncoder().encode(source).byteLength, lineCount: lineNo, layerCount: layer, slicer, flavor, config, settings, firstLayerZ, paths, bed, bounds, insertion, warnings: [...warnings], blockers: [...blockers], concerns, standardBlockers: [...standardBlockers], klipperBlockers, extrusionResetLine, newline };
}
