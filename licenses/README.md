# Bundled decoder notices

The pinned `@chestnutlabs/gcode-bgcode`, `@chestnutlabs/gcode-containers` and `@chestnutlabs/toolpath-core` 0.20.1 npm archives declare MIT but omit their monorepo license file. These upstream texts were retrieved on 2026-09-22, with trailing blank-line whitespace removed, and are incorporated by `npm run licenses` into the shipped third-party notices:

- [Chestnut Labs monorepo MIT license](https://github.com/ChestnutLabs/gcode-preview/blob/main/LICENSE): `chestnutlabs-MIT.txt`.
- [James Gopsill's MeatPack MIT license](https://github.com/jamesgopsill/meatpack/blob/main/LICENSE): `meatpack-MIT.txt`, attribution required by the decoder's source header.
- [Scott Vokes's heatshrink ISC license](https://github.com/atomicobject/heatshrink/blob/master/LICENSE): `heatshrink-ISC.txt`, attribution required by the decoder's source header.

Review these notices when upgrading the decoder. Prusa's AGPL libbgcode is a format/reference implementation only; its code is not included in the app.
