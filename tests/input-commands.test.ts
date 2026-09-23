import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/core/gcode';
import { buildFootprint, generateBrim } from '../src/core/geometry';
import { createInsertion, exportBlockers, exportBytes, hardExportBlockers } from '../src/core/export';
import { DEFAULT_BRIM } from '../src/core/types';
import { fixtureSource } from './fixtures';

const marlinSettings = [
  'M16 Test printer', 'M27 S5', 'M31', 'M75', 'M76', 'M77', 'M78', 'M113 S2', 'M119', 'M123', 'M155 S1', 'M503', 'M504',
  'M150B255', 'M151 R80', 'M250 C100', 'M255 S10', 'M256 B127', 'M300 S440 P100', 'M355 S1', 'M414 S0', 'M7219 D1',
  'M86 S180 T600', 'M87', 'M142 S45', 'M145 S0 H200 B60 F0', 'M149 F', 'M192 S30',
  'M301 E0 P22 I1 D80', 'M302 S170', 'M304 P10 I1 D300', 'M305 P0 B3950', 'M309 P10 I1 D300', 'M710 S100',
  'M17', 'M906 E650', 'M907 E650', 'M908 P1 S100', 'M909', 'M910', 'M911', 'M912',
  'M913 X100', 'M914 X10', 'M919 X O3 P-1 S1', 'M920 X500',
  'M407', 'M412 S1', 'M591 S0', 'M210 X3000', 'M211 S1', 'M603 U120 L125',
].join('\n');
const klipperSettings = [
  'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200', 'TEMPERATURE_WAIT SENSOR=extruder MINIMUM=195',
  'TURN_OFF_HEATERS', 'SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=chamber TARGET=40', 'SET_FAN_SPEED FAN=filter SPEED=0.5',
  'SET_INPUT_SHAPER SHAPER_TYPE=mzv SHAPER_FREQ_X=50', 'SET_TMC_CURRENT STEPPER=extruder CURRENT=0.65',
  'SET_IDLE_TIMEOUT TIMEOUT=600', 'SET_FILAMENT_SENSOR SENSOR=runout ENABLE=1',
  'SET_RETRACTION RETRACT_LENGTH=0.8 RETRACT_SPEED=35',
  'SET_DISPLAY_GROUP GROUP=default', 'set_display_text MSG=Printing', 'SET_LED LED=case WHITE=1',
  'SET_LED_TEMPLATE LED=case TEMPLATE=', 'RESPOND TYPE=echo MSG=Printing',
  'QUERY_FILAMENT_SENSOR SENSOR=runout', 'QUERY_FILAMENT_WIDTH', 'QUERY_ENDSTOPS', 'QUERY_PROBE',
  'QUERY_ADC NAME=extruder', 'DUMP_TMC STEPPER=extruder', 'GET_RETRACTION', 'BED_MESH_OUTPUT', 'BED_MESH_MAP', 'HELP', 'STATUS',
].join('\n');

function approach(flavor = 'klipper') {
  return fixtureSource().replace('gcode_flavor = klipper', `gcode_flavor = ${flavor}`)
    .replace('G1 X20 Y20 Z0.2 F1200', [
      'G1 X5 Y5 Z0.6 F600', 'M204 S900', 'G1 E-0.8 F2100',
      'G1 X20 Y20 F9000', 'G1 Z0.2 F600', 'G1 E0.8 F1800', 'M204 S300', 'G1 F1200',
    ].join('\n'));
}

describe('recognized input commands', () => {
  for (const flavor of ['marlin', 'marlin2', 'klipper']) {
    it(`inherits ${flavor} settings before and after insertion without rewriting them`, () => {
      const settings = flavor === 'klipper' ? klipperSettings : marlinSettings;
      const original = approach(flavor), baseline = parseGcode(original);
      // Place settings after state is known and within the first-layer model,
      // before any E reset: both geometry and the standard continuation matter.
      const source = original.replace('G1 X20 Y20 F9000', `${settings}\nG1 X20 Y20 F9000`)
        .replace('G1 X40 Y40 E1', `${settings}\nG1 X40 Y40 E1`);
      const job = parseGcode(source);
      expect(job.concerns).toEqual([]);
      expect(exportBlockers(job)).toEqual([]);
      expect(job.warnings).toEqual(baseline.warnings);
      expect(job.paths).toEqual(baseline.paths);
      expect(job.insertion!.kind).toBe('travel');
      expect(job.insertion!.state).toEqual(baseline.insertion!.state);
      expect(job.insertion!.modelState).toEqual(baseline.insertion!.modelState);
      expect(job.insertion!.acceleration).toEqual(baseline.insertion!.acceleration);
      const brim = generateBrim(buildFootprint(job), job, DEFAULT_BRIM);
      for (const mode of flavor === 'klipper' ? ['standard', 'klipper'] as const : ['standard'] as const) {
        const added = createInsertion(job, brim, mode);
        // Extra recognized source settings must not add any brim commands,
        // including redundant speed/acceleration assignments.
        expect(added).toBe(createInsertion(baseline, brim, mode));
        const output = new TextDecoder().decode(exportBytes(new TextEncoder().encode(source), job, brim, mode));
        expect(output.replace(added, '')).toBe(source);
      }
    });
  }

  it('still reads acceleration changes among inherited Klipper settings', () => {
    const source = approach().replace('M204 S900', `M204 S900\n${klipperSettings}\nset_velocity_limit ACCEL=700`);
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(job.insertion!.state.acceleration).toEqual({ print: 700, travel: 700, retract: null });
    expect(job.insertion!.acceleration).toMatchObject({ print: 300, travel: 700, restore: { travel: 700 } });
    const added = createInsertion(job, generateBrim(buildFootprint(job), job, DEFAULT_BRIM));
    expect(added).toContain('M204 S300');
    expect(added).toContain('M204 S700');
    expect(added).not.toContain('SET_VELOCITY_LIMIT');
  });

  it('keeps inherited settings as insertion boundaries so they execute before the brim', () => {
    const source = approach('marlin2').replace('G1 E0.8 F1800', 'G1 E0.8 F1800\nM301 E0 P22 I1 D80');
    const job = parseGcode(source);
    expect(exportBlockers(job)).toEqual([]);
    expect(job.insertion!.kind).toBe('model');
    expect(new TextDecoder().decode(new TextEncoder().encode(source).slice(0, job.insertion!.byteOffset)))
      .toContain('M301 E0 P22 I1 D80');
  });

  for (const command of ['M3000 S1', 'M300.1 S1', 'M150_CUSTOM', 'M573 R', 'M574 S0']) {
    it(`does not treat an unknown command as inherited: ${command}`, () => {
      const job = parseGcode(approach('marlin2').replace('G1 X40 Y40 E1', `${command}\nG1 X40 Y40 E1`));
      expect(hardExportBlockers(job).length).toBeGreaterThan(0);
      expect(job.standardBlockers.length).toBeGreaterThan(0);
    });
  }

  for (const command of ['SET_LED_CUSTOM LED=case', 'SET_LED.CUSTOM', 'SET_VELOCITY_LIMIT.CUSTOM ACCEL=700', 'SAVE_GCODE_STATE.CUSTOM', 'SET_PIN PIN=custom VALUE=1']) {
    it(`does not accept arbitrary macros or prefix matches: ${command}`, () => {
      const job = parseGcode(approach().replace('G1 X40 Y40 E1', `${command}\nG1 X40 Y40 E1`));
      expect(hardExportBlockers(job).join()).toMatch(/custom macro/);
      expect(job.standardBlockers.length).toBeGreaterThan(0);
    });
  }

  it('scopes newly recognized settings to the declared firmware, not the printer name', () => {
    const marlin = approach('marlin2').replace('G1 X40 Y40 E1', 'SET_LED LED=case WHITE=1\nG1 X40 Y40 E1');
    const klipper = approach().replace('G1 X40 Y40 E1', 'M300 S440\nG1 X40 Y40 E1');
    for (const source of [marlin, klipper]) expect(hardExportBlockers(parseGcode(source)).length).toBeGreaterThan(0);
    for (const name of ['GENERIC', 'COREONE_INDX', 'UNKNOWN']) {
      const job = parseGcode(approach('marlin2').replace('G21', `M300 S440\nG21`) + `; printer_model = ${name}\n`);
      expect(exportBlockers(job)).toEqual([]);
    }
  });

  it('does not bless motion-changing, executable, or E-counter-dependent commands as settings', () => {
    for (const command of ['M111 S8', 'M122 I', 'M209 S1', 'M217 Q', 'M240', 'M350 X16', 'M501', 'M600', 'G12', 'G427', 'M114']) {
      const job = parseGcode(approach('marlin2').replace('G1 X40 Y40 E1', `${command}\nG1 X40 Y40 E1`));
      expect(hardExportBlockers(job).length, command).toBeGreaterThan(0);
    }
    for (const command of ['SET_GCODE_OFFSET Z=1', 'ACTIVATE_EXTRUDER EXTRUDER=extruder1', 'SET_TMC_FIELD STEPPER=extruder FIELD=mres VALUE=4', 'RESTORE_GCODE_STATE NAME=other', 'GET_POSITION']) {
      const job = parseGcode(approach().replace('G1 X40 Y40 E1', `${command}\nG1 X40 Y40 E1`));
      expect(hardExportBlockers(job).length, command).toBeGreaterThan(0);
    }
  });

  it('does not let thermal units or other inherited settings establish motion units', () => {
    for (const units of ['', 'G20', 'G20\nG21']) {
      const job = parseGcode(approach('marlin2').replace('G21', `${marlinSettings}\n${units}`));
      expect(hardExportBlockers(job).join()).toMatch(/G21|Inch-based/);
    }
  });
});
