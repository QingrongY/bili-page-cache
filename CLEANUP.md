# Local cleanup

## If you still use the extension

Keep the **extension** folder at the path shown on the browser's extensions page. An unpacked extension loads its code from that folder.

After closing any development test browsers, these files can be removed manually:

| Path | Contents | Restore later |
| --- | --- | --- |
| node_modules/ | Development dependencies | Run `npm ci`. |
| .test-profile/ | Local development browser profile, if present | Tests can create a new profile. |
| tests/fixture.mp4 | Generated test video | Use the FFmpeg command in TESTING.md. |
| test-results/ | Local test output, if present | Run the relevant tests again. |
| dist/ | Release ZIP files | Download a release or run the packaging script. |
| browser-console.cjs | Local browser debugging helper, if present | Not needed to use the extension. |
| TEST-RESULTS.md | Private development notes, if present | Not part of the public repository. |

The README, source files, and tests can be downloaded from GitHub again. Deleting development files does not remove saved video data from the browser.

## Remove video data

1. Open the extension popup and click **Delete all saved videos**.
2. Check that it reports zero bytes remaining.
3. Close any cached video tabs, or use **Clear cache** in each panel.

## Remove the extension entirely

Clear saved video data and close cached tabs first. Remove Bili Cache on the browser's extensions page, then delete the local installation folder if you no longer need it. Download the release again whenever you want to reinstall.
