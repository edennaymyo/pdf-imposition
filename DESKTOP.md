# Windows desktop build

The desktop app wraps the existing offline Vite interface in Electron. The renderer keeps Node.js integration disabled and runs with context isolation and Chromium sandboxing enabled.

## Run on macOS for development

```bash
npm install
npm run desktop
```

This builds the Vite app, then opens it in an Electron window.

## Produce the Windows installer

Push the `feature/windows-desktop` branch and open **Actions → Windows Desktop Build → Run workflow** on GitHub. Download the `repeat-pdf-imposition-windows` artifact when the job finishes. It contains:

```text
Repeat-PDF-Imposition-Setup-0.1.0.exe
```

The first prototype is unsigned, so Windows SmartScreen may show an unknown-publisher warning. Code signing can be added after the desktop workflow is stable.
