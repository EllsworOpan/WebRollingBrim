# Rolling Brim

A browser-based workbench for adding a single-layer rolling brim directly to PrusaSlicer `.gcode` and `.bgcode`. Inspect 3D toolpaths, tune the brim in a precise 2D first-layer view, and export while preserving the original print commands.

Files stay in the browser. No account, API key, backend, or printer connection is required.

Separate controls set the rolling-circle diameter, brim width and model gap. Enclosed holes and narrow-entry pockets have independent toggles. The first-layer view shows individual extrusion outlines, and a Git-style export review shows the exact added commands before download.

**MIT licensed.** See [License](#license) for permissions and third-party notices. This is an independent project, not affiliated with or endorsed by Prusa Research.

## Safety and liability disclaimer

**Free, experimental tool — use at your own risk.** Rolling Brim edits G-code. You are responsible for reviewing and approving the exported file for your printer before running it. Preview and export checks cannot guarantee safe operation. Keep the original and supervise your first test.

This tool and its output are provided as is, without warranty. To the extent permitted by law, the developer accepts no responsibility for failed prints, printer or property damage, or other losses caused by using the tool or its output.

## Run with Docker

Install Docker with Docker Compose (Docker Desktop on Windows/macOS), clone or download this repository, and run from its root directory. Node.js does not need to be installed on the host.

```sh
docker compose up --build -d
```

Open **http://localhost:8080**. After pulling changes, rerun `docker compose up --build -d`. Stop with `docker compose down`; inspect status with `docker compose ps` and logs with `docker compose logs --tail=100`.

The container serves the production build through Nginx and binds to the local machine only. To use another host port, create an ignored `.env` file containing `PORT=8081`, then rerun the Compose command. No volumes, database or persistent server data are required. Docker is the local test/deployment option; GitHub Pages serves the built static files directly and does not run Docker.

## Develop locally

Requires Node.js 24 and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). `npm run build` creates `dist/`; `npm run preview` serves that build. `npm run check` verifies license notices, checks TypeScript, and runs the regression tests. The optional private-file test is skipped unless `ROLLING_BRIM_TEST_GCODE` is set; see [the fixture guide](examples/README.md).

The development and preview commands listen on your own machine only. If you deliberately need LAN testing, add `-- --host 0.0.0.0` to either npm command. Use a static host or the Docker production build for deployment.

## Push this checkout to GitHub

This checkout already has Git history and a `main` branch. Create an **empty** GitHub repository without adding a README, license or `.gitignore` there; those files are included here. Substitute your repository URL below:

```sh
git remote add origin https://github.com/YOUR_GITHUB_USER/YOUR_REPOSITORY.git
git push -u origin main
```

If `origin` is already configured, inspect it with `git remote -v` and skip the `remote add` command when it is correct. For a fresh copy of an already published repository, use `git clone` instead.

Keep private or third-party samples in `.local/`. Git and Docker exclude that directory, including its private history backup. Commit the lockfile and the supplied original fixtures; do not commit `node_modules/`, `dist/`, `.env` files or personal G-code. The previous lizard sample is absent from the publishable Git history and the deployed app.

## Deploy on GitHub Pages

1. Push the repository using the instructions above. A **public** repository can use GitHub Pages on GitHub Free; private-repository availability depends on your GitHub plan.
2. In the repository's **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. Open **Actions → Verify and deploy to GitHub Pages → Run workflow**, select `main`, and run it. Later pushes to `main` deploy automatically after checks pass. If the first push ran before Pages was enabled, rerun the workflow after step 2.
4. Open the published URL shown in **Settings → Pages** or the workflow's `github-pages` deployment. A project repository normally uses `https://YOUR_GITHUB_USER.github.io/YOUR_REPOSITORY/`.

The included [Pages workflow](.github/workflows/pages.yml) installs the locked dependencies, runs the checks, builds `dist/`, and uploads/deploys only those static files. Pull requests and manual runs on other branches are checked and built without deploying. No personal access token, API key, separate hosting service, or `gh-pages` branch is needed; the deployment uses GitHub's built-in token. See [GitHub's workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

The workflow automatically uses `/<repository>/` for project sites and `/` for repositories named `<owner>.github.io`. Asset, Web Worker, demo download and license links respect this path.

### Custom domains and other static hosts

For a custom domain, add a repository **Actions variable** named `PAGES_BASE_PATH` with the value `/` under **Settings → Secrets and variables → Actions → Variables**. Configure the domain and DNS in **Settings → Pages**, enable HTTPS when available, then rerun the workflow. Follow [GitHub's custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site). For any other path override, include both the leading and trailing `/`.

Any static host can serve the entire `dist/` directory. The default build is for `/`. To build for a subdirectory, set `BASE_PATH` before building:

```sh
# Bash / macOS / Linux
BASE_PATH=/rolling-brim/ npm run build
```

```powershell
# PowerShell
$env:BASE_PATH = '/rolling-brim/'
npm run build
Remove-Item Env:BASE_PATH
```

Upload all of `dist/`, including `assets/`, `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt`. No server-side routes or application backend are needed. Docker always builds for `/`.

## Workflow

1. Open a PrusaSlicer `.gcode` or `.bgcode` file, or use the original holes & pockets test plate. Binary input is decoded locally and downloads as `.bgcode`.
2. Adjust **rolling diameter**, **brim width**, and **separation gap**. Updates run in a Web Worker.
3. Optionally enable **enclosed holes** and **narrow-entry pockets** independently.
4. Inspect the **First layer** view. **Extrusion outlines** is on by default: individual model, auxiliary and brim passes have dark edges so their spacing and direction are visible when zoomed in. The edges are part of each bead's actual displayed width, not extra gaps or extra material. Turn the checkbox off for the solid footprint view. Pan, zoom, toggle brim visibility, and use the circle gauge to compare clearances. Uncovered connected islands are highlighted; no connectors are added automatically.
5. Open **Review export** for a Git-style diff: green `+` lines, unchanged context, original/export line numbers, and added/removed/changed counts. The compact view shows the insertion's beginning and end, with 8 original context lines on each side. Separate folds identify hidden **added** lines in the middle and **unchanged** lines outside the insertion, with exact counts and export line ranges. Expand a fold or choose **Expand all** to scroll continuously, without pages. **Compact view** folds it again. Switch between unified and side-by-side layouts, jump to either insertion boundary, or enter any export line number (its fold opens automatically). Large files use a byte index and render only the rows near the viewport.
6. **Download G-code** saves the exact output prepared for that review. A marked block prints after any already-completed skirt and immediately before the first supported model extrusion. Close the review to adjust settings; the next review prepares a fresh output.

The diff is read-only. For text files, its rows come from the original file's byte slices and the exact inserted block. For binary files, it shows the decoded G-code and added commands, and identifies the download as binary. Original command lines are neither rewritten nor removed. The workspace's 3D view remains an original-toolpath preview with a generated brim overlay; the export diff shows the actual added commands, including travel, retraction and lift.

**Print settings** initializes line width, brim speed, and travel lift from each newly loaded file. Travel lift includes the filament override when present. The slider and numeric input control hops between brim paths; the original value remains visible alongside them. Zero disables these hops. An existing source lift and the height required to hand control back to the source are still respected, so entry/exit can contain Z moves even at zero. Missing lift metadata starts at zero with a note. Low-clearance notes do not change your selection.

**Export method** defaults to **Standard G-code** for both Prusa/Marlin and Klipper files. **Klipper state restore** is an optional alternative for a file explicitly marked `klipper`. The export-check summary explains the insertion choice, reused retraction, handoff height, positioning/extrusion modes, first model feed, and brim/travel acceleration policy. Changing the method never bypasses the shared first-layer and position checks.

Gap and width follow PrusaSlicer's nominal line-spacing convention: positive gap separates, zero joins, and negative gap increases overlap. The first centreline is half a line spacing beyond the gap; a displayed bead is slightly wider than its spacing. The generated brim follows the first-layer extrusion height. Existing skirt, brim, support and other auxiliary first-layer deposition is kept and excluded from new brim paths.

## Geometry

The model footprint is reconstructed from the swept widths of first-layer model extrusions, including PrusaSlicer's inline Arachne width annotations. A 0.02 mm close removes microscopic bead seams. This represents the sliced first layer, including elephant-foot compensation, rather than the original mesh.

For rolling radius `r`, the model is expanded by `r` to form obstacles for the circle's centre. The remaining connected regions are classified using the **original** free space:

- **Outside:** circle centres connected to the unbounded exterior; always enabled.
- **Enclosed holes:** originally closed voids that can hold the circle; optional.
- **Narrow-entry pockets:** originally open voids whose usable circle-centre region is cut off by a narrow entrance; independently optional. Enabling this allows placing the circle inside, but does not allow it into narrower slots.

Selected centre regions are expanded back by the circle radius and intersected with the requested brim band. A region too small to contain the circle gets no brim, regardless of toggles. Calculations use Clipper2 at 0.001 mm coordinate precision and 0.006 mm rounded-offset tolerance; zero-clearance passages are treated as closed.

Printable contours use one spacing grid from the model/rolling boundary, based on the rounded extrusion cross-section. Each printable region is worked from its farthest contour toward the model. In an enclosed hole, this means progressing from the free interior toward its walls. Neighboring contours use short **non-extruding XY steps**, with no retraction or Z-hop. Seams are aligned by projecting onto the next contour's edge, rather than choosing an arbitrary polygon vertex. Trips between separate regions or contours without a safe short connection use the configured retraction and lift. Entry reuses existing retraction/lift; exit establishes the state required by the original model approach.

The loop count is `floor(width / spacing)` and the innermost centreline is `gap + spacing / 2` from the nominal boundary, matching PrusaSlicer's convention. For a 0.48 mm line at 0.2 mm height, spacing is approximately 0.43708 mm; the bead edge extends about 0.02146 mm beyond either side of its nominal spacing cell. Width is limited to whole passes, so the nominal outer edge can fall short by less than one spacing. An extra crowded loop is never squeezed into that remainder. The full deposited bead is clipped to the configured bed and avoids existing auxiliary material. Clipped contours stay open; the exporter never closes them across a model, skirt, or excluded region. Short connectors are checked along their entire length against the printable region, with a 0.008 mm polygon approximation tolerance. Very narrow leftover slivers that cannot fit an extrusion are not printed. Coverage uses the **generated beads** and the requested gap, not just the ideal brim area. Small negative gaps are an intentional overlap setting, not a geometric collision error.

Spacing is calculated as `lineWidth - layerHeight * (1 - π/4)`, consistent with [PrusaSlicer's rounded extrusion spacing](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Flow.cpp). The box's 0.48 mm brim width and 0.2 mm height therefore produce approximately 0.43708 mm between line centres. Its model perimeter annotation of 0.479999 mm is only 0.000001 mm different from the configured width. The footer's `infill_overlap = 15%` controls additional overlap **between infill and perimeters**, as defined in [PrusaSlicer's settings](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/PrintConfig.cpp); it does not control spacing between brim loops and is not applied to them.

The supplied box regression compares every loop's straight-edge positions with PrusaSlicer's G-code to within 0.003 mm, independently of seam placement. It also measures the full contours: this example retains up to about 0.12 mm of corner difference because a swept G-code footprint and our rounded polygon offsets do not reproduce the slicer's original slice polygons and corner construction exactly. This is a measured approximation, not a claim of identical deposited paths.

The box command regression compares extrusion per distance, 20 mm/s brim feeds, 300 mm/s short-step feeds, and 286/4000 mm/s² print/travel acceleration, then replays the original model continuation. Insertion follows the final skirt/brim wipe and precedes its `M204 S4000` and model travel. The existing 0.8 mm wipe retraction is reused. Exit retracts and lifts vertically to the upcoming absolute Z0.998; the unchanged original XYZ travel then moves horizontally before lowering and unretracting at the model. The original commands establish the travel and model feeds, so no final `G1 F1200` is added. A larger selected lift completes XY at that clearance before lowering to the handoff height, avoiding a diagonal descent from the brim. These approach paths intentionally differ from the original travel; matching feeds does not imply identical motion timing.

## G-code guarantees and supported scope

- Text input is never reserialized. Export concatenates the original file's byte slices around one added UTF-8 block. Original comments, thumbnails, footer, line endings, BOM, and an unterminated final line are preserved. Binary input preserves all metadata, thumbnails and untouched binary blocks byte-for-byte; only the G-code block containing the insertion is rebuilt.
- The added block has `ROLLING_BRIM_BEGIN` / `ROLLING_BRIM_END` markers. Removing it reproduces the text input byte-for-byte, or the original decoded G-code stream for binary input. A rebuilt binary block uses different container bytes.
- Insertion prefers the final absolute XY approach to the first model feature, after startup, auxiliary deposition and wipe retractions. The planner reads through the following lowering, unretraction, feed and acceleration commands before selecting a boundary. A supported handoff leaves the nozzle retracted at the required travel height and lets the original approach position it. Partial-axis travel, extrusion during travel, unknown required acceleration, intervening settings/macros, or incomplete entry state use the original model-start insertion with an explanation. That fallback returns to the saved XYZ position. Neither strategy skips an incompatible first model extrusion.
- Both methods preserve the feed used by the original continuation and restore slicer feature annotations. Established coordinate/extrusion modes remain unchanged. Feed rates appear on motions only when they change; a standalone restore is added only when the original continuation needs the previous feed before assigning its own. The optional Klipper snapshot restores its saved feed itself. Unchanged axis values and stationary travel are omitted; relative E actions are never deduplicated.
- The added block never emits fan, temperature, flow/speed override, pressure advance, or jerk commands. Acceleration is interpreted per firmware: separate Marlin P/T/R fields, or Klipper's shared acceleration and P/T minimum rule. The earlier insertion uses a positive first-layer acceleration setting when supplied, otherwise the known model print acceleration; travel uses the known approach acceleration. Unknown values are inherited without guessing from machine limits. Acceleration is set only for an emitted motion that needs a different value. Only changed print/travel acceleration fields are restored, unless the source sets them before use. Marlin's separate retract acceleration is inherited; Klipper uses shared acceleration for retract/unretract motions too. Other setting changes are boundaries the earlier insertion cannot cross.
- **Standard G-code** uses ordinary commands and does not emit `G92 E` or Klipper commands. Extra relative extrusion changes the logical E counter, but not subsequent relative extrusion amounts. The interpreter checks the original continuation until an explicit `G92 E` removes that difference, or through EOF if there is no reset. Absolute-E switches, ambiguous E moves, and commands/macros that could depend on the counter block standard export in that interval. An earlier `G92 E` is not required.
- **Klipper state restore** wraps the same brim in native `SAVE_GCODE_STATE` / `RESTORE_GCODE_STATE … MOVE=0`, restoring the actual runtime E state as well. Generated motions establish the planned handoff before restoration; MOVE=0 does not return XYZ. Acceleration is handled separately because the native snapshot does not save it. This can resolve a standard-mode E-counter dependency; it cannot resolve unknown first-layer geometry or extrusion mode. The reserved snapshot name is checked for conflicts in the input.
- Export targets **single-T0, planar PrusaSlicer G-code**, in text or binary form, for **Prusa/Marlin (`marlin` or `marlin2`) and Klipper**, with full slicer settings and layer/feature annotations. The exact first model extrusion must be preceded by explicit millimetres (`G21`), absolute XYZ (`G90`), relative extrusion (`M83`), a known position/feed rate, and no outstanding retraction. Model extrusion must remain relative; absolute-extrusion files can be previewed but cannot be exported. Linear moves and ordinary XY I/J or R arcs are interpreted.
- Active state is reconstructed from commands before insertion, and continuation requirements come from commands after it. Slicer metadata supplies first-layer height/width, filament properties, and travel/retraction settings. Startup macros invalidate assumptions until explicit commands establish them again; firmware defaults are not treated as proof of required modes or acceleration. An earlier insertion can have unknown XY when its first brim travel explicitly supplies both coordinates from a known Z. Geometry uses a deterministic model-position seed in that case, not invented starting coordinates.
- Numbered/checksummed G-code command lines, multi-tool jobs, rafts, sequential-object printing, vase mode, volumetric extrusion, firmware retraction, XYZ coordinate resets, raised first layers/Z offsets, and unsupported coordinate systems block export. A preview may still be available. Binary container CRCs are supported separately.
- Malformed numeric footer settings, invalid bed polygons, duplicate or incomplete motion parameters, multiple commands on one motion line, parenthesized motion comments, unsupported arc parameters, and unknown first-layer commands also block export. Explicit startup coordinate/extruder transforms are rejected even if later moves establish a position. These checks apply to both export methods; the Klipper snapshot does not bypass them.
- Brim hops are measured from the exact model printing Z, separately from entry and handoff heights. When supplied, `max_print_height` constrains all three. Source-required heights still apply with a zero brim hop. Travel is direct and is not obstacle-aware routing.
- Startup macros are preserved but cannot be expanded from a G-code file. Their hidden purge motions cannot be displayed or collision-checked. Unknown incoming XY is reported, and that incoming distance is omitted from the time estimate.
- Original time/material estimates and thumbnails remain unchanged. Added time estimates account for reused retraction/lift and the replaced approach travel when its origin is known; firmware acceleration and overrides can change the actual duration.
- The first release caps input files and decoded binary content at 200 MB, with at most 100,000 binary blocks. Browser/GPU memory can impose a lower practical limit. The 3D overview uses shaded extrusion geometry for decoded files under 30 MB and lightweight lines for larger files; the 2D view shows actual bead widths.

The [release safety review](docs/safety-review.md) records the checks performed, fixes, and remaining limits. Passing those checks establishes the tested software behavior; it is not a certification of a physical printer or of arbitrary input G-code.

### Binary G-code

Import supports [Prusa bgcode version 1](https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md), with no compression, zlib DEFLATE, heatshrink 11/4 or 12/4, and unencoded or MeatPack G-code (including the comment-preserving variant). INI metadata supplies the slicer settings. Declared CRC32 checksums are verified on every block; truncated files, unknown versions/codecs, unsupported block order, invalid text and excessive decoded sizes are rejected. Decoding runs in a browser worker. Files that omit the required layer/feature comments or use unsupported printer modes still fail the usual export checks.

Binary downloads retain the original file header, checksum policy, metadata, thumbnails and every untouched block. The affected G-code block is decoded, the allowlist-checked brim is inserted, and that region is stored as uncompressed/unencoded blocks of at most 64 KiB with new CRCs when required. Original decoded commands are preserved exactly; the file can grow because the changed region is stored without compression. The diff displays decoded commands and reconstructed metadata comments, not raw binary bytes. Download reuses the exact binary output prepared for review. No new printer commands are introduced by the binary wrapper.

### Generated G-code allowlist

This is the complete set of commands the app may **add**. It applies to both insertion strategies. Firmware flavor determines the `M204` form independently of the selected export method. Every original command stays byte-for-byte in place; this allowlist does not filter the source file.

Immediately before the completed block is joined to the original commands, the text review/download path, byte exporter and binary exporter run a runtime allowlist check. It scans every generated line, skips blank lines and semicolon comments, and checks the exact leading command token: `G1` or `M204`, plus `SAVE_GCODE_STATE` / `RESTORE_GCODE_STATE` only in Klipper state restore mode. An unexpected command aborts export with its name and line number within the added block; nothing is silently removed. This final check validates command names; generation checks and regression tests cover parameters and state. The reviewed download reuses the same validated output.

| Added command / permitted parameters | When emitted |
| --- | --- |
| `G1` with `X`, `Y`, `Z`, `E`, and/or `F` | Brim extrusion, travel, lift, retraction/unretraction, and the planned handoff. XYZ positions are absolute; E actions are relative. Unchanged XYZ coordinates and stationary travel are omitted. `F` appears only when the motion needs a different feed. A standalone `G1 F…` restores a changed feed only if the source needs it before assigning its own. |
| `M204 P…` or `M204 T…` — `marlin` / `marlin2` only | Change print or travel acceleration when an actual generated motion needs it, or restore a changed value the source still needs. Each command sets just one field; `R` and `S` are never generated for these flavors. |
| `M204 S…` — `klipper` only | Change shared acceleration when an actual generated motion needs it, or restore it when required by the source. `P`, `T`, and `R` are never generated for this flavor. |
| `SAVE_GCODE_STATE NAME=ROLLING_BRIM_APP` | Once at entry, only when **Klipper state restore** is selected. |
| `RESTORE_GCODE_STATE NAME=ROLLING_BRIM_APP MOVE=0` | Once at exit, only when **Klipper state restore** is selected. This also restores the saved feed; no additional feed restore is emitted. |
| Semicolon comments (`;…`) | Block boundaries, selected settings, path markers, and slicer feature/width/height annotations. These do not execute printer commands. |

No other commands or parameters are generated. In particular, temperature commands (`M104`, `M109`, `M140`, `M190`, `SET_HEATER_TEMPERATURE`, etc.) are **outside the allowlist**, as are fan controls, flow/speed overrides, pressure advance, jerk, `SET_VELOCITY_LIMIT`, homing, mode-setting commands and `G92`. The app requires the necessary modes to be established in the source instead of reasserting them. The model-start fallback inherits acceleration without adding any `M204` commands.

Emission tracks the active feed and acceleration; matching values are omitted. It also looks past insertion: a source setting that will run before its next use makes an explicit restore unnecessary. A stationary step or handoff does not trigger acceleration changes. With Klipper's shared acceleration, alternating print and travel values can legitimately require repeated `M204 S…` commands; identical consecutive values are omitted. Regression tests check this positive allowlist and the omission of redundant settings.

## Stack and viewer choice

- React / TypeScript / Vite
- `gcode-preview` **3.0.0-alpha.6**, pinned, with Three.js **0.180.0**. Its Prusa width metadata, layer handling, and public scene access fit this workbench. The version is prerelease; the viewer is isolated from the export interpreter.
- `clipper2-ts`, a TypeScript port of Clipper2, running in a Web Worker. It avoids a WASM loader/runtime while keeping the polygon engine replaceable. Its behavior is verified on original sliced fixtures and a generated large program.
- `@chestnutlabs/gcode-bgcode` 0.20.1 supplies the MeatPack and heatshrink decoders. The app validates the container and handles binary insertion; DEFLATE uses the browser's bounded decompression stream.
- SVG for accurate first-layer inspection; no external fonts, analytics, file uploads, or runtime services.

Tests cover original-byte preservation, relative-E continuation and original resets, optional Klipper state restoration, exact insertion state after skirt settings, unknown state rejection, zero/exact travel lift, original PrusaSlicer sample parsing and generation, hole/pocket independence, too-small holes, width independence, positive gaps, bed clipping, and existing-path exclusion. Toolpath tests check outside-to-model order, uniform spacing against the supplied PrusaSlicer box, short connections without retraction, separate regions, open clipped contours, and motion-time accounting. The sample button uses the original clearance test plate. See [examples/README.md](examples/README.md) for a visual toggle guide, model provenance, reproduction commands, and optional private-file testing. The lizard is not bundled with the site.

## License

Rolling Brim's original application code, documentation, and original clearance-test-plate assets are licensed under the [MIT License](LICENSE), copyright © 2026 EllsworOpan. MIT permits use, modification and redistribution, including commercial use, while requiring the copyright and license notice to be retained. The software is provided without warranty; the safety notice above explains the practical limitations of edited G-code.

Third-party dependencies retain their own licenses. Runtime dependencies currently use MIT (`gcode-preview`, the Chestnut Labs decoder packages, MeatPack, Three.js, React, React DOM, Scheduler and lil-gui), ISC (heatshrink and `lucide-react`, including its Feather attribution), and Boost Software License 1.0 (`clipper2-ts`). Full notices are in [public/THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt) and are included in every build, alongside the app's MIT license. Both are linked in the website footer. Development tools retain the licenses in their own packages. See [decoder notice provenance](licenses/README.md) for license texts missing from the published npm archives.

When updating dependencies, run `npm ci` after updating the lockfile, then `npm run licenses` and commit the updated public notice files. `npm run check` and `npm run build` reject stale notices. The generator copies the app license from the root `LICENSE` and collects the installed runtime packages' license text and Clipper's source copyright notices.

The app's license does not grant rights to models or G-code supplied by its users. Export preserves the original file's notices and does not relicense it. See [examples/README.md](examples/README.md) for fixture provenance; the third-party lizard is not distributed here.
