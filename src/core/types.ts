export interface Point { x: number; y: number }
export type Ring = Point[];
export type Rings = Ring[];
export interface Polygon { outer: Ring; holes: Rings }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface PrintPath {
  points: Ring;
  width: number;
  height: number;
  type: string;
  auxiliary: boolean;
}
export interface PrinterState {
  x: number; y: number; z: number; e: number; f: number; eKnown: boolean;
  absoluteXYZ: boolean; absoluteE: boolean;
  retracted: number;
  type: string; width: number; height: number;
}
export interface PrintSettings {
  layerHeight: number; lineWidth: number; filamentDiameter: number;
  flow: number; printSpeed: number; travelSpeed: number; zSpeed: number;
  retractLength: number; retractSpeed: number; unretractSpeed: number; zHop: number;
}
export interface ParsedJob {
  name: string; bytes: number; lineCount: number; layerCount: number;
  slicer: string; flavor: string; config: Record<string, string>;
  settings: PrintSettings; firstLayerZ: number; paths: PrintPath[];
  bed: Ring; bounds: Bounds;
  insertion: { byteOffset: number; line: number; state: PrinterState } | null;
  warnings: string[]; blockers: string[];
  standardBlockers: string[];
  klipperBlockers: string[];
  extrusionResetLine: number | null;
  newline: string;
}
export type ExportMode = 'standard' | 'klipper';
export interface BrimSettings {
  diameter: number; width: number; gap: number;
  holes: boolean; pockets: boolean;
  lineWidth: number; speed: number; travelLift: number;
}
export const DEFAULT_BRIM: BrimSettings = {
  diameter: 10, width: 5, gap: 0.1, holes: false, pockets: false,
  lineWidth: 0.48, speed: 20, travelLift: 0.4,
};
export interface GeometryContext {
  model: Rings; auxiliary: Rings; islands: Polygon[]; bounds: Bounds;
}
export interface BrimResult {
  settings: BrimSettings;
  area: Rings; paths: Rings; unserved: Rings;
  length: number; filament: number; minutes: number; areaMm2: number;
  regions: { outside: number; holes: number; pockets: number };
  clippedArea: number; avoidedArea: number;
  warnings: string[]; computeMs: number;
}
export interface LoadedJob { job: ParsedJob; geometry: GeometryContext }
export type WorkerRequest =
  | { type: 'load'; id: number; name: string; bytes: ArrayBuffer }
  | { type: 'generate'; id: number; settings: BrimSettings };
export type WorkerResponse =
  | { type: 'loaded'; id: number; value: LoadedJob }
  | { type: 'generated'; id: number; value: BrimResult }
  | { type: 'progress'; id: number; message: string }
  | { type: 'error'; id: number; message: string };
