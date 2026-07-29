#include "libmpv_player.h"

#include "mpv_dynamic.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>

namespace fongmi {

namespace {

void ThrowMpvError(const MpvDynamicLibrary& library, const char* action, int code) {
  if (code < 0) throw std::runtime_error(std::string(action) + "失败：" + library.errorString(code));
}

std::string HeaderValue(const std::unordered_map<std::string, std::string>& headers,
                        const std::string& target) {
  for (const auto& [raw_name, raw_value] : headers) {
    std::string name = raw_name;
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char value) {
      return static_cast<char>(std::tolower(value));
    });
    if (name == target && raw_value.find('\r') == std::string::npos && raw_value.find('\n') == std::string::npos) {
      return raw_value;
    }
  }
  return "";
}

}  // namespace

LibmpvPlayer::LibmpvPlayer() {
  EnsureMpv();
}

LibmpvPlayer::~LibmpvPlayer() {
  Destroy();
}

void LibmpvPlayer::EnsureMpv() {
  if (destroyed_ || mpv_) return;
  auto& library = MpvDynamicLibrary::Instance();
  if (!library.available()) return;
  mpv_ = library.create();
  if (!mpv_) throw std::runtime_error("libmpv 创建播放器失败");
  ThrowMpvError(library, "设置 libmpv 视频输出", library.setOptionString(mpv_, "vo", "libmpv"));
  library.setOptionString(mpv_, "terminal", "no");
  library.setOptionString(mpv_, "hwdec", "auto-safe");
  ThrowMpvError(library, "初始化 libmpv", library.initialize(mpv_));
  using_mpv_ = true;
}

void LibmpvPlayer::Command(const std::vector<std::string>& args) {
  if (!using_mpv_ || !mpv_) return;
  auto& library = MpvDynamicLibrary::Instance();
  ThrowMpvError(library, "执行 libmpv 命令", library.command(mpv_, args));
}

void LibmpvPlayer::Load(const std::string& url, const std::unordered_map<std::string, std::string>& headers) {
  if (destroyed_) throw std::runtime_error("播放器已经释放");
  if (url.empty()) throw std::runtime_error("播放地址不能为空");
  EnsureMpv();
  current_url_ = url;
  state_.position = 0;
  state_.duration = 0;
  state_.paused = false;
  state_.stopped = false;
  if (using_mpv_) {
    const std::string user_agent = HeaderValue(headers, "user-agent");
    const std::string referer = HeaderValue(headers, "referer");
    const std::string referrer = referer.empty() ? HeaderValue(headers, "referrer") : referer;
    const std::string header_fields = FormatLibmpvHeaders(headers);
    // mpv parses http-header-fields as a comma-delimited string list. Browser
    // User-Agent values often contain commas, so passing User-Agent through
    // that option produces malformed extra headers and some CDNs reply 400.
    // Use mpv's dedicated properties and reset them for every load instead.
    Command({"set", "user-agent", user_agent.empty() ? "Mozilla/5.0" : user_agent});
    Command({"set", "referrer", referrer});
    Command({"set", "http-header-fields", header_fields});
    Command({"loadfile", url, "replace"});
  }
}

void LibmpvPlayer::Play() {
  if (destroyed_) return;
  state_.paused = false;
  state_.stopped = false;
  if (using_mpv_) Command({"set", "pause", "no"});
}

void LibmpvPlayer::Pause() {
  if (destroyed_) return;
  state_.paused = true;
  if (using_mpv_) Command({"set", "pause", "yes"});
}

void LibmpvPlayer::Stop() {
  if (destroyed_) return;
  state_.stopped = true;
  if (using_mpv_) Command({"stop"});
}

void LibmpvPlayer::Seek(double seconds) {
  if (destroyed_) return;
  if (seconds < 0) throw std::runtime_error("播放位置必须是非负数");
  state_.position = seconds;
  if (using_mpv_) Command({"seek", std::to_string(seconds), "absolute"});
}

void LibmpvPlayer::SetSpeed(double speed) {
  if (destroyed_) return;
  if (speed < 0.25 || speed > 5) throw std::runtime_error("播放速度范围应为0.25到5");
  state_.speed = speed;
  if (using_mpv_) ThrowMpvError(MpvDynamicLibrary::Instance(), "设置播放速度", MpvDynamicLibrary::Instance().setDouble(mpv_, "speed", speed));
}

void LibmpvPlayer::SetVolume(double volume) {
  if (destroyed_) return;
  state_.volume = std::clamp(volume, 0.0, 100.0);
  if (using_mpv_) ThrowMpvError(MpvDynamicLibrary::Instance(), "设置音量", MpvDynamicLibrary::Instance().setDouble(mpv_, "volume", state_.volume));
}

void LibmpvPlayer::SetMuted(bool muted) {
  if (destroyed_) return;
  state_.muted = muted;
  if (using_mpv_) ThrowMpvError(MpvDynamicLibrary::Instance(), "设置静音", MpvDynamicLibrary::Instance().setFlag(mpv_, "mute", muted));
}

NativePlayerState LibmpvPlayer::GetState() const {
  NativePlayerState snapshot = state_;
  if (using_mpv_ && mpv_) {
    auto& library = MpvDynamicLibrary::Instance();
    double value = 0;
    bool flag = false;
    if (library.getDouble(mpv_, "time-pos", &value) >= 0) snapshot.position = std::max(0.0, value);
    if (library.getDouble(mpv_, "duration", &value) >= 0) snapshot.duration = std::max(0.0, value);
    if (library.getDouble(mpv_, "speed", &value) >= 0) snapshot.speed = value;
    if (library.getDouble(mpv_, "volume", &value) >= 0) snapshot.volume = std::clamp(value, 0.0, 100.0);
    if (library.getFlag(mpv_, "pause", &flag) >= 0) snapshot.paused = flag;
    if (library.getFlag(mpv_, "mute", &flag) >= 0) snapshot.muted = flag;
    if (library.getFlag(mpv_, "eof-reached", &flag) >= 0 && flag) snapshot.stopped = true;
  }
  return snapshot;
}

NativeViewResult LibmpvPlayer::AttachView(std::uintptr_t parentHandle, int x, int y, int width, int height) {
  if (destroyed_) return {false, 0, "播放器已经释放"};
  if (native_view_handle_) DetachView();
  EnsureMpv();
  if (!using_mpv_ || !MpvDynamicLibrary::Instance().renderApiAvailable()) {
    return {false, 0, "libmpv render API 不可用"};
  }
  NativeViewAttachment attachment;
  attachment.parentHandle = parentHandle;
  attachment.x = x;
  attachment.y = y;
  attachment.width = width;
  attachment.height = height;
  attachment.rendererContext = this;
  attachment.initializeRenderer = InitializeRendererCallback;
  attachment.renderFrame = RenderFrameCallback;
  attachment.reportSwap = ReportSwapCallback;
  attachment.shutdownRenderer = ShutdownRendererCallback;
  NativeViewResult result = AttachNativeView(attachment);
  if (result.ok) native_view_handle_ = result.viewHandle;
  return result;
}

void LibmpvPlayer::ResizeView(int x, int y, int width, int height) {
  if (native_view_handle_) ResizeNativeView(native_view_handle_, x, y, width, height);
}

void LibmpvPlayer::DetachView() {
  if (!native_view_handle_) return;
  const std::uintptr_t handle = native_view_handle_;
  native_view_handle_ = 0;
  DetachNativeView(handle);
}

bool LibmpvPlayer::InitializeRendererCallback(void* context,
                                              NativeOpenGLProcAddress getProcAddress,
                                              void* getProcAddressContext,
                                              NativeRequestRedraw requestRedraw,
                                              void* requestRedrawContext,
                                              std::string* error) {
  return static_cast<LibmpvPlayer*>(context)->InitializeRenderer(
    getProcAddress, getProcAddressContext, requestRedraw, requestRedrawContext, error);
}

void LibmpvPlayer::RenderFrameCallback(void* context, int width, int height) {
  static_cast<LibmpvPlayer*>(context)->RenderFrame(width, height);
}

void LibmpvPlayer::ReportSwapCallback(void* context) {
  static_cast<LibmpvPlayer*>(context)->ReportSwap();
}

void LibmpvPlayer::ShutdownRendererCallback(void* context) {
  static_cast<LibmpvPlayer*>(context)->ShutdownRenderer();
}

void LibmpvPlayer::RenderUpdateCallback(void* context) {
  auto* player = static_cast<LibmpvPlayer*>(context);
  if (player && player->request_redraw_) player->request_redraw_(player->request_redraw_context_);
}

bool LibmpvPlayer::InitializeRenderer(NativeOpenGLProcAddress getProcAddress,
                                      void* getProcAddressContext,
                                      NativeRequestRedraw requestRedraw,
                                      void* requestRedrawContext,
                                      std::string* error) {
  if (render_context_) return true;
  auto& library = MpvDynamicLibrary::Instance();
  if (!using_mpv_ || !mpv_ || !library.renderApiAvailable()) {
    if (error) *error = "libmpv OpenGL render API 不可用";
    return false;
  }
  mpv_opengl_init_params glInit{getProcAddress, getProcAddressContext};
  char* apiType = const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL);
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, apiType},
    {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &glInit},
    {MPV_RENDER_PARAM_INVALID, nullptr},
  };
  const int result = library.createRenderContext(&render_context_, mpv_, params);
  if (result < 0 || !render_context_) {
    if (error) *error = "创建 libmpv OpenGL render context 失败：" + library.errorString(result);
    render_context_ = nullptr;
    return false;
  }
  request_redraw_ = requestRedraw;
  request_redraw_context_ = requestRedrawContext;
  library.setRenderUpdateCallback(render_context_, RenderUpdateCallback, this);
  return true;
}

void LibmpvPlayer::RenderFrame(int width, int height) {
  if (!render_context_ || width <= 0 || height <= 0) return;
  auto& library = MpvDynamicLibrary::Instance();
  library.updateRenderContext(render_context_);
  mpv_opengl_fbo fbo{0, width, height, 0};
  int flipY = 1;
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
    {MPV_RENDER_PARAM_FLIP_Y, &flipY},
    {MPV_RENDER_PARAM_INVALID, nullptr},
  };
  library.render(render_context_, params);
}

void LibmpvPlayer::ReportSwap() {
  if (render_context_) MpvDynamicLibrary::Instance().reportRenderSwap(render_context_);
}

void LibmpvPlayer::ShutdownRenderer() {
  if (!render_context_) return;
  auto& library = MpvDynamicLibrary::Instance();
  library.setRenderUpdateCallback(render_context_, nullptr, nullptr);
  request_redraw_ = nullptr;
  request_redraw_context_ = nullptr;
  library.freeRenderContext(render_context_);
  render_context_ = nullptr;
}

void LibmpvPlayer::Destroy() {
  if (destroyed_) return;
  DetachView();
  ShutdownRenderer();
  state_.stopped = true;
  current_url_.clear();
  if (mpv_) {
    MpvDynamicLibrary::Instance().destroy(mpv_);
    mpv_ = nullptr;
  }
  using_mpv_ = false;
  destroyed_ = true;
}

}  // namespace fongmi
