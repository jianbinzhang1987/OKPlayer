#pragma once

#include <cstdint>
#include <string>

#include "mpv_render_abi.h"

namespace fongmi {

struct NativeViewAttachment {
  std::uintptr_t parentHandle = 0;
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  void* rendererContext = nullptr;
  bool (*initializeRenderer)(void* rendererContext,
                             NativeOpenGLProcAddress getProcAddress,
                             void* getProcAddressContext,
                             NativeRequestRedraw requestRedraw,
                             void* requestRedrawContext,
                             std::string* error) = nullptr;
  void (*renderFrame)(void* rendererContext, int width, int height) = nullptr;
  void (*reportSwap)(void* rendererContext) = nullptr;
  void (*shutdownRenderer)(void* rendererContext) = nullptr;
};

struct NativeViewResult {
  bool ok = false;
  std::uintptr_t viewHandle = 0;
  std::string message;
};

bool NativeViewRenderSupported();
NativeViewResult AttachNativeView(const NativeViewAttachment& attachment);
void DetachNativeView(std::uintptr_t viewHandle);
void ResizeNativeView(std::uintptr_t viewHandle, int x, int y, int width, int height);

#if defined(__APPLE__)
bool NativeViewRenderSupportedDarwin();
NativeViewResult AttachNativeViewDarwin(const NativeViewAttachment& attachment);
void DetachNativeViewDarwin(std::uintptr_t viewHandle);
void ResizeNativeViewDarwin(std::uintptr_t viewHandle, int x, int y, int width, int height);
#endif

#if defined(_WIN32)
bool NativeViewRenderSupportedWin();
NativeViewResult AttachNativeViewWin(const NativeViewAttachment& attachment);
void DetachNativeViewWin(std::uintptr_t viewHandle);
void ResizeNativeViewWin(std::uintptr_t viewHandle, int x, int y, int width, int height);
#endif

#if defined(__linux__)
bool NativeViewRenderSupportedLinux();
NativeViewResult AttachNativeViewLinux(const NativeViewAttachment& attachment);
void DetachNativeViewLinux(std::uintptr_t viewHandle);
void ResizeNativeViewLinux(std::uintptr_t viewHandle, int x, int y, int width, int height);
#endif

}  // namespace fongmi
