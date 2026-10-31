# Queue sync report (branch `queue-sync`)

## What changed
- `src/services/AutoSyncService.ts` (new): server-side upload queue for the job library. Started and stopped in `src/index.ts` next to the light timer. Ticks every 10 s, uses the existing polling data (`Ready` and polled within 30 s) and one fresh status request right before a send. With nothing queued it makes no printer request.
- State in `<data dir>/library-sync.json`: per file `name, size, modified, state (queued|synced|failed|unsynced), queuedAt, syncedAt, attempts, lastError, nextAttemptAt`; plus `lastPrintedFile`. Written atomically (temp file + rename), writes serialised.
- Order: oldest `queuedAt` first, one file per tick, upload only (`startNow=false`, `leveling=false`) through `backendManager.startJob`, the same call as the manual Send route. Nothing in the code starts a print.
- Retry delays 30 s, 1, 2, 4 min; `failed` after 5 attempts; Retry button / `POST .../requeue` resets it.
- Half-written files: `FileLibraryService.save` already streams to `.upload-*.part` and renames, and `list()` ignores dot-files, so a listed file is complete. No change needed. Direct writes into the library directory (outside the API) are not protected.
- Overwrite detection: size or mtime differs from the record => queued again, also if it changes during a send (then the send's result is discarded and it stays queued).
- Restart mid-send: the record is never `synced` before the send returns, so the file is sent again after a restart.
- First run (no `library-sync.json`): existing library files become `unsynced` + baseline flag, saved at once. When the printer is first `Ready`, names in `getLocalJobs` become `synced` (without `syncedAt`, so cleanup never touches them).
- Multiple printers: only the active context is served.
- Manual Send marks the file `synced`. `GET /api/files/library` adds `syncState`, `syncedAt`, `lastError`. `POST /api/files/library/<name>/requeue` (409 if auto-sync is off).
- UI: badge per file (On printer green, Queued amber, Failed red with tooltip + Retry, Not synced grey). While the modal is open it polls every 10 s; if the file list is unchanged only the badges are updated (no thumbnail reload).

## Config keys (`config.json`, added to `DEFAULT_CONFIG`; existing files get them on the next load)
| Key | Default |
|---|---|
| `AutoSyncEnabled` | `true` |
| `AutoSyncCleanupEnabled` | `false` |
| `AutoSyncCleanupDryRun` | `true` (so switching cleanup on only logs until this is set to `false`) |
| `AutoSyncCleanupKeepNewest` | `15` (minimum 1 in code) |

The 24 h minimum age is a constant, not a key. There is no "delete foreign files" option: cleanup works from our records only, which is stricter than the request.

## What the Creator 5 API offers (investigated in `@ghosttypes/ff-api` 2.0.3 and the repo)
- File list: only the 10 most recent names (`/gcodeList`). No full list, so baseline cannot see older files.
- Delete: none. Endpoints are Control, Detail, GCodeList, GCodePrint, GCodeThumb, Product, UploadFile. `FileManagerService` (SFTP delete) supports only AD5X and Adventurer 5M family, not the Creator 5.
- Storage: `/detail` has `remainingDiskSpace` (ff-api exposes `FreeDiskSpace`); no total capacity. This fork does not read it and I could not check whether the Creator 5 fills it.
- Result: the cleanup policy, dry run and logging are implemented and tested, but on a Creator 5 it logs once that the printer cannot delete and does nothing. The real delete path (SFTP) is only for the other models and is untested.

## Tests
- `src/services/AutoSyncService.test.ts`: 34 tests (baseline, ordering, ready-only, busy on fresh check, disconnected, overwrite, replace during send, restart mid-send, backoff and failed, requeue, cleanup policy incl. 24 h, newest N, protected files, dry run, no-delete printers, delete failure backoff).
- `file-library-routes.test.ts`: new test for list fields, requeue, manual send marks synced.
- Full suite: before (galvopi) 41 suites / 554 tests pass; after 42 suites / 589 tests pass. No failures, none pre-existing. `tsc` clean for backend and static; `biome check` clean on the changed files (one pre-existing `noExplicitAny` warning in the route test).
- The UI was only type-checked, not opened in a browser.

## Build
`npx pnpm@10.23.0 run build` and `pkg ... node20-linux-arm64` as in FORK_NOTES worked on Linux (pnpm was not installed; used `npx pnpm@10.23.0`).
`dist/flashforge-webui-linux-arm64`, 202581975 bytes, sha256 `84c405a418af7672afa9bb45d9e38acc438808eade333eff62e47e97f2edccb9` (`dist/` is git-ignored). It was not run on arm64 here.

## Open risks / unverified on a real printer
1. Readiness: relies on the polling state being `Ready` after the operator clears a finished job. Not checked on firmware 1.9.5. If a cleared printer reports another state, nothing is ever sent.
2. Upload while "Ready" is not locked against a print started on the touchscreen at the same moment; the window is one status request. A manual Send and an auto send could also overlap.
3. Baseline is limited to the 10 names the Creator 5 lists, so older library files appear as Not synced although they may be on the printer. Renaming a library file queues it as a new file (printer cannot rename).
4. `AutoSyncEnabled` defaults to true: after deploying, any new library upload goes to the printer by itself.
5. Retained records: synced files removed from the library keep their record (so cleanup can still find them); with cleanup off they stay in the JSON.
6. SFTP cleanup path (AD5X / 5M) untested.
