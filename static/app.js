/* ═══════════════════════════════════════════════════════════════
   PyVault — app.js
   ═══════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────
let state = { project_name: '', folders: [], scripts: [], settings: {} };
let currentScriptId = null;
let currentFolder    = null;   // null = root
let currentFilter    = 'all';  // all | pinned | folder:{id} | trash
let currentView      = 'grid'; // grid | tiles | compact | list
let sortMode         = 'modified';
let ctxTargetId      = null;
let ctxFolderId      = null;
let dirPickerPath    = null;
let moveSel          = null;   // selected folder id in move modal
let logTimer         = null;
let logLastLen       = 0;
let runFinishedShown = false;
let hasUnsavedChanges = false;
let savedProjectSnapshot = null;
let projectFileLabel   = null;
let _projectFileHandle = null;
let _confirmResolver   = null;
let _isWindows         = false;

// ── Folder tree & trash state ────────────────────────────────────
let openTreeNodes = new Set();   // expanded folder IDs in sidebar tree
let trashedScriptIds = new Set();
let trashedFolderIds = new Set();
const TRASH_KEY = 'pyvault-trash';

const COLORS = [
  '#00ff88','#00c8ff','#ff004d','#ffd700','#9d4edd','#ff6b35','#2ec4b6','#e63946','#06d6a0','#f72585',
  '#4cc9f0','#f8961e','#90be6d','#43aa8b','#577590','#f94144','#a8dadc','#e9c46a','#264653','#023e8a',
  '#7b2d8b','#c77dff','#48cae4','#b5e48c','#ff9a3c','#ef233c','#8ecae6','#a2d2ff','#cdb4db','#ffafcc',
];
const SCRIPT_ICONS = [
  '🐍','⚡','🔧','🛠','📊','🤖','🧪','🔍','💡','🚀',
  '🎯','🔑','📡','🧩','🌐','🔐','💾','📈','🗂','⚙',
  '🎮','🧬','🛡','📱','🖥','🗜','🔭','🧮','🪄','🎲',
  '🔥','💎','🌊','🧠','📝','🗃','🔗','🪝','⚗','🎛',
];
const FOLDER_ICONS = [
  '📁','📂','🗂','💼','🗃','📦','🎒','🏷','🧲','🔬',
  '🚀','⚡','🎯','🛠','💡','🔐','🌐','📊','🧪','🎮',
  '🏗','📚','🎨','🔧','💰','🏠','🌿','⭐','🔴','🟣',
]; 
const PY_KEYWORDS = new Set([
  'False','None','True','and','as','assert','async','await','break','class','continue',
  'def','del','elif','else','except','finally','for','from','global','if','import',
  'in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield'
]);
const PY_BUILTINS = new Set([
  'print','len','range','str','int','float','list','dict','set','tuple','bool','type',
  'open','input','enumerate','zip','map','filter','sorted','reversed','sum','min','max',
  'abs','round','isinstance','issubclass','hasattr','getattr','setattr','delattr',
  'super','property','staticmethod','classmethod','Exception','ValueError','TypeError',
  'KeyError','IndexError','RuntimeError','StopIteration','FileNotFoundError','OSError'
]);


// ── Trash management ─────────────────────────────────────────────
function loadTrash() {
  try {
    const data = JSON.parse(localStorage.getItem(TRASH_KEY) || '{}');
    trashedScriptIds = new Set(data.scripts || []);
    trashedFolderIds = new Set(data.folders || []);
  } catch { trashedScriptIds = new Set(); trashedFolderIds = new Set(); }
}

function saveTrash() {
  localStorage.setItem(TRASH_KEY, JSON.stringify({
    scripts: [...trashedScriptIds],
    folders: [...trashedFolderIds],
  }));
}

function getAllSubFolderIds(folderId) {
  const result = [];
  state.folders.filter(f => f.parent_id === folderId).forEach(c => {
    result.push(c.id);
    result.push(...getAllSubFolderIds(c.id));
  });
  return result;
}

function trashScript(id) {
  trashedScriptIds.add(id);
  saveTrash();
  if (currentScriptId === id) closeEditor();
  render();
  touchProject();
  toast('🗑 Скрипт перемещён в корзину');
}

function trashFolder(id) {
  const subIds = getAllSubFolderIds(id);
  [id, ...subIds].forEach(fid => trashedFolderIds.add(fid));
  state.scripts.forEach(s => {
    if ([id, ...subIds].includes(s.folder_id)) trashedScriptIds.add(s.id);
  });
  saveTrash();
  if (currentFolder === id || subIds.includes(currentFolder)) goRoot();
  render();
  touchProject();
  toast('🗑 Папка перемещена в корзину');
}

function restoreFromTrash(type, id) {
  if (type === 'script') {
    trashedScriptIds.delete(id);
    toast('↩ Скрипт восстановлен');
  } else {
    trashedFolderIds.delete(id);
    // Also restore scripts that were exclusively in this folder
    state.scripts.filter(s => s.folder_id === id).forEach(s => {
      trashedScriptIds.delete(s.id);
    });
    toast('↩ Папка восстановлена');
  }
  saveTrash();
  render();
  touchProject();
}

async function permanentlyDeleteScript(id) {
  const s = state.scripts.find(x => x.id === id);
  const ok = await showConfirm({
    title: 'Удалить навсегда?',
    message: `«${s ? s.name : id}» будет удалён безвозвратно.`,
    okText: 'Удалить', danger: true,
  });
  if (!ok) return;
  await api('/api/script/' + id, 'DELETE');
  state.scripts = state.scripts.filter(x => x.id !== id);
  trashedScriptIds.delete(id);
  saveTrash();
  render();
  touchProject();
  toast('Удалено безвозвратно', 'err');
}

async function permanentlyDeleteFolder(id) {
  const f = state.folders.find(x => x.id === id);
  const ok = await showConfirm({
    title: 'Удалить папку навсегда?',
    message: `«${f ? f.name : id}» и её содержимое будут удалены безвозвратно.`,
    okText: 'Удалить', danger: true,
  });
  if (!ok) return;
  const subIds = getAllSubFolderIds(id);
  // Delete scripts in these folders
  for (const fid of [id, ...subIds]) {
    const scripts = state.scripts.filter(s => s.folder_id === fid);
    for (const s of scripts) {
      await api('/api/script/' + s.id, 'DELETE');
      trashedScriptIds.delete(s.id);
    }
    state.scripts = state.scripts.filter(s => s.folder_id !== fid);
    await api('/api/folder/' + fid, 'DELETE');
    state.folders = state.folders.filter(x => x.id !== fid);
    trashedFolderIds.delete(fid);
  }
  saveTrash();
  render();
  touchProject();
  toast('Папка удалена безвозвратно', 'err');
}

async function emptyTrash() {
  const cnt = trashedScriptIds.size + trashedFolderIds.size;
  if (!cnt) { toast('Корзина и так пуста', 'info'); return; }
  const ok = await showConfirm({
    title: 'Очистить корзину?',
    message: `${cnt} элементов будет удалено безвозвратно.`,
    okText: 'Очистить', danger: true,
  });
  if (!ok) return;
  for (const id of [...trashedScriptIds]) {
    await api('/api/script/' + id, 'DELETE');
    state.scripts = state.scripts.filter(x => x.id !== id);
  }
  for (const id of [...trashedFolderIds]) {
    await api('/api/folder/' + id, 'DELETE');
    state.folders = state.folders.filter(x => x.id !== id);
  }
  trashedScriptIds.clear();
  trashedFolderIds.clear();
  saveTrash();
  render();
  touchProject();
  toast('🗑 Корзина очищена');
}

// ── Folder tree helpers ──────────────────────────────────────────
function buildFolderTree(folders) {
  const map = new Map();
  const visible = folders.filter(f => !trashedFolderIds.has(f.id));
  visible.forEach(f => map.set(f.id, { ...f, children: [] }));
  const roots = [];
  visible.forEach(f => {
    if (f.parent_id && map.has(f.parent_id)) {
      map.get(f.parent_id).children.push(map.get(f.id));
    } else {
      roots.push(map.get(f.id));
    }
  });
  return roots;
}

function renderFolderTreeNode(node, depth) {
  const cnt = state.scripts.filter(s => s.folder_id === node.id && !trashedScriptIds.has(s.id)).length;
  const hasChildren = node.children.length > 0;
  const isExpanded = openTreeNodes.has(node.id);
  const isActive = currentFilter === 'folder:' + node.id;
  const pl = 12 + depth * 14;
  const toggleHtml = hasChildren
    ? `<span class="tree-toggle" onclick="event.stopPropagation();toggleTreeNode('${node.id}')">${isExpanded ? '▾' : '▸'}</span>`
    : `<span class="tree-toggle invisible"></span>`;

  return `<div class="tree-node">
    <div class="nav-item tree-item${isActive ? ' active' : ''}"
      style="padding-left:${pl}px"
      data-filter="folder:${node.id}"
      onclick="setFilter('folder:${node.id}',this)"
      oncontextmenu="folderCtx(event,'${node.id}')">
      ${toggleHtml}
      <span class="folder-dot" style="background:${node.color}"></span>
      <span class="folder-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${node.icon} ${esc(node.name)}</span>
      <span class="nav-count">${cnt}</span>
    </div>
    ${hasChildren && isExpanded ? `<div class="tree-children">${node.children.map(c => renderFolderTreeNode(c, depth + 1)).join('')}</div>` : ''}
  </div>`;
}

function toggleTreeNode(id) {
  if (openTreeNodes.has(id)) openTreeNodes.delete(id);
  else openTreeNodes.add(id);
  renderSidebar();
}

function getFolderPath(folderId) {
  const path = [];
  let id = folderId;
  const visited = new Set();
  while (id && !visited.has(id)) {
    visited.add(id);
    const f = state.folders.find(x => x.id === id);
    if (!f) break;
    path.unshift(f);
    id = f.parent_id || null;
  }
  return path;
}

// ── Project snapshot / dirty vs .pyvault file ────────────────────
function normalizeProjectForSnapshot(data) {
  const scripts = (data.scripts || []).map(s => ({
    id: s.id,
    name: s.name,
    code: s.code || '',
    folder_id: s.folder_id || null,
    tags: [...(s.tags || [])].sort(),
    description: s.description || '',
    color: s.color || '#00ff88',
    icon: s.icon || '🐍',
    run_dir: s.run_dir || '',
    pinned: !!s.pinned,
  })).sort((a, b) => a.id.localeCompare(b.id));

  const folders = (data.folders || []).map(f => ({
    id: f.id,
    name: f.name,
    color: f.color,
    icon: f.icon,
    parent_id: f.parent_id || null,
  })).sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    project_name: data.project_name || '',
    folders,
    scripts,
    settings: data.settings || {},
  });
}

function serializeCurrentProject() {
  return normalizeProjectForSnapshot(state);
}

function setProjectBaseline(label) {
  savedProjectSnapshot = serializeCurrentProject();
  if (label !== undefined) projectFileLabel = label;
  updateProjectFileLabel();
  applyDirtyUI(false);
}

function updateProjectFileLabel() {
  const el = document.getElementById('proj-file-label');
  if (!el) return;
  if (projectFileLabel) {
    el.textContent = '📎 ' + projectFileLabel;
    el.classList.add('linked');
    el.title = 'Файл проекта: ' + projectFileLabel;
  } else if (_projectFileHandle && _projectFileHandle.name) {
    el.textContent = '📎 ' + _projectFileHandle.name;
    el.classList.add('linked');
    el.title = 'Файл проекта: ' + _projectFileHandle.name;
  } else {
    el.textContent = '— не сохранён в файл';
    el.classList.remove('linked');
    el.title = 'Сохраните проект в .pyvault для привязки к файлу';
  }
}

function checkProjectDirty() {
  const dirty = savedProjectSnapshot === null
    ? true
    : serializeCurrentProject() !== savedProjectSnapshot;
  applyDirtyUI(dirty);
  return dirty;
}

function touchProject() {
  checkProjectDirty();
}

function applyDirtyUI(dirty) {
  hasUnsavedChanges = dirty;
  document.getElementById('unsaved-dot').classList.toggle('hidden', !dirty);
  document.getElementById('editor-modified-badge').classList.toggle('hidden', !dirty);
  document.getElementById('save-btn').classList.toggle('has-unsaved', dirty);
}

function markUnsaved() { touchProject(); }
function markSaved() { setProjectBaseline(projectFileLabel); }

function isProjectFileLinked() {
  return !!_projectFileHandle;
}

// ── File System Access API: привязка к .pyvault ──────────────────
const HANDLE_DB = 'pyvault-fs';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'project-file';
const RECENT_LIST_KEY = 'pyvault-recent';
const RECENT_MAX = 15;

function recentHandleKey(id) {
  return 'recent-' + id;
}

function stableRecentId(fileName) {
  return (fileName || 'project').toLowerCase().replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Один файл = одна запись (lastModified при сохранении меняется — не используем). */
function dedupeRecentMeta(list) {
  const map = new Map();
  for (const item of list) {
    const fileName = item.fileName || item.id;
    const key = fileName.toLowerCase();
    const id = stableRecentId(fileName);
    const normalized = { ...item, id, fileName };
    const prev = map.get(key);
    if (!prev || new Date(normalized.openedAt) > new Date(prev.openedAt)) {
      map.set(key, { ...normalized, hasHandle: normalized.hasHandle || prev?.hasHandle });
    } else if (normalized.hasHandle) {
      map.set(key, { ...prev, hasHandle: true, openedAt: normalized.openedAt });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.openedAt) - new Date(a.openedAt)
  );
}

function loadRecentMeta() {
  try {
    const raw = localStorage.getItem(RECENT_LIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return dedupeRecentMeta(list);
  } catch (_) {
    return [];
  }
}

function saveRecentMeta(list) {
  const deduped = dedupeRecentMeta(list).slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_LIST_KEY, JSON.stringify(deduped));
  return deduped;
}

async function persistRecentHandle(id, handle) {
  if (!handle || !window.indexedDB) return;
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, recentHandleKey(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getStoredRecentHandle(id) {
  if (!window.indexedDB) return null;
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(recentHandleKey(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function deleteStoredRecentHandle(id) {
  if (!window.indexedDB) return;
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(recentHandleKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* ignore */ }
}

async function addToRecentProjects(handle, projectName) {
  if (!handle) return;
  const fileName = handle.name;
  const id = stableRecentId(fileName);
  const prevList = loadRecentMeta();
  for (const old of prevList) {
    if (old.fileName.toLowerCase() === fileName.toLowerCase() && old.id !== id) {
      await deleteStoredRecentHandle(old.id);
    }
  }
  const entry = {
    id,
    fileName,
    projectName: projectName || fileName.replace(/\.(pyvault|json)$/i, ''),
    openedAt: new Date().toISOString(),
    hasHandle: true,
  };
  const list = prevList.filter(x => x.fileName.toLowerCase() !== fileName.toLowerCase());
  list.unshift(entry);
  saveRecentMeta(list);
  await persistRecentHandle(id, handle);
}

function addToRecentProjectsMeta(file, projectName) {
  const fileName = file.name;
  const id = 'inp_' + stableRecentId(fileName);
  const entry = {
    id,
    fileName,
    projectName: projectName || fileName,
    openedAt: new Date().toISOString(),
    hasHandle: false,
  };
  const list = loadRecentMeta().filter(
    x => x.fileName.toLowerCase() !== fileName.toLowerCase()
  );
  list.unshift(entry);
  saveRecentMeta(list);
}

async function removeFromRecent(id) {
  const meta = loadRecentMeta().find(x => x.id === id);
  saveRecentMeta(loadRecentMeta().filter(x => x.id !== id));
  await deleteStoredRecentHandle(id);
  if (meta?.fileName) await deleteStoredRecentHandle(stableRecentId(meta.fileName));
  renderRecentProjectsModal();
  toast('Удалено из списка');
}

function renderRecentProjectsModal() {
  const el = document.getElementById('recent-list');
  if (!el) return;
  const list = loadRecentMeta();
  if (!list.length) {
    el.innerHTML = '<div class="recent-empty">Нет недавних проектов.<br>Используйте «Новый проект» или «Открыть файл».</div>';
    return;
  }
  el.innerHTML = list.map(item => `
    <div class="recent-item" data-id="${esc(item.id)}">
      <div class="recent-main">
        <div class="recent-title">${esc(item.projectName)}</div>
        <div class="recent-meta">📎 ${esc(item.fileName)} · ${relTime(item.openedAt)}${item.hasHandle ? '' : ' · повторный выбор'}</div>
      </div>
      <button type="button" class="recent-remove" data-id="${esc(item.id)}" title="Убрать из списка">×</button>
    </div>
  `).join('');
}

function openProjectsModal() {
  renderRecentProjectsModal();
  openModal('modal-recent');
}

async function confirmDiscardUnsaved() {
  if (!hasUnsavedChanges) return true;
  return showConfirm({
    title: 'Несохранённые изменения',
    message: 'Текущий проект не сохранён в файл. Открыть другой проект без сохранения?',
    okText: 'Открыть',
    danger: true,
  });
}

async function openRecentProject(id) {
  if (!(await confirmDiscardUnsaved())) return;
  const meta = loadRecentMeta().find(x => x.id === id);
  if (!meta) return;

  if (!meta.hasHandle) {
    closeModal('modal-recent');
    toast('Выберите тот же файл: ' + meta.fileName, 'info');
    document.getElementById('import-input').click();
    return;
  }

  let handle = await getStoredRecentHandle(id);
  if (!handle && meta.fileName) {
    handle = await getStoredRecentHandle(stableRecentId(meta.fileName));
  }
  if (!handle || typeof handle.queryPermission !== 'function') {
    toast('Файл недоступен — уберите из списка и откройте снова', 'err');
    return;
  }
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'prompt') perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    toast('Нет доступа к файлу', 'err');
    return;
  }
  closeModal('modal-recent');
  await importProjectFromHandle(handle);
}

async function createNewProject() {
  if (!(await confirmDiscardUnsaved())) return;
  const res = await api('/api/project/new', 'POST', { project_name: 'Мой Проект' });
  if (res.error) {
    toast('Ошибка: ' + res.error, 'err');
    return;
  }
  _projectFileHandle = null;
  await clearPersistedProjectFileHandle();
  projectFileLabel = null;
  state = res.state || await api('/api/state');
  document.getElementById('proj-name').value = state.project_name || 'Мой Проект';
  closeEditor();
  goRoot();
  closeModal('modal-recent');
  render();
  updateProjectFileLabel();
  setProjectBaseline(null);
  toast('✓ Создан новый проект');
}

async function browseProjectFile() {
  if (!(await confirmDiscardUnsaved())) return;
  closeModal('modal-recent');
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'PyVault Project',
          accept: { 'application/json': ['.pyvault', '.json'] },
        }],
        multiple: false,
      });
      await importProjectFromHandle(handle);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  document.getElementById('import-input').click();
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistProjectFileHandle(handle) {
  if (!handle || !window.indexedDB) return;
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearPersistedProjectFileHandle() {
  if (!window.indexedDB) return;
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* ignore */ }
}

async function restoreProjectFileHandle() {
  if (!window.indexedDB) return null;
  try {
    const db = await openHandleDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!handle || typeof handle.queryPermission !== 'function') return null;
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'prompt') perm = await handle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted' ? handle : null;
  } catch (_) {
    return null;
  }
}

async function ensureProjectWriteAccess() {
  if (!_projectFileHandle) return false;
  let perm = await _projectFileHandle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return true;
  if (perm === 'prompt') {
    perm = await _projectFileHandle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted';
  }
  return false;
}

async function writeBlobToProjectFile(blob) {
  if (!await ensureProjectWriteAccess()) return false;
  const writable = await _projectFileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

// ── Custom confirm dialog ────────────────────────────────────────
function showConfirm({ title, message, okText = 'Подтвердить', danger = false }) {
  return new Promise(resolve => {
    _confirmResolver = resolve;
    document.getElementById('confirm-title').textContent = title || 'Подтверждение';
    document.getElementById('confirm-message').textContent = message || '';
    const okBtn = document.getElementById('confirm-ok-btn');
    okBtn.textContent = okText;
    okBtn.className = danger ? 'btn-danger' : 'btn-ok';
    openModal('modal-confirm');
  });
}

function closeConfirm(ok) {
  closeModal('modal-confirm');
  if (_confirmResolver) {
    const fn = _confirmResolver;
    _confirmResolver = null;
    fn(!!ok);
  }
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  const drivesInfo = await api('/api/drives');
  _isWindows = !!(drivesInfo && drivesInfo.is_windows);

  loadTrash();
  initSidebarResize();

  document.getElementById('proj-name').addEventListener('input', e => {
    state.project_name = e.target.value;
    api('/api/state', 'POST', { project_name: e.target.value });
    touchProject();
  });

  document.getElementById('import-input').addEventListener('change', importProject);
  document.addEventListener('click', hideCtx);
  document.addEventListener('keydown', onGlobalKey);

  saveRecentMeta(loadRecentMeta());

  const recentList = document.getElementById('recent-list');
  if (recentList) {
    recentList.addEventListener('click', e => {
      const rm = e.target.closest('.recent-remove');
      if (rm && rm.dataset.id) {
        e.stopPropagation();
        removeFromRecent(rm.dataset.id);
        return;
      }
      const item = e.target.closest('.recent-item');
      if (item && item.dataset.id) openRecentProject(item.dataset.id);
    });
  }

  window.addEventListener('beforeunload', e => {
    checkProjectDirty();
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = '';
      document.getElementById('unsaved-warning').classList.remove('hidden');
    }
  });

  // Restore saved view mode
  const savedView = localStorage.getItem('pyvault-view');
  if (savedView && ['grid','cards','tiles','compact','list'].includes(savedView)) {
    currentView = savedView;
  }
  const vbtn = document.getElementById('vbtn-' + currentView);
  if (vbtn) {
    document.querySelectorAll('.view-btn').forEach(x => x.classList.remove('active'));
    vbtn.classList.add('active');
  }

  // Always start fresh — empty project, no file binding
  const freshRes = await api('/api/project/new', 'POST', { project_name: 'Мой Проект' });
  state = freshRes.state || await api('/api/state');
  _projectFileHandle = null;
  await clearPersistedProjectFileHandle();
  projectFileLabel = null;
  document.getElementById('proj-name').value = state.project_name || 'Мой Проект';
  updateProjectFileLabel();

  setProjectBaseline(null);
  render();
  setInterval(pollRunning, 1500);
  setInterval(syncStateFromServer, 2000);

  // Always show recent projects modal on startup
  openProjectsModal();
}

// ── API helper ───────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  try {
    const r = await fetch(url, opts);
    return await r.json();
  } catch(e) {
    return { error: String(e) };
  }
}

// ── Sync in-memory UI with server vault ──────────────────────────
async function syncStateFromServer() {
  const remote = await api('/api/state');
  if (!remote || remote.error) return;
  const remoteSnap = normalizeProjectForSnapshot(remote);
  const localSnap = serializeCurrentProject();
  if (remoteSnap !== localSnap) {
    if (!hasUnsavedChanges) {
      state = remote;
      document.getElementById('proj-name').value = state.project_name || 'Мой Проект';
      if (currentScriptId) {
        const s = state.scripts.find(x => x.id === currentScriptId);
        if (s) {
          document.getElementById('code-editor').value = s.code || '';
          refreshSyntaxHighlight();
          updateLineNumbers();
          updateStatusBar();
        } else {
          closeEditor();
        }
      }
      render();
    } else {
      touchProject();
    }
  }
}

// ── Render ───────────────────────────────────────────────────────
function render() {
  renderSidebar();
  renderCanvas();
  updateStats();
  checkProjectDirty();
}

function renderSidebar() {
  const nav = document.getElementById('folders-nav');
  const tree = buildFolderTree(state.folders);
  nav.innerHTML = tree.length
    ? tree.map(n => renderFolderTreeNode(n, 0)).join('')
    : `<div style="padding:8px 14px;font-size:10px;color:var(--text3)">Нет папок</div>`;

  // counts
  const visScripts = state.scripts.filter(s => !trashedScriptIds.has(s.id));
  document.getElementById('cnt-all').textContent  = visScripts.length;
  document.getElementById('cnt-pin').textContent  = visScripts.filter(s => s.pinned).length;
  document.getElementById('cnt-none').textContent = visScripts.filter(s => !s.folder_id).length;
  const trashEl = document.getElementById('cnt-trash');
  if (trashEl) trashEl.textContent = trashedScriptIds.size + trashedFolderIds.size;

  // active state
  document.querySelectorAll('.nav-item[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === currentFilter);
  });

  // Sidebar drop targets (after DOM update)
  setTimeout(attachSidebarDrop, 0);
}

function renderCanvas() {
  const c = document.getElementById('canvas');
  const bc = document.getElementById('breadcrumb');

  // ── Trash view ───────────────────────────────────────────────
  if (currentFilter === 'trash') {
    bc.innerHTML = `<span class="bc-current" style="color:var(--accent3)">🗑 Корзина</span>`;
    renderTrashView(c);
    return;
  }

  // ── Breadcrumb ───────────────────────────────────────────────
  const bcFolderId = currentFolder || (currentFilter.startsWith('folder:') ? currentFilter.split(':')[1] : null);
  if (bcFolderId) {
    const path = getFolderPath(bcFolderId);
    bc.innerHTML = `<span class="bc-item" onclick="goRoot()">🏠 Все</span>` +
      path.map((f, i) => {
        const isLast = i === path.length - 1;
        return `<span class="bc-sep">›</span>` + (isLast
          ? `<span class="bc-current">${f.icon} ${esc(f.name)}</span>`
          : `<span class="bc-item" onclick="openFolder('${f.id}')">${f.icon} ${esc(f.name)}</span>`);
      }).join('');
  } else {
    bc.innerHTML = '';
  }

  const q = document.getElementById('search-box').value.toLowerCase();

  // ── Filter scripts ───────────────────────────────────────────
  let scripts = state.scripts.filter(s => !trashedScriptIds.has(s.id)).filter(s => {
    if (currentFolder !== null) return s.folder_id === currentFolder;
    if (currentFilter === 'pinned') return s.pinned;
    if (currentFilter === 'none')   return !s.folder_id;
    if (currentFilter.startsWith('folder:')) {
      return s.folder_id === currentFilter.split(':')[1];
    }
    if (currentFilter === 'all') return !s.folder_id;
    return true;
  });

  if (q) {
    scripts = scripts.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.description||'').toLowerCase().includes(q) ||
      (s.tags||[]).some(t => t.toLowerCase().includes(q))
    );
  }

  // Sort
  if (sortMode === 'name')     scripts.sort((a,b) => a.name.localeCompare(b.name));
  else if (sortMode === 'lines') scripts.sort((a,b) => (b.code||'').split('\n').length - (a.code||'').split('\n').length);
  else scripts.sort((a,b) => (b.modified||'').localeCompare(a.modified||''));

  // ── Folders to show ──────────────────────────────────────────
  let folders = [];
  const sidebarFolderId = currentFilter.startsWith('folder:') ? currentFilter.split(':')[1] : null;
  const effectiveParentId = currentFolder !== null ? currentFolder : sidebarFolderId;

  if (!q || effectiveParentId) {
    if (currentFilter === 'all' || effectiveParentId !== null) {
      folders = state.folders.filter(f =>
        !trashedFolderIds.has(f.id) && (f.parent_id || null) === effectiveParentId
      );
      if (q) folders = folders.filter(f => f.name.toLowerCase().includes(q));
    }
  }

  if (!scripts.length && !folders.length) {
    c.innerHTML = `<div class="empty">
      <div class="empty-emoji">🐍</div>
      <div class="empty-title">Ничего нет</div>
      <div class="empty-sub">${q ? 'По запросу «'+esc(q)+'» ничего не найдено' : 'Нажмите «＋ Скрипт» чтобы начать'}</div>
    </div>`;
    return;
  }

  if (currentView === 'grid')    renderGrid(c, folders, scripts);
  else if (currentView === 'cards')   renderCards(c, folders, scripts);
  else if (currentView === 'tiles')   renderTiles(c, folders, scripts);
  else if (currentView === 'compact') renderCompact(c, folders, scripts);
  else renderList(c, folders, scripts);
}

function renderTrashView(c) {
  const trashedScripts = state.scripts.filter(s => trashedScriptIds.has(s.id));
  const trashedFolders = state.folders.filter(f => trashedFolderIds.has(f.id));
  const total = trashedScripts.length + trashedFolders.length;

  if (!total) {
    c.innerHTML = `<div class="empty">
      <div class="empty-emoji">🗑</div>
      <div class="empty-title">Корзина пуста</div>
      <div class="empty-sub">Удалённые скрипты и папки появятся здесь</div>
    </div>`;
    return;
  }

  let html = `<div class="trash-toolbar">
    <span style="font-size:11px;color:var(--text2)">${total} элемент${total===1?'':'ов'}</span>
    <button class="tb-btn danger" onclick="emptyTrash()" style="padding:4px 10px;font-size:11px">🗑 Очистить корзину</button>
  </div><div class="list-view">`;

  trashedFolders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id).length;
    html += `<div class="list-item folder-row trash-item">
      <div class="li-icon">${f.icon}</div>
      <div style="width:8px;height:8px;border-radius:50%;background:${f.color};flex-shrink:0"></div>
      <div class="li-info">
        <div class="li-name">${esc(f.name)}</div>
        <div class="li-meta">${cnt} скриптов · папка</div>
      </div>
      <div class="li-actions">
        <button class="tb-btn" onclick="restoreFromTrash('folder','${f.id}')" style="padding:3px 8px;font-size:10px" title="Восстановить">↩</button>
        <button class="tb-btn danger" onclick="permanentlyDeleteFolder('${f.id}')" style="padding:3px 8px;font-size:10px" title="Удалить навсегда">✕</button>
      </div>
    </div>`;
  });

  trashedScripts.forEach(s => {
    const lines = (s.code || '').split('\n').length;
    html += `<div class="list-item trash-item" style="--item-color:${s.color||'var(--accent)'}">
      <div class="li-icon">${s.icon || '🐍'}</div>
      <div class="li-info">
        <div class="li-name">${esc(s.name)}</div>
        <div class="li-meta">${lines} строк · скрипт</div>
      </div>
      <div class="li-actions">
        <button class="tb-btn" onclick="restoreFromTrash('script','${s.id}')" style="padding:3px 8px;font-size:10px" title="Восстановить">↩</button>
        <button class="tb-btn danger" onclick="permanentlyDeleteScript('${s.id}')" style="padding:3px 8px;font-size:10px" title="Удалить навсегда">✕</button>
      </div>
    </div>`;
  });

  html += '</div>';
  c.innerHTML = html;
}

function renderGrid(c, folders, scripts) {
  let html = '<div class="icon-grid">';

  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id && !trashedScriptIds.has(s.id)).length;
    const subCnt = state.folders.filter(sf => sf.parent_id === f.id && !trashedFolderIds.has(sf.id)).length;
    html += `<div class="folder-icon" data-id="${f.id}"
      ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="fi-body" style="--fi-color:${f.color}">
        <div class="fi-tab"></div>
        <div class="fi-face">${f.icon}</div>
      </div>
      <div class="fi-name">${esc(f.name)}</div>
      <div class="fi-count">${cnt} скр.${subCnt ? ' · '+subCnt+' папок' : ''}</div>
    </div>`;
  });

  const pinned = scripts.filter(s => s.pinned);
  const rest   = scripts.filter(s => !s.pinned);
  [...pinned, ...rest].forEach(s => { html += scriptIconHtml(s); });

  html += '</div>';
  c.innerHTML = html;
  attachDrag();
}

function renderTiles(c, folders, scripts) {
  let html = '<div class="tiles-view">';

  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id && !trashedScriptIds.has(s.id)).length;
    const subCnt = state.folders.filter(sf => sf.parent_id === f.id && !trashedFolderIds.has(sf.id)).length;
    html += `<div class="tile-item folder-tile" data-id="${f.id}"
      style="--fi-color:${f.color}"
      ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="tile-folder-body" style="--fi-color:${f.color}">
        <div class="tile-fi-tab"></div>
        <div class="tile-fi-face">${f.icon}</div>
      </div>
      <div class="tile-info">
        <div class="tile-name">${esc(f.name)}</div>
        <div class="tile-meta">${cnt} скриптов${subCnt ? ' · '+subCnt+' подпапок' : ''}</div>
      </div>
    </div>`;
  });

  const pinned = scripts.filter(s => s.pinned);
  const rest   = scripts.filter(s => !s.pinned);
  [...pinned, ...rest].forEach(s => {
    const lines = (s.code || '').split('\n').length;
    const desc  = s.description ? esc(s.description.slice(0, 50)) : '';
    const tags  = (s.tags || []).slice(0, 3).map(t => `<span class="si-tag">${esc(t)}</span>`).join('');
    html += `<div class="tile-item script-tile${s.pinned ? ' has-pin' : ''}" data-id="${s.id}"
      style="--si-color:${s.color || 'var(--accent)'}"
      ondblclick="openEditor('${s.id}')"
      onclick="selectItem(event,'s:${s.id}',this)"
      oncontextmenu="showScriptCtx(event,'${s.id}')">
      <div class="tile-icon">${s.icon || '🐍'}</div>
      <div class="tile-info">
        <div class="tile-name">${esc(s.name)}</div>
        <div class="tile-meta">${lines} строк${desc ? ' · ' + desc : ''}${tags ? ' &nbsp;' + tags : ''}</div>
      </div>
      ${s.pinned ? '<span class="tile-pin">📌</span>' : ''}
      <div class="tile-actions">
        <button class="tb-btn" onclick="quickRun(event,'${s.id}')" style="padding:3px 8px;font-size:10px">▶</button>
      </div>
    </div>`;
  });

  html += '</div>';
  c.innerHTML = html;
  attachDrag();
}

function renderCompact(c, folders, scripts) {
  let html = '<div class="compact-view">';

  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id && !trashedScriptIds.has(s.id)).length;
    html += `<div class="compact-item compact-folder" data-id="${f.id}"
      ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <span class="compact-icon">${f.icon}</span>
      <span class="compact-dot" style="background:${f.color}"></span>
      <span class="compact-name">${esc(f.name)}</span>
      <span class="compact-meta">${cnt} скр.</span>
    </div>`;
  });

  const pinned = scripts.filter(s => s.pinned);
  const rest   = scripts.filter(s => !s.pinned);
  [...pinned, ...rest].forEach(s => {
    const lines = (s.code || '').split('\n').length;
    const tags  = (s.tags || []).slice(0, 2).map(t => `<span class="si-tag">${esc(t)}</span>`).join('');
    html += `<div class="compact-item${s.pinned ? ' has-pin' : ''}" data-id="${s.id}"
      style="--si-color:${s.color || 'var(--accent)'}"
      ondblclick="openEditor('${s.id}')"
      onclick="selectItem(event,'s:${s.id}',this)"
      oncontextmenu="showScriptCtx(event,'${s.id}')">
      <span class="compact-icon">${s.icon || '🐍'}</span>
      <span class="compact-name">${esc(s.name)}</span>
      ${s.pinned ? '<span class="compact-pin">📌</span>' : ''}
      <span class="compact-meta">${lines} строк</span>
      ${tags ? `<span class="compact-tags">${tags}</span>` : ''}
    </div>`;
  });

  html += '</div>';
  c.innerHTML = html;
  attachDrag();
}

function renderCards(c, folders, scripts) {
  let html = '<div class="cards-view">';

  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id && !trashedScriptIds.has(s.id)).length;
    const subCnt = state.folders.filter(sf => sf.parent_id === f.id && !trashedFolderIds.has(sf.id)).length;
    html += `<div class="card-item card-folder" data-id="${f.id}"
      style="--fi-color:${f.color}"
      ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="card-folder-header" style="background:${f.color}20;border-bottom:2px solid ${f.color}40">
        <div class="card-folder-thumb">
          <div class="card-fi-tab" style="background:${f.color}"></div>
          <div class="card-fi-body" style="background:${f.color}">
            <span style="font-size:22px">${f.icon}</span>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-name">${esc(f.name)}</div>
        <div class="card-meta">${cnt} скриптов${subCnt ? ' · ' + subCnt + ' подпапок' : ''}</div>
        <div class="card-folder-badge">📁 папка</div>
      </div>
    </div>`;
  });

  const pinned = scripts.filter(s => s.pinned);
  const rest   = scripts.filter(s => !s.pinned);
  [...pinned, ...rest].forEach(s => {
    const lines = (s.code || '').split('\n').length;
    const preview = (s.code || '').split('\n').slice(0, 6).map(l => esc(l)).join('\n');
    const desc  = s.description ? esc(s.description.slice(0, 80)) : '';
    const tags  = (s.tags || []).slice(0, 3).map(t => `<span class="si-tag">${esc(t)}</span>`).join('');
    const running = isRunning(s.id);
    html += `<div class="card-item card-script${s.pinned?' has-pin':''}" data-id="${s.id}"
      style="--si-color:${s.color || 'var(--accent)'}"
      ondblclick="openEditor('${s.id}')"
      onclick="selectItem(event,'s:${s.id}',this)"
      oncontextmenu="showScriptCtx(event,'${s.id}')">
      <div class="card-header">
        <div class="card-icon-wrap">
          <span class="card-icon">${s.icon || '🐍'}</span>
          ${running ? '<div class="card-run-dot"></div>' : ''}
        </div>
        <div class="card-code-preview"><pre>${preview || '# пустой скрипт'}</pre></div>
        ${s.pinned ? '<span class="card-pin">📌</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-name">${esc(s.name)}</div>
        ${desc ? `<div class="card-desc">${desc}</div>` : ''}
        <div class="card-footer">
          <span class="card-meta">${lines} строк</span>
          ${tags ? `<span class="card-tags">${tags}</span>` : ''}
          <button class="card-run-btn tb-btn" onclick="quickRun(event,'${s.id}')" title="Запустить">▶</button>
        </div>
      </div>
    </div>`;
  });

  html += '</div>';
  c.innerHTML = html;
  attachDrag();
}

function scriptIconHtml(s) {
  const running = isRunning(s.id);
  return `<div class="script-icon${s.pinned?' has-pin':''}" data-id="${s.id}"
    style="--si-color:${s.color||'var(--accent)'}"
    ondblclick="openEditor('${s.id}')"
    onclick="selectItem(event,'s:${s.id}',this)"
    oncontextmenu="showScriptCtx(event,'${s.id}')">
    <div class="si-thumb">
      ${s.icon||'🐍'}
      ${running ? '<div class="si-run-dot"></div>' : ''}
    </div>
    ${s.pinned ? '<div class="si-pin">📌</div>' : ''}
    <div class="si-name">${esc(s.name)}</div>
    ${(s.tags||[]).length ? `<div class="si-tags">${(s.tags).slice(0,2).map(t=>`<span class="si-tag">${esc(t)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function renderList(c, folders, scripts) {
  let html = '<div class="list-view">';
  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id && !trashedScriptIds.has(s.id)).length;
    const subCnt = state.folders.filter(sf => sf.parent_id === f.id && !trashedFolderIds.has(sf.id)).length;
    html += `<div class="list-item folder-row" data-id="${f.id}" ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="li-icon">${f.icon}</div>
      <div style="width:10px;height:10px;border-radius:50%;background:${f.color};flex-shrink:0"></div>
      <div class="li-info">
        <div class="li-name">${esc(f.name)}</div>
        <div class="li-meta">${cnt} скриптов${subCnt ? ' · '+subCnt+' подпапок' : ''}</div>
      </div>
    </div>`;
  });
  scripts.forEach(s => {
    html += `<div class="list-item" data-id="${s.id}" style="--item-color:${s.color||'var(--accent)'}"
      ondblclick="openEditor('${s.id}')"
      onclick="selectItem(event,'s:${s.id}',this)"
      oncontextmenu="showScriptCtx(event,'${s.id}')">
      <div class="li-icon">${s.icon||'🐍'}</div>
      <div class="li-info">
        <div class="li-name">${esc(s.name)}</div>
        <div class="li-meta">${(s.code||'').split('\n').length} строк · ${relTime(s.modified)}</div>
      </div>
      <div class="li-actions">
        <button class="tb-btn" onclick="quickRun(event,'${s.id}')" title="Запустить" style="padding:3px 8px">▶</button>
      </div>
    </div>`;
  });
  html += '</div>';
  c.innerHTML = html;
  attachDrag();
}

// ── Navigation ───────────────────────────────────────────────────
function goRoot() {
  currentFolder = null;
  currentFilter = 'all';
  document.querySelectorAll('.nav-item[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === 'all');
  });
  renderCanvas();
}

function openFolder(id) {
  currentFolder = id;
  currentFilter = 'all';
  renderCanvas();
}

function setFilter(filter, el) {
  currentFilter = filter;
  currentFolder = null;
  document.querySelectorAll('.nav-item[data-filter]').forEach(x => x.classList.remove('active'));
  if (el) el.classList.add('active');
  renderCanvas();
}

// ── Selection ────────────────────────────────────────────────────
function selectItem(e, key, el) {
  document.querySelectorAll('.script-icon.selected,.folder-icon.selected').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
}

// ── Drag & Drop ──────────────────────────────────────────────────
function attachDrag() {
  // Scripts are draggable
  document.querySelectorAll('.script-icon, .tile-item.script-tile, .card-item.card-script, .compact-item:not(.compact-folder), .list-item:not(.folder-row)').forEach(el => {
    if (!el.dataset.id) return;
    el.draggable = true;
    el.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('scriptId', el.dataset.id);
      ev.dataTransfer.setData('dragType', 'script');
      ev.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });

  // Folders are draggable (to move into other folders)
  document.querySelectorAll('.folder-icon, .tile-item.folder-tile, .card-item.card-folder, .compact-item.compact-folder, .list-item.folder-row').forEach(el => {
    if (!el.dataset.id) return;
    el.draggable = true;
    el.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('folderId', el.dataset.id);
      ev.dataTransfer.setData('dragType', 'folder');
      ev.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });

  // Folder icons are drop targets (accept scripts and other folders)
  document.querySelectorAll('.folder-icon, .tile-item.folder-tile, .card-item.card-folder, .compact-item.compact-folder, .list-item.folder-row').forEach(el => {
    el.addEventListener('dragover', ev => {
      ev.preventDefault();
      // Don't allow folder to drop onto itself
      const dragFid = ev.dataTransfer.types.includes('text/plain') ? null : null;
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', ev => {
      if (!el.contains(ev.relatedTarget)) el.classList.remove('drag-over');
    });
    el.addEventListener('drop', async ev => {
      ev.preventDefault();
      el.classList.remove('drag-over');
      const targetFid = el.dataset.id;
      const dragType = ev.dataTransfer.getData('dragType');

      if (dragType === 'script') {
        const sid = ev.dataTransfer.getData('scriptId');
        if (!sid) return;
        await api('/api/script/' + sid, 'PUT', { folder_id: targetFid });
        const s = state.scripts.find(x => x.id === sid);
        if (s) s.folder_id = targetFid;
        render(); touchProject();
        toast(`📁 Скрипт перемещён в папку`);
      } else if (dragType === 'folder') {
        const srcFid = ev.dataTransfer.getData('folderId');
        if (!srcFid || srcFid === targetFid) return;
        // Prevent moving a folder into its own descendant
        const subIds = getAllSubFolderIds(srcFid);
        if (subIds.includes(targetFid)) {
          toast('⚠ Нельзя поместить папку в свою подпапку', 'err');
          return;
        }
        await api('/api/folder/' + srcFid, 'PUT', { parent_id: targetFid });
        const f = state.folders.find(x => x.id === srcFid);
        if (f) f.parent_id = targetFid;
        openTreeNodes.add(targetFid);
        render(); touchProject();
        toast(`📁 Папка перемещена`);
      }
    });
  });

  // Make sidebar folder tree items drop targets too
  attachSidebarDrop();
}

function attachSidebarDrop() {
  document.querySelectorAll('#folders-nav .nav-item.tree-item').forEach(el => {
    const fid = (el.dataset.filter || '').replace('folder:', '');
    if (!fid) return;

    el.addEventListener('dragover', ev => {
      ev.preventDefault();
      el.classList.add('sidebar-drag-over');
    });
    el.addEventListener('dragleave', ev => {
      if (!el.contains(ev.relatedTarget)) el.classList.remove('sidebar-drag-over');
    });
    el.addEventListener('drop', async ev => {
      ev.preventDefault();
      el.classList.remove('sidebar-drag-over');
      const dragType = ev.dataTransfer.getData('dragType');

      if (dragType === 'script') {
        const sid = ev.dataTransfer.getData('scriptId');
        if (!sid) return;
        await api('/api/script/' + sid, 'PUT', { folder_id: fid });
        const s = state.scripts.find(x => x.id === sid);
        if (s) s.folder_id = fid;
        render(); touchProject();
        toast(`📁 Скрипт перемещён в папку`);
      } else if (dragType === 'folder') {
        const srcFid = ev.dataTransfer.getData('folderId');
        if (!srcFid || srcFid === fid) return;
        const subIds = getAllSubFolderIds(srcFid);
        if (subIds.includes(fid)) {
          toast('⚠ Нельзя поместить папку в свою подпапку', 'err');
          return;
        }
        await api('/api/folder/' + srcFid, 'PUT', { parent_id: fid });
        const f = state.folders.find(x => x.id === srcFid);
        if (f) f.parent_id = fid;
        openTreeNodes.add(fid);
        render(); touchProject();
        toast(`📁 Папка перемещена`);
      }
    });
  });

  // "Все файлы" nav item — drop here to remove from folder / move to root
  const allNav = document.querySelector('.nav-item[data-filter="all"]');
  if (allNav) {
    allNav.addEventListener('dragover', ev => { ev.preventDefault(); allNav.classList.add('sidebar-drag-over'); });
    allNav.addEventListener('dragleave', ev => { if (!allNav.contains(ev.relatedTarget)) allNav.classList.remove('sidebar-drag-over'); });
    allNav.addEventListener('drop', async ev => {
      ev.preventDefault();
      allNav.classList.remove('sidebar-drag-over');
      const dragType = ev.dataTransfer.getData('dragType');
      if (dragType === 'script') {
        const sid = ev.dataTransfer.getData('scriptId');
        if (!sid) return;
        await api('/api/script/' + sid, 'PUT', { folder_id: null });
        const s = state.scripts.find(x => x.id === sid);
        if (s) s.folder_id = null;
        render(); touchProject();
        toast('📄 Скрипт перемещён в корень');
      } else if (dragType === 'folder') {
        const srcFid = ev.dataTransfer.getData('folderId');
        if (!srcFid) return;
        await api('/api/folder/' + srcFid, 'PUT', { parent_id: null });
        const f = state.folders.find(x => x.id === srcFid);
        if (f) f.parent_id = null;
        render(); touchProject();
        toast('📁 Папка перемещена в корень');
      }
    });
  }
}



// ── Editor ───────────────────────────────────────────────────────
function openEditor(id) {
  currentScriptId = id;
  const s = state.scripts.find(x => x.id === id);
  if (!s) return;

  document.getElementById('win-title').textContent = (s.icon||'🐍') + ' ' + s.name;
  document.getElementById('code-editor').value = s.code || '';
  syncRunDirInput(s.run_dir || '');
  document.getElementById('editor-overlay').classList.remove('hidden');

  refreshSyntaxHighlight();
  updateLineNumbers();
  updateStatusBar();
  switchWinTab('editor', document.querySelector('.win-tab'));

  clearTerminal();
  stopLog();
  loadDeps(id);
  renderInfoPane(s);
}

function closeEditor() {
  document.getElementById('editor-overlay').classList.add('hidden');
  currentScriptId = null;
  stopLog();
}

// ── Line Numbers (FIXED) ─────────────────────────────────────────
function updateLineNumbers() {
  const editor = document.getElementById('code-editor');
  const container = document.getElementById('line-numbers');
  const lines = editor.value.split('\n');
  // Build one span per line — each span has fixed line-height matching editor
  container.innerHTML = lines.map((_, i) => `<span class="ln">${i + 1}</span>`).join('');
}

function syncLineScroll() {
  const editor = document.getElementById('code-editor');
  const lnBox  = document.getElementById('line-numbers');
  const hiPre  = document.getElementById('code-highlight');
  lnBox.scrollTop = editor.scrollTop;
  if (hiPre) {
    hiPre.scrollTop = editor.scrollTop;
    hiPre.scrollLeft = editor.scrollLeft;
  }
}

// ── Python syntax highlight ──────────────────────────────────────
function highlightPython(code) {
  let out = '';
  let i = 0;
  const n = code.length;

  function append(cls, text) {
    out += `<span class="${cls}">${esc(text)}</span>`;
  }

  while (i < n) {
    const rest = code.slice(i);

    if (rest.startsWith('#')) {
      const end = rest.search(/\n/);
      const chunk = end === -1 ? rest : rest.slice(0, end);
      append('hl-cmt', chunk);
      i += chunk.length;
      continue;
    }

    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      const q = rest.slice(0, 3);
      let j = i + 3;
      while (j < n) {
        if (code.slice(j, j + 3) === q) { j += 3; break; }
        j++;
      }
      append('hl-str', code.slice(i, j));
      i = j;
      continue;
    }

    if (rest[0] === '"' || rest[0] === "'") {
      const q = rest[0];
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        if (code[j] === '\n') break;
        j++;
      }
      append('hl-str', code.slice(i, j));
      i = j;
      continue;
    }

    const num = rest.match(/^(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/);
    if (num) {
      append('hl-num', num[0]);
      i += num[0].length;
      continue;
    }

    const ident = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (ident) {
      const w = ident[0];
      if (PY_KEYWORDS.has(w)) append('hl-kw', w);
      else if (PY_BUILTINS.has(w)) append('hl-bi', w);
      else if (/^[A-Z]/.test(w)) append('hl-cls', w);
      else if (i + w.length < n && code[i + w.length] === '(') append('hl-fn', w);
      else out += esc(w);
      i += w.length;
      continue;
    }

    const deco = rest.match(/^@[A-Za-z_][A-Za-z0-9_.]*/);
    if (deco) {
      append('hl-dec', deco[0]);
      i += deco[0].length;
      continue;
    }

    if (/^[+\-*/%=<>!&|^~]/.test(rest)) {
      const op = rest.match(/^[+\-*/%=<>!&|^~]+/)[0];
      append('hl-op', op);
      i += op.length;
      continue;
    }

    out += esc(code[i]);
    i++;
  }
  return out;
}

function refreshSyntaxHighlight() {
  const editor = document.getElementById('code-editor');
  const codeEl = document.querySelector('#code-highlight code');
  if (!editor || !codeEl) return;
  const code = editor.value;
  codeEl.innerHTML = highlightPython(code) + '\n';
}

// ── Code change ──────────────────────────────────────────────────
function onCodeChange() {
  refreshSyntaxHighlight();
  updateLineNumbers();
  updateStatusBar();
  touchProject();
  clearTimeout(window._saveTimer);
  window._saveTimer = setTimeout(async () => {
    if (!currentScriptId) return;
    const code = document.getElementById('code-editor').value;
    await api('/api/script/' + currentScriptId, 'PUT', { code });
    const s = state.scripts.find(x => x.id === currentScriptId);
    if (s) { s.code = code; updateStats(); }
    loadDeps(currentScriptId);
    touchProject();
  }, 700);
}

function updateStatusBar() {
  const ed = document.getElementById('code-editor');
  const code = ed.value;
  const lines = code.split('\n').length;
  const chars = code.length;
  document.getElementById('st-lines').textContent = lines + ' строк';
  document.getElementById('st-chars').textContent = chars + ' символов';
  // cursor pos
  const pos = ed.selectionStart;
  let ln = 1, col = 1;
  for (let i = 0; i < pos; i++) { if (code[i] === '\n') { ln++; col = 1; } else col++; }
  document.getElementById('st-cursor').textContent = `Стр ${ln}, Кол ${col}`;
}

function handleEditorKey(e) {
  const ed = e.target;
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = ed.selectionStart, end = ed.selectionEnd;
    ed.value = ed.value.substring(0, s) + '    ' + ed.value.substring(end);
    ed.selectionStart = ed.selectionEnd = s + 4;
    onCodeChange();
    refreshSyntaxHighlight();
    return;
  }
  if (e.key === 'Enter') {
    const s = ed.selectionStart;
    const before = ed.value.substring(0, s);
    const lastLine = before.split('\n').pop();
    const indent = lastLine.match(/^(\s*)/)[1];
    const extra = lastLine.trimEnd().endsWith(':') ? '    ' : '';
    setTimeout(() => {
      const pos2 = ed.selectionStart;
      ed.value = ed.value.substring(0, pos2) + indent + extra + ed.value.substring(pos2);
      ed.selectionStart = ed.selectionEnd = pos2 + indent.length + extra.length;
      updateLineNumbers();
      updateStatusBar();
      refreshSyntaxHighlight();
    }, 0);
  }
  updateStatusBar();
}

// ── Run ──────────────────────────────────────────────────────────
async function runScript() {
  if (!currentScriptId) return;
  const btn = document.getElementById('run-btn');
  const s = state.scripts.find(x => x.id === currentScriptId);

  if (btn.classList.contains('stopping')) {
    await api('/api/script/' + currentScriptId + '/stop', 'POST');
    btn.innerHTML = '▶ Запустить';
    btn.classList.remove('stopping');
    addTermLine('— Остановлено —', 'sys');
    stopLog();
    return;
  }

  await syncRunDirFromInput();

  clearTerminal();
  addTermLine(`> python ${s.name}`, 'sys');
  addTermLine(`cwd: ${s.run_dir || '—'}`, 'sys');
  switchWinTab('terminal', null);

  const res = await api('/api/script/' + currentScriptId + '/run', 'POST', { run_dir: s.run_dir });
  if (res.error) { addTermLine('Ошибка: ' + res.error, 'err'); return; }
  if (res.script_path) addTermLine(`файл: ${res.script_path}`, 'sys');

  btn.innerHTML = '⏹ Остановить';
  btn.classList.add('stopping');
  logLastLen = 0;
  runFinishedShown = false;
  logTimer = setInterval(pollLogs, 250);
}

async function pollLogs() {
  if (!currentScriptId) return;
  const data = await api('/api/script/' + currentScriptId + '/logs');
  const logs = data.logs || [];
  if (logs.length > logLastLen) {
    for (let i = logLastLen; i < logs.length; i++) {
      const line = logs[i];
      const cls = /traceback|error/i.test(line) ? 'err' : /warning/i.test(line) ? 'warn' : '';
      addTermLine(line, cls);
    }
    logLastLen = logs.length;
  }
  setTerminalPartialLine(data.partial || '');
  if (!data.running) {
    setTerminalPartialLine('');
    if (!runFinishedShown) {
      runFinishedShown = true;
      addTermLine('— Завершено —', 'sys');
    }
    document.getElementById('run-btn').innerHTML = '▶ Запустить';
    document.getElementById('run-btn').classList.remove('stopping');
    stopLog();
    renderCanvas();
  }
}

function stopLog() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}

function clearTerminal() {
  document.getElementById('terminal-out').innerHTML = '<div class="tl sys">// Консоль</div>';
}

function toggleTerminalWrap(on) {
  document.getElementById('terminal-out').classList.toggle('wrap-mode', on);
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xterm256ToHex(idx) {
  if (idx < 0 || idx > 255) return null;
  const base = [
    '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
    '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  if (idx < 16) return base[idx];
  if (idx >= 16 && idx <= 231) {
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const level = [0, 95, 135, 175, 215, 255];
    return `rgb(${level[r]}, ${level[g]}, ${level[b]})`;
  }
  const gray = 8 + (idx - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function ansiToHtml(text) {
  const src = String(text ?? '');
  let i = 0;
  let out = '';
  const st = { bold: false, italic: false, color: '' };

  const styleStr = () => {
    const s = [];
    if (st.bold) s.push('font-weight:700');
    if (st.italic) s.push('font-style:italic');
    if (st.color) s.push(`color:${st.color}`);
    return s.join(';');
  };

  const pushText = (chunk) => {
    if (!chunk) return;
    const safe = escHtml(chunk);
    const style = styleStr();
    out += style ? `<span style="${style}">${safe}</span>` : safe;
  };

  while (i < src.length) {
    if (src[i] === '\u001b') {
      // CSI: ESC [ ... final-byte
      if (src[i + 1] === '[') {
        const csiMatch = src.slice(i + 2).match(/^[0-9;?]*[ -/]*[@-~]/);
        if (!csiMatch) {
          i += 1;
          continue;
        }
        const seq = csiMatch[0];
        const finalByte = seq[seq.length - 1];
        if (finalByte === 'm') {
          const raw = seq.slice(0, -1);
          const codes = raw.length ? raw.split(';').map(x => Number.parseInt(x, 10) || 0) : [0];
          for (let c = 0; c < codes.length; c++) {
            const code = codes[c];
            if (code === 0) { st.bold = false; st.italic = false; st.color = ''; continue; }
            if (code === 1) { st.bold = true; continue; }
            if (code === 3) { st.italic = true; continue; }
            if (code === 22) { st.bold = false; continue; }
            if (code === 23) { st.italic = false; continue; }
            if (code === 39) { st.color = ''; continue; }
            if (code >= 30 && code <= 37) {
              st.color = ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0'][code - 30];
              continue;
            }
            if (code >= 90 && code <= 97) {
              st.color = ['#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'][code - 90];
              continue;
            }
            if (code === 38 && codes[c + 1] === 5) {
              const color = xterm256ToHex(codes[c + 2]);
              if (color) st.color = color;
              c += 2;
            }
          }
        }
        // For non-color CSI (cursor moves/erase/etc) we just drop sequence.
        i += 2 + seq.length;
        continue;
      }
      // OSC: ESC ] ... BEL or ST
      if (src[i + 1] === ']') {
        let end = src.indexOf('\u0007', i + 2);
        const stEnd = src.indexOf('\u001b\\', i + 2);
        if (stEnd !== -1 && (end === -1 || stEnd < end)) end = stEnd + 1;
        if (end === -1) {
          i += 2;
          continue;
        }
        i = end + 1;
        continue;
      }
      // Any other ESC sequence: skip ESC char.
      i += 1;
      continue;
    }
    const nextEsc = src.indexOf('\u001b', i);
    if (nextEsc === -1) {
      pushText(src.slice(i));
      break;
    }
    pushText(src.slice(i, nextEsc));
    i = nextEsc;
  }
  return out;
}

function setTerminalPartialLine(text) {
  const out = document.getElementById('terminal-out');
  let partial = out.querySelector('.tl.partial');
  if (!text) {
    if (partial) partial.remove();
    return;
  }
  if (!partial) {
    partial = document.createElement('div');
    partial.className = 'tl partial';
    out.appendChild(partial);
  }
  partial.innerHTML = ansiToHtml(text);
  out.scrollTop = out.scrollHeight;
}

function addTermLine(text, cls = '') {
  const out = document.getElementById('terminal-out');
  const partial = out.querySelector('.tl.partial');
  if (partial) partial.remove();
  const d = document.createElement('div');
  d.className = 'tl ' + cls;
  d.innerHTML = ansiToHtml(text);
  out.appendChild(d);
  out.scrollTop = out.scrollHeight;
}

async function sendInput() {
  if (!currentScriptId) return;
  const inp = document.getElementById('terminal-input');
  const text = inp.value;
  inp.value = '';
  // Show echo in terminal
  addTermLine('> ' + text, 'sys');
  const res = await api('/api/script/' + currentScriptId + '/input', 'POST', { text });
  if (res.error) addTermLine('stdin error: ' + res.error, 'err');
}

function onTerminalKey(e) {
  if (e.key === 'Enter') sendInput();
}

async function quickRun(e, id) {
  e.stopPropagation();

  const s = state.scripts.find(x => x.id === id);
  if (!s) return;

  // Ask for run directory before executing
  const chosenDir = await pickRunDirForScript(id);
  if (chosenDir === null) return; // user cancelled

  // Apply directory if changed
  if (chosenDir !== (s.run_dir || '')) {
    await api('/api/script/' + id, 'PUT', { run_dir: chosenDir });
    s.run_dir = chosenDir;
  }

  // Open editor, switch to terminal, run
  openEditor(id);
  setTimeout(() => {
    switchWinTab('terminal', null);
    setTimeout(runScript, 50);
  }, 80);
}

// Shows a compact dir-picker modal for a script and resolves with chosen path
// Returns the path string (may be '') on confirm, or null on cancel
function pickRunDirForScript(id) {
  return new Promise(async resolve => {
    currentScriptId = id;
    const s = state.scripts.find(x => x.id === id);

    // Populate the dir picker as usual
    const manual = document.getElementById('dir-manual-path');
    if (manual) manual.value = s?.run_dir || '';
    let start = s ? (s.run_dir || '') : '';
    if (!start || start === '/' || start === '\\') {
      if (_isWindows) start = '__drives__';
      else start = (await api('/api/ls?path=' + encodeURIComponent(''))).path || '';
    }
    await loadDir(start);

    // Swap the modal confirm button to resolve the promise
    const modal = document.getElementById('modal-dir');
    const selectBtn = modal.querySelector('.btn-ok');
    const cancelBtn = modal.querySelector('.btn-cancel');

    function cleanup() {
      selectBtn.onclick = selectDir;
      cancelBtn.onclick = () => closeModal('modal-dir');
      modal.removeEventListener('click', backdropCancel);
    }

    function backdropCancel(ev) {
      if (ev.target === modal) { cleanup(); closeModal('modal-dir'); resolve(null); }
    }

    selectBtn.onclick = async () => {
      if (!dirPickerPath && dirPickerPath !== '') {
        toast('Выберите папку', 'err');
        return;
      }
      cleanup();
      closeModal('modal-dir');
      resolve(dirPickerPath || '');
    };

    cancelBtn.onclick = () => {
      cleanup();
      closeModal('modal-dir');
      resolve(null);
    };

    modal.addEventListener('click', backdropCancel);
    openModal('modal-dir');
  });
}


async function pollRunning() {
  // Update running dots on icons
  const running = new Set();
  for (const sid in window._runCache || {}) {
    const d = await api('/api/script/' + sid + '/logs');
    if (d.running) running.add(sid);
  }
  document.querySelectorAll('.script-icon .si-run-dot').forEach(el => {
    const ic = el.closest('.script-icon');
    if (ic && !running.has(ic.dataset.id)) el.remove();
  });
}

function isRunning(id) {
  return !!document.querySelector(`.script-icon[data-id="${id}"] .si-run-dot`);
}

// ── Dir Picker ───────────────────────────────────────────────────
function syncRunDirInput(path) {
  const inp = document.getElementById('run-dir-input');
  if (inp) inp.value = path || '';
}

async function validateDirPath(path) {
  const trimmed = (path || '').trim();
  if (!trimmed) return null;
  const data = await api('/api/ls?path=' + encodeURIComponent(trimmed));
  if (data.error) return null;
  return data.path;
}

async function setRunDir(path) {
  if (!currentScriptId || !path) return false;
  await api('/api/script/' + currentScriptId, 'PUT', { run_dir: path });
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s) s.run_dir = path;
  dirPickerPath = path;
  syncRunDirInput(path);
  touchProject();
  return true;
}

function onRunDirInputKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyManualRunDir();
  }
}

async function syncRunDirFromInput() {
  if (!currentScriptId) return;
  const inp = document.getElementById('run-dir-input');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s && s.run_dir === raw) return;
  const resolved = await validateDirPath(raw);
  if (resolved) await setRunDir(resolved);
}

async function applyManualRunDir() {
  if (!currentScriptId) return;
  const raw = document.getElementById('run-dir-input').value.trim();
  if (!raw) {
    toast('Укажите путь к папке', 'err');
    return;
  }
  const resolved = await validateDirPath(raw);
  if (!resolved) {
    toast('Папка не найдена или недоступна: ' + raw, 'err');
    return;
  }
  await setRunDir(resolved);
  toast('✓ Путь запуска: ' + shortPath(resolved));
}

async function applyDirManualPath() {
  const raw = document.getElementById('dir-manual-path').value.trim();
  if (!raw) {
    toast('Введите путь', 'err');
    return;
  }
  const resolved = await validateDirPath(raw);
  if (!resolved) {
    toast('Папка не найдена: ' + raw, 'err');
    return;
  }
  dirPickerPath = resolved;
  document.getElementById('dir-current').textContent = resolved;
  document.getElementById('dir-manual-path').value = resolved;
  await loadDir(resolved);
}

async function openDirPicker() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  const manual = document.getElementById('dir-manual-path');
  if (manual) manual.value = s?.run_dir || '';
  let start = s ? (s.run_dir || '') : '';
  if (!start || start === '/' || start === '\\') {
    if (_isWindows) start = '__drives__';
    else start = (await api('/api/ls?path=' + encodeURIComponent(''))).path;
  }
  await loadDir(start);
  openModal('modal-dir');
}

async function renderDirDrives() {
  const box = document.getElementById('dir-drives');
  if (!box) return;
  if (!_isWindows) {
    box.innerHTML = '';
    return;
  }
  const data = await api('/api/drives');
  const drives = data.drives || [];
  box.innerHTML = drives.map(d =>
    `<button type="button" class="dir-drive-btn" data-path="${encodeURIComponent(d.path)}">${esc(d.name)}</button>`
  ).join('');
}

async function loadDir(path) {
  const list = document.getElementById('dir-list');

  if (path === '__drives__') {
    dirPickerPath = null;
    document.getElementById('dir-current').textContent = 'Компьютер — выберите диск';
    await renderDirDrives();
    list.innerHTML = `<div class="dir-section-label">Диски</div>` +
      ((await api('/api/drives')).drives || []).map(d =>
        `<div class="dir-item" data-path="${encodeURIComponent(d.path)}">💿 ${esc(d.name)}</div>`
      ).join('');
    return;
  }

  const data = await api('/api/ls?path=' + encodeURIComponent(path));
  if (data.error) { toast(data.error, 'err'); return; }
  dirPickerPath = data.path;
  document.getElementById('dir-current').textContent = data.path;
  await renderDirDrives();

  let html = '';
  if (_isWindows) {
    html += `<div class="dir-item" data-path="__drives__">🖥 Компьютер (все диски)</div>`;
  }
  if (data.parent) {
    html += `<div class="dir-item" data-path="${encodeURIComponent(data.parent)}">⬆ ..</div>`;
  }
  html += data.items.filter(i => i.is_dir).map(i =>
    `<div class="dir-item" data-path="${encodeURIComponent(i.path)}">📁 ${esc(i.name)}</div>`
  ).join('');
  list.innerHTML = html;
}

// Event delegation for dir-list — safe click handler without inline onclick
document.addEventListener('click', e => {
  const driveBtn = e.target.closest('.dir-drive-btn');
  if (driveBtn && driveBtn.dataset.path) {
    loadDir(decodeURIComponent(driveBtn.dataset.path));
    return;
  }
  const item = e.target.closest('#dir-list .dir-item');
  if (item && item.dataset.path) {
    const p = decodeURIComponent(item.dataset.path);
    loadDir(p === '__drives__' ? '__drives__' : p);
  }
  // Event delegation for install-all button
  const installAll = e.target.closest('.install-all-btn');
  if (installAll && installAll.dataset.pkgs) {
    try {
      const pkgList = JSON.parse(decodeURIComponent(installAll.dataset.pkgs));
      installAllMissing(pkgList);
    } catch(err) { console.error('installAll parse error', err); }
  }
});

async function selectDir() {
  if (!currentScriptId || !dirPickerPath) {
    toast('Выберите папку или диск', 'err');
    return;
  }
  await setRunDir(dirPickerPath);
  closeModal('modal-dir');
  toast('✓ Директория установлена');
}

// ── Compile ──────────────────────────────────────────────────────
let _compileIconB64 = null;

function compileScript() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  // Reset modal state
  _compileIconB64 = null;
  document.getElementById('compile-status').textContent = `Скрипт: ${s.name}`;
  document.getElementById('compile-log').textContent = '';
  document.getElementById('compile-close-btn').disabled = false;
  document.getElementById('compile-icon-name').textContent = 'Не выбрана';
  document.getElementById('compile-build-onefile').checked = true;
  document.getElementById('compile-noconsole').checked = false;
  document.getElementById('compile-spinner').classList.add('hidden');
  openModal('modal-compile');
}

async function startCompile() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  const buildType = document.getElementById('compile-build-onefile').checked ? 'onefile' : 'onedir';
  const noConsole = document.getElementById('compile-noconsole').checked;

  // Show spinner + status
  document.getElementById('compile-spinner').classList.remove('hidden');
  document.getElementById('compile-status').textContent = `⏳ Компилирую: ${s.name}...`;
  document.getElementById('compile-log').textContent = 'Запускаю PyInstaller...\nЭто может занять минуту.\n\nПожалуйста, подождите — процесс активен.';
  document.getElementById('compile-close-btn').disabled = true;
  document.getElementById('compile-start-btn').disabled = true;
  document.getElementById('compile-start-btn').textContent = '⏳ Компилирую...';

  try {
    const payload = { build_type: buildType, noconsole: noConsole };
    if (_compileIconB64) payload.icon_b64 = _compileIconB64;

    const resp = await fetch('/api/compile/' + currentScriptId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok && resp.headers.get('Content-Disposition')) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disp = resp.headers.get('Content-Disposition') || '';
      // Handle RFC 5987 encoded filename: filename*=UTF-8''encoded.exe
      let dlName = s.name;
      const rfc5987 = disp.match(/filename\*=UTF-8''([^\s;]+)/i);
      if (rfc5987) {
        try { dlName = decodeURIComponent(rfc5987[1]); } catch(e) { dlName = s.name; }
      } else {
        const plain = disp.match(/filename="?([^";]+)"?/i);
        if (plain && plain[1]) dlName = plain[1];
      }
      a.download = dlName;
      a.click();
      document.getElementById('compile-spinner').classList.add('hidden');
      document.getElementById('compile-status').textContent = '✓ Готово! Файл скачан.';
      document.getElementById('compile-log').textContent = buildType === 'onefile'
        ? 'EXE успешно создан.' : 'Папка упакована в ZIP.';
    } else {
      const err = await resp.json();
      document.getElementById('compile-spinner').classList.add('hidden');
      document.getElementById('compile-status').textContent = '✗ Ошибка компиляции';
      document.getElementById('compile-log').textContent = err.output || err.error || 'Неизвестная ошибка';
    }
  } catch(e) {
    document.getElementById('compile-spinner').classList.add('hidden');
    document.getElementById('compile-status').textContent = '✗ Ошибка';
    document.getElementById('compile-log').textContent = e.message;
  }
  document.getElementById('compile-close-btn').disabled = false;
  document.getElementById('compile-start-btn').disabled = false;
  document.getElementById('compile-start-btn').textContent = '⚙ Компилировать';
}

function compileIconPick() {
  const inp = document.getElementById('compile-icon-input');
  inp.click();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('compile-icon-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      _compileIconB64 = ev.target.result.split(',')[1];
      document.getElementById('compile-icon-name').textContent = file.name;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });
});

// ── Deps ─────────────────────────────────────────────────────────
async function loadDeps(id) {
  const data = await api('/api/script/' + id + '/analyze');
  if (data.error) return;
  const c = document.getElementById('deps-pane');
  let html = `<div class="deps-info-grid">
    <div class="di-card"><div class="di-val">${data.lines}</div><div class="di-lbl">Строк</div></div>
    <div class="di-card"><div class="di-val">${data.functions.length}</div><div class="di-lbl">Функций</div></div>
    <div class="di-card"><div class="di-val">${data.classes.length}</div><div class="di-lbl">Классов</div></div>
    <div class="di-card"><div class="di-val">${data.complexity}</div><div class="di-lbl">Сложность</div></div>
  </div>`;

  if (data.errors && data.errors.length) {
    html += `<div class="dep-group-title">⚠ Синтаксические ошибки</div>`;
    data.errors.forEach(e => { html += `<div class="error-row">❌ ${esc(e)}</div>`; });
  }
  if (data.third_party.length) {
    // Count missing packages
    const missing = data.third_party.filter(pkg => !data.dep_status[pkg]);
    const unused = data.unused_imports || {};
    const unusedPkgs = Object.keys(unused);
    html += `<div class="dep-group-title" style="display:flex;align-items:center;justify-content:space-between">
      <span>📦 Сторонние пакеты ${unusedPkgs.length ? `<span style="color:#ffd700;font-size:11px;font-weight:400;margin-left:6px">(${unusedPkgs.length} неиспольз.)</span>` : ''}</span>
      ${missing.length > 0 ? `<button class="install-all-btn" id="install-all-btn-${id}" data-pkgs="${encodeURIComponent(JSON.stringify(missing))}">⬇ Установить все (${missing.length})</button>` : ''}
    </div>`;
    data.third_party.forEach(pkg => {
      const ok = data.dep_status[pkg];
      const isUnused = unused[pkg];
      html += `<div class="dep-row">
        <span class="dep-icon">📦</span>
        <span class="dep-name">${esc(pkg)}</span>
        <span class="dep-badge ${ok?'ok':'missing'}">${ok?'✓ есть':'✗ нет'}</span>
        ${isUnused ? `<span class="dep-badge unused" title="Не используется: ${esc(isUnused.join(', '))}">⚠ неиспольз.</span>` : ''}
        ${!ok?`<button class="install-btn" onclick="installPkg('${esc(pkg)}')">pip install</button>`:''}
      </div>`;
    });
  }
  if (data.std_libs.length) {
    const unusedStd = data.unused_stdlib || {};
    const unusedStdPkgs = Object.keys(unusedStd);
    html += `<div class="dep-group-title">🐍 Стандартная библиотека ${unusedStdPkgs.length ? `<span style="color:#ffd700;font-size:11px;font-weight:400;margin-left:6px">(${unusedStdPkgs.length} неиспольз.)</span>` : ''}</div>`;
    data.std_libs.forEach(pkg => {
      const isUnused = unusedStd[pkg];
      html += `<div class="dep-row">
        <span class="dep-icon">🐍</span>
        <span class="dep-name">${esc(pkg)}</span>
        <span class="dep-badge stdlib">stdlib</span>
        ${isUnused ? `<span class="dep-badge unused" title="Не используется: ${esc(isUnused.join(', '))}">⚠ неиспольз.</span>` : ''}
      </div>`;
    });
  }
  if (data.functions.length || data.classes.length) {
    const unusedFuncs = data.unused_functions || [];
    const unusedFuncSet = new Set(unusedFuncs);
    html += `<div class="dep-group-title">🏗 Структура кода ${unusedFuncs.length ? `<span style="color:#ffd700;font-size:11px;font-weight:400;margin-left:6px">(${unusedFuncs.length} неиспольз.)</span>` : ''}</div>`;
    if (data.classes.length) {
      html += `<div class="dep-row"><span class="dep-icon">🧱</span><span class="dep-name">Классы</span>
        <div class="fn-chips">${data.classes.map(x=>`<span class="fn-chip">${esc(x)}</span>`).join('')}</div></div>`;
    }
    if (data.functions.length) {
      html += `<div class="dep-row"><span class="dep-icon">⚡</span><span class="dep-name">Функции</span>
        <div class="fn-chips">${data.functions.map(x=>`<span class="fn-chip ${unusedFuncSet.has(x)?'fn-chip-unused':''}" ${unusedFuncSet.has(x)?'title="Функция определена, но нигде не вызывается"':''}>${esc(x)}${unusedFuncSet.has(x)?' ⚠':''}</span>`).join('')}</div></div>`;
    }
  }
  c.innerHTML = html;
}

async function installPkg(pkg) {
  toast(`Устанавливаю ${pkg}...`, 'info');
  const data = await api('/api/install', 'POST', { package: pkg });
  if (data.ok) { toast(`✓ ${pkg} установлен`); loadDeps(currentScriptId); }
  else toast(`Ошибка: ${data.error || data.output}`, 'err');
}

// Install ALL missing packages sequentially
async function installAllMissing(pkgList) {
  if (!pkgList || !pkgList.length) return;
  toast(`Устанавливаю ${pkgList.length} пакетов...`, 'info');
  // Update UI to show in progress
  const c = document.getElementById('deps-pane');
  const installBtn = c.querySelector('.install-all-btn');
  if (installBtn) { installBtn.disabled = true; installBtn.textContent = '⏳ Установка...'; }

  let failed = [];
  for (const pkg of pkgList) {
    const data = await api('/api/install', 'POST', { package: pkg });
    if (!data.ok) failed.push(pkg);
  }

  if (failed.length === 0) {
    toast(`✓ Все пакеты установлены`, 'ok');
  } else {
    toast(`⚠ Не удалось установить: ${failed.join(', ')}`, 'err');
  }
  loadDeps(currentScriptId);
}

// ── Info Pane ────────────────────────────────────────────────────
function renderInfoPane(s) {
  const c = document.getElementById('info-pane');
  c.innerHTML = `
    <div class="form-group">
      <label class="form-label">Название</label>
      <input class="form-input" value="${esc(s.name)}" onchange="updateField('name',this.value)">
    </div>
    <div class="form-group">
      <label class="form-label">Описание</label>
      <input class="form-input" value="${esc(s.description||'')}" onchange="updateField('description',this.value)">
    </div>
    <div class="form-group">
      <label class="form-label">Теги (через запятую)</label>
      <input class="form-input" value="${esc((s.tags||[]).join(', '))}"
        onchange="updateField('tags',this.value.split(',').map(t=>t.trim()).filter(Boolean))">
    </div>
    <div class="form-group">
      <label class="form-label">Папка</label>
      <select class="form-input" onchange="updateField('folder_id',this.value||null)">
        <option value="">— Без папки —</option>
        ${state.folders.map(f=>`<option value="${f.id}"${s.folder_id===f.id?' selected':''}>${f.icon} ${esc(f.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Иконка</label>
      <div class="icon-row">${SCRIPT_ICONS.map(ic=>`<div class="i-opt${ic===s.icon?' sel':''}"
        onclick="updateField('icon','${ic}');this.closest('.icon-row').querySelectorAll('.i-opt').forEach(x=>x.classList.remove('sel'));this.classList.add('sel')">${ic}</div>`).join('')}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Цвет</label>
      <div class="color-row">${COLORS.map(c=>`<div class="c-dot${c===s.color?' sel':''}" style="background:${c}"
        onclick="updateField('color','${c}');this.closest('.color-row').querySelectorAll('.c-dot').forEach(x=>x.classList.remove('sel'));this.classList.add('sel')"></div>`).join('')}</div>
    </div>
    <div style="font-size:10px;color:var(--text3);margin-top:10px;line-height:1.7">
      ID: ${s.id}<br>
      Создан: ${s.created ? new Date(s.created).toLocaleString('ru') : '—'}<br>
      Изменён: ${s.modified ? new Date(s.modified).toLocaleString('ru') : '—'}
    </div>`;
}

async function updateField(field, value) {
  if (!currentScriptId) return;
  const payload = { [field]: value };
  await api('/api/script/' + currentScriptId, 'PUT', payload);
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s) { s[field] = value; }
  if (field === 'name') document.getElementById('win-title').textContent = (s.icon||'🐍') + ' ' + value;
  render();
  touchProject();
}

// ── Create script ────────────────────────────────────────────────
function openNewScript() {
  // Populate folder select
  const sel = document.getElementById('ns-folder');
  sel.innerHTML = '<option value="">— Без папки —</option>' +
    state.folders.map(f => `<option value="${f.id}">${f.icon} ${esc(f.name)}</option>`).join('');
  // Preselect current folder (opened via canvas or sidebar)
  const activeFolderId = currentFolder || (currentFilter.startsWith('folder:') ? currentFilter.split(':')[1] : null);
  if (activeFolderId) sel.value = activeFolderId;

  buildIconPicker('ns-icon-row', SCRIPT_ICONS, SCRIPT_ICONS[0]);
  buildColorPicker('ns-color-row', COLORS, COLORS[0]);
  document.getElementById('ns-name').value = '';
  document.getElementById('ns-desc').value = '';
  document.getElementById('ns-tags').value = '';
  openModal('modal-new-script');
  setTimeout(() => document.getElementById('ns-name').focus(), 120);
}

async function createScript() {
  const name  = document.getElementById('ns-name').value.trim() || 'Новый скрипт';
  const desc  = document.getElementById('ns-desc').value.trim();
  const fid   = document.getElementById('ns-folder').value || null;
  const icon  = document.querySelector('#ns-icon-row .sel')?.textContent || '🐍';
  const color = document.querySelector('#ns-color-row .sel')?.style.background || COLORS[0];
  const tags  = document.getElementById('ns-tags').value.split(',').map(t => t.trim()).filter(Boolean);

  const s = await api('/api/script', 'POST', { name, description: desc, folder_id: fid, icon, color, tags });
  state.scripts.push(s);
  closeModal('modal-new-script');
  render();
  toast(`✓ Скрипт «${name}» создан`);
  touchProject();
  openEditor(s.id);
}

// ── Create folder ────────────────────────────────────────────────
function openNewFolder(parentOverride) {
  buildIconPicker('nf-icon-row', FOLDER_ICONS, FOLDER_ICONS[0]);
  buildColorPicker('nf-color-row', COLORS, COLORS[1]);
  document.getElementById('nf-name').value = '';

  // Populate parent folder selector
  const sel = document.getElementById('nf-parent-folder');
  if (sel) {
    const activeFolderId = currentFolder || (currentFilter.startsWith('folder:') ? currentFilter.split(':')[1] : null);
    const preselect = parentOverride !== undefined ? parentOverride : (activeFolderId || '');
    sel.innerHTML = '<option value="">— Корневой уровень —</option>' +
      state.folders
        .filter(f => !trashedFolderIds.has(f.id))
        .map(f => {
          const path = getFolderPath(f.id).map(x => x.name).join(' / ');
          return `<option value="${f.id}">${f.icon} ${path}</option>`;
        }).join('');
    sel.value = preselect || '';
  }

  openModal('modal-new-folder');
  setTimeout(() => document.getElementById('nf-name').focus(), 120);
}

async function createFolder() {
  const name      = document.getElementById('nf-name').value.trim() || 'Новая папка';
  const icon      = document.querySelector('#nf-icon-row .sel')?.textContent || '📁';
  const color     = document.querySelector('#nf-color-row .sel')?.style.background || COLORS[1];
  const parentSel = document.getElementById('nf-parent-folder');
  const parent_id = parentSel ? (parentSel.value || null) : null;

  const f = await api('/api/folder', 'POST', { name, icon, color, parent_id });
  if (f.error) { toast('Ошибка: ' + f.error, 'err'); return; }
  state.folders.push(f);
  if (f.parent_id) openTreeNodes.add(f.parent_id); // auto-expand parent
  closeModal('modal-new-folder');
  render();
  toast(`✓ Папка «${name}» создана`);
  touchProject();
}

// ── Move script ───────────────────────────────────────────────────
function openMoveModal(id) {
  ctxTargetId = id;
  moveSel = null;
  const list = document.getElementById('move-folder-list');
  list.innerHTML = `
    <div class="move-folder-item${!moveSel?' sel':''}" onclick="selectMoveTarget(null,this)">
      <span class="mf-dot" style="background:var(--border2)"></span>
      <span class="mf-name">📄 Без папки (корень)</span>
    </div>` +
    state.folders.map(f => `
    <div class="move-folder-item" data-id="${f.id}" onclick="selectMoveTarget('${f.id}',this)">
      <span class="mf-dot" style="background:${f.color}"></span>
      <span class="mf-name">${f.icon} ${esc(f.name)}</span>
    </div>`).join('');
  openModal('modal-move');
}

function selectMoveTarget(fid, el) {
  moveSel = fid;
  document.querySelectorAll('.move-folder-item').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
}

async function confirmMove() {
  if (ctxTargetId === null) return;
  await api('/api/script/' + ctxTargetId, 'PUT', { folder_id: moveSel });
  const s = state.scripts.find(x => x.id === ctxTargetId);
  if (s) s.folder_id = moveSel;
  closeModal('modal-move');
  render();
  touchProject();
  toast('✓ Скрипт перемещён');
}

// ── Context Menus ────────────────────────────────────────────────
function positionCtxMenu(menu, e) {
  const w = menu.offsetWidth || 200;
  const h = menu.offsetHeight || 280;
  menu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + 'px';
  menu.style.top  = Math.min(e.clientY, window.innerHeight - h - 8) + 'px';
}

function hideCtx() {
  document.querySelectorAll('.ctx-menu.open').forEach(m => m.classList.remove('open'));
}

function showScriptCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  hideCtx();
  ctxTargetId = id;
  const m = document.getElementById('ctx-menu');
  m.classList.add('open');
  positionCtxMenu(m, e);
}

function showFolderCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  hideCtx();
  ctxFolderId = id;
  const m = document.getElementById('ctx-menu-folder');
  m.classList.add('open');
  positionCtxMenu(m, e);
}

function folderCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  showFolderCtx(e, id);
}

function onCanvasAreaContextMenu(e) {
  if (e.target.closest('.script-icon, .folder-icon, .list-item, .ctx-menu')) return;
  if (e.target.closest('#toolbar, .search-wrap, .view-btn, .sort-btn, #search-box')) return;
  onCanvasContextMenu(e);
}

function onCanvasContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  hideCtx();
  const m = document.getElementById('ctx-menu-canvas');
  const goRootItem = document.getElementById('canvas-ctx-goroot');
  if (goRootItem) goRootItem.classList.toggle('hidden', !currentFolder);
  m.classList.add('open');
  positionCtxMenu(m, e);
}

function folderCtxOpen() {
  hideCtx();
  if (ctxFolderId) openFolder(ctxFolderId);
}

function folderCtxNewSub() {
  hideCtx();
  openNewFolder(ctxFolderId);
}

function openRenameFolderModal() {
  hideCtx();
  const f = state.folders.find(x => x.id === ctxFolderId);
  if (!f) return;
  document.getElementById('rename-folder-name').value = f.name;
  buildIconPicker('rename-folder-icon-row', FOLDER_ICONS, f.icon || FOLDER_ICONS[0]);
  buildColorPicker('rename-folder-color-row', COLORS, f.color || COLORS[1]);
  openModal('modal-rename-folder');
  setTimeout(() => {
    const inp = document.getElementById('rename-folder-name');
    inp.focus();
    inp.select();
  }, 120);
}

async function confirmRenameFolder() {
  const name = document.getElementById('rename-folder-name').value.trim();
  if (!name) {
    toast('Введите название папки', 'err');
    return;
  }
  if (!ctxFolderId) return;
  const icon  = document.querySelector('#rename-folder-icon-row .sel')?.textContent || '📁';
  const color = document.querySelector('#rename-folder-color-row .sel')?.style.background || COLORS[1];
  await api('/api/folder/' + ctxFolderId, 'PUT', { name, icon, color });
  const f = state.folders.find(x => x.id === ctxFolderId);
  if (f) { f.name = name; f.icon = icon; f.color = color; }
  closeModal('modal-rename-folder');
  render();
  touchProject();
  toast('✓ Папка обновлена');
}

async function folderCtxDelete() {
  hideCtx();
  const id = ctxFolderId;
  const f = state.folders.find(x => x.id === id);
  if (!f) return;
  trashFolder(id);
}

function canvasCtxNewScript() { hideCtx(); openNewScript(); }
function canvasCtxNewFolder() {
  hideCtx();
  const activeFolderId = currentFolder || (currentFilter.startsWith('folder:') ? currentFilter.split(':')[1] : null);
  openNewFolder(activeFolderId);
}
function canvasCtxOpenProject() { hideCtx(); openProjectsModal(); }
function canvasCtxSaveProject() { hideCtx(); exportProject(); }
function canvasCtxGoRoot()     { hideCtx(); goRoot(); }
function canvasCtxRefresh()    { hideCtx(); render(); toast('Обновлено', 'info'); }

// Context menu actions
function ctxEdit()      { hideCtx(); openEditor(ctxTargetId); }
function ctxRun()       { hideCtx(); openEditor(ctxTargetId); switchWinTab('terminal', null); setTimeout(runScript, 100); }
function ctxAnalyze()   { hideCtx(); openEditor(ctxTargetId); switchWinTab('deps', null); }
function ctxMove()      { hideCtx(); openMoveModal(ctxTargetId); }
async function ctxPin() {
  hideCtx();
  const s = state.scripts.find(x => x.id === ctxTargetId);
  if (!s) return;
  await api('/api/script/' + ctxTargetId, 'PUT', { pinned: !s.pinned });
  s.pinned = !s.pinned;
  render();
  touchProject();
  toast(s.pinned ? '📌 Закреплён' : 'Откреплён');
}
async function ctxDup() {
  hideCtx();
  const s = state.scripts.find(x => x.id === ctxTargetId);
  if (!s) return;
  const copy = await api('/api/script', 'POST', { ...s, name: s.name + ' (копия)', id: undefined });
  state.scripts.push(copy);
  render();
  touchProject();
  toast('⎘ Скрипт скопирован');
}
function ctxCompile()   { hideCtx(); openEditor(ctxTargetId); compileScript(); }
async function ctxDelete() {
  hideCtx();
  trashScript(ctxTargetId);
}

// ── Project Save / Load ──────────────────────────────────────────
async function importProjectFromHandle(handle) {
  const file = await handle.getFile();
  const form = new FormData();
  form.append('file', file);
  const r = await fetch('/api/project/import', { method: 'POST', body: form });
  const data = await r.json();
  if (!data.ok) {
    toast('Ошибка: ' + (data.error || 'импорт'), 'err');
    return;
  }
  _projectFileHandle = handle;
  projectFileLabel = handle.name;
  await persistProjectFileHandle(handle);
  await addToRecentProjects(handle, data.name);
  state = await api('/api/state');
  document.getElementById('proj-name').value = state.project_name;
  closeEditor();
  render();
  updateProjectFileLabel();
  toast(`✓ Проект «${data.name}» открыт`);
  setProjectBaseline(handle.name);
}

async function importProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!(await confirmDiscardUnsaved())) {
    e.target.value = '';
    return;
  }
  const form = new FormData();
  form.append('file', file);
  const r = await fetch('/api/project/import', { method: 'POST', body: form });
  const data = await r.json();
  if (data.ok) {
    _projectFileHandle = null;
    await clearPersistedProjectFileHandle();
    projectFileLabel = file.name;
    addToRecentProjectsMeta(file, data.name);
    state = await api('/api/state');
    document.getElementById('proj-name').value = state.project_name;
    closeEditor();
    render();
    updateProjectFileLabel();
    toast(`✓ Проект «${data.name}» загружен (для автосохранения откройте через «Открыть» в Chrome/Edge)`);
    setProjectBaseline(file.name);
  } else {
    toast('Ошибка: ' + data.error, 'err');
  }
  e.target.value = '';
}

async function exportProject() {
  try {
    await api('/api/state', 'POST', {
      project_name: state.project_name,
      folders: state.folders,
      scripts: state.scripts,
      settings: state.settings,
    });
    const resp = await fetch('/api/project/export');
    const blob = await resp.blob();
    const projName = (state.project_name || 'project').replace(/[^a-zA-Z0-9_а-яА-ЯёЁ\-]/g, '_');

    if (_projectFileHandle) {
      const ok = await writeBlobToProjectFile(blob);
      if (ok) {
        projectFileLabel = _projectFileHandle.name || projectFileLabel;
        await addToRecentProjects(_projectFileHandle, state.project_name);
        updateProjectFileLabel();
        toast('💾 Сохранено в ' + (_projectFileHandle.name || 'файл'));
        setProjectBaseline(projectFileLabel || _projectFileHandle.name);
        return;
      }
      toast('Нет доступа к файлу — откройте проект заново', 'err');
      return;
    }

    if (window.showSaveFilePicker) {
      try {
        _projectFileHandle = await window.showSaveFilePicker({
          suggestedName: (projectFileLabel || projName).replace(/\.(pyvault|json)$/i, '') + '.pyvault',
          types: [{ description: 'PyVault Project', accept: { 'application/json': ['.pyvault'] } }],
        });
        const ok = await writeBlobToProjectFile(blob);
        if (!ok) {
          _projectFileHandle = null;
          toast('Не удалось записать файл', 'err');
          return;
        }
        projectFileLabel = _projectFileHandle.name;
        await persistProjectFileHandle(_projectFileHandle);
        await addToRecentProjects(_projectFileHandle, state.project_name);
        updateProjectFileLabel();
        toast('💾 Проект сохранён');
        setProjectBaseline(_projectFileHandle.name);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        _projectFileHandle = null;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = projName + '.pyvault';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    projectFileLabel = projName + '.pyvault';
    toast('💾 Файл скачан в папку загрузок');
    setProjectBaseline(projectFileLabel);
  } catch (e) {
    toast('Ошибка сохранения: ' + e.message, 'err');
  }
}

// ── View / Sort ──────────────────────────────────────────────────
function setView(v, btn) {
  currentView = v;
  localStorage.setItem('pyvault-view', v);
  document.querySelectorAll('.view-btn').forEach(x => x.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else {
    const b = document.getElementById('vbtn-' + v);
    if (b) b.classList.add('active');
  }
  renderCanvas();
}

function cycleSortMode() {
  const modes = ['modified', 'name', 'lines'];
  const labels = { modified: '⇅ Дата', name: '⇅ Имя', lines: '⇅ Строки' };
  sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
  document.getElementById('sort-btn').textContent = labels[sortMode];
  renderCanvas();
}

// ── Stats ────────────────────────────────────────────────────────
function updateStats() {
  const visScripts = state.scripts.filter(s => !trashedScriptIds.has(s.id));
  const visFolders = state.folders.filter(f => !trashedFolderIds.has(f.id));
  document.getElementById('stat-scripts').textContent = visScripts.length;
  document.getElementById('stat-folders').textContent = visFolders.length;
  const lines = visScripts.reduce((a, s) => a + (s.code||'').split('\n').length, 0);
  document.getElementById('stat-lines').textContent = lines > 999 ? (lines/1000).toFixed(1)+'k' : lines;
  document.getElementById('stat-run').textContent = document.querySelectorAll('.si-run-dot').length;
}

// ── Window Tabs ──────────────────────────────────────────────────
function switchWinTab(name, el) {
  document.querySelectorAll('.win-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  if (el) { el.classList.add('active'); }
  else {
    const t = document.querySelector(`.win-tab[data-tab="${name}"]`);
    if (t) t.classList.add('active');
  }
  const pane = document.getElementById('pane-' + name);
  if (pane) pane.classList.add('active');
  if (name === 'deps' && currentScriptId) loadDeps(currentScriptId);
  if (name === 'info' && currentScriptId) {
    const s = state.scripts.find(x => x.id === currentScriptId);
    if (s) renderInfoPane(s);
  }
}

// ── Modals ───────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Double-click outside modal to close (NOT single click)
document.querySelectorAll('.modal-back').forEach(b => {
  let clickCount = 0;
  let clickTimer = null;
  b.addEventListener('click', e => {
    if (e.target !== b) return; // only backdrop
    clickCount++;
    if (clickCount === 1) {
      clickTimer = setTimeout(() => { clickCount = 0; }, 400);
    } else if (clickCount >= 2) {
      clearTimeout(clickTimer);
      clickCount = 0;
      b.classList.remove('open');
    }
  });
});

// ── Icon / Color pickers ─────────────────────────────────────────
function buildIconPicker(containerId, icons, defaultIcon) {
  const c = document.getElementById(containerId);
  c.innerHTML = icons.map(ic =>
    `<div class="i-opt${ic === defaultIcon ? ' sel' : ''}"
      onclick="this.closest('.icon-row').querySelectorAll('.i-opt').forEach(x=>x.classList.remove('sel'));this.classList.add('sel')"
    >${ic}</div>`
  ).join('');
}

function buildColorPicker(containerId, colors, defaultColor) {
  const c = document.getElementById(containerId);
  c.innerHTML = colors.map(col =>
    `<div class="c-dot${col === defaultColor ? ' sel' : ''}" style="background:${col}"
      onclick="this.closest('.color-row').querySelectorAll('.c-dot').forEach(x=>x.classList.remove('sel'));this.classList.add('sel')"
    ></div>`
  ).join('');
}

// ── Keyboard ─────────────────────────────────────────────────────
function onGlobalKey(e) {
  // Block Ctrl+S entirely — never let browser save dialog open
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    exportProject();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'n' && !document.getElementById('editor-overlay').classList.contains('hidden') === false) {
      e.preventDefault(); openNewScript();
    }
    if (e.key === 'Enter' && !document.getElementById('editor-overlay').classList.contains('hidden')) {
      e.preventDefault(); runScript();
    }
    if (e.key === 'w') {
      e.preventDefault(); closeEditor();
    }
  }
  if (e.key === 'Escape') {
    hideCtx();
    if (_confirmResolver) { closeConfirm(false); return; }
    document.querySelectorAll('.modal-back.open').forEach(m => m.classList.remove('open'));
    hideCtx();
    if (!document.getElementById('editor-overlay').classList.contains('hidden') &&
        !document.querySelector('.modal-back.open')) {
      closeEditor();
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'ok') {
  const c = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'err' ? 'err' : type === 'info' ? 'info' : '');
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function shortPath(p) {
  if (!p) return '~';
  const norm = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(norm)) {
    const parts = norm.split('/').filter(Boolean);
    if (parts.length > 3) return parts[0] + '/…/' + parts.slice(-2).join('/');
    return p;
  }
  const parts = norm.split('/').filter(Boolean);
  if (parts.length > 3) return '/…/' + parts.slice(-2).join('/');
  return p;
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso);
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин. назад';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч. назад';
  return new Date(iso).toLocaleDateString('ru');
}

// ── Sidebar resize ───────────────────────────────────────────────
function initSidebarResize() {
  const handle  = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', e => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.classList.add('resizing-sidebar');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!isResizing) return;
    const w = Math.max(160, Math.min(420, startWidth + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    sidebar.style.minWidth = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.classList.remove('resizing-sidebar');
    localStorage.setItem('pyvault-sidebar-w', sidebar.offsetWidth);
  });

  // Restore saved width
  const saved = parseInt(localStorage.getItem('pyvault-sidebar-w') || '0');
  if (saved >= 160 && saved <= 420) {
    sidebar.style.width = saved + 'px';
    sidebar.style.minWidth = saved + 'px';
  }
}

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);