# Native Runtime Layout

This directory is copied into the packaged application's resources as `native/`.

Expected release layout after native libmpv is built:

```text
resources/native/
  libmpv-player/
    darwin-x64/fongmi_libmpv_player.node
    darwin-arm64/fongmi_libmpv_player.node
    win32-x64/fongmi_libmpv_player.node
    linux-x64/fongmi_libmpv_player.node
```

Current repository status: placeholder only. The application must treat missing native addons as normal and fall back to the existing MPV IPC backend.
