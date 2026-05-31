#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
██████╗ ██╗   ██╗██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗
██╔══██╗╚██╗ ██╔╝██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝
██████╔╝ ╚████╔╝ ██║   ██║███████║██║   ██║██║     ██║
██╔═══╝   ╚██╔╝  ╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║
██║        ██║    ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║
╚═╝        ╚═╝     ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝

PyVault — Хранилище Python-скриптов
Запустите и откройте http://localhost:7331 в браузере
"""

import os, sys, json, ast, subprocess, threading, zipfile, base64
import hashlib, shutil, re, time, signal
from pathlib import Path
from datetime import datetime
from flask import Flask, request, jsonify, render_template_string, send_file
import io

app = Flask(__name__)
app.config['SECRET_KEY'] = 'pyvault-secret-2024'

# ─── Состояние приложения ────────────────────────────────────────────────────
vault_state = {
    "project_name": "Мой Проект",
    "folders": [],          # [{id, name, color, icon}]
    "scripts": [],          # [{id, name, code, folder_id, tags, created, modified, color, icon, description, run_dir, pinned}]
    "settings": {
        "theme": "dark",
        "accent": "#00ff88",
        "font_size": 14,
        "auto_save": True
    }
}

run_processes = {}   # id → subprocess
run_logs = {}        # id → [lines]

# ─── Утилиты ─────────────────────────────────────────────────────────────────

def gen_id():
    return hashlib.md5(str(time.time_ns()).encode()).hexdigest()[:8]

def analyze_script(code: str) -> dict:
    """Анализирует зависимости, функции, классы скрипта через AST."""
    imports = []
    std_libs = set()
    third_party = set()
    functions = []
    classes = []
    lines = len(code.splitlines())
    errors = []

    # Стандартные библиотеки Python
    STDLIB = {
        'os','sys','re','json','math','time','datetime','random','string',
        'collections','itertools','functools','pathlib','shutil','copy',
        'threading','multiprocessing','subprocess','socket','ssl','http',
        'urllib','email','html','xml','csv','io','struct','hashlib','hmac',
        'base64','codecs','pickle','shelve','sqlite3','logging','unittest',
        'argparse','configparser','contextlib','abc','dataclasses','typing',
        'enum','decimal','fractions','statistics','array','queue','heapq',
        'bisect','pprint','textwrap','difflib','traceback','warnings','gc',
        'inspect','ast','dis','tokenize','keyword','builtins','importlib',
        'pkgutil','zipfile','tarfile','gzip','bz2','lzma','tempfile',
        'glob','fnmatch','fileinput','stat','platform','signal','atexit',
        'weakref','types','operator','linecache','site','sysconfig','zipimport'
    }

    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.name.split('.')[0]
                    imports.append(name)
                    if name in STDLIB:
                        std_libs.add(name)
                    else:
                        third_party.add(name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    name = node.module.split('.')[0]
                    imports.append(name)
                    if name in STDLIB:
                        std_libs.add(name)
                    else:
                        third_party.add(name)
            elif isinstance(node, ast.FunctionDef):
                if node.col_offset == 0:
                    functions.append(node.name)
            elif isinstance(node, ast.ClassDef):
                classes.append(node.name)
    except SyntaxError as e:
        errors.append(f"Синтаксическая ошибка: строка {e.lineno} — {e.msg}")
    except Exception as e:
        errors.append(str(e))

    return {
        "imports": sorted(set(imports)),
        "std_libs": sorted(std_libs),
        "third_party": sorted(third_party),
        "functions": functions,
        "classes": classes,
        "lines": lines,
        "errors": errors,
        "complexity": "низкая" if lines < 50 else "средняя" if lines < 200 else "высокая"
    }

def check_installed(package: str) -> bool:
    try:
        result = subprocess.run(
            [sys.executable, "-c", f"import {package}"],
            capture_output=True, timeout=5
        )
        return result.returncode == 0
    except:
        return False

# ─── API Маршруты ─────────────────────────────────────────────────────────────

@app.route('/api/state', methods=['GET'])
def get_state():
    return jsonify(vault_state)

@app.route('/api/state', methods=['POST'])
def update_state():
    data = request.json
    vault_state.update(data)
    return jsonify({"ok": True})

@app.route('/api/script', methods=['POST'])
def create_script():
    data = request.json
    script = {
        "id": gen_id(),
        "name": data.get("name", "Новый скрипт"),
        "code": data.get("code", "# Новый скрипт\nprint('Привет, мир!')\n"),
        "folder_id": data.get("folder_id", None),
        "tags": data.get("tags", []),
        "description": data.get("description", ""),
        "color": data.get("color", "#00ff88"),
        "icon": data.get("icon", "🐍"),
        "run_dir": data.get("run_dir", str(Path.home())),
        "pinned": False,
        "created": datetime.now().isoformat(),
        "modified": datetime.now().isoformat(),
    }
    vault_state["scripts"].append(script)
    return jsonify(script)

@app.route('/api/script/<sid>', methods=['PUT'])
def update_script(sid):
    data = request.json
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            s.update(data)
            s["modified"] = datetime.now().isoformat()
            return jsonify(s)
    return jsonify({"error": "Не найден"}), 404

@app.route('/api/script/<sid>', methods=['DELETE'])
def delete_script(sid):
    vault_state["scripts"] = [s for s in vault_state["scripts"] if s["id"] != sid]
    return jsonify({"ok": True})

@app.route('/api/script/<sid>/analyze', methods=['GET'])
def analyze(sid):
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            result = analyze_script(s["code"])
            # Проверяем что установлено
            dep_status = {}
            for pkg in result["third_party"]:
                dep_status[pkg] = check_installed(pkg)
            result["dep_status"] = dep_status
            return jsonify(result)
    return jsonify({"error": "Не найден"}), 404

@app.route('/api/script/<sid>/run', methods=['POST'])
def run_script(sid):
    data = request.json or {}
    run_dir = data.get("run_dir")
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            if run_dir is None:
                run_dir = s.get("run_dir", str(Path.home()))

            # Сохраняем во временный файл
            tmp = Path(f"/tmp/pyvault_{sid}.py")
            tmp.write_text(s["code"], encoding='utf-8')

            run_logs[sid] = []
            try:
                proc = subprocess.Popen(
                    [sys.executable, str(tmp)],
                    cwd=run_dir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1
                )
                run_processes[sid] = proc

                def reader():
                    for line in proc.stdout:
                        run_logs.setdefault(sid, []).append(line.rstrip('\n'))
                        if len(run_logs[sid]) > 500:
                            run_logs[sid] = run_logs[sid][-500:]
                    proc.wait()

                threading.Thread(target=reader, daemon=True).start()
                return jsonify({"ok": True, "pid": proc.pid})
            except Exception as e:
                return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Не найден"}), 404

@app.route('/api/script/<sid>/stop', methods=['POST'])
def stop_script(sid):
    if sid in run_processes:
        try:
            run_processes[sid].terminate()
            del run_processes[sid]
        except:
            pass
    return jsonify({"ok": True})

@app.route('/api/script/<sid>/logs', methods=['GET'])
def get_logs(sid):
    logs = run_logs.get(sid, [])
    running = sid in run_processes and run_processes[sid].poll() is None
    return jsonify({"logs": logs, "running": running})

@app.route('/api/install', methods=['POST'])
def install_package():
    data = request.json
    pkg = data.get("package", "")
    if not re.match(r'^[a-zA-Z0-9_\-\[\]>=<\.]+$', pkg):
        return jsonify({"error": "Недопустимое имя пакета"}), 400

    def do_install():
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", pkg, "--break-system-packages"],
            capture_output=True, text=True, timeout=120
        )
        return result.stdout + result.stderr

    try:
        output = do_install()
        return jsonify({"ok": True, "output": output})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/folder', methods=['POST'])
def create_folder():
    data = request.json
    folder = {
        "id": gen_id(),
        "name": data.get("name", "Новая папка"),
        "color": data.get("color", "#6366f1"),
        "icon": data.get("icon", "📁"),
        "created": datetime.now().isoformat()
    }
    vault_state["folders"].append(folder)
    return jsonify(folder)

@app.route('/api/folder/<fid>', methods=['PUT'])
def update_folder(fid):
    data = request.json
    for f in vault_state["folders"]:
        if f["id"] == fid:
            f.update(data)
            return jsonify(f)
    return jsonify({"error": "Не найдена"}), 404

@app.route('/api/folder/<fid>', methods=['DELETE'])
def delete_folder(fid):
    vault_state["folders"] = [f for f in vault_state["folders"] if f["id"] != fid]
    for s in vault_state["scripts"]:
        if s.get("folder_id") == fid:
            s["folder_id"] = None
    return jsonify({"ok": True})

@app.route('/api/project/export', methods=['GET'])
def export_project():
    buf = io.BytesIO()
    data = json.dumps(vault_state, ensure_ascii=False, indent=2)
    buf.write(data.encode('utf-8'))
    buf.seek(0)
    name = vault_state.get("project_name", "project").replace(" ", "_")
    return send_file(buf, mimetype='application/json',
                     as_attachment=True,
                     download_name=f"{name}.pyvault")

@app.route('/api/project/import', methods=['POST'])
def import_project():
    global vault_state
    if 'file' not in request.files:
        return jsonify({"error": "Нет файла"}), 400
    f = request.files['file']
    try:
        data = json.loads(f.read().decode('utf-8'))
        vault_state.update(data)
        return jsonify({"ok": True, "name": vault_state.get("project_name")})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/api/compile/<sid>', methods=['POST'])
def compile_to_exe(sid):
    data = request.json or {}
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            tmp_dir = Path(f"/tmp/pyvault_compile_{sid}")
            tmp_dir.mkdir(exist_ok=True)
            py_file = tmp_dir / f"{s['name'].replace(' ','_')}.py"
            py_file.write_text(s["code"], encoding='utf-8')

            result = subprocess.run(
                [sys.executable, "-m", "PyInstaller",
                 "--onefile", "--distpath", str(tmp_dir / "dist"),
                 "--workpath", str(tmp_dir / "build"),
                 "--specpath", str(tmp_dir),
                 str(py_file)],
                capture_output=True, text=True, timeout=300
            )
            output = result.stdout[-3000:] + result.stderr[-1000:]

            exe_name = s['name'].replace(' ','_')
            exe_path = tmp_dir / "dist" / exe_name
            if not exe_path.exists():
                exe_path = tmp_dir / "dist" / (exe_name + ".exe")

            if exe_path.exists():
                return send_file(str(exe_path), as_attachment=True,
                                 download_name=exe_path.name)
            else:
                return jsonify({"error": "Компиляция не удалась", "output": output}), 500
    return jsonify({"error": "Не найден"}), 404

@app.route('/api/ls', methods=['GET'])
def list_dir():
    path = request.args.get("path", str(Path.home()))
    try:
        p = Path(path)
        items = []
        for item in sorted(p.iterdir()):
            items.append({
                "name": item.name,
                "path": str(item),
                "is_dir": item.is_dir()
            })
        return jsonify({"path": str(p), "parent": str(p.parent), "items": items})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ─── Главная страница ─────────────────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PyVault — Хранилище скриптов</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,600;0,800;1,300&family=Unbounded:wght@300;400;700;900&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #080b10;
  --bg2: #0d1117;
  --bg3: #161b22;
  --bg4: #1c2230;
  --border: #21262d;
  --border2: #30363d;
  --accent: #00ff88;
  --accent2: #00c8ff;
  --accent3: #ff006e;
  --text: #e6edf3;
  --text2: #8b949e;
  --text3: #484f58;
  --font-mono: 'JetBrains Mono', monospace;
  --font-head: 'Unbounded', sans-serif;
  --radius: 10px;
  --glow: 0 0 20px rgba(0,255,136,0.15);
  --glow2: 0 0 40px rgba(0,255,136,0.08);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
  overflow: hidden;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* Animated background grid */
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image:
    linear-gradient(rgba(0,255,136,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,255,136,0.03) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
}

/* ── TITLEBAR ── */
#titlebar {
  height: 52px;
  background: rgba(13,17,23,0.95);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 12px;
  flex-shrink: 0;
  z-index: 100;
  position: relative;
}
#titlebar::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0.4;
}

.logo {
  font-family: var(--font-head);
  font-weight: 900;
  font-size: 15px;
  letter-spacing: -0.5px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  white-space: nowrap;
}

.logo-version {
  font-size: 9px;
  color: var(--text3);
  font-family: var(--font-mono);
  margin-left: -6px;
}

.titlebar-actions { display: flex; gap: 6px; margin-left: auto; align-items: center; }

.tb-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 6px;
  color: var(--text2);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.tb-btn:hover { border-color: var(--accent); color: var(--accent); }
.tb-btn.primary {
  background: rgba(0,255,136,0.08);
  border-color: var(--accent);
  color: var(--accent);
}
.tb-btn.primary:hover { background: rgba(0,255,136,0.18); box-shadow: var(--glow); }

#project-name-input {
  background: transparent;
  border: none;
  color: var(--text2);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  transition: all 0.2s;
  width: 160px;
}
#project-name-input:hover, #project-name-input:focus {
  background: var(--bg3);
  color: var(--text);
  outline: 1px solid var(--border2);
}

/* ── LAYOUT ── */
#main {
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* ── SIDEBAR ── */
#sidebar {
  width: 220px;
  background: rgba(13,17,23,0.8);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}

.sidebar-section {
  padding: 12px 12px 6px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: var(--text3);
  text-transform: uppercase;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sidebar-add-btn {
  background: none; border: none;
  color: var(--text3); cursor: pointer;
  font-size: 14px; line-height: 1;
  transition: color 0.2s;
  padding: 2px;
}
.sidebar-add-btn:hover { color: var(--accent); }

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin: 1px 6px;
  color: var(--text2);
  font-size: 12px;
  transition: all 0.15s;
  position: relative;
  user-select: none;
}
.nav-item:hover { background: var(--bg3); color: var(--text); }
.nav-item.active {
  background: rgba(0,255,136,0.08);
  color: var(--accent);
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  transform: translateY(-50%);
  width: 3px; height: 60%;
  background: var(--accent);
  border-radius: 0 3px 3px 0;
}
.nav-count {
  margin-left: auto;
  background: var(--bg4);
  color: var(--text3);
  font-size: 9px;
  padding: 2px 5px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}
.nav-item.active .nav-count {
  background: rgba(0,255,136,0.15);
  color: var(--accent);
}

.folder-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

#sidebar-bottom {
  margin-top: auto;
  padding: 12px;
  border-top: 1px solid var(--border);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 8px;
}
.stat-item {
  background: var(--bg3);
  border-radius: 6px;
  padding: 8px;
  text-align: center;
}
.stat-val {
  font-family: var(--font-head);
  font-size: 16px;
  font-weight: 700;
  color: var(--accent);
}
.stat-lbl {
  font-size: 9px;
  color: var(--text3);
  margin-top: 1px;
}

/* ── CONTENT ── */
#content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── TOOLBAR ── */
#toolbar {
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(13,17,23,0.6);
  flex-shrink: 0;
}

#search-box {
  flex: 1;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 8px;
  padding: 6px 12px 6px 32px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  transition: all 0.2s;
  position: relative;
}
.search-wrap { position: relative; flex: 1; }
.search-wrap::before {
  content: '⌕';
  position: absolute;
  left: 10px; top: 50%;
  transform: translateY(-50%);
  color: var(--text3);
  font-size: 14px;
  pointer-events: none;
}
#search-box:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0,255,136,0.08);
}

.view-toggle { display: flex; gap: 3px; }
.view-btn {
  padding: 5px 8px;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 5px;
  color: var(--text3);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}
.view-btn:hover, .view-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(0,255,136,0.05);
}

/* ── GRID / CANVAS ── */
#canvas-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px;
}

#canvas-area::-webkit-scrollbar { width: 5px; }
#canvas-area::-webkit-scrollbar-track { background: transparent; }
#canvas-area::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

.scripts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 14px;
}

/* ── SCRIPT CARD ── */
.script-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: none;
}
.script-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--card-color, var(--accent)) 0%, transparent 60%);
  opacity: 0.04;
  transition: opacity 0.2s;
}
.script-card:hover {
  transform: translateY(-3px) scale(1.02);
  border-color: var(--card-color, var(--accent));
  box-shadow: 0 8px 30px rgba(0,0,0,0.4), 0 0 0 1px var(--card-color, var(--accent)) inset;
}
.script-card:hover::before { opacity: 0.1; }
.script-card.pinned {
  border-color: rgba(255,200,0,0.4);
}
.script-card.pinned::after {
  content: '📌';
  position: absolute;
  top: 6px; right: 6px;
  font-size: 10px;
}

.card-icon {
  font-size: 28px;
  line-height: 1;
  transition: transform 0.2s;
}
.script-card:hover .card-icon { transform: scale(1.15) rotate(-5deg); }

.card-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-desc {
  font-size: 10px;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
}
.card-tag {
  font-size: 9px;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--bg4);
  color: var(--text3);
  border: 1px solid var(--border);
}
.card-lines {
  margin-left: auto;
  font-size: 9px;
  color: var(--text3);
}

.card-actions {
  position: absolute;
  top: 6px; right: 6px;
  display: none;
  gap: 4px;
}
.script-card:hover .card-actions { display: flex; }
.card-act-btn {
  background: var(--bg4);
  border: 1px solid var(--border2);
  border-radius: 5px;
  color: var(--text2);
  font-size: 11px;
  width: 22px; height: 22px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.card-act-btn:hover { border-color: var(--accent); color: var(--accent); }
.card-act-btn.run:hover { border-color: #00ff88; color: #00ff88; }
.card-act-btn.del:hover { border-color: var(--accent3); color: var(--accent3); }

/* Running pulse */
.card-running {
  position: absolute;
  bottom: 6px; right: 6px;
  width: 8px; height: 8px;
  background: var(--accent);
  border-radius: 50%;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.4); }
}

/* ── DROP ZONE ── */
.folder-drop-zone {
  border: 2px dashed var(--border2);
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  color: var(--text3);
  font-size: 11px;
  margin-bottom: 14px;
  transition: all 0.2s;
}
.folder-drop-zone.drag-over {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(0,255,136,0.04);
}

.folder-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text2);
  margin-bottom: 10px;
  padding: 4px 0;
  cursor: pointer;
  user-select: none;
}
.folder-label:hover { color: var(--text); }
.folder-label .toggle-icon { font-size: 9px; transition: transform 0.2s; }
.folder-label.collapsed .toggle-icon { transform: rotate(-90deg); }

/* ── PANEL SLIDE ── */
#right-panel {
  width: 440px;
  background: var(--bg2);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
#right-panel.hidden { width: 0; border-left-width: 0; }

.panel-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg3);
  flex-shrink: 0;
}
.panel-title {
  font-family: var(--font-head);
  font-size: 12px;
  font-weight: 700;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.panel-close {
  background: none; border: none;
  color: var(--text3); cursor: pointer;
  font-size: 16px; line-height: 1;
  transition: color 0.2s;
}
.panel-close:hover { color: var(--accent3); }

.panel-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.panel-tab {
  padding: 8px 14px;
  font-size: 11px;
  cursor: pointer;
  color: var(--text3);
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  white-space: nowrap;
}
.panel-tab:hover { color: var(--text); }
.panel-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.panel-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tab-pane { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.tab-pane.active { display: flex; }

/* ── CODE EDITOR ── */
#editor-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--bg);
}

#code-editor {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  background: transparent;
  color: #e6edf3;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  padding: 14px;
  padding-left: 52px;
  border: none;
  resize: none;
  outline: none;
  tab-size: 4;
  caret-color: var(--accent);
  z-index: 2;
  white-space: pre;
  overflow-wrap: normal;
  overflow: auto;
}

#line-numbers {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 44px;
  padding: 14px 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text3);
  text-align: right;
  pointer-events: none;
  z-index: 3;
  background: var(--bg2);
  border-right: 1px solid var(--border);
  overflow: hidden;
  user-select: none;
}

.editor-footer {
  padding: 6px 14px;
  background: var(--bg3);
  border-top: 1px solid var(--border);
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--text3);
  flex-shrink: 0;
}

/* ── DEPS PANEL ── */
.deps-section { padding: 14px; overflow-y: auto; flex: 1; }
.dep-group-title {
  font-size: 9px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 8px;
  margin-top: 12px;
}
.dep-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--bg3);
  margin-bottom: 4px;
  transition: all 0.15s;
}
.dep-item:hover { background: var(--bg4); }
.dep-icon { font-size: 13px; }
.dep-name { flex: 1; font-size: 12px; color: var(--text); }
.dep-badge {
  font-size: 9px;
  padding: 2px 7px;
  border-radius: 10px;
  font-weight: 600;
}
.dep-badge.ok { background: rgba(0,255,136,0.12); color: var(--accent); border: 1px solid rgba(0,255,136,0.3); }
.dep-badge.missing { background: rgba(255,0,110,0.12); color: var(--accent3); border: 1px solid rgba(255,0,110,0.3); }
.dep-badge.stdlib { background: rgba(0,200,255,0.12); color: var(--accent2); border: 1px solid rgba(0,200,255,0.3); }

.install-btn {
  padding: 3px 9px;
  background: rgba(255,0,110,0.1);
  border: 1px solid rgba(255,0,110,0.3);
  border-radius: 5px;
  color: var(--accent3);
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.install-btn:hover { background: rgba(255,0,110,0.2); }

.code-info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.info-card {
  background: var(--bg3);
  border-radius: 8px;
  padding: 10px;
  text-align: center;
}
.info-card-val {
  font-family: var(--font-head);
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
}
.info-card-lbl { font-size: 9px; color: var(--text3); margin-top: 2px; }

.fn-list { display: flex; flex-wrap: wrap; gap: 4px; }
.fn-chip {
  background: var(--bg4);
  border: 1px solid var(--border2);
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 10px;
  color: var(--text2);
}

/* ── TERMINAL ── */
.terminal-area {
  flex: 1;
  background: #020408;
  overflow-y: auto;
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
}
.terminal-area::-webkit-scrollbar { width: 4px; }
.terminal-area::-webkit-scrollbar-thumb { background: var(--border2); }

.term-line { color: #cdd9e5; word-break: break-all; }
.term-line.error { color: #ff6b6b; }
.term-line.system { color: var(--accent); opacity: 0.7; font-style: italic; }

.terminal-controls {
  padding: 8px 14px;
  background: #020408;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.run-dir-select {
  flex: 1;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--text2);
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-dir-select:hover { border-color: var(--accent2); color: var(--text); }

.run-btn {
  padding: 6px 14px;
  background: rgba(0,255,136,0.1);
  border: 1px solid var(--accent);
  border-radius: 7px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: flex; align-items: center; gap: 5px;
  white-space: nowrap;
}
.run-btn:hover { background: rgba(0,255,136,0.2); box-shadow: var(--glow); }
.run-btn.stop {
  background: rgba(255,0,110,0.1);
  border-color: var(--accent3);
  color: var(--accent3);
}
.run-btn.stop:hover { background: rgba(255,0,110,0.2); }

/* ── MODAL ── */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.7);
  backdrop-filter: blur(8px);
  z-index: 1000;
  display: none;
  align-items: center;
  justify-content: center;
}
.modal-backdrop.open { display: flex; }

.modal {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 14px;
  padding: 24px;
  width: min(480px, 90vw);
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05) inset;
  animation: modal-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes modal-in {
  from { opacity: 0; transform: scale(0.9) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.modal h2 {
  font-family: var(--font-head);
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 18px;
  color: var(--text);
}

.form-group { margin-bottom: 14px; }
.form-label {
  display: block;
  font-size: 10px;
  color: var(--text3);
  letter-spacing: 0.8px;
  text-transform: uppercase;
  margin-bottom: 5px;
}
.form-input {
  width: 100%;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 7px;
  padding: 8px 11px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  transition: border-color 0.2s;
}
.form-input:focus { outline: none; border-color: var(--accent); }

.color-picker-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.color-dot {
  width: 22px; height: 22px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: transform 0.2s;
}
.color-dot:hover { transform: scale(1.2); }
.color-dot.active { border-color: white; }

.icon-picker-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.icon-opt {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  border-radius: 6px;
  cursor: pointer;
  background: var(--bg3);
  border: 1px solid transparent;
  transition: all 0.15s;
}
.icon-opt:hover, .icon-opt.active {
  border-color: var(--accent);
  background: rgba(0,255,136,0.08);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 20px;
}
.btn-cancel {
  padding: 7px 16px;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 7px;
  color: var(--text2);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover { border-color: var(--border); color: var(--text); }

.btn-ok {
  padding: 7px 20px;
  background: rgba(0,255,136,0.1);
  border: 1px solid var(--accent);
  border-radius: 7px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-ok:hover { background: rgba(0,255,136,0.2); }

/* ── TOAST ── */
#toast-container {
  position: fixed;
  bottom: 24px; right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
}
.toast {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--text);
  animation: toast-in 0.3s ease;
  pointer-events: all;
  max-width: 300px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.toast.error { border-left-color: var(--accent3); }
.toast.info { border-left-color: var(--accent2); }
@keyframes toast-in {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

/* ── DIR PICKER ── */
.dir-list {
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: 7px;
  margin-top: 8px;
}
.dir-list::-webkit-scrollbar { width: 4px; }
.dir-list::-webkit-scrollbar-thumb { background: var(--border2); }

.dir-item {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text2);
  display: flex; align-items: center; gap: 8px;
  transition: background 0.1s;
}
.dir-item:hover { background: var(--bg3); color: var(--text); }
.dir-current {
  padding: 6px 12px;
  font-size: 10px;
  color: var(--accent);
  background: rgba(0,255,136,0.05);
  border-bottom: 1px solid var(--border);
  word-break: break-all;
}

/* ── COMPILE MODAL ── */
.compile-progress {
  margin-top: 12px;
  background: var(--bg);
  border-radius: 7px;
  height: 4px;
  overflow: hidden;
}
.compile-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  border-radius: 7px;
  width: 0%;
  transition: width 0.3s;
  animation: loading-bar 2s linear infinite;
}
@keyframes loading-bar {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; }
  100% { width: 0%; margin-left: 100%; }
}
.compile-log {
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg);
  border-radius: 7px;
  padding: 10px;
  font-size: 10px;
  color: var(--text3);
  margin-top: 10px;
  line-height: 1.6;
  font-family: var(--font-mono);
}

/* ── EMPTY STATE ── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text3);
  gap: 12px;
  text-align: center;
}
.empty-icon { font-size: 48px; opacity: 0.4; }
.empty-title { font-family: var(--font-head); font-size: 14px; color: var(--text2); }
.empty-sub { font-size: 11px; }

/* ── SCROLLABLE SIDEBAR ── */
#folders-list { overflow-y: auto; flex: 1; padding: 0 0 8px; }
#folders-list::-webkit-scrollbar { width: 3px; }
#folders-list::-webkit-scrollbar-thumb { background: var(--border); }

/* LIST VIEW */
.scripts-list { display: flex; flex-direction: column; gap: 4px; }
.script-list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.script-list-item:hover {
  border-color: var(--card-color, var(--accent));
  background: var(--bg3);
}
.script-list-item .icon { font-size: 18px; }
.script-list-item .info { flex: 1; min-width: 0; }
.script-list-item .name { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.script-list-item .meta { font-size: 10px; color: var(--text3); margin-top: 2px; }
.script-list-item .actions { display: none; gap: 4px; }
.script-list-item:hover .actions { display: flex; }

/* ── CONTEXT MENU ── */
.ctx-menu {
  position: fixed;
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 9px;
  padding: 4px;
  z-index: 5000;
  min-width: 160px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  display: none;
  animation: ctx-in 0.12s ease;
}
.ctx-menu.open { display: block; }
@keyframes ctx-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.ctx-item {
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text2);
  border-radius: 6px;
  cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  transition: all 0.1s;
}
.ctx-item:hover { background: var(--bg3); color: var(--text); }
.ctx-item.danger:hover { background: rgba(255,0,110,0.1); color: var(--accent3); }
.ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }
</style>
</head>
<body>

<!-- TITLEBAR -->
<div id="titlebar">
  <div class="logo">⬡ PyVault</div>
  <span class="logo-version">v1.0</span>
  <input id="project-name-input" value="Мой Проект" title="Название проекта" spellcheck="false">
  <div class="titlebar-actions">
    <label class="tb-btn" title="Открыть проект">
      📂 Открыть
      <input type="file" id="import-file" accept=".pyvault,.json" style="display:none">
    </label>
    <button class="tb-btn primary" onclick="exportProject()">💾 Сохранить</button>
    <button class="tb-btn" onclick="openNewScript()">＋ Скрипт</button>
    <button class="tb-btn" onclick="openNewFolder()">📁 Папка</button>
  </div>
</div>

<!-- MAIN -->
<div id="main">

  <!-- SIDEBAR -->
  <div id="sidebar">
    <div id="folders-list">
      <div class="sidebar-section">
        Навигация
      </div>
      <div class="nav-item active" data-filter="all" onclick="setFilter('all', this)">
        <span>🏠</span> Все скрипты
        <span class="nav-count" id="count-all">0</span>
      </div>
      <div class="nav-item" data-filter="pinned" onclick="setFilter('pinned', this)">
        <span>📌</span> Закреплённые
        <span class="nav-count" id="count-pinned">0</span>
      </div>
      <div class="nav-item" data-filter="none" onclick="setFilter('none', this)">
        <span>📄</span> Без папки
        <span class="nav-count" id="count-none">0</span>
      </div>

      <div class="sidebar-section" style="margin-top:8px;">
        Папки
        <button class="sidebar-add-btn" onclick="openNewFolder()" title="Создать папку">＋</button>
      </div>
      <div id="folders-nav"></div>
    </div>

    <div id="sidebar-bottom">
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-val" id="stat-scripts">0</div>
          <div class="stat-lbl">скриптов</div>
        </div>
        <div class="stat-item">
          <div class="stat-val" id="stat-folders">0</div>
          <div class="stat-lbl">папок</div>
        </div>
        <div class="stat-item">
          <div class="stat-val" id="stat-lines">0</div>
          <div class="stat-lbl">строк</div>
        </div>
        <div class="stat-item">
          <div class="stat-val" id="stat-running">0</div>
          <div class="stat-lbl">запущено</div>
        </div>
      </div>
    </div>
  </div>

  <!-- CONTENT -->
  <div id="content">
    <div id="toolbar">
      <div class="search-wrap">
        <input type="text" id="search-box" placeholder="Поиск скриптов, тегов..." oninput="renderScripts()">
      </div>
      <div class="view-toggle">
        <button class="view-btn active" id="btn-grid" onclick="setView('grid', this)" title="Сетка">▦</button>
        <button class="view-btn" id="btn-list" onclick="setView('list', this)" title="Список">☰</button>
      </div>
      <button class="tb-btn" onclick="sortScripts()" title="Сортировать">⇅ Сорт</button>
    </div>
    <div id="canvas-area">
      <div id="scripts-container"></div>
    </div>
  </div>

  <!-- RIGHT PANEL -->
  <div id="right-panel" class="hidden">
    <div class="panel-header">
      <span id="panel-script-icon">🐍</span>
      <span class="panel-title" id="panel-script-name">Скрипт</span>
      <button class="panel-close" onclick="closePanel()">✕</button>
    </div>
    <div class="panel-tabs">
      <div class="panel-tab active" onclick="switchTab('editor', this)">✏️ Редактор</div>
      <div class="panel-tab" onclick="switchTab('deps', this)">📦 Зависимости</div>
      <div class="panel-tab" onclick="switchTab('terminal', this)">▶ Консоль</div>
      <div class="panel-tab" onclick="switchTab('info', this)">ℹ Инфо</div>
    </div>
    <div class="panel-content">

      <!-- EDITOR TAB -->
      <div class="tab-pane active" id="tab-editor">
        <div id="editor-container">
          <div id="line-numbers"></div>
          <textarea id="code-editor" spellcheck="false"
            oninput="onCodeChange()"
            onkeydown="handleEditorKey(event)"
            onscroll="syncScroll()"
          ></textarea>
        </div>
        <div class="editor-footer">
          <span id="cursor-pos">Стр 1, Кол 1</span>
          <span id="editor-lines">0 строк</span>
          <span id="editor-chars">0 символов</span>
          <button style="margin-left:auto; background:none; border:none; color:var(--text3); cursor:pointer; font-size:10px; font-family:var(--font-mono);" onclick="compileScript()" title="Компилировать в EXE">⚙ EXE</button>
        </div>
      </div>

      <!-- DEPS TAB -->
      <div class="tab-pane" id="tab-deps">
        <div class="deps-section" id="deps-content">
          <div style="color:var(--text3); text-align:center; margin-top:20px; font-size:12px;">
            Откройте скрипт и перейдите на вкладку Зависимости
          </div>
        </div>
      </div>

      <!-- TERMINAL TAB -->
      <div class="tab-pane" id="tab-terminal" style="flex-direction:column;">
        <div class="terminal-area" id="terminal-output">
          <div class="term-line system">// Консоль вывода</div>
        </div>
        <div class="terminal-controls">
          <button class="run-dir-select" id="run-dir-btn" onclick="openDirPicker()" title="Выбрать рабочую директорию">
            📂 <span id="run-dir-label">~</span>
          </button>
          <button class="run-btn" id="run-btn" onclick="runCurrentScript()">▶ Запустить</button>
        </div>
      </div>

      <!-- INFO TAB -->
      <div class="tab-pane" id="tab-info">
        <div class="deps-section" id="info-content">
        </div>
      </div>
    </div>
  </div>
</div>

<!-- MODALS -->

<!-- NEW SCRIPT MODAL -->
<div class="modal-backdrop" id="modal-new-script">
  <div class="modal">
    <h2>Новый скрипт</h2>
    <div class="form-group">
      <label class="form-label">Название</label>
      <input class="form-input" id="ns-name" placeholder="мой_скрипт" spellcheck="false">
    </div>
    <div class="form-group">
      <label class="form-label">Описание</label>
      <input class="form-input" id="ns-desc" placeholder="Что делает этот скрипт?" spellcheck="false">
    </div>
    <div class="form-group">
      <label class="form-label">Папка</label>
      <select class="form-input" id="ns-folder">
        <option value="">— Без папки —</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Иконка</label>
      <div class="icon-picker-row" id="ns-icon-picker"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Цвет</label>
      <div class="color-picker-row" id="ns-color-picker"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Теги (через запятую)</label>
      <input class="form-input" id="ns-tags" placeholder="утилита, данные, ...">
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal('modal-new-script')">Отмена</button>
      <button class="btn-ok" onclick="createScript()">Создать</button>
    </div>
  </div>
</div>

<!-- NEW FOLDER MODAL -->
<div class="modal-backdrop" id="modal-new-folder">
  <div class="modal">
    <h2>Новая папка</h2>
    <div class="form-group">
      <label class="form-label">Название</label>
      <input class="form-input" id="nf-name" placeholder="Мои утилиты">
    </div>
    <div class="form-group">
      <label class="form-label">Иконка</label>
      <div class="icon-picker-row" id="nf-icon-picker"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Цвет</label>
      <div class="color-picker-row" id="nf-color-picker"></div>
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal('modal-new-folder')">Отмена</button>
      <button class="btn-ok" onclick="createFolder()">Создать</button>
    </div>
  </div>
</div>

<!-- DIR PICKER MODAL -->
<div class="modal-backdrop" id="modal-dir">
  <div class="modal" style="width:min(520px,90vw)">
    <h2>📂 Выбор рабочей директории</h2>
    <div class="dir-current" id="dir-current-path">/</div>
    <div class="dir-list" id="dir-list"></div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-cancel" onclick="closeModal('modal-dir')">Отмена</button>
      <button class="btn-ok" onclick="selectCurrentDir()">Выбрать эту папку</button>
    </div>
  </div>
</div>

<!-- COMPILE MODAL -->
<div class="modal-backdrop" id="modal-compile">
  <div class="modal">
    <h2>⚙ Компиляция в EXE</h2>
    <div id="compile-status" style="color:var(--text2); font-size:12px;">Подготовка...</div>
    <div class="compile-progress"><div class="compile-bar" id="compile-bar"></div></div>
    <div class="compile-log" id="compile-log"></div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-ok" onclick="closeModal('modal-compile')" id="compile-close-btn" disabled>Закрыть</button>
    </div>
  </div>
</div>

<!-- CONTEXT MENU -->
<div class="ctx-menu" id="ctx-menu">
  <div class="ctx-item" onclick="ctxEdit()">✏️ Редактировать</div>
  <div class="ctx-item" onclick="ctxRun()">▶ Запустить</div>
  <div class="ctx-item" onclick="ctxAnalyze()">📦 Зависимости</div>
  <div class="ctx-item" onclick="ctxPin()">📌 Закрепить / открепить</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" onclick="ctxDuplicate()">⎘ Дублировать</div>
  <div class="ctx-item" onclick="ctxCompile()">⚙ Скомпилировать</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item danger" onclick="ctxDelete()">🗑 Удалить</div>
</div>

<!-- TOAST CONTAINER -->
<div id="toast-container"></div>

<script>
// ────────────────────────────────────────────────
//  State
// ────────────────────────────────────────────────
let state = { project_name: 'Мой Проект', folders: [], scripts: [], settings: {} };
let currentScriptId = null;
let currentFilter = 'all';
let currentView = 'grid';
let sortMode = 'modified'; // modified | name | lines
let logInterval = null;
let ctxTarget = null;
let dirPickerPath = null;

const COLORS = ['#00ff88','#00c8ff','#ff006e','#ffd700','#9d4edd','#ff6b35','#2ec4b6','#e63946'];
const SCRIPT_ICONS = ['🐍','⚡','🔧','🛠','📊','🤖','🧪','🔍','📁','💡','🚀','🎯','🔑','📡','🧩','🌐'];
const FOLDER_ICONS = ['📁','📂','🗂','💼','🗃','📦','🎒','🏷'];

// ────────────────────────────────────────────────
//  Init
// ────────────────────────────────────────────────
async function init() {
  state = await apiFetch('/api/state');
  document.getElementById('project-name-input').value = state.project_name || 'Мой Проект';
  renderSidebar();
  renderScripts();
  updateStats();

  document.getElementById('project-name-input').addEventListener('input', e => {
    state.project_name = e.target.value;
    apiFetch('/api/state', 'POST', { project_name: e.target.value });
  });

  document.getElementById('import-file').addEventListener('change', importProject);
  document.addEventListener('click', () => {
    document.getElementById('ctx-menu').classList.remove('open');
  });

  setInterval(updateRunning, 1500);
}

async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}

// ────────────────────────────────────────────────
//  Render
// ────────────────────────────────────────────────
function renderSidebar() {
  const nav = document.getElementById('folders-nav');
  nav.innerHTML = '';
  state.folders.forEach(f => {
    const el = document.createElement('div');
    el.className = 'nav-item';
    el.dataset.filter = 'folder:' + f.id;
    const count = state.scripts.filter(s => s.folder_id === f.id).length;
    el.innerHTML = `
      <span class="folder-dot" style="background:${f.color}"></span>
      ${f.icon} ${escHtml(f.name)}
      <span class="nav-count">${count}</span>
    `;
    el.onclick = () => setFilter('folder:' + f.id, el);
    el.oncontextmenu = e => showFolderCtx(e, f);
    nav.appendChild(el);
  });

  document.getElementById('count-all').textContent = state.scripts.length;
  document.getElementById('count-pinned').textContent = state.scripts.filter(s => s.pinned).length;
  document.getElementById('count-none').textContent = state.scripts.filter(s => !s.folder_id).length;
}

function renderScripts() {
  const q = document.getElementById('search-box').value.toLowerCase();
  let scripts = state.scripts.filter(s => {
    if (q) {
      const match = s.name.toLowerCase().includes(q) ||
        (s.description||'').toLowerCase().includes(q) ||
        (s.tags||[]).some(t => t.toLowerCase().includes(q));
      if (!match) return false;
    }
    if (currentFilter === 'all') return true;
    if (currentFilter === 'pinned') return s.pinned;
    if (currentFilter === 'none') return !s.folder_id;
    if (currentFilter.startsWith('folder:')) return s.folder_id === currentFilter.split(':')[1];
    return true;
  });

  if (sortMode === 'name') scripts.sort((a,b) => a.name.localeCompare(b.name));
  else if (sortMode === 'lines') scripts.sort((a,b) => (b.code||'').split('\n').length - (a.code||'').split('\n').length);
  else scripts.sort((a,b) => (b.modified||'').localeCompare(a.modified||''));

  const container = document.getElementById('scripts-container');

  if (!scripts.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🐍</div>
        <div class="empty-title">Нет скриптов</div>
        <div class="empty-sub">${q ? 'Ничего не найдено по запросу "'+escHtml(q)+'"' : 'Нажмите «＋ Скрипт» чтобы добавить первый скрипт'}</div>
      </div>`;
    return;
  }

  if (currentView === 'grid') {
    renderGrid(container, scripts);
  } else {
    renderList(container, scripts);
  }
}

function renderGrid(container, scripts) {
  // Group by folders if showing all
  if (currentFilter === 'all' && !document.getElementById('search-box').value) {
    let html = '';

    // Pinned first
    const pinned = scripts.filter(s => s.pinned);
    if (pinned.length) {
      html += `<div class="folder-label"><span class="toggle-icon">▼</span> 📌 Закреплённые</div>`;
      html += `<div class="scripts-grid" style="margin-bottom:20px">` + pinned.map(cardHtml).join('') + `</div>`;
    }

    // By folder
    state.folders.forEach(f => {
      const fs = scripts.filter(s => s.folder_id === f.id && !s.pinned);
      if (!fs.length) return;
      html += `<div class="folder-label"><span class="toggle-icon">▼</span>
        <span class="folder-dot" style="background:${f.color}"></span>
        ${f.icon} ${escHtml(f.name)}</div>`;
      html += `<div class="scripts-grid" style="margin-bottom:20px">` + fs.map(cardHtml).join('') + `</div>`;
    });

    // No folder
    const noFolder = scripts.filter(s => !s.folder_id && !s.pinned);
    if (noFolder.length) {
      if (state.folders.length) {
        html += `<div class="folder-label"><span class="toggle-icon">▼</span> 📄 Без папки</div>`;
      }
      html += `<div class="scripts-grid">` + noFolder.map(cardHtml).join('') + `</div>`;
    }

    container.innerHTML = html;
  } else {
    container.innerHTML = `<div class="scripts-grid">` + scripts.map(cardHtml).join('') + `</div>`;
  }
  attachCardEvents();
}

function renderList(container, scripts) {
  container.innerHTML = `<div class="scripts-list">` +
    scripts.map(s => `
      <div class="script-list-item" data-id="${s.id}"
        style="--card-color:${s.color||'var(--accent)'}"
        ondblclick="openScript('${s.id}')"
        oncontextmenu="showCtxMenu(event,'${s.id}')">
        <div class="icon">${s.icon||'🐍'}</div>
        <div class="info">
          <div class="name">${escHtml(s.name)}</div>
          <div class="meta">${(s.code||'').split('\n').length} строк · ${s.modified ? relTime(s.modified) : ''}</div>
        </div>
        <div class="actions">
          <button class="card-act-btn run" onclick="quickRun(event,'${s.id}')" title="Запустить">▶</button>
          <button class="card-act-btn" onclick="openScript('${s.id}')" title="Редактировать">✎</button>
        </div>
      </div>`).join('') + `</div>`;
}

function cardHtml(s) {
  const lines = (s.code||'').split('\n').length;
  const running = false; // will update via JS
  const tags = (s.tags||[]).slice(0,2).map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('');
  return `
    <div class="script-card${s.pinned?' pinned':''}" data-id="${s.id}"
      style="--card-color:${s.color||'var(--accent)'}"
      ondblclick="openScript('${s.id}')"
      oncontextmenu="showCtxMenu(event,'${s.id}')">
      <div class="card-icon">${s.icon||'🐍'}</div>
      <div class="card-name">${escHtml(s.name)}</div>
      ${s.description ? `<div class="card-desc">${escHtml(s.description)}</div>` : ''}
      <div class="card-meta">${tags}<span class="card-lines">${lines} стр.</span></div>
      <div class="card-actions">
        <button class="card-act-btn run" onclick="quickRun(event,'${s.id}')" title="Запустить">▶</button>
        <button class="card-act-btn del" onclick="deleteScriptConfirm(event,'${s.id}')" title="Удалить">✕</button>
      </div>
      ${isRunning(s.id) ? '<div class="card-running"></div>' : ''}
    </div>`;
}

function attachCardEvents() {
  // Drag to folder
  document.querySelectorAll('.script-card').forEach(card => {
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('scriptId', card.dataset.id);
    });
  });
  document.querySelectorAll('.folder-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const sid = e.dataTransfer.getData('scriptId');
      const fid = zone.dataset.folder;
      await apiFetch('/api/script/' + sid, 'PUT', { folder_id: fid || null });
      await reload();
    });
  });
}

// ────────────────────────────────────────────────
//  Open / Edit Script
// ────────────────────────────────────────────────
function openScript(id) {
  currentScriptId = id;
  const s = state.scripts.find(x => x.id === id);
  if (!s) return;

  document.getElementById('right-panel').classList.remove('hidden');
  document.getElementById('panel-script-name').textContent = s.name;
  document.getElementById('panel-script-icon').textContent = s.icon || '🐍';

  const editor = document.getElementById('code-editor');
  editor.value = s.code || '';
  updateLineNumbers();
  updateEditorFooter();

  // Update run dir
  const runDir = s.run_dir || '~';
  document.getElementById('run-dir-label').textContent = shortPath(runDir);

  // Auto-analyze deps
  loadDeps(id);
  loadInfo(s);
  clearTerminal();
  switchTab('editor', document.querySelector('.panel-tab.active') || document.querySelector('.panel-tab'));
  stopLogPolling();
}

function closePanel() {
  document.getElementById('right-panel').classList.add('hidden');
  currentScriptId = null;
  stopLogPolling();
}

async function onCodeChange() {
  if (!currentScriptId) return;
  const code = document.getElementById('code-editor').value;
  updateLineNumbers();
  updateEditorFooter();
  // Auto-save debounced
  clearTimeout(window._saveTimer);
  window._saveTimer = setTimeout(async () => {
    await apiFetch('/api/script/' + currentScriptId, 'PUT', { code });
    const s = state.scripts.find(x => x.id === currentScriptId);
    if (s) s.code = code;
    loadDeps(currentScriptId);
  }, 800);
}

function updateLineNumbers() {
  const editor = document.getElementById('code-editor');
  const lines = editor.value.split('\n');
  const nums = lines.map((_,i) => i+1).join('\n');
  document.getElementById('line-numbers').textContent = nums;
}

function syncScroll() {
  const editor = document.getElementById('code-editor');
  const lines = document.getElementById('line-numbers');
  lines.scrollTop = editor.scrollTop;
}

function updateEditorFooter() {
  const editor = document.getElementById('code-editor');
  const code = editor.value;
  const lines = code.split('\n');
  document.getElementById('editor-lines').textContent = lines.length + ' строк';
  document.getElementById('editor-chars').textContent = code.length + ' символов';

  const pos = editor.selectionStart;
  let lineNum = 1, col = 1;
  for (let i = 0; i < pos; i++) {
    if (code[i] === '\n') { lineNum++; col = 1; } else col++;
  }
  document.getElementById('cursor-pos').textContent = `Стр ${lineNum}, Кол ${col}`;
}

function handleEditorKey(e) {
  const editor = e.target;
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart, end = editor.selectionEnd;
    editor.value = editor.value.substring(0, s) + '    ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = s + 4;
    onCodeChange();
  }
  if (e.key === 'Enter') {
    const s = editor.selectionStart;
    const before = editor.value.substring(0, s);
    const lastLine = before.split('\n').pop();
    const indent = lastLine.match(/^(\s*)/)[1];
    const extra = lastLine.trimEnd().endsWith(':') ? '    ' : '';
    setTimeout(() => {
      const pos = editor.selectionStart;
      editor.value = editor.value.substring(0, pos) + indent + extra + editor.value.substring(pos);
      editor.selectionStart = editor.selectionEnd = pos + indent.length + extra.length;
      updateLineNumbers();
      updateEditorFooter();
    }, 0);
  }
  updateEditorFooter();
}

// ────────────────────────────────────────────────
//  Deps
// ────────────────────────────────────────────────
async function loadDeps(id) {
  const data = await apiFetch('/api/script/' + id + '/analyze');
  if (data.error) return;

  const container = document.getElementById('deps-content');
  let html = `<div class="code-info-grid">
    <div class="info-card"><div class="info-card-val">${data.lines}</div><div class="info-card-lbl">Строк</div></div>
    <div class="info-card"><div class="info-card-val">${data.complexity}</div><div class="info-card-lbl">Сложность</div></div>
    <div class="info-card"><div class="info-card-val">${data.functions.length}</div><div class="info-card-lbl">Функций</div></div>
    <div class="info-card"><div class="info-card-val">${data.classes.length}</div><div class="info-card-lbl">Классов</div></div>
  </div>`;

  if (data.errors && data.errors.length) {
    html += `<div class="dep-group-title">⚠ Ошибки синтаксиса</div>`;
    data.errors.forEach(e => {
      html += `<div class="dep-item"><span class="dep-icon">❌</span><span class="dep-name" style="color:var(--accent3)">${escHtml(e)}</span></div>`;
    });
  }

  if (data.third_party.length) {
    html += `<div class="dep-group-title">Сторонние пакеты</div>`;
    data.third_party.forEach(pkg => {
      const ok = data.dep_status[pkg];
      html += `<div class="dep-item">
        <span class="dep-icon">📦</span>
        <span class="dep-name">${escHtml(pkg)}</span>
        <span class="dep-badge ${ok?'ok':'missing'}">${ok?'✓ Установлен':'✗ Нет'}</span>
        ${!ok ? `<button class="install-btn" onclick="installPkg('${escHtml(pkg)}')">Установить</button>` : ''}
      </div>`;
    });
  }

  if (data.std_libs.length) {
    html += `<div class="dep-group-title">Стандартная библиотека</div>`;
    data.std_libs.forEach(pkg => {
      html += `<div class="dep-item">
        <span class="dep-icon">🐍</span>
        <span class="dep-name">${escHtml(pkg)}</span>
        <span class="dep-badge stdlib">stdlib</span>
      </div>`;
    });
  }

  if (data.functions.length || data.classes.length) {
    html += `<div class="dep-group-title">Структура</div>`;
    if (data.classes.length) {
      html += `<div class="dep-item"><span class="dep-icon">🏗</span><span class="dep-name">Классы: </span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${data.classes.map(c=>`<span class="fn-chip">${escHtml(c)}</span>`).join('')}</div></div>`;
    }
    if (data.functions.length) {
      html += `<div class="dep-item"><span class="dep-icon">⚡</span><span class="dep-name">Функции: </span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${data.functions.map(c=>`<span class="fn-chip">${escHtml(c)}</span>`).join('')}</div></div>`;
    }
  }

  container.innerHTML = html;
}

async function installPkg(pkg) {
  toast(`Устанавливаю ${pkg}...`, 'info');
  const data = await apiFetch('/api/install', 'POST', { package: pkg });
  if (data.ok) {
    toast(`✓ ${pkg} установлен`, 'ok');
    loadDeps(currentScriptId);
  } else {
    toast(`Ошибка: ${data.error}`, 'error');
  }
}

// ────────────────────────────────────────────────
//  Info
// ────────────────────────────────────────────────
function loadInfo(s) {
  const container = document.getElementById('info-content');
  container.innerHTML = `
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Название</label>
      <input class="form-input" value="${escHtml(s.name)}" onchange="updateField('name',this.value)">
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Описание</label>
      <input class="form-input" value="${escHtml(s.description||'')}" onchange="updateField('description',this.value)">
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Теги (через запятую)</label>
      <input class="form-input" value="${(s.tags||[]).join(', ')}"
        onchange="updateField('tags',this.value.split(',').map(t=>t.trim()).filter(Boolean))">
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Иконка</label>
      <div class="icon-picker-row">
        ${SCRIPT_ICONS.map(ic => `<div class="icon-opt${ic===s.icon?' active':''}" onclick="updateField('icon','${ic}');this.closest('.icon-picker-row').querySelectorAll('.icon-opt').forEach(x=>x.classList.remove('active'));this.classList.add('active');document.getElementById('panel-script-icon').textContent='${ic}'">${ic}</div>`).join('')}
      </div>
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Цвет акцента</label>
      <div class="color-picker-row">
        ${COLORS.map(c => `<div class="color-dot${c===s.color?' active':''}" style="background:${c}" onclick="updateField('color','${c}');document.querySelectorAll('.color-dot').forEach(x=>x.classList.remove('active'));this.classList.add('active')"></div>`).join('')}
      </div>
    </div>
    <div style="color:var(--text3);font-size:10px;margin-top:12px;">
      Создан: ${s.created ? new Date(s.created).toLocaleString('ru') : '—'}<br>
      Изменён: ${s.modified ? new Date(s.modified).toLocaleString('ru') : '—'}<br>
      ID: ${s.id}
    </div>
  `;
}

async function updateField(field, value) {
  if (!currentScriptId) return;
  const payload = {};
  payload[field] = value;
  await apiFetch('/api/script/' + currentScriptId, 'PUT', payload);
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s) s[field] = value;
  if (field === 'name') document.getElementById('panel-script-name').textContent = value;
  renderSidebar();
  renderScripts();
}

// ────────────────────────────────────────────────
//  Run
// ────────────────────────────────────────────────
function clearTerminal() {
  document.getElementById('terminal-output').innerHTML = '<div class="term-line system">// Консоль вывода</div>';
}

function addTermLine(text, cls = '') {
  const div = document.getElementById('terminal-output');
  const line = document.createElement('div');
  line.className = 'term-line ' + cls;
  line.textContent = text;
  div.appendChild(line);
  div.scrollTop = div.scrollHeight;
}

async function runCurrentScript() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  const btn = document.getElementById('run-btn');

  if (isRunning(currentScriptId)) {
    await apiFetch('/api/script/' + currentScriptId + '/stop', 'POST');
    btn.textContent = '▶ Запустить';
    btn.className = 'run-btn';
    addTermLine('— Остановлено —', 'system');
    stopLogPolling();
    return;
  }

  clearTerminal();
  addTermLine(`$ python ${s.name}`, 'system');
  switchTab('terminal', null);

  const result = await apiFetch('/api/script/' + currentScriptId + '/run', 'POST', {
    run_dir: s.run_dir
  });

  if (result.error) {
    addTermLine('Ошибка: ' + result.error, 'error');
    return;
  }

  btn.innerHTML = '⏹ Остановить';
  btn.className = 'run-btn stop';

  let lastLen = 0;
  logInterval = setInterval(async () => {
    const data = await apiFetch('/api/script/' + currentScriptId + '/logs');
    const logs = data.logs || [];
    if (logs.length > lastLen) {
      for (let i = lastLen; i < logs.length; i++) {
        const line = logs[i];
        addTermLine(line, line.toLowerCase().includes('error') || line.toLowerCase().includes('traceback') ? 'error' : '');
      }
      lastLen = logs.length;
    }
    if (!data.running) {
      addTermLine('— Завершено —', 'system');
      btn.innerHTML = '▶ Запустить';
      btn.className = 'run-btn';
      stopLogPolling();
      renderScripts();
    }
  }, 300);
}

async function quickRun(e, id) {
  e.stopPropagation();
  currentScriptId = id;
  openScript(id);
  switchTab('terminal', null);
  setTimeout(runCurrentScript, 100);
}

function isRunning(id) {
  return document.querySelector(`.script-card[data-id="${id}"] .card-running`) !== null;
}

function stopLogPolling() {
  if (logInterval) { clearInterval(logInterval); logInterval = null; }
}

async function updateRunning() {
  // Refresh run state indicators
  for (const card of document.querySelectorAll('.script-card')) {
    const id = card.dataset.id;
    const data = await apiFetch('/api/script/' + id + '/logs').catch(() => null);
    if (!data) continue;
    const existing = card.querySelector('.card-running');
    if (data.running && !existing) {
      const dot = document.createElement('div');
      dot.className = 'card-running';
      card.appendChild(dot);
    } else if (!data.running && existing) {
      existing.remove();
    }
  }
  // Update stat
  const running = document.querySelectorAll('.card-running').length;
  document.getElementById('stat-running').textContent = running;
}

// ────────────────────────────────────────────────
//  Dir Picker
// ────────────────────────────────────────────────
async function openDirPicker() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  dirPickerPath = s ? (s.run_dir || '/') : '/';
  await loadDir(dirPickerPath);
  openModal('modal-dir');
}

async function loadDir(path) {
  const data = await apiFetch('/api/ls?path=' + encodeURIComponent(path));
  if (data.error) { toast(data.error, 'error'); return; }
  dirPickerPath = data.path;
  document.getElementById('dir-current-path').textContent = data.path;
  const list = document.getElementById('dir-list');
  list.innerHTML = `
    <div class="dir-item" onclick="loadDir('${escJs(data.parent)}')">⬆ ..</div>
    ${data.items.filter(i => i.is_dir).map(i =>
      `<div class="dir-item" onclick="loadDir('${escJs(i.path)}')">📁 ${escHtml(i.name)}</div>`
    ).join('')}
  `;
}

async function selectCurrentDir() {
  if (!currentScriptId || !dirPickerPath) return;
  await apiFetch('/api/script/' + currentScriptId, 'PUT', { run_dir: dirPickerPath });
  const s = state.scripts.find(x => x.id === currentScriptId);
  if (s) s.run_dir = dirPickerPath;
  document.getElementById('run-dir-label').textContent = shortPath(dirPickerPath);
  closeModal('modal-dir');
  toast('✓ Директория установлена', 'ok');
}

// ────────────────────────────────────────────────
//  Compile
// ────────────────────────────────────────────────
async function compileScript() {
  if (!currentScriptId) return;
  const s = state.scripts.find(x => x.id === currentScriptId);
  openModal('modal-compile');
  document.getElementById('compile-status').textContent = `Компилирую: ${s.name}...`;
  document.getElementById('compile-log').textContent = 'PyInstaller запущен...';
  document.getElementById('compile-close-btn').disabled = true;

  try {
    const resp = await fetch('/api/compile/' + currentScriptId, { method: 'POST' });
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disp = resp.headers.get('Content-Disposition') || '';
      a.download = disp.match(/filename="?([^"]+)"?/)?.[1] || s.name + '_exe';
      a.click();
      document.getElementById('compile-status').textContent = '✓ Готово!';
      document.getElementById('compile-log').textContent = 'EXE-файл загружен.';
    } else {
      const err = await resp.json();
      document.getElementById('compile-status').textContent = '✗ Ошибка компиляции';
      document.getElementById('compile-log').textContent = err.output || err.error;
    }
  } catch(e) {
    document.getElementById('compile-status').textContent = '✗ Ошибка';
    document.getElementById('compile-log').textContent = e.message;
  }
  document.getElementById('compile-close-btn').disabled = false;
}

// ────────────────────────────────────────────────
//  Create / Delete
// ────────────────────────────────────────────────
function openNewScript() {
  // Fill folder select
  const sel = document.getElementById('ns-folder');
  sel.innerHTML = '<option value="">— Без папки —</option>' +
    state.folders.map(f => `<option value="${f.id}">${f.icon} ${escHtml(f.name)}</option>`).join('');

  // Fill icon picker
  let activeIcon = '🐍';
  document.getElementById('ns-icon-picker').innerHTML =
    SCRIPT_ICONS.map(ic => `<div class="icon-opt${ic===activeIcon?' active':''}" data-icon="${ic}"
      onclick="document.querySelectorAll('#ns-icon-picker .icon-opt').forEach(x=>x.classList.remove('active'));this.classList.add('active')">${ic}</div>`).join('');

  // Fill color picker
  let activeColor = COLORS[0];
  document.getElementById('ns-color-picker').innerHTML =
    COLORS.map(c => `<div class="color-dot${c===activeColor?' active':''}" style="background:${c}" data-color="${c}"
      onclick="document.querySelectorAll('#ns-color-picker .color-dot').forEach(x=>x.classList.remove('active'));this.classList.add('active')"></div>`).join('');

  document.getElementById('ns-name').value = '';
  document.getElementById('ns-desc').value = '';
  document.getElementById('ns-tags').value = '';
  openModal('modal-new-script');
  setTimeout(() => document.getElementById('ns-name').focus(), 100);
}

async function createScript() {
  const name = document.getElementById('ns-name').value.trim() || 'Новый скрипт';
  const desc = document.getElementById('ns-desc').value.trim();
  const folder_id = document.getElementById('ns-folder').value || null;
  const icon = document.querySelector('#ns-icon-picker .active')?.dataset.icon || '🐍';
  const color = document.querySelector('#ns-color-picker .active')?.dataset.color || COLORS[0];
  const tags = document.getElementById('ns-tags').value.split(',').map(t=>t.trim()).filter(Boolean);

  const script = await apiFetch('/api/script', 'POST', { name, description: desc, folder_id, icon, color, tags });
  state.scripts.push(script);
  closeModal('modal-new-script');
  renderSidebar();
  renderScripts();
  updateStats();
  toast(`✓ Скрипт "${name}" создан`);
  openScript(script.id);
}

async function deleteScriptConfirm(e, id) {
  e.stopPropagation();
  if (!confirm('Удалить скрипт?')) return;
  await apiFetch('/api/script/' + id, 'DELETE');
  state.scripts = state.scripts.filter(s => s.id !== id);
  if (currentScriptId === id) closePanel();
  renderSidebar();
  renderScripts();
  updateStats();
  toast('Скрипт удалён', 'error');
}

function openNewFolder() {
  let activeIcon = '📁';
  document.getElementById('nf-icon-picker').innerHTML =
    FOLDER_ICONS.map(ic => `<div class="icon-opt${ic===activeIcon?' active':''}" data-icon="${ic}"
      onclick="document.querySelectorAll('#nf-icon-picker .icon-opt').forEach(x=>x.classList.remove('active'));this.classList.add('active')">${ic}</div>`).join('');
  document.getElementById('nf-color-picker').innerHTML =
    COLORS.map(c => `<div class="color-dot" style="background:${c}" data-color="${c}"
      onclick="document.querySelectorAll('#nf-color-picker .color-dot').forEach(x=>x.classList.remove('active'));this.classList.add('active')"></div>`).join('');
  document.querySelector('#nf-color-picker .color-dot').classList.add('active');
  document.getElementById('nf-name').value = '';
  openModal('modal-new-folder');
  setTimeout(() => document.getElementById('nf-name').focus(), 100);
}

async function createFolder() {
  const name = document.getElementById('nf-name').value.trim() || 'Новая папка';
  const icon = document.querySelector('#nf-icon-picker .active')?.dataset.icon || '📁';
  const color = document.querySelector('#nf-color-picker .active')?.dataset.color || COLORS[0];
  const folder = await apiFetch('/api/folder', 'POST', { name, icon, color });
  state.folders.push(folder);
  closeModal('modal-new-folder');
  renderSidebar();
  updateStats();
  toast(`✓ Папка "${name}" создана`);
}

// ────────────────────────────────────────────────
//  Project Save/Load
// ────────────────────────────────────────────────
function exportProject() {
  window.location.href = '/api/project/export';
  toast('💾 Проект сохранён');
}

async function importProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch('/api/project/import', { method: 'POST', body: form });
  const data = await resp.json();
  if (data.ok) {
    state = await apiFetch('/api/state');
    document.getElementById('project-name-input').value = state.project_name;
    renderSidebar();
    renderScripts();
    updateStats();
    closePanel();
    toast(`✓ Проект "${data.name}" загружен`);
  } else {
    toast('Ошибка загрузки: ' + data.error, 'error');
  }
  e.target.value = '';
}

// ────────────────────────────────────────────────
//  Context Menu
// ────────────────────────────────────────────────
function showCtxMenu(e, id) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = id;
  const menu = document.getElementById('ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
}

function ctxEdit() { openScript(ctxTarget); }
function ctxRun() { openScript(ctxTarget); switchTab('terminal',null); setTimeout(runCurrentScript,200); }
function ctxAnalyze() { openScript(ctxTarget); switchTab('deps',null); }
async function ctxPin() {
  const s = state.scripts.find(x=>x.id===ctxTarget);
  if (!s) return;
  await apiFetch('/api/script/'+ctxTarget, 'PUT', { pinned: !s.pinned });
  s.pinned = !s.pinned;
  renderSidebar(); renderScripts(); updateStats();
}
async function ctxDuplicate() {
  const s = state.scripts.find(x=>x.id===ctxTarget);
  if (!s) return;
  const copy = await apiFetch('/api/script', 'POST', {
    ...s, name: s.name + ' (копия)', id: undefined
  });
  state.scripts.push(copy);
  renderScripts(); updateStats();
  toast('⎘ Скрипт скопирован');
}
function ctxCompile() { openScript(ctxTarget); compileScript(); }
async function ctxDelete() {
  if (!confirm('Удалить?')) return;
  await apiFetch('/api/script/'+ctxTarget, 'DELETE');
  state.scripts = state.scripts.filter(s=>s.id!==ctxTarget);
  if (currentScriptId===ctxTarget) closePanel();
  renderSidebar(); renderScripts(); updateStats();
  toast('Удалено', 'error');
}

function showFolderCtx(e, f) {
  e.preventDefault();
  if (!confirm(`Удалить папку "${f.name}"? Скрипты останутся.`)) return;
  apiFetch('/api/folder/'+f.id, 'DELETE').then(() => {
    state.folders = state.folders.filter(x=>x.id!==f.id);
    state.scripts.forEach(s => { if (s.folder_id===f.id) s.folder_id=null; });
    renderSidebar(); renderScripts();
    toast('Папка удалена');
  });
}

// ────────────────────────────────────────────────
//  UI Helpers
// ────────────────────────────────────────────────
function setFilter(filter, el) {
  currentFilter = filter;
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  if (el) el.classList.add('active');
  renderScripts();
}

function setView(view, btn) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(x => x.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderScripts();
}

function sortScripts() {
  const modes = ['modified','name','lines'];
  sortMode = modes[(modes.indexOf(sortMode)+1) % modes.length];
  const labels = { modified:'⇅ Дата', name:'⇅ Имя', lines:'⇅ Строки' };
  document.querySelector('.tb-btn[onclick="sortScripts()"]').textContent = labels[sortMode];
  renderScripts();
}

function switchTab(name, clickedEl) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  if (clickedEl) clickedEl.classList.add('active');
  else {
    const tab = document.querySelector(`.panel-tab[onclick*="${name}"]`);
    if (tab) tab.classList.add('active');
  }
  const pane = document.getElementById('tab-' + name);
  if (pane) pane.classList.add('active');

  if (name === 'deps' && currentScriptId) loadDeps(currentScriptId);
  if (name === 'info' && currentScriptId) {
    const s = state.scripts.find(x=>x.id===currentScriptId);
    if (s) loadInfo(s);
  }
}

function updateStats() {
  document.getElementById('stat-scripts').textContent = state.scripts.length;
  document.getElementById('stat-folders').textContent = state.folders.length;
  const totalLines = state.scripts.reduce((acc,s) => acc + (s.code||'').split('\n').length, 0);
  document.getElementById('stat-lines').textContent = totalLines > 999 ? Math.round(totalLines/1000)+'k' : totalLines;
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function toast(msg, type='ok') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function reload() {
  state = await apiFetch('/api/state');
  renderSidebar(); renderScripts(); updateStats();
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escJs(s) {
  return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}
function shortPath(p) {
  const home = '/root';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  const parts = p.split('/');
  if (parts.length > 3) return '.../' + parts.slice(-2).join('/');
  return p;
}
function relTime(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d;
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return Math.floor(diff/60000) + ' мин. назад';
  if (diff < 86400000) return Math.floor(diff/3600000) + ' ч. назад';
  return d.toLocaleDateString('ru');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'n') { e.preventDefault(); openNewScript(); }
    if (e.key === 's') { e.preventDefault(); exportProject(); }
    if (e.key === 'Enter' && currentScriptId) { e.preventDefault(); runCurrentScript(); }
    if (e.key === 'Escape') closePanel();
  }
});

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => {
    if (e.target === bd) bd.classList.remove('open');
  });
});

// Init!
init();
</script>
</body>
</html>"""

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)

# ─── Entry Point ──────────────────────────────────────────────────────────────

def open_browser():
    import webbrowser, time
    time.sleep(1.2)
    webbrowser.open('http://localhost:7331')

if __name__ == '__main__':
    print("\n" + "─"*55)
    print("  ⬡  PyVault — Хранилище Python-скриптов")
    print("─"*55)
    print("  Открывается браузер: http://localhost:7331")
    print("  Для остановки нажмите Ctrl+C")
    print("─"*55 + "\n")

    threading.Thread(target=open_browser, daemon=True).start()

    app.run(
        host='0.0.0.0',
        port=7331,
        debug=False,
        use_reloader=False,
        threaded=True
    )