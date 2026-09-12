// Makes the shipped copy of the download engine wear the product's name.
//
// The engine is yt-dlp. A customer who opens
// Program Files\Velox Downloader\resources\bin should see the product they
// paid for, not the name of a tool they could have fetched themselves. So the
// build copies bin/yt-dlp.exe to the shipped name and package.json ships the
// copy (build.extraResources). The original is left untouched, so a dev
// checkout keeps working either way.
//
// yt-dlp is released into the public domain (Unlicense), so shipping it under
// another name is allowed. The licences of everything bundled inside it stay
// where they are, in bin/_internal/THIRD_PARTY_LICENSES.txt.
//
// ── Do NOT rcedit this file ────────────────────────────────────────────────
// The obvious next step is to rewrite the version block too, because Windows
// still shows "yt-dlp" under Properties → Details. It was tried: rcedit
// rewrites the PE resource section, and that moves the CArchive PyInstaller
// appends to the end of the executable. The result still looks like a valid
// .exe and fails at run time with:
//
//   [PYI-20504:ERROR] Could not load PyInstaller's embedded PKG archive
//
// Renaming the file is safe; editing its resources is not. Hiding the name in
// the properties dialog needs the engine rebuilt from source with its own
// version block, which is a much bigger job than it looks.
//
// Run by `npm run prebuild`; safe to run by hand at any time.

const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin');
const SOURCE = path.join(BIN, 'yt-dlp.exe');
const SHIPPED = path.join(BIN, 'velox-core.exe');

function main() {
  if (process.platform !== 'win32') return;           // only the Windows build ships this
  if (!fs.existsSync(SOURCE)) {
    console.log('[brand] bin/yt-dlp.exe is not here — nothing to brand');
    return;
  }
  fs.copyFileSync(SOURCE, SHIPPED);
  console.log(`[brand] ${path.basename(SOURCE)} -> ${path.basename(SHIPPED)}`);
}

main();
