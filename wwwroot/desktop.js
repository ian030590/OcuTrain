/* Tauri 2 desktop adapter; the same training page also runs in a browser. */
(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) return;
  const invoke = tauri.core.invoke;
  let fullscreenChange = Promise.resolve();
  let pendingStatus = null;
  const forward = payload => {
    if (typeof window.handleNativeTobiiMessage === "function") window.handleNativeTobiiMessage(payload);
    else if (payload.type === "status") pendingStatus = payload;
  };
  const ready = Promise.all([
    tauri.event.listen("tobii-gaze", event => forward(event.payload)),
    tauri.event.listen("tobii-eyes", event => forward(event.payload)),
    tauri.event.listen("tobii-status", event => forward(event.payload))
  ]);
  // Register synchronously, before app.js captures its bridge reference.
  window.isTobiiNativeHost = true;
  window.OcuTrainDesktop = {
    async GetStatusJson() {
      await ready;
      const status = await invoke("get_status");
      if (pendingStatus) { pendingStatus = null; forward(status); }
      return JSON.stringify(status);
    },
    async GetClockJson() { return JSON.stringify(await invoke("get_clock")); },
    SaveCsv(filename, content) { return invoke("save_document", { filename, content }); },
    OpenDataFolder() { return invoke("open_data_folder"); },
    async FullscreenReady() {
      // fullscreenchange may be delivered after requestFullscreen's promise resolves.
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      await fullscreenChange;
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    }
  };
  // WebView2's DOM fullscreen state and the native window must change together.
  document.addEventListener("fullscreenchange", () => {
    fullscreenChange = fullscreenChange.catch(() => {}).then(() => invoke("set_fullscreen", { fullscreen: Boolean(document.fullscreenElement) }));
    fullscreenChange.catch(error => {
      console.error("Could not change desktop fullscreen:", error);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    });
  });
})();
