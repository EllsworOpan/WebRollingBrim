/// <reference lib="webworker" />
import { parseGcode } from './gcode';
import { buildFootprint, generateBrim } from './geometry';
import { decodeSource } from './source';
import type { LoadedJob, WorkerRequest, WorkerResponse } from './types';

let loaded: LoadedJob | null = null;
const send = (message: WorkerResponse) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      loaded = null;
      send({ type: 'progress', id: message.id, message: 'Reading G-code and checking binary blocks…' });
      const source = await decodeSource(new Uint8Array(message.bytes), message.name);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes);
      if (text.includes('\0')) throw new Error('Unsupported binary file. Choose PrusaSlicer .gcode or .bgcode.');
      const job = parseGcode(text, message.name, source.bytes.byteLength);
      send({ type: 'progress', id: message.id, message: 'Reconstructing the first-layer footprint…' });
      const geometry = buildFootprint(job);
      loaded = { job, geometry, bgcode: source.bgcode };
      send({ type: 'loaded', id: message.id, value: loaded, decoded: source.bgcode ? new Blob([source.bytes]) : undefined });
    } else {
      if (!loaded) throw new Error('Load a G-code file first.');
      send({ type: 'progress', id: message.id, message: 'Finding reachable regions and laying brim paths…' });
      send({ type: 'generated', id: message.id, value: generateBrim(loaded.geometry, loaded.job, message.settings) });
    }
  } catch (error) { send({ type: 'error', id: message.id, message: error instanceof Error ? error.message : 'Unable to process this file.' }); }
};
