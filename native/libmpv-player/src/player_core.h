#pragma once

#include <string>

namespace fongmi::libmpv {

struct BackendInfo {
  std::string name;
  std::string mode;
  std::string status;
  std::string reason;
};

BackendInfo GetBackendInfo();

}  // namespace fongmi::libmpv
