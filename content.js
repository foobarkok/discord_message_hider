(() => {
  "use strict";

  const EMPTY_STATE = {
    version: 1,
    settings: { hiddenMessageDisplay: "none" },
    messages: {}
  };

  let state = structuredClone(EMPTY_STATE);
  let contextMessage = null;
  let scanScheduled = false;
  let lastUrl = location.href;

  const CONTEXT_MENU_ID = "dmh-context-menu";

  init().catch((error) => console.error("Discord Message Hider init failed:", error));

  async function init() {
    injectContextMenu();
    bindGlobalEvents();

    const response = await sendMessage({ type: "GET_STATE" });
    if (response?.ok) {
      state = response.state;
    }

    applyCurrentState();
    observeDom();
  }

  function bindGlobalEvents() {
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "STATE_UPDATED") return;
      state = message.state;
      applyCurrentState();
    });

    window.addEventListener("popstate", () => {
      lastUrl = location.href;
      scheduleScan();
    });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScan();
      }
    }, 1000);
  }

  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "childList" || mutation.addedNodes.length === 0) continue;
        if (mutationIsRelevant(mutation)) {
          scheduleScan();
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    scheduleScan();
  }

  function mutationIsRelevant(mutation) {
    if (isComposerNode(mutation.target)) return false;
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = /** @type {Element} */ (node);
      if (getMessageInfo(element) || element.querySelector?.('[id^="chat-messages-"]')) {
        return true;
      }
      if (element.id?.startsWith("message-content-")) return true;
    }
    return Boolean(findMessageContainer(mutation.target));
  }

  function isComposerNode(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest('textarea, [contenteditable="true"], [role="textbox"]'));
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      applyCurrentState();
    });
  }

  function isLinkedToPreviousAuthor(previous, current) {
    // 直前のメッセージに含まれるユーザー名要素のID
    const previousUsername = previous.querySelector(
      '[id^="message-username-"]'
    );

    if (!previousUsername?.id) return false;

    // 現在のメッセージ、または内部のarticle要素のaria-labelledby
    const labelledElement = current.matches("[aria-labelledby]")
      ? current
      : current.querySelector("[aria-labelledby]");

    if (!labelledElement) return false;

    const labelledBy = (
      labelledElement.getAttribute("aria-labelledby") || ""
    ).split(/\s+/);

    return labelledBy.includes(previousUsername.id);
  }

  function sameAuthor(a, b) {
    if (a.authorId && b.authorId) {
      return a.authorId === b.authorId;
    }

    if (
      a.authorName &&
      b.authorName &&
      a.authorName !== "不明なユーザー" &&
      b.authorName !== "不明なユーザー"
    ) {
      return a.authorName === b.authorName;
    }

    return false;
  }

  function getDiscordMessageLayoutNode(row) {
    return row.querySelector(
      '[class*="compact"], [class*="cozyMessage"], [class*="cozy"]'
    );
  }

  function findCozyClass(current, messageNodes) {
    const currentIndex = messageNodes.indexOf(current);

    for (let distance = 1; distance < messageNodes.length; distance += 1) {
      for (const index of [
        currentIndex - distance,
        currentIndex + distance
      ]) {
        if (index < 0 || index >= messageNodes.length) continue;

        const candidate = messageNodes[index];
        const layoutNode = getDiscordMessageLayoutNode(candidate);
        if (!layoutNode) continue;

        const cozy = Array.from(layoutNode.classList).find(
          (name) => name.toLowerCase().includes("cozy")
        );

        if (cozy) return cozy;
      }
    }

    return null;
  }

  function updateCompactMessagesAfterHidden(messageNodes, hiddenIds) {
    // 以前の変更を解除してから再判定
    for (const node of messageNodes) {
      node.classList.remove("dmh-promoted-cozy");

      const inner = getDiscordMessageLayoutNode(node);
      if (inner) inner.classList.remove("dmh-promoted-cozy");
    }

    for (let i = 1; i < messageNodes.length; i += 1) {
      const previous = messageNodes[i - 1];
      const current = messageNodes[i];

      const previousInfo = getMessageInfo(previous);
      const currentInfo = getMessageInfo(current);

      if (!previousInfo?.id || !hiddenIds.has(previousInfo.id)) continue;
      if (!sameAuthor(previousInfo, currentInfo)) continue;

      const layoutNode = getDiscordMessageLayoutNode(current);
      if (!layoutNode) continue;

      const classes = Array.from(layoutNode.classList);
      const compactClass = classes.find(
        (name) => name.toLowerCase().includes("compact")
      );

      if (!compactClass) continue;

      const cozyClass = findCozyClass(current, messageNodes);

      if (cozyClass) {
        layoutNode.classList.remove(compactClass);
        layoutNode.classList.add(cozyClass, "dmh-promoted-cozy");
        current.classList.add("dmh-promoted-cozy");
      }
    }
  }

  function findAuthorNode(messageElement) {
    const selectors = [
      '[id^="message-username-"]',
      '[class*="username"]',
      '[class*="headerText"]',
      '[class*="header-text"]',
      'h3 span[role="button"]',
      'h3 span'
    ];

    for (const selector of selectors) {
      const node = messageElement.querySelector(selector);
      if (node && cleanSingleLine(node.textContent || "")) {
        return node;
      }
    }

    return null;
  }

  function findAvatarNode(messageElement) {
    const selectors = [
      'img[class*="avatar"]',
      '[class*="avatar"] img',
      'img[src*="/avatars/"]',
      'img[src*="/users/"]'
    ];

    for (const selector of selectors) {
      const node = messageElement.querySelector(selector);
      if (node instanceof HTMLImageElement && node.src) {
        return node;
      }
    }

    return null;
  }

  function updateMissingGroupedMessageHeaders(messageNodes, hiddenIds) {
    document.querySelectorAll(".dmh-synthetic-author-header")
      .forEach((node) => node.remove());

    for (let i = 1; i < messageNodes.length; i += 1) {
      const previous = messageNodes[i - 1];
      const current = messageNodes[i];

      const previousInfo = getMessageInfo(previous);
      const currentInfo = getMessageInfo(current);

      if (!previousInfo?.id || !hiddenIds.has(previousInfo.id)) continue;
      if (
        !sameAuthor(previousInfo, currentInfo) &&
        !isLinkedToPreviousAuthor(previous, current)
      ) {
        continue;
      }

      const contentNode = findMessageContentNode(current, currentInfo.id);
      if (!contentNode) continue;

      const authorNode = findAuthorNode(previous);
      const avatarNode = findAvatarNode(previous);
      const authorName =
        previousInfo.authorName ||
        cleanSingleLine(authorNode?.textContent || "");

      if (!authorName && !avatarNode) continue;

      const header = document.createElement("div");
      header.className = "dmh-synthetic-author-header";
      header.setAttribute("aria-hidden", "true");

      if (avatarNode) {
        const avatar = avatarNode.cloneNode(true);
        avatar.removeAttribute("id");
        avatar.classList.add("dmh-synthetic-avatar");
        avatar.setAttribute("alt", "");
        avatar.setAttribute("aria-hidden", "true");
        avatar.removeAttribute("srcset");
        header.appendChild(avatar);
      }

      if (authorName) {
        const name = document.createElement("span");
        name.className = "dmh-synthetic-author-name";
        name.textContent = authorName;
        header.appendChild(name);
      }

      contentNode.parentElement?.insertBefore(header, contentNode);
    }
  }

  function applyCurrentState() {
    const messageNodes = getAllMessageContainers();
    const hiddenIds = new Set(Object.keys(state.messages || {}));

    for (const element of messageNodes) {
      const info = getMessageInfo(element);
      if (!info?.id) continue;

      const isHidden = hiddenIds.has(info.id);
      if (isHidden) {
        applyHiddenMessageStyle(element);
      } else {
        removeHiddenMessageStyle(element);
      }

      updateQuoteReferences(element);
    }

    updateCompactMessagesAfterHidden(messageNodes, hiddenIds);
    updateMissingGroupedMessageHeaders(messageNodes, hiddenIds);

    for (const quote of getPotentialQuoteContainers()) {
      updateQuoteContainer(quote, findReferenceId(quote, null));
    }
  }

  function getAllMessageContainers() {
    const nodes = [];
    const seen = new Set();
    const selectors = [
      'li[id^="chat-messages-"]',
      '[id^="chat-messages-"]',
      '[data-list-item-id^="chat-messages-"]'
    ];

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        if (!getMessageInfo(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }

    return nodes;
  }

  function findMessageContainer(target) {
    let element = target instanceof Element ? target : target?.parentElement;
    for (let i = 0; element && i < 30; i += 1) {
      if (getMessageInfo(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function getMessageInfo(element) {
    if (!(element instanceof Element)) return null;

    const candidates = [
      element.id,
      element.getAttribute("data-list-item-id"),
      element.getAttribute("data-message-id")
    ].filter(Boolean);

    let id = "";
    let channelId = "";

    for (const value of candidates) {
      const match = String(value).match(/chat-messages-(\d+)-(\d+)$/);
      if (match) {
        channelId ||= match[1];
        id ||= match[2];
      }
      const contentMatch = String(value).match(/message-content-(\d+)$/);
      if (contentMatch) id ||= contentMatch[1];
    }

    if (!id) {
      const contentNode = element.querySelector('[id^="message-content-"]');
      const match = contentNode?.id?.match(/^message-content-(\d+)$/);
      if (match) id = match[1];
    }

    if (!id) return null;

    channelId ||= getChannelIdFromUrl();

    const contentNode = findMessageContentNode(element, id);
    const content = contentNode ? cleanText(contentNode.innerText || contentNode.textContent || "") : "";
    const author = findAuthor(element);
    const attachments = findAttachments(element);

    return {
      id,
      channelId,
      guildId: getGuildIdFromUrl(),
      channelName: getCurrentChannelName(),
      authorId: author.id,
      authorName: author.name,
      content,
      attachments
    };
  }

  function findMessageContentNode(element, messageId) {
    return (
      element.querySelector(`#message-content-${CSS.escape(messageId)}`) ||
      element.querySelector('[id^="message-content-"]') ||
      element.querySelector('[class*="markup-"]') ||
      element.querySelector('[class*="markup"]')
    );
  }

  function findAuthor(element) {
    const selectors = [
      '[id^="message-username-"]',
      '[class*="username"]',
      '[class*="headerText"]',
      '[class*="header-text"]',
      'h3 [data-text-variant]',
      'h3 span[role="button"]',
      'h3 span',
      'h2 span'
    ];

    for (const selector of selectors) {
      const nodes = element.querySelectorAll(selector);

      for (const node of nodes) {
        const name = cleanSingleLine(
          node.textContent ||
          node.getAttribute("aria-label") ||
          node.getAttribute("data-text") ||
          ""
        );

        if (
          name &&
          name !== "(unknown user)" &&
          !name.includes("Bot") &&
          !/^\d+$/.test(name)
        ) {
          const id =
            node.getAttribute("data-user-id") ||
            findUserIdFromElement(node) ||
            "";

          return { id, name };
        }
      }
    }

    // Discordのアクセシビリティ情報から取得を試みる
    const ariaNodes = element.querySelectorAll("[aria-label]");
    for (const node of ariaNodes) {
      const label = cleanSingleLine(node.getAttribute("aria-label") || "");

      const match = label.match(
        /^(.+?)(?:,\s*(?:BOT|bot))?(?:\s*,\s*(?:edited|編集済み))?$/
      );

      if (match && match[1] && match[1].length < 100) {
        const name = match[1].trim();

        if (
          name &&
          name !== "(unknown user)" &&
          !/^\d+$/.test(name)
        ) {
          return {
            id: findUserIdFromElement(node) || "",
            name
          };
        }
      }
    }

    return {
      id: "",
      name: "不明なユーザー"
    };
  }

  function findUserIdFromElement(node) {
    let current = node instanceof Element ? node : null;
    for (let i = 0; current && i < 8; i += 1) {
      for (const attribute of ["data-user-id", "data-id"]) {
        const value = current.getAttribute(attribute);
        if (/^\d{15,25}$/.test(value || "")) return value;
      }
      for (const value of current.getAttributeNames().map((name) => current.getAttribute(name))) {
        const match = String(value || "").match(/\b(\d{15,25})\b/);
        if (match) return match[1];
      }
      current = current.parentElement;
    }
    return "";
  }

  function findAttachments(element) {
    const attachments = [];
    const seen = new Set();
    for (const link of element.querySelectorAll('a[href]')) {
      const href = link.href;
      if (!href) continue;
      if (!/(cdn\.discordapp\.com|media\.discordapp\.net)/i.test(href)) continue;
      const name = cleanSingleLine(link.textContent || link.getAttribute("aria-label") || "");
      const key = `${name}\n${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push({ name, url: href });
    }
    return attachments;
  }

  function getChannelIdFromUrl() {
    const match = location.pathname.match(/^\/channels\/[^/]+\/(\d+)/);
    return match?.[1] || "";
  }

  function getGuildIdFromUrl() {
    const match = location.pathname.match(/^\/channels\/([^/]+)\//);
    return match?.[1] && match[1] !== "@me" ? match[1] : "";
  }

  function getCurrentChannelName() {
    const selectors = [
      'main header h1',
      '[role="main"] header h1',
      'main h1',
      'header h1',
      '[class*="title-"]'
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const name = cleanSingleLine(node.textContent || "");
        if (name && !/^\d+$/.test(name)) return name;
      }
    }

    return "";
  }

  function cleanSingleLine(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function cleanText(text) {
    return String(text)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim();
  }

  async function hideMessage(element) {
    const info = getMessageInfo(element);
    if (!info?.id) return;

    const record = {
      ...info,
      hiddenAt: Date.now()
    };

    const response = await sendMessage({ type: "HIDE_MESSAGE", record });
    if (!response?.ok) {
      console.error("Could not hide message:", response?.error);
      return;
    }

    state = response.state;
    applyCurrentState();
    hideContextMenu();
  }

  async function unhideMessageById(id) {
    const response = await sendMessage({ type: "UNHIDE_MESSAGE", id });
    if (!response?.ok) {
      console.error("Could not unhide message:", response?.error);
      return;
    }
    state = response.state;
    applyCurrentState();
  }

  function applyHiddenMessageStyle(element) {
    element.classList.add("dmh-hidden-message");
    element.classList.toggle(
      "dmh-placeholder-mode",
      state.settings.hiddenMessageDisplay === "placeholder"
    );
  }

  function removeHiddenMessageStyle(element) {
    element.classList.remove("dmh-hidden-message", "dmh-placeholder-mode");
  }

  function updateQuoteReferences(messageElement) {
    for (const quote of getPotentialQuoteContainers(messageElement)) {
      const refId = findReferenceId(quote, getMessageInfo(messageElement)?.id || null);
      updateQuoteContainer(quote, refId);
    }
  }

  function getPotentialQuoteContainers(root = document) {
    const selectors = [
      '[class*="repliedMessage"]',
      '[class*="replied-message"]',
      '[class*="replying"]',
      '[class*="reply"]',
      '[class*="reference"]',
      '[id*="message-reference"]'
    ];

    const result = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of root.querySelectorAll?.(selector) || []) {
        if (seen.has(element)) continue;
        if (element.closest?.('[contenteditable="true"], textarea')) continue;
        seen.add(element);
        result.push(element);
      }
    }
    return result;
  }

  function findReferenceId(container, currentMessageId) {
    if (!(container instanceof Element)) return "";

    const hrefNodes = [container, ...container.querySelectorAll("a[href]")];
    for (const node of hrefNodes) {
      const href = node.getAttribute?.("href") || "";
      const match = href.match(/\/channels\/[^/]+\/\d+\/(\d{15,25})(?:[?#].*)?$/);
      if (match?.[1] && match[1] !== currentMessageId) return match[1];
    }

    for (const node of [container, ...container.querySelectorAll("[id]")]) {
      const match = String(node.id || "").match(/^message-content-(\d{15,25})$/);
      if (match?.[1] && match[1] !== currentMessageId) return match[1];
    }

    const attrs = [
      "data-message-id",
      "data-reference-message-id",
      "data-referenced-message-id"
    ];
    for (const node of [container, ...container.querySelectorAll("*")]) {
      for (const attr of attrs) {
        const value = node.getAttribute?.(attr);
        if (/^\d{15,25}$/.test(value || "") && value !== currentMessageId) return value;
      }
    }

    return "";
  }

  function updateQuoteContainer(container, referenceId) {
    if (!(container instanceof Element)) return;
    const shouldHide = Boolean(referenceId && state.messages?.[referenceId]);
    container.classList.toggle("dmh-quote-hidden", shouldHide);
    container.dataset.dmhReferenceId = referenceId || "";
  }
  function injectContextMenu() {
    const menu = document.createElement("div");
    menu.id = CONTEXT_MENU_ID;
    menu.className = "dmh-context-menu";
    menu.hidden = true;
    menu.innerHTML = `
      <button type="button" data-action="toggle"></button>
      <button type="button" data-action="options">非表示メッセージを管理</button>
    `;
    document.body.appendChild(menu);
  }

  function onContextMenu(event) {
    // Only handle context menus originating from an actual Discord message row.
    // Other Discord UI (channels, rooms, categories, server list, etc.) must
    // retain its native context menu.
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const messageElement = findMessageContainer(target);
    if (!messageElement || !isMessageContextTarget(target, messageElement)) return;

    const info = getMessageInfo(messageElement);
    if (!info?.id) return;

    event.preventDefault();
    event.stopPropagation();

    contextMessage = messageElement;
    const menu = document.getElementById(CONTEXT_MENU_ID);
    const toggle = menu?.querySelector('[data-action="toggle"]');
    if (!menu || !toggle) return;

    const isHidden = Boolean(state.messages?.[info.id]);
    toggle.textContent = isHidden ? "このメッセージの非表示を解除" : "このメッセージを非表示";
    toggle.classList.toggle("danger", !isHidden);

    const x = Math.min(event.clientX, window.innerWidth - 240);
    const y = Math.min(event.clientY, window.innerHeight - 100);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    menu.hidden = false;
  }

  function isMessageContextTarget(target, messageElement) {
    // Discord message rows are identified by the chat-messages-* marker.
    const row = target.closest(
      'li[id^="chat-messages-"], [id^="chat-messages-"], [data-list-item-id^="chat-messages-"]'
    );
    return Boolean(row && (row === messageElement || row.contains(messageElement)));
  }

  function onDocumentClick(event) {
    const menu = document.getElementById(CONTEXT_MENU_ID);
    const button = event.target instanceof Element ? event.target.closest("button") : null;

    if (button?.closest(`#${CSS.escape(CONTEXT_MENU_ID)}`)) {
      const action = button.dataset.action;
      if (action === "toggle" && contextMessage) {
        const info = getMessageInfo(contextMessage);
        if (info?.id) {
          if (state.messages?.[info.id]) {
            unhideMessageById(info.id);
          } else {
            hideMessage(contextMessage);
          }
        }
      } else if (action === "options") {
        sendMessage({ type: "OPEN_OPTIONS" });
      }
      hideContextMenu();
      return;
    }

    if (menu && !menu.contains(event.target)) {
      hideContextMenu();
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") hideContextMenu();
  }

  function hideContextMenu() {
    const menu = document.getElementById(CONTEXT_MENU_ID);
    if (menu) menu.hidden = true;
    contextMessage = null;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }
})();
