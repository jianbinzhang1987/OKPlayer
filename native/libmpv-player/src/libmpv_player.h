#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "mpv_render_abi.h"
#include "platform/native_view.h"

namespace fongmi {

struct NativePlayerState {
  double position = 0;
  double duration = 0;
  double speed = 1;
  double volume = 100;
  bool paused = false;
  bool muted = false;
  bool stopped = true;
};

class LibmpvPlayer final {
 public:
  LibmpvPlayer();
  ~LibmpvPlayer();

  void Load(const std::string& url, const std::unordered_map<std::string, std::string>& headers);
  void Play();
  void Pause();
  void Stop();
  void Seek(double seconds);
  void SetSpeed(double speed);
  void SetVolume(double volume);
  void SetMuted(bool muted);
  NativePlayerState GetState() const;

  NativeViewResult AttachView(std::uintptr_t parentHandle, int x, int y, int width, int height);
  void ResizeView(int x, int y, int width, int height);
  void DetachView();
  bool IsViewAttached() const { return native_view_handle_ != 0; }

  void Destroy();

 private:
  static bool InitializeRendererCallback(void* context,
                                         NativeOpenGLProcAddress getProcAddress,
                                         void* getProcAddressContext,
                                         NativeRequestRedraw requestRedraw,
                                         void* requestRedrawContext,
                                         std::string* error);
  static void RenderFrameCallback(void* context, int width, int height);
  static void ReportSwapCallback(void* context);
  static void ShutdownRendererCallback(void* context);
  static void RenderUpdateCallback(void* context);

  void EnsureMpv();
  void Command(const std::vector<std::string>& args);
  bool InitializeRenderer(NativeOpenGLProcAddress getProcAddress,
                          void* getProcAddressContext,
                          NativeRequestRedraw requestRedraw,
                          void* requestRedrawContext,
                          std::string* error);
  void RenderFrame(int width, int height);
  void ReportSwap();
  void ShutdownRenderer();

  NativePlayerState state_;
  std::string current_url_;
  mpv_handle* mpv_ = nullptr;
  mpv_render_context* render_context_ = nullptr;
  NativeRequestRedraw request_redraw_ = nullptr;
  void* request_redraw_context_ = nullptr;
  std::uintptr_t native_view_handle_ = 0;
  bool using_mpv_ = false;
  bool destroyed_ = false;
};

}  // namespace fongmi
