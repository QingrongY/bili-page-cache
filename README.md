# Bili Cache

Cache Bilibili videos in Edge or Chrome. Play downloaded parts as they arrive, or save a complete video for 7 days.

[Download](https://github.com/QingrongY/bili-page-cache/releases/latest)

<img src="docs/panel.png" width="304" alt="Bili Cache panel">

## Install

1. Download the release ZIP and extract it.
2. Open `edge://extensions` or `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the **extension** folder. Keep this folder in place while using the extension.

## Use

1. Open a Bilibili video and select a fixed quality, such as 4K.
2. Play for a few seconds, then open Bili Cache from the toolbar and click **Enable on this tab**.
3. Click **Cache video**. You can pause playback while it downloads.

The panel shows download size, speed, and time remaining. Downloaded parts are available during playback; seeking ahead of the cache uses the network. Direct MP4 playback switches to the cache when the download finishes.

**Options** includes the number of download connections, automatic server selection, and playback from downloaded parts. The default is four video connections and one audio connection.

## Save and delete

- **Save for 7 days** keeps a completed video after the tab closes. Wait for the expiry date to appear before closing the tab.
- To reuse it, open the same video, select the same quality and audio track, and enable Bili Cache.
- **Renew for 7 days** resets the expiry date. **Delete saved** removes the saved copy.
- **Clear cache** clears the current tab's temporary cache. Unsaved data is also cleared when the tab closes.
- **Delete all saved videos**, in the toolbar popup, clears all saved copies and shows the remaining storage.

Expired copies are removed every 30 minutes while the browser runs, and on the next browser start.

## Supported playback

MP4 and DASH, up to 12 GiB per track. Live streams and multi-part FLV are not supported. Playback uses the original Bilibili player and its current login session. Downloads restart after a page refresh.

## Update

Extract the new release into your installation folder and click **Reload** on the extensions page. Close and reopen the cache panel to use the new version on an existing tab; this clears that tab's temporary cache.

[Local cleanup](CLEANUP.md) · [Development and tests](TESTING.md) · [Privacy](PRIVACY.md) · [Changes](CHANGELOG.md) · [License](LICENSE)
