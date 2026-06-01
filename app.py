#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PyVault — сервер
Запуск: python app.py
Откройте: http://localhost:7332
"""

import os, sys, json, ast, subprocess, threading, io, re, time, hashlib, tempfile
from pathlib import Path
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, send_file

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

app = Flask(__name__, static_folder=str(STATIC_DIR), template_folder=str(TEMPLATES_DIR))

# ── Состояние приложения ──────────────────────────────────────────────────────
def default_vault_state(project_name: str = "Мой Проект") -> dict:
    return {
        "project_name": project_name,
        "folders": [],
        "scripts": [],
        "settings": {"theme": "dark", "accent": "#00ff88", "font_size": 14},
    }

vault_state = default_vault_state()

run_processes = {}   # sid → Popen
run_logs = {}        # sid → [str]
run_partials = {}    # sid → str (текущая строка без \n)
run_files = {}       # sid → Path (временный .py в run_dir)

# ── Вспомогательные функции ───────────────────────────────────────────────────

def cleanup_run_file(sid: str) -> None:
    path = run_files.pop(sid, None)
    if path is None:
        return
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass

def resolve_run_dir(run_dir: str) -> Path:
    p = Path(run_dir).expanduser().resolve()
    if not p.is_dir():
        raise FileNotFoundError(f"Директория не найдена: {run_dir}")
    return p

def script_run_env() -> dict:
    """Окружение для дочернего Python: UTF-8 stdout/stderr (Rich, кириллица, рамки)."""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if sys.platform == "win32":
        env["PYTHONLEGACYWINDOWSSTDIO"] = "0"
        env.setdefault("TERM", "xterm-256color")
    return env

def python_run_args(script_name: str) -> list:
    args = [sys.executable]
    if sys.platform == "win32" and sys.version_info >= (3, 7):
        args.extend(["-X", "utf8"])
    args.extend(["-u", script_name])
    return args

_PYVAULT_UTF8_BOOT = """# PyVault: UTF-8 для консоли (Rich, Unicode, кириллица)
import sys
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
"""

def wrap_script_code_for_run(code: str) -> str:
    if sys.platform == "win32":
        return _PYVAULT_UTF8_BOOT + "\n" + code
    return code

def gen_id() -> str:
    return hashlib.md5(str(time.time_ns()).encode()).hexdigest()[:8]

def analyze_code(code: str) -> dict:
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
        'weakref','types','operator','linecache','site','sysconfig','zipimport',
        'tkinter','turtle','cmd','code','codeop','pdb','profile','timeit',
        'doctest','unittest','xmlrpc','ftplib','imaplib','poplib','smtplib',
        'nntplib','telnetlib','uuid','ipaddress','binascii','struct','wave',
        'audioop','aifc','sunau','chunk','colorsys','imghdr','sndhdr',
        'ossaudiodev','readline','rlcompleter','msvcrt','winreg','winsound',
        'posix','pwd','grp','termios','tty','pty','fcntl','pipes','resource',
        'syslog','optparse','getopt','getpass','curses','ctypes','concurrent',
        'asyncio','selectors','signal','mmap','winreg','token','py_compile'
    }
    std_libs, third_party, functions, classes = set(), set(), [], []
    errors = []
    lines = len(code.splitlines())
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.name.split('.')[0]
                    (std_libs if name in STDLIB else third_party).add(name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    name = node.module.split('.')[0]
                    (std_libs if name in STDLIB else third_party).add(name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.col_offset == 0:
                    functions.append(node.name)
            elif isinstance(node, ast.ClassDef):
                if node.col_offset == 0:
                    classes.append(node.name)
    except SyntaxError as e:
        errors.append(f"Строка {e.lineno}: {e.msg}")
    except Exception as e:
        errors.append(str(e))

    return {
        "std_libs": sorted(std_libs),
        "third_party": sorted(third_party),
        "functions": functions,
        "classes": classes,
        "lines": lines,
        "errors": errors,
        "complexity": "простая" 
            if lines < 50 else "низкая" 
            if lines < 150 else "средняя"
            if lines < 400 else "повышенная"
            if lines < 800 else "высокая"
            if lines < 1500 else "очень высокая"
            if lines < 2500 else "критическая"
            if lines < 4000 else "недопустимая"
    }

def check_installed(pkg: str) -> bool:
    try:
        r = subprocess.run([sys.executable, "-c", f"import {pkg}"],
                           capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False

# ── API: State ────────────────────────────────────────────────────────────────

@app.route("/api/state")
def api_state():
    return jsonify(vault_state)

@app.route("/api/state", methods=["POST"])
def api_state_update():
    vault_state.update(request.json)
    return jsonify({"ok": True})

# ── API: Scripts ──────────────────────────────────────────────────────────────

@app.route("/api/script", methods=["POST"])
def api_script_create():
    d = request.json or {}
    s = {
        "id": gen_id(),
        "name": d.get("name", "Новый скрипт"),
        "code": d.get("code", '# Новый скрипт\nprint("Привет, мир!")\n'),
        "folder_id": d.get("folder_id"),
        "tags": d.get("tags", []),
        "description": d.get("description", ""),
        "color": d.get("color", "#00ff88"),
        "icon": d.get("icon", "🐍"),
        "run_dir": d.get("run_dir", str(Path.home())),
        "pinned": False,
        "created": datetime.now().isoformat(),
        "modified": datetime.now().isoformat(),
    }
    vault_state["scripts"].append(s)
    return jsonify(s)

@app.route("/api/script/<sid>", methods=["PUT"])
def api_script_update(sid):
    d = request.json or {}
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            s.update(d)
            s["modified"] = datetime.now().isoformat()
            return jsonify(s)
    return jsonify({"error": "Не найден"}), 404

@app.route("/api/script/<sid>", methods=["DELETE"])
def api_script_delete(sid):
    vault_state["scripts"] = [s for s in vault_state["scripts"] if s["id"] != sid]
    return jsonify({"ok": True})

@app.route("/api/script/<sid>/analyze")
def api_analyze(sid):
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            result = analyze_code(s["code"])
            result["dep_status"] = {p: check_installed(p) for p in result["third_party"]}
            return jsonify(result)
    return jsonify({"error": "Не найден"}), 404

# ── API: Run ──────────────────────────────────────────────────────────────────

@app.route("/api/script/<sid>/run", methods=["POST"])
def api_run(sid):
    d = request.json or {}
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            cleanup_run_file(sid)
            run_dir = d.get("run_dir") or s.get("run_dir") or str(Path.home())
            try:
                work_dir = resolve_run_dir(run_dir)
            except FileNotFoundError as e:
                return jsonify({"error": str(e)}), 400
            except OSError as e:
                return jsonify({"error": str(e)}), 400

            script_file = work_dir / f"pyvault_run_{sid}.py"
            try:
                script_file.write_text(wrap_script_code_for_run(s["code"]), encoding="utf-8")
            except OSError as e:
                return jsonify({"error": f"Не удалось создать файл в {work_dir}: {e}"}), 500

            run_files[sid] = script_file
            run_logs[sid] = []
            run_partials[sid] = ""
            try:
                proc = subprocess.Popen(
                    python_run_args(script_file.name),
                    cwd=str(work_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    env=script_run_env(),
                )
                run_processes[sid] = proc

                def reader():
                    buf = ""
                    try:
                        while True:
                            ch = proc.stdout.read(1)
                            if ch == "":
                                break
                            if ch == "\r":
                                # Перерисовка текущей строки (spinner/progress).
                                run_partials[sid] = buf
                                continue
                            if ch == "\n":
                                run_logs.setdefault(sid, []).append(buf)
                                if len(run_logs[sid]) > 2000:
                                    run_logs[sid] = run_logs[sid][-2000:]
                                buf = ""
                                run_partials[sid] = ""
                                continue
                            buf += ch
                            run_partials[sid] = buf
                    except Exception:
                        pass
                    finally:
                        if buf:
                            run_logs.setdefault(sid, []).append(buf)
                            if len(run_logs[sid]) > 2000:
                                run_logs[sid] = run_logs[sid][-2000:]
                        run_partials[sid] = ""
                        try:
                            proc.wait()
                        except Exception:
                            pass
                        cleanup_run_file(sid)
                        if sid in run_processes and run_processes[sid] is proc:
                            del run_processes[sid]

                threading.Thread(target=reader, daemon=True).start()
                return jsonify({
                    "ok": True,
                    "pid": proc.pid,
                    "cwd": str(work_dir),
                    "script_path": str(script_file),
                })
            except Exception as e:
                cleanup_run_file(sid)
                return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Не найден"}), 404

@app.route("/api/script/<sid>/stop", methods=["POST"])
def api_stop(sid):
    proc = run_processes.pop(sid, None)
    if proc:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    cleanup_run_file(sid)
    return jsonify({"ok": True})

@app.route("/api/script/<sid>/input", methods=["POST"])
def api_input(sid):
    """Send a line of text to the running script's stdin."""
    text = (request.json or {}).get("text", "")
    proc = run_processes.get(sid)
    if proc and proc.poll() is None:
        try:
            proc.stdin.write(text + "\n")
            proc.stdin.flush()
            # Echo the input to the log so the terminal shows it
            run_logs.setdefault(sid, []).append(text)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Процесс не запущен"}), 400

@app.route("/api/script/<sid>/logs")
def api_logs(sid):
    return jsonify({
        "logs": run_logs.get(sid, []),
        "partial": run_partials.get(sid, ""),
        "running": sid in run_processes and run_processes[sid].poll() is None
    })

# ── API: Folders ──────────────────────────────────────────────────────────────

@app.route("/api/folder", methods=["POST"])
def api_folder_create():
    d = request.json or {}
    f = {
        "id": gen_id(),
        "name": d.get("name", "Новая папка"),
        "color": d.get("color", "#6366f1"),
        "icon": d.get("icon", "📁"),
        "parent_id": d.get("parent_id", None),
        "created": datetime.now().isoformat(),
    }
    vault_state["folders"].append(f)
    return jsonify(f)

@app.route("/api/folder/<fid>", methods=["PUT"])
def api_folder_update(fid):
    d = request.json or {}
    for f in vault_state["folders"]:
        if f["id"] == fid:
            f.update(d)
            return jsonify(f)
    return jsonify({"error": "Не найдена"}), 404

@app.route("/api/folder/<fid>", methods=["DELETE"])
def api_folder_delete(fid):
    vault_state["folders"] = [f for f in vault_state["folders"] if f["id"] != fid]
    for s in vault_state["scripts"]:
        if s.get("folder_id") == fid:
            s["folder_id"] = None
    return jsonify({"ok": True})

# ── API: Project ──────────────────────────────────────────────────────────────

@app.route("/api/project/export")
def api_export():
    buf = io.BytesIO()
    buf.write(json.dumps(vault_state, ensure_ascii=False, indent=2).encode("utf-8"))
    buf.seek(0)
    name = re.sub(r'[^\w\-]', '_', vault_state.get("project_name", "project"))
    return send_file(buf, mimetype="application/json",
                     as_attachment=True, download_name=f"{name}.pyvault")

@app.route("/api/project/new", methods=["POST"])
def api_project_new():
    global vault_state
    d = request.json or {}
    name = (d.get("project_name") or "Мой Проект").strip() or "Мой Проект"
    for sid in list(run_processes.keys()):
        proc = run_processes.pop(sid, None)
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        cleanup_run_file(sid)
    run_logs.clear()
    run_partials.clear()
    vault_state = default_vault_state(name)
    return jsonify({"ok": True, "name": name, "state": vault_state})

@app.route("/api/project/import", methods=["POST"])
def api_import():
    global vault_state
    if "file" not in request.files:
        return jsonify({"error": "Нет файла"}), 400
    try:
        data = json.loads(request.files["file"].read().decode("utf-8"))
        vault_state.clear()
        vault_state.update(default_vault_state())
        vault_state.update(data)
        return jsonify({"ok": True, "name": vault_state.get("project_name")})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ── API: Install ──────────────────────────────────────────────────────────────

@app.route("/api/install", methods=["POST"])
def api_install():
    pkg = (request.json or {}).get("package", "")
    if not re.match(r'^[a-zA-Z0-9_\-\[\]>=<\.,]+$', pkg):
        return jsonify({"error": "Недопустимое имя пакета"}), 400
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", pkg, "--break-system-packages"],
            capture_output=True, text=True, timeout=180
        )
        out = r.stdout + r.stderr
        return jsonify({"ok": r.returncode == 0, "output": out})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── API: Compile ──────────────────────────────────────────────────────────────

@app.route("/api/compile/<sid>", methods=["POST"])
def api_compile(sid):
    for s in vault_state["scripts"]:
        if s["id"] == sid:
            d = request.json or {}
            build_type = d.get("build_type", "onefile")   # "onefile" | "onedir"
            icon_b64   = d.get("icon_b64")                # base64-encoded .ico, optional

            tmp_dir = Path(tempfile.gettempdir()) / f"pyvault_compile_{sid}"
            tmp_dir.mkdir(exist_ok=True)
            safe_name = re.sub(r'[^\w]', '_', s['name'])
            py_file = tmp_dir / f"{safe_name}.py"
            py_file.write_text(s["code"], encoding="utf-8")

            no_console = d.get("noconsole", False)

            cmd = [
                sys.executable, "-m", "PyInstaller",
                f"--{build_type}",
                "--distpath", str(tmp_dir / "dist"),
                "--workpath", str(tmp_dir / "build"),
                "--specpath", str(tmp_dir),
            ]

            if no_console:
                cmd.append("--noconsole")

            # Write icon file if provided
            if icon_b64:
                import base64
                try:
                    ico_path = tmp_dir / f"{safe_name}.ico"
                    ico_path.write_bytes(base64.b64decode(icon_b64))
                    cmd += ["--icon", str(ico_path)]
                except Exception:
                    pass  # ignore bad icon data

            cmd.append(str(py_file))

            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            if build_type == "onefile":
                exe = tmp_dir / "dist" / safe_name
                if not exe.exists():
                    exe = tmp_dir / "dist" / (safe_name + ".exe")
                if exe.exists():
                    ascii_name = re.sub(r'[^\w\-.]', '_', exe.name)
                    return send_file(str(exe), as_attachment=True, download_name=ascii_name)
            else:
                # onedir — zip the folder
                import zipfile
                dist_dir = tmp_dir / "dist" / safe_name
                if not dist_dir.exists():
                    dist_dir = tmp_dir / "dist" / safe_name.rstrip("_")
                if dist_dir.exists():
                    zip_path = tmp_dir / f"{safe_name}.zip"
                    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                        for f_path in dist_dir.rglob("*"):
                            zf.write(f_path, f_path.relative_to(dist_dir.parent))
                    ascii_zip = re.sub(r'[^\w\-.]', '_', zip_path.name)
                    return send_file(str(zip_path), as_attachment=True, download_name=ascii_zip)

            return jsonify({"error": "Не удалось скомпилировать",
                            "output": (r.stdout + r.stderr)[-4000:]}), 500
    return jsonify({"error": "Не найден"}), 404

# ── API: Dir listing ──────────────────────────────────────────────────────────

@app.route("/api/drives")
def api_drives():
    """Список дисков (Windows) для выбора рабочей директории."""
    drives = []
    if sys.platform == "win32":
        import string
        for letter in string.ascii_uppercase:
            root = f"{letter}:\\"
            if os.path.exists(root):
                drives.append({"name": f"{letter}:", "path": root, "is_dir": True})
    return jsonify({"drives": drives, "is_windows": sys.platform == "win32"})

@app.route("/api/ls")
def api_ls():
    path = request.args.get("path", str(Path.home()))
    if path in ("", "/", "\\"):
        path = str(Path.home())
    try:
        p = Path(path).resolve()
        items = []
        for item in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            try:
                items.append({"name": item.name, "path": str(item), "is_dir": item.is_dir()})
            except OSError:
                continue
        parent = str(p.parent)
        if parent == str(p):
            parent = None
        return jsonify({"path": str(p), "parent": parent, "items": items})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ── Главная страница ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(str(TEMPLATES_DIR), "index.html")

# ── Запуск ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    STATIC_DIR.mkdir(exist_ok=True)
    TEMPLATES_DIR.mkdir(exist_ok=True)

    banner = """
╔══════════════════════════════════════════════╗
║   ⬡  PyVault — Хранилище Python-скриптов     ║
╠══════════════════════════════════════════════╣
║   Браузер:  http://localhost:7332            ║
║   Стоп:     Ctrl+C                           ║
╚══════════════════════════════════════════════╝
"""
    print(banner)

    def open_browser():
        import webbrowser, time
        time.sleep(1.0)
        webbrowser.open("http://localhost:7332")

    threading.Thread(target=open_browser, daemon=True).start()
    app.run(host="0.0.0.0", port=7332, debug=False, use_reloader=False, threaded=True)