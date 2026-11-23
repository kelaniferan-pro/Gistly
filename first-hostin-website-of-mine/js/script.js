// ======================================================
// Gistly - script.js
// ======================================================

// ---------- Saving data in the browser ----------
// localStorage is shared by every tab of this browser, so two accounts
// logged in in two tabs can message each other through it.
const memory = {}; // backup if localStorage is blocked
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (e) {
      return key in memory ? memory[key] : fallback;
    }
  },
  // Returns true if saved, false if the browser storage is full
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { memory[key] = value; return false; }
  }
};

// Who is logged in is saved per tab, so each tab can be a different account.
const session = {
  get() { try { return sessionStorage.getItem("chatbot_session"); } catch (e) { return null; } },
  set(phone) {
    try {
      if (phone) sessionStorage.setItem("chatbot_session", phone);
      else sessionStorage.removeItem("chatbot_session");
    } catch (e) {}
  }
};

// Scrambles the password (demo only). A real site must do this on a server.
async function hash(text) {
  try {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return text;
  }
}

// ---------- Page elements and state ----------
const $ = id => document.getElementById(id);
const msgBox = $("auth-msg");
const list = $("messages");
const input = $("text");
const BOT_ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2z"/></svg>';
const DAY = 24 * 60 * 60 * 1000; // statuses disappear after 24 hours

let me = null;        // phone number of the logged-in person
let active = "bot";   // open chat: "bot", a phone number, or "ch:<channel id>"
let lastFrom = null;
let botTyping = false;
let botPending = 0;
let pending = null;   // where the photo being picked is going
let pendingImg = "";
let viewer = null;    // { items, i } while the full-screen viewer is open

// ---------- Country codes ----------
const countries = [
  ["Australia", "+61"], ["Brazil", "+55"], ["Canada", "+1"], ["France", "+33"],
  ["Germany", "+49"], ["Ghana", "+233"], ["India", "+91"], ["Kenya", "+254"],
  ["Nigeria", "+234"], ["South Africa", "+27"], ["United Kingdom", "+44"], ["United States", "+1"]
];
["login-code", "signup-code", "new-code", "admin-code"].forEach(id => {
  countries.forEach(([name, code]) => {
    $(id).add(new Option(name + " (" + code + ")", code, false, name === "United States"));
  });
});

// Turns "+234" and "0803 123 4567" into "+2348031234567". Returns "" if invalid.
function makePhone(code, number) {
  const digits = number.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 6 || digits.length > 14) return "";
  return code + digits;
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const timeText = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = "msg" + (ok ? " ok" : "");
  el.hidden = false;
}

// ---------- Login and Create profile ----------
function showTab(which) {
  const isLogin = which === "login";
  $("login-form").hidden = !isLogin;
  $("signup-form").hidden = isLogin;
  $("tab-login").setAttribute("aria-selected", isLogin);
  $("tab-signup").setAttribute("aria-selected", !isLogin);
  msgBox.hidden = true;
}
const showError = text => showMsg(msgBox, text, false);

$("tab-login").onclick = () => showTab("login");
$("tab-signup").onclick = () => showTab("signup");

$("signup-btn").onclick = async () => {
  const name = $("signup-name").value.trim();
  const phone = makePhone($("signup-code").value, $("signup-phone").value);
  const pass = $("signup-password").value;

  if (!name || !$("signup-phone").value.trim() || !pass) return showError("Fill in your name, phone number, and password.");
  if (!phone) return showError("Enter a valid phone number.");
  if (pass.length < 6) return showError("Use a password with at least 6 characters.");

  const all = store.get("chatbot_users", []);
  if (all.some(u => u.phone === phone)) return showError("Account already exists. Log in instead.");

  all.push({ name, phone, pass: await hash(pass) });
  store.set("chatbot_users", all);
  openApp(phone, name);
};

$("login-btn").onclick = async () => {
  const phone = makePhone($("login-code").value, $("login-phone").value);
  const pass = $("login-password").value;

  if (!$("login-phone").value.trim() || !pass) return showError("Enter your phone number and password.");
  if (!phone) return showError("Enter a valid phone number.");

  const user = store.get("chatbot_users", []).find(u => u.phone === phone);
  if (!user) return showError("No account found with that number. Create a profile first.");
  if (user.pass !== await hash(pass)) return showError("Wrong password. Try again.");
  openApp(user.phone, user.name);
};

$("logout-btn").onclick = () => {
  session.set(null);
  me = null;
  closeAll();
  $("app").hidden = true;
  $("auth").hidden = false;
  showTab("login");
};

// ---------- Reading data ----------
const users = () => store.get("chatbot_users", []);
// Names: the name YOU gave a contact is what you see. Without one you see the phone number.
const profileName = phone => { const u = users().find(x => x.phone === phone); return u ? u.name : phone; };
const savedNames = () => store.get("names_" + me, {});
const nameOf = phone => {
  if (phone === me) return profileName(phone);
  const saved = savedNames()[phone];
  if (saved) return saved;
  // contacts added before names existed keep their profile name
  return store.get("contacts_" + me, []).includes(phone) ? profileName(phone) : phone;
};
// For senders inside groups and channels who may not be saved: "~Profile name"
const publicName = phone => (phone === me ? profileName(phone) : savedNames()[phone] || "~" + profileName(phone));
const withNumber = phone => {
  const n = nameOf(phone);
  if (n !== phone) return n + " (" + phone + ")";
  return profileName(phone) === phone ? phone : "~" + profileName(phone) + " (" + phone + ")";
};
const pairKey = (a, b) => [a, b].sort().join("|");   // one key per pair of people
const allMsgs = () => store.get("chatbot_msgs", {});
const msgsWith = other => allMsgs()[pairKey(me, other)] || [];
const readsOf = phone => store.get("reads_" + phone, {}); // when each person last read each chat
const botHistory = () => store.get("chat_" + me, []);
const isOpen = () => matchMedia("(min-width: 800px)").matches || $("app").classList.contains("show-chat");
const isChannel = id => id.startsWith("ch:");
const channels = () => store.get("chatbot_channels", []);
const channelOf = id => channels().find(c => "ch:" + c.id === id);
const canPost = c => c.owner === me || c.admins.includes(me);
const MAX_GROUP = 20; // most people in a group, including you
const isGroup = id => id.startsWith("gr:");
const groups = () => store.get("chatbot_groups", []);
const groupOf = id => groups().find(g => "gr:" + g.id === id);

// Everyone a person added, plus anyone who has texted them
function contactsOf(phone) {
  const found = new Set(store.get("contacts_" + phone, []));
  Object.keys(allMsgs()).forEach(key => {
    const [a, b] = key.split("|");
    if (a === phone) found.add(b);
    if (b === phone) found.add(a);
  });
  found.delete(phone); // your "message yourself" chat is not a contact
  return [...found];
}
const contactList = () => contactsOf(me);

function title(id) {
  if (id === "bot") return "Chatbot";
  if (id === me) return "You";
  if (isChannel(id)) { const c = channelOf(id); return c ? c.name : "Channel"; }
  if (isGroup(id)) { const g = groupOf(id); return g ? g.name : "Group"; }
  return nameOf(id);
}

// A chat as a simple list. side "user" = right, "bot" = left
function thread(id) {
  if (id === "bot") {
    return botHistory().map(m => ({
      side: m.from, from: m.from, text: m.text, t: m.t,
      ticks: m.from === "user", read: !(m.from === "user" && m.t === botPending)
    }));
  }
  if (isChannel(id)) {
    const c = channelOf(id);
    return c ? c.posts.map(p => ({
      side: p.from === me ? "user" : "bot", from: p.from, text: p.text, img: p.img, t: p.t,
      poll: p.poll, pid: p.id, who: p.from === me ? "" : publicName(p.from), ticks: false
    })) : [];
  }
  if (isGroup(id)) {
    const g = groupOf(id);
    // A message gets blue ticks when every other member has read it
    return g ? g.messages.map(m => ({
      side: m.from === me ? "user" : "bot", from: m.from, text: m.text, img: m.img, t: m.t,
      who: m.from === me ? "" : publicName(m.from), ticks: m.from === me,
      read: g.members.filter(p => p !== m.from).every(p => (readsOf(p)[id] || 0) >= m.t)
    })) : [];
  }
  const theirRead = readsOf(id)[me] || 0;
  return msgsWith(id).map(m => ({
    side: m.from === me ? "user" : "bot", from: m.from, text: m.text, img: m.img, t: m.t,
    ticks: m.from === me, read: id === me || m.t <= theirRead
  }));
}

function unread(id) {
  const lastRead = readsOf(me)[id] || 0;
  const msgs = isGroup(id) ? (groupOf(id) || { messages: [] }).messages : msgsWith(id);
  return msgs.filter(m => m.from !== me && m.t > lastRead).length;
}

// Marks the open chat as read (this turns the sender's ticks blue)
function markRead() {
  if (!me || active === "bot" || isChannel(active) || !isOpen()) return;
  let incoming;
  if (isGroup(active)) {
    const g = groupOf(active);
    if (!g || !g.members.includes(me)) return;
    incoming = g.messages.filter(m => m.from !== me);
  } else {
    incoming = msgsWith(active).filter(m => m.from !== me);
  }
  if (!incoming.length) return;
  const latest = incoming[incoming.length - 1].t;
  const reads = readsOf(me);
  if ((reads[active] || 0) < latest) {
    reads[active] = latest;
    store.set("reads_" + me, reads);
  }
}

// ---------- Drawing: avatars, chat list, conversation ----------
function setAvatar(el, id) {
  el.className = "avatar" + (id === "bot" ? " bot" : isChannel(id) ? " chan" : isGroup(id) ? " grp" : "");
  if (id === "bot") el.innerHTML = BOT_ICON;
  else el.textContent = (id === me ? nameOf(me) : title(id)).charAt(0).toUpperCase();
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const botLast = botHistory().slice(-1)[0];
  const items = [{ id: "bot", name: "Chatbot", last: botLast, prefix: botLast && botLast.from === "user" ? "You: " : "", unread: 0 }];

  // Message yourself
  const selfMsgs = msgsWith(me);
  items.push({ id: me, name: "You (Message yourself)", last: selfMsgs[selfMsgs.length - 1], prefix: "", unread: 0, empty: "Message yourself" });

  contactList().forEach(p => {
    const m = msgsWith(p);
    const last = m[m.length - 1];
    items.push({ id: p, name: nameOf(p), last, prefix: last && last.from === me ? "You: " : "", unread: unread(p) });
  });

  groups().filter(g => g.members.includes(me)).forEach(g => {
    const last = g.messages[g.messages.length - 1];
    items.push({
      id: "gr:" + g.id, name: g.name, last, t: g.t, unread: unread("gr:" + g.id), empty: "Group created",
      prefix: last ? (last.from === me ? "You: " : publicName(last.from) + ": ") : ""
    });
  });

  const stamp = i => (i.last ? i.last.t : i.t || 0);
  items.sort((a, b) => stamp(b) - stamp(a));

  const ul = $("chat-list");
  ul.innerHTML = "";
  items.filter(i => (i.name + " " + i.id).toLowerCase().includes(q)).forEach(i => {
    const li = document.createElement("li");
    li.className = "chat-item" + (i.id === active ? " active" : "");
    li.tabIndex = 0;
    li.innerHTML =
      '<div></div><div class="grow">' +
      '<div class="top"><span class="name"></span><span class="time-s"></span></div>' +
      '<div class="top"><span class="preview"></span></div></div>';
    setAvatar(li.firstChild, i.id);
    li.querySelector(".name").textContent = i.name;
    li.querySelector(".time-s").textContent = i.last ? timeText(i.last.t) : "";
    li.querySelector(".preview").textContent = i.last
      ? i.prefix + (i.last.text || "📷 Photo")
      : i.empty || "Tap to start chatting";
    if (i.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = i.unread;
      li.querySelectorAll(".top")[1].appendChild(badge);
    }
    li.onclick = () => openChatWith(i.id);
    li.onkeydown = e => { if (e.key === "Enter") openChatWith(i.id); };
    ul.appendChild(li);
  });
}

function renderConversation() {
  // If I left the group that was open, go back to the bot chat
  if (isGroup(active)) {
    const g0 = groupOf(active);
    if (!g0 || !g0.members.includes(me)) active = "bot";
  }
  const c = isChannel(active) ? channelOf(active) : null;
  const g = isGroup(active) ? groupOf(active) : null;
  $("chat-name").textContent = title(active);
  setAvatar($("chat-avatar"), active);

  let status;
  if (active === "bot") status = botTyping ? "typing…" : "online";
  else if (c) {
    const n = c.followers.length;
    status = n + (n === 1 ? " follower" : " followers") + (c.owner === me ? " · Owner" : c.admins.includes(me) ? " · Admin" : "");
  } else if (g) status = g.members.map(p => (p === me ? "You" : publicName(p))).join(", ");
  else if (active === me) status = "Message yourself";
  else status = active;
  $("status").textContent = status;

  const readOnly = !!c && !canPost(c);
  $("admin-btn").hidden = !(c || g);
  $("contact-btn").hidden = !(!c && !g && active !== "bot" && active !== me);
  $("composer").hidden = readOnly;
  $("channel-note").hidden = !readOnly;
  $("attach-btn").hidden = active === "bot";
  $("poll-btn").hidden = !(c && canPost(c));

  list.innerHTML = '<div class="chip">Today</div>';
  lastFrom = null;
  thread(active).forEach(m => addBubble(m));
}

// Draws one bubble (text and/or photo)
function addBubble(m) {
  const row = document.createElement("div");
  row.className = "row " + m.side;

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (lastFrom !== m.side ? " tail" : "") + (m.img ? " has-img" : "") + (m.poll ? " has-poll" : "");
  lastFrom = m.side;

  if (m.who) {
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = m.who;
    bubble.appendChild(who);
  }
  if (m.poll) bubble.appendChild(buildPoll(m));
  if (m.img) {
    const pic = new Image();
    pic.className = "msg-img";
    pic.alt = "Photo";
    pic.src = m.img;
    pic.onload = () => { list.scrollTop = list.scrollHeight; };
    pic.onclick = () => openViewer([{ img: m.img, caption: m.text, from: m.from, t: m.t }], 0);
    bubble.appendChild(pic);
  }
  if (m.text) {
    const words = document.createElement("span");
    words.textContent = m.text;
    bubble.appendChild(words);
  }

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timeText(m.t);
  if (m.ticks) {
    const ticks = document.createElement("span");
    ticks.className = "ticks" + (m.read ? " read" : "");
    ticks.textContent = "✓✓";
    meta.appendChild(ticks);
  }
  bubble.appendChild(meta);

  row.appendChild(bubble);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function render() {
  if (!me) return;
  markRead();
  renderList();
  renderConversation();
  renderUpdates();
}

function openChatWith(id) {
  active = id;
  $("app").classList.add("show-chat"); // on phones, switch to the conversation
  render();
  if (!$("composer").hidden) input.focus();
}

function openApp(phone, name) {
  me = phone;
  session.set(phone);
  active = "bot";
  closeAll();
  $("auth").hidden = true;
  $("app").hidden = false;
  $("app").classList.remove("show-chat"); // on phones, start at the chat list
  $("new-chat").hidden = true;
  setSideTab("chats");
  $("my-avatar").textContent = name.charAt(0).toUpperCase();
  $("my-name").textContent = name;
  $("my-phone").textContent = phone;

  if (!botHistory().length) {
    pushBot(phone, { from: "bot", text: "Hi " + name + "! Send me a message to get started.", t: Date.now() });
  }
  render();
}

// ---------- Sending messages ----------
const replies = [
  "This is a placeholder reply. Real answers are coming soon.",
  "Thanks for your message. I’m still learning how to respond.",
  "Interesting! Tell me more.",
  "I’m a demo bot for now, but I’m listening.",
  "Got it. A smarter reply will go here later."
];

function pushBot(phone, message) {
  const key = "chat_" + phone;
  const history = store.get(key, []);
  history.push(message);
  store.set(key, history);
}

function sendMessage(other, text, img) {
  const all = allMsgs();
  const key = pairKey(me, other);
  (all[key] = all[key] || []).push({ from: me, text, img: img || "", t: Date.now() });
  return store.set("chatbot_msgs", all);
}

function postToChannel(id, text, img) {
  const arr = channels();
  const c = arr.find(x => "ch:" + x.id === id);
  if (!c || !canPost(c)) return false;
  c.posts.push({ from: me, text, img: img || "", t: Date.now() });
  return store.set("chatbot_channels", arr);
}

function send() {
  const text = input.value.trim();
  if (!text || !me) return;
  input.value = "";
  const phone = me;

  if (active === "bot") {
    const mine = { from: "user", text, t: Date.now() };
    pushBot(phone, mine);
    botPending = mine.t;
    botTyping = true;
    render();
    // After a short pause the bot replies (replace this for a real bot)
    setTimeout(() => {
      botPending = 0;
      botTyping = false;
      pushBot(phone, { from: "bot", text: replies[Math.floor(Math.random() * replies.length)], t: Date.now() });
      if (me === phone) render();
    }, 1100);
    return;
  }

  if (isChannel(active)) postToChannel(active, text, "");
  else if (isGroup(active)) sendToGroup(active, text, "");
  else sendMessage(active, text, "");
  render();
}

$("send-btn").onclick = send;
input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });

// ---------- Photos: take or choose, shrink, preview, send ----------
// Photos are shrunk first so they fit in the browser's small storage.
function compress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 720 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function pickPhoto(target) {
  pending = target;
  $("source-sheet").hidden = false;
}

$("attach-btn").onclick = () => pickPhoto({ type: isChannel(active) ? "channel" : "chat", id: active });
$("add-status-btn").onclick = e => { e.stopPropagation(); pickPhoto({ type: "status" }); };
$("src-camera").onclick = () => { $("source-sheet").hidden = true; $("cam-input").click(); };
$("src-gallery").onclick = () => { $("source-sheet").hidden = true; $("file-input").click(); };

["cam-input", "file-input"].forEach(id => {
  $(id).addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !pending) return;
    try { pendingImg = await compress(file); }
    catch (err) { return alert("Could not read that photo."); }
    $("photo-preview").src = pendingImg;
    $("photo-caption").value = "";
    $("photo-send").textContent = pending.type === "status" ? "Post status" : "Send";
    $("photo-modal").hidden = false;
  });
});

$("photo-send").onclick = () => {
  const caption = $("photo-caption").value.trim();
  let ok;
  if (pending.type === "status") ok = addStatus(pendingImg, caption);
  else if (pending.type === "channel") ok = postToChannel(pending.id, caption, pendingImg);
  else if (isGroup(pending.id)) ok = sendToGroup(pending.id, caption, pendingImg);
  else ok = sendMessage(pending.id, caption, pendingImg);
  if (!ok) return alert("This browser’s storage is full, so the photo could not be sent.");
  $("photo-modal").hidden = true;
  pendingImg = "";
  render();
};
$("photo-caption").addEventListener("keydown", e => { if (e.key === "Enter") $("photo-send").click(); });

// ---------- Status ----------
const allStatus = () => store.get("chatbot_status", []).filter(s => Date.now() - s.t < DAY);

function addStatus(img, caption) {
  const arr = allStatus();
  arr.push({ id: genId(), from: me, img, caption, t: Date.now() });
  return store.set("chatbot_status", arr);
}

// Statuses I'm allowed to see: posted by someone who has my number
// in their contacts, and who hasn't hidden their status from me.
function visibleStatus() {
  const groups = {};
  allStatus().forEach(s => {
    if (s.from === me) return;
    if (!contactsOf(s.from).includes(me)) return;
    if (store.get("hidden_" + s.from, []).includes(me)) return;
    (groups[s.from] = groups[s.from] || []).push(s);
  });
  return Object.entries(groups)
    .map(([from, items]) => ({ from, items }))
    .sort((a, b) => b.items[b.items.length - 1].t - a.items[a.items.length - 1].t);
}

// ---------- Channels ----------
$("new-channel-btn").onclick = () => {
  $("ch-name").value = "";
  $("ch-desc").value = "";
  $("ch-msg").hidden = true;
  $("channel-modal").hidden = false;
  $("ch-name").focus();
};

$("ch-create").onclick = () => {
  const name = $("ch-name").value.trim();
  if (!name) return showMsg($("ch-msg"), "Give your channel a name.", false);
  const arr = channels();
  const c = { id: genId(), name, desc: $("ch-desc").value.trim(), owner: me, admins: [], followers: [me], posts: [], t: Date.now() };
  arr.push(c);
  store.set("chatbot_channels", arr);
  $("channel-modal").hidden = true;
  openChatWith("ch:" + c.id);
};

function follow(id) {
  const arr = channels();
  const c = arr.find(x => x.id === id);
  if (c && !c.followers.includes(me)) { c.followers.push(me); store.set("chatbot_channels", arr); }
  openChatWith("ch:" + id);
}

// Owner adds admins (admins can post in the channel)
function renderAdmins() {
  const c = channelOf(active);
  const ul = $("admin-list");
  ul.innerHTML = "";
  if (!c) return;
  [c.owner, ...c.admins].forEach(p => {
    const li = document.createElement("li");
    li.textContent = withNumber(p) + " · " + (p === c.owner ? "Owner" : "Admin");
    ul.appendChild(li);
  });
}

// Channel info pop-up. Everyone can read it; only the owner sees the edit boxes.
$("admin-btn").onclick = () => {
  if (isGroup(active)) return openGroupInfo();
  const c = isChannel(active) ? channelOf(active) : null;
  if (!c) return;
  const owner = c.owner === me;
  $("info-name").textContent = c.name;
  $("info-desc").textContent = c.desc || "No description";
  $("info-name-input").value = c.name;
  $("info-desc-input").value = c.desc;
  $("info-view").hidden = owner;
  $("info-edit").hidden = !owner;
  $("admin-add-box").hidden = !owner;
  $("info-note").hidden = owner;
  $("info-msg").hidden = true;
  $("admin-msg").hidden = true;
  $("admin-phone").value = "";
  renderAdmins();
  $("admin-modal").hidden = false;
};

// Only the owner can change the name (admins cannot)
$("info-save").onclick = () => {
  const out = $("info-msg");
  const arr = channels();
  const c = arr.find(x => "ch:" + x.id === active);
  if (!c || c.owner !== me) return showMsg(out, "Only the channel owner can change the name.", false);
  const name = $("info-name-input").value.trim();
  if (!name) return showMsg(out, "The channel needs a name.", false);
  c.name = name;
  c.desc = $("info-desc-input").value.trim();
  store.set("chatbot_channels", arr);
  showMsg(out, "Saved.", true);
  render();
};

$("admin-add").onclick = () => {
  const out = $("admin-msg");
  const phone = makePhone($("admin-code").value, $("admin-phone").value);
  const arr = channels();
  const c = arr.find(x => "ch:" + x.id === active);

  if (!c || c.owner !== me) return showMsg(out, "Only the channel owner can add admins.", false);
  if (!phone) return showMsg(out, "Enter a valid phone number.", false);
  if (phone === c.owner) return showMsg(out, "That’s you. You’re already the owner.", false);
  if (c.admins.includes(phone)) return showMsg(out, "That person is already an admin.", false);
  if (!users().some(u => u.phone === phone)) return showMsg(out, "No Gistly account with that number.", false);

  c.admins.push(phone);
  if (!c.followers.includes(phone)) c.followers.push(phone);
  store.set("chatbot_channels", arr);
  $("admin-phone").value = "";
  showMsg(out, publicName(phone) + " is now an admin.", true);
  renderAdmins();
  render();
};

// ---------- Polls (pin button: owner and admins create, everyone votes once) ----------
const MAX_ANSWERS = 20;
const pollRows = () => [...$("poll-options").querySelectorAll("input")];

function refreshPoll() {
  const rows = pollRows();
  rows.forEach((input, i) => {
    input.placeholder = "Answer " + (i + 1);
    input.parentNode.querySelector("button").hidden = rows.length <= 2; // keep at least 2 answers
  });
  const full = rows.length >= MAX_ANSWERS;
  $("poll-count").textContent = rows.length + "/" + MAX_ANSWERS;
  $("poll-add").disabled = full;
  $("poll-add").textContent = full ? "Limit reached (20 answers)" : "+ Add answer";
}

function addPollRow() {
  if (pollRows().length >= MAX_ANSWERS) return;
  const row = document.createElement("div");
  row.className = "poll-opt";
  const field = document.createElement("input");
  field.type = "text";
  field.maxLength = 60;
  field.autocomplete = "off";
  const remove = document.createElement("button");
  remove.className = "icon-btn";
  remove.setAttribute("aria-label", "Remove answer");
  remove.textContent = "✕";
  remove.onclick = () => { if (pollRows().length > 2) { row.remove(); refreshPoll(); } };
  row.append(field, remove);
  $("poll-options").appendChild(row);
  refreshPoll();
}

$("poll-btn").onclick = () => {
  if (!isChannel(active)) return;
  $("poll-question").value = "";
  $("poll-options").innerHTML = "";
  $("poll-msg").hidden = true;
  addPollRow();
  addPollRow();
  $("poll-modal").hidden = false;
  $("poll-question").focus();
};
$("poll-add").onclick = addPollRow;

$("poll-ok").onclick = () => {
  const out = $("poll-msg");
  const question = $("poll-question").value.trim();
  const answers = pollRows().map(i => i.value.trim()).filter(Boolean);

  if (!question) return showMsg(out, "Type your question.", false);
  if (answers.length < 2) return showMsg(out, "Add at least 2 answers.", false);
  if (answers.length > MAX_ANSWERS) return showMsg(out, "A poll can have 20 answers at most.", false);
  if (new Set(answers.map(a => a.toLowerCase())).size !== answers.length) return showMsg(out, "Each answer must be different.", false);

  const arr = channels();
  const c = arr.find(x => "ch:" + x.id === active);
  if (!c || !canPost(c)) return showMsg(out, "Only the owner and admins can create polls.", false);

  c.posts.push({
    id: genId(), from: me, text: "", img: "", t: Date.now(),
    poll: { question, options: answers.map(text => ({ text, votes: [] })) }
  });
  if (!store.set("chatbot_channels", arr)) return showMsg(out, "This browser’s storage is full.", false);
  $("poll-modal").hidden = true;
  render();
};

// One vote per person: after voting, the buttons lock
function votePoll(pid, index) {
  const arr = channels();
  const c = arr.find(x => "ch:" + x.id === active);
  if (!c || !c.followers.includes(me)) return;
  const post = c.posts.find(p => p.id === pid);
  if (!post || !post.poll) return;
  if (post.poll.options.some(o => o.votes.includes(me))) return;
  post.poll.options[index].votes.push(me);
  store.set("chatbot_channels", arr);
  render();
}

function buildPoll(m) {
  const box = document.createElement("div");
  box.className = "poll";
  const question = document.createElement("div");
  question.className = "poll-q";
  question.textContent = m.poll.question;
  box.appendChild(question);

  const total = m.poll.options.reduce((sum, o) => sum + o.votes.length, 0);
  const voted = m.poll.options.some(o => o.votes.includes(me));

  m.poll.options.forEach((o, i) => {
    const mine = o.votes.includes(me);
    const btn = document.createElement("button");
    btn.className = "poll-choice" + (mine ? " mine" : "");
    btn.disabled = voted;
    const bar = document.createElement("span");
    bar.className = "poll-bar";
    bar.style.width = (total ? Math.round(o.votes.length / total * 100) : 0) + "%";
    const text = document.createElement("span");
    text.className = "poll-text";
    text.textContent = (mine ? "✓ " : "") + o.text;
    const num = document.createElement("span");
    num.className = "poll-num";
    num.textContent = o.votes.length;
    btn.append(bar, text, num);
    btn.onclick = () => votePoll(m.pid, i);
    box.appendChild(btn);
  });

  const foot = document.createElement("div");
  foot.className = "poll-foot";
  foot.textContent = total + (total === 1 ? " vote" : " votes") + (voted ? " · You voted" : " · Tap one answer to vote");
  box.appendChild(foot);
  return box;
}

// ---------- Groups (people from your chats only, 20 max including you) ----------
function sendToGroup(id, text, img) {
  const arr = groups();
  const g = arr.find(x => "gr:" + x.id === id);
  if (!g || !g.members.includes(me)) return false;
  g.messages.push({ from: me, text, img: img || "", t: Date.now() });
  return store.set("chatbot_groups", arr);
}

// A list of tick-boxes. "room" = how many more people can still be picked.
function buildPicker(box, people, room, onChange) {
  box.innerHTML = "";
  if (!people.length) {
    box.innerHTML = '<div class="empty">No one to add. Add people to your chats first with the + button.</div>';
    onChange(0);
    return;
  }
  const update = () => {
    const boxes = [...box.querySelectorAll("input")];
    const n = boxes.filter(i => i.checked).length;
    boxes.forEach(i => { i.disabled = !i.checked && n >= room; }); // stop at the limit
    onChange(n);
  };
  people.forEach(p => {
    const label = document.createElement("label");
    label.className = "check";
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.value = p;
    tick.onchange = update;
    const text = document.createElement("span");
    text.textContent = withNumber(p);
    label.append(tick, text);
    box.appendChild(label);
  });
  update();
}

const countText = n => n + "/" + MAX_GROUP + (n >= MAX_GROUP ? " · limit reached" : "");

$("group-btn").onclick = () => {
  $("gc-name").value = "";
  $("gc-msg").hidden = true;
  buildPicker($("gc-list"), contactList(), MAX_GROUP - 1, n => { $("gc-count").textContent = countText(n + 1); });
  $("group-create").hidden = false;
  $("gc-name").focus();
};

$("gc-create").onclick = () => {
  const out = $("gc-msg");
  const name = $("gc-name").value.trim();
  const mine = contactList();
  const picked = [...document.querySelectorAll("#gc-list input:checked")].map(i => i.value).filter(p => mine.includes(p));

  if (!name) return showMsg(out, "Give the group a name.", false);
  if (!picked.length) return showMsg(out, "Pick at least one person from your chats.", false);
  if (picked.length + 1 > MAX_GROUP) return showMsg(out, "A group can have 20 people at most.", false);

  const arr = groups();
  const g = { id: genId(), name, owner: me, members: [me, ...picked], messages: [], t: Date.now() };
  arr.push(g);
  store.set("chatbot_groups", arr);
  $("group-create").hidden = true;
  openChatWith("gr:" + g.id);
};

function openGroupInfo() {
  const g = groupOf(active);
  if (!g) return;
  $("gi-title").textContent = g.name;
  $("gi-count").textContent = g.members.length + "/" + MAX_GROUP + " people";
  $("gi-msg").hidden = true;

  const ul = $("gi-members");
  ul.innerHTML = "";
  g.members.forEach(p => {
    const li = document.createElement("li");
    li.textContent = (p === me ? "You" : withNumber(p)) + (p === g.owner ? " · Creator" : "");
    ul.appendChild(li);
  });

  const creator = g.owner === me;
  $("gi-add-box").hidden = !creator;
  if (creator) {
    const people = contactList().filter(p => !g.members.includes(p));
    buildPicker($("gi-add-list"), people, MAX_GROUP - g.members.length, n => {
      $("gi-add-count").textContent = countText(g.members.length + n);
    });
  }
  $("group-modal").hidden = false;
}

$("gi-add-btn").onclick = () => {
  const out = $("gi-msg");
  const arr = groups();
  const g = arr.find(x => "gr:" + x.id === active);
  if (!g || g.owner !== me) return showMsg(out, "Only the group creator can add people.", false);
  const picked = [...document.querySelectorAll("#gi-add-list input:checked")].map(i => i.value)
    .filter(p => contactList().includes(p) && !g.members.includes(p));

  if (!picked.length) return showMsg(out, "Pick at least one person.", false);
  if (g.members.length + picked.length > MAX_GROUP) return showMsg(out, "A group can have 20 people at most.", false);

  g.members.push(...picked);
  store.set("chatbot_groups", arr);
  render();
  openGroupInfo();
  showMsg($("gi-msg"), picked.length + (picked.length === 1 ? " person added." : " people added."), true);
};

$("gi-leave").onclick = () => {
  if (!confirm("Leave this group?")) return;
  const arr = groups();
  const i = arr.findIndex(x => "gr:" + x.id === active);
  if (i < 0) return;
  const g = arr[i];
  g.members = g.members.filter(p => p !== me);
  if (!g.members.length) arr.splice(i, 1);
  else if (g.owner === me) g.owner = g.members[0]; // someone else becomes the creator
  store.set("chatbot_groups", arr);
  $("group-modal").hidden = true;
  active = "bot";
  $("app").classList.remove("show-chat");
  render();
};

// ---------- The Updates page ----------
function makeRow(avatarId, name, sub, onClick, extra) {
  const row = document.createElement("div");
  row.className = "u-row";
  row.tabIndex = 0;
  row.innerHTML = '<div></div><div class="grow"><div class="name"></div><div class="preview"></div></div>';
  setAvatar(row.firstChild, avatarId);
  row.querySelector(".name").textContent = name;
  row.querySelector(".preview").textContent = sub;
  if (extra) row.appendChild(extra);
  row.onclick = onClick;
  row.onkeydown = e => { if (e.key === "Enter") onClick(); };
  return row;
}

function renderUpdates() {
  // My status
  const mine = allStatus().filter(s => s.from === me);
  setAvatar($("my-status-avatar"), me);
  $("my-status-avatar").classList.toggle("ring", mine.length > 0);
  $("my-status-text").textContent = mine.length
    ? mine.length + (mine.length === 1 ? " update" : " updates") + " · " + timeText(mine[mine.length - 1].t)
    : "Tap the camera to add a status update";

  // Statuses from my contacts
  const box = $("status-list");
  box.innerHTML = "";
  const groups = visibleStatus();
  if (!groups.length) box.innerHTML = '<div class="empty">No recent updates from your contacts.</div>';
  groups.forEach(g => {
    const last = g.items[g.items.length - 1];
    const row = makeRow(g.from, publicName(g.from), timeText(last.t), () => openViewer(g.items, 0));
    row.firstChild.classList.add("ring");
    box.appendChild(row);
  });

  // Channels
  const all = channels();
  const lastT = c => (c.posts.length ? c.posts[c.posts.length - 1].t : c.t);
  const q = $("channel-search").value.trim().toLowerCase();
  const match = c => (c.name + " " + c.desc).toLowerCase().includes(q);
  const followed = all.filter(c => c.followers.includes(me) && match(c)).sort((a, b) => lastT(b) - lastT(a));
  const others = all.filter(c => !c.followers.includes(me) && match(c));

  const mineBox = $("my-channels");
  mineBox.innerHTML = followed.length || q ? "" : '<div class="empty">You don’t follow any channels yet. Press + to create one.</div>';
  followed.forEach(c => {
    const last = c.posts[c.posts.length - 1];
    const sub = last ? (last.poll ? "📊 " + last.poll.question : last.text || "📷 Photo") : (c.desc || "No posts yet");
    mineBox.appendChild(makeRow("ch:" + c.id, c.name, sub, () => openChatWith("ch:" + c.id)));
  });

  const findBox = $("find-channels");
  findBox.innerHTML = others.length ? "" :
    '<div class="empty">' + (q ? "No channels match your search." : "No other channels to find right now.") + '</div>';
  others.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "follow-btn";
    btn.textContent = "Follow";
    const n = c.followers.length;
    const sub = n + (n === 1 ? " follower" : " followers") + (c.desc ? " · " + c.desc : "");
    findBox.appendChild(makeRow("ch:" + c.id, c.name, sub, () => follow(c.id), btn));
  });
}

$("my-status-row").onclick = () => {
  const mine = allStatus().filter(s => s.from === me);
  if (mine.length) openViewer(mine, 0);
  else pickPhoto({ type: "status" });
};

// ---------- Settings: block people from seeing my status ----------
$("settings-btn").onclick = () => {
  const hidden = store.get("hidden_" + me, []);
  const box = $("hide-list");
  box.innerHTML = "";
  const people = contactList();
  if (!people.length) box.innerHTML = '<div class="empty">You have no contacts yet. Add people with the + button in Chats.</div>';
  people.forEach(p => {
    const label = document.createElement("label");
    label.className = "check";
    const box1 = document.createElement("input");
    box1.type = "checkbox";
    box1.value = p;
    box1.checked = hidden.includes(p);
    const text = document.createElement("span");
    text.textContent = withNumber(p);
    label.append(box1, text);
    box.appendChild(label);
  });
  $("settings-modal").hidden = false;
};

$("settings-save").onclick = () => {
  const blocked = [...document.querySelectorAll("#hide-list input:checked")].map(i => i.value);
  store.set("hidden_" + me, blocked);
  $("settings-modal").hidden = true;
  render();
};

// ---------- Full-screen viewer ----------
function openViewer(items, i) {
  viewer = { items, i };
  showSlide();
  $("viewer").hidden = false;
}

function showSlide() {
  const s = viewer.items[viewer.i];
  const who = s.from === me ? "You" : s.from === "bot" ? "Chatbot" : publicName(s.from);
  $("v-img").src = s.img;
  $("v-caption").textContent = s.caption || "";
  $("v-caption").hidden = !s.caption;
  $("v-name").textContent = who;
  $("v-time").textContent = timeText(s.t);
  $("v-avatar").className = "avatar";
  $("v-avatar").textContent = who.charAt(0).toUpperCase();
  $("v-count").textContent = viewer.items.length > 1 ? (viewer.i + 1) + " / " + viewer.items.length : "";
}

const closeViewer = () => { $("viewer").hidden = true; viewer = null; };
$("v-close").onclick = closeViewer;
$("v-next").onclick = () => {
  if (viewer.i < viewer.items.length - 1) { viewer.i++; showSlide(); }
  else closeViewer();
};
$("v-prev").onclick = () => { if (viewer.i > 0) { viewer.i--; showSlide(); } };

// ---------- Pop-ups, tabs and other buttons ----------
function closeAll() {
  document.querySelectorAll(".modal").forEach(m => { m.hidden = true; });
  if (!$("viewer").hidden) closeViewer();
}
document.querySelectorAll(".modal").forEach(m =>
  m.addEventListener("click", e => { if (e.target === m) m.hidden = true; })
);
document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => { b.closest(".modal").hidden = true; })
);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeAll();
  if (viewer && e.key === "ArrowRight") $("v-next").click();
  if (viewer && e.key === "ArrowLeft") $("v-prev").click();
});

function setSideTab(tab) {
  $("chats-pane").hidden = tab !== "chats";
  $("updates-pane").hidden = tab !== "updates";
  $("nav-chats").setAttribute("aria-selected", tab === "chats");
  $("nav-updates").setAttribute("aria-selected", tab === "updates");
}
$("nav-chats").onclick = () => setSideTab("chats");
$("nav-updates").onclick = () => setSideTab("updates");

// The + button in Chats: add a person by phone number
$("plus-btn").onclick = () => {
  const panel = $("new-chat");
  panel.hidden = !panel.hidden;
  $("new-msg").hidden = true;
  if (!panel.hidden) $("new-phone").focus();
};

$("new-btn").onclick = () => {
  const fail = text => showMsg($("new-msg"), text, false);
  const name = $("new-name").value.trim();
  const phone = makePhone($("new-code").value, $("new-phone").value);

  if (!phone) return fail("Enter a valid phone number.");
  if (phone === me) { $("new-phone").value = ""; $("new-chat").hidden = true; return openChatWith(me); }
  if (!name) return fail("Enter a name for this contact. It is what you will see for them.");
  if (!users().some(u => u.phone === phone)) return fail("No Gistly account with that number. Ask them to create a profile first.");

  const key = "contacts_" + me;
  const contacts = store.get(key, []);
  if (!contacts.includes(phone)) { contacts.push(phone); store.set(key, contacts); }

  const names = savedNames();
  names[phone] = name;
  store.set("names_" + me, names);

  $("new-name").value = "";
  $("new-phone").value = "";
  $("new-chat").hidden = true;
  openChatWith(phone);
};

// Pencil button in a chat: save or rename the person
$("contact-btn").onclick = () => {
  $("cm-phone").textContent = active;
  $("cm-name").value = savedNames()[active] || (nameOf(active) === active ? "" : nameOf(active));
  $("cm-msg").hidden = true;
  $("contact-modal").hidden = false;
  $("cm-name").focus();
};
$("cm-save").onclick = () => {
  const name = $("cm-name").value.trim();
  if (!name) return showMsg($("cm-msg"), "Enter a name for this contact.", false);
  const names = savedNames();
  names[active] = name;
  store.set("names_" + me, names);
  $("contact-modal").hidden = true;
  render();
};
$("cm-name").addEventListener("keydown", e => { if (e.key === "Enter") $("cm-save").click(); });
["new-name", "new-phone"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") $("new-btn").click(); }));

$("back-btn").onclick = () => { $("app").classList.remove("show-chat"); renderList(); };
$("search").addEventListener("input", renderList);
$("channel-search").addEventListener("input", renderUpdates);

// When another tab changes the shared data (message, read receipt, status), redraw
window.addEventListener("storage", () => { if (me) render(); });

// Pressing Enter in the login or sign-up form submits it
document.querySelectorAll("#auth input").forEach(el =>
  el.addEventListener("keydown", e => {
    if (e.key === "Enter") ($("login-form").hidden ? $("signup-btn") : $("login-btn")).click();
  })
);

// ---------- Stay logged in after a refresh ----------
const savedUser = users().find(u => u.phone === session.get());
if (savedUser) openApp(savedUser.phone, savedUser.name);