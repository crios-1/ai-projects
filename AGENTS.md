# ai-projects

This repository hosts standalone projects. Each project lives in its own top-level directory.

## Projects

- `space-invader/` — Electron + TypeScript desktop app: a visually rich disk-space analyzer and cleaner (treemap visualization, largest-files/file-type breakdowns, delete to Trash or permanently, and "unlock & delete" for paths held open by other processes).

## Cursor Cloud specific instructions

These notes are for agents working in the Cursor Cloud VM (the update script has already installed dependencies).

### Space Invader (`space-invader/`)

- Standard commands live in `space-invader/package.json` scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`. Run them from the `space-invader/` directory.
- **Running the GUI**: `npm run dev` (electron-vite) launches the Electron window. The VM has a live X display at `DISPLAY=:1`, so run with `DISPLAY=:1 npm run dev`. If no display is attached, wrap with `xvfb-run -a npm run dev`. The main process auto-adds `--no-sandbox` on Linux (the Chromium SUID sandbox is not configured in this container), so no extra flags are needed.
- `dbus`/`atom_cache` errors in the Electron console are benign in this headless container and do not affect functionality.
- **Electron binary**: a plain `npm install` here has sometimes skipped Electron's binary download. If `node_modules/electron/path.txt` or `node_modules/electron/dist/` is missing, run `node node_modules/electron/install.js` (the update script already does this). Symptom when missing: `electron-vite dev` fails with `Error: Electron uninstall`.
- **Tests**: `npm test` runs an integration test of the lock-detection/unlock subsystem via Node type-stripping (`node --experimental-strip-types test/unlock.integration.ts`). It spawns a `tail -f` holder, so it requires the `lsof` binary (present in this VM).
- **Unlock feature caveat**: lock detection uses `lsof` on Linux/macOS (Windows is stubbed). On Linux the kernel allows deleting files that are open, so the GUI's "locked" modal generally won't trigger from normal open files — that branch is primarily for Windows. The detection + process-termination logic itself is covered by `npm test`.
- HMR updates the renderer instantly; changes to `src/main/**` or `src/preload/**` restart the Electron process automatically.
- The disk scan runs in a Node worker thread (`src/main/scan-worker.ts`, emitted to `out/main/scan-worker.js`). Any new worker entry must be added to `main.build.rollupOptions.input` in `electron.vite.config.ts`, otherwise the worker file won't be built and `new Worker(...)` will fail at runtime.
- **Packaging installers**: `npm run dist:win` builds a Windows NSIS installer via electron-builder (config in `electron-builder.yml`; output in `release/`, which is gitignored). Cross-building the Windows target from this Linux VM requires Wine on PATH (`sudo apt-get install -y wine`); without it electron-builder fails at the NSIS step with `spawn wine ENOENT`. The unpacked app and the `.exe` are produced under `release/`. Wine is NOT part of the dev/update setup — install it only when you need to package a Windows build.
