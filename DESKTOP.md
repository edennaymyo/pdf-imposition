# Windows desktop build

The desktop app wraps the offline Vite interface in Electron. Node.js integration stays disabled; context isolation and Chromium sandboxing stay enabled.

## Version 0.2.0

- Single-sided and Front/Back PDF preview and export.
- Independent artwork rotation/reset and repeated grid patterns.
- Compact Artwork, Layout, and Duplo controls; saved presets.
- Barcode overlap is allowed without warnings or approval. White knockout and top-layer placement stay enabled.
- Top-right corner trim marks are hidden on barcode sides and restored when barcode is off. Registration and gutter marks remain unchanged.

## Build the Windows installer

GitHub Actions builds on a Windows runner when `feature/front-back-duplex` or `feature/windows-desktop` is pushed. It can also be started with **Actions → Windows Desktop Build → Run workflow**, selecting the branch that contains the intended changes.

The workflow runs tests, builds the app, and packages an x64 NSIS installer. Download and extract the `repeat-pdf-imposition-windows` artifact:

```text
Repeat-PDF-Imposition-Setup-0.2.0.exe
Repeat-PDF-Imposition-Setup-0.2.0.exe.sha256
```

Build directly on Windows with Node.js 22 installed:

```powershell
npm ci
npm run desktop:win
```

Output is in `release/`. GitHub's source-code ZIP is not the installer. Building does not automatically create or publish a public release.

## Install and verify

Run the installer on a Windows x64 computer, then launch **Repeat PDF Imposition** from the Start menu or desktop shortcut. Node.js and a localhost server are not required on the user's computer.

The build is unsigned, so Windows may show an unknown-publisher warning. Verify its source/checksum and follow your organization's security policy. Do not disable security protections globally.

Before production use, verify:

1. Upload a two-page PDF, choose Front and Back, rotate, and preview both sides.
2. Load a barcode folder (use **Load folder for this session** if persistent folder access is unavailable).
3. Export with an overlapping barcode; no overlap approval is needed. Check white knockout, registration, and top-right corner mark suppression.
4. Save/apply a preset, restart, and check persistence. Desktop presets are separate from browser presets.
5. Disconnect the network and repeat upload/preview/export. Fonts may fall back to locally installed fonts; PDF processing stays local.
6. Print at 100%, check physical front/back alignment, and scan the job barcode on the Duplo machine.

## Run on macOS for development

```bash
npm ci
npm run desktop
```

macOS desktop smoke tests do not replace testing the Windows installer on a Windows computer.
