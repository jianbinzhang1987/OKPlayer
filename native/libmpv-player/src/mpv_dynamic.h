#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "mpv_render_abi.h"

namespace fongmi {

class MpvDynamicLibrary final {
 public:
  using CreateFn = mpv_handle* (*)();
  using InitializeFn = int (*)(mpv_handle*);
  using SetOptionStringFn = int (*)(mpv_handle*, const char*, const char*);
  using CommandFn = int (*)(mpv_handle*, const char**);
  using CommandStringFn = int (*)(mpv_handle*, const char*);
  using SetPropertyFn = int (*)(mpv_handle*, const char*, int, void*);
  using GetPropertyFn = int (*)(mpv_handle*, const char*, int, void*);
  using DestroyFn = void (*)(mpv_handle*);
  using ErrorStringFn = const char* (*)(int);
  using ClientApiVersionFn = unsigned long (*)(void);
  using RenderContextCreateFn = int (*)(mpv_render_context**, mpv_handle*, mpv_render_param*);
  using RenderContextSetUpdateCallbackFn = void (*)(mpv_render_context*, MpvRenderUpdateCallback, void*);
  using RenderContextUpdateFn = std::uint64_t (*)(mpv_render_context*);
  using RenderContextRenderFn = int (*)(mpv_render_context*, mpv_render_param*);
  using RenderContextReportSwapFn = void (*)(mpv_render_context*);
  using RenderContextFreeFn = void (*)(mpv_render_context*);

  static MpvDynamicLibrary& Instance();

  bool available() const { return available_; }
  const std::string& path() const { return path_; }
  const std::string& error() const { return error_; }
  unsigned long clientApiVersion() const;
  bool renderApiAvailable() const;

  mpv_handle* create() const;
  int setOptionString(mpv_handle* handle, const std::string& name, const std::string& value) const;
  int initialize(mpv_handle* handle) const;
  int command(mpv_handle* handle, const std::vector<std::string>& args) const;
  int commandString(mpv_handle* handle, const std::string& command) const;
  int setDouble(mpv_handle* handle, const std::string& name, double value) const;
  int setFlag(mpv_handle* handle, const std::string& name, bool value) const;
  int getDouble(mpv_handle* handle, const std::string& name, double* value) const;
  int getFlag(mpv_handle* handle, const std::string& name, bool* value) const;
  void destroy(mpv_handle* handle) const;
  int createRenderContext(mpv_render_context** context, mpv_handle* handle, mpv_render_param* params) const;
  void setRenderUpdateCallback(mpv_render_context* context, MpvRenderUpdateCallback callback, void* callbackContext) const;
  std::uint64_t updateRenderContext(mpv_render_context* context) const;
  int render(mpv_render_context* context, mpv_render_param* params) const;
  void reportRenderSwap(mpv_render_context* context) const;
  void freeRenderContext(mpv_render_context* context) const;
  std::string errorString(int code) const;

 private:
  MpvDynamicLibrary();
  ~MpvDynamicLibrary();
  MpvDynamicLibrary(const MpvDynamicLibrary&) = delete;
  MpvDynamicLibrary& operator=(const MpvDynamicLibrary&) = delete;

  void* library_ = nullptr;
  bool available_ = false;
  std::string path_;
  std::string error_;

  CreateFn create_ = nullptr;
  InitializeFn initialize_ = nullptr;
  SetOptionStringFn set_option_string_ = nullptr;
  CommandFn command_ = nullptr;
  CommandStringFn command_string_ = nullptr;
  SetPropertyFn set_property_ = nullptr;
  GetPropertyFn get_property_ = nullptr;
  DestroyFn destroy_ = nullptr;
  ErrorStringFn error_string_ = nullptr;
  ClientApiVersionFn client_api_version_ = nullptr;
  RenderContextCreateFn render_context_create_ = nullptr;
  RenderContextSetUpdateCallbackFn render_context_set_update_callback_ = nullptr;
  RenderContextUpdateFn render_context_update_ = nullptr;
  RenderContextRenderFn render_context_render_ = nullptr;
  RenderContextReportSwapFn render_context_report_swap_ = nullptr;
  RenderContextFreeFn render_context_free_ = nullptr;
};

std::vector<std::string> DefaultLibmpvCandidates();
std::string FormatLibmpvHeaders(const std::unordered_map<std::string, std::string>& headers);

}  // namespace fongmi
