#include "mpv_dynamic.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fongmi {

namespace {

constexpr int MPV_FORMAT_FLAG = 3;
constexpr int MPV_FORMAT_DOUBLE = 5;

void* OpenLibrary(const std::string& path, std::string* error) {
#if defined(_WIN32)
  HMODULE handle = LoadLibraryA(path.c_str());
  if (!handle && error) *error = "LoadLibrary failed";
  return reinterpret_cast<void*>(handle);
#else
  // dlerror() returns the current thread-local loader error and clears it.
  // Calling it twice can return nullptr on the second call and passing that
  // nullptr into std::string is undefined behaviour (and previously caused
  // the addon availability probe to crash when libmpv was absent).
  dlerror();
  void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!handle && error) {
    const char* loader_error = dlerror();
    *error = loader_error ? loader_error : "dlopen failed";
  }
  return handle;
#endif
}

void CloseLibrary(void* library) {
  if (!library) return;
#if defined(_WIN32)
  FreeLibrary(reinterpret_cast<HMODULE>(library));
#else
  dlclose(library);
#endif
}

void* LoadSymbol(void* library, const char* name) {
#if defined(_WIN32)
  return reinterpret_cast<void*>(GetProcAddress(reinterpret_cast<HMODULE>(library), name));
#else
  return dlsym(library, name);
#endif
}

template <typename T>
T Resolve(void* library, const char* name) {
  return reinterpret_cast<T>(LoadSymbol(library, name));
}

bool IsSafeHeaderName(const std::string& name) {
  if (name.empty()) return false;
  return std::all_of(name.begin(), name.end(), [](unsigned char value) {
    return std::isalnum(value) || value == '!' || value == '#' || value == '$' || value == '%' || value == '&' ||
           value == '\'' || value == '*' || value == '+' || value == '-' || value == '.' || value == '^' ||
           value == '_' || value == '`' || value == '|' || value == '~';
  });
}

bool ContainsNewline(const std::string& value) {
  return value.find('\n') != std::string::npos || value.find('\r') != std::string::npos;
}

}  // namespace

std::vector<std::string> DefaultLibmpvCandidates() {
  std::vector<std::string> candidates;
  // Never search the process/global loader paths by a generic library name.
  // A Homebrew or system libmpv can pull in a very large, incompatible
  // dependency graph and may block the Electron main process during dlopen.
  // Only a release-managed, explicitly selected absolute path is allowed.
  if (const char* env = std::getenv("FONGMI_LIBMPV_LIBRARY")) {
    const std::filesystem::path selected(env);
    if (*env && selected.is_absolute()) candidates.emplace_back(selected.lexically_normal().string());
  }
  return candidates;
}

std::string FormatLibmpvHeaders(const std::unordered_map<std::string, std::string>& headers) {
  static const std::vector<std::string> blocked = {
    "connection",
    "content-length",
    "host",
    "proxy-authorization",
    "proxy-connection",
    "transfer-encoding",
  };

  std::vector<std::string> fields;
  for (const auto& [raw_name, raw_value] : headers) {
    std::string name = raw_name;
    std::string lowered = name;
    std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char value) { return std::tolower(value); });
    if (std::find(blocked.begin(), blocked.end(), lowered) != blocked.end()) continue;
    if (lowered == "user-agent" || lowered == "referer" || lowered == "referrer") continue;
    if (!IsSafeHeaderName(name) || raw_value.empty() || ContainsNewline(raw_value)) continue;
    fields.push_back(name + ": " + raw_value);
  }

  std::ostringstream stream;
  for (size_t index = 0; index < fields.size(); ++index) {
    if (index > 0) stream << ",";
    stream << fields[index];
  }
  return stream.str();
}

MpvDynamicLibrary& MpvDynamicLibrary::Instance() {
  static MpvDynamicLibrary instance;
  return instance;
}

MpvDynamicLibrary::MpvDynamicLibrary() {
  std::string last_error;
  for (const auto& candidate : DefaultLibmpvCandidates()) {
    library_ = OpenLibrary(candidate, &last_error);
    if (!library_) continue;
    path_ = candidate;
    create_ = Resolve<CreateFn>(library_, "mpv_create");
    initialize_ = Resolve<InitializeFn>(library_, "mpv_initialize");
    set_option_string_ = Resolve<SetOptionStringFn>(library_, "mpv_set_option_string");
    command_ = Resolve<CommandFn>(library_, "mpv_command");
    command_string_ = Resolve<CommandStringFn>(library_, "mpv_command_string");
    set_property_ = Resolve<SetPropertyFn>(library_, "mpv_set_property");
    get_property_ = Resolve<GetPropertyFn>(library_, "mpv_get_property");
    destroy_ = Resolve<DestroyFn>(library_, "mpv_destroy");
    error_string_ = Resolve<ErrorStringFn>(library_, "mpv_error_string");
    client_api_version_ = Resolve<ClientApiVersionFn>(library_, "mpv_client_api_version");
    render_context_create_ = Resolve<RenderContextCreateFn>(library_, "mpv_render_context_create");
    render_context_set_update_callback_ = Resolve<RenderContextSetUpdateCallbackFn>(library_, "mpv_render_context_set_update_callback");
    render_context_update_ = Resolve<RenderContextUpdateFn>(library_, "mpv_render_context_update");
    render_context_render_ = Resolve<RenderContextRenderFn>(library_, "mpv_render_context_render");
    render_context_report_swap_ = Resolve<RenderContextReportSwapFn>(library_, "mpv_render_context_report_swap");
    render_context_free_ = Resolve<RenderContextFreeFn>(library_, "mpv_render_context_free");
    if (create_ && initialize_ && set_option_string_ && command_ && set_property_ && get_property_ && destroy_) {
      available_ = true;
      return;
    }
    CloseLibrary(library_);
    library_ = nullptr;
    create_ = nullptr;
    initialize_ = nullptr;
    set_option_string_ = nullptr;
    command_ = nullptr;
    command_string_ = nullptr;
    set_property_ = nullptr;
    get_property_ = nullptr;
    destroy_ = nullptr;
    error_string_ = nullptr;
    client_api_version_ = nullptr;
    render_context_create_ = nullptr;
    render_context_set_update_callback_ = nullptr;
    render_context_update_ = nullptr;
    render_context_render_ = nullptr;
    render_context_report_swap_ = nullptr;
    render_context_free_ = nullptr;
    last_error = "libmpv 动态库缺少必要符号";
  }
  available_ = false;
  error_ = last_error.empty() ? "未找到 libmpv 动态库" : last_error;
}

MpvDynamicLibrary::~MpvDynamicLibrary() {
  // Intentionally keep a successfully loaded libmpv resident until process
  // exit. libmpv pulls in FFmpeg, rendering and platform frameworks whose
  // unload order is outside our control; dlclose during Node/Electron teardown
  // can deadlock or crash. Failed candidates are still closed immediately in
  // the constructor before another candidate is tried.
  library_ = nullptr;
}

unsigned long MpvDynamicLibrary::clientApiVersion() const {
  return client_api_version_ ? client_api_version_() : 0;
}

bool MpvDynamicLibrary::renderApiAvailable() const {
  return render_context_create_ && render_context_set_update_callback_ && render_context_update_
    && render_context_render_ && render_context_free_;
}

mpv_handle* MpvDynamicLibrary::create() const {
  return create_ ? create_() : nullptr;
}

int MpvDynamicLibrary::initialize(mpv_handle* handle) const {
  return initialize_ ? initialize_(handle) : -1;
}

int MpvDynamicLibrary::setOptionString(mpv_handle* handle, const std::string& name, const std::string& value) const {
  return set_option_string_ ? set_option_string_(handle, name.c_str(), value.c_str()) : -1;
}

int MpvDynamicLibrary::command(mpv_handle* handle, const std::vector<std::string>& args) const {
  if (!command_) return -1;
  std::vector<const char*> command_args;
  command_args.reserve(args.size() + 1);
  for (const auto& arg : args) command_args.push_back(arg.c_str());
  command_args.push_back(nullptr);
  return command_(handle, command_args.data());
}

int MpvDynamicLibrary::commandString(mpv_handle* handle, const std::string& command) const {
  if (!command_string_) return -1;
  return command_string_(handle, command.c_str());
}

int MpvDynamicLibrary::setDouble(mpv_handle* handle, const std::string& name, double value) const {
  return set_property_ ? set_property_(handle, name.c_str(), MPV_FORMAT_DOUBLE, &value) : -1;
}

int MpvDynamicLibrary::setFlag(mpv_handle* handle, const std::string& name, bool value) const {
  int flag = value ? 1 : 0;
  return set_property_ ? set_property_(handle, name.c_str(), MPV_FORMAT_FLAG, &flag) : -1;
}

int MpvDynamicLibrary::getDouble(mpv_handle* handle, const std::string& name, double* value) const {
  return get_property_ ? get_property_(handle, name.c_str(), MPV_FORMAT_DOUBLE, value) : -1;
}

int MpvDynamicLibrary::getFlag(mpv_handle* handle, const std::string& name, bool* value) const {
  int flag = 0;
  const int result = get_property_ ? get_property_(handle, name.c_str(), MPV_FORMAT_FLAG, &flag) : -1;
  if (result >= 0 && value) *value = flag != 0;
  return result;
}

void MpvDynamicLibrary::destroy(mpv_handle* handle) const {
  if (destroy_ && handle) destroy_(handle);
}

int MpvDynamicLibrary::createRenderContext(mpv_render_context** context, mpv_handle* handle, mpv_render_param* params) const {
  return render_context_create_ ? render_context_create_(context, handle, params) : -1;
}

void MpvDynamicLibrary::setRenderUpdateCallback(mpv_render_context* context, MpvRenderUpdateCallback callback, void* callbackContext) const {
  if (render_context_set_update_callback_ && context) render_context_set_update_callback_(context, callback, callbackContext);
}

std::uint64_t MpvDynamicLibrary::updateRenderContext(mpv_render_context* context) const {
  return render_context_update_ && context ? render_context_update_(context) : 0;
}

int MpvDynamicLibrary::render(mpv_render_context* context, mpv_render_param* params) const {
  return render_context_render_ && context ? render_context_render_(context, params) : -1;
}

void MpvDynamicLibrary::reportRenderSwap(mpv_render_context* context) const {
  if (render_context_report_swap_ && context) render_context_report_swap_(context);
}

void MpvDynamicLibrary::freeRenderContext(mpv_render_context* context) const {
  if (render_context_free_ && context) render_context_free_(context);
}

std::string MpvDynamicLibrary::errorString(int code) const {
  if (error_string_) {
    const char* message = error_string_(code);
    if (message) return message;
  }
  return "libmpv error " + std::to_string(code);
}

}  // namespace fongmi
