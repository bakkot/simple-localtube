# simple-localtube

A tiny node.js project for hosting a local youtube clone, using yt-dlp to subscribe to channels.

Dependencies are kept to a minimum. This is not going to require docker, elasticsearch, redis, or event react.

## Setup

Make sure you have node v23.6.0 or later so you have support for executing typescript without transpilation.

Have `yt-dlp` in your PATH, or provide `YT_DLP_PATH` as an environment variable.

Have `ffmpeg` in your path for use by `yt-dlp`.

`npm ci` to install dependencies.

