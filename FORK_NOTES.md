# Fork notes: FlashForgeWebUI for a Creator 5 on a small board

This is [Parallel-7/FlashForgeWebUI](https://github.com/Parallel-7/FlashForgeWebUI) (MIT) at
`origin/alpha` 21e9e32 plus the changes below, built for and tested on a Flashforge Creator 5
(firmware 1.9.5) served from an Orange Pi Zero 2 (1 GB RAM). The `galvopi` branch is the
working branch; it is not an upstream release and has not been proposed upstream.

## What this adds

| Feature | Where |
|---|---|
| **Job library**: G-code/3MF files kept on the WebUI host. Upload with progress, thumbnails and slicer details, rename, download, delete, *Send to printer* (upload only, idle printers only), *Print...* (opens the existing Upload Job dialog with material matching), *View* | `src/services/FileLibraryService.ts`, `src/webui/server/routes/file-library-routes.ts`, `src/webui/static/features/file-library.ts` |
| **Live G-code viewer**: draws the layer being printed in tool colours with a nozzle marker, layer slider, preview of library files | `src/services/GcodeViewService.ts`, `src/webui/server/routes/gcode-view-routes.ts`, `src/webui/static/features/gcode-viewer.ts` |
| **Job weight and length** for firmware that reports none, measured from the lifetime filament counter | `src/services/FilamentUsageTracker.ts` (used by `DualAPIBackend`) |
| **Print speed slider** (50-200 %) | `Creator5Backend.setPrintSpeed`, `POST /api/printer/control/speed`, `src/webui/static/features/print-speed.ts` |
| Recent/Local Files usable on the Creator 5 again (started as sliced, after a confirmation) | `panels.ts`, `dialogs.ts`, `job-control.ts` |
| Default layout that tiles for the Creator 5 panel set | `WebUIComponentRegistry.ts` |

## Creator 5 findings these rely on (measured, firmware 1.9.5)

- `printProgress` is the **byte position in the G-code file** divided by its size. On a 100-layer,
  4-tool test print it matched the file offset of all 220 tool changes to within 0.0001. The viewer
  is built on this.
- `printLayer` is derived from the Z height, not a layer counter. It jumps by 2 to 8 during z-hops
  and tool changes and is wrong for the first seconds of a job. Do not use it.
- The printer lists only file names, so there is no tool data for files already on it; they can be
  started as sliced (tool N prints from slot N) but not remapped.
- Estimated filament length and weight are always 0. The lifetime counter (`cumulativeFilament`,
  metres) does advance during a print; the tracker used it to get within about 2 % of the slicer's
  figure on a full job.
- `printerCtl_cmd` (speed, Z offset, fans) is a **partial update**: a field sent as `-200` is left
  unchanged. `Control.setSpeedOverride` in `@ghosttypes/ff-api` sends 0 / 100 / 100 for the other
  fields and would reset the Z offset and fans, so it is not used. Reference:
  [flashforge-api-docs](https://github.com/Parallel-7/flashforge-api-docs), `endpoints_creator5_1.9.2.yaml`.

## Not yet verified on a real printer

- The speed slider (tested against a mock that records the exact command).
- Sliced 3MF jobs in the viewer (assumes progress refers to the embedded plate G-code).
- A phone-sized layout of the viewer.

## Build and deploy (aarch64 Linux target, built on Windows)

The upstream `build:linux-arm` script fails when cross-building on Windows. This works:

```bash
pnpm install
pnpm run build
pnpm exec pkg . --targets node20-linux-arm64 --no-bytecode --public-packages "*" --public \
  --output dist/flashforge-webui-linux-arm64
```

Copy the binary to the board and run it with a data directory, e.g.
`DATA_DIR=/home/user/ffwebui/data ./flashforge-webui --last-used`. The data directory holds
`config.json` (web password, port) and `printer_details.json` (printer IP, serial, check code);
neither belongs in version control. See upstream's README for the rest.

Do not run `biome check --write` with globs over the whole tree; it reformats unrelated upstream files.
