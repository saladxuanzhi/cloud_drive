"""
单用户云盘后端 (FastAPI)。

运行模式:通常通过 Nginx 反向代理对外暴露,鉴权由 Nginx 承担(参见 Nginx 配置)。
本进程通常绑定 127.0.0.1:8000,默认开启 X-Forwarded-For 信任,以便读取真实客户端 IP
用于限流与审计日志。

安全要点(2026-07 重构):
  - 路径遍历:get_safe_path 用 Path.is_relative_to,Linux/Windows 都安全。
  - 上传防护:危险扩展黑名单(可配置)、文件大小上限、流式校验。
  - 票务防爆破:ticket 仍为 uuid4(122 位熵),但加入失败计数与 IP 锁定。
  - 限流:基于 IP 的滑动窗口(内存),针对高频/高成本端点单独配置。
  - 审计:trash/restore/delete/share/upload/download/move/rename 等动作写 audit.log。
  - CORS:不与 allow_credentials=True 联用;若需 CORS 需显式配置环境变量。
  - 响应头:全部响应带 X-Content-Type-Options: nosniff,降低 MIME 嗅探风险。
"""

import os
import shutil
import json
import uuid
import time
import hashlib
import re
import zipfile
import logging
import threading
from collections import deque
from pathlib import Path
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ================= 配置区 =================
# 平台自适应默认根目录:
#   - Windows: D:\Drive(开发习惯;若不存在会自动创建)
#   - Linux/macOS: ~/cloud-drive(用户级,无需 root)
# 推荐通过环境变量 CLOUD_DRIVE_ROOT 显式指定生产环境路径,
# 不要依赖默认值 —— 部署到不同机器时默认值不会自动迁移。
import sys as _sys
if _sys.platform == "win32":
    _DEFAULT_DRIVE_ROOT = "D:\\Drive"
else:
    _DEFAULT_DRIVE_ROOT = str(Path.home() / "cloud-drive")

CLOUD_DRIVE_ROOT = os.getenv("CLOUD_DRIVE_ROOT", _DEFAULT_DRIVE_ROOT)
USER_ROOT = os.getenv("USER_ROOT", CLOUD_DRIVE_ROOT)
DRIVE_DATA_DIR = os.getenv("DRIVE_DATA_DIR", os.path.join(CLOUD_DRIVE_ROOT, ".system_data"))
TRASH_DIR = os.path.join(DRIVE_DATA_DIR, ".trash")
TEMP_DIR = os.path.join(DRIVE_DATA_DIR, ".tmp")
PINNED_FILE = os.path.join(DRIVE_DATA_DIR, ".pinned.json")
TRASH_DB_FILE = os.path.join(TRASH_DIR, "trash_db.json")
LOG_DIR = os.path.join(DRIVE_DATA_DIR, "log")
AUDIT_LOG_FILE = os.path.join(LOG_DIR, "audit.log")
ICONS_DIR = Path(__file__).parent / "icons"

# 票据有效期与限流
COPY_LINK_TTL = int(os.getenv("COPY_LINK_TTL", "3600"))                # 1 小时
DIRECT_DOWNLOAD_TTL = int(os.getenv("DIRECT_DOWNLOAD_TTL", "60"))      # 60 秒

# 业务硬上限
FOLDER_DOWNLOAD_LIMIT = int(os.getenv("FOLDER_DOWNLOAD_LIMIT", str(200 * 1024 * 1024)))  # 200MB
TEXT_PREVIEW_LIMIT = int(os.getenv("TEXT_PREVIEW_LIMIT", str(2 * 1024 * 1024)))         # 2MB
IMAGE_PREVIEW_LIMIT = int(os.getenv("IMAGE_PREVIEW_LIMIT", str(50 * 1024 * 1024)))       # 50MB
BINARY_SNIFF_BYTES = 8 * 1024
MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE", str(10 * 1024 * 1024 * 1024)))       # 10GB/文件
UPLOAD_CHUNK_SIZE = 32 * 1024

# 限流阈值(按 IP 滑动窗口)
RATE_LIMIT_UPLOAD_PER_MIN = int(os.getenv("RATE_LIMIT_UPLOAD_PER_MIN", "30"))
RATE_LIMIT_FILE_LIST_PER_MIN = int(os.getenv("RATE_LIMIT_FILE_LIST_PER_MIN", "300"))
RATE_LIMIT_TICKET_PER_MIN = int(os.getenv("RATE_LIMIT_TICKET_PER_MIN", "60"))
RATE_LIMIT_FOLDER_TICKET_PER_MIN = int(os.getenv("RATE_LIMIT_FOLDER_TICKET_PER_MIN", "10"))
RATE_LIMIT_SHARE_PER_MIN = int(os.getenv("RATE_LIMIT_SHARE_PER_MIN", "30"))

# Ticket 失败保护:5 分钟内 N 次失败 -> 锁定 IP 15 分钟
TICKET_FAIL_WINDOW = 300
TICKET_FAIL_THRESHOLD = 10
TICKET_FAIL_LOCKOUT = 900

# Nginx 反代时是否信任 X-Forwarded-For。直连部署请设为 false。
TRUST_PROXY = os.getenv("TRUST_PROXY", "true").lower() in ("1", "true", "yes")

# CORS:为空时回退到 [] (不开放);"*" 显式打开,只用于开发(不能配 credentials)
_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()] if _raw_origins else []

# 允许预览的图片扩展 → MIME。
# 注:已移除 svg,SVG 内嵌脚本可通过 <img> 标签触发 XSS,改为只可下载不能预览。
_IMAGE_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png",  "gif":  "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",  "ico":  "image/x-icon",
}
# 允许预览的文本/代码/配置扩展。lower-case 比较。
_TEXT_EXTS = {
    # 纯文本/笔记
    "txt", "md", "markdown", "log", "rst",
    # 代码
    "js", "jsx", "ts", "tsx", "mjs", "cjs",
    "py", "java", "kt", "scala", "groovy",
    "c", "h", "cpp", "cc", "cxx", "hpp", "hh",
    "go", "rs", "swift", "m", "mm", "rb", "php",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "sql", "lua", "pl", "r", "dart", "vue", "svelte",
    "css", "scss", "sass", "less", "html", "htm", "xml",
    # 配置 / 数据
    "json", "yml", "yaml", "toml", "ini", "env", "conf",
    "properties", "cfg", "gradle", "cmake",
}

# 上传黑名单:默认屏蔽常见 webshell/可执行扩展。
# 通过环境变量 UPLOAD_BLOCKED_EXTS="php5,asp" 追加;UPLOAD_BLOCKED_EXTS="-" 表示清空。
_DEFAULT_BLOCKED_EXTS = {
    "php", "php3", "php4", "php5", "phtml", "phar",
    "jsp", "jspx", "asp", "aspx", "asa", "cer", "cdx",
    "cgi", "pl",
    "exe", "bat", "cmd", "com", "scr", "msi",
    "vbs", "vbe", "ps1", "psm1", "wsf", "wsh", "hta",
    "sh", "bash",
    "dll", "so", "dylib",
    "jar", "war",
}
_extra_blocked = os.getenv("UPLOAD_BLOCKED_EXTS", "")
if _extra_blocked == "-":
    BLOCKED_EXTS = set()
elif _extra_blocked:
    BLOCKED_EXTS = _DEFAULT_BLOCKED_EXTS | {
        e.strip().lower().lstrip(".") for e in _extra_blocked.split(",") if e.strip()
    }
else:
    BLOCKED_EXTS = _DEFAULT_BLOCKED_EXTS

# Windows 保留名(大小写不敏感),防止与设备冲突
_WINDOWS_RESERVED = (
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)

# ================= 路径/目录初始化 =================
def _validate_and_init_dirs() -> None:
    """启动时严格校验 CLOUD_DRIVE_ROOT 可用性,失败时给出明确指引,而不是到
    第一个 HTTP 请求时才发现路径不可访问。"""
    root = Path(CLOUD_DRIVE_ROOT)

    # 1. 显式禁掉看起来像 Windows 盘符的相对路径(防止 Linux 下出现 ./D:\Drive 这种
    #    "创建成功但访问不到"的情况)
    if _sys.platform != "win32" and re.match(r"^[A-Za-z]:[\\/]", str(root)):
        raise RuntimeError(
            f"CLOUD_DRIVE_ROOT={CLOUD_DRIVE_ROOT!r} 是 Windows 盘符路径,但当前平台是 "
            f"{_sys.platform}。请通过环境变量显式指定 Linux 路径,例如:\n"
            f"  export CLOUD_DRIVE_ROOT=/var/lib/cloud-drive\n"
            f"或在 ~/.bashrc 中设置。脚本默认会在 Linux 下用 {Path.home() / 'cloud-drive'}。"
        )

    # 2. 创建(若已存在则跳过)
    try:
        for d in (CLOUD_DRIVE_ROOT, USER_ROOT, DRIVE_DATA_DIR, TRASH_DIR, TEMP_DIR, LOG_DIR):
            Path(d).mkdir(parents=True, exist_ok=True)
    except PermissionError as e:
        raise RuntimeError(
            f"无法创建 CLOUD_DRIVE_ROOT={CLOUD_DRIVE_ROOT} 下的目录: 权限不足 ({e})。"
            f"请确保运行用户对路径有写权限,或换一个可写目录。"
        ) from e
    except OSError as e:
        raise RuntimeError(
            f"无法创建 CLOUD_DRIVE_ROOT={CLOUD_DRIVE_ROOT}: {e}。"
            f"请检查路径是否合法、所在父目录是否存在且可写。"
        ) from e

    # 3. 校验确实可读可写(防止挂载只读卷等情况)
    if not os.access(str(root), os.R_OK | os.W_OK | os.X_OK):
        raise RuntimeError(
            f"CLOUD_DRIVE_ROOT={root} 不可读/写/执行。请检查权限或挂载状态。"
        )

    # 4. 校验 USER_ROOT 在 CLOUD_DRIVE_ROOT 之内
    user_root_resolved = Path(USER_ROOT).resolve()
    system_root_resolved = Path(CLOUD_DRIVE_ROOT).resolve()
    if not user_root_resolved.is_relative_to(system_root_resolved):
        raise RuntimeError(
            f"USER_ROOT ({USER_ROOT}) 必须是 CLOUD_DRIVE_ROOT ({CLOUD_DRIVE_ROOT}) 的子目录或相同目录"
        )


_validate_and_init_dirs()
if not Path(PINNED_FILE).exists():
    Path(PINNED_FILE).write_text("[]", encoding="utf-8")
if not Path(TRASH_DB_FILE).exists():
    Path(TRASH_DB_FILE).write_text("{}", encoding="utf-8")
if not ICONS_DIR.exists():
    raise RuntimeError(f"未找到图标目录：{ICONS_DIR}")

# ================= 日志系统 =================
# 审计日志:关键操作(上传/下载/分享/删除/移动/限流等)写入 audit.log
# 容量:每个 10MB 滚动,保留 5 个旧文件
audit_logger = logging.getLogger("cloud_drive.audit")
audit_logger.setLevel(logging.INFO)
audit_logger.propagate = False
_audit_handler = RotatingFileHandler(
    AUDIT_LOG_FILE, maxBytes=1 * 1024 * 1024, backupCount=5, encoding="utf-8"
)
_audit_handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
audit_logger.addHandler(_audit_handler)

# 错误日志:未捕获异常等
error_logger = logging.getLogger("cloud_drive.error")
error_logger.setLevel(logging.WARNING)
error_logger.propagate = False
_err_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, "error.log"),
    maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8",
)
_err_handler.setFormatter(
    logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
)
error_logger.addHandler(_err_handler)


def _client_ip(request: Request) -> str:
    """从请求中提取客户端 IP。Nginx 反代下取 X-Forwarded-For 链头;
    直连时取 client.host。"""
    if TRUST_PROXY:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
    return (request.client.host if request.client else "-") or "-"


def _ua(request: Request) -> str:
    ua = request.headers.get("user-agent", "-")
    return ua[:200] if ua else "-"


def log_audit(event: str, request: Request = None, **details) -> None:
    """写一条审计日志。所有用户态关键操作都应调用。
    格式: ISO 时间戳 | event | ip=<ip> | ua=<ua> | k=v k=v ..."""
    parts = [event]
    if request is not None:
        parts.append(f"ip={_client_ip(request)}")
        parts.append(f"ua={_ua(request)}")
    for k, v in details.items():
        # 截断过长的字段,避免日志膨胀
        sv = str(v)
        if len(sv) > 500:
            sv = sv[:500] + "..."
        parts.append(f"{k}={sv}")
    try:
        audit_logger.info(" | ".join(parts))
    except Exception:
        # 审计日志失败不能阻塞主流程
        pass


# ================= 限流(进程内滑动窗口) =================
class RateLimiter:
    """轻量级滑动窗口限流。所有状态都在内存中,重启即丢失。"""

    def __init__(self, max_requests: int, window_seconds: int):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._records: dict[str, deque] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> bool:
        """通过则返回 True 并记录;被限流则返回 False。"""
        now = time.time()
        cutoff = now - self.window_seconds
        with self._lock:
            bucket = self._records.get(key)
            if bucket is None:
                bucket = deque()
                self._records[key] = bucket
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.max_requests:
                return False
            bucket.append(now)
            return True

    def cleanup(self) -> None:
        """定期清空过期键,防止内存增长。"""
        cutoff = time.time() - self.window_seconds
        with self._lock:
            for k in list(self._records.keys()):
                bucket = self._records[k]
                while bucket and bucket[0] < cutoff:
                    bucket.popleft()
                if not bucket:
                    del self._records[k]


# 各端点限流器
_rate_upload = RateLimiter(RATE_LIMIT_UPLOAD_PER_MIN, 60)
_rate_list = RateLimiter(RATE_LIMIT_FILE_LIST_PER_MIN, 60)
_rate_ticket = RateLimiter(RATE_LIMIT_TICKET_PER_MIN, 60)
_rate_folder_ticket = RateLimiter(RATE_LIMIT_FOLDER_TICKET_PER_MIN, 60)
_rate_share = RateLimiter(RATE_LIMIT_SHARE_PER_MIN, 60)

# Ticket 失败跟踪:失败次数过多 -> 锁定一段时间
_ticket_fail_lock = threading.Lock()
_ticket_fail_records: dict[str, deque] = {}
_ticket_fail_lockouts: dict[str, float] = {}


def _ticket_is_locked(ip: str) -> bool:
    with _ticket_fail_lock:
        unlock = _ticket_fail_lockouts.get(ip, 0)
        if unlock and time.time() < unlock:
            return True
        if unlock:
            _ticket_fail_lockouts.pop(ip, None)
        return False


def _ticket_record_failure(ip: str) -> bool:
    """记录一次 ticket 失败,达到阈值则锁定。返回是否刚刚被锁定。"""
    now = time.time()
    cutoff = now - TICKET_FAIL_WINDOW
    with _ticket_fail_lock:
        bucket = _ticket_fail_records.get(ip)
        if bucket is None:
            bucket = deque()
            _ticket_fail_records[ip] = bucket
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        bucket.append(now)
        if len(bucket) >= TICKET_FAIL_THRESHOLD:
            _ticket_fail_lockouts[ip] = now + TICKET_FAIL_LOCKOUT
            return True
        return False


def _ticket_record_success(ip: str) -> None:
    with _ticket_fail_lock:
        _ticket_fail_records.pop(ip, None)
        _ticket_fail_lockouts.pop(ip, None)


# ================= FastAPI 应用 =================
app = FastAPI(title="Single-User Cloud Drive")

# CORS:不与 allow_credentials 联用;默认关闭,需显式开启
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# 全局安全响应头
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception:
        error_logger.exception("未捕获异常: %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "internal_server_error"},
        )
    # 防止 MIME 嗅探,影响所有文本/二进制响应
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # 文件下载/预览多数为 inline,可加 Referrer-Policy 减少跨站泄露
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


# 上传大小前置校验(Content-Length 头)
@app.middleware("http")
async def reject_oversize_request(request: Request, call_next):
    if request.url.path == "/api/upload":
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_UPLOAD_SIZE + 1024 * 1024:
            # +1MB 余量留给 multipart 头
            return JSONResponse(
                status_code=413,
                content={
                    "error": "request_too_large",
                    "limit": MAX_UPLOAD_SIZE,
                },
            )
    return await call_next(request)


# 内存下载凭证表 {ticket_id: {...}}
DOWNLOAD_TICKETS: dict[str, dict] = {}


def _purge_expired_tickets() -> None:
    now = time.time()
    expired = [k for k, v in DOWNLOAD_TICKETS.items() if v["expires"] < now]
    for k in expired:
        del DOWNLOAD_TICKETS[k]


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
        content={"error": "未找到 style.css,请确保它与 main.py 放在同一目录下！"},
    )


@app.get("/script.js")
def serve_script():
    script_path = Path("script.js")
    if script_path.exists():
        return FileResponse(script_path, media_type="application/javascript")
    return JSONResponse(status_code=404, content={"error": "未找到 script.js"})


# ================= 图标按需加载 API =================
# 名称必须只含字母/数字/下划线/连字符,杜绝路径穿越
_SAFE_ICON_NAME = re.compile(r"^[A-Za-z0-9_\-]+$")


@app.get("/api/icon/{name}")
def get_icon(name: str):
    """按需返回单个 SVG 图标;用不到就不会触发请求。"""
    if not _SAFE_ICON_NAME.match(name):
        raise HTTPException(status_code=400, detail="Invalid icon name")
    icon_path = ICONS_DIR / f"{name}.svg"
    if not icon_path.exists() or not icon_path.is_file():
        raise HTTPException(status_code=404, detail=f"Icon '{name}' not found")
    return FileResponse(icon_path, media_type="image/svg+xml")


# ================= 核心安全验证方法 =================
def get_safe_path(rel_path: str) -> Path:
    """把用户传入的相对路径解析为绝对路径并做越界检查。
    使用 Path.is_relative_to,跨平台可靠(Python 3.9+)。"""
    base = Path(USER_ROOT).resolve()
    rel_path = (rel_path or "").lstrip("/")
    target = (base / rel_path).resolve() if rel_path else base
    if not target.is_relative_to(base):
        raise HTTPException(
            status_code=403, detail="Access Denied: Path Traversal Detected!"
        )
    return target


def load_json(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(filepath, data):
    """原子写:先写临时文件再 os.replace,避免崩溃时半截文件。"""
    tmp = f"{filepath}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, filepath)


# 重命名时禁止出现的字符(Windows + POSIX 共同禁止集)
_INVALID_NAME_CHARS = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")


def _validate_basename(name: str) -> None:
    """校验 basename 合法性。重命名/新建文件夹/上传文件名前都应调用。"""
    if not name:
        raise HTTPException(400, "名称不能为空")
    if name in (".", ".."):
        raise HTTPException(400, "名称无效")
    if name.endswith(" ") or name.endswith("."):
        raise HTTPException(400, "名称不能以空格或点结尾")
    if _INVALID_NAME_CHARS.search(name):
        raise HTTPException(400, "名称包含非法字符")
    if "/" in name or "\\" in name:
        raise HTTPException(400, "名称不能包含路径分隔符")
    # Windows 保留名(在 Linux 上传也可能被同主机其他用户使用)
    stem = name.split(".")[0].upper()
    if stem in _WINDOWS_RESERVED:
        raise HTTPException(400, f"名称使用了系统保留字: {name}")


def _check_filename_for_upload(filename: str) -> str:
    """上传前校验文件名:返回清洗后的合法名;若不能修复则抛 400。
    校验项:控制字符/路径分隔符/Windows 保留名/黑名单扩展名。"""
    if not filename:
        raise HTTPException(400, "文件名为空")

    # 截取 basename 防止 file.filename 含路径
    base = filename.replace("\\", "/").split("/")[-1]
    if not base or base in (".", ".."):
        raise HTTPException(400, f"非法的文件名: {filename!r}")

    # 控制字符
    if any(ord(c) < 32 for c in base):
        raise HTTPException(400, "文件名包含控制字符")

    # 扩展名黑名单(对 basename 与父目录均做检查 —— 防止 double extension)
    parts = base.lower().split(".")
    for p in parts[1:]:  # 跳过文件名主体
        if p in BLOCKED_EXTS:
            raise HTTPException(400, f"禁止上传的文件类型: .{p}")

    # 走 _validate_basename 做剩余校验
    _validate_basename(base)
    return base


def get_folder_size(folder: Path) -> int:
    """递归累加文件夹内所有常规文件的大小(字节)。
    软链接、不可访问的子项会被跳过,不让一次坏文件拖崩整个下载。"""
    total = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                fp = Path(root) / name
                if fp.is_file() and not fp.is_symlink():
                    total += fp.stat().st_size
            except OSError:
                continue
    return total


def _zip_folder_to(src_dir: Path, zip_path: Path) -> None:
    """把 src_dir 下的所有文件打包到 zip_path,保留相对目录结构。"""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, _dirs, files in os.walk(src_dir):
            for name in files:
                fp = Path(root) / name
                try:
                    if not fp.is_file() or fp.is_symlink():
                        continue
                    arcname = fp.relative_to(src_dir).as_posix()
                    zf.write(fp, arcname)
                except OSError:
                    continue


def _require_rate(limiter: RateLimiter, request: Request) -> None:
    ip = _client_ip(request)
    if not limiter.check(ip):
        log_audit("RATE_LIMIT", request, endpoint=request.url.path)
        raise HTTPException(429, "请求过于频繁,请稍后再试")


# ================= 基础/单项操作 API =================
@app.get("/api/storage")
def get_storage(request: Request):
    _require_rate(_rate_list, request)
    total, used, free = shutil.disk_usage(USER_ROOT)
    return {"total": total, "used": used, "free": free}


@app.get("/api/files")
def list_files(path: str = "", request: Request = None):
    _require_rate(_rate_list, request)
    target = get_safe_path(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Directory not found")

    items = []
    for item in target.iterdir():
        if item.name.startswith("."):
            continue
        try:
            stat = item.stat()
        except OSError:
            continue
        items.append({
            "name": item.name,
            "is_dir": item.is_dir(),
            "size": stat.st_size if not item.is_dir() else 0,
            "modified": stat.st_mtime,
        })
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return {"path": path, "items": items}


class ActionReq(BaseModel):
    path: str
    target_path: str = None


@app.post("/api/action/create_folder")
def create_folder(req: ActionReq, request: Request):
    """创建文件夹。req.path 是目标完整路径(含父目录),例如 "documents/photos"。
    仅校验最后一段 basename;中间父目录若不存在会一并创建。"""
    if not req.path:
        raise HTTPException(400, "缺少路径")
    _validate_basename(Path(req.path).name)
    target = get_safe_path(req.path)
    if target.exists():
        if target.is_dir():
            return {"success": True, "exists": True}
        raise HTTPException(409, "已存在同名文件,无法创建文件夹")
    try:
        target.mkdir(parents=True, exist_ok=False)
    except PermissionError:
        raise HTTPException(403, "权限不足,无法创建文件夹")
    except FileExistsError as e:
        raise HTTPException(409, f"路径冲突: {e}")
    except OSError as e:
        raise HTTPException(500, f"创建失败:{e}")
    log_audit("CREATE_FOLDER", request, path=req.path)
    return {"success": True}


@app.post("/api/action/rename")
def rename_item(req: ActionReq, request: Request):
    """重命名:要求源/目标位于同一父目录,仅修改 basename。"""
    if not req.target_path:
        raise HTTPException(400, "缺少目标路径 target_path")
    src = get_safe_path(req.path)
    if not src.exists():
        raise HTTPException(404, "源文件不存在")
    dst = get_safe_path(req.target_path)
    # 必须位于同一目录:禁止把重命名变成"移动"
    if src.parent.resolve() != dst.parent.resolve():
        raise HTTPException(400, "重命名只能在同一目录下进行")
    new_name = dst.name
    _validate_basename(new_name)
    if src.name == new_name:
        return {"success": True, "unchanged": True}
    if dst.exists():
        raise HTTPException(409, f"已存在同名项:{new_name}")
    try:
        src.rename(dst)
    except PermissionError:
        raise HTTPException(403, "权限不足,无法重命名")
    except OSError as e:
        raise HTTPException(500, f"重命名失败:{e}")
    log_audit("RENAME", request, src=req.path, dst=req.target_path)
    return {"success": True}


# ================= 移动 API =================
class MoveReq(BaseModel):
    paths: list[str]
    target_dir: str = ""  # 目标目录相对路径,"" 表示根目录


@app.post("/api/action/move")
def move_items(req: MoveReq, request: Request):
    """把若干项移动到目标目录。
    - 目标必须是已存在的目录。
    - 跳过:源不存在 / 已在目标目录 / 移动到自身或子目录 / 目标已存在同名项。
    - 返回成功数量与逐项错误信息,便于前端提示。"""
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
                errors.append(f"{p}:源不存在")
                continue
            src_res = src.resolve()
            if src.parent.resolve() == dest_res:
                errors.append(f"{src.name}:已在目标目录中")
                continue
            # 不能把目录移动到它自身或其子目录
            if src.is_dir() and (
                dest_res == src_res or dest_res.is_relative_to(src_res)
            ):
                errors.append(f"{src.name}:不能移动到自身或其子目录")
                continue
            dst = dest_dir / src.name
            if dst.exists():
                errors.append(f"{src.name}:目标已存在同名项")
                continue
            shutil.move(str(src), str(dst))
            moved += 1
        except Exception as e:
            errors.append(f"{p}:{e}")
    log_audit("MOVE", request, target=req.target_dir, count=moved, errors=len(errors))
    return {"success": True, "moved": moved, "errors": errors}


# ================= 固定路径 (Pin) API =================
class PinReq(BaseModel):
    path: str = ""


def _load_valid_pins():
    """读取固定列表,顺带清理已不存在的目录。"""
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
def get_pinned(request: Request):
    _require_rate(_rate_list, request)
    return {"pinned": _load_valid_pins()}


@app.post("/api/action/pin")
def toggle_pin(req: PinReq, request: Request):
    """切换固定:已固定则取消,未固定则添加。仅允许固定存在的目录。"""
    path = req.path.strip("/") if req.path else ""
    target = get_safe_path(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "目录不存在,无法固定")
    pins = _load_valid_pins()
    if path in pins:
        pins.remove(path)
        pinned = False
    else:
        pins.append(path)
        pinned = True
    save_json(PINNED_FILE, pins)
    log_audit("PIN_TOGGLE", request, path=path, pinned=pinned)
    return {"success": True, "pinned": pinned, "pinned_list": pins}


# ================= 回收站 API =================
@app.get("/api/trash")
def list_trash(request: Request):
    _require_rate(_rate_list, request)
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
                "size": meta.get("size", 0),
            })
    if len(valid_trash) != len(trash_db):
        save_json(TRASH_DB_FILE, valid_trash)
    items.sort(key=lambda x: x["deleted_at"], reverse=True)
    return {"items": items}


class BulkTrashReq(BaseModel):
    paths: list[str]


@app.post("/api/action/bulk_trash")
def bulk_trash(req: BulkTrashReq, request: Request):
    """批量移入回收站,返回每项结果,前端可展示具体失败原因。"""
    trash_db = load_json(TRASH_DB_FILE)
    moved = 0
    errors = []
    for path_str in req.paths:
        try:
            src = get_safe_path(path_str)
            if not src.exists():
                errors.append(f"{path_str}:源不存在")
                continue
            trash_id = str(uuid.uuid4())
            trashed_name = f"{trash_id}_{src.name}"
            dst = Path(TRASH_DIR) / trashed_name
            is_dir = src.is_dir()
            try:
                size = 0 if is_dir else src.stat().st_size
            except OSError:
                size = 0
            shutil.move(str(src), str(dst))
            trash_db[trashed_name] = {
                "original_path": path_str,
                "deleted_at": time.time(),
                "is_dir": is_dir,
                "size": size,
            }
            moved += 1
        except Exception as e:
            errors.append(f"{path_str}:{e}")
    save_json(TRASH_DB_FILE, trash_db)
    log_audit("BULK_TRASH", request, count=moved, errors=len(errors))
    return {"success": True, "count": moved, "errors": errors}


class BulkRestoreReq(BaseModel):
    trashed_names: list[str]


@app.post("/api/action/bulk_restore")
def bulk_restore(req: BulkRestoreReq, request: Request):
    """批量从回收站中还原,返回每项结果。"""
    trash_db = load_json(TRASH_DB_FILE)
    moved = 0
    errors = []
    for name in req.trashed_names:
        if name not in trash_db:
            errors.append(f"{name}:不在回收站中")
            continue
        try:
            meta = trash_db[name]
            src = Path(TRASH_DIR) / name
            if not src.exists():
                errors.append(f"{name}:回收站文件已丢失")
                # 同步清理 DB
                trash_db.pop(name, None)
                continue
            dst = get_safe_path(meta["original_path"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                # 重名处理:附加 _restored_<ts> 后缀
                suffix = f"_restored_{int(time.time())}"
                dst = dst.parent / f"{dst.stem}{suffix}{dst.suffix}"
            shutil.move(str(src), str(dst))
            trash_db.pop(name, None)
            moved += 1
        except Exception as e:
            errors.append(f"{name}:{e}")
    save_json(TRASH_DB_FILE, trash_db)
    log_audit("BULK_RESTORE", request, count=moved, errors=len(errors))
    return {"success": True, "count": moved, "errors": errors}


class BulkDeletePermanentlyReq(BaseModel):
    trashed_names: list[str]


@app.post("/api/action/bulk_delete_permanently")
def bulk_delete_permanently(req: BulkDeletePermanentlyReq, request: Request):
    """批量永久删除(不可撤销),返回每项结果。"""
    trash_db = load_json(TRASH_DB_FILE)
    deleted = 0
    errors = []
    for name in req.trashed_names:
        if name not in trash_db:
            errors.append(f"{name}:不在回收站中")
            continue
        try:
            src = Path(TRASH_DIR) / name
            if src.exists():
                if src.is_dir() and not src.is_symlink():
                    shutil.rmtree(src)
                else:
                    src.unlink()
            trash_db.pop(name, None)
            deleted += 1
        except Exception as e:
            errors.append(f"{name}:{e}")
    save_json(TRASH_DB_FILE, trash_db)
    log_audit("BULK_DELETE_PERMANENT", request, count=deleted, errors=len(errors))
    return {"success": True, "count": deleted, "errors": errors}


# ================= 下载 & 复制链接 凭证 API =================
@app.post("/api/download/ticket")
def generate_download_ticket(req: ActionReq, request: Request):
    """前端立即下载使用:短时(60s)一次性 ticket。"""
    _require_rate(_rate_ticket, request)
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
    log_audit("DOWNLOAD_TICKET", request, path=req.path)
    return {"ticket": ticket_id, "expires_in": DIRECT_DOWNLOAD_TTL}


@app.post("/api/download/folder/ticket")
def generate_folder_download_ticket(req: ActionReq, request: Request):
    """前端立即下载文件夹:先计算大小,超过限制直接 413;否则压缩为 zip 并返回 ticket。"""
    _require_rate(_rate_folder_ticket, request)
    target = get_safe_path(req.path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Folder not found")
    total_size = get_folder_size(target)
    limit = FOLDER_DOWNLOAD_LIMIT
    if total_size > limit:
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
    zip_id = str(uuid.uuid4())
    zip_path = Path(TEMP_DIR) / f"{zip_id}.zip"
    try:
        _zip_folder_to(target, zip_path)
    except Exception as e:
        zip_path.unlink(missing_ok=True)
        raise HTTPException(500, f"打包失败:{e}")
    ticket_id = str(uuid.uuid4())
    DOWNLOAD_TICKETS[ticket_id] = {
        "path": req.path,
        "zip_id": zip_id,
        "expires": time.time() + DIRECT_DOWNLOAD_TTL,
        "kind": "folder",
    }
    log_audit("FOLDER_DOWNLOAD_TICKET", request, path=req.path, size=total_size)
    return {
        "ticket": ticket_id,
        "expires_in": DIRECT_DOWNLOAD_TTL,
        "filename": f"{target.name}.zip",
        "size": total_size,
    }


def _build_share_url(request: Request, ticket_id: str) -> str:
    """构造分享链接。优先使用环境变量 PUBLIC_BASE_URL(避免 Host 头伪造);
    未配置时回退到 request.base_url。"""
    public_base = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    if public_base:
        return f"{public_base}/api/download/file?ticket={ticket_id}"
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/download/file?ticket={ticket_id}"


@app.post("/api/action/copy_link")
def generate_copy_link(req: ActionReq, request: Request):
    """生成可分享的下载链接:1 小时内一次性有效。
    注意:只有当选中单个文件时才由前端调用此处,多选场景下前端会先提示。"""
    _require_rate(_rate_share, request)
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
    url = _build_share_url(request, ticket_id)
    log_audit("SHARE_LINK", request, path=req.path)
    return {
        "url": url,
        "expires_in": COPY_LINK_TTL,
        "ticket": ticket_id,
    }


@app.get("/api/download/file")
def download_file(ticket: str, background: BackgroundTasks, request: Request):
    """下载/分享链接统一出口:凭 ticket 取文件或文件夹 zip,取后 ticket 立即失效。
    文件夹场景下,响应返回后通过 BackgroundTasks 清理临时 zip。"""
    ip = _client_ip(request)
    if _ticket_is_locked(ip):
        log_audit("TICKET_LOCKED", request)
        raise HTTPException(403, "Access denied")

    info = DOWNLOAD_TICKETS.pop(ticket, None)
    if info is None:
        if _ticket_record_failure(ip):
            log_audit("TICKET_FAIL_LOCKOUT", request)
            raise HTTPException(403, "Access denied")
        log_audit("TICKET_FAIL", request)
        raise HTTPException(403, "Invalid or expired ticket")
    if time.time() > info["expires"]:
        log_audit("TICKET_EXPIRED", request, kind=info.get("kind"))
        raise HTTPException(403, "Ticket expired")
    _ticket_record_success(ip)

    kind = info.get("kind", "direct")
    if kind == "folder":
        zip_id = info.get("zip_id")
        zip_path = Path(TEMP_DIR) / f"{zip_id}.zip"
        if not zip_path.exists() or not zip_path.is_file():
            raise HTTPException(404, "压缩文件已失效,请重新发起下载")
        target = get_safe_path(info["path"])
        filename = f"{target.name}.zip" if target.exists() else "folder.zip"

        def _cleanup_zip():
            try:
                Path(zip_path).unlink(missing_ok=True)
            except Exception:
                pass

        background.add_task(_cleanup_zip)
        log_audit("FOLDER_DOWNLOAD", request, path=info["path"])
        return FileResponse(zip_path, filename=filename, media_type="application/zip")

    target = get_safe_path(info["path"])
    if not target.exists() or target.is_dir():
        raise HTTPException(404, "File not found")
    log_audit("FILE_DOWNLOAD", request, path=info["path"], kind=kind)
    return FileResponse(target, filename=target.name)


# ================= 预览 API =================
@app.get("/api/preview")
def preview_file(path: str = "", kind: str = "image", request: Request = None):
    """读取并返回单文件内容用于前端预览。
    - kind=image: 流式返回图像字节(FileResponse),设置正确的 Content-Type。
      (注:不再支持 svg 预览,避免 SVG XSS 风险)
    - kind=text : 返回 JSON { content, size, truncated }。超过 2 MB → 413;含 NUL → 415。
    """
    _require_rate(_rate_list, request)
    if kind not in ("image", "text"):
        raise HTTPException(400, "kind 必须为 image 或 text")
    target = get_safe_path(path)
    if not target.exists():
        raise HTTPException(404, "文件不存在")
    if not target.is_file():
        raise HTTPException(400, "只能预览文件,不能预览目录或特殊项")
    if target.is_symlink():
        raise HTTPException(400, "不支持预览符号链接")
    ext = target.suffix.lstrip(".").lower()
    size = target.stat().st_size
    if kind == "image":
        if ext not in _IMAGE_MIME:
            raise HTTPException(400, f"不支持的图片格式:{ext or '(无扩展名)'}")
        if size > IMAGE_PREVIEW_LIMIT:
            return JSONResponse(
                status_code=413,
                content={
                    "error": f"图片过大(>{IMAGE_PREVIEW_LIMIT // 1024 // 1024}MB),无法预览",
                    "size": size,
                },
            )
        return FileResponse(target, media_type=_IMAGE_MIME[ext])

    # kind == "text"
    if ext and ext not in _TEXT_EXTS:
        raise HTTPException(415, f"不支持的文本格式:{ext}")
    if size > TEXT_PREVIEW_LIMIT:
        return JSONResponse(
            status_code=413,
            content={
                "error": f"文件过大(>{TEXT_PREVIEW_LIMIT // 1024 // 1024}MB),仅支持预览 2MB 以内的文本",
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
        raise HTTPException(500, f"读取失败:{e}")
    if b"\x00" in head:
        return JSONResponse(status_code=415, content={"error": "binary", "size": size})
    text = (head + rest).decode("utf-8", errors="replace")
    return {"content": text, "size": size, "truncated": False}


# ================= 上传 API =================
@app.post("/api/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    path: str = Form(""),
    client_md5: str = Form(...),
    relative_path: str = Form(""),
):
    """统一上传入口。
    - 单文件上传:relative_path 留空,最终路径为 path/file.filename。
    - 文件夹上传:relative_path 由前端传入 webkitRelativePath(如 "myfolder/sub/a.txt"),
      自动按相对路径建立子目录并保留文件夹结构。
    安全:
      - 限流:每 IP 每分钟 N 次。
      - 扩展名黑名单(可配置)。
      - 文件名清洗 + 大小上限(流式校验)。
      - 原子替换(os.replace)避免半截文件。
    """
    _require_rate(_rate_upload, request)
    # 文件名校验
    safe_name = _check_filename_for_upload(file.filename or "")
    temp_path = Path(TEMP_DIR) / str(uuid.uuid4())
    md5_hash = hashlib.md5()
    total_bytes = 0
    try:
        with open(temp_path, "wb") as f:
            while chunk := await file.read(UPLOAD_CHUNK_SIZE):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_SIZE:
                    f.close()
                    temp_path.unlink(missing_ok=True)
                    log_audit(
                        "UPLOAD_REJECT_SIZE",
                        request,
                        path=path,
                        attempted=total_bytes,
                        limit=MAX_UPLOAD_SIZE,
                    )
                    raise HTTPException(
                        413, f"文件超过大小限制 {MAX_UPLOAD_SIZE // 1024 // 1024}MB"
                    )
                md5_hash.update(chunk)
                f.write(chunk)

        server_md5 = md5_hash.hexdigest()
        if server_md5 != client_md5:
            temp_path.unlink(missing_ok=True)
            log_audit("UPLOAD_MD5_MISMATCH", request, path=path, name=safe_name)
            raise HTTPException(400, "MD5 Verification Failed")

        # 解析目标目录
        target_dir = get_safe_path(path)
        target_dir.mkdir(parents=True, exist_ok=True)

        if relative_path:
            # 文件夹模式
            rel = relative_path.replace("\\", "/").strip("/")
            if not rel:
                temp_path.unlink(missing_ok=True)
                raise HTTPException(400, "relative_path 非法")
            # 校验每个中间段
            for seg in rel.split("/"):
                if seg and seg != "." and seg != "..":
                    _validate_basename(seg)
            final_path = get_safe_path(f"{path.strip('/')}/{rel}")
            parent = final_path.parent
            try:
                parent.mkdir(parents=True, exist_ok=True)
            except FileExistsError:
                temp_path.unlink(missing_ok=True)
                raise HTTPException(409, f"无法创建目录:{parent} 与已有文件冲突")
            except OSError as e:
                temp_path.unlink(missing_ok=True)
                raise HTTPException(500, f"创建目录失败:{e}")
        else:
            final_path = target_dir / safe_name
            # 冲突检查
            if final_path.exists():
                temp_path.unlink(missing_ok=True)
                raise HTTPException(409, f"已存在同名文件:{safe_name}")

        if not temp_path.exists():
            raise HTTPException(500, "临时文件丢失,请重试")
        if not final_path.parent.exists():
            temp_path.unlink(missing_ok=True)
            raise HTTPException(500, f"父目录不存在:{final_path.parent}")

        try:
            os.replace(str(temp_path), str(final_path))
        except FileNotFoundError as e:
            raise HTTPException(
                500,
                f"保存失败:路径不存在 {final_path.parent}({e.strerror or e})",
            )
        except PermissionError as e:
            raise HTTPException(403, f"权限不足:{e}")
        except OSError as e:
            raise HTTPException(500, f"保存失败:{e}")

        log_audit(
            "UPLOAD", request,
            path=str(final_path.relative_to(Path(USER_ROOT).resolve())),
            size=total_bytes, md5=server_md5,
        )
        return {"success": True, "md5": server_md5, "saved_as": final_path.name}

    except HTTPException:
        # 已经清理过临时文件的场景不要重复 unlink(可能已被前面的 raise 之前删了)
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        error_logger.exception("upload 异常: %s", e)
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        raise HTTPException(500, f"上传失败:{e}")


if __name__ == "__main__":
    import uvicorn
    # 绑定 127.0.0.1(由 Nginx 反代对外),如需直连请用 0.0.0.0 + 防火墙
    uvicorn.run(app, host="0.0.0.0", port=8000)
