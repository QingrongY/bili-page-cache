# Privacy

Bili Cache stores video data locally. It has no analytics or developer server.

When enabled on a tab, it reads the selected video and audio URLs from Bilibili and downloads those files from the player's media servers. Playback-information requests use the browser's existing Bilibili session.

Temporary data is released when the tab closes. Saved copies include media data, media-path keys, quality, and an expiry date in the extension's IndexedDB storage. Delete them from the panel or toolbar popup. Expired copies are checked every 30 minutes and at browser startup. Edge or Chrome manages physical disk reclamation.

## Permissions

| Permission | Used for |
| --- | --- |
| activeTab | Access the tab where you open the extension. |
| scripting | Add the cache panel and playback handlers after you enable it. |
| alarms | Remove expired saved copies in the background. |
