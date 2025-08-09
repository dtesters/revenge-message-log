import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

// In-memory unsubscribers/patch removers
let unpatchOpenLazy = null;
const subscriptions = [];

// Stores we query when our snapshot is missing
const MessageStore = findByProps("getMessage", "getMessages");

// ActionSheet utilities
const ActionSheet = findByProps("openLazy", "close");
const Sheet = findByProps("ActionSheetRow", "ActionSheetCloseButton", "ActionSheetTitleHeader");

// Initialize persistent storage layout
function ensureStorage() {
  if (!storage.logs) storage.logs = {}; // { [channelId: string]: LogEntry[] }
  if (!storage.messageIndex) storage.messageIndex = {}; // { [messageId: string]: MessageSnapshot }
}

function simplifyEmbed(embed) {
  if (!embed) return null;
  const { title, description, url, color, timestamp, author, footer, fields, provider, image, thumbnail, video } = embed;
  return {
    title,
    description,
    url,
    color,
    timestamp,
    author: author ? { name: author.name, url: author.url, icon_url: author.icon_url } : undefined,
    footer: footer ? { text: footer.text, icon_url: footer.icon_url } : undefined,
    fields: Array.isArray(fields)
      ? fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }))
      : undefined,
    provider: provider ? { name: provider.name, url: provider.url } : undefined,
    image: image ? { url: image.url, proxy_url: image.proxy_url, width: image.width, height: image.height } : undefined,
    thumbnail: thumbnail ? { url: thumbnail.url, proxy_url: thumbnail.proxy_url, width: thumbnail.width, height: thumbnail.height } : undefined,
    video: video ? { url: video.url, width: video.width, height: video.height } : undefined,
  };
}

function normalizeEmbeds(embeds) {
  if (!embeds) return [];
  return embeds.map(simplifyEmbed).filter(Boolean);
}

function areEmbedsEqual(a, b) {
  try {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  } catch {
    return false;
  }
}

function snapshotFromMessage(message) {
  if (!message) return null;
  const channelId = message.channel_id ?? message.channelId;
  return {
    messageId: message.id,
    channelId,
    authorId: message.author?.id,
    content: message.content ?? "",
    embeds: normalizeEmbeds(message.embeds ?? []),
    timestamp: Date.now(),
  };
}

function getStoredSnapshot(messageId) {
  return storage.messageIndex?.[messageId] ?? null;
}

function setStoredSnapshot(snap) {
  if (!snap || !snap.messageId) return;
  storage.messageIndex[snap.messageId] = {
    messageId: snap.messageId,
    channelId: snap.channelId,
    authorId: snap.authorId,
    content: snap.content ?? "",
    embeds: normalizeEmbeds(snap.embeds ?? []),
    timestamp: Date.now(),
  };
}

function snapshotFromStore(channelId, messageId) {
  try {
    if (!MessageStore?.getMessage) return null;
    const msg = MessageStore.getMessage(channelId, messageId);
    return snapshotFromMessage(msg);
  } catch {
    return null;
  }
}

function appendLog(channelId, entry) {
  if (!channelId) return;
  if (!storage.logs[channelId]) storage.logs[channelId] = [];
  storage.logs[channelId].push({ ...entry, ts: Date.now() });
  // Optional: bound log size per channel to avoid unbounded growth
  const MAX = 500;
  if (storage.logs[channelId].length > MAX) {
    storage.logs[channelId] = storage.logs[channelId].slice(-MAX);
  }
}

function clearChannelLogs(channelId) {
  if (!channelId) return;
  storage.logs[channelId] = [];
}

function subscribe(type, handler) {
  FluxDispatcher.subscribe(type, handler);
  subscriptions.push({ type, handler });
}

function unsubscribeAll() {
  for (const s of subscriptions.splice(0)) {
    try { FluxDispatcher.unsubscribe(s.type, s.handler); } catch {}
  }
}

// ActionSheet injection for Channel Long Press: add "Clear log"
function patchChannelLongPressActionSheet() {
  if (!ActionSheet?.openLazy) return;
  unpatchOpenLazy = after("openLazy", ActionSheet, (args, ret) => {
    try {
      const key = args?.[0];
      if (key !== "ChannelLongPressActionSheet") return;
      ret.then((sheet) => {
        const original = sheet?.default;
        if (!original) return;
        sheet.default = (props) => {
          const element = original(props);

          // Attempt to append a row to the sheet's children tree
          try {
            const RowComponent = Sheet?.ActionSheetRow;
            if (!RowComponent) return element;
            const row = React.createElement(RowComponent, {
              key: "vd-msglog-clear",
              label: "Clear log",
              title: "Clear log",
              onPress: () => {
                try {
                  const channelId = props?.channel?.id ?? props?.channel?.channel?.id ?? props?.channelId;
                  clearChannelLogs(channelId);
                  showToast("Message log cleared for this channel.");
                } catch {}
                try { ActionSheet?.close?.(); } catch {}
              },
              disabled: !props?.channel?.id,
            });

            // Known sheet structure: element.props.children.props.children is array of sections
            const root = element?.props?.children;
            const body = root?.props?.children;
            // Use heuristic: find a section array and push our row as a separate section or append to last
            if (Array.isArray(body)) {
              // Append to the last section if it looks like a list
              const last = body[body.length - 1];
              if (last?.props?.children && Array.isArray(last.props.children)) {
                last.props.children.push(row);
              } else {
                body.push(React.createElement(React.Fragment, { key: "vd-msglog-section" }, row));
              }
            } else if (body?.props?.children && Array.isArray(body.props.children)) {
              body.props.children.push(row);
            }
          } catch {
            // If structure changes, silently fail to avoid breaking the sheet
          }

          return element;
        };
      });
    } catch {
      // ignore
    }
  });
}

// Event handlers
function onMessageCreate(action) {
  const message = action?.message ?? action;
  const snap = snapshotFromMessage(message);
  if (snap) setStoredSnapshot(snap);
}

function onMessageUpdate(action) {
  const next = action?.message ?? {};
  const channelId = next.channel_id ?? action?.channelId;
  const messageId = next.id ?? action?.id;
  if (!messageId || !channelId) return;

  const prev = getStoredSnapshot(messageId) || snapshotFromStore(channelId, messageId);
  const nextSnap = snapshotFromMessage(next);

  // Update our index regardless
  if (nextSnap) setStoredSnapshot(nextSnap);

  if (!prev || !nextSnap) return;

  const contentChanged = (prev.content ?? "") !== (nextSnap.content ?? "");
  const embedsChanged = !areEmbedsEqual(prev.embeds, nextSnap.embeds);

  if (contentChanged || embedsChanged) {
    appendLog(channelId, {
      type: "edit",
      messageId,
      channelId,
      authorId: prev.authorId ?? nextSnap.authorId,
      oldContent: prev.content ?? "",
      newContent: nextSnap.content ?? "",
      oldEmbeds: prev.embeds ?? [],
      newEmbeds: nextSnap.embeds ?? [],
    });
  }
}

function onMessageDelete(action) {
  const channelId = action?.channelId ?? action?.channel_id;
  const id = action?.id ?? action?.messageId;
  if (!channelId || !id) return;

  const prev = getStoredSnapshot(id) || snapshotFromStore(channelId, id);
  appendLog(channelId, {
    type: "delete",
    messageId: id,
    channelId,
    authorId: prev?.authorId,
    oldContent: prev?.content ?? "",
    oldEmbeds: prev?.embeds ?? [],
  });
}

function onMessageDeleteBulk(action) {
  const channelId = action?.channelId ?? action?.channel_id;
  const ids = action?.ids ?? [];
  if (!channelId || !Array.isArray(ids)) return;
  for (const id of ids) onMessageDelete({ channelId, id });
}

export function onLoad() {
  ensureStorage();

  // Subscribe to core message events
  subscribe("MESSAGE_CREATE", onMessageCreate);
  subscribe("MESSAGE_UPDATE", onMessageUpdate);
  subscribe("MESSAGE_DELETE", onMessageDelete);
  subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);

  // Patch channel long-press menu to add our Clear Log action
  patchChannelLongPressActionSheet();
}

export function onUnload() {
  try { unsubscribeAll(); } catch {}
  try { unpatchOpenLazy?.(); unpatchOpenLazy = null; } catch {}
}

export const settings = {
  get name() { return "Message Log"; },
  render() {
    const View = ReactNative?.View ?? ((props) => React.createElement("div", props));
    const Text = ReactNative?.Text ?? ((props) => React.createElement("span", props));
    const rows = Object.entries(storage.logs ?? {}).map(([cid, entries]) =>
      React.createElement(View, { key: cid, style: { padding: 8 } },
        React.createElement(Text, null, `Channel ${cid}: ${entries.length} entries`)
      )
    );
    return React.createElement(View, { style: { padding: 12 } }, rows);
  },
};

export default { onLoad, onUnload, settings };


