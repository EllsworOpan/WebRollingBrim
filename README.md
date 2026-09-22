# Rolling Brim

A browser-based workbench for adding a single-layer rolling brim directly to PrusaSlicer G-code. Inspect 3D toolpaths, tune the brim in a precise 2D first-layer view, and export without rewriting any original lines.

Files stay in the browser. No account, API key, backend, or printer connection is required.

## Safety and liability disclaimer

**Free, experimental tool — use at your own risk.** Rolling Brim edits G-code. You are responsible for reviewing and approving the exported file for your printer before running it. Preview and export checks cannot guarantee safe operation. Keep the original and supervise your first test.

This tool and its output are provided as is, without warranty. To the extent permitted by law, the developer accepts no responsibility for failed prints, printer or property damage, or other losses caused by using the tool or its output.

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

1. Open a plain-text PrusaSlicer `.gcode` file or use the original holes & pockets test plate.
2. Adjust **rolling diameter**, **brim width**, and **separation gap**. Updates run in a Web Worker.
3. Optionally enable **enclosed holes** and **narrow-entry pockets** independently.
4. Inspect the **First layer** view. **Extrusion outlines** is on by default: individual model, auxiliary and brim passes have dark edges so their spacing and direction are visible when zoomed in. The edges are part of each bead's actual displayed width, not extra gaps or extra material. Turn the checkbox off for the solid footprint view. Pan, zoom, toggle brim visibility, and use the circle gauge to compare clearances. Uncovered connected islands are highlighted; no connectors are added automatically.
5. Open **Review export** for a Git-style diff: green `+` lines, unchanged context, original/export line numbers, and added/removed/changed counts. Switch between unified and side-by-side layouts, jump to either end of the insertion, or enable **Full file** to inspect any original line. Large files are indexed by byte offset and shown in pages of 250 lines.
6. **Download G-code** saves the exact output prepared for that review. A marked block prints after any already-completed skirt and immediately before the first supported model extrusion. Close the review to adjust settings; the next review prepares a fresh output.

The diff is read-only. Its rows come from the original file's byte slices and the exact inserted block; original lines are neither rewritten nor removed. The workspace's 3D view remains an original-toolpath preview with a generated brim overlay; the export diff shows the actual added commands, including travel, retraction and lift.

**Print settings** initializes line width, brim speed, and travel lift from each newly loaded file. Travel lift includes the filament override when present. The slider and numeric input control only the added brim; the original value remains visible alongside them. Zero emits **no Z moves** in the brim block, and a positive value is used exactly, with no hidden minimum. The insertion point must already be at first-layer Z. Missing lift metadata starts at zero with a note. Low-clearance notes do not change your selection.

**Export method** defaults to **Standard G-code** for both Prusa/Marlin and Klipper files. **Klipper state restore** is an optional alternative for a file explicitly marked `klipper`. The export-check summary shows the original insertion line, positioning/extrusion modes, and feed rate of the first resumed model move. Changing the method never bypasses the shared first-layer and position checks.

Gap and width follow PrusaSlicer's nominal line-spacing convention: positive gap separates, zero joins, and negative gap increases overlap. The first centreline is half a line spacing beyond the gap; a displayed bead is slightly wider than its spacing. The generated brim follows the first-layer extrusion height. Existing skirt, brim, support and other auxiliary first-layer deposition is kept and excluded from new brim paths.

## Geometry

The model footprint is reconstructed from the swept widths of first-layer model extrusions, including PrusaSlicer's inline Arachne width annotations. A 0.02 mm close removes microscopic bead seams. This represents the sliced first layer, including elephant-foot compensation, rather than the original mesh.

For rolling radius `r`, the model is expanded by `r` to form obstacles for the circle's centre. The remaining connected regions are classified using the **original** free space:

- **Outside:** circle centres connected to the unbounded exterior; always enabled.
- **Enclosed holes:** originally closed voids that can hold the circle; optional.
- **Narrow-entry pockets:** originally open voids whose usable circle-centre region is cut off by a narrow entrance; independently optional. Enabling this allows placing the circle inside, but does not allow it into narrower slots.

Selected centre regions are expanded back by the circle radius and intersected with the requested brim band. A region too small to contain the circle gets no brim, regardless of toggles. Calculations use Clipper2 at 0.001 mm coordinate precision and 0.006 mm rounded-offset tolerance; zero-clearance passages are treated as closed.

Printable contours use one spacing grid from the model/rolling boundary, based on the rounded extrusion cross-section. Each printable region is worked from its farthest contour toward the model. In an enclosed hole, this means progressing from the free interior toward its walls. Neighboring contours use short **non-extruding XY steps**, with no retraction or Z-hop. Seams are aligned by projecting onto the next contour's edge, rather than choosing an arbitrary polygon vertex. The initial trip to the brim, trips between separate regions or contours without a safe short connection, and the final return use the configured retraction and lift.

The loop count is `floor(width / spacing)` and the innermost centreline is `gap + spacing / 2` from the nominal boundary, matching PrusaSlicer's convention. For a 0.48 mm line at 0.2 mm height, spacing is approximately 0.43708 mm; the bead edge extends about 0.02146 mm beyond either side of its nominal spacing cell. Width is limited to whole passes, so the nominal outer edge can fall short by less than one spacing. An extra crowded loop is never squeezed into that remainder. The full deposited bead is clipped to the configured bed and avoids existing auxiliary material. Clipped contours stay open; the exporter never closes them across a model, skirt, or excluded region. Short connectors are checked along their entire length against the printable region, with a 0.008 mm polygon approximation tolerance. Very narrow leftover slivers that cannot fit an extrusion are not printed. Coverage uses the **generated beads** and the requested gap, not just the ideal brim area. Small negative gaps are an intentional overlap setting, not a geometric collision error.

Spacing is calculated as `lineWidth - layerHeight * (1 - π/4)`, consistent with [PrusaSlicer's rounded extrusion spacing](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Flow.cpp). The box's 0.48 mm brim width and 0.2 mm height therefore produce approximately 0.43708 mm between line centres. Its model perimeter annotation of 0.479999 mm is only 0.000001 mm different from the configured width. The footer's `infill_overlap = 15%` controls additional overlap **between infill and perimeters**, as defined in [PrusaSlicer's settings](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/PrintConfig.cpp); it does not control spacing between brim loops and is not applied to them.

The supplied box regression compares every loop's straight-edge positions with PrusaSlicer's G-code to within 0.003 mm, independently of seam placement. It also measures the full contours: this example retains up to about 0.12 mm of corner difference because a swept G-code footprint and our rounded polygon offsets do not reproduce the slicer's original slice polygons and corner construction exactly. This is a measured approximation, not a claim of identical deposited paths.

The box command regression compares extrusion per distance, 20 mm/s brim feeds, and 300 mm/s short-step feeds, then replays the original model continuation to verify its positions, relative extrusion amounts, feeds, acceleration and feature annotations. The box needs a final `G1 F1200` in the added block: its original standalone feed command is **before** insertion, and its next model move inherits that speed. Acceleration is deliberately left unchanged: the source switches between 286 mm/s² for brim extrusion and 4000 mm/s² for short steps, whereas our entire insertion inherits the active 286 mm/s². Entry/exit also differ: the source wipes and combines some travel with lift; the app uses explicit retraction and lift. Matching requested feeds does not imply identical travel times or command sequences.

## G-code guarantees and supported scope

- The input is never reserialized. Export concatenates the original file's byte slices around one added UTF-8 block. Original comments, thumbnails, footer, line endings, BOM, and an unterminated final line are preserved.
- The added block has `ROLLING_BRIM_BEGIN` / `ROLLING_BRIM_END` markers. Removing the whole block reproduces the input byte-for-byte.
- Both methods return to the original XYZ position, preserve the feed rate used by the original continuation, and restore slicer feature annotations. Established coordinate/extrusion modes remain unchanged, so no redundant `G90` / `M83` commands are emitted. Feed rates appear on motions only when they change; a final standalone feed restore is emitted only if needed in standard mode. When the exact next original model move contains its own valid feed rate, that command supplies the speed and the redundant restore is omitted. Otherwise the saved feed is restored before that move; comments or later speed changes never substitute for it. The optional Klipper snapshot restores its saved feed rate itself. Unchanged axis values and stationary travel are omitted. Repeated relative extrusion/retraction commands remain actions and are never deduplicated. Temperatures, fan, flow/speed overrides, pressure advance, and acceleration are left untouched; the original commands remain in place.
- **Standard G-code** uses ordinary commands and does not emit `G92 E` or Klipper commands. Extra relative extrusion changes the logical E counter, but not subsequent relative extrusion amounts. The interpreter checks the original continuation until an explicit `G92 E` removes that difference, or through EOF if there is no reset. Absolute-E switches, ambiguous E moves, and commands/macros that could depend on the counter block standard export in that interval. An earlier `G92 E` is not required.
- **Klipper state restore** wraps the same brim in native `SAVE_GCODE_STATE` / `RESTORE_GCODE_STATE … MOVE=0`, restoring the actual runtime E state as well. Explicit travel already returns XYZ before restoration. This can resolve a standard-mode E-counter dependency; it cannot resolve unknown first-layer geometry, position, or extrusion mode. The reserved snapshot name is checked for conflicts in the input.
- Export targets **single-T0, planar PrusaSlicer text G-code** for **Prusa/Marlin (`marlin` or `marlin2`) and Klipper**, with the full slicer footer. The exact first model extrusion must be preceded by explicit millimetres (`G21`), absolute XYZ (`G90`), relative extrusion (`M83`), a known position/feed rate, and no outstanding retraction. Model extrusion must remain relative; absolute-extrusion files can be previewed but cannot be exported. Linear moves and ordinary XY I/J or R arcs are interpreted.
- Active state is reconstructed from commands up to the insertion point, including changes after the skirt. The interpreter never skips an incompatible first model move to insert later. Slicer metadata provides first-layer height/width, filament properties, and travel/retraction settings. These are not all represented by standalone commands. Startup macros invalidate assumptions about state until explicit commands establish it again; firmware defaults are not treated as proof of the required modes.
- Binary `.bgcode`, numbered/checksummed programs, multi-tool jobs, rafts, sequential-object printing, vase mode, volumetric extrusion, firmware retraction, XYZ coordinate resets, raised first layers/Z offsets, and unsupported coordinate systems block export. A preview may still be available.
- Startup macros are preserved but cannot be expanded from a G-code file. Their hidden purge motions cannot be displayed or collision-checked. The insertion follows explicit slicer positioning, not an assumed macro endpoint.
- Original time/material estimates and thumbnails remain unchanged. Added time is an estimate from path lengths, speeds, retractions and lifts; firmware acceleration and overrides can change the actual duration.
- The first release caps files at 200 MB. Browser/GPU memory can impose a lower practical limit. The 3D overview uses shaded extrusion geometry for files under 30 MB and lightweight lines for larger files; the 2D view shows actual bead widths.

## Stack and viewer choice

- React / TypeScript / Vite
- `gcode-preview` **3.0.0-alpha.6**, pinned, with Three.js **0.180.0**. Its Prusa width metadata, layer handling, and public scene access fit this workbench. The version is prerelease; the viewer is isolated from the export interpreter.
- `clipper2-ts`, a TypeScript port of Clipper2, running in a Web Worker. It avoids a WASM loader/runtime while keeping the polygon engine replaceable. Its behavior is verified on original sliced fixtures and a generated large program.
- SVG for accurate first-layer inspection; no external fonts, analytics, file uploads, or runtime services.

Tests cover original-byte preservation, relative-E continuation and original resets, optional Klipper state restoration, exact insertion state after skirt settings, unknown state rejection, zero/exact travel lift, original PrusaSlicer sample parsing and generation, hole/pocket independence, too-small holes, width independence, positive gaps, bed clipping, and existing-path exclusion. Toolpath tests check outside-to-model order, uniform spacing against the supplied PrusaSlicer box, short connections without retraction, separate regions, open clipped contours, and motion-time accounting. The sample button uses the original clearance test plate. See [examples/README.md](examples/README.md) for a visual toggle guide, model provenance, reproduction commands, and optional private-file testing. The lizard is not bundled with the site.
