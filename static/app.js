/* ═══════════════════════════════════════════════════════════════
   PyVault — app.js
   ═══════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────
let state = { project_name: '', folders: [], scripts: [], settings: {} };
let currentScriptId = null;
let currentFolder    = null;   // null = root
let currentFilter    = 'all';  // all | pinned | folder:{id}
let currentView      = 'grid'; // grid | list
let sortMode         = 'modified';
let ctxTargetId      = null;
let dirPickerPath    = null;
let moveSel          = null;   // selected folder id in move modal
let logTimer         = null;
let logLastLen       = 0;

const COLORS = ['#00ff88','#00c8ff','#ff004d','#ffd700','#9d4edd','#ff6b35','#2ec4b6','#e63946','#06d6a0','#f72585'];
const SCRIPT_ICONS = ['🐍','⚡','🔧','🛠','📊','🤖','🧪','🔍','💡','🚀','🎯','🔑','📡','🧩','🌐','🔐','💾','📈','🗂','⚙'];
const FOLDER_ICONS = ['📁','📂','🗂','💼','🗃','📦','🎒','🏷','🧲','🔬'];

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  state = await api('/api/state');
  document.getElementById('proj-name').value = state.project_name || 'Мой Проект';
  document.getElementById('proj-name').addEventListener('input', e => {
    state.project_name = e.target.value;
    api('/api/state', 'POST', { project_name: e.target.value });
  });

  document.getElementById('import-input').addEventListener('change', importProject);
  document.addEventListener('click', hideCtx);
  document.addEventListener('keydown', onGlobalKey);

  render();
  setInterval(pollRunning, 1500);
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

// ── Render ───────────────────────────────────────────────────────
function render() {
  renderSidebar();
  renderCanvas();
  updateStats();
}

function renderSidebar() {
  const nav = document.getElementById('folders-nav');
  nav.innerHTML = state.folders.map(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id).length;
    return `<div class="nav-item${currentFilter==='folder:'+f.id?' active':''}"
      data-filter="folder:${f.id}"
      onclick="setFilter('folder:${f.id}',this)"
      oncontextmenu="folderCtx(event,'${f.id}')">
      <span class="folder-dot" style="background:${f.color}"></span>
      ${f.icon} ${esc(f.name)}
      <span class="nav-count">${cnt}</span>
    </div>`;
  }).join('');

  // counts
  document.getElementById('cnt-all').textContent = state.scripts.length;
  document.getElementById('cnt-pin').textContent = state.scripts.filter(s => s.pinned).length;
  document.getElementById('cnt-none').textContent = state.scripts.filter(s => !s.folder_id).length;

  // active state
  document.querySelectorAll('.nav-item[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === currentFilter);
  });
}

function renderCanvas() {
  const c = document.getElementById('canvas');

  // Breadcrumb
  const bc = document.getElementById('breadcrumb');
  if (currentFolder) {
    const f = state.folders.find(x => x.id === currentFolder);
    bc.innerHTML = `<span class="bc-item" onclick="goRoot()">🏠 Все</span>
      <span class="bc-sep">›</span>
      <span class="bc-current">${f ? f.icon+' '+esc(f.name) : '?'}</span>`;
  } else {
    bc.innerHTML = '';
  }

  const q = document.getElementById('search-box').value.toLowerCase();

  // Filter scripts
  let scripts = state.scripts.filter(s => {
    // When browsing a specific folder (double-clicked)
    if (currentFolder !== null) return s.folder_id === currentFolder;

    if (currentFilter === 'pinned') return s.pinned;
    if (currentFilter === 'none')   return !s.folder_id;
    if (currentFilter.startsWith('folder:')) {
      return s.folder_id === currentFilter.split(':')[1];
    }
    // 'all' filter at root: hide scripts that belong to a folder
    if (currentFilter === 'all') return !s.folder_id;

    if (q) {
      return s.name.toLowerCase().includes(q) ||
        (s.description||'').toLowerCase().includes(q) ||
        (s.tags||[]).some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  // Apply search query on top of filter
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

  // Folders to show (only when in root / all-scripts view)
  let folders = [];
  if (!currentFolder && currentFilter === 'all' && !q) {
    folders = state.folders;
  }

  if (!scripts.length && !folders.length) {
    c.innerHTML = `<div class="empty">
      <div class="empty-emoji">🐍</div>
      <div class="empty-title">Ничего нет</div>
      <div class="empty-sub">${q ? 'По запросу «'+esc(q)+'» ничего не найдено' : 'Нажмите «＋ Скрипт» чтобы начать'}</div>
    </div>`;
    return;
  }

  if (currentView === 'grid') {
    renderGrid(c, folders, scripts);
  } else {
    renderList(c, folders, scripts);
  }
}

function renderGrid(c, folders, scripts) {
  let html = '<div class="icon-grid">';

  // Folders as Windows-style icons
  folders.forEach(f => {
    const cnt = state.scripts.filter(s => s.folder_id === f.id).length;
    html += `<div class="folder-icon" data-id="${f.id}"
      ondblclick="openFolder('${f.id}')"
      onclick="selectItem(event,'f:${f.id}',this)"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="fi-body" style="--fi-color:${f.color}">
        <div class="fi-tab"></div>
        <div class="fi-face">${f.icon}</div>
      </div>
      <div class="fi-name">${esc(f.name)}</div>
      <div class="fi-count">${cnt} скрипт${cnt===1?'':'ов'}</div>
    </div>`;
  });

  // Pinned scripts first
  const pinned = scripts.filter(s => s.pinned);
  const rest   = scripts.filter(s => !s.pinned);
  [...pinned, ...rest].forEach(s => {
    html += scriptIconHtml(s);
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
    const cnt = state.scripts.filter(s => s.folder_id === f.id).length;
    html += `<div class="list-item folder-row" ondblclick="openFolder('${f.id}')"
      oncontextmenu="showFolderCtx(event,'${f.id}')">
      <div class="li-icon">${f.icon}</div>
      <div style="width:10px;height:10px;border-radius:50%;background:${f.color};flex-shrink:0"></div>
      <div class="li-info">
        <div class="li-name">${esc(f.name)}</div>
        <div class="li-meta">${cnt} скриптов</div>
      </div>
    </div>`;
  });
  scripts.forEach(s => {
    html += `<div class="list-item" data-id="${s.id}" style="--item-color:${s.color||'var(--accent)'}"
      ondblclick="openEditor('${s.id}')"
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
  document.querySelectorAll('.script-icon').forEach(el => {
    el.draggable = true;
    el.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('scriptId', el.dataset.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
  });
  document.querySelectorAll('.folder-icon').forEach(el => {
    el.addEventListener('dragover', ev => { ev.preventDefault(); el.classList.add('selected'); });
    el.addEventListener('dragleave', () => el.classList.remove('selected'));
    el.addEventListener('drop', async ev => {
      ev.preventDefault();
      el.classList.remove('selected');
      const sid = ev.dataTransfer.getData('scriptId');
      if (!sid) return;
      const fid = el.dataset.id;
      await api('/api/script/' + sid, 'PUT', { folder_id: fid });
      const s = state.scripts.find(x => x.id === sid);
      if (s) s.folder_id = fid;
      render();
      toast(`Перемещён в папку`);
    });
  });
}

// ── Editor ───────────────────────────────────────────────────────
function openEditor(id) {
  currentScriptId = id;
  const s = state.scripts.find(x => x.id === id);
  if (!s) return;

  document.getElementById('win-title').textContent = (s.icon||'🐍') + ' ' + s.name;
  document.getElementById('code-editor').value = s.code || '';
  document.getElementById('run-dir-label').textContent = shortPath(s.run_dir || '~');
  document.getElementById('editor-overlay').classList.remove('hidden');

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
  lnBox.scrollTop = editor.scrollTop;
}

// ── Code change ──────────────────────────────────────────────────
function onCodeChange() {
  updateLineNumbers();
  updateStatusBar();
  clearTimeout(window._saveTimer);
  window._saveTimer = setTimeout(async () => {
    if (!currentScriptId) return;
    const code = document.getElementById('code-editor').value;
    await api('/api/script/' + currentScriptId, 'PUT', { code });
    const s = state.scripts.find(x => x.id === currentScriptId);
    if (s) { s.code = code; updateStats(); }
    loadDeps(currentScriptId);
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

  clearTerminal();
  addTermLine(`> python ${s.name}`, 'sys');
  switchWinTab('terminal', null);

  const res = await api('/api/script/' + currentScriptId + '/run', 'POST', { run_dir: s.run_dir });
  if (res.error) { addTermLine('Ошибка: ' + res.error, 'err'); return; }

  btn.innerHTML = '⏹ Остановить';
  btn.classList.add('stopping');
  logLastLen = 0;
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
  if (!data.running) {
    addTermLine('— Завершено —', 'sys');
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

function addTermLine(text, cls = '') {
  const out = document.getElementById('terminal-out');
  const d = document.createElement('div');
  d.className = 'tl ' + cls;
  d.textContent = text;
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
  openEditor(id);
  setTimeout(() => {
    switchWinTab('terminal', null);
    setTimeout(runScript, 50);
  }, 80);
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
async function openDirPicker() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  dirPickerPath = s ? (s.run_dir || '/') : '/';
  await loadDir(dirPickerPath);
  openModal('modal-dir');
}

async function loadDir(path) {
  const data = await api('/api/ls?path=' + encodeURIComponent(path));
  if (data.error) { toast(data.error, 'err'); return; }
  dirPickerPath = data.path;
  document.getElementById('dir-current').textContent = data.path;
  const list = document.getElementById('dir-list');
  list.innerHTML = `<div class="dir-item" onclick="loadDir(${JSON.stringify(data.parent)})">⬆ ..</div>` +
    data.items.filter(i => i.is_dir).map(i =>
      `<div class="dir-item" onclick="loadDir(${JSON.stringify(i.path)})">📁 ${esc(i.name)}</div>`
    ).join('');
}

async function selectDir() {
  if (!currentScriptId || !dirPickerPath) return;
  await api('/api/script/' + currentScriptId, 'PUT', { run_dir: dirPickerPath });
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s) s.run_dir = dirPickerPath;
  document.getElementById('run-dir-label').textContent = shortPath(dirPickerPath);
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
  openModal('modal-compile');
}

async function startCompile() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  const buildType = document.getElementById('compile-build-onefile').checked ? 'onefile' : 'onedir';

  document.getElementById('compile-status').textContent = `Компилирую: ${s.name}...`;
  document.getElementById('compile-log').textContent = 'Запускаю PyInstaller...\nЭто может занять минуту.';
  document.getElementById('compile-close-btn').disabled = true;
  document.getElementById('compile-start-btn').disabled = true;

  try {
    const payload = { build_type: buildType };
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
      a.download = disp.match(/filename="?([^"]+)"?/)?.[1] || s.name;
      a.click();
      document.getElementById('compile-status').textContent = '✓ Готово! Файл скачан.';
      document.getElementById('compile-log').textContent = buildType === 'onefile'
        ? 'EXE успешно создан.' : 'Папка упакована в ZIP.';
    } else {
      const err = await resp.json();
      document.getElementById('compile-status').textContent = '✗ Ошибка компиляции';
      document.getElementById('compile-log').textContent = err.output || err.error || 'Неизвестная ошибка';
    }
  } catch(e) {
    document.getElementById('compile-status').textContent = '✗ Ошибка';
    document.getElementById('compile-log').textContent = e.message;
  }
  document.getElementById('compile-close-btn').disabled = false;
  document.getElementById('compile-start-btn').disabled = false;
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
    html += `<div class="dep-group-title">📦 Сторонние пакеты</div>`;
    data.third_party.forEach(pkg => {
      const ok = data.dep_status[pkg];
      html += `<div class="dep-row">
        <span class="dep-icon">📦</span>
        <span class="dep-name">${esc(pkg)}</span>
        <span class="dep-badge ${ok?'ok':'missing'}">${ok?'✓ есть':'✗ нет'}</span>
        ${!ok?`<button class="install-btn" onclick="installPkg('${esc(pkg)}')">pip install</button>`:''}
      </div>`;
    });
  }
  if (data.std_libs.length) {
    html += `<div class="dep-group-title">🐍 Стандартная библиотека</div>`;
    data.std_libs.forEach(pkg => {
      html += `<div class="dep-row"><span class="dep-icon">🐍</span><span class="dep-name">${esc(pkg)}</span><span class="dep-badge stdlib">stdlib</span></div>`;
    });
  }
  if (data.functions.length || data.classes.length) {
    html += `<div class="dep-group-title">🏗 Структура кода</div>`;
    if (data.classes.length) {
      html += `<div class="dep-row"><span class="dep-icon">🧱</span><span class="dep-name">Классы</span>
        <div class="fn-chips">${data.classes.map(x=>`<span class="fn-chip">${esc(x)}</span>`).join('')}</div></div>`;
    }
    if (data.functions.length) {
      html += `<div class="dep-row"><span class="dep-icon">⚡</span><span class="dep-name">Функции</span>
        <div class="fn-chips">${data.functions.map(x=>`<span class="fn-chip">${esc(x)}</span>`).join('')}</div></div>`;
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
}

// ── Create script ────────────────────────────────────────────────
function openNewScript() {
  // Populate folder select
  const sel = document.getElementById('ns-folder');
  sel.innerHTML = '<option value="">— Без папки —</option>' +
    state.folders.map(f => `<option value="${f.id}">${f.icon} ${esc(f.name)}</option>`).join('');
  // Preselect current folder
  if (currentFolder) sel.value = currentFolder;

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
  openEditor(s.id);
}

// ── Create folder ────────────────────────────────────────────────
function openNewFolder() {
  buildIconPicker('nf-icon-row', FOLDER_ICONS, FOLDER_ICONS[0]);
  buildColorPicker('nf-color-row', COLORS, COLORS[1]);
  document.getElementById('nf-name').value = '';
  openModal('modal-new-folder');
  setTimeout(() => document.getElementById('nf-name').focus(), 120);
}

async function createFolder() {
  const name  = document.getElementById('nf-name').value.trim() || 'Новая папка';
  const icon  = document.querySelector('#nf-icon-row .sel')?.textContent || '📁';
  const color = document.querySelector('#nf-color-row .sel')?.style.background || COLORS[1];
  const f = await api('/api/folder', 'POST', { name, icon, color });
  state.folders.push(f);
  closeModal('modal-new-folder');
  render();
  toast(`✓ Папка «${name}» создана`);
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
  toast('✓ Скрипт перемещён');
}

// ── Context Menus ────────────────────────────────────────────────
function showScriptCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  ctxTargetId = id;
  const m = document.getElementById('ctx-menu');
  m.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  m.style.top  = Math.min(e.clientY, window.innerHeight - 280) + 'px';
  m.classList.add('open');
}

function showFolderCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  // Simple inline folder menu
  if (confirm(`Удалить папку? Скрипты останутся в корне.`)) {
    api('/api/folder/' + id, 'DELETE').then(() => {
      state.folders = state.folders.filter(f => f.id !== id);
      state.scripts.forEach(s => { if (s.folder_id === id) s.folder_id = null; });
      render();
      toast('Папка удалена');
    });
  }
}

function folderCtx(e, id) {
  e.preventDefault();
  e.stopPropagation();
  showFolderCtx(e, id);
}

function hideCtx() { document.getElementById('ctx-menu').classList.remove('open'); }

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
  render(); toast(s.pinned ? '📌 Закреплён' : 'Откреплён');
}
async function ctxDup() {
  hideCtx();
  const s = state.scripts.find(x => x.id === ctxTargetId);
  if (!s) return;
  const copy = await api('/api/script', 'POST', { ...s, name: s.name + ' (копия)', id: undefined });
  state.scripts.push(copy);
  render(); toast('⎘ Скрипт скопирован');
}
function ctxCompile()   { hideCtx(); openEditor(ctxTargetId); compileScript(); }
async function ctxDelete() {
  hideCtx();
  if (!confirm('Удалить скрипт?')) return;
  await api('/api/script/' + ctxTargetId, 'DELETE');
  state.scripts = state.scripts.filter(s => s.id !== ctxTargetId);
  if (currentScriptId === ctxTargetId) closeEditor();
  render(); toast('Удалено', 'err');
}

// ── Project Save / Load ──────────────────────────────────────────
function exportProject() {
  window.location.href = '/api/project/export';
  toast('💾 Проект сохранён');
}

async function importProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  const r = await fetch('/api/project/import', { method: 'POST', body: form });
  const data = await r.json();
  if (data.ok) {
    state = await api('/api/state');
    document.getElementById('proj-name').value = state.project_name;
    closeEditor();
    render();
    toast(`✓ Проект «${data.name}» загружен`);
  } else {
    toast('Ошибка: ' + data.error, 'err');
  }
  e.target.value = '';
}

// ── View / Sort ──────────────────────────────────────────────────
function setView(v, btn) {
  currentView = v;
  document.querySelectorAll('.view-btn').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
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
  document.getElementById('stat-scripts').textContent = state.scripts.length;
  document.getElementById('stat-folders').textContent = state.folders.length;
  const lines = state.scripts.reduce((a, s) => a + (s.code||'').split('\n').length, 0);
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

document.querySelectorAll('.modal-back').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('open'); });
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
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'n' && !document.getElementById('editor-overlay').classList.contains('hidden') === false) {
      e.preventDefault(); openNewScript();
    }
    if (e.key === 's') { e.preventDefault(); exportProject(); }
    if (e.key === 'Enter' && !document.getElementById('editor-overlay').classList.contains('hidden')) {
      e.preventDefault(); runScript();
    }
    if (e.key === 'w') {
      e.preventDefault(); closeEditor();
    }
  }
  if (e.key === 'Escape') {
    hideCtx();
    document.querySelectorAll('.modal-back.open').forEach(m => m.classList.remove('open'));
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
  const home = '/root';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  const parts = p.split('/').filter(Boolean);
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

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);