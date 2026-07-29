# Third-Party Notices

This application includes the following runtime open-source components.

## ArtPlayer 5.4.0

- Project: ArtPlayer.js
- Copyright: Harvey Zhao
- License: MIT
- Purpose: experimental in-application HTML5 player UI and control layer

## option-validator 2.0.6

- Copyright (c) 2018 Harvey Zack
- License: MIT
- Purpose: transitive runtime dependency of ArtPlayer

The MIT-licensed components above are provided under the following terms:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## hls.js 1.6.16

- Project: hls.js
- License: Apache License 2.0
- Purpose: HLS playback through Media Source Extensions when native HLS is unavailable

The complete Apache License 2.0 text is available in the hls.js source distribution and its upstream repository.

## Optional native media runtime: mpv / libmpv and FFmpeg

Native high-compatibility packages may include mpv/libmpv, FFmpeg, codecs, subtitle libraries, TLS libraries, and other dynamically linked runtime components.

The applicable license for mpv/libmpv and FFmpeg depends on the exact binary build configuration, enabled optional components, and the licenses of all linked libraries. It must not be inferred solely from the project name or from another distributor's build.

Every formal native release must therefore include:

- the exact distributed component version;
- the declared SPDX-style license expression for that exact build;
- an HTTP(S) corresponding-source location;
- `Resources/libmpv/<platform>-<arch>/NATIVE_RUNTIME_NOTICES.md`;
- `native-runtime-manifest.json` licensing metadata;
- any complete license texts, written offers, attribution, relinking materials, or source-code obligations required by the declared licenses.

The build pipeline permits `unverified` metadata only for local test packages. Formal native packaging and release verification reject unverified license declarations unless an explicit test-only override is used.
