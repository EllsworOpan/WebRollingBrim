# Rolling Brim

A browser-based workbench for adding a single-layer rolling brim directly to PrusaSlicer G-code. Inspect 3D toolpaths, tune the brim in a precise 2D first-layer view, and export without rewriting any original lines.

Files stay in the browser. No account, API key, backend, or printer connection is required.

## Run with Docker

```sh
docker compose up --build -d
```

Open **http://localhost:8080**. Stop with `docker compose down`. Set the `PORT` environment variable to change the host port. The container serves the production build through Nginx and binds to the local machine only.

## Develop locally

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. `npm run build` creates `dist/`; `npm run preview` serves that build. `npm run check` runs TypeScript checking and the regression tests.

## Deploy on GitHub Pages

1. Put this project in a GitHub repository with a `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Push to `main`, or run the included **Verify and deploy to GitHub Pages** workflow.

The workflow checks the code and geometry before publishing. It handles both repository Pages URLs (`/<repository>/`) and user/organization Pages URLs (`/`). For a custom domain, set the workflow's build `BASE_PATH` to `/` and configure the domain in Pages. Docker always builds with `/`.

## Workflow

1. Open a plain-text PrusaSlicer `.gcode` file or use the included flexi lizard sample.
2. Adjust **rolling diameter**, **brim width**, and **separation gap**. Updates run in a Web Worker.
3. Optionally enable **enclosed holes** and **narrow-entry pockets** independently.
4. Inspect the **First layer** view. Pan, zoom, toggle brim visibility, and use the circle gauge to compare clearances. Uncovered connected islands are highlighted; no connectors are added automatically.
5. Export the G-code. A marked block prints after any already-completed skirt and immediately before the first supported model extrusion.

Positive gap means separation, zero means contact, negative gap means overlap. Width is measured from the inner edge of the brim, including the selected gap. The generated brim follows the first-layer extrusion height. Existing skirt, brim, support and other auxiliary first-layer deposition is kept and excluded from new brim paths.

## Geometry

The model footprint is reconstructed from the swept widths of first-layer model extrusions, including PrusaSlicer's inline Arachne width annotations. A 0.02 mm close removes microscopic bead seams. This represents the sliced first layer, including elephant-foot compensation, rather than the original mesh.

For rolling radius `r`, the model is expanded by `r` to form obstacles for the circle's centre. The remaining connected regions are classified using the **original** free space:

- **Outside:** circle centres connected to the unbounded exterior; always enabled.
- **Enclosed holes:** originally closed voids that can hold the circle; optional.
- **Narrow-entry pockets:** originally open voids whose usable circle-centre region is cut off by a narrow entrance; independently optional. Enabling this allows placing the circle inside, but does not allow it into narrower slots.

Selected centre regions are expanded back by the circle radius and intersected with the requested brim band. A region too small to contain the circle gets no brim, regardless of toggles. Calculations use Clipper2 at 0.001 mm coordinate precision and 0.006 mm rounded-offset tolerance; zero-clearance passages are treated as closed.

Printable concentric paths are inset by half the extrusion width and spaced according to a rounded extrusion cross-section. The result is clipped to the configured bed and avoids existing auxiliary material. Very narrow leftover slivers that cannot fit an extrusion are not printed. Coverage uses the **generated beads** and the requested gap, not just the ideal brim area. Small negative gaps are an intentional overlap setting, not a geometric collision error.

## G-code guarantees and supported scope

- The input is never reserialized. Export concatenates the original file's byte slices around one added UTF-8 block. Original comments, thumbnails, footer, line endings, BOM, and an unterminated final line are preserved.
- The added block has `ROLLING_BRIM_BEGIN` / `ROLLING_BRIM_END` markers. Removing the whole block reproduces the input byte-for-byte.
- The block restores XYZ, E coordinates, coordinate/extrusion modes, feed rate, and slicer feature annotations. Klipper uses its native `SAVE_GCODE_STATE` / `RESTORE_GCODE_STATE` to preserve even an E origin hidden in startup macros. Marlin requires an explicit `G92 E` reference. The insertion point must have known coordinates/feed and no outstanding retraction. Existing temperature, fan, pressure-advance, and acceleration commands are retained.
- Export targets **single-T0, planar, millimetre PrusaSlicer G-code** for **Prusa/Marlin (`marlin` or `marlin2`) and Klipper**, with the full slicer configuration footer. Firmware is detected from each file, never assumed from the slicer. Prusa/Marlin exports use standard G-code only; Klipper state commands are emitted only for a file explicitly marked `klipper`. Linear moves and ordinary XY I/J or R arcs are interpreted. Relative or absolute extrusion is supported.
- Binary `.bgcode`, numbered/checksummed programs, multi-tool jobs, rafts, sequential-object printing, vase mode, volumetric extrusion, firmware retraction, XYZ coordinate resets, raised first layers/Z offsets, and unsupported coordinate systems block export. A preview may still be available.
- Startup macros are preserved but cannot be expanded from a G-code file. Their hidden purge motions cannot be displayed or collision-checked. The insertion follows explicit slicer positioning, not an assumed macro endpoint.
- Original time/material estimates and thumbnails remain unchanged. Added time is an estimate from path lengths, speeds, retractions and lifts; firmware acceleration and overrides can change the actual duration.
- The first release caps files at 200 MB. Browser/GPU memory can impose a lower practical limit. The 3D overview uses shaded extrusion geometry for files under 30 MB and lightweight lines for larger files; the 2D view shows actual bead widths.

## Stack and viewer choice

- React / TypeScript / Vite
- `gcode-preview` **3.0.0-alpha.6**, pinned, with Three.js **0.180.0**. Its Prusa width metadata, layer handling, and public scene access fit this workbench. The version is prerelease; the viewer is isolated from the export interpreter.
- `clipper2-ts`, a TypeScript port of Clipper2, running in a Web Worker. It avoids a WASM loader/runtime while keeping the polygon engine replaceable. Its performance is verified on the supplied file.
- SVG for accurate first-layer inspection; no external fonts, analytics, file uploads, or runtime services.

Tests cover original-byte preservation, modal-state restoration, actual-sample parsing and generation, hole/pocket independence, too-small holes, width independence, positive gaps, bed clipping, and existing-path exclusion. The supplied `examples/gcodes` file is used by the tests and the sample button.
