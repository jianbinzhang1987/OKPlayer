#include <node_api.h>

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "libmpv_player.h"
#include "mpv_dynamic.h"

namespace {

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Boolean(napi_env env, bool input) {
  napi_value value;
  napi_get_boolean(env, input, &value);
  return value;
}

napi_value Number(napi_env env, double input) {
  napi_value value;
  napi_create_double(env, input, &value);
  return value;
}

napi_value String(napi_env env, const std::string& input) {
  napi_value value;
  napi_create_string_utf8(env, input.c_str(), input.size(), &value);
  return value;
}

std::string ToString(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  buffer.resize(length);
  return buffer;
}

double ToNumber(napi_env env, napi_value value) {
  double result = 0;
  napi_get_value_double(env, value, &result);
  return result;
}

bool ToBoolean(napi_env env, napi_value value) {
  bool result = false;
  napi_get_value_bool(env, value, &result);
  return result;
}

std::uintptr_t ToPointer(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_bigint) {
    std::uint64_t result = 0;
    bool lossless = false;
    napi_get_value_bigint_uint64(env, value, &result, &lossless);
    if (!lossless) throw std::runtime_error("原生窗口句柄超出可表示范围");
    return static_cast<std::uintptr_t>(result);
  }
  if (type == napi_number) return static_cast<std::uintptr_t>(ToNumber(env, value));
  throw std::runtime_error("原生窗口句柄必须是 bigint 或 number");
}

void ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

std::unordered_map<std::string, std::string> HeadersFromValue(napi_env env, napi_value value) {
  std::unordered_map<std::string, std::string> headers;
  napi_valuetype value_type;
  napi_typeof(env, value, &value_type);
  if (value_type != napi_object) return headers;

  napi_value names;
  napi_get_property_names(env, value, &names);
  uint32_t length = 0;
  napi_get_array_length(env, names, &length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value key_value;
    napi_get_element(env, names, index, &key_value);
    std::string key = ToString(env, key_value);
    napi_value field_value;
    napi_get_property(env, value, key_value, &field_value);
    napi_valuetype field_type;
    napi_typeof(env, field_value, &field_type);
    if (field_type == napi_string) headers[key] = ToString(env, field_value);
  }
  return headers;
}

fongmi::LibmpvPlayer* UnwrapPlayer(napi_env env, napi_callback_info info, size_t* argc, napi_value* args) {
  napi_value this_arg;
  napi_get_cb_info(env, info, argc, args, &this_arg, nullptr);
  void* data = nullptr;
  napi_unwrap(env, this_arg, &data);
  return static_cast<fongmi::LibmpvPlayer*>(data);
}

napi_value ViewResultToObject(napi_env env, const fongmi::NativeViewResult& result) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "ok", Boolean(env, result.ok));
  napi_set_named_property(env, object, "message", String(env, result.message));
  napi_value handle;
  napi_create_bigint_uint64(env, static_cast<std::uint64_t>(result.viewHandle), &handle);
  napi_set_named_property(env, object, "viewHandle", handle);
  return object;
}

napi_value StateToObject(napi_env env, const fongmi::NativePlayerState& state) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "position", Number(env, state.position));
  napi_set_named_property(env, object, "duration", Number(env, state.duration));
  napi_set_named_property(env, object, "speed", Number(env, state.speed));
  napi_set_named_property(env, object, "volume", Number(env, state.volume));
  napi_set_named_property(env, object, "paused", Boolean(env, state.paused));
  napi_set_named_property(env, object, "muted", Boolean(env, state.muted));
  napi_set_named_property(env, object, "stopped", Boolean(env, state.stopped));
  return object;
}

napi_value MethodLoad(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (!player || argc < 1) {
    ThrowError(env, "load 需要播放地址");
    return Undefined(env);
  }
  try {
    player->Load(ToString(env, args[0]), argc > 1 ? HeadersFromValue(env, args[1]) : std::unordered_map<std::string, std::string>{});
  } catch (const std::exception& error) {
    ThrowError(env, error.what());
  }
  return Undefined(env);
}

napi_value MethodPlay(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player) player->Play();
  return Undefined(env);
}

napi_value MethodPause(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player) player->Pause();
  return Undefined(env);
}

napi_value MethodStop(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player) player->Stop();
  return Undefined(env);
}

napi_value MethodSeek(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player && argc > 0) player->Seek(ToNumber(env, args[0]));
  return Undefined(env);
}

napi_value MethodSetSpeed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player && argc > 0) player->SetSpeed(ToNumber(env, args[0]));
  return Undefined(env);
}

napi_value MethodSetVolume(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player && argc > 0) player->SetVolume(ToNumber(env, args[0]));
  return Undefined(env);
}

napi_value MethodSetMuted(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player && argc > 0) player->SetMuted(ToBoolean(env, args[0]));
  return Undefined(env);
}

napi_value MethodAttachView(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (!player || argc < 5) {
    ThrowError(env, "attachView 需要父窗口句柄和播放区域");
    return Undefined(env);
  }
  try {
    return ViewResultToObject(env, player->AttachView(
      ToPointer(env, args[0]),
      static_cast<int>(ToNumber(env, args[1])),
      static_cast<int>(ToNumber(env, args[2])),
      static_cast<int>(ToNumber(env, args[3])),
      static_cast<int>(ToNumber(env, args[4]))));
  } catch (const std::exception& error) {
    ThrowError(env, error.what());
    return Undefined(env);
  }
}

napi_value MethodResizeView(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player && argc >= 4) {
    player->ResizeView(
      static_cast<int>(ToNumber(env, args[0])),
      static_cast<int>(ToNumber(env, args[1])),
      static_cast<int>(ToNumber(env, args[2])),
      static_cast<int>(ToNumber(env, args[3])));
  }
  return Undefined(env);
}

napi_value MethodDetachView(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player) player->DetachView();
  return Undefined(env);
}

napi_value MethodIsViewAttached(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  return Boolean(env, player && player->IsViewAttached());
}

napi_value MethodGetState(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  return player ? StateToObject(env, player->GetState()) : Undefined(env);
}

napi_value MethodDestroy(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  auto* player = UnwrapPlayer(env, info, &argc, args);
  if (player) player->Destroy();
  return Undefined(env);
}

void PlayerFinalizer(napi_env /*env*/, void* data, void* /*hint*/) {
  delete static_cast<fongmi::LibmpvPlayer*>(data);
}

void DefineMethod(napi_env env, napi_value object, const char* name, napi_callback callback) {
  napi_value function;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function);
  napi_set_named_property(env, object, name, function);
}

napi_value CreatePlayer(napi_env env, napi_callback_info /*info*/) {
  napi_value object;
  napi_create_object(env, &object);
  auto* player = new fongmi::LibmpvPlayer();
  napi_wrap(env, object, player, PlayerFinalizer, nullptr, nullptr);
  DefineMethod(env, object, "load", MethodLoad);
  DefineMethod(env, object, "play", MethodPlay);
  DefineMethod(env, object, "pause", MethodPause);
  DefineMethod(env, object, "stop", MethodStop);
  DefineMethod(env, object, "seek", MethodSeek);
  DefineMethod(env, object, "setSpeed", MethodSetSpeed);
  DefineMethod(env, object, "setVolume", MethodSetVolume);
  DefineMethod(env, object, "setMuted", MethodSetMuted);
  DefineMethod(env, object, "attachView", MethodAttachView);
  DefineMethod(env, object, "resizeView", MethodResizeView);
  DefineMethod(env, object, "detachView", MethodDetachView);
  DefineMethod(env, object, "isViewAttached", MethodIsViewAttached);
  DefineMethod(env, object, "getState", MethodGetState);
  DefineMethod(env, object, "destroy", MethodDestroy);
  return object;
}

napi_value GetBuildInfo(napi_env env, napi_callback_info /*info*/) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "name", String(env, "fongmi_libmpv_player"));
  napi_set_named_property(env, object, "api", String(env, "node-api"));
  auto& library = fongmi::MpvDynamicLibrary::Instance();
  napi_set_named_property(env, object, "linkedLibmpv", Boolean(env, library.available()));
  napi_set_named_property(env, object, "renderApiAvailable", Boolean(env, library.renderApiAvailable()));
  napi_set_named_property(env, object, "renderReady", Boolean(env, library.renderApiAvailable() && fongmi::NativeViewRenderSupported()));
  napi_set_named_property(env, object, "libmpvPath", String(env, library.path()));
  napi_set_named_property(env, object, "libmpvError", String(env, library.error()));
  napi_set_named_property(env, object, "clientApiVersion", Number(env, static_cast<double>(library.clientApiVersion())));
#if defined(__APPLE__)
  napi_set_named_property(env, object, "platform", String(env, "darwin"));
#elif defined(_WIN32)
  napi_set_named_property(env, object, "platform", String(env, "win32"));
#elif defined(__linux__)
  napi_set_named_property(env, object, "platform", String(env, "linux"));
#else
  napi_set_named_property(env, object, "platform", String(env, "unknown"));
#endif
  return object;
}

napi_value Init(napi_env env, napi_value exports) {
  DefineMethod(env, exports, "createPlayer", CreatePlayer);
  DefineMethod(env, exports, "getBuildInfo", GetBuildInfo);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
