#include "platform/native_view.h"

#ifdef _WIN32

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <gl/GL.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

namespace fongmi {
namespace {

constexpr UINT kRenderMessage = WM_APP + 0x341;
constexpr UINT kResizeMessage = WM_APP + 0x342;
constexpr UINT kStopMessage = WM_APP + 0x343;
constexpr wchar_t kWindowClassName[] = L"FongMiLibmpvRenderWindow";

struct WinViewState {
  NativeViewAttachment attachment;
  HWND parent = nullptr;
  HWND window = nullptr;
  HDC deviceContext = nullptr;
  HGLRC openGLContext = nullptr;
  std::thread thread;
  std::mutex mutex;
  std::condition_variable readyCondition;
  std::atomic<bool> stopping{false};
  bool ready = false;
  bool initialized = false;
  bool selfDelete = false;
  std::string error;
  int x = 0;
  int y = 0;
  int width = 1;
  int height = 1;
};

void* ResolveWglSymbol(void* /*context*/, const char* name) {
  if (!name) return nullptr;
  PROC address = wglGetProcAddress(name);
  const std::uintptr_t raw = reinterpret_cast<std::uintptr_t>(address);
  if (address && raw > 3 && raw != static_cast<std::uintptr_t>(-1)) {
    return reinterpret_cast<void*>(raw);
  }
  static HMODULE openGL = LoadLibraryW(L"opengl32.dll");
  return openGL ? reinterpret_cast<void*>(GetProcAddress(openGL, name)) : nullptr;
}

void RequestWindowsRedraw(void* context) {
  auto* state = static_cast<WinViewState*>(context);
  if (!state || state->stopping.load() || !state->window) return;
  PostMessageW(state->window, kRenderMessage, 0, 0);
}

void RenderWindowsFrame(WinViewState* state) {
  if (!state || !state->initialized || state->stopping.load() || !state->window) return;
  RECT client{};
  GetClientRect(state->window, &client);
  const int width = static_cast<int>(std::max(1L, client.right - client.left));
  const int height = static_cast<int>(std::max(1L, client.bottom - client.top));
  if (!wglMakeCurrent(state->deviceContext, state->openGLContext)) return;
  glViewport(0, 0, width, height);
  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  state->attachment.renderFrame(state->attachment.rendererContext, width, height);
  SwapBuffers(state->deviceContext);
  if (state->attachment.reportSwap) state->attachment.reportSwap(state->attachment.rendererContext);
}

LRESULT CALLBACK RenderWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  auto* state = reinterpret_cast<WinViewState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
    state = static_cast<WinViewState*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
  }
  switch (message) {
    case kRenderMessage:
      RenderWindowsFrame(state);
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      BeginPaint(window, &paint);
      RenderWindowsFrame(state);
      EndPaint(window, &paint);
      return 0;
    }
    case kResizeMessage: {
      if (!state) return 0;
      int x = 0;
      int y = 0;
      int width = 1;
      int height = 1;
      {
        std::lock_guard lock(state->mutex);
        x = state->x;
        y = state->y;
        width = state->width;
        height = state->height;
      }
      SetWindowPos(window, nullptr, x, y, width, height,
                   SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER | SWP_SHOWWINDOW);
      PostMessageW(window, kRenderMessage, 0, 0);
      return 0;
    }
    case kStopMessage:
    case WM_CLOSE:
      PostQuitMessage(0);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wParam, lParam);
  }
}

ATOM RegisterRenderWindowClass() {
  static std::once_flag once;
  static ATOM atom = 0;
  std::call_once(once, [] {
    WNDCLASSEXW definition{};
    definition.cbSize = sizeof(definition);
    definition.style = CS_OWNDC | CS_HREDRAW | CS_VREDRAW;
    definition.lpfnWndProc = RenderWindowProc;
    definition.hInstance = GetModuleHandleW(nullptr);
    definition.hCursor = LoadCursor(nullptr, IDC_ARROW);
    definition.lpszClassName = kWindowClassName;
    atom = RegisterClassExW(&definition);
    if (!atom && GetLastError() == ERROR_CLASS_ALREADY_EXISTS) atom = 1;
  });
  return atom;
}

void SignalReady(WinViewState* state, bool initialized, const std::string& error = {}) {
  {
    std::lock_guard lock(state->mutex);
    state->initialized = initialized;
    state->error = error;
    state->ready = true;
  }
  state->readyCondition.notify_all();
}

void CleanupWindowsView(WinViewState* state) {
  state->stopping.store(true);
  if (state->initialized && state->attachment.shutdownRenderer) {
    if (state->deviceContext && state->openGLContext) {
      wglMakeCurrent(state->deviceContext, state->openGLContext);
    }
    state->attachment.shutdownRenderer(state->attachment.rendererContext);
  }
  state->initialized = false;
  wglMakeCurrent(nullptr, nullptr);
  if (state->openGLContext) wglDeleteContext(state->openGLContext);
  state->openGLContext = nullptr;
  if (state->deviceContext && state->window) ReleaseDC(state->window, state->deviceContext);
  state->deviceContext = nullptr;
  if (state->window && IsWindow(state->window)) DestroyWindow(state->window);
  state->window = nullptr;
}

void FinishWindowsThread(WinViewState* state) {
  bool selfDelete = false;
  {
    std::lock_guard lock(state->mutex);
    selfDelete = state->selfDelete;
  }
  if (selfDelete) delete state;
}

void WindowsRenderThread(WinViewState* state) {
  if (!RegisterRenderWindowClass()) {
    SignalReady(state, false, "注册 Windows 原生视频窗口失败");
    FinishWindowsThread(state);
    return;
  }

  state->window = CreateWindowExW(
    0,
    kWindowClassName,
    L"",
    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    state->x, state->y, state->width, state->height,
    state->parent,
    nullptr,
    GetModuleHandleW(nullptr),
    state);
  if (!state->window) {
    SignalReady(state, false, "创建 Windows 子 HWND 失败");
    FinishWindowsThread(state);
    return;
  }

  state->deviceContext = GetDC(state->window);
  PIXELFORMATDESCRIPTOR descriptor{};
  descriptor.nSize = sizeof(descriptor);
  descriptor.nVersion = 1;
  descriptor.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  descriptor.iPixelType = PFD_TYPE_RGBA;
  descriptor.cColorBits = 32;
  descriptor.cAlphaBits = 8;
  descriptor.cDepthBits = 24;
  descriptor.iLayerType = PFD_MAIN_PLANE;
  const int pixelFormat = state->deviceContext ? ChoosePixelFormat(state->deviceContext, &descriptor) : 0;
  if (!pixelFormat || !SetPixelFormat(state->deviceContext, pixelFormat, &descriptor)) {
    SignalReady(state, false, "设置 Windows OpenGL pixel format 失败");
    CleanupWindowsView(state);
    FinishWindowsThread(state);
    return;
  }

  state->openGLContext = wglCreateContext(state->deviceContext);
  if (!state->openGLContext || !wglMakeCurrent(state->deviceContext, state->openGLContext)) {
    SignalReady(state, false, "创建 Windows WGL context 失败");
    CleanupWindowsView(state);
    FinishWindowsThread(state);
    return;
  }

  std::string rendererError;
  const bool initialized = state->attachment.initializeRenderer(
    state->attachment.rendererContext,
    ResolveWglSymbol,
    nullptr,
    RequestWindowsRedraw,
    state,
    &rendererError);
  SignalReady(state, initialized, rendererError);
  if (initialized && !state->stopping.load()) {
    ShowWindow(state->window, SW_SHOWNA);
    PostMessageW(state->window, kRenderMessage, 0, 0);
    MSG message{};
    while (!state->stopping.load() && GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

  CleanupWindowsView(state);
  FinishWindowsThread(state);
}

}  // namespace

bool NativeViewRenderSupportedWin() {
  return true;
}

NativeViewResult AttachNativeViewWin(const NativeViewAttachment& attachment) {
  HWND parent = reinterpret_cast<HWND>(attachment.parentHandle);
  if (!parent || !IsWindow(parent)) return {false, 0, "父 HWND 句柄无效"};
  auto* state = new WinViewState();
  state->attachment = attachment;
  state->parent = parent;
  state->x = attachment.x;
  state->y = attachment.y;
  state->width = std::max(1, attachment.width);
  state->height = std::max(1, attachment.height);
  state->thread = std::thread(WindowsRenderThread, state);

  {
    std::unique_lock lock(state->mutex);
    if (!state->readyCondition.wait_for(lock, std::chrono::seconds(10), [state] { return state->ready; })) {
      state->stopping.store(true);
      state->selfDelete = true;
      if (state->window) PostMessageW(state->window, kStopMessage, 0, 0);
      state->thread.detach();
      return {false, 0, "Windows 原生视频窗口初始化超时，已隔离后台清理"};
    }
  }
  if (!state->initialized) {
    const std::string error = state->error.empty() ? "Windows libmpv 渲染器初始化失败" : state->error;
    if (state->thread.joinable()) state->thread.join();
    delete state;
    return {false, 0, error};
  }
  return {true, reinterpret_cast<std::uintptr_t>(state), "Windows libmpv WGL 子窗口已挂载"};
}

void DetachNativeViewWin(std::uintptr_t viewHandle) {
  auto* state = reinterpret_cast<WinViewState*>(viewHandle);
  if (!state) return;
  state->stopping.store(true);
  if (state->window) PostMessageW(state->window, kStopMessage, 0, 0);
  if (state->thread.joinable()) state->thread.join();
  delete state;
}

void ResizeNativeViewWin(std::uintptr_t viewHandle, int x, int y, int width, int height) {
  auto* state = reinterpret_cast<WinViewState*>(viewHandle);
  if (!state || state->stopping.load()) return;
  {
    std::lock_guard lock(state->mutex);
    state->x = x;
    state->y = y;
    state->width = std::max(1, width);
    state->height = std::max(1, height);
  }
  if (state->window) PostMessageW(state->window, kResizeMessage, 0, 0);
}

}  // namespace fongmi

#else

namespace fongmi {
bool NativeViewRenderSupportedWin() { return false; }
NativeViewResult AttachNativeViewWin(const NativeViewAttachment&) { return {false, 0, "Windows 原生渲染仅在 Windows 构建中可用"}; }
void DetachNativeViewWin(std::uintptr_t) {}
void ResizeNativeViewWin(std::uintptr_t, int, int, int, int) {}
}  // namespace fongmi

#endif
