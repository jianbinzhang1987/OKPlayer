#include "platform/native_view.h"

#ifdef __linux__

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <GL/gl.h>
#include <GL/glx.h>
#include <dlfcn.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>

namespace fongmi {
namespace {

struct LinuxViewState {
  NativeViewAttachment attachment;
  ::Window parent = 0;
  ::Window window = 0;
  Display* display = nullptr;
  GLXContext openGLContext = nullptr;
  Colormap colormap = 0;
  std::thread thread;
  std::mutex mutex;
  std::condition_variable condition;
  std::atomic<bool> stopping{false};
  bool ready = false;
  bool initialized = false;
  bool selfDelete = false;
  bool redrawPending = true;
  bool resizePending = false;
  std::string error;
  int x = 0;
  int y = 0;
  int width = 1;
  int height = 1;
};

int* GlxVisualAttributes() {
  static int attributes[] = {
    GLX_RGBA,
    GLX_DOUBLEBUFFER,
    GLX_RED_SIZE, 8,
    GLX_GREEN_SIZE, 8,
    GLX_BLUE_SIZE, 8,
    GLX_ALPHA_SIZE, 8,
    GLX_DEPTH_SIZE, 24,
    None,
  };
  return attributes;
}

void* ResolveGlxSymbol(void* /*context*/, const char* name) {
  if (!name) return nullptr;
  void* address = reinterpret_cast<void*>(glXGetProcAddressARB(reinterpret_cast<const GLubyte*>(name)));
  return address ? address : dlsym(RTLD_DEFAULT, name);
}

void RequestLinuxRedraw(void* context) {
  auto* state = static_cast<LinuxViewState*>(context);
  if (!state || state->stopping.load()) return;
  {
    std::lock_guard lock(state->mutex);
    state->redrawPending = true;
  }
  state->condition.notify_one();
}

void SignalReady(LinuxViewState* state, bool initialized, const std::string& error = {}) {
  {
    std::lock_guard lock(state->mutex);
    state->initialized = initialized;
    state->error = error;
    state->ready = true;
  }
  state->condition.notify_all();
}

void RenderLinuxFrame(LinuxViewState* state, int width, int height) {
  if (!state->initialized || state->stopping.load()) return;
  if (!glXMakeCurrent(state->display, state->window, state->openGLContext)) return;
  const int renderWidth = std::max(1, width);
  const int renderHeight = std::max(1, height);
  glViewport(0, 0, renderWidth, renderHeight);
  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  state->attachment.renderFrame(state->attachment.rendererContext, renderWidth, renderHeight);
  glXSwapBuffers(state->display, state->window);
  if (state->attachment.reportSwap) state->attachment.reportSwap(state->attachment.rendererContext);
}

void CleanupLinuxView(LinuxViewState* state) {
  state->stopping.store(true);
  if (!state->display) return;
  if (state->initialized && state->attachment.shutdownRenderer) {
    if (state->window && state->openGLContext) glXMakeCurrent(state->display, state->window, state->openGLContext);
    state->attachment.shutdownRenderer(state->attachment.rendererContext);
  }
  state->initialized = false;
  glXMakeCurrent(state->display, None, nullptr);
  if (state->openGLContext) glXDestroyContext(state->display, state->openGLContext);
  if (state->window) XDestroyWindow(state->display, state->window);
  if (state->colormap) XFreeColormap(state->display, state->colormap);
  XCloseDisplay(state->display);
  state->display = nullptr;
  state->window = 0;
  state->openGLContext = nullptr;
  state->colormap = 0;
}

void FinishLinuxThread(LinuxViewState* state) {
  bool selfDelete = false;
  {
    std::lock_guard lock(state->mutex);
    selfDelete = state->selfDelete;
  }
  if (selfDelete) delete state;
}

void LinuxRenderThread(LinuxViewState* state) {
  state->display = XOpenDisplay(nullptr);
  if (!state->display) {
    SignalReady(state, false, "无法连接 X11 DISPLAY");
    FinishLinuxThread(state);
    return;
  }

  XVisualInfo* visual = glXChooseVisual(state->display, DefaultScreen(state->display), GlxVisualAttributes());
  if (!visual) {
    SignalReady(state, false, "找不到可用的 X11/GLX visual");
    CleanupLinuxView(state);
    FinishLinuxThread(state);
    return;
  }

  state->colormap = XCreateColormap(state->display, state->parent, visual->visual, AllocNone);
  XSetWindowAttributes attributes{};
  attributes.colormap = state->colormap;
  attributes.border_pixel = 0;
  attributes.background_pixel = BlackPixel(state->display, DefaultScreen(state->display));
  attributes.event_mask = ExposureMask | StructureNotifyMask;
  state->window = XCreateWindow(
    state->display,
    state->parent,
    state->x,
    state->y,
    static_cast<unsigned int>(state->width),
    static_cast<unsigned int>(state->height),
    0,
    visual->depth,
    InputOutput,
    visual->visual,
    CWColormap | CWBorderPixel | CWBackPixel | CWEventMask,
    &attributes);
  if (!state->window) {
    XFree(visual);
    SignalReady(state, false, "创建 X11 子窗口失败");
    CleanupLinuxView(state);
    FinishLinuxThread(state);
    return;
  }

  state->openGLContext = glXCreateContext(state->display, visual, nullptr, True);
  XFree(visual);
  if (!state->openGLContext || !glXMakeCurrent(state->display, state->window, state->openGLContext)) {
    SignalReady(state, false, "创建 Linux GLX context 失败");
    CleanupLinuxView(state);
    FinishLinuxThread(state);
    return;
  }

  XMapWindow(state->display, state->window);
  XFlush(state->display);
  std::string rendererError;
  const bool initialized = state->attachment.initializeRenderer(
    state->attachment.rendererContext,
    ResolveGlxSymbol,
    nullptr,
    RequestLinuxRedraw,
    state,
    &rendererError);
  SignalReady(state, initialized, rendererError);

  if (initialized && !state->stopping.load()) {
    while (!state->stopping.load()) {
      bool redraw = false;
      bool resize = false;
      int x = 0;
      int y = 0;
      int width = 1;
      int height = 1;
      {
        std::unique_lock lock(state->mutex);
        state->condition.wait_for(lock, std::chrono::milliseconds(100), [state] {
          return state->stopping.load() || state->redrawPending || state->resizePending;
        });
        if (state->stopping.load()) break;
        redraw = state->redrawPending;
        resize = state->resizePending;
        state->redrawPending = false;
        state->resizePending = false;
        x = state->x;
        y = state->y;
        width = state->width;
        height = state->height;
      }

      while (XPending(state->display) > 0) {
        XEvent event{};
        XNextEvent(state->display, &event);
        if (event.type == Expose) redraw = true;
        if (event.type == ConfigureNotify) {
          width = event.xconfigure.width;
          height = event.xconfigure.height;
          redraw = true;
        }
        if (event.type == DestroyNotify) state->stopping.store(true);
      }
      if (state->stopping.load()) break;
      if (resize) {
        XMoveResizeWindow(state->display, state->window, x, y,
                          static_cast<unsigned int>(std::max(1, width)),
                          static_cast<unsigned int>(std::max(1, height)));
        XFlush(state->display);
        redraw = true;
      }
      if (redraw) RenderLinuxFrame(state, width, height);
    }
  }

  CleanupLinuxView(state);
  FinishLinuxThread(state);
}

bool CanCreateGlxVisual() {
  const char* displayName = std::getenv("DISPLAY");
  if (!displayName || !*displayName) return false;
  Display* display = XOpenDisplay(nullptr);
  if (!display) return false;
  XVisualInfo* visual = glXChooseVisual(display, DefaultScreen(display), GlxVisualAttributes());
  const bool supported = visual != nullptr;
  if (visual) XFree(visual);
  XCloseDisplay(display);
  return supported;
}

}  // namespace

bool NativeViewRenderSupportedLinux() {
  return CanCreateGlxVisual();
}

NativeViewResult AttachNativeViewLinux(const NativeViewAttachment& attachment) {
  if (!NativeViewRenderSupportedLinux()) return {false, 0, "当前 Linux 会话没有可用的 X11/GLX 渲染环境"};
  if (!attachment.parentHandle) return {false, 0, "缺少 Linux X11 父窗口句柄"};
  auto* state = new LinuxViewState();
  state->attachment = attachment;
  state->parent = static_cast<::Window>(attachment.parentHandle);
  state->x = attachment.x;
  state->y = attachment.y;
  state->width = std::max(1, attachment.width);
  state->height = std::max(1, attachment.height);
  state->thread = std::thread(LinuxRenderThread, state);

  {
    std::unique_lock lock(state->mutex);
    if (!state->condition.wait_for(lock, std::chrono::seconds(10), [state] { return state->ready; })) {
      state->stopping.store(true);
      state->selfDelete = true;
      state->condition.notify_all();
      state->thread.detach();
      return {false, 0, "Linux 原生视频窗口初始化超时，已隔离后台清理"};
    }
  }
  if (!state->initialized) {
    const std::string error = state->error.empty() ? "Linux libmpv 渲染器初始化失败" : state->error;
    state->stopping.store(true);
    state->condition.notify_all();
    if (state->thread.joinable()) state->thread.join();
    delete state;
    return {false, 0, error};
  }
  return {true, reinterpret_cast<std::uintptr_t>(state), "Linux libmpv X11/GLX 子窗口已挂载"};
}

void DetachNativeViewLinux(std::uintptr_t viewHandle) {
  auto* state = reinterpret_cast<LinuxViewState*>(viewHandle);
  if (!state) return;
  state->stopping.store(true);
  state->condition.notify_all();
  if (state->thread.joinable()) state->thread.join();
  delete state;
}

void ResizeNativeViewLinux(std::uintptr_t viewHandle, int x, int y, int width, int height) {
  auto* state = reinterpret_cast<LinuxViewState*>(viewHandle);
  if (!state || state->stopping.load()) return;
  {
    std::lock_guard lock(state->mutex);
    state->x = x;
    state->y = y;
    state->width = std::max(1, width);
    state->height = std::max(1, height);
    state->resizePending = true;
  }
  state->condition.notify_one();
}

}  // namespace fongmi

#else

namespace fongmi {
bool NativeViewRenderSupportedLinux() { return false; }
NativeViewResult AttachNativeViewLinux(const NativeViewAttachment&) { return {false, 0, "Linux 原生渲染仅在 Linux 构建中可用"}; }
void DetachNativeViewLinux(std::uintptr_t) {}
void ResizeNativeViewLinux(std::uintptr_t, int, int, int, int) {}
}  // namespace fongmi

#endif
