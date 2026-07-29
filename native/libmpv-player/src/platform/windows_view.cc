#ifdef _WIN32
#include <windows.h>
#endif

namespace fongmi::libmpv::platform {

void ReserveWindowsViewBridge() {
  // The real implementation will create a child HWND and bind libmpv rendering
  // to it. This stub keeps the platform compilation unit in place.
}

}  // namespace fongmi::libmpv::platform
