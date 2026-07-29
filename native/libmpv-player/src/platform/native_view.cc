#include "platform/native_view.h"

namespace fongmi {

bool NativeViewRenderSupported() {
#if defined(__APPLE__)
  return NativeViewRenderSupportedDarwin();
#elif defined(_WIN32)
  return NativeViewRenderSupportedWin();
#elif defined(__linux__)
  return NativeViewRenderSupportedLinux();
#else
  return false;
#endif
}

NativeViewResult AttachNativeView(const NativeViewAttachment& attachment) {
  if (attachment.parentHandle == 0) return {false, 0, "缺少父窗口句柄"};
  if (attachment.width <= 0 || attachment.height <= 0) return {false, 0, "视频区域尺寸无效"};
  if (!attachment.initializeRenderer || !attachment.renderFrame || !attachment.shutdownRenderer) {
    return {false, 0, "缺少 libmpv 渲染回调"};
  }
#if defined(__APPLE__)
  return AttachNativeViewDarwin(attachment);
#elif defined(_WIN32)
  return AttachNativeViewWin(attachment);
#elif defined(__linux__)
  return AttachNativeViewLinux(attachment);
#else
  return {false, 0, "当前平台尚未实现原生视频视图"};
#endif
}

void DetachNativeView(std::uintptr_t viewHandle) {
  if (!viewHandle) return;
#if defined(__APPLE__)
  DetachNativeViewDarwin(viewHandle);
#elif defined(_WIN32)
  DetachNativeViewWin(viewHandle);
#elif defined(__linux__)
  DetachNativeViewLinux(viewHandle);
#endif
}

void ResizeNativeView(std::uintptr_t viewHandle, int x, int y, int width, int height) {
  if (!viewHandle || width <= 0 || height <= 0) return;
#if defined(__APPLE__)
  ResizeNativeViewDarwin(viewHandle, x, y, width, height);
#elif defined(_WIN32)
  ResizeNativeViewWin(viewHandle, x, y, width, height);
#elif defined(__linux__)
  ResizeNativeViewLinux(viewHandle, x, y, width, height);
#endif
}

}  // namespace fongmi
