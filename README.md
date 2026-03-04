# mdmate Technical README

## What this app is
Electron Markdown workspace with:
- Left pane: markdown source editor (CodeMirror)
- Right pane: rendered editable preview
- Confluence Cloud export assistant (text + per-diagram PNG copy/download)
- Mermaid rendering
- ASCII/text-art rendering and editing via embedded AsciiFlow
- Local folder/file sync with autosave + conflict handling

## Runtime architecture
- `main.js`: Electron main process, IPC handlers, workspace IO/watch (`chokidar`)
- `preload.js`: safe renderer API (`window.mdtoolFs`)
- `app.js`: renderer logic (editor, preview, sync, Confluence copy flow, AsciiFlow popup)
- `style.css`: renderer UI styles

## AsciiFlow integration
- Vendored source: `vendor/asciiflow/client`, `vendor/asciiflow/common`
- Build script: `scripts/build-asciiflow.mjs`
- Built runtime output: `assets/asciiflow/`
- Embedded popup loads `assets/asciiflow` and uses bridge methods on `window.__asciiflow__`
- Font used for ASCII/text-art rendering: `assets/fonts/SourceCodePro-Regular.ttf`, `assets/fonts/SourceCodePro-Medium.ttf`

## Dev commands
- Install deps: `npm install`
- Run app: `npm run dev`
- Rebuild embedded AsciiFlow bundle: `npm run build:asciiflow`
- Package app: `npm run package`

## AsciiFlow upgrade (very concise)
1. Replace vendored code:
   - overwrite `vendor/asciiflow/client` and `vendor/asciiflow/common` from the new upstream version.
2. Re-apply bridge methods in `vendor/asciiflow/client/app.tsx`:
   - `setCommittedText(value)` and `clearCommittedText()` inside `window.__asciiflow__`.
3. Ensure Source Code Pro font files still exist:
   - `assets/fonts/SourceCodePro-Regular.ttf`
   - `assets/fonts/SourceCodePro-Medium.ttf`
4. Rebuild embedded AsciiFlow:
   - `npm run build:asciiflow`
5. Smoke test:
   - open an `ascii|text|plain|txt` block -> click `Edit` -> diagram appears in popup with toolbar.
   - click `Apply` -> markdown + preview update.
   - `Copy for Confluence` still produces text placeholders + PNG diagram actions.

## Notes
- If upstream AsciiFlow changes `#asciiflow/*` import behavior, update resolver logic in `scripts/build-asciiflow.mjs`.
- If popup opens but diagram is blank, use `Reload Source`; this typically indicates delayed route/store hydration.
