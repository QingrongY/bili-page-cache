# Bili Cache

An Edge and Chrome extension that caches the video and audio selected in the Bilibili player. Open it from the toolbar when you need it. The player, timeline, and comments stay on the page.

[Download the latest release](https://github.com/QingrongY/bili-page-cache/releases/latest)

<img src="docs/panel.png" width="304" alt="Bili Cache showing a completed video cache">

Example panel with sample download size.

## Install

1. Download `BiliCache-0.6.0.zip` from Releases and extract it to a folder you will keep.
2. Open `edge://extensions` or `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted **extension** folder.
4. Open a Bilibili video, click the extension icon, and choose **Enable on this tab**.

This is a GitHub release. It is not listed in the Edge or Chrome extension store. No local server or Node.js installation is needed to use it.

## Cache a video

Choose a fixed quality, such as 4K, in the Bilibili player. Play for a few seconds so the player selects its video and audio tracks. You can then pause it and click **Cache video**.

Keep that quality and audio track selected. Changing either may select a different file that is not cached. The panel reports progress, download speed, and estimated time remaining.

| Control | What it does |
| --- | --- |
| Cache video | Downloads the selected video and audio into a temporary cache. |
| Cancel | Stops the download and releases its cached parts. |
| Clear cache | Releases this tab's temporary cache. Saved copies remain. |
| Save for 7 days | Writes a complete cache to extension storage. Keep the tab open until saving finishes. |
| Renew for 7 days | Replaces the saved copy and starts a new seven-day period. |
| Delete saved | Deletes the saved copy. This tab can keep using its temporary cache. |
| Close (×) | Stops caching, releases the temporary cache, and removes the panel. |

Closing, refreshing, or leaving the video page disables caching on that page. Open the extension again to use it on another page.

### Playback during download

**Play downloaded parts** is on by default. A playback request is served locally only when every requested byte is already cached. Requests with missing bytes use the network. Seeking to an uncached position can still buffer, and playback shares bandwidth with the download.

This works with DASH requests made through the page's fetch or XMLHttpRequest functions. A video playing directly from an MP4 URL switches to the cache only after the whole file is downloaded.

### Download options

- **Connections:** 4 video requests by default; choose 1 or 8 under **Options**. Audio uses one request. More connections do not always improve speed.
- **Choose the fastest server:** checks up to four server addresses supplied by the player for the same file, then uses the fastest measured address. Each check reads at most 256 KiB per server, with two checks at a time and a three-second timeout.
- Slow downloads can trigger another server check after a cooldown. Completed parts are kept. The extension cannot change your accelerator or VPN route, and a short speed check cannot guarantee the fastest connection throughout a download.

## Saved videos and cleanup

Saved copies use the extension's IndexedDB storage. They are not exported to Downloads or stored in Bilibili's site database. The expiry time is shown in the panel. To reuse a copy, open the same video, select the same quality and audio, and enable the extension. If playback details are not ready yet, play briefly and click **Cache video** to check again.

A cleanup alarm is registered before saving. Expired copies cannot be restored. The extension checks for expired data every 30 minutes while the browser is running, and also when the browser starts or the extension is updated. Cleanup does not require the original video tab to remain open.

The toolbar popup shows the number and size of all saved copies. **Delete all saved videos** removes them and checks that the remaining count and stored media size are zero. Each video's data and index are saved or deleted in one transaction; a failed write rolls back both. Renewing a copy replaces its record.

The browser cannot run cleanup while it is closed or the extension is disabled. It handles physical disk reclamation itself, so a logical size of zero does not mean its database files shrink immediately. This extension does not promise secure disk erasure.

## Limits

- The original player must provide access to the selected quality. Cached bytes do not replace login, playback metadata, or any other requirements of the original player. This is not a guarantee of fully offline playback.
- Supports MP4 and DASH. Live streams, multi-part FLV, and requests made inside workers are not supported.
- Maximum size is 12 GiB per track. Saving can fail if disk space or the browser's storage quota is exhausted; the current temporary cache remains available.
- A completed cache avoids network waits for supported requests. Decoding, keyframes, and hardware still affect seek time.
- Unfinished downloads cannot resume after a refresh. Browser storage eviction can remove saved copies before expiry.
- Bilibili player changes may break compatibility. Local tests do not establish compatibility with every title or 4K stream.

## Update or remove

Extract a new release into the same installation folder, then click **Reload** on the browser's extensions page. An already open page may keep its earlier cache code until you close its panel and enable it again. Do that only when you are ready to discard its temporary cache.

To remove saved video data, use **Delete all saved videos** first. Close cached video tabs to release their temporary data. You can then remove the extension through the browser's extensions page.

Keep the **extension** folder while using an unpacked installation. Deleting that folder breaks the installed extension. See [local cleanup](CLEANUP.md) for development files you can remove yourself.

## Development

Requires Node.js, Microsoft Edge, and FFmpeg on PATH. Tests run in separate, muted browser profiles and use generated media.

```powershell
npm ci
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 12 -c:v libx264 -preset ultrafast -g 24 -pix_fmt yuv420p -c:a aac -movflags +faststart -y tests/fixture.mp4
npm test
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

[Testing](TESTING.md) · [Privacy](PRIVACY.md) · [Changes](CHANGELOG.md) · [ISC license](LICENSE)
