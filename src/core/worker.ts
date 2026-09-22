/// <reference lib="webworker" />
import { parseGcode } from './gcode';
import { buildFootprint, generateBrim } from './geometry';
import type { LoadedJob, WorkerRequest, WorkerResponse } from './types';

let loaded: LoadedJob | null = null;
const send = (message: WorkerResponse) => self.postMessage(message);
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      loaded = null;
      send({ type: 'progress', id: message.id, message: 'Reading toolpaths and print settings…' });
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(message.bytes);
      if (text.includes('\0')) throw new Error('Please use plain-text .gcode. Binary .bgcode is not supported.');
      const job = parseGcode(text, message.name, message.bytes.byteLength);
      send({ type: 'progress', id: message.id, message: 'Reconstructing the first-layer footprint…' });
      const geometry = buildFootprint(job);
      loaded = { job, geometry };
      send({ type: 'loaded', id: message.id, value: loaded });
    } else {
      if (!loaded) throw new Error('Load a G-code file first.');
      send({ type: 'progress', id: message.id, message: 'Finding reachable regions and laying brim paths…' });
      send({ type: 'generated', id: message.id, value: generateBrim(loaded.geometry, loaded.job, message.settings) });
    }
  } catch (error) { send({ type: 'error', id: message.id, message: error instanceof Error ? error.message : 'Unable to process this file.' }); }
};
