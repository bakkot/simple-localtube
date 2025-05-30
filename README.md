# simple-localtube

A tiny node.js project for hosting a local youtube clone, using yt-dlp to subscribe to channels.

Dependencies are kept to a minimum. This is not going to require docker, elasticsearch, redis, or event react.

It is intended as an alternative to heavier tools like [TubeArchivist](https://www.tubearchivist.com/) or [Jellyfin](https://jellyfin.org/), mostly because those tools either store data in a way I don't like or have excessive breaking changes.

## Threat model

This project is designed to be secure against a reasonably bright 10-year-old. It is _not_ designed to be exposed to the open internet. In particular, while I am (to the best of my knowledge) following reasonable practices for password handling, there have been no security audits and _there is no rate-limiting on the login form_.

It is also assumed that it's OK for anyone with access to the server (even without an account) to cause videos to be added to the UI as long as they're already on disk.

## No breaking changes

It is my intention that this project (once it hits 1.0) will never have a breaking change, so you can safely upgrade from any version to any later version.

### Isn't JavaScript a bad choice for that?

No. JavaScript as a programming language has an almost religious commitment to not shipping breaking changes (as one of the ~~high priests~~ editors of the JS specification, I should know). This is not true of many [other languages](https://docs.python.org/3/whatsnew/3.13.html#removed-modules-and-apis).

Node.js does ship breaking changes every six months, but these rarely break applications unless they are relying on the V8 API or using native dependencies, which this project does not (made possible by node's recent inclusion of [sqlite](https://nodejs.org/api/sqlite.html) in its standard library).

JavaScript's reputation for frequent breaking changes mostly comes from people's experience with certain build tools and frontend frameworks, neither of which this project uses.

## Setup

Make sure you have node v24 or later.

Have `yt-dlp` in your PATH, or provide `YT_DLP_PATH` as an environment variable.

Have `ffmpeg` in your path for use by `yt-dlp`.

`npm ci` to install dependencies.

