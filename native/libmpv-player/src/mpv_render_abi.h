#pragma once

#include <cstdint>

namespace fongmi {

struct mpv_handle;
struct mpv_render_context;

struct mpv_render_param {
  int type;
  void* data;
};

struct mpv_opengl_init_params {
  void* (*get_proc_address)(void* context, const char* name);
  void* get_proc_address_ctx;
};

struct mpv_opengl_fbo {
  int fbo;
  int w;
  int h;
  int internal_format;
};

constexpr int MPV_RENDER_PARAM_INVALID = 0;
constexpr int MPV_RENDER_PARAM_API_TYPE = 1;
constexpr int MPV_RENDER_PARAM_OPENGL_INIT_PARAMS = 2;
constexpr int MPV_RENDER_PARAM_OPENGL_FBO = 3;
constexpr int MPV_RENDER_PARAM_FLIP_Y = 4;
constexpr std::uint64_t MPV_RENDER_UPDATE_FRAME = 1ULL << 0;
constexpr const char* MPV_RENDER_API_TYPE_OPENGL = "opengl";

using MpvRenderUpdateCallback = void (*)(void* context);
using NativeOpenGLProcAddress = void* (*)(void* context, const char* name);
using NativeRequestRedraw = void (*)(void* context);

}  // namespace fongmi
