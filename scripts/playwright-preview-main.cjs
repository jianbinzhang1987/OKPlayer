const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0c10",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadURL("http://127.0.0.1:4179/?preview=1");
  window.show();
});

app.on("window-all-closed", () => app.quit());
