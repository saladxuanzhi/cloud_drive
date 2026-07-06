import os
import shutil
import json
import uuid
import time
import hashlib
import re
import zipfile
from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ================= 配置区 =================
# 系统根目录：存放 .trash、.tmp、.pinned.json、trash_db.json 等网盘自身文件。
# 用户在 UI 里看不到这些文件。
CLOUD_DRIVE_ROOT = os.getenv("CLOUD_DRIVE_ROOT", "D:\\Drive")
# 用户可见的最上层目录。所有文件/目录操作都基于此目录解析相对路径。
USER_ROOT = os.getenv("USER_ROOT", CLOUD_DRIVE_ROOT)

# 网盘自身用的文件位置（与用户文件隔离，不出现在文件列表中）
DRIVE_DATA_DIR = os.getenv("DRIVE_DATA_DIR", os.path.join(CLOUD_DRIVE_ROOT, ".system_data"))
TRASH_DIR = os.path.join(DRIVE_DATA_DIR, ".trash")
TEMP_DIR = os.path.join(DRIVE_DATA_DIR, ".tmp")
PINNED_FILE = os.path.join(DRIVE_DATA_DIR, ".pinned.json")
TRASH_DB_FILE = os.path.join(TRASH_DIR, "trash_db.json")
ICONS_DIR = Path(__file__).parent / "icons"

# 复制链接凭证有效期（秒）：1 小时
COPY_LINK_TTL = 3600
# 直接下载凭证有效期（秒）：60 秒（仅用于前端立即下载）
DIRECT_DOWNLOAD_TTL = 60
# 文件夹下载大小限制（字节）：200 MB。超过限制不允许打包下载。
FOLDER_DOWNLOAD_LIMIT = 200 * 1024 * 1024
# 文本预览大小上限（字节）：2 MB。超过则返回 413。
TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024
# 图片预览大小上限（字节）：50 MB。超过则返回 413。
IMAGE_PREVIEW_LIMIT = 50 * 1024 * 1024
# 二进制检测窗口：读取文件首部 8KB 找 NUL 字节。
BINARY_SNIFF_BYTES = 8 * 1024
# 允许预览的图片扩展 → MIME。
_IMAGE_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png",  "gif":  "image/gif",
    "webp": "image/webp", "svg": "image/svg+xml",
    "bmp": "image/bmp",  "ico":  "image/x-icon",
}
# 允许预览的文本/代码/配置扩展。lower-case 比较。
_TEXT_EXTS = {
    # 纯文本/笔记
    "txt","md","markdown","log","rst",
    # 代码
    "js","jsx","ts","tsx","mjs","cjs",
    "py","java","kt","scala","groovy",
    "c","h","cpp","cc","cxx","hpp","hh",
    "go","rs","swift","m","mm","rb","php",
    "sh","bash","zsh","fish","ps1","bat","cmd",
    "sql","lua","pl","r","dart","vue","svelte",
    "css","scss","sass","less","html","htm","xml",
    # 配置 / 数据
    "json","yml","yaml","toml","ini","env","conf",
    "properties","cfg","gradle","cmake",
}

# 初始化系统目录
for d in [CLOUD_DRIVE_ROOT, USER_ROOT, TRASH_DIR, TEMP_DIR]:
    Path(d).mkdir(parents=True, exist_ok=True)
# 校验 USER_ROOT 必须是 CLOUD_DRIVE_ROOT 自身或它的子目录
_user_root_resolved = str(Path(USER_ROOT).resolve())
_system_root_resolved = str(Path(CLOUD_DRIVE_ROOT).resolve())
if not _user_root_resolved.startswith(_system_root_resolved):
    raise RuntimeError(
        f"USER_ROOT ({USER_ROOT}) 必须是 CLOUD_DRIVE_ROOT ({CLOUD_DRIVE_ROOT}) 的子目录或相同目录"
    )
if not os.path.exists(PINNED_FILE):
    with open(PINNED_FILE, 'w') as f: json.dump([], f)
if not os.path.exists(TRASH_DB_FILE):
    with open(TRASH_DB_FILE, 'w') as f: json.dump({}, f)
if not ICONS_DIR.exists():
    raise RuntimeError(f"未找到图标目录：{ICONS_DIR}")

app = FastAPI(title="Single-User Cloud Drive")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 内存中保存的下载凭证 {ticket_id: {"path": relative_path, "expires": timestamp, "kind": "direct" | "share"}}
DOWNLOAD_TICKETS = {}

# ================= 前端页面托管 =================
@app.get("/")
def serve_frontend():
    index_path = Path("index.html")
    if index_path.exists():
        return FileResponse(index_path)
    return JSONResponse(status_code=404, content={"error": "未找到 index.html"})

@app.get("/style.css")
def serve_css():
    css_path = Path("style.css")
    if css_path.exists():
        return FileResponse(css_path, media_type="text/css")
    return JSONResponse(
        status_code=404,
        content={"error": "未找到 style.css，请确保它与 main.py 放在同一目录下！"}
    )

@app.get("/script.js")
def serve_script():
    script_path = Path("script.js")
    if script_path.exists():
        return FileResponse(script_path, media_type="application/javascript")
    return JSONResponse(status_code=404, content={"error": "未找到 script.js"})

# ================= 图标按需加载 API =================
# 仅按需返回单个 SVG，不一次性加载全部图标。
# 前端通过 GET /api/icon/{name} 在用到某个图标时才发起请求。
_SAFE_ICON_NAME = re.compile(r"^[A-Za-z0-9_\-]+$")

@app.get("/api/icon/{name}")
def get_icon(name: str):
    """按需返回单个 SVG 图标；用不到就不会触发请求。"""
    # 仅允许字母/数字/下划线/连字符，杜绝路径穿越
    if not _SAFE_ICON_NAME.match(name):
        raise HTTPException(status_code=400, detail="Invalid icon name")
    icon_path = ICONS_DIR / f"{name}.svg"
    if not icon_path.exists() or not icon_path.is_file():
        raise HTTPException(status_code=404, detail=f"Icon '{name}' not found")
    return FileResponse(icon_path, media_type="image/svg+xml")

# ================= 核心安全验证方法 =================
def get_safe_path(rel_path: str) -> Path:
    # 文件操作都基于用户可见根目录解析，限制在 USER_ROOT 内防越界
    base = Path(USER_ROOT).resolve()
    rel_path = rel_path.lstrip('/') if rel_path else ""
    target = (base / rel_path).resolve()

    if not str(target).startswith(str(base)):
        raise HTTPException(status_code=403, detail="Access Denied: Path Traversal Detected!")
    return target

def load_json(filepath):
    with open(filepath, 'r', encoding='utf-8') as f: return json.load(f)

def save_json(filepath, data):
    with open(filepath, 'w', encoding='utf-8') as f: json.dump(data, f, ensure_ascii=False)

# 重命名时禁止出现的字符（Windows + POSIX 共同禁止集）
_INVALID_NAME_CHARS = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")

def _validate_basename(name: str) -> None:
    """校验 basename 合法性。重命名/新建文件夹前都应调用。"""
    if name is None or name == "":
        raise HTTPException(400, "名称不能为空")
    if name in (".", ".."):
        raise HTTPException(400, "名称无效")
    if name.endswith(" ") or name.endswith("."):
        # Windows 不允许以空格/点结尾
        raise HTTPException(400, "名称不能以空格或点结尾")
    if _INVALID_NAME_CHARS.search(name):
        raise HTTPException(400, "名称包含非法字符")
    if "/" in name or "\\" in name:
        raise HTTPException(400, "名称不能包含路径分隔符")

def _purge_expired_tickets() -> None:
    now = time.time()
    expired = [k for k, v in DOWNLOAD_TICKETS.items() if v['expires'] < now]
    for k in expired:
        del DOWNLOAD_TICKETS[k]

def get_folder_size(folder: Path) -> int:
    """递归累加文件夹内所有常规文件的大小（字节）。
    软链接、不可访问的子项会被跳过，不让一次坏文件拖崩整个下载。"""
    total = 0
    for root, dirs, files in os.walk(folder):
        for name in files:
            try:
                fp = Path(root) / name
                if fp.is_file() and not fp.is_symlink():
                    total += fp.stat().st_size
            except OSError:
                continue
    return total

def _zip_folder_to(src_dir: Path, zip_path: Path) -> None:
    """把 src_dir 下的所有文件打包到 zip_path，保留相对目录结构。"""
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(src_dir):
            for name in files:
                fp = Path(root) / name
                try:
                    if not fp.is_file() or fp.is_symlink():
                        continue
                    arcname = fp.relative_to(src_dir).as_posix()
                    zf.write(fp, arcname)
                except OSError:
                    continue

# ================= 基础/单项操作 API =================
@app.get("/api/storage")
def get_storage():
    total, used, free = shutil.disk_usage(USER_ROOT)
    return {"total": total, "used": used, "free": free}

@app.get("/api/files")
def list_files(path: str = ""):
    target = get_safe_path(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Directory not found")

    items = []
    for item in target.iterdir():
        if item.name.startswith('.'):
            continue
        stat = item.stat()
        items.append({
            "name": item.name,
            "is_dir": item.is_dir(),
            "size": stat.st_size if not item.is_dir() else 0,
            "modified": stat.st_mtime
        })
    items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
    return {"path": path, "items": items}

class ActionReq(BaseModel):
    path: str
    target_path: str = None

@app.post("/api/action/create_folder")
def create_folder(req: ActionReq):
    """创建文件夹。
    req.path 是要创建的目标完整路径（含父目录），例如 "documents/photos"。
    仅校验最后一段 basename；中间父目录若不存在会一并创建。
    """
    if not req.path:
        raise HTTPException(400, "缺少路径")
    _validate_basename(Path(req.path).name)

    target = get_safe_path(req.path)
    if target.exists():
        if target.is_dir():
            return {"success": True, "exists": True}
        raise HTTPException(409, "已存在同名文件，无法创建文件夹")

    try:
        target.mkdir(parents=True, exist_ok=False)
    except PermissionError:
        raise HTTPException(403, "权限不足，无法创建文件夹")
    except OSError as e:
        raise HTTPException(500, f"创建失败：{e}")
    return {"success": True}

@app.post("/api/action/rename")
def rename_item(req: ActionReq):
    """重命名：要求源/目标位于同一父目录，仅修改 basename。"""
    if not req.target_path:
        raise HTTPException(400, "缺少目标路径 target_path")

    src = get_safe_path(req.path)
    if not src.exists():
        raise HTTPException(404, "源文件不存在")

    dst = get_safe_path(req.target_path)

    # 必须位于同一目录：禁止把重命名变成"移动"
    if src.parent.resolve() != dst.parent.resolve():
        raise HTTPException(400, "重命名只能在同一目录下进行")

    new_name = dst.name
    _validate_basename(new_name)

    if src.name == new_name:
        # 名称未变，幂等返回
        return {"success": True, "unchanged": True}

    if dst.exists():
        raise HTTPException(409, f"已存在同名项：{new_name}")

    try:
        src.rename(dst)
    except PermissionError:
        raise HTTPException(403, "权限不足，无法重命名")
    except OSError as e:
        raise HTTPException(500, f"重命名失败：{e}")

    return {"success": True}

# ================= 移动 API =================
class MoveReq(BaseModel):
    paths: list[str]
    target_dir: str = ""  # 目标目录相对路径，"" 表示根目录

@app.post("/api/action/move")
def move_items(req: MoveReq):
    """把若干项移动到目标目录。
    - 目标必须是已存在的目录。
    - 跳过：源不存在 / 已在目标目录 / 移动到自身或子目录 / 目标已存在同名项。
    - 返回成功数量与逐项错误信息，便于前端提示。
    """
    dest_dir = get_safe_path(req.target_dir)
    if not dest_dir.exists() or not dest_dir.is_dir():
        raise HTTPException(404, "目标目录不存在")

    dest_res = dest_dir.resolve()
    moved = 0
    errors = []
    for p in req.paths:
        try:
            src = get_safe_path(p)
            if not src.exists():
                errors.append(f"{p}：源不存在")
                continue
            src_res = src.resolve()
            # 已在目标目录：无需移动
            if src.parent.resolve() == dest_res:
                errors.append(f"{src.name}：已在目标目录中")
                continue
            # 不能把目录移动到它自身或其子目录
            if src.is_dir() and (dest_res == src_res or str(dest_res).startswith(str(src_res) + os.sep)):
                errors.append(f"{src.name}：不能移动到自身或其子目录")
                continue
            dst = dest_dir / src.name
            if dst.exists():
                errors.append(f"{src.name}：目标已存在同名项")
                continue
            shutil.move(str(src), str(dst))
            moved += 1
        except Exception as e:
            errors.append(f"{p}：{e}")
    return {"success": True, "moved": moved, "errors": errors}

# ================= 固定路径（Pin）API =================
class PinReq(BaseModel):
    path: str = ""

def _load_valid_pins():
    """读取固定列表，顺带清理已不存在的目录。"""
    pins = load_json(PINNED_FILE)
    valid = []
    for p in pins:
        try:
            t = get_safe_path(p)
            if t.exists() and t.is_dir():
                valid.append(p)
        except HTTPException:
            continue
    if len(valid) != len(pins):
        save_json(PINNED_FILE, valid)
    return valid

@app.get("/api/pinned")
def get_pinned():
    return {"pinned": _load_valid_pins()}

@app.post("/api/action/pin")
def toggle_pin(req: PinReq):
    """切换固定：已固定则取消，未固定则添加。仅允许固定存在的目录。"""
    path = req.path.strip("/") if req.path else ""
    target = get_safe_path(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "目录不存在，无法固定")

    pins = _load_valid_pins()
    if path in pins:
        pins.remove(path)
        pinned = False
    else:
        pins.append(path)
        pinned = True
    save_json(PINNED_FILE, pins)
    return {"success": True, "pinned": pinned, "pinned_list": pins}

# ================= 回收站 API & 批量操作 =================
@app.get("/api/trash")
def list_trash():
    """读取回收站数据库并返回内容"""
    trash_db = load_json(TRASH_DB_FILE)
    valid_trash = {}
    items = []
    for trashed_name, meta in trash_db.items():
        p = Path(TRASH_DIR) / trashed_name
        if p.exists():
            valid_trash[trashed_name] = meta
            items.append({
                "trashed_name": trashed_name,
                "original_path": meta["original_path"],
                "name": Path(meta["original_path"]).name,
                "deleted_at": meta["deleted_at"],
                "is_dir": meta.get("is_dir", False),
                "size": meta.get("size", 0)
            })
    if len(valid_trash) != len(trash_db):
        save_json(TRASH_DB_FILE, valid_trash)

    items.sort(key=lambda x: x["deleted_at"], reverse=True)
    return {"items": items}

class BulkTrashReq(BaseModel):
    paths: list[str]

@app.post("/api/action/bulk_trash")
def bulk_trash(req: BulkTrashReq):
    """批量移入回收站"""
    trash_db = load_json(TRASH_DB_FILE)
    success_count = 0
    for path_str in req.paths:
        try:
            src = get_safe_path(path_str)
            if src.exists():
                trash_id = str(uuid.uuid4())
                trashed_name = f"{trash_id}_{src.name}"
                dst = Path(TRASH_DIR) / trashed_name

                is_dir = src.is_dir()
                size = 0 if is_dir else src.stat().st_size

                shutil.move(str(src), str(dst))
                trash_db[trashed_name] = {
                    "original_path": path_str,
                    "deleted_at": time.time(),
                    "is_dir": is_dir,
                    "size": size
                }
                success_count += 1
        except Exception as e:
            print(f"Error trashing {path_str}: {e}")

    save_json(TRASH_DB_FILE, trash_db)
    return {"success": True, "count": success_count}

class BulkRestoreReq(BaseModel):
    trashed_names: list[str]

@app.post("/api/action/bulk_restore")
def bulk_restore(req: BulkRestoreReq):
    """批量从回收站中还原"""
    trash_db = load_json(TRASH_DB_FILE)
    success_count = 0
    for name in req.trashed_names:
        if name in trash_db:
            try:
                meta = trash_db[name]
                src = Path(TRASH_DIR) / name
                if src.exists():
                    dst = get_safe_path(meta["original_path"])
                    dst.parent.mkdir(parents=True, exist_ok=True)

                    if dst.exists(): # 重名处理
                        suffix = f"_restored_{int(time.time())}"
                        dst = dst.parent / f"{dst.stem}{suffix}{dst.suffix}"

                    shutil.move(str(src), str(dst))
                    del trash_db[name]
                    success_count += 1
            except Exception as e:
                print(f"Error restoring {name}: {e}")

    save_json(TRASH_DB_FILE, trash_db)
    return {"success": True, "count": success_count}

class BulkDeletePermanentlyReq(BaseModel):
    trashed_names: list[str]

@app.post("/api/action/bulk_delete_permanently")
def bulk_delete_permanently(req: BulkDeletePermanentlyReq):
    """批量永久删除（不可撤销）"""
    trash_db = load_json(TRASH_DB_FILE)
    success_count = 0
    for name in req.trashed_names:
        if name in trash_db:
            try:
                src = Path(TRASH_DIR) / name
                if src.exists():
                    if src.is_dir():
                        shutil.rmtree(src)
                    else:
                        src.unlink()
                del trash_db[name]
                success_count += 1
            except Exception as e:
                print(f"Error deleting permanently {name}: {e}")

    save_json(TRASH_DB_FILE, trash_db)
    return {"success": True, "count": success_count}

# ================= 下载 & 复制链接 凭证 API =================
@app.post("/api/download/ticket")
def generate_download_ticket(req: ActionReq):
    """前端立即下载使用：短时（60s）一次性 ticket。"""
    target = get_safe_path(req.path)
    if not target.exists() or target.is_dir():
        raise HTTPException(404, "File not found")

    _purge_expired_tickets()

    ticket_id = str(uuid.uuid4())
    DOWNLOAD_TICKETS[ticket_id] = {
        "path": req.path,
        "expires": time.time() + DIRECT_DOWNLOAD_TTL,
        "kind": "direct",
    }
    return {"ticket": ticket_id, "expires_in": DIRECT_DOWNLOAD_TTL}


@app.post("/api/download/folder/ticket")
def generate_folder_download_ticket(req: ActionReq):
    """前端立即下载文件夹：先计算大小，超过限制直接 413；否则压缩为 zip 并返回 ticket。"""
    target = get_safe_path(req.path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Folder not found")

    total_size = get_folder_size(target)
    limit = FOLDER_DOWNLOAD_LIMIT
    if total_size > limit:
        # 返回结构化错误，便于前端展示具体大小
        return JSONResponse(
            status_code=413,
            content={
                "error": "folder_too_large",
                "detail": f"文件夹大小 {total_size / 1024 / 1024:.1f}MB 超过下载限制 {limit / 1024 / 1024:.0f}MB",
                "size": total_size,
                "limit": limit,
            },
        )

    _purge_expired_tickets()

    # 把 ZIP 落到临时目录，文件名用 uuid 避免冲突
    zip_id = str(uuid.uuid4())
    zip_path = Path(TEMP_DIR) / f"{zip_id}.zip"
    try:
        _zip_folder_to(target, zip_path)
    except Exception as e:
        zip_path.unlink(missing_ok=True)
        raise HTTPException(500, f"打包失败：{e}")

    ticket_id = str(uuid.uuid4())
    DOWNLOAD_TICKETS[ticket_id] = {
        "path": req.path,
        "zip_id": zip_id,
        "expires": time.time() + DIRECT_DOWNLOAD_TTL,
        "kind": "folder",
    }
    return {
        "ticket": ticket_id,
        "expires_in": DIRECT_DOWNLOAD_TTL,
        "filename": f"{target.name}.zip",
        "size": total_size,
    }


@app.post("/api/action/copy_link")
def generate_copy_link(req: ActionReq, request: Request):
    """生成可分享的下载链接：1 小时内一次性有效。
    注意：只有当选中单个文件时才由前端调用此处，多选场景下前端会先提示。"""
    target = get_safe_path(req.path)
    if not target.exists():
        raise HTTPException(404, "源文件不存在")
    if target.is_dir():
        raise HTTPException(400, "暂不支持为文件夹生成分享链接")

    _purge_expired_tickets()

    ticket_id = str(uuid.uuid4())
    DOWNLOAD_TICKETS[ticket_id] = {
        "path": req.path,
        "expires": time.time() + COPY_LINK_TTL,
        "kind": "share",
    }

    base = str(request.base_url).rstrip('/')
    url = f"{base}/api/download/file?ticket={ticket_id}"
    return {
        "url": url,
        "expires_in": COPY_LINK_TTL,
        "ticket": ticket_id,
    }


@app.get("/api/download/file")
def download_file(ticket: str, background: BackgroundTasks):
    """下载/分享链接统一出口：凭 ticket 取文件或文件夹 zip，取后 ticket 立即失效。
    文件夹场景下，响应返回后通过 BackgroundTasks 清理临时 zip。"""
    info = DOWNLOAD_TICKETS.pop(ticket, None)
    if info is None:
        raise HTTPException(403, "Invalid or expired ticket")
    if time.time() > info['expires']:
        raise HTTPException(403, "Ticket expired")

    kind = info.get("kind", "direct")

    if kind == "folder":
        zip_id = info.get("zip_id")
        zip_path = Path(TEMP_DIR) / f"{zip_id}.zip"
        if not zip_path.exists() or not zip_path.is_file():
            raise HTTPException(404, "压缩文件已失效，请重新发起下载")

        target = get_safe_path(info['path'])
        filename = f"{target.name}.zip" if target.exists() else "folder.zip"

        # 响应送出后再删临时文件，避免下载过程中文件被提前删除
        def _cleanup_zip():
            try:
                Path(zip_path).unlink(missing_ok=True)
            except Exception:
                pass
        background.add_task(_cleanup_zip)

        return FileResponse(zip_path, filename=filename, media_type="application/zip")

    target = get_safe_path(info['path'])
    if not target.exists() or target.is_dir():
        raise HTTPException(404, "File not found")
    return FileResponse(target, filename=target.name)

# ================= 预览 API =================
@app.get("/api/preview")
def preview_file(path: str = "", kind: str = "image"):
    """
    读取并返回单文件内容用于前端预览。
    - kind=image: 流式返回图像字节（FileResponse），设置正确的 Content-Type。
    - kind=text : 返回 JSON { content, size, truncated }。超过 2 MB → 413；含 NUL → 415。
    """
    if kind not in ("image", "text"):
        raise HTTPException(400, "kind 必须为 image 或 text")

    target = get_safe_path(path)
    if not target.exists():
        raise HTTPException(404, "文件不存在")
    if not target.is_file():
        raise HTTPException(400, "只能预览文件，不能预览目录或特殊项")
    if target.is_symlink():
        raise HTTPException(400, "不支持预览符号链接")

    ext = target.suffix.lstrip(".").lower()
    size = target.stat().st_size

    if kind == "image":
        if ext not in _IMAGE_MIME:
            raise HTTPException(400, f"不支持的图片格式：{ext or '(无扩展名)'}")
        if size > IMAGE_PREVIEW_LIMIT:
            return JSONResponse(
                status_code=413,
                content={
                    "error": f"图片过大（>{IMAGE_PREVIEW_LIMIT // 1024 // 1024}MB），无法预览",
                    "size": size,
                },
            )
        return FileResponse(target, media_type=_IMAGE_MIME[ext])

    # kind == "text"
    if ext and ext not in _TEXT_EXTS:
        raise HTTPException(415, f"不支持的文本格式：{ext}")
    if size > TEXT_PREVIEW_LIMIT:
        return JSONResponse(
            status_code=413,
            content={
                "error": f"文件过大（>{TEXT_PREVIEW_LIMIT // 1024 // 1024}MB），仅支持预览 2MB 以内的文本",
                "size": size,
                "limit": TEXT_PREVIEW_LIMIT,
            },
        )

    try:
        with open(target, "rb") as f:
            head = f.read(BINARY_SNIFF_BYTES)
            rest = f.read()
    except PermissionError:
        raise HTTPException(403, "权限不足")
    except OSError as e:
        raise HTTPException(500, f"读取失败：{e}")

    if b"\x00" in head:
        return JSONResponse(status_code=415, content={"error": "binary", "size": size})

    text = (head + rest).decode("utf-8", errors="replace")
    return {"content": text, "size": size, "truncated": False}

# ================= 上传 API =================
@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    path: str = Form(""),
    client_md5: str = Form(...),
    relative_path: str = Form(""),
):
    """统一上传入口。
    - 单文件上传：relative_path 留空，最终路径为 path/file.filename。
    - 文件夹上传：relative_path 由前端传入 webkitRelativePath（如 "myfolder/sub/a.txt"），
      自动按相对路径建立子目录并保留文件夹结构。

    注意：这里直接用 os.replace 而不是 shutil.move。
    shutil.move 在目标已是目录时会"移入"它而非报错（且后续 fallback 可能在 Windows 上
    触发 WinError 3）；os.replace 语义清晰——目标父目录必须存在，否则直接报错。
    """
    temp_path = Path(TEMP_DIR) / str(uuid.uuid4())
    md5_hash = hashlib.md5()

    try:
        with open(temp_path, "wb") as f:
            while chunk := await file.read(8192 * 4):
                md5_hash.update(chunk)
                f.write(chunk)

        server_md5 = md5_hash.hexdigest()
        if server_md5 != client_md5:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(400, "MD5 Verification Failed")

        # 解析目标目录
        target_dir = get_safe_path(path)
        target_dir.mkdir(parents=True, exist_ok=True)

        if relative_path:
            # 文件夹模式：把 \\ 统一成 /、去掉首尾 /
            rel = relative_path.replace("\\", "/").strip("/")
            if not rel:
                raise HTTPException(400, "relative_path 非法")

            # 拼接完整相对路径，借助 get_safe_path 做越界校验
            final_path = get_safe_path(f"{path.strip('/')}/{rel}")

            # 创建父目录（含中间所有目录）
            parent = final_path.parent
            try:
                parent.mkdir(parents=True, exist_ok=True)
            except FileExistsError:
                raise HTTPException(409, f"无法创建目录：{parent} 与已有文件冲突")
            except OSError as e:
                raise HTTPException(500, f"创建目录失败：{e}")
        else:
            final_path = target_dir / file.filename

        # 防御性检查：temp 必须存在、父目录必须存在
        if not temp_path.exists():
            raise HTTPException(500, "临时文件丢失，请重试")
        if not final_path.parent.exists():
            raise HTTPException(500, f"父目录不存在：{final_path.parent}")

        # 直接 os.replace：原子替换，路径不存在时直接报错
        try:
            os.replace(str(temp_path), str(final_path))
        except FileNotFoundError as e:
            raise HTTPException(
                500,
                f"保存失败：路径不存在 {final_path.parent}（{e.strerror or e}）"
            )
        except PermissionError as e:
            raise HTTPException(403, f"权限不足：{e}")
        except OSError as e:
            raise HTTPException(500, f"保存失败：{e}")

        return {"success": True, "md5": server_md5, "saved_as": final_path.name}

    except HTTPException:
        temp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(500, str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)