const STORAGE_KEY = "state";
const CURRENT_VERSION = 1;

const DEFAULT_STATE = {
  version: CURRENT_VERSION,
  settings: {
    hiddenMessageDisplay: "none"
  },
  messages: {}
};

async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

function normalizeState(input) {
  const state = input && typeof input === "object" ? input : {};
  const settings = state.settings && typeof state.settings === "object" ? state.settings : {};
  const messages = state.messages && typeof state.messages === "object" ? state.messages : {};

  return {
    version: CURRENT_VERSION,
    settings: {
      hiddenMessageDisplay:
        settings.hiddenMessageDisplay === "placeholder" ? "placeholder" : "none"
    },
    messages
  };
}

async function saveState(state) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalizeState(state)
  });
}

async function updateState(mutator) {
  const state = await getState();
  await mutator(state);
  await saveState(state);
  return state;
}

async function broadcastState(state, sourceTabId = null) {
  const tabs = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  await Promise.all(
    tabs.map((tab) => {
      if (sourceTabId !== null && tab.id === sourceTabId) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state }).catch(() => {});
    })
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await saveState(DEFAULT_STATE);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        sendResponse({ ok: true, state: await getState() });
        return;
      }

      case "OPEN_OPTIONS": {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      case "HIDE_MESSAGE": {
        const record = message.record;
        if (!record?.id) {
          sendResponse({ ok: false, error: "Missing message id" });
          return;
        }

        const state = await updateState((current) => {
          current.messages[String(record.id)] = normalizeRecord(record);
        });
        await broadcastState(state, sender.tab?.id ?? null);
        sendResponse({ ok: true, state });
        return;
      }

      case "UNHIDE_MESSAGE": {
        const id = String(message.id ?? "");
        if (!id) {
          sendResponse({ ok: false, error: "Missing message id" });
          return;
        }

        const state = await updateState((current) => {
          delete current.messages[id];
        });
        await broadcastState(state, sender.tab?.id ?? null);
        sendResponse({ ok: true, state });
        return;
      }

      case "SET_DISPLAY_MODE": {
        const mode = message.mode === "placeholder" ? "placeholder" : "none";
        const state = await updateState((current) => {
          current.settings.hiddenMessageDisplay = mode;
        });
        await broadcastState(state, sender.tab?.id ?? null);
        sendResponse({ ok: true, state });
        return;
      }

      case "REPLACE_STATE": {
        const imported = normalizeState(message.state);
        const merge = message.merge !== false;
        const state = await updateState((current) => {
          current.settings = imported.settings;
          if (merge) {
            current.messages = { ...current.messages, ...imported.messages };
          } else {
            current.messages = imported.messages;
          }
        });
        await broadcastState(state, sender.tab?.id ?? null);
        sendResponse({ ok: true, state });
        return;
      }

      case "CLEAR_ALL": {
        const state = await updateState((current) => {
          current.messages = {};
        });
        await broadcastState(state, sender.tab?.id ?? null);
        sendResponse({ ok: true, state });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((error) => {
    console.error("Discord Message Hider error:", error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dmh") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "PING") {
      port.postMessage({ type: "PONG" });
    }
  });
});

function normalizeRecord(record) {
  return {
    id: String(record.id),
    channelId: String(record.channelId ?? ""),
    channelName: String(record.channelName ?? ""),
    guildId: String(record.guildId ?? ""),
    authorId: String(record.authorId ?? ""),
    authorName: String(record.authorName ?? ""),
    content: String(record.content ?? ""),
    attachments: Array.isArray(record.attachments)
      ? record.attachments.map((attachment) => ({
          name: String(attachment?.name ?? ""),
          url: String(attachment?.url ?? "")
        }))
      : [],
    hiddenAt: Number.isFinite(Number(record.hiddenAt))
      ? Number(record.hiddenAt)
      : Date.now()
  };
}
