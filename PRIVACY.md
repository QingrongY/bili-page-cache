# Privacy

Bili Cache has no analytics, advertising, or application server. It does not send cached videos or browsing history to the developer.

## Page access

The extension accesses a tab after you click its toolbar action and enable it. It reads playback information and video URLs from the Bilibili player, then downloads the selected video and audio from the player's media servers. If necessary, it repeats the playback-information request already used by that page, using the browser's existing Bilibili session.

Normal Bilibili and media-server requests still expose the information those requests usually carry, such as your IP address and applicable session credentials. The extension does not export your login session.

## Local data

Temporary media data belongs to the enabled page and is released when that page closes or caching stops. The browser may store Blob data in memory or temporary disk files.

Clicking **Save for 7 days** writes the media data, media-path keys, quality label, and expiry time to the extension's IndexedDB database. Saved copies can be removed from the page panel or together from the toolbar popup. Expired records are removed by the cleanup worker. Browser shutdown, extension disablement, scheduling, and physical disk reclamation can delay deletion.

## Permissions

| Permission | Purpose |
| --- | --- |
| activeTab | Access the tab where you open the extension. |
| scripting | Add the cache controls and request handlers after you enable them. |
| alarms | Wake the cleanup worker to remove expired saved copies. |

There are no always-on content scripts or broad host permissions. A storage frame can be opened on Bilibili pages to exchange cached Blob data with the extension's database. The cleanup worker does not open video pages or download media.
