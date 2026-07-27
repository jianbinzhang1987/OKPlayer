# Bundled mpv runtime layout

Place verified mpv runtime files in the following directories before formal packaging:

```text
resources/mpv/
├── macos/
│   ├── x64/mpv
│   └── arm64/mpv
├── windows/
│   └── x64/mpv.exe
└── linux/
    └── x64/mpv
```

The application checks `FONGMI_MPV_PATH` first, then the packaged runtime above, and finally the system `PATH` for development compatibility.

Formal releases must include the matching mpv executable and all required dynamic libraries, licenses, signatures and checksums for the target platform.
