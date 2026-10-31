# Fork notes: FlashForgeWebUI for a Creator 5 on a small board

This is [Parallel-7/FlashForgeWebUI](https://github.com/Parallel-7/FlashForgeWebUI) (MIT) at
`origin/alpha` 21e9e32 plus the changes below, built for and tested on a Flashforge Creator 5
(firmware 1.9.5) served from an Orange Pi Zero 2 (1 GB RAM). The `galvopi` branch is the
working branch; it is not an upstream release and has not been proposed upstream.

## What this adds

| Feature | Where |
|---|---|
| **Job library**: G-code/3MF files kept on the WebUI host. Upload with progress, thumbnails and slicer details, rename, download, delete, *Send to printer* (upload only, idle printers only), *Print...* (opens the existing Upload Job dialog with material matching), *View* | `src/services/FileLibraryService.ts`, `src/webui/server/routes/file-library-routes.ts`, `src/webui/static/features/file-library.ts` |
| **Upload queue (auto-sync)**: files PUT into the library are sent to the idle printer by the server (upload only, never started), with per-file markers in the library list and optional cleanup of old files on the printer | `src/services/AutoSyncService.ts`, `GET /api/files/library`, `POST /api/files/library/<name>/requeue`, `src/webui/static/features/file-library.ts` |
| **Live G-code viewer**: draws the layer being printed in tool colours with a nozzle marker, layer slider, preview of library files | `src/services/GcodeViewService.ts`, `src/webui/server/routes/gcode-view-routes.ts`, `src/webui/static/features/gcode-viewer.ts` |
| **Job weight and length** for firmware that reports none, measured from the lifetime filament counter | `src/services/FilamentUsageTracker.ts` (used by `DualAPIBackend`) |
| **Light timer**: daily auto-off at a set time and one-shot "off in 30 min / 1 h / 2 h / 4 h" timers, run by the server (works with no browser open), state in `<data dir>/light-timer.json` | `src/services/LightTimerService.ts`, `src/webui/server/routes/light-timer-routes.ts`, `src/webui/static/features/light-timer.ts` |
| **Print speed slider** (50-200 %) | `Creator5Backend.setPrintSpeed`, `POST /api/printer/control/speed`, `src/webui/static/features/print-speed.ts` |
| Recent/Local Files usable on the Creator 5 again (started as sliced, after a confirmation) | `panels.ts`, `dialogs.ts`, `job-control.ts` |
| Default layout that tiles for the Creator 5 panel set | `WebUIComponentRegistry.ts` |

## Upload queue for agents and scripts

After logging in, `PUT /api/files/library/<name>` with the raw file as the body (`?overwrite=1` to replace).
The upload is written to a temporary file and renamed, so the server never sees a half-written file.
Within about 10 seconds of the printer being **ready** (not printing, paused, or finished and waiting to be
cleared on the touchscreen), the oldest queued file is uploaded to the printer, one file per cycle. Nothing is
ever started. Clearing a finished job on the touchscreen is what lets the next file go.

State per file is kept in `<data dir>/library-sync.json`. Markers in the library list:

| Marker | Meaning |
|---|---|
| **On printer** (green) | Sent by the queue or by hand, or listed by the printer at the first run |
| **Queued** (amber) | Waiting for a ready printer, or waiting out a retry delay |
| **Failed** (red) | 5 failed attempts; the tooltip shows the last error; **Retry** queues it again |
| **Not synced** (grey) | Not queued: in the library at the first run but not on the printer's list, cleaned off the printer, or auto-sync was off when it arrived. The manual **Send to printer** works |

Overwriting a file queues it again. Files already in the library when the service first runs are not queued
(the Creator 5 lists only its 10 most recent files, so older ones show as Not synced). Retries wait 30 s, 1 min,
2 min, 4 min between attempts. Only the active printer context is served.

### Config keys (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `AutoSyncEnabled` | `true` | `false` stops all sending; new files then show as Not synced |
| `AutoSyncCleanupEnabled` | `false` | Delete old files from the printer (see below) |
| `AutoSyncCleanupDryRun` | `true` | With cleanup on, only log `would delete ...` |
| `AutoSyncCleanupKeepNewest` | `15` | Newest synced files to keep (at least 1) |

Cleanup runs only when the printer is ready and the queue is empty. It deletes one file per cycle, only files this
service synced (never files found on the printer at the first run or put there by the touchscreen or a slicer),
oldest first, never the printing or last printed file, never anything synced less than 24 hours ago. Every
deletion is logged. A deleted file stays in the library as Not synced. **The Creator 5 HTTP API has no delete
call and the SFTP file manager does not support it, so cleanup does nothing there** (it logs that once). It acts
only on models with SFTP file management (AD5X, Adventurer 5M family); that path is untested on a real printer.

## Creator 5 findings these rely on (measured, firmware 1.9.5)

- `printProgress` is the **byte position in the G-code file** divided by its size. On a 100-layer,
  4-tool test print it matched the file offset of all 220 tool changes to within 0.0001. The viewer
  is built on this.
- `printLayer` is derived from the Z height, not a layer counter. It jumps by 2 to 8 during z-hops
  and tool changes and is wrong for the first seconds of a job. Do not use it.
- The printer lists only file names, so there is no tool data for files already on it; they can be
  started as sliced (tool N prints from slot N) but not remapped.
- `/detail` carries `remainingDiskSpace` (free internal storage, exposed by `ff-api` as `FreeDiskSpace`) but this
  fork does not read it, and whether the Creator 5 fills it is unverified. The HTTP API has no file delete, no
  storage size and lists only the 10 most recent file names.
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
- Auto-sync against a real Creator 5: the upload while `Ready`, the state names the firmware reports after a job
  is cleared on the touchscreen, and the polling data used to decide readiness. Tested against mocks only.
- Printer-side cleanup (SFTP models only).

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
