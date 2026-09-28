# Contributing

Use an issue to report a bug or suggest a change. Include your browser version, extension version, video type, selected quality and steps to reproduce. Leave out cookies and signed media URLs.

## Run the tests

Install Node.js 22 or later, Edge or Chrome, and FFmpeg on your PATH.

~~~sh
npm ci
npm test
~~~

Tests use generated media and separate browser profiles. Set BROWSER=chrome to test Chrome, or BROWSER_PATH to use a specific browser executable.

Run npm run test:large to check an 8 GB saved copy, browser restart, capacity limits and disk cleanup. Set LARGE_DOWNLOAD=1 to include a full concurrent download through the installed extension. Allow at least 25 GB of free disk space.

## Build

On Windows, run npm run package. It produces the manual installation ZIP, a store ZIP with the manifest at its root, store images and SHA-256 checksums in dist.

Run npm run assets to regenerate icons and screenshots. Extension code has no build step or runtime dependencies.

Open a pull request against main. Actions test Edge and Chrome before packaging. A v tag matching the manifest version also runs the large-file test and creates a GitHub release.
