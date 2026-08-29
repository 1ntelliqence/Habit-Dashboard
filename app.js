
const STORAGE_KEY = "habit-new-tab-v1";
const LOCAL_CONFIG_KEY = "habit-dashboard-local-config-v4";
const DAYS_SHOWN = 10;

const DB_NAME = "habit-new-tab-assets";
const DB_VERSION = 1;
const IMAGE_STORE = "background-images";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "Habit Dashboard";
const DRIVE_DATA_FILE = "habit-dashboard-data.json";
const DRIVE_BACKUP_FOLDER = "Backups";
const AUTH_WORKER_URL = "https://habit-dashboard-auth.tfranklinvanrossum1.workers.dev";

const defaultState = {
  habits: [
    { id: crypto.randomUUID(), name: "At least 10 Minutes of Motion", color: "#22c55e", completions: {} },
    { id: crypto.randomUUID(), name: "Leave The House for 20 Mins", color: "#10b981", completions: {} },
    { id: crypto.randomUUID(), name: "Study Korean for 15 Mins", color: "#14b8a6", completions: {} }
  ],
  theme: "dark",
  offset: 0,
  appearance: {
    backgroundMode: "color",
    backgroundColor: "#0f1b2d",
    overlayOpacity: 28,
    slideshowSeconds: 30
  },
  dayNotes: {},
  lists: [],
  journal: {
    encrypted: false,
    entries: {}
  },
  meta: {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  }
};

const defaultLocalConfig = {
  workerAccessKey: "",
  driveFolderId: "",
  driveDataFileId: "",
  driveBackupFolderId: "",
  lastSyncedContentAt: "",
  hasEverSynced: false
};

let state = loadState();
let localConfig = loadLocalConfig();

let editingHabitId = null;
let editingNoteDate = null;
let journalDate = new Date();
let journalSaveTimer = null;

let journalKey = null;
let journalMemory = null;

let backgroundImages = [];
let slideshowIndex = 0;
let slideshowTimer = null;

let googleAccessToken = "";
let pendingConflict = null;

const $ = id => document.getElementById(id);

const tracker = $("tracker");
const todayLabel = $("todayLabel");
const themeToggle = $("themeToggle");
const habitDialog = $("habitDialog");
const habitForm = $("habitForm");
const habitName = $("habitName");
const habitColor = $("habitColor");
const dialogTitle = $("dialogTitle");

const settingsPanel = $("settingsPanel");
const backgroundLayer = $("backgroundLayer");
const backgroundOverlay = $("backgroundOverlay");
const backgroundColor = $("backgroundColor");
const backgroundImagesInput = $("backgroundImages");
const slideshowSeconds = $("slideshowSeconds");
const overlayOpacity = $("overlayOpacity");
const overlayValue = $("overlayValue");
const imageSummary = $("imageSummary");

const dayNoteDialog = $("dayNoteDialog");
const dayNoteText = $("dayNoteText");
const dayNoteDate = $("dayNoteDate");

const journalText = $("journalText");
const journalDateLabel = $("journalDateLabel");
const journalSavedState = $("journalSavedState");
const journalLocked = $("journalLocked");
const vaultBadge = $("vaultBadge");

const listsGrid = $("listsGrid");
const listDialog = $("listDialog");
const listForm = $("listForm");
const listName = $("listName");

const vaultDialog = $("vaultDialog");
const vaultDialogTitle = $("vaultDialogTitle");
const vaultDialogSubtitle = $("vaultDialogSubtitle");
const vaultPassword = $("vaultPassword");
const vaultPasswordConfirm = $("vaultPasswordConfirm");
const vaultConfirmWrap = $("vaultConfirmWrap");
const vaultSubmitBtn = $("vaultSubmitBtn");
const vaultWarning = $("vaultWarning");

const workerAccessKey = $("workerAccessKey");
const driveStatusText = $("driveStatusText");
const driveStatusBadge = $("driveStatusBadge");

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeJournal(saved) {
  if (saved?.journal?.encrypted) {
    return {
      encrypted: true,
      salt: saved.journal.salt,
      iv: saved.journal.iv,
      ciphertext: saved.journal.ciphertext,
      iterations: saved.journal.iterations || 250000
    };
  }

  // v3 migration: journalEntries lived at the root.
  if (saved?.journalEntries && typeof saved.journalEntries === "object") {
    return { encrypted: false, entries: saved.journalEntries };
  }

  if (saved?.journal && saved.journal.entries) {
    return { encrypted: false, entries: saved.journal.entries };
  }

  return { encrypted: false, entries: {} };
}

function mergeDefaults(saved) {
  const base = clone(defaultState);
  const merged = {
    ...base,
    ...(saved || {}),
    appearance: {
      ...base.appearance,
      ...(saved?.appearance || {})
    },
    dayNotes: saved?.dayNotes || {},
    lists: Array.isArray(saved?.lists) ? saved.lists : [],
    journal: normalizeJournal(saved),
    meta: {
      ...base.meta,
      ...(saved?.meta || {}),
      schemaVersion: 4
    }
  };
  delete merged.journalEntries;
  return merged;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? mergeDefaults(JSON.parse(raw)) : clone(defaultState);
  } catch {
    return clone(defaultState);
  }
}

function loadLocalConfig() {
  try {
    const raw = localStorage.getItem(LOCAL_CONFIG_KEY);
    return raw ? { ...defaultLocalConfig, ...JSON.parse(raw) } : { ...defaultLocalConfig };
  } catch {
    return { ...defaultLocalConfig };
  }
}

function saveLocalConfig() {
  localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(localConfig));
}

function saveState({ touch = true } = {}) {
  if (touch) state.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseISO(s) {
  const [y,m,d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function visibleDates() {
  const today = new Date();
  const end = addDays(today, state.offset);
  return Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(end, i - DAYS_SHOWN + 1));
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#",""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function colorWithAlpha(hex, alpha) {
  const {r,g,b} = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function streakEndingAt(habit, date) {
  let streak = 0;
  let d = new Date(date);
  while (habit.completions[isoDate(d)]) {
    streak++;
    d = addDays(d, -1);
  }
  return streak;
}

function currentStreak(habit) {
  const today = new Date();
  if (habit.completions[isoDate(today)]) return streakEndingAt(habit, today);
  const yesterday = addDays(today, -1);
  return habit.completions[isoDate(yesterday)] ? streakEndingAt(habit, yesterday) : 0;
}

function longestStreak(habit) {
  const keys = Object.keys(habit.completions).filter(k => habit.completions[k]).sort();
  if (!keys.length) return 0;
  let best = 1, current = 1;
  for (let i = 1; i < keys.length; i++) {
    const diff = Math.round((parseISO(keys[i]) - parseISO(keys[i - 1])) / 86400000);
    current = diff === 1 ? current + 1 : 1;
    best = Math.max(best, current);
  }
  return best;
}

function totalCount(habit) {
  return Object.values(habit.completions).filter(Boolean).length;
}

function intensityFor(habit, date) {
  if (!habit.completions[isoDate(date)]) return 0;
  const streak = streakEndingAt(habit, date);
  return Math.min(0.22 + (streak - 1) * 0.075, 0.9);
}

function statCell(label, value, header = false) {
  const el = document.createElement("div");
  el.className = `cell ${header ? "stats-head" : "stats-cell"}`;
  el.innerHTML = header ? label : `<strong>${value}</strong>`;
  return el;
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  themeToggle.textContent = state.theme === "dark" ? "☀" : "☾";
  todayLabel.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long", month: "long", day: "numeric"
  }).format(new Date());

  renderTracker();
  renderJournal();
  renderLists();
  renderVaultControls();
  renderDriveControls();
}

function renderTracker() {
  const dates = visibleDates();
  tracker.style.gridTemplateColumns = `250px repeat(${DAYS_SHOWN}, minmax(66px, 1fr)) repeat(3, 86px)`;
  tracker.innerHTML = "";

  if (!state.habits.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.gridColumn = "1 / -1";
    empty.textContent = "No habits yet. Add one to start tracking.";
    tracker.appendChild(empty);
    return;
  }

  const firstHead = document.createElement("div");
  firstHead.className = "cell habit-head";
  firstHead.innerHTML = `<span class="habit-title">Habits</span>`;
  tracker.appendChild(firstHead);

  const todayISO = isoDate(new Date());

  dates.forEach(date => {
    const key = isoDate(date);
    const el = document.createElement("div");
    el.className = "cell date-head" + (key === todayISO ? " today" : "");
    const hasNote = !!(state.dayNotes[key] && state.dayNotes[key].trim());
    el.innerHTML = `
      <span>${date.toLocaleDateString(undefined, {month:"short"})}</span>
      <strong>${date.getDate()}</strong>
      <span>${date.toLocaleDateString(undefined, {weekday:"short"})}</span>
      <button class="note-toggle ${hasNote ? "has-note" : ""}" data-note-date="${key}" title="${hasNote ? "Edit note" : "Add note"}">${hasNote ? "●" : "＋"}</button>
    `;
    tracker.appendChild(el);
  });

  tracker.appendChild(statCell("Current<br>streak", null, true));
  tracker.appendChild(statCell("Longest<br>streak", null, true));
  tracker.appendChild(statCell("Total<br>count", null, true));

  state.habits.forEach(habit => {
    const head = document.createElement("div");
    head.className = "cell habit-head";
    head.innerHTML = `
      <span class="habit-title">${escapeHTML(habit.name)}</span>
      <span class="row-actions">
        <button data-edit="${habit.id}" title="Edit">✎</button>
        <button data-delete="${habit.id}" title="Delete">×</button>
      </span>
    `;
    tracker.appendChild(head);

    dates.forEach(date => {
      const key = isoDate(date);
      const done = !!habit.completions[key];
      const cell = document.createElement("div");
      cell.className = `cell complete-cell${done ? " done" : ""}`;
      cell.dataset.habit = habit.id;
      cell.dataset.date = key;

      if (done) cell.style.background = colorWithAlpha(habit.color, intensityFor(habit, date));
      cell.innerHTML = `<span class="check">${done ? "✓" : ""}</span>`;
      tracker.appendChild(cell);
    });

    tracker.appendChild(statCell("", currentStreak(habit)));
    tracker.appendChild(statCell("", longestStreak(habit)));
    tracker.appendChild(statCell("", totalCount(habit)));
  });
}

// ---------------- Journal encryption ----------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveJournalKey(password, saltBytes, iterations = 250000) {
  const rawKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJournalMemory({ newSalt = false, password = "" } = {}) {
  if (!state.journal.encrypted && !password) return;

  let saltBytes;
  const iterations = state.journal.iterations || 250000;

  if (newSalt || !state.journal.salt) {
    saltBytes = crypto.getRandomValues(new Uint8Array(16));
    journalKey = await deriveJournalKey(password, saltBytes, iterations);
  } else {
    saltBytes = base64ToBytes(state.journal.salt);
    if (!journalKey && password) journalKey = await deriveJournalKey(password, saltBytes, iterations);
  }

  if (!journalKey) throw new Error("Journal is locked.");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(journalMemory || {}));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, journalKey, plaintext);

  state.journal = {
    encrypted: true,
    salt: bytesToBase64(saltBytes),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iterations
  };
}

async function decryptJournal(password) {
  if (!state.journal.encrypted) {
    journalMemory = state.journal.entries || {};
    return true;
  }

  try {
    const salt = base64ToBytes(state.journal.salt);
    const iv = base64ToBytes(state.journal.iv);
    const ciphertext = base64ToBytes(state.journal.ciphertext);
    const key = await deriveJournalKey(password, salt, state.journal.iterations || 250000);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    journalKey = key;
    journalMemory = parsed && typeof parsed === "object" ? parsed : {};
    return true;
  } catch {
    return false;
  }
}

async function enableVault(password) {
  if (state.journal.encrypted) return;
  journalMemory = state.journal.entries || {};
  state.journal = { encrypted: true, iterations: 250000 };
  await encryptJournalMemory({ newSalt: true, password });
  saveState();
  renderJournal();
  renderVaultControls();
}

function lockJournal() {
  if (!state.journal.encrypted) return;
  journalKey = null;
  journalMemory = null;
  renderJournal();
  renderVaultControls();
}

async function removeVault() {
  if (!state.journal.encrypted || !journalMemory || !journalKey) return;
  const entries = clone(journalMemory);
  state.journal = { encrypted: false, entries };
  journalKey = null;
  journalMemory = entries;
  saveState();
  renderJournal();
  renderVaultControls();
}

function initJournalMemory() {
  if (state.journal.encrypted) {
    journalMemory = null;
    journalKey = null;
  } else {
    journalMemory = state.journal.entries || {};
  }
}

function renderJournal() {
  const key = isoDate(journalDate);
  journalDateLabel.textContent = journalDate.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });

  if (state.journal.encrypted && !journalKey) {
    journalLocked.classList.remove("hidden");
    journalText.classList.add("hidden");
    journalSavedState.textContent = "Locked";
    vaultBadge.textContent = "Encrypted";
    vaultBadge.classList.add("good");
    return;
  }

  journalLocked.classList.add("hidden");
  journalText.classList.remove("hidden");

  if (!journalMemory) journalMemory = state.journal.entries || {};
  journalText.value = journalMemory[key] || "";
  journalSavedState.textContent = "Saved";

  vaultBadge.textContent = state.journal.encrypted ? "Encrypted · Unlocked" : "Local";
  vaultBadge.classList.toggle("good", state.journal.encrypted);
}

async function saveJournalCurrent() {
  if (state.journal.encrypted && !journalKey) return;
  if (!journalMemory) journalMemory = {};

  const key = isoDate(journalDate);
  const value = journalText.value;

  if (value.trim()) journalMemory[key] = value;
  else delete journalMemory[key];

  if (state.journal.encrypted) {
    await encryptJournalMemory();
  } else {
    state.journal.entries = journalMemory;
  }

  saveState();
  journalSavedState.textContent = "Saved";
}

function renderVaultControls() {
  const enabled = state.journal.encrypted;
  const unlocked = enabled && !!journalKey;

  $("vaultStatusBadge").textContent = !enabled ? "Off" : (unlocked ? "Unlocked" : "Locked");
  $("vaultStatusBadge").classList.toggle("good", enabled);

  $("enableVaultBtn").classList.toggle("hidden", enabled);
  $("lockVaultBtn").classList.toggle("hidden", !unlocked);
  $("removeVaultBtn").classList.toggle("hidden", !unlocked);
}

// ---------------- Lists ----------------

function renderLists() {
  listsGrid.innerHTML = "";

  if (!state.lists.length) {
    const empty = document.createElement("div");
    empty.className = "surface empty-list";
    empty.textContent = "No lists yet. Create one for errands, work, groceries, packing, or anything else.";
    listsGrid.appendChild(empty);
    return;
  }

  state.lists.forEach(list => {
    const card = document.createElement("article");
    card.className = "list-card";
    card.dataset.listId = list.id;

    const itemsHTML = list.items.map(item => `
      <div class="list-item ${item.done ? "done" : ""}" data-item-id="${item.id}">
        <input type="checkbox" data-action="toggle-item" ${item.done ? "checked" : ""}>
        <input class="item-text" data-action="edit-item" value="${escapeHTML(item.text)}" aria-label="Checklist item">
        <button class="icon-ghost" data-action="delete-item" title="Delete item">×</button>
      </div>
    `).join("");

    card.innerHTML = `
      <div class="list-card-head">
        <div class="list-title" contenteditable="true" spellcheck="false">${escapeHTML(list.name)}</div>
        <button class="icon-ghost" data-action="delete-list" title="Delete list">×</button>
      </div>
      <div class="list-items">${itemsHTML}</div>
      <div class="add-item-row">
        <input data-action="new-item-input" placeholder="Add reminder...">
        <button class="secondary" data-action="add-item">Add</button>
      </div>
    `;
    listsGrid.appendChild(card);
  });
}

// ---------------- Day notes ----------------

function openDayNote(dateKey) {
  editingNoteDate = dateKey;
  const date = parseISO(dateKey);
  dayNoteDate.textContent = date.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
  dayNoteText.value = state.dayNotes[dateKey] || "";
  dayNoteDialog.showModal();
  setTimeout(() => dayNoteText.focus(), 0);
}

// ---------------- Background images ----------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IMAGE_STORE)) {
        req.result.createObjectStore(IMAGE_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getImages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readonly");
    const req = tx.objectStore(IMAGE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function addImage(file) {
  const db = await openDB();
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    tx.objectStore(IMAGE_STORE).add({
      name: file.name,
      type: file.type || "image/jpeg",
      data: buffer
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearImages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    tx.objectStore(IMAGE_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function revokeImageURLs() {
  backgroundImages.forEach(img => {
    if (img.url) URL.revokeObjectURL(img.url);
  });
}

async function refreshImages() {
  revokeImageURLs();
  const items = await getImages();
  backgroundImages = items.map(item => ({
    ...item,
    url: URL.createObjectURL(new Blob([item.data], { type: item.type }))
  }));
  imageSummary.textContent = backgroundImages.length
    ? `${backgroundImages.length} image${backgroundImages.length === 1 ? "" : "s"} saved on this device.`
    : "No images uploaded on this device.";
  slideshowIndex = 0;
  applyBackground();
}

function applyBackground() {
  const a = state.appearance;
  backgroundColor.value = a.backgroundColor;
  slideshowSeconds.value = String(a.slideshowSeconds);
  overlayOpacity.value = String(a.overlayOpacity);
  overlayValue.textContent = `${a.overlayOpacity}%`;

  document.querySelectorAll("#backgroundModeControl button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === a.backgroundMode);
  });

  clearInterval(slideshowTimer);
  slideshowTimer = null;

  backgroundLayer.style.backgroundColor = a.backgroundColor;
  backgroundLayer.style.backgroundImage = "none";
  backgroundOverlay.style.background = "rgba(0,0,0,0)";

  if (a.backgroundMode === "color") return;

  if (!backgroundImages.length) {
    imageSummary.textContent = "Upload at least one image on this device to use this mode.";
    return;
  }

  backgroundOverlay.style.background = `rgba(0,0,0,${a.overlayOpacity / 100})`;

  if (a.backgroundMode === "image") {
    backgroundLayer.style.backgroundImage = `url("${backgroundImages[0].url}")`;
    return;
  }

  function showSlide() {
    if (!backgroundImages.length) return;
    backgroundLayer.style.backgroundImage = `url("${backgroundImages[slideshowIndex % backgroundImages.length].url}")`;
    slideshowIndex = (slideshowIndex + 1) % backgroundImages.length;
  }

  showSlide();
  slideshowTimer = setInterval(showSlide, Number(a.slideshowSeconds) * 1000);
}

// ---------------- Google Drive ----------------

function renderDriveControls() {
  workerAccessKey.value = localConfig.workerAccessKey || "";

  if (!localConfig.workerAccessKey) {
    driveStatusBadge.textContent = "Device not paired";
    driveStatusBadge.classList.remove("good");
    driveStatusText.textContent = "Paste your APP_ACCESS_KEY once on this device, then tap Pair This Device.";
  } else if (googleAccessToken) {
    driveStatusBadge.textContent = "Ready";
    driveStatusBadge.classList.add("good");
  } else {
    driveStatusBadge.textContent = localConfig.hasEverSynced ? "Paired" : "Paired · checking Drive";
    driveStatusBadge.classList.add("good");

    if (localConfig.lastSyncedContentAt) {
      const d = new Date(localConfig.lastSyncedContentAt);
      driveStatusText.textContent = `Last synced copy: ${d.toLocaleString()}`;
    } else {
      driveStatusText.textContent = "Device paired. Sync will renew Google Drive access automatically.";
    }
  }

  $("driveQuickBtn").textContent = localConfig.workerAccessKey ? "Drive ✓" : "Drive";
}

function setDriveStatus(message) {
  driveStatusText.textContent = message;
}

function workerHeaders() {
  if (!localConfig.workerAccessKey) {
    throw new Error("Pair this device first by saving your APP_ACCESS_KEY.");
  }
  return {
    "Content-Type": "application/json",
    "X-App-Key": localConfig.workerAccessKey
  };
}

async function workerRequest(path, options = {}) {
  const headers = {
    ...workerHeaders(),
    ...(options.headers || {})
  };

  const res = await fetch(`${AUTH_WORKER_URL}${path}`, {
    ...options,
    headers
  });

  let data = null;
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    if (res.status === 401 && data?.error === "unauthorized") {
      throw new Error("That device access key is not correct.");
    }
    throw new Error(data?.message || data?.error || `Auth helper error (${res.status}).`);
  }

  return data;
}

async function checkWorkerStatus() {
  return workerRequest("/status", { method: "GET" });
}

async function getWorkerAccessToken() {
  const data = await workerRequest("/token", {
    method: "POST",
    body: "{}"
  });

  if (!data?.access_token) {
    throw new Error("The auth helper did not return a Google access token.");
  }

  googleAccessToken = data.access_token;
  renderDriveControls();
  return googleAccessToken;
}

async function ensureDriveToken() {
  if (googleAccessToken) return googleAccessToken;
  return getWorkerAccessToken();
}

async function authorizeGoogleDrive() {
  try {
    setDriveStatus("Starting Google authorization...");
    const status = await checkWorkerStatus();

    if (status.connected) {
      setDriveStatus("Google Drive is already authorized. Syncing...");
      await getWorkerAccessToken();
      await smartSync();
      return;
    }

    const data = await workerRequest("/oauth/start", {
      method: "POST",
      body: "{}"
    });

    if (!data?.authUrl) throw new Error("Could not start Google authorization.");

    // Stay in the SAME app window. This is important on iPhone installed PWAs:
    // Safari and the standalone PWA can use different storage contexts.
    setDriveStatus("Opening Google...");
    window.location.assign(data.authUrl);
  } catch (error) {
    setDriveStatus(error?.message || "Could not start Google authorization.");
    alert(error?.message || "Could not start Google authorization.");
    throw error;
  }
}

async function pairThisDevice() {
  const key = workerAccessKey.value.trim();
  if (!key) throw new Error("Paste your APP_ACCESS_KEY first.");

  localConfig.workerAccessKey = key;
  googleAccessToken = "";
  saveLocalConfig();

  try {
    const status = await checkWorkerStatus();
    renderDriveControls();

    if (status.connected) {
      setDriveStatus("Device paired. Google Drive is already authorized — syncing now...");
      await getWorkerAccessToken();
      await smartSync();
    } else {
      setDriveStatus("Device paired. Tap Authorize Google Drive once to finish the initial setup.");
    }
  } catch (error) {
    localConfig.workerAccessKey = "";
    saveLocalConfig();
    renderDriveControls();
    throw error;
  }
}

function handleDriveError(error) {
  console.error(error);
  setDriveStatus(error?.message || "Drive sync failed.");
}

async function driveFetch(url, options = {}, retry = true) {
  await ensureDriveToken();

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${googleAccessToken}`);

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 && retry) {
    googleAccessToken = "";
    await getWorkerAccessToken();
    return driveFetch(url, options, false);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive error (${res.status}): ${text.slice(0, 250)}`);
  }

  return res;
}

function escapeDriveQuery(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listDriveFiles(q, fields = "files(id,name,mimeType,modifiedTime,parents)") {
  const params = new URLSearchParams({
    q,
    spaces: "drive",
    fields,
    pageSize: "100"
  });
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  return res.json();
}

async function createDriveMetadataFile(metadata) {
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name,modifiedTime,parents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata)
  });
  return res.json();
}

async function findOrCreateFolder(name, parentId = "") {
  const clauses = [
    `name='${escapeDriveQuery(name)}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    "trashed=false"
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);

  const result = await listDriveFiles(clauses.join(" and "));
  if (result.files?.length) return result.files[0].id;

  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) metadata.parents = [parentId];

  const created = await createDriveMetadataFile(metadata);
  return created.id;
}

async function ensureDriveStructure() {
  if (!localConfig.driveFolderId) {
    localConfig.driveFolderId = await findOrCreateFolder(DRIVE_FOLDER_NAME);
    saveLocalConfig();
  }

  if (!localConfig.driveBackupFolderId) {
    localConfig.driveBackupFolderId = await findOrCreateFolder(DRIVE_BACKUP_FOLDER, localConfig.driveFolderId);
    saveLocalConfig();
  }

  if (!localConfig.driveDataFileId) {
    const q = [
      `name='${escapeDriveQuery(DRIVE_DATA_FILE)}'`,
      `'${localConfig.driveFolderId}' in parents`,
      "trashed=false"
    ].join(" and ");
    const result = await listDriveFiles(q);
    if (result.files?.length) {
      localConfig.driveDataFileId = result.files[0].id;
      saveLocalConfig();
    }
  }
}

function serializableState() {
  const copy = clone(state);
  copy.meta.schemaVersion = 4;
  return copy;
}

async function createJsonFile(name, parentId, data) {
  const boundary = `habit_${crypto.randomUUID()}`;
  const metadata = {
    name,
    mimeType: "application/json",
    parents: [parentId]
  };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;

  const res = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    }
  );
  return res.json();
}

async function updateJsonFile(fileId, data) {
  const res = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );
  return res.json();
}

async function fetchRemoteState() {
  await ensureDriveStructure();
  if (!localConfig.driveDataFileId) return null;

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(localConfig.driveDataFileId)}?alt=media`
  );
  return res.json();
}

async function createRemoteBackup(remoteState) {
  if (!remoteState) return;
  await ensureDriveStructure();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await createJsonFile(`backup-${stamp}.json`, localConfig.driveBackupFolderId, remoteState);
  await pruneRemoteBackups();
}

async function pruneRemoteBackups() {
  const q = [
    `'${localConfig.driveBackupFolderId}' in parents`,
    "trashed=false"
  ].join(" and ");

  const result = await listDriveFiles(q, "files(id,name,createdTime),nextPageToken");
  const files = (result.files || []).sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));

  for (const file of files.slice(20)) {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: "DELETE"
    });
  }
}

async function uploadLocalToDrive({ backupRemote = true } = {}) {
  await saveJournalCurrent();

  setDriveStatus("Backing up to Google Drive...");
  await ensureDriveStructure();

  let remote = null;
  if (localConfig.driveDataFileId && backupRemote) {
    try { remote = await fetchRemoteState(); } catch {}
  }
  if (remote) await createRemoteBackup(remote);

  const payload = serializableState();

  if (!localConfig.driveDataFileId) {
    const created = await createJsonFile(DRIVE_DATA_FILE, localConfig.driveFolderId, payload);
    localConfig.driveDataFileId = created.id;
  } else {
    await updateJsonFile(localConfig.driveDataFileId, payload);
  }

  localConfig.lastSyncedContentAt = state.meta.updatedAt;
  localConfig.hasEverSynced = true;
  saveLocalConfig();
  setDriveStatus(`Backed up ${new Date().toLocaleString()}`);
  renderDriveControls();
}

async function applyRemoteState(remote) {
  if (!remote || !remote.habits) throw new Error("Drive copy does not look like a Habit Dashboard backup.");

  state = mergeDefaults(remote);
  saveState({ touch: false });

  localConfig.lastSyncedContentAt = state.meta.updatedAt || new Date().toISOString();
  localConfig.hasEverSynced = true;
  saveLocalConfig();

  initJournalMemory();
  journalDate = new Date();
  render();
  applyBackground();
}

async function restoreFromDrive() {
  setDriveStatus("Checking Google Drive...");
  const remote = await fetchRemoteState();
  if (!remote) throw new Error("No Habit Dashboard backup exists in Drive yet.");

  const okay = confirm("Replace this device's dashboard data with the Google Drive copy? Your current device data will be downloaded as a JSON backup first.");
  if (!okay) return;

  downloadJsonBackup("before-drive-restore");
  await applyRemoteState(remote);
  setDriveStatus(`Restored from Drive ${new Date().toLocaleString()}`);
}

function timestampMs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : 0;
}

async function smartSync() {
  await saveJournalCurrent();
  setDriveStatus("Syncing...");

  await ensureDriveStructure();
  const remote = await fetchRemoteState();

  if (!remote) {
    await uploadLocalToDrive({ backupRemote: false });
    return;
  }

  const localUpdated = timestampMs(state.meta.updatedAt);
  const remoteUpdated = timestampMs(remote.meta?.updatedAt);
  const baseUpdated = timestampMs(localConfig.lastSyncedContentAt);

  if (!localConfig.hasEverSynced) {
    // Never guess on a first sync when Drive already contains data.
    pendingConflict = remote;
    $("conflictDialog").showModal();
    setDriveStatus("Drive already has a dashboard. Choose which copy to keep.");
    return;
  }

  const localChanged = localUpdated > baseUpdated;
  const remoteChanged = remoteUpdated > baseUpdated;

  if (localChanged && remoteChanged && localUpdated !== remoteUpdated) {
    pendingConflict = remote;
    $("conflictDialog").showModal();
    setDriveStatus("Sync needs your choice.");
    return;
  }

  if (remoteUpdated > localUpdated) {
    await applyRemoteState(remote);
    setDriveStatus(`Updated from Drive ${new Date().toLocaleString()}`);
  } else if (localUpdated > remoteUpdated) {
    await uploadLocalToDrive({ backupRemote: true });
  } else {
    localConfig.lastSyncedContentAt = state.meta.updatedAt;
    localConfig.hasEverSynced = true;
    saveLocalConfig();
    setDriveStatus(`Already up to date · ${new Date().toLocaleTimeString()}`);
    renderDriveControls();
  }
}

// ---------------- Export / import ----------------

function downloadJsonBackup(label = "backup") {
  const blob = new Blob([JSON.stringify(serializableState(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `habit-dashboard-${label}-${isoDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- Event listeners ----------------

tracker.addEventListener("click", e => {
  const noteBtn = e.target.closest("[data-note-date]");
  if (noteBtn) {
    e.stopPropagation();
    openDayNote(noteBtn.dataset.noteDate);
    return;
  }

  const cell = e.target.closest(".complete-cell");
  if (cell) {
    const habit = state.habits.find(h => h.id === cell.dataset.habit);
    const date = cell.dataset.date;
    habit.completions[date] = !habit.completions[date];
    if (!habit.completions[date]) delete habit.completions[date];
    saveState();
    renderTracker();
    return;
  }

  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) {
    const habit = state.habits.find(h => h.id === editBtn.dataset.edit);
    editingHabitId = habit.id;
    habitName.value = habit.name;
    habitColor.value = habit.color;
    dialogTitle.textContent = "Edit Habit";
    habitDialog.showModal();
    return;
  }

  const deleteBtn = e.target.closest("[data-delete]");
  if (deleteBtn) {
    const habit = state.habits.find(h => h.id === deleteBtn.dataset.delete);
    if (confirm(`Delete "${habit.name}"? This also deletes its history.`)) {
      state.habits = state.habits.filter(h => h.id !== habit.id);
      saveState();
      renderTracker();
    }
  }
});

$("addHabitBtn").addEventListener("click", () => {
  editingHabitId = null;
  habitName.value = "";
  habitColor.value = "#22c55e";
  dialogTitle.textContent = "New Habit";
  habitDialog.showModal();
  setTimeout(() => habitName.focus(), 0);
});

$("cancelHabitBtn").addEventListener("click", () => habitDialog.close());

habitForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = habitName.value.trim();
  if (!name) return;

  if (editingHabitId) {
    const habit = state.habits.find(h => h.id === editingHabitId);
    habit.name = name;
    habit.color = habitColor.value;
  } else {
    state.habits.push({ id: crypto.randomUUID(), name, color: habitColor.value, completions: {} });
  }

  saveState();
  habitDialog.close();
  renderTracker();
});

$("closeDayNoteBtn").addEventListener("click", () => dayNoteDialog.close());

$("dayNoteForm").addEventListener("submit", e => {
  e.preventDefault();
  const value = dayNoteText.value.trim();
  if (value) state.dayNotes[editingNoteDate] = value;
  else delete state.dayNotes[editingNoteDate];
  saveState();
  dayNoteDialog.close();
  renderTracker();
});

$("deleteDayNoteBtn").addEventListener("click", () => {
  if (editingNoteDate) delete state.dayNotes[editingNoteDate];
  saveState();
  dayNoteText.value = "";
  dayNoteDialog.close();
  renderTracker();
});

$("prevBtn").addEventListener("click", () => {
  state.offset -= DAYS_SHOWN;
  saveState();
  renderTracker();
});

$("nextBtn").addEventListener("click", () => {
  state.offset += DAYS_SHOWN;
  saveState();
  renderTracker();
});

$("todayBtn").addEventListener("click", () => {
  state.offset = 0;
  saveState();
  renderTracker();
});

// Journal
journalText.addEventListener("input", () => {
  journalSavedState.textContent = "Saving...";
  clearTimeout(journalSaveTimer);
  journalSaveTimer = setTimeout(() => saveJournalCurrent().catch(console.error), 500);
});

journalText.addEventListener("blur", () => saveJournalCurrent().catch(console.error));

$("journalPrev").addEventListener("click", async () => {
  await saveJournalCurrent();
  journalDate = addDays(journalDate, -1);
  renderJournal();
});

$("journalNext").addEventListener("click", async () => {
  await saveJournalCurrent();
  journalDate = addDays(journalDate, 1);
  renderJournal();
});

$("journalToday").addEventListener("click", async () => {
  await saveJournalCurrent();
  journalDate = new Date();
  renderJournal();
});

// Vault
let vaultMode = "enable";

function openVaultDialog(mode) {
  vaultMode = mode;
  vaultPassword.value = "";
  vaultPasswordConfirm.value = "";
  vaultWarning.textContent = "";

  if (mode === "enable") {
    vaultDialogTitle.textContent = "Secure Journal";
    vaultDialogSubtitle.textContent = "Encrypt every journal entry with a password.";
    vaultConfirmWrap.classList.remove("hidden");
    vaultPasswordConfirm.required = true;
    vaultSubmitBtn.textContent = "Enable encryption";
  } else {
    vaultDialogTitle.textContent = "Unlock Journal";
    vaultDialogSubtitle.textContent = "Your password is used only on this device to decrypt the journal.";
    vaultConfirmWrap.classList.add("hidden");
    vaultPasswordConfirm.required = false;
    vaultSubmitBtn.textContent = "Unlock";
  }

  vaultDialog.showModal();
  setTimeout(() => vaultPassword.focus(), 0);
}

$("enableVaultBtn").addEventListener("click", () => openVaultDialog("enable"));
$("unlockJournalBtn").addEventListener("click", () => openVaultDialog("unlock"));
$("closeVaultBtn").addEventListener("click", () => vaultDialog.close());

$("lockVaultBtn").addEventListener("click", async () => {
  await saveJournalCurrent();
  lockJournal();
});

$("removeVaultBtn").addEventListener("click", async () => {
  if (!confirm("Remove journal encryption on this device and future Drive backups?")) return;
  await removeVault();
});

$("vaultForm").addEventListener("submit", async e => {
  e.preventDefault();
  const password = vaultPassword.value;

  if (vaultMode === "enable") {
    if (password.length < 8) {
      vaultWarning.textContent = "Use at least 8 characters.";
      return;
    }
    if (password !== vaultPasswordConfirm.value) {
      vaultWarning.textContent = "The passwords do not match.";
      return;
    }
    vaultSubmitBtn.disabled = true;
    vaultSubmitBtn.textContent = "Encrypting...";
    try {
      await enableVault(password);
      vaultDialog.close();
    } catch (err) {
      vaultWarning.textContent = err.message || "Could not enable encryption.";
    } finally {
      vaultSubmitBtn.disabled = false;
      vaultSubmitBtn.textContent = "Enable encryption";
    }
  } else {
    vaultSubmitBtn.disabled = true;
    vaultSubmitBtn.textContent = "Unlocking...";
    const ok = await decryptJournal(password);
    vaultSubmitBtn.disabled = false;
    vaultSubmitBtn.textContent = "Unlock";
    if (!ok) {
      vaultWarning.textContent = "That password did not unlock the journal.";
      return;
    }
    vaultDialog.close();
    renderJournal();
    renderVaultControls();
  }
});

// Lists
$("newListBtn").addEventListener("click", () => {
  listName.value = "";
  listDialog.showModal();
  setTimeout(() => listName.focus(), 0);
});

$("cancelListBtn").addEventListener("click", () => listDialog.close());

listForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = listName.value.trim();
  if (!name) return;
  state.lists.push({ id: crypto.randomUUID(), name, items: [] });
  saveState();
  listDialog.close();
  renderLists();
});

listsGrid.addEventListener("click", e => {
  const card = e.target.closest(".list-card");
  if (!card) return;

  const list = state.lists.find(l => l.id === card.dataset.listId);
  if (!list) return;

  const action = e.target.dataset.action;

  if (action === "delete-list") {
    if (confirm(`Delete "${list.name}"?`)) {
      state.lists = state.lists.filter(l => l.id !== list.id);
      saveState();
      renderLists();
    }
    return;
  }

  if (action === "add-item") {
    const input = card.querySelector('[data-action="new-item-input"]');
    const text = input.value.trim();
    if (!text) return;
    list.items.push({ id: crypto.randomUUID(), text, done: false });
    saveState();
    renderLists();
    return;
  }

  if (action === "delete-item") {
    const row = e.target.closest(".list-item");
    list.items = list.items.filter(item => item.id !== row.dataset.itemId);
    saveState();
    renderLists();
  }
});

listsGrid.addEventListener("change", e => {
  const card = e.target.closest(".list-card");
  const row = e.target.closest(".list-item");
  if (!card || !row) return;

  const list = state.lists.find(l => l.id === card.dataset.listId);
  const item = list?.items.find(i => i.id === row.dataset.itemId);
  if (!item) return;

  if (e.target.dataset.action === "toggle-item") {
    item.done = e.target.checked;
    saveState();
    renderLists();
  }
});

listsGrid.addEventListener("input", e => {
  const card = e.target.closest(".list-card");
  if (!card) return;
  const list = state.lists.find(l => l.id === card.dataset.listId);
  if (!list) return;

  if (e.target.classList.contains("item-text")) {
    const row = e.target.closest(".list-item");
    const item = list.items.find(i => i.id === row.dataset.itemId);
    if (item) {
      item.text = e.target.value;
      saveState();
    }
  }

  if (e.target.classList.contains("list-title")) {
    list.name = e.target.textContent.trim() || "Untitled List";
    saveState();
  }
});

listsGrid.addEventListener("keydown", e => {
  if (e.target.dataset.action === "new-item-input" && e.key === "Enter") {
    e.preventDefault();
    e.target.closest(".list-card").querySelector('[data-action="add-item"]').click();
  }
});

// Theme + settings
themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  saveState();
  render();
});

$("settingsBtn").addEventListener("click", () => {
  settingsPanel.classList.add("open");
  settingsPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
});

$("closeSettingsBtn").addEventListener("click", () => {
  settingsPanel.classList.remove("open");
  settingsPanel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("settings-open");
});

$("driveQuickBtn").addEventListener("click", () => {
  settingsPanel.classList.add("open");
  settingsPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-open");
  settingsPanel.scrollTop = 0;
  setTimeout(() => {
    const driveSection = $("workerAccessKey");
    if (driveSection) driveSection.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 50);
});

document.querySelectorAll("#backgroundModeControl button").forEach(btn => {
  btn.addEventListener("click", () => {
    state.appearance.backgroundMode = btn.dataset.mode;
    saveState();
    applyBackground();
  });
});

backgroundColor.addEventListener("input", () => {
  state.appearance.backgroundColor = backgroundColor.value;
  saveState();
  applyBackground();
});

overlayOpacity.addEventListener("input", () => {
  state.appearance.overlayOpacity = Number(overlayOpacity.value);
  saveState();
  applyBackground();
});

slideshowSeconds.addEventListener("change", () => {
  state.appearance.slideshowSeconds = Number(slideshowSeconds.value);
  saveState();
  applyBackground();
});

backgroundImagesInput.addEventListener("change", async e => {
  const files = [...e.target.files];
  if (!files.length) return;

  for (const file of files) {
    if (file.type.startsWith("image/")) await addImage(file);
  }

  await refreshImages();

  if (backgroundImages.length === 1) state.appearance.backgroundMode = "image";
  else if (backgroundImages.length > 1) state.appearance.backgroundMode = "slideshow";

  saveState();
  applyBackground();
  e.target.value = "";
});

$("clearImagesBtn").addEventListener("click", async () => {
  await clearImages();
  state.appearance.backgroundMode = "color";
  saveState();
  await refreshImages();
});

// Cloudflare auth helper / Google Drive actions
$("saveWorkerKeyBtn").addEventListener("click", () => {
  pairThisDevice().catch(handleDriveError);
});

workerAccessKey.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    pairThisDevice().catch(handleDriveError);
  }
});

$("connectDriveBtn").addEventListener("click", () => {
  authorizeGoogleDrive().catch(handleDriveError);
});

$("syncDriveBtn").addEventListener("click", async () => {
  try {
    await getWorkerAccessToken();
    await smartSync();
  } catch (error) {
    handleDriveError(error);
  }
});

$("pullDriveBtn").addEventListener("click", async () => {
  try {
    await getWorkerAccessToken();
    await restoreFromDrive();
  } catch (error) {
    handleDriveError(error);
  }
});

$("pushDriveBtn").addEventListener("click", async () => {
  try {
    await getWorkerAccessToken();
    const okay = confirm("Back up this device's current dashboard to Google Drive? Any existing Drive copy is preserved in the Backups folder first.");
    if (okay) await uploadLocalToDrive({ backupRemote: true });
  } catch (error) {
    handleDriveError(error);
  }
});

// If Google just redirected back after the one-time authorization,
// clean the URL and immediately sync.
if (new URLSearchParams(location.search).get("google") === "connected") {
  history.replaceState({}, "", location.pathname);
  setTimeout(async () => {
    try {
      if (localConfig.workerAccessKey) {
        await getWorkerAccessToken();
        await smartSync();
      }
    } catch (error) {
      handleDriveError(error);
    }
  }, 500);
}

// Conflict
$("useDriveBtn").addEventListener("click", async () => {
  if (!pendingConflict) return;
  downloadJsonBackup("conflict-local-copy");
  await applyRemoteState(pendingConflict);
  pendingConflict = null;
  $("conflictDialog").close();
  setDriveStatus("Drive copy kept. Local copy was downloaded as a backup.");
});

$("useDeviceBtn").addEventListener("click", async () => {
  const remote = pendingConflict;
  pendingConflict = null;
  $("conflictDialog").close();
  if (remote) await createRemoteBackup(remote);
  await uploadLocalToDrive({ backupRemote: false });
  setDriveStatus("This device copy kept. Previous Drive copy was backed up.");
});

$("cancelConflictBtn").addEventListener("click", () => {
  pendingConflict = null;
  $("conflictDialog").close();
});

// Export / Import
$("exportBtn").addEventListener("click", async () => {
  await saveJournalCurrent();
  downloadJsonBackup("backup");
});

$("importInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.habits)) throw new Error("Invalid backup");
    state = mergeDefaults(imported);
    saveState({ touch: false });
    initJournalMemory();
    journalDate = new Date();
    render();
    applyBackground();
  } catch {
    alert("That file doesn't look like a valid Habit Dashboard backup.");
  }

  e.target.value = "";
});

// PWA
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(console.error);
  });
}

window.addEventListener("beforeunload", () => {
  // Browser may not wait for async encryption here, so normal input autosave is the primary path.
  revokeImageURLs();
});

initJournalMemory();
render();
refreshImages().catch(() => applyBackground());

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && settingsPanel.classList.contains("open")) {
    settingsPanel.classList.remove("open");
    settingsPanel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("settings-open");
  }
});
