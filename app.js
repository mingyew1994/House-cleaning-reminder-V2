/* ============================================================
   CleanHome — app.js
   Sections:
     1. State & Persistence
     2. Utilities
     3. Canvas Engine (shared)
     4. Layout Editor
     5. Task Manager
     6. Clean Now
     7. Router / Boot
   ============================================================ */

'use strict';

// ───────────────────────────────────────────────────────────────
// 0. Firebase Init
// ───────────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey: 'AIzaSyAhaaOnASWPKKWoOl_u7148jBhUB667MP8',
  authDomain: 'home-cleaning-app-e5822.firebaseapp.com',
  projectId: 'home-cleaning-app-e5822',
  storageBucket: 'home-cleaning-app-e5822.firebasestorage.app',
  messagingSenderId: '893296379379',
  appId: '1:893296379379:web:573899cd9e018a5ee87e86',
});
const auth = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();
let currentUser    = null;
let currentHouseId = null;
let userHouses     = [];    // [{ id, name, ownerId, members, ... }] — all houses this user is in
let _saveTimer     = null;
let _unsubSnapshot = null;  // real-time listener cleanup

// ─────────────────────────────────────────────────────────────
// 1. State & Persistence
// ─────────────────────────────────────────────────────────────

const STORAGE_ROOMS = 'hca_rooms';
const STORAGE_TASKS = 'hca_tasks';

const state = {
  rooms: [],   // { id, label, cells:[{r,c}], color }
  tasks: [],   // { id, roomId, name, durationMins, intervalDays, lastCleaned, photo }
};

// ── Sync status badge ──
function setSyncStatus(status) {
  // status: 'synced' | 'saving' | 'offline'
  let el = document.getElementById('sync-status');
  if (!el) return;
  const map = {
    synced:  { icon: '☁️', text: 'Synced',  color: 'var(--green)' },
    saving:  { icon: '🔄', text: 'Saving…', color: 'var(--amber)' },
    offline: { icon: '⚠️', text: 'Offline', color: 'var(--red)'   },
  };
  const s = map[status] || map.offline;
  el.innerHTML = `<span style="font-size:11px;color:${s.color};font-weight:600;display:flex;align-items:center;gap:3px">${s.icon} ${s.text}</span>`;
}

function saveState() {
  // localStorage as fast backup
  try {
    localStorage.setItem(STORAGE_ROOMS, JSON.stringify(state.rooms));
    localStorage.setItem(STORAGE_TASKS, JSON.stringify(state.tasks));
  } catch(e) {}
  // Debounce Firestore writes (max once per 800 ms)
  if (!currentHouseId) { setSyncStatus('offline'); return; }
  setSyncStatus('saving');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    db.collection('houses').doc(currentHouseId)
      .update({ rooms: state.rooms, tasks: state.tasks })
      .then(() => setSyncStatus('synced'))
      .catch(e => { console.warn('Firestore save failed', e); setSyncStatus('offline'); });
  }, 800);
}

function loadStateLocal() {
  try {
    const r = localStorage.getItem(STORAGE_ROOMS);
    const t = localStorage.getItem(STORAGE_TASKS);
    if (r) state.rooms = JSON.parse(r);
    if (t) state.tasks = JSON.parse(t);
  } catch(e) { console.warn('Load failed', e); }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─────────────────────────────────────────────────────────────
// 2. Utilities
// ─────────────────────────────────────────────────────────────

const ROOM_COLORS = [
  '#6c63ff', '#30d158', '#ff9f0a', '#ff453a',
  '#0a84ff', '#bf5af2', '#ff6b9d', '#5ac8fa',
  '#34c759', '#ff9500',
];

let _colorIdx = 0;
function nextColor() { return ROOM_COLORS[_colorIdx++ % ROOM_COLORS.length]; }

function cellKey(r, c) { return `${r},${c}`; }
function parseKey(k) { const [r, c] = k.split(',').map(Number); return { r, c }; }

function cellsEqual(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map(({r, c}) => cellKey(r, c)));
  return b.every(({r, c}) => setA.has(cellKey(r, c)));
}

function showAlert(msg) {
  document.getElementById('modal-alert-msg').textContent = msg;
  document.getElementById('modal-alert').style.display = '';
}

document.getElementById('btn-alert-ok').addEventListener('click', () => {
  document.getElementById('modal-alert').style.display = 'none';
});

function daysSince(isoStr) {
  if (!isoStr) return Infinity;
  return (Date.now() - new Date(isoStr).getTime()) / 86400000;
}

function formatTime(mins) {
  if (mins < 60) return `${mins} mins`;
  const hr = Math.floor(mins / 60);
  const m = mins % 60;
  const hStr = hr === 1 ? '1 hour' : `${hr} hours`;
  return m === 0 ? hStr : `${hStr} ${m} mins`;
}

/** Compress an image data-URL to max 700px JPEG at 0.7 quality. */
async function compressImage(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const MAX = 700, canvas = document.createElement('canvas');
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) {
        const ratio = MAX / Math.max(w, h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Check if a string is a base64 data URL (not a remote URL). */
function isDataUrl(str) {
  return str && str.startsWith('data:');
}

/** Upload a base64 photo to Firebase Storage and return the download URL. */
async function uploadTaskPhoto(taskId, dataUrl) {
  if (!currentHouseId || !dataUrl) return null;
  try {
    const path = `houses/${currentHouseId}/tasks/${taskId}.jpg`;
    const ref = storage.ref(path);
    // Convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await ref.put(blob, { contentType: 'image/jpeg' });
    return await ref.getDownloadURL();
  } catch (e) {
    console.warn('Photo upload failed', e);
    return dataUrl; // fallback to keeping the data URL
  }
}

/** Delete a task's photo from Firebase Storage. */
async function deleteTaskPhoto(taskId) {
  if (!currentHouseId) return;
  try {
    const path = `houses/${currentHouseId}/tasks/${taskId}.jpg`;
    await storage.ref(path).delete();
  } catch (e) {
    // Ignore — file may not exist
  }
}

/** Migrate any remaining base64 photos in state to Firebase Storage. */
async function migrateBase64Photos() {
  if (!currentHouseId) return;
  let changed = false;
  for (const task of state.tasks) {
    if (isDataUrl(task.photo)) {
      const url = await uploadTaskPhoto(task.id, task.photo);
      if (url && !isDataUrl(url)) {
        task.photo = url;
        changed = true;
      }
    }
  }
  if (changed) saveState();
}

// ─────────────────────────────────────────────────────────────
// 3. Canvas Engine
// ─────────────────────────────────────────────────────────────

const GRID_ROWS = 24;
const GRID_COLS = 16;
const CELL_PX      = 28;   // pixels per cell — layout editor
const TASK_CELL_PX = 14;   // pixels per cell — tasks mini-map

function canvasSize() {
  return { w: GRID_COLS * CELL_PX, h: GRID_ROWS * CELL_PX };
}
function taskCanvasSize() {
  return { w: GRID_COLS * TASK_CELL_PX, h: GRID_ROWS * TASK_CELL_PX };
}

function setupCanvas(canvas, size) {
  const { w, h } = size || canvasSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function drawGrid(ctx, cellPx) {
  const px = cellPx || CELL_PX;
  ctx.strokeStyle = 'rgba(160,160,190,0.35)';
  ctx.lineWidth = 0.5;
  for (let r = 0; r <= GRID_ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * px);
    ctx.lineTo(GRID_COLS * px, r * px);
    ctx.stroke();
  }
  for (let c = 0; c <= GRID_COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * px, 0);
    ctx.lineTo(c * px, GRID_ROWS * px);
    ctx.stroke();
  }
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Draw all saved rooms. cellPx defaults to CELL_PX (layout editor). */
function drawRooms(ctx, rooms, highlightIds = [], cellPx) {
  const px = cellPx || CELL_PX;
  rooms.forEach(room => {
    const isHighlighted = highlightIds.includes(room.id);
    room.cells.forEach(({ r, c }) => {
      ctx.fillStyle = isHighlighted
        ? hexToRgba(room.color, 0.85)
        : hexToRgba(room.color, 0.18);
      ctx.fillRect(c * px + 1, r * px + 1, px - 2, px - 2);
    });

    drawRoomOutline(ctx, room.cells, room.color, isHighlighted ? 2.5 : 1.5, px);

    // Label — find centroid (only if cells are large enough to read)
    if (room.cells.length > 0 && px >= 20) {
      const cx = room.cells.reduce((s, {c}) => s + c, 0) / room.cells.length;
      const cy = room.cells.reduce((s, {r}) => s + r, 0) / room.cells.length;
      const fontSize = px < 26 ? 9 : 11;
      ctx.font = `bold ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const words = room.label.split(' ');
      const lines = [];
      let line = '';
      words.forEach(w => {
        const test = line ? line + ' ' + w : w;
        if (test.length > 8 && line) { lines.push(line); line = w; }
        else { line = test; }
      });
      lines.push(line);
      const lineH = fontSize + 4;
      const centerX = (cx + 0.5) * px;
      const centerY = (cy + 0.5) * px;

      // Measure the widest line for the background pill
      let maxW = 0;
      lines.forEach(l => { maxW = Math.max(maxW, ctx.measureText(l).width); });
      const padX = 6, padY = 3;
      const bgW = maxW + padX * 2;
      const bgH = lines.length * lineH + padY * 2;
      const bgX = centerX - bgW / 2;
      const bgY = centerY - bgH / 2;

      // Draw dark background pill
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const pillR = 4;
      ctx.beginPath();
      ctx.moveTo(bgX + pillR, bgY);
      ctx.lineTo(bgX + bgW - pillR, bgY);
      ctx.quadraticCurveTo(bgX + bgW, bgY, bgX + bgW, bgY + pillR);
      ctx.lineTo(bgX + bgW, bgY + bgH - pillR);
      ctx.quadraticCurveTo(bgX + bgW, bgY + bgH, bgX + bgW - pillR, bgY + bgH);
      ctx.lineTo(bgX + pillR, bgY + bgH);
      ctx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - pillR);
      ctx.lineTo(bgX, bgY + pillR);
      ctx.quadraticCurveTo(bgX, bgY, bgX + pillR, bgY);
      ctx.closePath();
      ctx.fill();

      // Draw white text on the dark pill
      ctx.fillStyle = '#ffffff';
      lines.forEach((l, i) => {
        ctx.fillText(l, centerX, centerY + (i - (lines.length - 1) / 2) * lineH);
      });
    }
  });
}

/** Draw task badges on rooms — colored by worst urgency */
function drawTaskBadges(ctx, rooms, tasks, cellPx) {
  const px = cellPx || CELL_PX;
  const r = px < 20 ? 5 : 7;
  rooms.forEach(room => {
    const roomTasks = tasks.filter(t => t.roomId === room.id);
    if (roomTasks.length === 0) return;
    // Find worst urgency
    let badgeColor = '#22a85a'; // green
    roomTasks.forEach(task => {
      const ratio = daysSince(task.lastCleaned) / task.intervalDays;
      if (ratio >= 1) { badgeColor = '#e5372b'; }
      else if (ratio >= 0.5 && badgeColor !== '#e5372b') { badgeColor = '#d97706'; }
    });
    const maxC = Math.max(...room.cells.map(c => c.c));
    const minR = Math.min(...room.cells.filter(c => c.c === maxC).map(c => c.r));
    const x = (maxC + 1) * px - r;
    const y = minR * px + r;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = badgeColor;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${px < 20 ? 7 : 9}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(roomTasks.length > 9 ? '9+' : roomTasks.length, x, y);
  });
}

function drawRoomOutline(ctx, cells, color, lineWidth = 2, cellPx) {
  const px = cellPx || CELL_PX;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  const cellSet = new Set(cells.map(({r, c}) => cellKey(r, c)));
  cells.forEach(({ r, c }) => {
    if (!cellSet.has(cellKey(r - 1, c))) {
      ctx.beginPath(); ctx.moveTo(c * px, r * px); ctx.lineTo((c + 1) * px, r * px); ctx.stroke();
    }
    if (!cellSet.has(cellKey(r + 1, c))) {
      ctx.beginPath(); ctx.moveTo(c * px, (r + 1) * px); ctx.lineTo((c + 1) * px, (r + 1) * px); ctx.stroke();
    }
    if (!cellSet.has(cellKey(r, c - 1))) {
      ctx.beginPath(); ctx.moveTo(c * px, r * px); ctx.lineTo(c * px, (r + 1) * px); ctx.stroke();
    }
    if (!cellSet.has(cellKey(r, c + 1))) {
      ctx.beginPath(); ctx.moveTo((c + 1) * px, r * px); ctx.lineTo((c + 1) * px, (r + 1) * px); ctx.stroke();
    }
  });
}

function pointerToCell(canvas, evt, cellPx) {
  const px = cellPx || CELL_PX;
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX || evt.touches?.[0]?.clientX || 0) - rect.left;
  const y = (evt.clientY || evt.touches?.[0]?.clientY || 0) - rect.top;
  return {
    r: Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(y / px))),
    c: Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x / px))),
  };
}

// ─────────────────────────────────────────────────────────────
// 4. Layout Editor
// ─────────────────────────────────────────────────────────────

const layoutEditor = (() => {
  const canvas = document.getElementById('floor-canvas');
  let ctx;

  // Current tool: 'draw' | 'merge' | 'erase' | 'label' | 'move'
  let activeTool = 'draw';

  // Cells being painted in current stroke
  let pendingCells = new Set();  // cellKey strings

  // For merge: selected room ids
  let mergeSelected = [];

  // Is pointer currently down?
  let pointerDown = false;

  // Floor plan overlay
  let overlayImg = null;

  // Overlay transform state
  let overlayScale   = 1.0;   // 1.0 = 100%
  let overlayOpacity = 0.5;   // 0–1
  let overlayX       = 0;     // px offset
  let overlayY       = 0;     // px offset
  let overlayCrop    = true;  // clip to canvas bounds
  // For drag-move
  let moveDragStart  = null;  // { x, y, startOX, startOY }

  const btnDraw  = document.getElementById('btn-tool-draw');
  const btnMerge = document.getElementById('btn-tool-merge');
  const btnErase = document.getElementById('btn-tool-erase');
  const btnLabel = document.getElementById('btn-tool-label');
  const btnMove  = document.getElementById('btn-tool-move');
  const btnSave  = document.getElementById('btn-save-room');
  const btnClear = document.getElementById('btn-clear-selection');
  const btnDel   = document.getElementById('btn-delete-room');
  const btnEditMode = document.getElementById('btn-edit-mode');
  const toolbar  = document.getElementById('layout-toolbar');
  const overlayControlsEl = document.getElementById('overlay-controls');
  const chipsEl  = document.getElementById('room-chips');
  let editMode   = false;

  function init() {
    ctx = setupCanvas(canvas);
    bindToolButtons();
    bindCanvasEvents();
    bindActionButtons();
    bindEditModeButton();
    bindOverlayInput();
    canvas.classList.add('canvas-locked');
    renderAll();
  }

  // ── Overlay controls helpers ─────────────────────

  function showOverlayControls() {
    overlayControlsEl.classList.remove('overlay-controls-hidden');
    btnMove.style.display = '';
  }
  function hideOverlayControls() {
    overlayControlsEl.classList.add('overlay-controls-hidden');
    btnMove.style.display = 'none';
    if (activeTool === 'move') setTool('draw');
  }

  function resetOverlayTransform() {
    overlayScale = 1.0;
    overlayOpacity = 0.5;
    overlayX = 0;
    overlayY = 0;
    syncOverlaySliders();
    renderAll();
  }

  function fitOverlayToCanvas() {
    if (!overlayImg) return;
    const { w, h } = canvasSize();
    const scaleW = w / overlayImg.naturalWidth;
    const scaleH = h / overlayImg.naturalHeight;
    overlayScale = Math.min(scaleW, scaleH);
    overlayX = 0;
    overlayY = 0;
    syncOverlaySliders();
    renderAll();
  }

  function syncOverlaySliders() {
    const scaleSlider   = document.getElementById('overlay-scale');
    const opacitySlider = document.getElementById('overlay-opacity');
    const xSlider       = document.getElementById('overlay-x');
    const ySlider       = document.getElementById('overlay-y');
    const cropCheck     = document.getElementById('overlay-crop-check');

    scaleSlider.value   = Math.round(overlayScale * 100);
    opacitySlider.value = Math.round(overlayOpacity * 100);
    xSlider.value       = Math.round(overlayX);
    ySlider.value       = Math.round(overlayY);
    cropCheck.checked   = overlayCrop;

    document.getElementById('overlay-scale-val').textContent   = Math.round(overlayScale * 100) + '%';
    document.getElementById('overlay-opacity-val').textContent  = Math.round(overlayOpacity * 100) + '%';
    document.getElementById('overlay-x-val').textContent        = Math.round(overlayX);
    document.getElementById('overlay-y-val').textContent        = Math.round(overlayY);
  }

  function bindOverlayInput() {
    const input    = document.getElementById('overlay-img-input');
    const clearBtn = document.getElementById('btn-overlay-clear');

    // Upload handler
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          overlayImg = img;
          clearBtn.style.display = '';
          resetOverlayTransform();
          fitOverlayToCanvas();
          showOverlayControls();
          renderAll();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
      input.value = '';
    });

    // Clear handler
    clearBtn.addEventListener('click', () => {
      overlayImg = null;
      clearBtn.style.display = 'none';
      hideOverlayControls();
      renderAll();
    });

    // Scale slider
    document.getElementById('overlay-scale').addEventListener('input', e => {
      overlayScale = parseInt(e.target.value) / 100;
      document.getElementById('overlay-scale-val').textContent = e.target.value + '%';
      renderAll();
    });

    // Opacity slider
    document.getElementById('overlay-opacity').addEventListener('input', e => {
      overlayOpacity = parseInt(e.target.value) / 100;
      document.getElementById('overlay-opacity-val').textContent = e.target.value + '%';
      renderAll();
    });

    // X slider
    document.getElementById('overlay-x').addEventListener('input', e => {
      overlayX = parseInt(e.target.value);
      document.getElementById('overlay-x-val').textContent = e.target.value;
      renderAll();
    });

    // Y slider
    document.getElementById('overlay-y').addEventListener('input', e => {
      overlayY = parseInt(e.target.value);
      document.getElementById('overlay-y-val').textContent = e.target.value;
      renderAll();
    });

    // Crop checkbox
    document.getElementById('overlay-crop-check').addEventListener('change', e => {
      overlayCrop = e.target.checked;
      renderAll();
    });

    // Fit button
    document.getElementById('btn-overlay-fit').addEventListener('click', () => {
      fitOverlayToCanvas();
    });

    // Reset button
    document.getElementById('btn-overlay-reset').addEventListener('click', () => {
      resetOverlayTransform();
    });
  }

  function bindEditModeButton() {
    btnEditMode.addEventListener('click', () => {
      editMode = !editMode;
      if (editMode) {
        btnEditMode.textContent = '🔒 Lock Layout';
        btnEditMode.classList.add('editing');
        toolbar.classList.remove('toolbar-hidden');
        canvas.classList.remove('canvas-locked');
        btnSave.style.display = '';
        btnClear.style.display = '';
      } else {
        btnEditMode.textContent = '✏️ Edit Layout';
        btnEditMode.classList.remove('editing');
        toolbar.classList.add('toolbar-hidden');
        hideOverlayControls();
        canvas.classList.add('canvas-locked');
        canvas.classList.remove('tool-move');
        pendingCells.clear();
        mergeSelected = [];
        btnSave.style.display = 'none';
        btnClear.style.display = 'none';
        btnDel.style.display = 'none';
        renderAll();
      }
    });
  }

  function setTool(tool) {
    activeTool = tool;
    pendingCells.clear();
    mergeSelected = [];
    [btnDraw, btnMerge, btnErase, btnLabel, btnMove].forEach(b => b.classList.remove('active'));
    ({ draw: btnDraw, merge: btnMerge, erase: btnErase, label: btnLabel, move: btnMove })[tool]?.classList.add('active');
    // Toggle move cursor
    if (tool === 'move') {
      canvas.classList.add('tool-move');
    } else {
      canvas.classList.remove('tool-move');
    }
    updateActionButtons();
    renderAll();
  }

  function bindToolButtons() {
    btnDraw.addEventListener('click',  () => setTool('draw'));
    btnMerge.addEventListener('click', () => setTool('merge'));
    btnErase.addEventListener('click', () => setTool('erase'));
    btnLabel.addEventListener('click', () => setTool('label'));
    btnMove.addEventListener('click',  () => setTool('move'));
  }

  function bindCanvasEvents() {
    // Pointer events (covers mouse + touch)
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerDown(e) {
    e.preventDefault();
    pointerDown = true;
    canvas.setPointerCapture(e.pointerId);

    if (activeTool === 'move' && overlayImg) {
      const rect = canvas.getBoundingClientRect();
      moveDragStart = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        startOX: overlayX,
        startOY: overlayY,
      };
      return;
    }

    const { r, c } = pointerToCell(canvas, e);
    handleCellInteraction(r, c);
  }

  function onPointerMove(e) {
    e.preventDefault();
    if (!pointerDown) return;

    if (activeTool === 'move' && moveDragStart) {
      const rect = canvas.getBoundingClientRect();
      const dx = (e.clientX - rect.left) - moveDragStart.x;
      const dy = (e.clientY - rect.top) - moveDragStart.y;
      overlayX = moveDragStart.startOX + dx;
      overlayY = moveDragStart.startOY + dy;
      syncOverlaySliders();
      renderAll();
      return;
    }

    const { r, c } = pointerToCell(canvas, e);
    if (activeTool === 'draw' || activeTool === 'erase') {
      handleCellInteraction(r, c);
    }
  }

  function onPointerUp() {
    pointerDown = false;
    moveDragStart = null;
  }

  function handleCellInteraction(r, c) {
    const key = cellKey(r, c);

    if (activeTool === 'draw') {
      // Don't overwrite existing rooms
      if (!occupiedByRoom(r, c)) {
        pendingCells.add(key);
        renderAll();
      }
    } else if (activeTool === 'erase') {
      // Remove from pending
      pendingCells.delete(key);
      // Remove from existing rooms
      state.rooms = state.rooms.map(room => ({
        ...room,
        cells: room.cells.filter(cell => !(cell.r === r && cell.c === c)),
      })).filter(room => room.cells.length > 0);
      saveState();
      renderAll();
      renderChips();
    } else if (activeTool === 'merge') {
      const room = findRoomAtCell(r, c);
      if (room) {
        if (mergeSelected.includes(room.id)) {
          mergeSelected = mergeSelected.filter(id => id !== room.id);
        } else {
          mergeSelected.push(room.id);
        }
        updateActionButtons();
        renderAll();
      }
    } else if (activeTool === 'label') {
      const room = findRoomAtCell(r, c);
      if (room) openRoomNameModal(room);
    }
  }

  function occupiedByRoom(r, c) {
    return state.rooms.some(room =>
      room.cells.some(cell => cell.r === r && cell.c === c)
    );
  }

  function findRoomAtCell(r, c) {
    return state.rooms.find(room =>
      room.cells.some(cell => cell.r === r && cell.c === c)
    );
  }

  function updateActionButtons() {
    if (activeTool === 'draw') {
      btnSave.style.display = '';
      btnClear.style.display = '';
      btnDel.style.display = 'none';
    } else if (activeTool === 'merge') {
      btnSave.style.display = mergeSelected.length >= 2 ? '' : 'none';
      btnSave.textContent = '🔗 Merge Rooms';
      btnClear.style.display = mergeSelected.length > 0 ? '' : 'none';
      btnDel.style.display = 'none';
    } else if (activeTool === 'erase') {
      btnSave.style.display = 'none';
      btnClear.style.display = '';
      btnDel.style.display = mergeSelected.length > 0 ? '' : 'none';
    } else {
      btnSave.style.display = 'none';
      btnClear.style.display = 'none';
      btnDel.style.display = 'none';
    }
    if (activeTool === 'draw') btnSave.textContent = '✔ Save Room';
  }

  function bindActionButtons() {
    btnSave.addEventListener('click', () => {
      if (activeTool === 'draw') saveRoom();
      else if (activeTool === 'merge') mergeRooms();
    });
    btnClear.addEventListener('click', () => {
      pendingCells.clear();
      mergeSelected = [];
      updateActionButtons();
      renderAll();
    });
    btnDel.addEventListener('click', deleteSelectedRooms);
  }

  // ── Room Name Modal ──────────────────────────────

  let _pendingColor = ROOM_COLORS[0];
  let _editingRoomId = null;

  function buildColorPicker() {
    const el = document.getElementById('room-color-picker');
    el.innerHTML = '';
    ROOM_COLORS.forEach(color => {
      const dot = document.createElement('div');
      dot.className = 'color-dot' + (color === _pendingColor ? ' selected' : '');
      dot.style.background = color;
      dot.addEventListener('click', () => {
        _pendingColor = color;
        el.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
      });
      el.appendChild(dot);
    });
  }

  function openRoomNameModal(existingRoom = null) {
    _editingRoomId = existingRoom ? existingRoom.id : null;
    _pendingColor = existingRoom ? existingRoom.color : nextColor();
    document.getElementById('input-room-name').value = existingRoom ? existingRoom.label : '';
    buildColorPicker();
    document.getElementById('modal-room-name').style.display = '';
    document.getElementById('input-room-name').focus();
  }

  document.getElementById('btn-room-name-cancel').addEventListener('click', () => {
    document.getElementById('modal-room-name').style.display = 'none';
  });

  document.getElementById('btn-room-name-save').addEventListener('click', () => {
    const label = document.getElementById('input-room-name').value.trim() || 'Room';
    if (_editingRoomId) {
      const room = state.rooms.find(r => r.id === _editingRoomId);
      if (room) { room.label = label; room.color = _pendingColor; }
    } else {
      commitRoom(label, _pendingColor);
    }
    document.getElementById('modal-room-name').style.display = 'none';
    saveState();
    renderAll();
    renderChips();
  });

  function saveRoom() {
    if (pendingCells.size === 0) { showAlert('Paint some cells first!'); return; }
    openRoomNameModal();
  }

  function commitRoom(label, color) {
    const cells = Array.from(pendingCells).map(k => parseKey(k));
    state.rooms.push({ id: uid(), label, cells, color });
    pendingCells.clear();
  }

  function mergeRooms() {
    if (mergeSelected.length < 2) return;
    const rooms = mergeSelected.map(id => state.rooms.find(r => r.id === id)).filter(Boolean);
    const allCells = rooms.flatMap(r => r.cells);
    const base = rooms[0];
    base.cells = allCells;
    // Remove merged rooms (keep base)
    const removeIds = mergeSelected.slice(1);
    state.rooms = state.rooms.filter(r => !removeIds.includes(r.id));
    // Move tasks from removed rooms to base
    state.tasks.forEach(t => {
      if (removeIds.includes(t.roomId)) t.roomId = base.id;
    });
    mergeSelected = [];
    saveState();
    renderAll();
    renderChips();
  }

  function deleteSelectedRooms() {
    if (mergeSelected.length === 0) return;
    state.rooms = state.rooms.filter(r => !mergeSelected.includes(r.id));
    state.tasks = state.tasks.filter(t => !mergeSelected.includes(t.roomId));
    mergeSelected = [];
    saveState();
    renderAll();
    renderChips();
  }

  // ── Render ───────────────────────────────────────

  function renderAll() {
    const { w, h } = canvasSize();
    ctx.clearRect(0, 0, w, h);

    // Draw floor plan overlay (only in edit mode, with transform controls)
    if (editMode && overlayImg) {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;

      // Optionally clip to canvas bounds
      if (overlayCrop) {
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();
      }

      // Compute the rendered image size
      const imgW = overlayImg.naturalWidth * overlayScale;
      const imgH = overlayImg.naturalHeight * overlayScale;

      ctx.drawImage(overlayImg, overlayX, overlayY, imgW, imgH);
      ctx.restore();
    }

    drawGrid(ctx);
    drawRooms(ctx, state.rooms, mergeSelected);
    drawTaskBadges(ctx, state.rooms, state.tasks);

    // Pending cells (being drawn)
    const pendingColor = '#6c63ff';
    pendingCells.forEach(key => {
      const { r, c } = parseKey(key);
      ctx.fillStyle = hexToRgba(pendingColor, 0.55);
      ctx.fillRect(c * CELL_PX + 1, r * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    });
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    state.rooms.forEach(room => {
      const chip = document.createElement('div');
      chip.className = 'room-chip' + (mergeSelected.includes(room.id) ? ' selected' : '');
      chip.style.background = hexToRgba(room.color, 0.25);
      chip.style.borderColor = room.color;
      chip.innerHTML = `<span class="chip-dot" style="background:${room.color}"></span>${room.label}`;
      chip.addEventListener('click', () => {
        if (activeTool === 'merge') {
          if (mergeSelected.includes(room.id)) {
            mergeSelected = mergeSelected.filter(id => id !== room.id);
          } else {
            mergeSelected.push(room.id);
          }
          updateActionButtons();
          renderAll();
          renderChips();
        } else if (activeTool === 'label') {
          openRoomNameModal(room);
        }
      });
      chipsEl.appendChild(chip);
    });
  }

  return { init, renderAll, renderChips };
})();

// ─────────────────────────────────────────────────────────────
// 5. Task Manager
// ─────────────────────────────────────────────────────────────

const taskManager = (() => {
  const canvas  = document.getElementById('tasks-canvas');
  let ctx;

  let selectedRoomId = null;
  let editingTaskId  = null;
  let photoDataUrl   = null;

  const roomTitleEl = document.getElementById('tasks-room-title');
  const listEl      = document.getElementById('tasks-list');
  const addBtn      = document.getElementById('btn-add-task');
  const hintEl      = document.getElementById('tasks-hint');

  function init() {
    ctx = setupCanvas(canvas, taskCanvasSize());
    bindCanvasEvents();
    bindRoomChips();
    bindModal();
    bindPhotoInput();
    renderCanvas();
  }

  // Room chips element in tasks view (we add it dynamically)
  let taskChipsEl = null;
  let viewAll = false;  // true = show all rooms grouped

  function bindCanvasEvents() {
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      const { r, c } = pointerToCell(canvas, e, TASK_CELL_PX);
      const room = state.rooms.find(room =>
        room.cells.some(cell => cell.r === r && cell.c === c)
      );
      if (room) selectRoom(room.id);
      else { selectedRoomId = null; renderList(); updateTaskChips(); }
      renderCanvas();
    }, { passive: false });
  }

  function bindRoomChips() {
    // Insert a chips row between canvas wrap and list wrap
    taskChipsEl = document.createElement('div');
    taskChipsEl.id = 'task-room-chips';
    taskChipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;flex-shrink:0;overflow-x:auto;border-bottom:1px solid var(--border);background:var(--bg2);';
    const tasksWrap = document.getElementById('tasks-list-wrap');
    tasksWrap.parentNode.insertBefore(taskChipsEl, tasksWrap);
    updateTaskChips();
  }

  function updateTaskChips() {
    if (!taskChipsEl) return;
    taskChipsEl.innerHTML = '';

    if (state.rooms.length === 0) {
      taskChipsEl.innerHTML = '<span style="color:var(--text3);font-size:12px;padding:4px">No rooms yet — draw rooms in the Layout tab first.</span>';
      return;
    }

    // "All Rooms" chip
    const allChip = document.createElement('div');
    allChip.className = 'room-chip' + (viewAll ? ' selected' : '');
    allChip.style.background = viewAll ? 'rgba(108,99,255,0.35)' : 'rgba(108,99,255,0.12)';
    allChip.style.borderColor = '#6c63ff';
    const totalTasks = state.tasks.length;
    allChip.innerHTML = `<span class="chip-dot" style="background:#6c63ff"></span>All Rooms${totalTasks ? ` <span style="font-size:10px;opacity:.7">(${totalTasks})</span>` : ''}`;
    allChip.addEventListener('click', () => {
      viewAll = true;
      selectedRoomId = null;
      hintEl.style.display = 'none';
      renderList();
      renderCanvas();
      updateTaskChips();
    });
    taskChipsEl.appendChild(allChip);

    state.rooms.forEach(room => {
      const chip = document.createElement('div');
      chip.className = 'room-chip' + (!viewAll && room.id === selectedRoomId ? ' selected' : '');
      chip.style.background = hexToRgba(room.color, 0.25);
      chip.style.borderColor = room.color;
      const taskCount = state.tasks.filter(t => t.roomId === room.id).length;
      chip.innerHTML = `<span class="chip-dot" style="background:${room.color}"></span>${room.label}${taskCount ? ` <span style="font-size:10px;opacity:.7">(${taskCount})</span>` : ''}`;
      chip.addEventListener('click', () => {
        viewAll = false;
        selectRoom(room.id);
        renderCanvas();
        updateTaskChips();
      });
      taskChipsEl.appendChild(chip);
    });
  }

  function selectRoom(roomId) {
    viewAll = false;
    selectedRoomId = roomId;
    renderList();
    hintEl.style.display = 'none';
    updateTaskChips();
  }

  function renderCanvas() {
    const { w, h } = taskCanvasSize();
    ctx.clearRect(0, 0, w, h);
    drawGrid(ctx, TASK_CELL_PX);
    // Highlight: all rooms when viewAll, otherwise just selected room
    const highlightIds = viewAll ? state.rooms.map(r => r.id) : (selectedRoomId ? [selectedRoomId] : []);
    drawRooms(ctx, state.rooms, highlightIds, TASK_CELL_PX);
    drawTaskBadges(ctx, state.rooms, state.tasks, TASK_CELL_PX);
  }

  function renderList() {
    listEl.innerHTML = '';
    addBtn.style.display = 'none';

    // ── View All mode: show every room's tasks grouped ──────────
    if (viewAll) {
      roomTitleEl.textContent = '';
      const roomsWithTasks = state.rooms.filter(r => state.tasks.some(t => t.roomId === r.id));
      const roomsWithoutTasks = state.rooms.filter(r => !state.tasks.some(t => t.roomId === r.id));

      if (state.tasks.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🏠</div><p>No tasks in any room yet.<br>Tap a room chip to add tasks.</p></div>';
        return;
      }

      roomsWithTasks.forEach(room => {
        // Room section header
        const header = document.createElement('div');
        header.className = 'room-section-header';
        header.style.borderLeftColor = room.color;
        const roomTasks = state.tasks.filter(t => t.roomId === room.id);
        header.innerHTML = `
          <span class="room-section-dot" style="background:${room.color}"></span>
          <span class="room-section-name">${escHtml(room.label)}</span>
          <span class="room-section-count">${roomTasks.length} task${roomTasks.length !== 1 ? 's' : ''}</span>`;
        listEl.appendChild(header);

        roomTasks.forEach(task => listEl.appendChild(buildTaskCard(task)));
      });

      // Show rooms with no tasks as a subtle note
      if (roomsWithoutTasks.length > 0) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:8px 4px 4px;font-size:12px;color:var(--text3);';
        note.textContent = `No tasks: ${roomsWithoutTasks.map(r => r.label).join(', ')}`;
        listEl.appendChild(note);
      }

      return;
    }

    // ── Single room mode ────────────────────────────────────────
    if (!selectedRoomId) {
      roomTitleEl.textContent = '';
      return;
    }
    const room = state.rooms.find(r => r.id === selectedRoomId);
    if (!room) { selectedRoomId = null; return; }

    roomTitleEl.textContent = room.label;
    roomTitleEl.style.color = room.color;
    addBtn.style.display = '';

    const roomTasks = state.tasks.filter(t => t.roomId === selectedRoomId);
    if (roomTasks.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No tasks yet.<br>Tap + Add Task to create one.</p></div>';
    } else {
      roomTasks.forEach(task => listEl.appendChild(buildTaskCard(task)));
    }
  }

  function urgencyLabel(task) {
    if (!task.lastCleaned) return { cls: 'urgent', text: 'Never cleaned' };
    const ratio = daysSince(task.lastCleaned) / task.intervalDays;
    const daysLeft = Math.round(task.intervalDays - daysSince(task.lastCleaned));

    if (daysLeft < 0) return { cls: 'urgent', text: `Overdue by ${Math.abs(daysLeft)}d` };
    if (daysLeft === 0) return { cls: 'urgent', text: 'Due today' };
    if (ratio >= 0.75) return { cls: 'soon', text: `Due in ${daysLeft}d` };
    return { cls: 'ok', text: `Due in ${daysLeft}d` };
  }

  function buildTaskCard(task) {
    const card = document.createElement('div');
    const { cls, text } = urgencyLabel(task);
    card.className = 'task-card ' + (cls === 'urgent' ? 'overdue' : cls === 'soon' ? 'due-soon' : '');

    // Urgency strip
    const strip = document.createElement('div');
    strip.className = 'urgency-strip';
    strip.style.background = cls === 'urgent' ? '#ff453a' : cls === 'soon' ? '#ffd60a' : '#30d158';
    card.appendChild(strip);

    // Photo thumbnail with lightbox
    if (task.photo) {
      const wrap = document.createElement('div');
      wrap.className = 'task-thumb-wrap';
      const img = document.createElement('img');
      img.className = 'task-thumb';
      img.src = task.photo;
      img.alt = task.name;
      img.title = 'Tap to zoom';
      // Clicking the thumbnail itself opens lightbox
      img.addEventListener('click', e => {
        e.stopPropagation();
        openPhotoLightbox(task.photo);
      });
      const expandBtn = document.createElement('button');
      expandBtn.className = 'task-thumb-expand';
      expandBtn.title = 'View photo';
      expandBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
      expandBtn.addEventListener('click', e => {
        e.stopPropagation();
        openPhotoLightbox(task.photo);
      });
      wrap.appendChild(img);
      wrap.appendChild(expandBtn);
      card.appendChild(wrap);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'task-info';
    info.innerHTML = `
      <div class="task-name">${escHtml(task.name)}</div>
      <div class="task-meta">
        <span class="task-badge">⏱ ${formatTime(task.durationMins)}</span>
        <span class="task-badge">🔁 every ${task.intervalDays}d</span>
        <span class="task-badge ${cls}">${text}</span>
      </div>`;
    card.appendChild(info);

    card.addEventListener('click', () => openTaskModal(task));
    return card;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Task Modal ────────────────────────────────────

  function bindModal() {
    addBtn.addEventListener('click', () => openTaskModal(null));
    document.getElementById('btn-task-cancel').addEventListener('click', closeTaskModal);
    document.getElementById('btn-task-save').addEventListener('click', saveTask);
    document.getElementById('btn-task-delete').addEventListener('click', deleteTask);
  }

  function openTaskModal(task) {
    editingTaskId = task ? task.id : null;
    photoDataUrl  = task ? task.photo || null : null;

    document.getElementById('modal-task-title').textContent = task ? 'Edit Task' : 'New Task';
    document.getElementById('task-name').value      = task ? task.name : '';
    document.getElementById('task-duration').value  = task ? task.durationMins : '';
    document.getElementById('task-interval').value  = task ? task.intervalDays : '';

    const preview = document.getElementById('task-photo-preview');
    if (photoDataUrl) {
      preview.src = photoDataUrl;
      preview.style.display = '';
    } else {
      preview.style.display = 'none';
      preview.src = '';
    }

    document.getElementById('btn-task-delete').style.display = task ? '' : 'none';
    document.getElementById('modal-task').style.display = '';
    document.getElementById('task-name').focus();
  }

  function closeTaskModal() {
    document.getElementById('modal-task').style.display = 'none';
  }

  async function saveTask() {
    const name     = document.getElementById('task-name').value.trim();
    const duration = parseInt(document.getElementById('task-duration').value);
    const interval = parseInt(document.getElementById('task-interval').value);

    if (!name)           { showAlert('Please enter a task name.'); return; }
    if (isNaN(duration) || duration < 1) { showAlert('Enter a valid duration.'); return; }
    if (isNaN(interval) || interval < 1) { showAlert('Enter a valid interval.'); return; }

    let taskId;

    if (editingTaskId) {
      taskId = editingTaskId;
      const task = state.tasks.find(t => t.id === editingTaskId);
      if (task) {
        task.name = name;
        task.durationMins = duration;
        task.intervalDays = interval;
        if (photoDataUrl !== undefined) task.photo = photoDataUrl;
      }
    } else {
      taskId = uid();
      state.tasks.push({
        id: taskId,
        roomId: selectedRoomId,
        name,
        durationMins: duration,
        intervalDays: interval,
        lastCleaned: null,
        photo: photoDataUrl,
      });
    }

    // Upload base64 photo to Firebase Storage if needed
    const task = state.tasks.find(t => t.id === taskId);
    if (task && isDataUrl(task.photo)) {
      closeTaskModal();
      renderList();
      renderCanvas();
      // Upload in background, then update URL
      const downloadUrl = await uploadTaskPhoto(taskId, task.photo);
      if (downloadUrl && !isDataUrl(downloadUrl)) {
        task.photo = downloadUrl;
      }
    } else {
      closeTaskModal();
      renderList();
      renderCanvas();
    }

    saveState();
    renderList();
    layoutEditor.renderAll();
  }

  async function deleteTask() {
    if (!editingTaskId) return;
    // Delete photo from Storage
    deleteTaskPhoto(editingTaskId);
    state.tasks = state.tasks.filter(t => t.id !== editingTaskId);
    saveState();
    closeTaskModal();
    renderList();
    renderCanvas();
    layoutEditor.renderAll();
  }

  function bindPhotoInput() {
    const input = document.getElementById('task-photo-input');
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async e => {
        photoDataUrl = await compressImage(e.target.result);
        const preview = document.getElementById('task-photo-preview');
        preview.src = photoDataUrl;
        preview.style.display = '';
      };
      reader.readAsDataURL(file);
    });
  }

  function refresh() {
    renderCanvas();
    renderList();
    updateTaskChips();
  }

  return { init, refresh };
})();

// ─────────────────────────────────────────────────────────────
// 6. Clean Now
// ─────────────────────────────────────────────────────────────

const cleanNow = (() => {
  const resultsEl = document.getElementById('clean-results');
  let cleanMode = 'time'; // 'time' | 'urgent'

  function init() {
    const timeInput = document.getElementById('avail-time');
    const timeDisplay = document.getElementById('time-val-display');

    function updateSlider() {
      const val = timeInput.value;
      timeDisplay.textContent = formatTime(val);
      const min = timeInput.min || 5;
      const max = timeInput.max || 240;
      const pct = ((val - min) / (max - min)) * 100;
      timeInput.style.backgroundSize = `${pct}% 100%`;
    }

    timeInput.addEventListener('input', updateSlider);
    updateSlider(); // set initial track fill

    document.getElementById('btn-go-clean').addEventListener('click', run);

    // Mode toggle
    document.querySelectorAll('.clean-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        cleanMode = btn.dataset.mode;
        document.querySelectorAll('.clean-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const isTime = cleanMode === 'time';
        document.getElementById('time-mode-panel').style.display = isTime ? '' : 'none';
        document.getElementById('urgent-mode-panel').style.display = isTime ? 'none' : '';
        // Auto-run urgent mode immediately
        if (!isTime) runUrgent();
        else resultsEl.innerHTML = ''; // clear previous results
      });
    });
  }

  function run() {
    const avail = parseInt(document.getElementById('avail-time').value);
    if (isNaN(avail) || avail < 1) { showAlert('Enter how many minutes you have.'); return; }

    // Score tasks by urgency — only include tasks past 50% of their interval
    const scored = state.tasks.map(task => {
      const ratio = daysSince(task.lastCleaned) / task.intervalDays;
      return { task, urgency: ratio };
    })
    .filter(({ urgency }) => urgency >= 0.5)   // Skip freshly-cleaned tasks
    .sort((a, b) => b.urgency - a.urgency);

    // Greedy pack
    let remaining = avail;
    const selected = [];
    scored.forEach(({ task, urgency }) => {
      if (task.durationMins <= remaining) {
        selected.push({ task, urgency });
        remaining -= task.durationMins;
      }
    });

    renderResults(selected, avail);
  }

  function renderResults(selected, availMins) {
    resultsEl.innerHTML = '';

    if (state.tasks.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🏠</div><p>No tasks yet!<br>Go to Layout → Tasks to add cleaning tasks.</p></div>';
      return;
    }

    if (selected.length === 0) {
      const eligible = state.tasks.filter(t => daysSince(t.lastCleaned) / t.intervalDays >= 0.5);
      if (eligible.length === 0) {
        resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><p>Everything is freshly cleaned!<br>Nothing needs attention right now.</p></div>';
      } else {
        resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⏱</div><p>Tasks need attention but don\'t fit in ' + availMins + ' minutes.<br>Try a longer time window.</p></div>';
      }
      return;
    }

    const totalMins = selected.reduce((s, { task }) => s + task.durationMins, 0);

    // Summary bar
    const summary = document.createElement('div');
    summary.id = 'clean-summary';
    summary.innerHTML = `
      <span><strong>${selected.length}</strong> task${selected.length !== 1 ? 's' : ''}</span>
      <span><strong>${formatTime(totalMins)}</strong> / ${formatTime(availMins)} used</span>`;
    resultsEl.appendChild(summary);

    selected.forEach(({ task, urgency }) => {
      const room = state.rooms.find(r => r.id === task.roomId);
      const card = document.createElement('div');
      card.className = 'clean-task-card';
      card.dataset.taskId = task.id;

      const check = document.createElement('div');
      check.className = 'task-check';
      check.addEventListener('click', e => {
        e.stopPropagation();
        toggleDone(task.id, card, check);
      });

      const info = document.createElement('div');
      info.className = 'clean-task-info';

      const urgencyStr = urgency >= 1 ? '🔴 Overdue'
        : urgency >= 0.75 ? '🟡 Due soon'
        : '🟢 Scheduled';

      info.innerHTML = `
        <div class="clean-task-name">${escHtml(task.name)}</div>
        <div class="clean-task-sub">${room ? room.label : 'Unknown room'} · ${urgencyStr}</div>`;

      const dur = document.createElement('div');
      dur.className = 'clean-task-duration';
      dur.textContent = formatTime(task.durationMins);

      card.appendChild(check);
      card.appendChild(info);
      card.appendChild(dur);
      resultsEl.appendChild(card);
    });
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function toggleDone(taskId, card, check) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    const isDone = check.classList.contains('checked');
    if (!isDone) {
      check.classList.add('checked');
      card.classList.add('done');
      const now = new Date().toISOString();
      task.lastCleaned = now;
      task.cleanHistory = task.cleanHistory || [];
      task.cleanHistory.push(now);
    } else {
      check.classList.remove('checked');
      card.classList.remove('done');
      task.lastCleaned = null;
      if (task.cleanHistory && task.cleanHistory.length > 0) {
        const lastIso = task.cleanHistory[task.cleanHistory.length - 1];
        if (new Date(lastIso).toDateString() === new Date().toDateString()) {
          task.cleanHistory.pop();
        }
      }
    }
    saveState();
  }

  // ── Most Urgent mode ─────────────────────────────
  function runUrgent() {
    resultsEl.innerHTML = '';

    if (state.tasks.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🏠</div><p>No tasks yet!<br>Go to Layout → Tasks to add cleaning tasks.</p></div>';
      return;
    }

    const scored = state.tasks.map(task => ({
      task,
      urgency: daysSince(task.lastCleaned) / task.intervalDays,
    }))
    .filter(({ urgency }) => urgency >= 0.5)
    .sort((a, b) => b.urgency - a.urgency);

    if (scored.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><p>Everything is freshly cleaned!<br>Nothing needs attention right now.</p></div>';
      return;
    }

    // Header pill
    const header = document.createElement('div');
    header.id = 'clean-summary';
    const overdueCount = scored.filter(s => s.urgency >= 1).length;
    const dueSoonCount = scored.length - overdueCount;
    header.innerHTML = `
      <span><strong>${scored.length}</strong> task${scored.length !== 1 ? 's' : ''} need attention</span>
      <span>${overdueCount > 0 ? `<span style="color:#e5372b;font-weight:700">${overdueCount} overdue</span>` : `<span style="color:#d97706;font-weight:700">${dueSoonCount} due soon</span>`}</span>`;
    resultsEl.appendChild(header);

    scored.forEach(({ task, urgency }) => {
      const room = state.rooms.find(r => r.id === task.roomId);
      const card = document.createElement('div');
      card.className = 'clean-task-card' + (urgency >= 1 ? ' urgent-card' : '');
      card.dataset.taskId = task.id;

      // Urgency strip
      const strip = document.createElement('div');
      strip.className = 'urgency-strip';
      strip.style.background = urgency >= 1 ? '#ff453a' : urgency >= 0.75 ? '#ffd60a' : '#30d158';
      card.appendChild(strip);

      const check = document.createElement('div');
      check.className = 'task-check';
      check.addEventListener('click', e => {
        e.stopPropagation();
        toggleDone(task.id, card, check);
        // Re-run urgent after short delay to re-sort
        setTimeout(runUrgent, 600);
      });

      const info = document.createElement('div');
      info.className = 'clean-task-info';

      const daysOverdue = Math.round(daysSince(task.lastCleaned) - task.intervalDays);
      const urgencyStr = urgency >= 1
        ? `🔴 Overdue by ${daysOverdue > 0 ? daysOverdue + 'd' : 'today'}`
        : urgency >= 0.75 ? '🟡 Due soon'
        : '🟢 Scheduled';

      info.innerHTML = `
        <div class="clean-task-name">${escHtml(task.name)}</div>
        <div class="clean-task-sub">${room ? room.label : 'Unknown room'} · ${urgencyStr}</div>`;

      const dur = document.createElement('div');
      dur.className = 'clean-task-duration';
      dur.textContent = formatTime(task.durationMins);

      card.appendChild(check);
      card.appendChild(info);
      card.appendChild(dur);
      resultsEl.appendChild(card);
    });
  }

  return { init };
})();

// ─────────────────────────────────────────────────────────────
// 7. Progress Tab
// ─────────────────────────────────────────────────────────────

const progressTab = (() => {
  const CIRCUMFERENCE = 2 * Math.PI * 50; // r=50 → 314.16

  const MESSAGES = [
    { min: 0,  max: 20,  emoji: '😅', text: 'Lots to do! Every task crossed off counts.' },
    { min: 20, max: 40,  emoji: '💪', text: 'Getting started — keep the momentum going!' },
    { min: 40, max: 60,  emoji: '🚀', text: 'Almost halfway there — great progress!' },
    { min: 60, max: 80,  emoji: '✨', text: 'Looking good! Your home is in great shape.' },
    { min: 80, max: 95,  emoji: '🌟', text: 'Nearly spotless — you\'re crushing it!' },
    { min: 95, max: 101, emoji: '🏆', text: 'Perfect! Everything is fresh and clean!' },
  ];

  function init() { /* Nothing to bind — renders on tab switch */ }

  function render() {
    if (state.tasks.length === 0) {
      document.getElementById('progress-pct').textContent = '—';
      document.getElementById('progress-ring-sub').textContent = 'no tasks';
      document.getElementById('progress-motivation').textContent = 'Add tasks in the Tasks tab to start tracking progress.';
      document.getElementById('progress-stats-row').innerHTML = '';
      document.getElementById('progress-rooms').innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><p>No tasks yet.<br>Create tasks in the Tasks tab to see your progress.</p></div>';
      setRing(0, '#6c63ff');
      return;
    }

    // Compute global status counts
    const counts = { clean: 0, soon: 0, overdue: 0, never: 0 };
    state.tasks.forEach(task => {
      if (!task.lastCleaned) { counts.never++; return; }
      const ratio = daysSince(task.lastCleaned) / task.intervalDays;
      if (ratio >= 1)    counts.overdue++;
      else if (ratio >= 0.5) counts.soon++;
      else               counts.clean++;
    });

    const onTrack = counts.clean + counts.soon;
    const pct = Math.round((onTrack / state.tasks.length) * 100);

    // Ring colour: red → amber → green
    const ringColor = pct >= 80 ? '#30d158' : pct >= 50 ? '#ffd60a' : '#ff453a';

    // Update ring
    setRing(pct, ringColor);
    document.getElementById('progress-pct').textContent = pct + '%';
    document.getElementById('progress-ring-sub').style.color = ringColor;

    // Motivation message
    const msg = MESSAGES.find(m => pct >= m.min && pct < m.max) || MESSAGES[MESSAGES.length - 1];
    document.getElementById('progress-motivation').textContent = msg.emoji + ' ' + msg.text;

    // Stat pills
    const statsEl = document.getElementById('progress-stats-row');
    statsEl.innerHTML = '';
    const pills = [
      { cls: 'green', label: `✅ ${counts.clean} clean` },
      { cls: 'amber', label: `⏳ ${counts.soon} due soon` },
      { cls: 'red',   label: `🔴 ${counts.overdue} overdue` },
    ];
    if (counts.never > 0) pills.push({ cls: 'grey', label: `❓ ${counts.never} never cleaned` });
    pills.forEach(({ cls, label }) => {
      const p = document.createElement('div');
      p.className = 'stat-pill ' + cls;
      p.textContent = label;
      statsEl.appendChild(p);
    });

    renderHeatmap();
    renderRooms();
  }

  function renderHeatmap() {
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Aggregate cleanHistory over the last 91 days.
    const counts = {};
    const today = new Date();
    today.setHours(0,0,0,0);

    state.tasks.forEach(task => {
      if (!task.cleanHistory) return;
      task.cleanHistory.forEach(iso => {
        const d = new Date(iso);
        d.setHours(0,0,0,0);
        const diff = Math.floor((today - d) / 86400000);
        if (diff >= 0 && diff < 91) counts[diff] = (counts[diff] || 0) + 1;
      });
    });

    // Build days array oldest → newest (index 0 = 90 days ago)
    const days = [];
    for (let i = 90; i >= 0; i--) {
      const date = new Date(today.getTime() - i * 86400000);
      days.push({ diff: i, count: counts[i] || 0, date });
    }

    // Pad the start so first cell aligns to Sunday column
    const startDow = days[0].date.getDay(); // 0=Sun
    const padded = [...Array(startDow).fill(null), ...days];

    // pad tail to full weeks
    while (padded.length % 7 !== 0) padded.push(null);

    // Group into weeks (each sub-array is 7 days: Sun→Sat)
    const weeks = [];
    for (let i = 0; i < padded.length; i += 7) {
      weeks.push(padded.slice(i, i + 7));
    }

    // Build month labels: one label per week-column when month changes
    const monthLabels = [];
    let lastMonth = -1;
    weeks.forEach(week => {
      const firstReal = week.find(d => d !== null);
      if (firstReal && firstReal.date.getMonth() !== lastMonth) {
        lastMonth = firstReal.date.getMonth();
        monthLabels.push({ text: MONTHS[lastMonth] });
      } else {
        monthLabels.push({ text: '' });
      }
    });

    // ── Render outer container ──────────────────────
    const outer = document.getElementById('heatmap-outer');
    outer.innerHTML = '';

    // Day labels column
    const dayLabels = document.createElement('div');
    dayLabels.id = 'heatmap-day-labels';
    DAYS.forEach((d, i) => {
      const lbl = document.createElement('div');
      lbl.className = 'heatmap-day-label' + (i % 2 === 0 ? '' : ' hidden');
      lbl.textContent = d;
      dayLabels.appendChild(lbl);
    });
    outer.appendChild(dayLabels);

    // Right side: month labels + grid
    const right = document.createElement('div');
    right.id = 'heatmap-right';

    // Month labels
    const monthRow = document.createElement('div');
    monthRow.id = 'heatmap-month-labels';
    monthLabels.forEach(({ text }) => {
      const lbl = document.createElement('div');
      lbl.className = 'heatmap-month-label';
      lbl.style.width = '16px'; // 12px cell + 4px gap
      lbl.textContent = text;
      monthRow.appendChild(lbl);
    });
    right.appendChild(monthRow);

    // Grid
    const grid = document.createElement('div');
    grid.id = 'activity-heatmap';
    weeks.forEach(week => {
      week.forEach(dayInfo => {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        if (!dayInfo) {
          cell.style.background = 'transparent';
        } else {
          let lvl = 0;
          if (dayInfo.count === 1) lvl = 1;
          else if (dayInfo.count === 2) lvl = 2;
          else if (dayInfo.count >= 3 && dayInfo.count <= 4) lvl = 3;
          else if (dayInfo.count > 4) lvl = 4;
          cell.dataset.level = lvl;
          if (dayInfo.count > 0) {
            cell.title = `${dayInfo.count} task${dayInfo.count > 1 ? 's' : ''} on ${dayInfo.date.toDateString()}`;
          }
        }
        grid.appendChild(cell);
      });
    });
    right.appendChild(grid);
    outer.appendChild(right);

    // Scroll to right-most (today) after paint
    setTimeout(() => { outer.scrollLeft = outer.scrollWidth; }, 0);

    // Legend
    let legend = document.getElementById('heatmap-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'heatmap-legend';
    }
    legend.innerHTML = '';
    document.getElementById('progress-activity').appendChild(legend);

    const less = document.createElement('span'); less.textContent = 'Less';
    legend.appendChild(less);
    [0, 1, 2, 3, 4].forEach(lvl => {
      const c = document.createElement('div');
      c.className = 'legend-cell heatmap-cell';
      c.dataset.level = lvl;
      legend.appendChild(c);
    });
    const more = document.createElement('span'); more.textContent = 'More';
    legend.appendChild(more);
  }

  function setRing(pct, color) {
    const fill = document.getElementById('ring-fill');
    const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
    fill.style.strokeDashoffset = offset;
    fill.style.stroke = color;
  }

  function renderRooms() {
    const el = document.getElementById('progress-rooms');
    el.innerHTML = '';

    state.rooms.forEach(room => {
      const roomTasks = state.tasks.filter(t => t.roomId === room.id);
      if (roomTasks.length === 0) return;

      let cleanCount = 0;
      roomTasks.forEach(task => {
        if (!task.lastCleaned) return;
        const ratio = daysSince(task.lastCleaned) / task.intervalDays;
        if (ratio < 0.5) cleanCount++;
      });
      const roomPct = Math.round((cleanCount / roomTasks.length) * 100);
      const barColor = roomPct >= 80 ? '#30d158' : roomPct >= 50 ? '#ffd60a' : '#ff453a';

      const card = document.createElement('div');
      card.className = 'room-progress-card';

      card.innerHTML = `
        <div class="room-progress-top">
          <div class="room-progress-dot" style="background:${room.color}"></div>
          <div class="room-progress-name">${escHtml(room.label)}</div>
          <div class="room-progress-pct" style="color:${barColor}">${roomPct}%</div>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="background:${barColor};width:0%" data-target="${roomPct}"></div>
        </div>
        <div class="room-progress-tasks">${buildTaskDots(roomTasks)}</div>`;

      el.appendChild(card);
    });

    // Animate bars after paint
    requestAnimationFrame(() => {
      el.querySelectorAll('.progress-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.target + '%';
      });
    });
  }

  function buildTaskDots(tasks) {
    return tasks.map(task => {
      let color = '#4a5270'; // never
      if (task.lastCleaned) {
        const ratio = daysSince(task.lastCleaned) / task.intervalDays;
        color = ratio >= 1 ? '#ff453a' : ratio >= 0.5 ? '#ffd60a' : '#30d158';
      }
      return `<div class="task-status-dot" style="background:${color}" title="${escHtml(task.name)}: ${statusText(task)}"></div>`;
    }).join('');
  }

  function statusText(task) {
    if (!task.lastCleaned) return 'Never cleaned';
    const ratio = daysSince(task.lastCleaned) / task.intervalDays;
    const daysLeft = Math.round(task.intervalDays - daysSince(task.lastCleaned));

    if (daysLeft < 0) return `Overdue by ${Math.abs(daysLeft)}d`;
    if (daysLeft === 0) return 'Due today';
    if (ratio >= 0.5) return `Due in ${daysLeft}d`;
    return `Clean (due in ${daysLeft}d)`;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init, render };
})();

// ─────────────────────────────────────────────────────────────
// 7. Router / Boot
// ─────────────────────────────────────────────────────────────

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('view-' + viewName).classList.add('active');
  document.getElementById('nav-' + viewName).classList.add('active');

  if (viewName === 'tasks')    taskManager.refresh();
  if (viewName === 'progress') progressTab.render();
  if (viewName === 'layout') {
    layoutEditor.renderAll();
    layoutEditor.renderChips();
  }
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ── Photo Lightbox (double-tap to zoom) ──────────────────────────
function openPhotoLightbox(src) {
  const img = document.getElementById('modal-photo-img');
  img.src = src;
  img.style.transform = '';
  img.classList.remove('zoomed');
  document.getElementById('modal-photo').style.display = '';
}

function initPhotoLightbox() {
  const modal = document.getElementById('modal-photo');
  const img   = document.getElementById('modal-photo-img');
  const closeIt = () => {
    modal.style.display = 'none';
    img.style.transform = '';
    img.classList.remove('zoomed');
  };
  document.getElementById('modal-photo-close').addEventListener('click', closeIt);
  modal.addEventListener('click', e => { if (e.target === modal) closeIt(); });
  // Double-tap zoom toggle
  let lastTap = 0;
  img.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 320) {
      const zoomed = img.classList.toggle('zoomed');
      img.style.transform = zoomed ? 'scale(2.2)' : '';
    }
    lastTap = now;
  });
}

// ── Live Countdown Timer ──────────────────────────────────────────
let liveTimer;
function startLiveTimer() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    const activeView = document.querySelector('.view.active').id;
    if (activeView === 'view-tasks') taskManager.refresh();
    else if (activeView === 'view-progress') progressTab.render();
  }, 60000);
}

// ─────────────────────────────────────────────────────────────────
// Firebase Auth, House & Sharing
// ─────────────────────────────────────────────────────────────────

// ── Multi-house resolver: gets ALL houses the user belongs to.
// Returns array of { id, name, ownerId, members, ... }. Always at least 1.
async function resolveHouses(user) {
  // Always query houses by member — this is the source of truth and works
  // even if userMeta is stale or the user was just added to a new house.
  let houses = [];
  try {
    const snap = await db.collection('houses')
      .where('members', 'array-contains', user.uid).get();
    houses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('House query failed:', e.message);
  }

  // Brand new user — no houses at all. Create one and migrate localStorage.
  if (houses.length === 0) {
    const rooms = JSON.parse(localStorage.getItem(STORAGE_ROOMS) || '[]');
    const tasks = JSON.parse(localStorage.getItem(STORAGE_TASKS) || '[]');
    const houseRef = db.collection('houses').doc();
    const payload = {
      ownerId: user.uid,
      members: [user.uid],
      name: 'My House',
      rooms,
      tasks,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await houseRef.set(payload);
    houses = [{ id: houseRef.id, ...payload }];
  }

  // Backfill missing names for legacy houses (no write — purely display)
  houses.forEach(h => { if (!h.name) h.name = h.ownerId === user.uid ? 'My House' : 'Shared House'; });
  // Sort: owned houses first, then by name
  houses.sort((a, b) => {
    const aOwn = a.ownerId === user.uid ? 0 : 1;
    const bOwn = b.ownerId === user.uid ? 0 : 1;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return (a.name || '').localeCompare(b.name || '');
  });
  return houses;
}

// ── Pick which house to load right now.
// Honors the user's saved active choice. Falls back to legacy houseId,
// then to the first owned house, then any house.
async function pickActiveHouse(user, houses) {
  let saved = null;
  try {
    const meta = await db.collection('userMeta').doc(user.uid).get();
    if (meta.exists) {
      const d = meta.data();
      saved = d.activeHouseId || d.houseId || null;  // legacy fallback
    }
  } catch (e) { /* permissions may not allow this — fine */ }

  if (saved && houses.some(h => h.id === saved)) return saved;
  const owned = houses.find(h => h.ownerId === user.uid);
  return (owned || houses[0]).id;
}

// ── Detect newly-shared houses since last visit; show a toast for each.
async function detectAndAnnounceNewHouses(user, houses) {
  const userMetaRef = db.collection('userMeta').doc(user.uid);
  let known = null;
  try {
    const meta = await userMetaRef.get();
    if (meta.exists) known = meta.data().knownHouseIds || null;
  } catch (e) { /* ignore */ }

  const currentIds = houses.map(h => h.id);

  // First time we've ever tracked this user — just record, no toast.
  if (!Array.isArray(known)) {
    await userMetaRef.set({ knownHouseIds: currentIds }, { merge: true }).catch(() => {});
    return;
  }

  const newOnes = houses.filter(h => !known.includes(h.id) && h.ownerId !== user.uid);
  if (newOnes.length) {
    newOnes.forEach(h => showToast(`🏠 You've been added to "${h.name}". Open the menu to switch.`, 7000));
  }
  // Update knownHouseIds even if no new ones (so removed houses get pruned)
  if (newOnes.length || known.length !== currentIds.length) {
    await userMetaRef.set({ knownHouseIds: currentIds }, { merge: true }).catch(() => {});
  }
}

// ── Switch the active house. Saves choice, swaps the live listener.
async function switchToHouse(houseId) {
  if (!houseId || houseId === currentHouseId) return;
  if (!userHouses.some(h => h.id === houseId)) {
    console.warn('switchToHouse: not a member of', houseId);
    return;
  }
  // Tear down old listener and clear state
  if (_unsubSnapshot) { _unsubSnapshot(); _unsubSnapshot = null; }
  currentHouseId = houseId;
  state.rooms = []; state.tasks = [];
  // Persist active choice
  try {
    await db.collection('userMeta').doc(currentUser.uid)
      .set({ activeHouseId: houseId }, { merge: true });
  } catch (e) { /* non-fatal */ }
  // Bring up the new listener — it will populate state and re-render
  subscribeToHouse();
  updateShareLeaveVisibility();
  renderHouseSwitcher();
  setSyncStatus('saving');
}

// ── Real-time listener: keeps state in sync across all devices.
function subscribeToHouse() {
  if (_unsubSnapshot) _unsubSnapshot(); // cancel any previous listener
  _unsubSnapshot = db.collection('houses').doc(currentHouseId)
    .onSnapshot(doc => {
      if (!doc.exists) return;
      const d = doc.data();
      state.rooms = d.rooms || [];
      state.tasks = d.tasks || [];
      // Keep userHouses entry fresh (name, members) so the switcher reflects changes
      const idx = userHouses.findIndex(h => h.id === currentHouseId);
      if (idx >= 0) {
        userHouses[idx] = { id: currentHouseId, ...d };
        renderHouseSwitcher();
      }
      // Persist locally as backup
      try {
        localStorage.setItem(STORAGE_ROOMS, JSON.stringify(state.rooms));
        localStorage.setItem(STORAGE_TASKS, JSON.stringify(state.tasks));
      } catch(e) {}
      setSyncStatus('synced');
      // Refresh all views
      layoutEditor.renderAll();
      layoutEditor.renderChips();
      taskManager.refresh();
      const activeView = document.querySelector('.view.active');
      if (activeView && activeView.id === 'view-progress') progressTab.render();
      if (activeView && activeView.id === 'view-clean') cleanNow.render();
    }, err => {
      console.warn('Firestore snapshot error:', err);
      setSyncStatus('offline');
    });
}

async function handleAuthState(user) {
  const loginEl   = document.getElementById('login-screen');
  const loadingEl = document.getElementById('loading-overlay');

  // Cancel any previous real-time listener
  if (_unsubSnapshot) { _unsubSnapshot(); _unsubSnapshot = null; }

  if (user) {
    currentUser = user;
    try {
      // Save/update profile for invite-by-email lookup
      await db.collection('userProfiles').doc(user.uid).set({
        email: (user.email || '').toLowerCase(),
        displayName: user.displayName || '',
      }, { merge: true });

      // Resolve ALL houses (own + any shared), pick which is active
      userHouses = await resolveHouses(user);
      currentHouseId = await pickActiveHouse(user, userHouses);

      // Persist the active choice (also writes knownHouseIds first-run baseline)
      await db.collection('userMeta').doc(user.uid)
        .set({ activeHouseId: currentHouseId }, { merge: true }).catch(() => {});

      // Tell the user about any new shared houses they got added to
      await detectAndAnnounceNewHouses(user, userHouses);

      // Start the real-time listener — it will populate state and render
      subscribeToHouse();

      // Migrate any legacy base64 photos to Firebase Storage (runs once, in background)
      setTimeout(() => migrateBase64Photos(), 2000);

    } catch (e) {
      console.warn('Firestore setup failed, falling back to localStorage:', e);
      loadStateLocal();
      setSyncStatus('offline');
      layoutEditor.renderAll();
      layoutEditor.renderChips();
      taskManager.refresh();
    }

    updateUserUI(user);
    renderHouseSwitcher();
    loginEl.classList.add('hidden');
    loadingEl.classList.add('hidden');
  } else {
    currentUser = null; currentHouseId = null; userHouses = [];
    setSyncStatus('offline');
    loginEl.classList.remove('hidden');
    loadingEl.classList.add('hidden');
  }
}

function updateUserUI(user) {
  const initStr = (user.displayName || user.email || '?')
    .split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('user-avatar-initials').textContent = initStr;
  document.getElementById('user-name-short').textContent =
    (user.displayName || user.email || '').split(' ')[0];
  document.getElementById('btn-user-menu').classList.add('visible');
  document.getElementById('dropdown-name').textContent  = user.displayName || '';
  document.getElementById('dropdown-email').textContent = user.email || '';
  // Show/hide Share vs Leave House based on whether this user is the owner
  updateShareLeaveVisibility();
}

function updateShareLeaveVisibility() {
  // We need the house doc to know if user is owner, but we can cache it
  // For now use a quick Firestore read and update the dropdown
  if (!currentHouseId || !currentUser) return;
  db.collection('houses').doc(currentHouseId).get().then(doc => {
    if (!doc.exists) return;
    const isOwner = doc.data().ownerId === currentUser.uid;
    const shareBtn = document.getElementById('btn-share-house');
    const leaveBtn = document.getElementById('btn-leave-house');
    if (shareBtn) shareBtn.style.display = isOwner ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = isOwner ? 'none' : '';
  }).catch(() => {});
}

function initAuthUI() {
  document.getElementById('btn-google-signin').addEventListener('click', async () => {
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch(e) { showAlert('Sign-in failed: ' + (e.message || 'Unknown error')); }
  });

  const menuBtn  = document.getElementById('btn-user-menu');
  const dropdown = document.getElementById('user-dropdown');
  menuBtn.addEventListener('click', e => { e.stopPropagation(); dropdown.classList.toggle('hidden'); });
  document.addEventListener('click', () => dropdown.classList.add('hidden'));

  document.getElementById('btn-sign-out').addEventListener('click', () => {
    dropdown.classList.add('hidden');
    auth.signOut();
  });

  document.getElementById('btn-leave-house').addEventListener('click', async () => {
    dropdown.classList.add('hidden');
    if (!confirm('Are you sure you want to leave this house? You will lose access to all shared data.')) return;
    await leaveHouse();
  });

  document.getElementById('btn-share-house').addEventListener('click', () => {
    dropdown.classList.add('hidden');
    openShareModal();
  });
  document.getElementById('btn-share-cancel').addEventListener('click', () => {
    document.getElementById('modal-share').style.display = 'none';
  });
  document.getElementById('btn-share-invite').addEventListener('click', async () => {
    const email = document.getElementById('share-email-input').value.trim();
    if (!email) { showAlert('Please enter an email address.'); return; }
    const btn = document.getElementById('btn-share-invite');
    btn.textContent = 'Inviting…';
    await shareHouseWithEmail(email);
    btn.textContent = 'Invite';
    document.getElementById('share-email-input').value = '';
    loadShareMembers();
  });
}

async function openShareModal() {
  document.getElementById('modal-share').style.display = '';
  document.getElementById('share-email-input').value = '';
  await loadShareMembers();
}

async function loadShareMembers() {
  const el = document.getElementById('share-members-list');
  el.innerHTML = '<span style="color:var(--text3);font-size:12px">Loading members…</span>';
  const houseDoc = await db.collection('houses').doc(currentHouseId).get();
  const house    = houseDoc.data();
  const members  = house.members || [];
  el.innerHTML = '<div style="font-size:11px;font-weight:700;color:var(--text2);margin:10px 0 6px;text-transform:uppercase;letter-spacing:.5px">Members</div>';
  for (const uid of members) {
    const pDoc    = await db.collection('userProfiles').doc(uid).get();
    const profile = pDoc.exists ? pDoc.data() : {};
    const initials = (profile.displayName || profile.email || '?')
      .split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const row = document.createElement('div');
    row.className = 'share-member-row';
    const isOwner = uid === house.ownerId;
    const isCurrentUser = uid === currentUser.uid;
    // Show remove button for members (non-owner) if current user is owner,
    // or a Leave button if this row is the current (non-owner) user
    let actionHtml = `<span class="share-member-badge">${isOwner ? 'Owner' : 'Member'}</span>`;
    if (!isOwner && isCurrentUser) {
      // Current user is a non-owner member — show Leave button
      actionHtml = `<button class="share-member-leave-btn" data-uid="${uid}">Leave</button>`;
    } else if (!isOwner && house.ownerId === currentUser.uid) {
      // Current user is the owner — show Remove button for other members
      actionHtml = `<span class="share-member-badge">Member</span>
        <button class="share-member-remove-btn" data-uid="${uid}" title="Remove member">✕</button>`;
    }
    row.innerHTML = `
      <div class="share-member-avatar">${initials}</div>
      <div class="share-member-info">
        <div class="share-member-name">${profile.displayName || 'Unknown'}</div>
        <div class="share-member-email">${profile.email || uid}</div>
      </div>
      ${actionHtml}`;
    el.appendChild(row);
  }
  // Bind Leave buttons
  el.querySelectorAll('.share-member-leave-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to leave this house? You will lose access to all shared data.')) return;
      btn.textContent = 'Leaving…';
      btn.disabled = true;
      await leaveHouse();
    });
  });
  // Bind Remove buttons (owner removing a member)
  el.querySelectorAll('.share-member-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetUid = btn.dataset.uid;
      if (!confirm('Remove this member from the house?')) return;
      btn.textContent = '…';
      btn.disabled = true;
      await db.collection('houses').doc(currentHouseId).update({
        members: firebase.firestore.FieldValue.arrayRemove(targetUid),
      });
      // Remove userMeta pointer for the removed user (best-effort)
      await db.collection('userMeta').doc(targetUid).delete().catch(() => {});
      await loadShareMembers();
    });
  });
}

async function leaveHouse() {
  const houseToLeave = currentHouseId;
  try {
    // Remove this user from the house members list
    await db.collection('houses').doc(houseToLeave).update({
      members: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
    });
  } catch (e) {
    console.warn('leaveHouse error:', e);
    showAlert('Could not leave the house. Please try again.');
    return;
  }

  // Drop the listener and clear state
  if (_unsubSnapshot) { _unsubSnapshot(); _unsubSnapshot = null; }
  state.rooms = []; state.tasks = [];
  userHouses = userHouses.filter(h => h.id !== houseToLeave);

  document.getElementById('modal-share').style.display = 'none';

  // Switch to another existing house if any, else create a fresh one
  if (userHouses.length > 0) {
    const next = userHouses.find(h => h.ownerId === currentUser.uid) || userHouses[0];
    currentHouseId = null;  // force switchToHouse to actually swap
    await switchToHouse(next.id);
    showToast(`Left the house. Switched to "${next.name}".`);
  } else {
    currentHouseId = null;
    localStorage.removeItem(STORAGE_ROOMS);
    localStorage.removeItem(STORAGE_TASKS);
    try {
      userHouses = await resolveHouses(currentUser);  // creates a fresh one
      currentHouseId = userHouses[0].id;
      await db.collection('userMeta').doc(currentUser.uid)
        .set({ activeHouseId: currentHouseId }, { merge: true }).catch(() => {});
      subscribeToHouse();
      renderHouseSwitcher();
      showAlert('You have left the house. A new personal house has been created for you.');
    } catch (e) {
      console.warn('Post-leave house setup failed:', e);
      showAlert('You have left the house. Please reload the app.');
    }
  }
}

async function shareHouseWithEmail(email) {
  const normalized = email.trim().toLowerCase();
  const snap = await db.collection('userProfiles')
    .where('email', '==', normalized).limit(1).get();
  if (snap.empty) {
    showAlert(`No CleanHome account found for "${email}".\nThey must sign in to CleanHome first.`);
    return;
  }
  const targetUid = snap.docs[0].id;
  if (targetUid === currentUser.uid) { showAlert("That's your own account!"); return; }
  await db.collection('houses').doc(currentHouseId).update({
    members: firebase.firestore.FieldValue.arrayUnion(targetUid),
  });
  // Refresh local copy of members so the modal stays accurate
  const fresh = await db.collection('houses').doc(currentHouseId).get();
  const idx = userHouses.findIndex(h => h.id === currentHouseId);
  if (idx >= 0 && fresh.exists) userHouses[idx] = { id: currentHouseId, ...fresh.data() };
  showAlert(`✅ House shared with ${email}!\nThey'll see it the next time they open CleanHome.`);
}

// ─────────────────────────────────────────────────────────────────
// House Switcher UI (rendered into the user dropdown)
// ─────────────────────────────────────────────────────────────────
function renderHouseSwitcher() {
  const container = document.getElementById('house-switcher');
  if (!container) return;
  if (!userHouses || userHouses.length === 0) { container.innerHTML = ''; return; }

  // Hide the section entirely if user only has 1 house and wants to rename — still useful
  // We always show it; with 1 house it shows the current name + a rename pencil.
  const rows = userHouses.map(h => {
    const isActive = h.id === currentHouseId;
    const isOwner  = h.ownerId === currentUser.uid;
    const memberCount = (h.members || []).length;
    return `
      <button class="house-switch-row ${isActive ? 'active' : ''}" data-id="${h.id}">
        <span class="house-switch-check">${isActive ? '●' : '○'}</span>
        <span class="house-switch-info">
          <span class="house-switch-name">${escapeHtml(h.name || 'House')}</span>
          <span class="house-switch-sub">${isOwner ? 'Owner' : 'Member'} · ${memberCount} ${memberCount === 1 ? 'person' : 'people'}</span>
        </span>
        ${isOwner ? `<span class="house-switch-rename" data-id="${h.id}" title="Rename">✎</span>` : ''}
      </button>
    `;
  }).join('');

  container.innerHTML = `
    <div class="house-switcher-label">${userHouses.length > 1 ? 'Switch House' : 'Your House'}</div>
    ${rows}
  `;

  // Wire up clicks
  container.querySelectorAll('.house-switch-row').forEach(row => {
    row.addEventListener('click', async e => {
      // If the click was on the rename pencil, handle that instead
      if (e.target.classList.contains('house-switch-rename')) {
        e.stopPropagation();
        promptRenameHouse(e.target.dataset.id);
        return;
      }
      const id = row.dataset.id;
      document.getElementById('user-dropdown').classList.add('hidden');
      if (id !== currentHouseId) {
        await switchToHouse(id);
        const h = userHouses.find(x => x.id === id);
        if (h) showToast(`Switched to "${h.name}"`);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

async function promptRenameHouse(houseId) {
  const h = userHouses.find(x => x.id === houseId);
  if (!h) return;
  const newName = prompt('Rename house', h.name || 'My House');
  if (newName === null) return;
  const trimmed = newName.trim().slice(0, 40);
  if (!trimmed || trimmed === h.name) return;
  try {
    await db.collection('houses').doc(houseId).update({ name: trimmed });
    h.name = trimmed;
    renderHouseSwitcher();
    showToast('House renamed');
  } catch (e) {
    showAlert('Could not rename: ' + (e.message || 'permission denied'));
  }
}

// ─────────────────────────────────────────────────────────────────
// Toast notifications
// ─────────────────────────────────────────────────────────────────
function showToast(message, duration = 3500) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host.appendChild(el);
  // animate in
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ─────────────────────────────────────────────────────────────────
// Telegram linking
// ─────────────────────────────────────────────────────────────────
// Bot username — UPDATE this to your bot once you create it via @BotFather.
const TELEGRAM_BOT_USERNAME = 'CleanHomeRemindersBot';

async function openTelegramModal() {
  const modal = document.getElementById('modal-telegram');
  modal.style.display = '';
  document.getElementById('telegram-code-input').value = '';
  await refreshTelegramStatus();
}

async function refreshTelegramStatus() {
  const statusEl  = document.getElementById('telegram-status');
  const connectEl = document.getElementById('telegram-connect-section');
  const linkedEl  = document.getElementById('telegram-linked-section');
  const botLink   = document.getElementById('telegram-bot-link');
  botLink.href = `https://t.me/${TELEGRAM_BOT_USERNAME}`;
  botLink.textContent = `@${TELEGRAM_BOT_USERNAME}`;

  try {
    const doc = await db.collection('userMeta').doc(currentUser.uid).get();
    const tg = doc.exists ? doc.data().telegram : null;
    if (tg && tg.chatId) {
      statusEl.innerHTML = `<span style="color:var(--green)">●</span> Connected${tg.username ? ' as @' + escapeHtml(tg.username) : ''}`;
      connectEl.style.display = 'none';
      linkedEl.style.display  = '';
    } else {
      statusEl.innerHTML = `<span style="color:var(--text3)">○</span> Not connected`;
      connectEl.style.display = '';
      linkedEl.style.display  = 'none';
    }
  } catch (e) {
    statusEl.textContent = 'Could not check status.';
  }
}

async function linkTelegram(code) {
  const cleaned = (code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{6}$/.test(cleaned)) {
    showAlert('That code doesn\'t look right. Codes are 6 characters (letters + numbers).');
    return;
  }
  const btn = document.getElementById('btn-telegram-link');
  btn.disabled = true; btn.textContent = 'Linking…';
  try {
    // Look up the pending code doc — bot writes these into `telegramCodes/{code}`
    const codeRef = db.collection('telegramCodes').doc(cleaned);
    const snap = await codeRef.get();
    if (!snap.exists) {
      showAlert('Code not found. Make sure you sent /start to the bot first, and try again with the latest code.');
      return;
    }
    const data = snap.data();
    const expiresAt = data.expiresAt && data.expiresAt.toMillis ? data.expiresAt.toMillis() : 0;
    if (expiresAt && expiresAt < Date.now()) {
      showAlert('That code has expired. Send /start to the bot again to get a fresh code.');
      return;
    }
    // Save the link onto userMeta
    await db.collection('userMeta').doc(currentUser.uid).set({
      telegram: {
        chatId: data.chatId,
        username: data.username || null,
        linkedAt: firebase.firestore.FieldValue.serverTimestamp(),
      },
    }, { merge: true });
    // Best-effort: delete the consumed code (Cloud Function also TTLs it)
    codeRef.delete().catch(() => {});
    showToast('✅ Telegram connected');
    refreshTelegramStatus();
  } catch (e) {
    console.warn('linkTelegram failed', e);
    showAlert('Linking failed: ' + (e.message || 'please try again'));
  } finally {
    btn.disabled = false; btn.textContent = 'Link';
  }
}

async function unlinkTelegram() {
  if (!confirm('Disconnect Telegram? You will stop receiving reminders.')) return;
  try {
    await db.collection('userMeta').doc(currentUser.uid).set({
      telegram: firebase.firestore.FieldValue.delete(),
    }, { merge: true });
    showToast('Telegram disconnected');
    refreshTelegramStatus();
  } catch (e) {
    showAlert('Disconnect failed: ' + (e.message || 'try again'));
  }
}

function initTelegramUI() {
  const openBtn = document.getElementById('btn-telegram');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      document.getElementById('user-dropdown').classList.add('hidden');
      openTelegramModal();
    });
  }
  document.getElementById('btn-telegram-close').addEventListener('click', () => {
    document.getElementById('modal-telegram').style.display = 'none';
  });
  document.getElementById('btn-telegram-link').addEventListener('click', () => {
    const code = document.getElementById('telegram-code-input').value;
    linkTelegram(code);
  });
  document.getElementById('btn-telegram-unlink').addEventListener('click', unlinkTelegram);
}


function boot() {
  layoutEditor.init();
  taskManager.init();
  cleanNow.init();
  progressTab.init();
  initPhotoLightbox();
  initAuthUI();
  initTelegramUI();
  startLiveTimer();
  // Auth gates the app — shows loading until user status is known
  auth.onAuthStateChanged(user => handleAuthState(user));
}

document.addEventListener('DOMContentLoaded', boot);

