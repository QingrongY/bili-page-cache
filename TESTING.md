# Testing

The browser suite runs with Microsoft Edge, Playwright, and generated video and audio. It uses isolated browser profiles and muted playback.

## Coverage

- Sequential and parallel byte-range downloads, out-of-order completion, exact file assembly, retries, and cancellation.
- Servers that ignore Range headers, automatic server selection, and switching after a slowdown without discarding completed chunks.
- Local fetch and XMLHttpRequest responses, invalid ranges, missing ranges falling back to the network, and clearing cached data.
- Actual MediaSource playback while later download chunks are blocked.
- Seeking in a completed local MP4 with network access disabled.
- Manual activation, close, navigation, extension reloads, popup errors, and late playback metadata.
- Explicit seven-day saving, restoring after a reload, deleting a saved copy, expiry, and transaction rollback after an index write fails.
- Blob transfer to extension-owned storage, replacing a saved copy without duplication, expiry cleanup after the video tab closes and the worker stops, and deleting all saved copies from the popup.

Run `npm test` after generating the fixture below. The suite currently contains 19 tests.

Release 0.6.0: all 19 tests passed on September 28, 2026. The English panel was also rendered and checked at its default size with Options collapsed; no horizontal overflow was found.

## Run locally

Requires Node.js, Microsoft Edge, and FFmpeg on PATH.

```powershell
npm ci
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 12 -c:v libx264 -preset ultrafast -g 24 -pix_fmt yuv420p -c:a aac -movflags +faststart -y tests/fixture.mp4
npm test
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```
