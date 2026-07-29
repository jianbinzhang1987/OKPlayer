#include "player_core.h"

namespace fongmi::libmpv {

BackendInfo GetBackendInfo() {
  return BackendInfo{
    "fongmi-native-libmpv",
    "node-api",
    "scaffold",
    "Native addon boundary is available; real libmpv render binding is not enabled in this scaffold build."
  };
}

}  // namespace fongmi::libmpv
