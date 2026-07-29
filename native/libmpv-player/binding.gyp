{
  "targets": [
    {
      "target_name": "fongmi_libmpv_player",
      "sources": [
        "src/addon.cc",
        "src/libmpv_player.cc",
        "src/mpv_dynamic.cc",
        "src/platform/native_view.cc"
      ],
      "include_dirs": ["src"],
      "defines": ["NAPI_VERSION=9"],
      "cflags_cc": ["-fexceptions"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/platform/native_view_darwin.mm"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_CFLAGS": ["-fobjc-arc", "-Wno-deprecated-declarations"],
            "GCC_PREPROCESSOR_DEFINITIONS": ["$(inherited)", "GL_SILENCE_DEPRECATION=1"],
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          },
          "libraries": [
            "-framework Cocoa",
            "-framework OpenGL"
          ]
        }],
        ["OS=='win'", {
          "sources": ["src/platform/native_view_win.cc"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++20"]
            }
          },
          "libraries": ["opengl32.lib", "user32.lib", "gdi32.lib"]
        }],
        ["OS=='linux'", {
          "sources": ["src/platform/native_view_linux.cc"],
          "cflags_cc": ["-std=c++20", "-fexceptions"],
          "libraries": ["-ldl", "-lX11", "-lGL", "-pthread"]
        }]
      ]
    }
  ]
}
