import { createApp } from "vue";
import App from "./App.vue";
import { createMockTvApi } from "./mock-api.ts";
import "./styles.css";

const previewMode = new URLSearchParams(window.location.search).get("preview") === "1";
if (import.meta.env.DEV && (previewMode || !(window as any).tvApi)) {
  const descriptor = Object.getOwnPropertyDescriptor(window, "tvApi");
  if (!descriptor || descriptor.configurable || descriptor.writable) {
    Object.defineProperty(window, "tvApi", { value: createMockTvApi(), configurable: true, writable: true });
  }
}

document.documentElement.dataset.platform = (window as any).tvApi?.platform ?? "unknown";
document.documentElement.dataset.desktopPlatform = (window as any).tvApi?.desktopPlatform ?? "unknown";

createApp(App).mount("#app");
