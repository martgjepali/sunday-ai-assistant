"""
SUNDAY's bridge into Blender. SUNDAY starts Blender with:
    blender.exe [file.blend] --python sunday_bridge.py
and talks to this script over 127.0.0.1 (one JSON line per request, one per reply).

Every request must carry the token SUNDAY passed in SUNDAY_BLENDER_TOKEN. Work runs on
Blender's main thread through a timer. Code SUNDAY writes runs with restricted builtins:
no file access, no shell, no imports beyond Blender's own modules and a few math ones.
"""

import builtins
import contextlib
import io
import json
import math
import os
import queue
import re
import socket
import tempfile
import threading
import traceback

import bmesh
import bpy
import mathutils

PORT = int(os.environ.get("SUNDAY_BLENDER_PORT", "9876"))
TOKEN = os.environ.get("SUNDAY_BLENDER_TOKEN", "")
jobs = queue.Queue()

# ───────── Restricted execution for SUNDAY's own bpy code ─────────

ALLOWED_MODULES = {"bpy", "bmesh", "mathutils", "math", "random", "colorsys", "itertools", "functools"}
_real_import = builtins.__import__


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name.split(".")[0] not in ALLOWED_MODULES:
        raise ImportError(f"SUNDAY's Blender bridge doesn't allow importing {name!r}")
    return _real_import(name, globals, locals, fromlist, level)


_DENIED_BUILTINS = {
    "open", "exec", "eval", "compile", "__import__", "input", "breakpoint",
    "exit", "quit", "help", "globals", "locals", "vars", "memoryview", "__loader__", "__spec__",
}
SAFE_BUILTINS = {k: getattr(builtins, k) for k in dir(builtins) if k not in _DENIED_BUILTINS}
SAFE_BUILTINS["__import__"] = _safe_import

# Blender's own ways to touch files, run scripts or change the app — off limits to generated code.
BLOCKED = re.compile(
    r"bpy\.ops\.(wm|file|preferences|script|text|extensions|export_\w+|image\.save\w*|sound|render\.render)"
    r"|bpy\.utils|bpy\.app\.(handlers|driver_namespace)|addon_utils|as_module|libraries\.(write|load)"
    r"|save_render|\.save\(|filepath\w*\s*=|__\w+__"
)


def cmd_run(p):
    code = p.get("code", "")
    hit = BLOCKED.search(code)
    if hit:
        raise PermissionError(f"blocked by SUNDAY's bridge: {hit.group(0)!r} (no file, app or script operations)")
    out = io.StringIO()
    env = {
        "__builtins__": SAFE_BUILTINS,
        "__name__": "sunday",
        "bpy": bpy,
        "bmesh": bmesh,
        "mathutils": mathutils,
        "Vector": mathutils.Vector,
        "Euler": mathutils.Euler,
        "Matrix": mathutils.Matrix,
        "math": math,
    }
    with contextlib.redirect_stdout(out):
        exec(compile(code, "<sunday>", "exec"), env)
    try:
        with override():
            bpy.ops.ed.undo_push(message="SUNDAY")
    except Exception:
        pass
    result = env.get("result")
    return {
        "output": out.getvalue()[-6000:],
        "result": None if result is None else repr(result)[:2000],
        "objects": len(bpy.context.scene.objects),
    }


# ───────── Helpers ─────────


def view3d():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next(r for r in area.regions if r.type == "WINDOW")
                return win, area, region
    raise RuntimeError("No 3D viewport is open in Blender.")


def override():
    win, area, region = view3d()
    return bpy.context.temp_override(window=win, area=area, region=region)


VIEWS = {
    "front": (90, 0, 0),
    "back": (90, 0, 180),
    "right": (90, 0, 90),
    "left": (90, 0, -90),
    "top": (0, 0, 0),
    "three_quarter": (70, 0, 35),
    "three_quarter_back": (70, 0, 215),
}


def frame(objs, r3d):
    pts = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        return
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    r3d.view_location = (lo + hi) / 2
    r3d.view_distance = max((hi - lo).length * 1.15, 0.5)


# ───────── Commands ─────────


def cmd_ping(p):
    return {"blender": bpy.app.version_string, "file": bpy.data.filepath or "(unsaved)"}


def cmd_scene(p):
    objs = []
    for o in bpy.context.scene.objects:
        objs.append({
            "name": o.name,
            "type": o.type,
            "location": [round(v, 3) for v in o.location],
            "rotation": [round(math.degrees(v), 1) for v in o.rotation_euler],
            "dimensions": [round(v, 3) for v in o.dimensions],
            "parent": o.parent.name if o.parent else None,
            "collection": o.users_collection[0].name if o.users_collection else None,
            "materials": [s.material.name for s in getattr(o, "material_slots", []) if s.material],
            "modifiers": [m.type for m in getattr(o, "modifiers", [])],
            "vertices": len(o.data.vertices) if o.type == "MESH" else None,
            "hidden": o.hide_get(),
        })
    return {
        "file": bpy.data.filepath or "(unsaved)",
        "count": len(objs),
        "objects": objs[:250],
        "collections": [c.name for c in bpy.data.collections],
        "materials": [m.name for m in bpy.data.materials][:100],
    }


def cmd_look(p):
    """Renders the viewport (off-screen, so other windows on top don't matter) and returns the image path."""
    win, area, region = view3d()
    space = area.spaces.active
    r3d = space.region_3d
    angle = VIEWS.get(p.get("view") or "three_quarter", VIEWS["three_quarter"])
    r3d.view_rotation = mathutils.Euler([math.radians(a) for a in angle]).to_quaternion()
    r3d.view_perspective = "PERSP"
    names = p.get("objects")
    targets = [o for o in bpy.context.scene.objects if o.visible_get() and o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
    if names:
        targets = [o for o in targets if o.name in names] or targets
    frame(targets, r3d)
    space.shading.type = p.get("shading") or "MATERIAL"

    scene = bpy.context.scene
    old = (scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage)
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1200, 900, 100
    path = os.path.join(tempfile.gettempdir(), "sunday_blender_view.png")
    try:
        with bpy.context.temp_override(window=win, area=area, region=region):
            bpy.ops.render.opengl(write_still=False, view_context=True)
        bpy.data.images["Render Result"].save_render(path)
    finally:
        scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = old
    return {"image": path, "view": p.get("view") or "three_quarter", "framed": len(targets)}


def cmd_import(p):
    path = p["path"]
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.data.objects.keys())
    with override():
        if ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=path)
        elif ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=path)
        elif ext == ".obj":
            bpy.ops.wm.obj_import(filepath=path)
        elif ext == ".stl":
            bpy.ops.wm.stl_import(filepath=path)
        else:
            raise ValueError(f"Can't import {ext} files (glb, gltf, fbx, obj, stl work).")
    return {"imported": [n for n in bpy.data.objects.keys() if n not in before]}


def cmd_save(p):
    path = p["path"]
    if os.path.exists(path):
        raise FileExistsError(f"{path} already exists — I never overwrite.")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with override():
        bpy.ops.wm.save_as_mainfile(filepath=path)
    return {"saved": path}


COMMANDS = {"ping": cmd_ping, "scene": cmd_scene, "run": cmd_run, "look": cmd_look, "import": cmd_import, "save": cmd_save}

# ───────── Plumbing: socket thread ↔ main-thread timer ─────────


def tick():
    while not jobs.empty():
        req, box, done = jobs.get()
        try:
            fn = COMMANDS.get(req.get("type"))
            if not fn:
                raise ValueError(f"unknown command {req.get('type')!r}")
            box["res"] = {"ok": True, "result": fn(req.get("params") or {})}
        except Exception as e:
            box["res"] = {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
        done.set()
    return 0.05


def handle(conn):
    with conn:
        f = conn.makefile("rwb")
        try:
            req = json.loads(f.readline() or b"{}")
        except ValueError:
            return
        if not TOKEN or req.get("token") != TOKEN:
            res = {"ok": False, "error": "wrong token"}
        else:
            box, done = {}, threading.Event()
            jobs.put((req, box, done))
            done.wait(900)
            res = box.get("res", {"ok": False, "error": "Blender didn't finish within 15 minutes."})
        f.write((json.dumps(res) + "\n").encode())
        f.flush()


def serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        srv.bind(("127.0.0.1", PORT))
    except OSError as e:
        print(f"[SUNDAY] bridge couldn't use port {PORT}: {e}")
        return
    srv.listen(8)
    print(f"[SUNDAY] bridge listening on 127.0.0.1:{PORT}")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


bpy.app.timers.register(tick, persistent=True)
threading.Thread(target=serve, daemon=True).start()
