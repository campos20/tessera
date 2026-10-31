// Installs coi-sw.js and reloads once so the page is served cross-origin isolated.
// No-op when the server already sends COOP/COEP (dev server, preview, proper hosting).
(function () {
  if (window.crossOriginIsolated || !window.isSecureContext || !("serviceWorker" in navigator)) {
    sessionStorage.removeItem("tessera-coi-reloaded");
    return;
  }
  // Reload at most once per session so a browser that refuses isolation can't loop.
  if (sessionStorage.getItem("tessera-coi-reloaded")) {
    console.warn("tessera: cross-origin isolation unavailable even with the service worker");
    return;
  }
  var swUrl = new URL("coi-sw.js", document.currentScript.src);
  navigator.serviceWorker
    .register(swUrl)
    .then(function () {
      return navigator.serviceWorker.ready;
    })
    .then(function () {
      sessionStorage.setItem("tessera-coi-reloaded", "1");
      window.location.reload();
    })
    .catch(function (e) {
      console.warn("tessera: failed to register the cross-origin isolation service worker", e);
    });
})();
