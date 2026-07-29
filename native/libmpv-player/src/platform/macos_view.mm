#import <Cocoa/Cocoa.h>

namespace fongmi::libmpv::platform {

void ReserveMacosViewBridge() {
  // The real implementation will attach an NSView backed by libmpv's render
  // context to the Electron BrowserWindow native handle. This stub keeps the
  // platform compilation unit in place without changing current playback.
}

}  // namespace fongmi::libmpv::platform
