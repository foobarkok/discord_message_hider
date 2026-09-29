(() => {
  "use strict";

  let state = {
    version: 1,
    settings: { hiddenMessageDisplay: "none" },
    messages: {}
  };

  const list = document.getElementById("list");
  const search = document.getElementById("search");
  const sort = document.getElementById("sort");
  const visibleCount = document.getElementById("visible-count");
  const totalCount = document.getElementById("total-count");
  const unhideSelected = document.getElementById("unhide-selected");
  const clearAll = document.getElementById("clear-all");
  const template = document.getElementById("message-template");

  init().catch((error) => showError(error));

  async function init() {
    const response = await sendMessage({ type: "GET_STATE" });
    if (!response?.ok) throw new Error(response?.error || "状態を取得できませんでした。");
    state = response.state;

    bindEvents();
    renderSettings();
    renderList();

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "STATE_UPDATED") return;
      state = message.state;
      renderSettings();
      renderList();
    });
  }

  function bindEvents() {
    search.addEventListener("input", renderList);
    sort.addEventListener("change", renderList);

    document.querySelectorAll('input[name="display"]').forEach((radio) => {
      radio.addEventListener("change", async () => {
        const response = await sendMessage({ type: "SET_DISPLAY_MODE", mode: radio.value });
        if (response?.ok) state = response.state;
        renderList();
      });
    });

    unhideSelected.addEventListener("click", async () => {
      const ids = getSelectedIds();
      if (!ids.length) return;
      await Promise.all(ids.map((id) => sendMessage({ type: "UNHIDE_MESSAGE", id })));
      const response = await sendMessage({ type: "GET_STATE" });
      if (response?.ok) state = response.state;
      renderList();
    });

    clearAll.addEventListener("click", async () => {
      const count = Object.keys(state.messages || {}).length;
      if (!count) return;
      const confirmed = window.confirm(`非表示リストの${count}件をすべて解除しますか？`);
      if (!confirmed) return;
      const response = await sendMessage({ type: "CLEAR_ALL" });
      if (response?.ok) state = response.state;
      renderList();
    });

    document.getElementById("export").addEventListener("click", exportJson);
    document.getElementById("import").addEventListener("click", () => {
      document.getElementById("import-file").click();
    });
    document.getElementById("import-file").addEventListener("change", importJson);
  }

  function renderSettings() {
    for (const radio of document.querySelectorAll('input[name="display"]')) {
      radio.checked = radio.value === state.settings.hiddenMessageDisplay;
    }
  }

  function renderList() {
    const records = getFilteredRecords();
    list.replaceChildren();

    const total = Object.keys(state.messages || {}).length;
    totalCount.textContent = String(total);
    visibleCount.textContent = String(records.length);
    clearAll.disabled = total === 0;
    unhideSelected.disabled = records.length === 0;

    if (!records.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = total === 0 ? "まだ非表示にしたメッセージはありません。" : "検索条件に一致するメッセージはありません。";
      list.appendChild(empty);
      return;
    }

    for (const record of records) {
      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".message-card");
      const checkbox = fragment.querySelector(".select-message");
      const channel = fragment.querySelector(".channel");
      const author = fragment.querySelector(".author");
      const time = fragment.querySelector(".hidden-at");
      const content = fragment.querySelector(".content");
      const attachments = fragment.querySelector(".attachments");
      const id = fragment.querySelector(".message-id");
      const unhide = fragment.querySelector(".unhide-one");

      checkbox.dataset.id = record.id;
      channel.textContent = record.channelName || `(channel ${record.channelId || "unknown"})`;
      author.textContent = record.authorName || "(unknown user)";
      const date = new Date(record.hiddenAt);
      time.textContent = Number.isNaN(date.getTime()) ? "" : formatDate(date);
      content.textContent = record.content || "(テキスト本文なし)";
      id.textContent = record.id;

      for (const attachment of record.attachments || []) {
        const line = document.createElement("div");
        line.className = "attachment";
        line.textContent = attachment.name || attachment.url || "attachment";
        line.title = attachment.url || "";
        attachments.appendChild(line);
      }

      unhide.addEventListener("click", async () => {
        const response = await sendMessage({ type: "UNHIDE_MESSAGE", id: record.id });
        if (response?.ok) state = response.state;
        renderList();
      });

      checkbox.addEventListener("change", updateSelectionUi);
      card.dataset.id = record.id;
      list.appendChild(fragment);
    }

    updateSelectionUi();
  }

  function getFilteredRecords() {
    const query = search.value.trim().toLocaleLowerCase();
    const records = Object.values(state.messages || {}).filter((record) => {
      if (!query) return true;
      return [record.content, record.authorName, record.channelName, record.authorId, record.channelId]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });

    records.sort((a, b) => {
      switch (sort.value) {
        case "oldest": return Number(a.hiddenAt) - Number(b.hiddenAt);
        case "channel": return String(a.channelName).localeCompare(String(b.channelName), "ja");
        case "author": return String(a.authorName).localeCompare(String(b.authorName), "ja");
        case "newest":
        default: return Number(b.hiddenAt) - Number(a.hiddenAt);
      }
    });

    return records;
  }

  function getSelectedIds() {
    return [...document.querySelectorAll(".select-message:checked")]
      .map((checkbox) => checkbox.dataset.id)
      .filter(Boolean);
  }

  function updateSelectionUi() {
    const selected = getSelectedIds().length;
    unhideSelected.disabled = selected === 0;
    unhideSelected.textContent = selected
      ? `選択した${selected}件を非表示リストから外す`
      : "選択したものを非表示リストから外す";
  }

  async function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `discord-message-hider-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      validateImport(parsed);

      const currentCount = Object.keys(state.messages || {}).length;
      const incomingCount = Object.keys(parsed.messages || {}).length;
      const replace = window.confirm(
        `JSONには${incomingCount}件の非表示メッセージがあります。\n\nOK: 現在のリストに追加（同じIDは上書き）\nキャンセル: インポートを中止`
      );
      if (!replace) return;

      const response = await sendMessage({ type: "REPLACE_STATE", state: parsed, merge: true });
      if (!response?.ok) throw new Error(response?.error || "インポートに失敗しました。");
      state = response.state;
      renderSettings();
      renderList();
      void currentCount;
    } catch (error) {
      showError(error);
    }
  }

  function validateImport(parsed) {
    if (!parsed || typeof parsed !== "object") throw new Error("JSONの形式が不正です。");
    if (typeof parsed.messages !== "object" || parsed.messages === null || Array.isArray(parsed.messages)) {
      throw new Error("messagesが見つかりません。");
    }
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function showError(error) {
    console.error(error);
    window.alert(`Discord Message Hider: ${error?.message || String(error)}`);
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
