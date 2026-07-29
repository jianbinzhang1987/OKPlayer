namespace fongmi::libmpv::platform {

void ReserveLinuxViewBridge() {
  // The real implementation will prefer X11 embedding first and fall back to a
  // guarded external compatibility backend under Wayland until the compositor
  // strategy is verified.
}

}  // namespace fongmi::libmpv::platform
