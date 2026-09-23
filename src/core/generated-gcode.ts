import type { ExportMode } from './types';

const commands = new Set(['G1', 'M204']);
const klipperCommands = new Set(['SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE']);

/** Check the completed block immediately before joining it to the source file.
 * This is a command-name allowlist; generation owns parameter/state validation.
 */
export function validateGeneratedGcode(block: string, mode: ExportMode): void {
  for (const [index, line] of block.split(/\r\n|\n|\r/).entries()) {
    const command = line.split(';', 1)[0].trim().split(/\s+/, 1)[0];
    if (!command) continue;
    if (commands.has(command) || (mode === 'klipper' && klipperCommands.has(command))) continue;
    throw new Error(`Export blocked: generated brim line ${index + 1} uses disallowed command "${command}".`);
  }
}
