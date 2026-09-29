(() => {
  "use strict";

  const STORAGE_KEY = "state";
  const count = document.getElementById("count");
  const radios = [...document.querySelectorAll('input[name="display"]')];

  load();

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  for (const radio of radios) {
    radio.addEventListener("change", async () => {
      await sendMessage({ type: "SET_DISPLAY_MODE", mode: radio.value });
    });
  }

  async function load() {
    const response = await sendMessage({ type: "GET_STATE" });
    if (!response?.ok) return;
    const state = response.state;
    count.textContent = String(Object.keys(state.messages || {}).length);
    for (const radio of radios) {
      radio.checked = radio.value === state.settings.hiddenMessageDisplay;
    }
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }
})();
