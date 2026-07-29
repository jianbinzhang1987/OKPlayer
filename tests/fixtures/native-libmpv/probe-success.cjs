process.stdout.write(`${JSON.stringify({
  ok: true,
  buildInfo: {
    name: "fongmi_libmpv_player",
    api: "node-api",
    platform: process.platform,
    linkedLibmpv: true,
    renderReady: true,
    libmpvPath: process.argv[3],
    clientApiVersion: 131072,
  },
  state: { position: 0, duration: 0, paused: false, stopped: true, speed: 1, volume: 100, muted: false },
})}\n`);
