const CONFIG = {
    // 从 index.html 头部内联脚本注入的全局变量读取二级路径。
    // 例如跑在 https://example.com/cloud-drive/ 时,值为 "/cloud-drive";
    // 跑在根路径时,值为 ""。所有 API 调用都会自动加上这个前缀。
    API_BASE: window.__BASE_PATH__ || "",
};

/**
 * 拼接父目录与子项名,避免 `parent ? parent + "/" + name : name` 散落各处。
 * 会自动去除 name 自身的首尾斜杠,以及把 \ 统一为 /。
 */
function joinPath(parent, name) {
    const cleanName = String(name || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!parent) return cleanName;
    if (!cleanName) return parent;
    return `${parent}/${cleanName}`;
}

// ================= URL 路径 Base64 编码 =================
// 用 ?path=b64:<...> 替代 ?path=<percent-encoded>,避免中文路径在地址栏上
// 变成超长 %xx 序列。新写入的 URL 一律带 b64: 前缀;读取时遇到 b64: 走
// Base64 解码,否则回退到 decodeURIComponent(旧链接平滑兼容)。
// 服务端所有 API 仍接收原始 path 字符串,前端在调用 API 前完成解码。
// 前缀用 "b64:" 是安全的:_validate_basename 禁止 : 作为文件名一部分。

/**
 * 把任意 Unicode path 编码为 URL-safe Base64(无 padding)。
 * 返回值形如 "b64:L29"  其中 ":" 后是 base64url 字符集 [A-Za-z0-9_-]。
 */
function encodePathForUrl(path) {
    if (!path) return "";
    try {
        // TextEncoder → 二进制字符串 → btoa,得到 UTF-8 安全的 Base64
        const bytes = new TextEncoder().encode(String(path));
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        return "b64:" + urlSafe;
    } catch (_) {
        // 极端情况(TextEncoder 不可用等):回退到 percent-encode,避免阻塞
        try { return "b64:" + btoa(unescape(encodeURIComponent(String(path)))); }
        catch (_) { return ""; }
    }
}

/**
 * 解码 ?path= 的原始值:识别 b64: 前缀走 Base64,否则按 legacy percent-encoded 处理。
 * 失败一律返回 ""(等同于根目录),不让坏 URL 阻塞页面初始化。
 */
function decodePathFromUrl(raw) {
    if (raw == null || raw === "") return "";
    if (typeof raw !== "string") return "";
    if (raw.startsWith("b64:")) {
        try {
            let b64 = raw.slice(4).replace(/-/g, "+").replace(/_/g, "/");
            // 补回缺失的 padding(atob 要求长度是 4 的倍数)
            const pad = b64.length % 4;
            if (pad) b64 += "=".repeat(4 - pad);
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder().decode(bytes);
        } catch (_) {
            return "";
        }
    }
    // legacy:旧分享链接或外部粘贴仍是 %E4%B8%AD... 形式
    try { return decodeURIComponent(raw); } catch (_) { return ""; }
}

// ================= 地址栏与 currentPath 同步 =================
// 把"当前目录"映射到 URL 的 ?path=foo/bar 查询参数,刷新/前进/后退都能恢复。
// 选用 query 而非 hash:更接近真实路由,刷新不依赖服务器端 fallback;
// 选用 query 而非 path-based 路由:静态托管(GitHub Pages / Vercel 等)刷新不会 404。
// 部署在子路径(例如 /cloud-drive/)时,所有 URL 都自动保留 __BASE_PATH__ 前缀。

/**
 * 从当前 location.search 解出"应该显示的视图与路径"。
 * 返回 { view, path }:
 *   - ?view=trash  → { view: "trash",  path: "" }        回收站
 *   - ?view=pinned → { view: "pinned", path: "" }        已固定的文件夹
 *   - ?path=b64:.. 或 ?path=foo/bar → { view: "files", path: "<解码后>" } 文件视图子目录
 *   - 其它(含无参数 / 非法值)→ { view: "files", path: "" } 主目录
 * 说明:主目录、回收站、已固定的文件夹各自拥有专属 URL,刷新/前进/后退都能恢复。
 *       path 参数的编码方式详见 encodePathForUrl/decodePathFromUrl。
 */
function stateFromUrl() {
    let params;
    try {
        params = new URLSearchParams(window.location.search);
    } catch (_) {
        return { view: "files", path: "" };
    }
    const view = params.get("view");
    if (view === "trash") return { view: "trash", path: "" };
    if (view === "pinned") return { view: "pinned", path: "" };

    const raw = params.get("path");
    if (raw === null) return { view: "files", path: "" };          // 无 ?path,视为主目录
    // 先解码(b64: 前缀或旧 percent-encoded),再做安全归一化
    const decoded = decodePathFromUrl(raw);
    if (decoded === "") return { view: "files", path: "" };       // 解码失败/空串视为根
    const normalized = String(decoded).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (normalized === "") return { view: "files", path: "" };     // ?path= 或 ?path=/// 也视为根
    if (/[\x00-\x1f]/.test(normalized)) return { view: "files", path: "" }; // 控制字符视为非法
    return { view: "files", path: normalized };
}

/**
 * 依据当前 currentView + currentPath,返回应出现在地址栏上的相对 URL(不含 origin)。
 *   - 回收站            → __BASE_PATH__ + "?view=trash"
 *   - 已固定的文件夹     → __BASE_PATH__ + "?view=pinned"
 *   - 主目录            → __BASE_PATH__
 *   - 文件视图子目录     → __BASE_PATH__ + "?path=b64:..."
 *
 * 使用 Base64 URL-Safe 编码(详见 encodePathForUrl),避免中文/特殊字符被
 * percent-encoded 成一长串 %xx,既不美观也容易触顶 URL 长度限制。
 */
function urlForState() {
    const base = window.__BASE_PATH__ || "";
    if (currentView === "trash") return `${base}?view=trash`;
    if (currentView === "pinned") return `${base}?view=pinned`;
    const path = (currentPath == null || currentPath === "") ? "" : String(currentPath);
    return path ? `${base}?path=${encodePathForUrl(path)}` : `${base}`;
}

/**
 * 把当前视图 + currentPath 同步到浏览器地址栏。
 * replace=true 用 history.replaceState(不增加历史项,启动期用);
 * replace=false 用 history.pushState(用户每次导航都新增一项,浏览器后退能回到上一步)。
 * 幂等:URL 已是目标时跳过,避免污染历史栈。
 * skipWhenFromPopstate=true 时跳过自身——popstate 触发的导航不应再写历史。
 */
function syncUrlFromState(replace, { skipWhenFromPopstate = false } = {}) {
    if (skipWhenFromPopstate && _popstateNavigating) return;
    const target = urlForState();
    const state = { view: currentView, path: currentPath };
    const current =
        window.location.pathname +
        (window.location.search || "") +
        (window.location.hash || "");
    // 同时归一化尾部 "/" 和 "?",避免外部链接尾部斜杠导致的重复条目污染历史栈。
    // 这条 norm 是浏览器回退正确性的关键:回退时若 location.pathname 末尾有 "/" 而 target 没有,
    // 不归一化会让 popstate 触发的 syncUrl 误认为"需要 pushState",结果在历史里塞进一条
    // URL 等价但不同的条目,导致第二次回退指向同一 URL、看起来"没反应"。
    const norm = (s) => s.replace(/\/+$/, "").replace(/\?+$/, "");
    if (norm(current) === norm(target)) return;
    try {
        if (replace) {
            window.history.replaceState(state, "", target);
        } else {
            window.history.pushState(state, "", target);
        }
    } catch (e) {
        // 文件:// 或权限异常环境下 history API 可能抛错;不影响网盘功能
        console.warn("[syncUrlFromState] history API 调用失败:", e);
    }
}

/**
 * 读取 URL 并导航到对应视图/目录。供 DOMContentLoaded 与 popstate 共用。
 * 会在导航期间 set 一个内部标志,阻止视图切换与 loadPath 再次写历史(pushState 重入)。
 */
let _popstateNavigating = false;
function navigateFromUrl({ replace = false } = {}) {
    const { view, path } = stateFromUrl();
    _popstateNavigating = true;
    const done = () => { _popstateNavigating = false; };

    if (view === "trash") {
        switchToTrashView();
        if (replace) syncUrlFromState(true, { skipWhenFromPopstate: true });
        done();
        return Promise.resolve();
    }
    if (view === "pinned") {
        switchToPinnedView();
        if (replace) syncUrlFromState(true, { skipWhenFromPopstate: true });
        done();
        return Promise.resolve();
    }
    // files 视图:切到文件视图并加载目标目录(path 为 "" 即主目录)
    switchToFilesView();
    if (replace) syncUrlFromState(true, { skipWhenFromPopstate: true });
    return Promise.resolve(loadPath(path || "")).finally(done);
}

// ================= 侧边栏宽度拖拽 =================
(function setupSidebarResizer() {
    const resizer = document.getElementById("sidebarResizer");
    if (!resizer) return;

    // 最左即为现在的 sidebar 宽度（256px）
    const MIN_W = 256;
    const MAX_W_RATIO = 0.45; // 上限 = 视口宽度 45%，避免挤掉主内容
    const STORAGE_KEY = "cloud_drive_sidebar_width";

    const computeMax = () => Math.max(MIN_W + 80, Math.floor(window.innerWidth * MAX_W_RATIO));

    const applyWidth = (w) => {
        document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    };

    // 启动时尝试恢复上次保存的宽度
    try {
        const saved = parseInt(localStorage.getItem(STORAGE_KEY) || "", 10);
        if (Number.isFinite(saved) && saved >= MIN_W && saved <= computeMax()) {
            applyWidth(saved);
        }
    } catch (_) { /* localStorage 不可用时忽略 */ }

    let dragging = false;
    let startX = 0;
    let startW = 0;

    const getSidebarWidth = () => {
        const el = document.querySelector(".sidebar");
        return el ? el.getBoundingClientRect().width : MIN_W;
    };

    const onPointerDown = (clientX, preventDefault) => {
        dragging = true;
        startX = clientX;
        startW = getSidebarWidth();
        resizer.classList.add("dragging");
        document.body.classList.add("resizing");
        if (preventDefault) preventDefault();
    };

    const onPointerMove = (clientX) => {
        if (!dragging) return;
        const maxW = computeMax();
        let newW = startW + (clientX - startX);
        newW = Math.max(MIN_W, Math.min(maxW, newW));
        applyWidth(newW);
    };

    const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove("dragging");
        document.body.classList.remove("resizing");
        const w = Math.round(getSidebarWidth());
        try { localStorage.setItem(STORAGE_KEY, String(w)); } catch (_) {}
    };

    // 鼠标
    resizer.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // 只响应左键
        onPointerDown(e.clientX, () => e.preventDefault());
    });
    document.addEventListener("mousemove", (e) => onPointerMove(e.clientX));
    document.addEventListener("mouseup", onPointerUp);

    // 触屏
    resizer.addEventListener("touchstart", (e) => {
        if (!e.touches || !e.touches[0]) return;
        onPointerDown(e.touches[0].clientX, () => e.preventDefault());
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
        if (!dragging || !e.touches || !e.touches[0]) return;
        onPointerMove(e.touches[0].clientX);
    }, { passive: true });
    document.addEventListener("touchend", onPointerUp);
    document.addEventListener("touchcancel", onPointerUp);

    // 窗口尺寸变化时，确保保存的宽度仍合法（不强制改写）
    window.addEventListener("resize", () => {
        const maxW = computeMax();
        const cur = Math.round(getSidebarWidth());
        if (cur > maxW) applyWidth(maxW);
    });
})();

let currentView = "files";
let currentPath = "";
let currentRawPath = ""; // 路径输入框在编辑模式下显示的"原始路径"，与 currentPath 同步
let currentItemsList = [];
// 渲染用列表:当前搜索词过滤后的结果。无搜索时与 currentItemsList 是同一引用。
// 表格渲染 / 虚拟滚动 / 行点击 / 操作按钮索引一律使用 displayedItems,
// 这样搜索与虚拟滚动(>=200 条只渲染可见行)可以正确协作。
let displayedItems = [];
let searchQuery = ""; // 当前搜索词(空串 = 不过滤)
let selectedItems = [];
let lastSelectedIndex = -1; // shift+click 的锚点；普通点击/Ctrl 加入时更新
let currentXHRs = {};
// 当前正在飞行的 /api/files 请求，用于快速切换目录时取消上一次请求，
// 避免旧响应覆盖新内容（例如点 pinned 后立刻点主目录时）。
let currentListController = null;
let pinnedPaths = []; // 已固定的目录相对路径列表
// 排序状态：sortField=name|modified|size，sortDirection=asc|desc
let sortField = "name";
let sortDirection = "asc";

// ================= 图标按需懒加载 =================
// 只在用到某个图标时才向后端请求一次，结果缓存在内存里。
// 整个会话的生命周期内，相同图标只请求一次；用不到的图标完全不会触发请求。
const iconCache = Object.create(null);   // 已成功加载的 SVG 字符串
const iconFailed = new Set();            // 加载失败的图标名，避免反复重试
const iconInflight = new Map();          // name -> Promise，防并发重复请求

async function loadIcon(name) {
    if (Object.prototype.hasOwnProperty.call(iconCache, name)) return iconCache[name];
    if (iconFailed.has(name)) return "";
    if (iconInflight.has(name)) return iconInflight.get(name);

    const p = fetch(`${CONFIG.API_BASE}/api/icon/${encodeURIComponent(name)}`)
        .then(async res => {
            if (!res.ok) {
                iconFailed.add(name);
                console.warn(`图标加载失败：${name} (${res.status})`);
                return "";
            }
            const svg = await res.text();
            iconCache[name] = svg;
            return svg;
        })
        .catch(err => {
            iconFailed.add(name);
            console.error(`图标请求异常：${name}`, err);
            return "";
        })
        .finally(() => iconInflight.delete(name));

    iconInflight.set(name, p);
    return p;
}

// 将 root 范围内所有 <* data-icon="x"> 占位符替换成对应的 SVG。
// 每个图标只会请求一次，并发安全。
async function renderIcons(root) {
    if (!root) return;
    const placeholders = Array.from(root.querySelectorAll("[data-icon]"));
    if (placeholders.length === 0) return;

    const names = Array.from(new Set(placeholders.map(el => el.getAttribute("data-icon"))));
    await Promise.all(names.map(n => loadIcon(n)));

    for (const el of placeholders) {
        if (!el.parentNode) continue; // 已被前面的替换摘除
        const name = el.getAttribute("data-icon");
        const svg = iconCache[name];
        if (!svg) continue;
        // 占位符是 .icon-wrapper 容器，保留容器、把 SVG 注入到内部，
        // 由 CSS 负责容器内 SVG 的居中与缩放，避免直接限制 svg 标签尺寸。
        el.innerHTML = svg;
    }
}

// ================= 自定义 tooltip（仿 Google Drive） =================
// 整页只创建一个浮层 <div class="data-tooltip">，通过事件委托监听所有
// 带 [data-tooltip] 的元素：进入时填字 + 定位 + 显示，离开时隐藏。
// 使用 mouseover/mouseout 而不是 mouseenter/mouseleave 是因为前者会冒泡，
// 这样无需给每个目标单独绑定监听。
(function setupTooltips() {
    const TIP_GAP = 6;          // tooltip 与目标元素的间距 (px)
    const VIEWPORT_PAD = 8;     // 离视口边缘的最小留白 (px)

    // 移动端没有 hover 概念，data-tooltip 整套浮层都不该出现。
    // 用 matchMedia 与 .is-mobile class 双重判断：class 由 index.html 注入，
    // 这里再响应断点变化，进入移动端时主动隐藏已经显示的 tooltip。
    const mq = window.matchMedia("(max-width: 768px)");
    const isMobile = () => mq.matches || document.documentElement.classList.contains("is-mobile");

    // 单一浮层：延迟创建，避免无 tooltip 页面也带一个空的 div。
    let tipEl = null;
    function ensureTip() {
        if (tipEl) return tipEl;
        tipEl = document.createElement("div");
        tipEl.className = "data-tooltip";
        tipEl.setAttribute("role", "tooltip");
        // pointer-events: none 防止浮层挡住 mousemove 触发连续定位
        tipEl.style.pointerEvents = "none";
        document.body.appendChild(tipEl);
        return tipEl;
    }

    function findTooltipTarget(node) {
        // 沿 DOM 树向上查找最近的带 [data-tooltip] 的祖先
        while (node && node !== document) {
            if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-tooltip")) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    function positionTip(target) {
        const tip = ensureTip();
        tip.textContent = target.getAttribute("data-tooltip") || "";
        // 先显示才能拿到尺寸
        tip.classList.add("visible");

        const rect = target.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        // 默认放在元素正下方
        let top = rect.bottom + TIP_GAP;
        let left = rect.left + rect.width / 2 - tipRect.width / 2;

        // 下方空间不足时翻到上方
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < tipRect.height + TIP_GAP + VIEWPORT_PAD && rect.top > tipRect.height + TIP_GAP + VIEWPORT_PAD) {
            top = rect.top - tipRect.height - TIP_GAP;
        }

        // 横向夹紧到视口内
        const maxLeft = window.innerWidth - tipRect.width - VIEWPORT_PAD;
        if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
        if (left > maxLeft) left = maxLeft;

        tip.style.top = (top + scrollY) + "px";
        tip.style.left = (left + scrollX) + "px";
    }

    function hideTip() {
        if (tipEl) tipEl.classList.remove("visible");
    }

    // mouseover 捕获进入：从触发节点向上找最近的 [data-tooltip]
    document.addEventListener("mouseover", (e) => {
        if (isMobile()) { hideTip(); return; }
        const target = findTooltipTarget(e.target);
        if (target) {
            positionTip(target);
        } else {
            // 移到了一个没有 tooltip 的区域，隐藏即可
            hideTip();
        }
    });

    // mouseout 捕获离开：relatedTarget 是新进入的节点，如果仍在某个 [data-tooltip]
    // 子树内就不该隐藏 —— 借助 findTooltipTarget 判断。
    document.addEventListener("mouseout", (e) => {
        if (isMobile()) { hideTip(); return; }
        const next = findTooltipTarget(e.relatedTarget);
        if (!next) hideTip();
    });

    // 滚动 / 窗口尺寸变化 / 按住隐藏原生 title 后，tooltip 应跟随消失
    window.addEventListener("scroll", hideTip, true);
    window.addEventListener("resize", hideTip);
    // ESC 也关闭（对键盘用户友好）
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideTip();
    });

    // 跨断点切换到移动端时，立刻收起任何残留的 tooltip，避免浮层停在屏幕上。
    const onBreakpointChange = () => { if (isMobile()) hideTip(); };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onBreakpointChange);
    else if (typeof mq.addListener === "function") mq.addListener(onBreakpointChange);
})();

window.addEventListener("DOMContentLoaded", () => {
    // 启动期异常不再静默:开发阶段如果脚本本身有错,直接弹出提示
    try {
        // 首屏静态图标已内联到 HTML，无需 renderIcons(document.body)；
        // 这里只处理动态按需加载（文件类型 dir/file/image、对话框 rename 等）。
        updateStorage();
        loadPinned();
        // 从 URL 恢复视图与目录(刷新页面 / 直接打开分享链接时能回到原视图):
        //   ?view=trash → 回收站, ?view=pinned → 已固定的文件夹, ?path=... / 无参 → 文件视图。
        // replace=true 让首次定位不增加历史项;视图切换由 navigateFromUrl 统一处理。
        navigateFromUrl({ replace: true });
    } catch (e) {
        console.error("[init]", e);
        alert("页面初始化失败:" + (e && e.message ? e.message : e));
    }
});

// 浏览器前进/后退:地址栏变了但 currentPath 没变,需要重新拉取对应目录。
// 这里不能用 pushState,否则会无限回环;由 navigateFromUrl 内部标志位保护。
// 弹出层优先级:预览 > 操作面板 > 路由(URL 同步)。
// closeXxxModal 在主动关闭时会 history.back(), 随之而来的 popstate 是自家副作用,
// 用 _suppressNextPopstateForXxx 直接吞掉, 防止重复拉取目录。
window.addEventListener("popstate", () => {
    window.DriveDrag?.cancel();
    if (_suppressNextPopstateForPreview) {
        _suppressNextPopstateForPreview = false;
        return;
    }
    if (_suppressNextPopstateForActionSheet) {
        _suppressNextPopstateForActionSheet = false;
        return;
    }
    if (document.getElementById("previewOverlay")) {
        _previewClosingFromPopstate = true;
        try {
            closePreviewModal();
        } finally {
            _previewClosingFromPopstate = false;
        }
        return;
    }
    if (document.querySelector(".mobile-action-sheet-overlay")) {
        _actionSheetClosingFromPopstate = true;
        try {
            closeMobileActions();
        } finally {
            _actionSheetClosingFromPopstate = false;
        }
        return;
    }
    navigateFromUrl({ replace: false });
});

// 全局错误兜底:script 错误除了进 console,也用 toast 让用户可见
window.addEventListener("error", (e) => {
    if (e && e.error) {
        console.error("[window.error]", e.error);
        showToast("页面发生内部错误,请打开控制台查看详情");
    }
});
window.addEventListener("unhandledrejection", (e) => {
    console.error("[unhandledrejection]", e.reason);
});

function switchToFilesView() {
    currentView = "files";
    // 不重置 currentPath、不调用 loadPath，由调用方决定目标路径并显式 loadPath，
    // 避免与调用方随后 loadPath(其他路径) 形成 fetch 竞争，
    // 导致面包屑与表格内容不一致。
    // 主目录仅在路径为 Home (currentPath === "") 时高亮，进入子目录后取消激活。
    document.body.setAttribute("data-view", "files");
    document.getElementById("navFiles").classList.toggle("active", currentPath === "");
    document.getElementById("navPinned").classList.remove("active");
    document.getElementById("navTrash").classList.remove("active");
    document.getElementById("bcPinBtn").style.display = "";
    clearSelection();
}

// 侧边栏「主目录」 / 面包屑 Home 共用的回到根目录入口:
//   1. 切到 files 视图
//   2. 清掉 currentPath(顺带让依赖 currentPath 的 UI 立即反映"已在根目录")
//   3. 直接调 History API 把 URL 改成裸 base,擦掉 ?path= / ?view= 等所有查询参数
//   4. 仅在状态真正变化时(从 trash/pinned 过来,或已在子目录)重新拉取根目录内容
// 不用 loadPath 改 URL——loadPath 是数据加载入口,职责单一;
// 也不用 syncUrlFromState——它的去重比较可能把"看起来已是裸 base"或"当前 entry 就这个 URL"
// 的边缘更新吞掉,Home 是高频点击,必须无条件把 ? 抹掉。
function navFilesClick() {
    const wasNonFilesView = currentView !== "files";
    const wasNotHome = currentPath !== "";
    switchToFilesView();
    currentPath = "";
    currentRawPath = "";
    // 部署在子路径(/cloud-drive/)时,base 是 "/cloud-drive";根部署时 base 是 ""。
    // fallback 用 pathname 去掉 ?# 后缀,处理 __BASE_PATH__ 未注入的极端情况。
    const base = window.__BASE_PATH__ || window.location.pathname.replace(/[?#].*$/, "");
    try {
        window.history.pushState({ view: "files", path: "" }, "", base);
    } catch (e) {
        // file:// 或权限异常下 history API 可能抛错,不影响网盘功能
        console.warn("[navFilesClick] history.pushState 调用失败:", e);
    }
    if (wasNonFilesView || wasNotHome) {
        loadPath("");
    }
}

function switchToPinnedView() {
    window.DriveDrag?.cancel();
    currentView = "pinned";
    document.body.setAttribute("data-view", "pinned");
    document.getElementById("navFiles").classList.remove("active");
    document.getElementById("navPinned").classList.add("active");
    document.getElementById("navTrash").classList.remove("active");
    // pinned 视图下不需要在面包屑尾部再"固定当前目录"按钮
    document.getElementById("bcPinBtn").style.display = "none";
    // 离开 files 视图：清掉 sidebar 中被高亮的 pinned-item
    updatePinButton();
    clearSelection();
    // 已固定的文件夹拥有专属 URL(?view=pinned);popstate/启动期由 navigateFromUrl 控制历史,
    // 这里 skipWhenFromPopstate 避免重复写历史。
    syncUrlFromState(false, { skipWhenFromPopstate: true });
    renderPinnedMain();
}

function switchToTrashView() {
    window.DriveDrag?.cancel();
    currentView = "trash";
    document.body.setAttribute("data-view", "trash");
    document.getElementById("navFiles").classList.remove("active");
    document.getElementById("navPinned").classList.remove("active");
    document.getElementById("navTrash").classList.add("active");
    // 回收站视图下固定按钮无意义，隐藏
    document.getElementById("bcPinBtn").style.display = "none";
    // 离开 files 视图：清掉 sidebar 中被高亮的 pinned-item
    updatePinButton();
    clearSelection();
    // 回收站拥有专属 URL(?view=trash);popstate/启动期由 navigateFromUrl 控制历史,
    // 这里 skipWhenFromPopstate 避免重复写历史。
    syncUrlFromState(false, { skipWhenFromPopstate: true });
    loadTrash();
}

// ================= 侧边栏：「已固定的文件夹」展开/折叠 =================
let pinnedSectionOpen = false;
function togglePinnedSection() {
    pinnedSectionOpen = !pinnedSectionOpen;
    syncPinnedExpander();
    renderPinnedSidebar();
}

/**
 * 把 sidebar 的三角 expander 状态与 pinnedSectionOpen 同步：
 * 展开时给 expander 加 .expanded（CSS 内 rotate 90deg 变成 ▼）。
 */
function syncPinnedExpander() {
    const expander = document.getElementById("navPinnedExpander");
    if (!expander) return;
    expander.classList.toggle("expanded", pinnedSectionOpen);
}

async function loadPath(path) {
    window.DriveDrag?.cancel();
    // 取消上一次未完成的 /api/files 请求，避免快速切换目录（如点 pinned 后立刻点主目录）
    // 时旧响应迟到覆盖新内容。
    if (currentListController) {
        currentListController.abort();
    }
    currentListController = new AbortController();

    currentPath = path;
    currentRawPath = path || "";
    updateBreadcrumb();
    updatePinButton();
    clearSelection();
    // 把当前目录同步到地址栏:由用户交互触发时 pushState(新增历史);
    // 由 popstate / 启动期触发时 navigateFromUrl 已经把 URL 改好,这里跳过避免冗余条目。
    // skipWhenFromPopstate 仅在 _popstateNavigating 为 true 时生效,不影响用户主动点击的写入。
    syncUrlFromState(false, { skipWhenFromPopstate: true });
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(path)}`, {
            signal: currentListController.signal,
        });
        if (!res.ok) {
            // 后端错误,显示具体信息方便排查(限流 / 越权 / 404 等)
            let detail = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                if (body && (body.detail || body.error)) {
                    detail = body.detail || body.error;
                }
            } catch (_) { /* 响应不是 JSON,忽略 */ }
            throw new Error(`后端 ${res.status}: ${detail}`);
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.items)) {
            throw new Error("后端返回格式异常:缺少 items 数组");
        }
        currentItemsList = data.items;
        renderTableHeader();
        renderTableBody();
        window.DriveDrag?.refreshTargets();
    } catch (e) {
        // 主动取消的请求不报错
        if (e && e.name === 'AbortError') return;
        console.error("[loadPath]", e);
        showAlert("加载目录失败", e && e.message ? e.message : String(e));
    }
}

/**
 * 把 pinnedPaths 渲染到主面板（右侧列表）。
 * 每条记录是 is_dir=true 的文件夹；点击可导航、双击也可导航。
 * 空 pinned 列表时显示「尚未固定任何文件夹」。
 */
function renderPinnedMain() {
    updateBreadcrumb();
    updatePinButton();
    currentItemsList = pinnedPaths.map(p => ({
        name: pathLabel(p),
        full_path: p,
        is_dir: true,
        size: 0,
        modified: 0,
    }));
    renderTableHeader();
    renderTableBody();
}

function openPinnedItem(idx) {
    const item = displayedItems[idx];
    if (!item || !item.is_dir) return;
    switchToFilesView();
    loadPath(item.full_path);
}

async function loadTrash() {
    updateBreadcrumb();
    clearSelection();
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/trash`);
        if (!res.ok) {
            // 后端错误(限流/500 等)要展示具体原因,而不是静默显示一个空回收站
            let detail = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                if (body && (body.detail || body.error)) {
                    detail = body.detail || body.error;
                }
            } catch (_) { /* 响应不是 JSON,忽略 */ }
            currentItemsList = [];
            renderTableHeader();
            renderTableBody();
            return showAlert("加载回收站失败", detail);
        }
        const data = await res.json();
        currentItemsList = Array.isArray(data.items) ? data.items : [];
        renderTableHeader();
        renderTableBody();
    } catch (e) {
        showAlert("加载回收站失败", e && e.message ? e.message : String(e));
    }
}

// ================= 列排序 =================
// 排序图标 SVG 颜色：rgb(0, 74, 119)；圆形背景：rgb(194, 231, 255)
const SORT_ARROW_COLOR = "rgb(0, 74, 119)";
const SORT_ARROW_BG = "rgb(194, 231, 255)";

// 每个字段的默认排序方向：用于未排序列 tooltip，以及 handleSortClick 跨列切换。
//   name    → asc  （A 到 Z）
//   modified→ desc （新到旧）
//   size    → desc （大到小）
const SORT_DEFAULT_DIR = { name: "asc", modified: "desc", size: "desc" };

/**
 * 构造可排序的列头：仅在 sortField === field 时显示箭头徽章，否则渲染占位 span。
 * 占位与箭头同尺寸，避免点击排序时列宽发生跳动。
 */
function sortableTh(label, field) {
    const isActive = sortField === field;
    const arrowHtml = isActive
        ? sortArrowSvg(sortDirection)
        : '<span class="sort-arrow-placeholder" aria-hidden="true"></span>';
    // tooltip 描述当前排序状态：
    //   - 已排序列：展示当前方向文案
    //   - 未排序列：展示若按此列排序时的默认方向文案
    const tipDir = isActive ? sortDirection : (SORT_DEFAULT_DIR[field] || "asc");
    const tooltip = sortTooltipText(field, tipDir);
    return `<th class="sort-th${isActive ? " active" : ""}" data-field="${field}" data-tooltip="${tooltip}" onclick="handleSortClick('${field}', event)">
        <span class="sort-th-inner">
            <span class="sort-th-label">${label}</span>
            ${arrowHtml}
        </span>
    </th>`;
}

/**
 * 排序 tooltip 文案：纯字段+方向 → 文案的查表。
 * 文案直接描述「当前/默认」排序状态，不带「已按」「点击」等动作词。
 */
const SORT_TOOLTIP_TEXT = {
    name:     { asc: "以A到Z的顺序排序",       desc: "以Z到A的顺序排序" },
    modified: { asc: "以从旧到新的顺序排序",   desc: "以从新到旧的顺序排序" },
    size:     { asc: "以从小到大的顺序排序",   desc: "以从大到小的顺序排序" },
};
function sortTooltipText(field, direction) {
    const fieldMap = SORT_TOOLTIP_TEXT[field];
    if (!fieldMap) return "";
    return fieldMap[direction] || "";
}

function sortArrowSvg(direction) {
    // 用户指定的上/下箭头 SVG，viewBox 0 -960 960 960
    const path = direction === "asc"
        ? "M440-240v-368L296-464l-56-56 240-240 240 240-56 56-144-144v368h-80Z"
        : "M480-240 240-480l56-56 144 144v-368h80v368l144-144 56 56-240 240Z";
    return `<span class="sort-arrow" aria-label="${direction === "asc" ? "升序" : "降序"}">` +
           `<svg viewBox="0 -960 960 960" focusable="false" width="20" height="20" fill="${SORT_ARROW_COLOR}"><path d="${path}"></path></svg>` +
           `</span>`;
}

/**
 * 对展示列表(displayedItems)原地排序：
 * - 文件夹始终排在文件前（不受字段/方向影响）；
 * - 同类型内按 sortField（name/modified/size）排序；
 * - sortDirection 控制升/降序；"name" 用中文 localeCompare 以正确处理中文文件名。
 * 无搜索时 displayedItems 与 currentItemsList 同引用,排序结果即全量排序。
 */
function sortItems() {
    if (!displayedItems || displayedItems.length === 0) return;
    const dir = sortDirection === "asc" ? 1 : -1;
    displayedItems.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        let cmp = 0;
        if (sortField === "name") {
            // numeric:true 让 file_2 排在 file_10 之前（自然排序）；sensitivity:'base' 兼容中文大小写不敏感比较。
            cmp = String(a.name || "").localeCompare(
                String(b.name || ""), 'zh-CN', { numeric: true, sensitivity: 'base' });
        } else if (sortField === "modified") {
            // 回收站用 deleted_at 字段，files/pinned 用 modified 字段
            const aVal = Number(a.modified ?? a.deleted_at) || 0;
            const bVal = Number(b.modified ?? b.deleted_at) || 0;
            cmp = aVal - bVal;
        } else if (sortField === "size") {
            cmp = (Number(a.size) || 0) - (Number(b.size) || 0);
        }
        return dir * cmp;
    });
}

/**
 * 列头点击：同列切换方向，跨列切换到该字段的默认方向（见 SORT_DEFAULT_DIR）。
 * stopPropagation 避免触发 document 的 click-outside-clear-selection 逻辑。
 */
function handleSortClick(field, event) {
    if (window.DriveDrag?.isBusy()) return;
    if (event) event.stopPropagation();
    if (sortField === field) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
        sortField = field;
        // 跨列切换时，使用该字段的默认方向 —— 与未排序列的 tooltip 文案保持一致
        sortDirection = SORT_DEFAULT_DIR[field] || "asc";
    }
    renderTableHeader(); // 更新箭头显示
    renderTableBody();   // 重新排序 + 重渲染
}

function renderTableHeader() {
    const head = document.getElementById("tableHeader");
    if (currentView === "files") {
        head.innerHTML = `
            <tr>
                ${sortableTh("名称", "name")}
                ${sortableTh("修改时间", "modified")}
                ${sortableTh("大小", "size")}
                <th class="col-actions" style="width: 140px;"></th>
            </tr>
        `;
    } else if (currentView === "pinned") {
        head.innerHTML = `
            <tr>
                ${sortableTh("名称", "name")}
                <th class="col-fullpath">完整路径</th>
                <th class="col-actions" style="width: 140px;"></th>
            </tr>
        `;
    } else {
        head.innerHTML = `
            <tr>
                ${sortableTh("名称", "name")}
                <th class="col-trash-original">原位置</th>
                ${sortableTh("删除时间", "modified")}
                ${sortableTh("大小", "size")}
                <th class="col-actions" style="width: 100px;">操作</th>
            </tr>
        `;
    }

    // 给每列的 data-field / 静态 <th> 加上列语义类,
    // 移动端 CSS 通过这些类决定哪些列在窄屏隐藏。
    const ths = head.querySelectorAll("th");
    ths.forEach((th) => {
        const field = th.getAttribute("data-field");
        if (field === "modified") th.classList.add("col-modified");
        else if (field === "size") th.classList.add("col-size");
    });
}

// ================= 虚拟滚动 =================
// 列表项 >= VSCROLL_THRESHOLD 时,只渲染视口内 ±BUFFER 行的 DOM。
// 实现方式:tbody 设为 position: relative,塞一个 spacer <tr> 撑出总高度,
// 实际可见行 position: absolute 定位,DOM 节点数与列表大小解耦。
const VSCROLL_THRESHOLD = 200;
const VSCROLL_BUFFER = 8;
let _vscrollContainer = null;
let _vscrollAttached = false;
let _vscrollRowHeight = 40;
let _vscrollLastRange = null;
let _vscrollResizeObs = null;

function _vscrollGetContainer() {
    if (_vscrollContainer && document.body.contains(_vscrollContainer)) {
        return _vscrollContainer;
    }
    _vscrollContainer = document.querySelector(".file-list");
    return _vscrollContainer;
}

function _vscrollMeasureRowHeight() {
    const tbody = document.getElementById("fileTableBody");
    if (!tbody) return _vscrollRowHeight;
    const probe = tbody.querySelector("tr:not(.vscroll-spacer)");
    if (probe) {
        const h = probe.getBoundingClientRect().height;
        if (h > 0 && Number.isFinite(h)) return h;
    }
    return _vscrollRowHeight;
}

function _vscrollOnScroll() {
    const container = _vscrollGetContainer();
    if (!container) return;
    const rowH = _vscrollRowHeight;
    const total = displayedItems.length;
    const scrollTop = container.scrollTop;
    const viewport = container.clientHeight || 600;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - VSCROLL_BUFFER);
    const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowH) + VSCROLL_BUFFER);
    if (_vscrollLastRange && _vscrollLastRange.start === start && _vscrollLastRange.end === end) return;
    _vscrollLastRange = { start, end };
    _vscrollRenderRows(start, end, rowH);
}

function _vscrollRenderRows(start, end, rowH) {
    const tbody = document.getElementById("fileTableBody");
    if (!tbody) return;
    tbody.style.position = "relative";

    // spacer 撑出总高度,这样 tbody 才有正确的滚动空间
    let spacer = tbody.querySelector("tr.vscroll-spacer");
    if (!spacer) {
        spacer = document.createElement("tr");
        spacer.className = "vscroll-spacer";
        const td = document.createElement("td");
        td.colSpan = 100;
        td.style.border = "none";
        td.style.padding = "0";
        td.style.background = "transparent";
        spacer.appendChild(td);
        tbody.appendChild(spacer);
    }
    const totalH = displayedItems.length * rowH;
    spacer.firstElementChild.style.height = totalH + "px";

    const old = tbody.querySelectorAll("tr:not(.vscroll-spacer)");
    old.forEach(tr => tr.remove());

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const item = displayedItems[i];
        const tr = _buildTableRow(item, i);
        tr.style.position = "absolute";
        tr.style.left = "0";
        tr.style.right = "0";
        tr.style.top = (i * rowH) + "px";
        tr.style.height = rowH + "px";
        frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    renderIcons(tbody);
}

function _vscrollAttach() {
    if (_vscrollAttached) return;
    const container = _vscrollGetContainer();
    if (!container) return;
    container.addEventListener("scroll", _vscrollOnScroll, { passive: true });
    _vscrollAttached = true;
    if (window.ResizeObserver) {
        _vscrollResizeObs = new ResizeObserver(() => {
            _vscrollLastRange = null;
            _vscrollOnScroll();
        });
        _vscrollResizeObs.observe(container);
    } else {
        window.addEventListener("resize", () => {
            _vscrollLastRange = null;
            _vscrollOnScroll();
        });
    }
}

function _vscrollReset() {
    _vscrollLastRange = null;
    const tbody = document.getElementById("fileTableBody");
    if (tbody) tbody.style.position = "";
    const container = _vscrollGetContainer();
    if (container) container.scrollTop = 0;
}

/**
 * 构造单行 <tr>(不含位置样式),普通渲染与虚拟滚动共用。
 */
// ================= 自定义双击判定 =================
// 浏览器原生 ondblclick 的判定时间窗是 OS 决定的(Windows 默认 ~500ms),
// 用户感知上偏短;改用 1 秒自定义窗口:
//   - 在 1s 内对同一行(index)连续两次 click → 触发"双击动作"
//   - 单次 click 仍走 handleRowClick(选中/多选)
//   - 与浏览器原生 dblclick 解耦,不再受系统设置影响
const DBLCLICK_WINDOW_MS = 1000;
let _lastClickTs = 0;
let _lastClickIndex = -1;

function _attachDblclickHandler(tr, index, action, clearSel = false) {
    // 单一 click 监听,同时承担:
    //   - 单击 → handleRowClick(选中 / 多选,与原 tr.onclick 等价)
    //   - 双击(同 index、1s 窗口内)→ action() + 可选 clearSelection()
    //
    // 这样设计是因为原来拆成两个监听器会撞上执行顺序问题:
    //   1) dblclick 监听器先跑 → loadPath 内部 clearSelection
    //   2) tr.onclick 后跑   → handleRowClick 重新选中该行
    // 把两个职责合并到一个监听器后,双击分支 return 不再走 handleRowClick,
    // 自然避免了「清完又被选回去」的竞态。
    //
    // clearSel=true:进入新目录(loadPath/openPinnedItem)时,旧 selectedItems
    //   指向旧目录的 items,新目录里已经无意义,清掉。
    // clearSel=false:预览文件(previewFile)时目录没变,选择保留。
    tr.addEventListener("click", (e) => {
        // 行内操作按钮(重命名/下载/移动/删除等)由全局事件委托统一处理,
        // 点击按钮不应触发行选中/双击逻辑。
        if (e.target.closest && e.target.closest(".action-btn, .action-more")) return;
        const now = Date.now();
        const isDbl = (_lastClickIndex === index) && (now - _lastClickTs) <= DBLCLICK_WINDOW_MS;
        if (isDbl) {
            _lastClickTs = 0;
            _lastClickIndex = -1;
            action();
            if (clearSel) clearSelection();
            return;  // 双击分支:不再走 handleRowClick,避免重新选中
        }
        // 单击:更新时间戳 + 走原选中逻辑
        _lastClickTs = now;
        _lastClickIndex = index;
        handleRowClick(e, index);
    });
}

function _buildTableRow(item, index) {
    const ext = item.name.split(".").pop().toLowerCase();
    const tr = document.createElement("tr");
    tr.setAttribute("data-index", index);

    // 拖拽（仅 files 视图）：记录行内条目路径；目录行同时标记为可放置目标。
    if (currentView === "files") {
        const path = joinPath(currentPath, item.name);
        tr.dataset.itemPath = path;
        if (item.is_dir) {
            tr.dataset.dropKind = "directory";
            tr.dataset.dropPath = path;
        }
        if (window.DriveDrag?.isSourcePath(path)) tr.classList.add("drive-drag-source");
    }

    // 双击动作:不再用 tr.ondblclick(原生窗口太短),改用 1s 自定义窗口。
    if (currentView === "files" && !item.is_dir) {
        const previewKind = canPreview(item, ext);
        if (previewKind) {
            // 可预览:双击 → 打开预览(不动目录,选择保留)
            _attachDblclickHandler(tr, index, () => previewFile(item, previewKind), false);
            tr.style.cursor = "pointer";
        } else {
            // 不可预览的文件:仍要绑定 click,否则单击无法触发选中/多选。
            // 双击无操作(用户用行尾按钮做下载/重命名/移动/删除)。
            _attachDblclickHandler(tr, index, () => {}, false);
        }
    }
    if (currentView === "files" && item.is_dir) {
        // 进入子目录 → 旧选择已经无意义,清掉
        _attachDblclickHandler(tr, index, () => loadPath(joinPath(currentPath, item.name)), true);
    }
    if (currentView === "pinned") {
        // 从已固定的文件夹进入 → 同理清掉选择
        _attachDblclickHandler(tr, index, () => openPinnedItem(index), true);
        tr.style.cursor = "pointer";
    }

    let metaCells = "";
    let actionCell = "";

    if (currentView === "files") {
        metaCells = `<td class="col-modified">${formatDate(item.modified)}</td><td class="col-size">${formatBytes(item.size)}</td>`;
        // 操作按钮只携带 data-action/data-index,由全局事件委托统一分发:
        // 不再用 onclick 字符串内嵌文件名 -- escapeAttr 的 &#39; 经 HTML 属性
        // 解码后会破坏 JS 字符串,含单引号的文件名曾让整行按钮全部失效。
        actionCell = `
            <td class="col-actions">
                <div class="row-actions-desktop" style="display:flex;">
                    <div class="action-btn" data-tooltip="重命名" data-action="rename" data-index="${index}">
                        <svg height="20" viewBox="0 -960 960 960" width="20" focusable="false" fill="currentColor"><path d="M351-144l144-144h369v144H351Zm-183-72h51l375-375-51-51-375 375v51Zm-72 72v-153l498-498q11-11 23.84-16 12.83-5 27-5 14.16 0 27.16 5t24 16l51 51q11 11 16 24t5 26.54q0 14.45-5.02 27.54T747-642L249-144H96Zm600-549-51-51 51 51Zm-127.95 76.95L543-642l51 51-25.95-25.05Z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="移动" data-action="move" data-index="${index}">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10zm-8.01-9l-1.41 1.41L12.16 12H8v2h4.16l-1.59 1.59L11.99 17 16 13.01 11.99 9z"/></svg>
                    </div>
                    ${!item.is_dir ? `<div class="action-btn" data-tooltip="下载" data-action="download" data-index="${index}">
                        <svg height="20" width="20" viewBox="0 96 960 960" fill="#444746"><path d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"/></svg>
                    </div>` : `<div class="action-btn" data-tooltip="下载文件夹" data-action="download" data-index="${index}">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                    </div>`}
                    <div class="action-btn" data-tooltip="移至回收站" data-action="trash" data-index="${index}">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9zm4 0h2v9h-2z"/></svg>
                    </div>
                </div>
                <button class="action-more" type="button" aria-label="更多操作" data-action="more" data-view="files" data-index="${index}">⋮</button>
            </td>`;
    } else if (currentView === "pinned") {
        metaCells = `<td class="col-fullpath" style="color:var(--text-muted); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-tooltip="${escapeAttr(item.full_path || "根目录")}">${escapeHtml(item.full_path || "根目录")}</td>`;
        actionCell = `
            <td class="col-actions">
                <div class="row-actions-desktop" style="display:flex;">
                    <div class="action-btn" data-tooltip="进入目录" data-action="open-pinned" data-index="${index}">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="下载" data-action="download-pinned" data-index="${index}">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="取消固定" data-action="unpin" data-index="${index}">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                    </div>
                </div>
                <button class="action-more" type="button" aria-label="更多操作" data-action="more" data-view="pinned" data-index="${index}">⋮</button>
            </td>`;
    } else {
        metaCells = `
            <td class="col-trash-original" style="color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-tooltip="${escapeAttr(item.original_path)}">${escapeHtml(item.original_path)}</td>
            <td class="col-modified">${formatDate(item.deleted_at)}</td>
            <td class="col-size">${formatBytes(item.size)}</td>`;
        actionCell = `
            <td class="col-actions">
                <div class="row-actions-desktop" style="display:flex;">
                    <div class="action-btn" data-tooltip="还原" data-action="restore" data-index="${index}">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="#444746"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="永久删除" data-action="delete-perm" data-index="${index}">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M9.4 16.5l2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6L16 9.9l-1.4-1.4-2.6 2.6-2.6-2.6L8 9.9l2.6 2.6L8 15.1ZM7 21q-.825 0-1.412-.587Q5 19.825 5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413Q17.825 21 17 21ZM17 6H7v13h10ZM7 6v13Z"/></svg>
                    </div>
                </div>
                <button class="action-more" type="button" aria-label="更多操作" data-action="more" data-view="trash" data-index="${index}">⋮</button>
            </td>`;
    }

    tr.innerHTML = `
        <td><div class="file-name-cell" data-name-cell="${index}">${getIcon(item.is_dir, ext)}<span style="font-weight: 500;">${escapeHtml(item.name)}</span></div></td>
        ${metaCells}
        ${actionCell}
    `;
    // 注意:不在这里设 tr.onclick。
    // 单击/双击统一由上面 _attachDblclickHandler 里注册的唯一 click 监听器处理,
    // 否则会出现「dblclick 监听器清选 → onclick 又选回去」的竞态(详见函数注释)。
    return tr;
}

function renderTableBody() {
    const tbody = document.getElementById("fileTableBody");
    tbody.innerHTML = "";

    // 先按当前搜索词过滤出展示列表,再排序渲染。
    // 搜索作用于数据源而不是 DOM -- 虚拟滚动(>=200 条只渲染可见行)下,
    // 遍历 DOM 行做 display:none 既搜不到未渲染的行,滚动重渲染后还会丢结果。
    rebuildDisplayedItems();

    // 始终按当前 sortField/sortDirection 排序后再渲染
    sortItems();

    if (currentItemsList.length === 0) {
        const colCount = currentView === "files" ? 4 : (currentView === "pinned" ? 3 : 5);
        const emptyText = currentView === "pinned" ? "尚未固定任何文件夹" : "空空如也";
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding:32px; color:#aaa;">${emptyText}</td></tr>`;
        _vscrollReset();
        return;
    }
    if (displayedItems.length === 0) {
        const colCount = currentView === "files" ? 4 : (currentView === "pinned" ? 3 : 5);
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding:32px; color:#aaa;">没有匹配「${escapeHtml(searchQuery)}」的文件</td></tr>`;
        _vscrollReset();
        return;
    }

    if (displayedItems.length >= VSCROLL_THRESHOLD) {
        // 启用虚拟滚动:先临时放一行用于测行高,再清空正式渲染
        const probe = _buildTableRow(displayedItems[0], 0);
        tbody.appendChild(probe);
        _vscrollRowHeight = Math.max(1, _vscrollMeasureRowHeight());
        _vscrollAttach();
        _vscrollReset();
        const container = _vscrollGetContainer();
        const viewport = (container && container.clientHeight) || 600;
        const start = 0;
        const end = Math.min(
            displayedItems.length,
            Math.ceil(viewport / _vscrollRowHeight) + VSCROLL_BUFFER * 2,
        );
        _vscrollLastRange = { start, end };
        _vscrollRenderRows(start, end, _vscrollRowHeight);
    } else {
        // 普通全量渲染
        _vscrollReset();
        const frag = document.createDocumentFragment();
        displayedItems.forEach((item, index) => {
            frag.appendChild(_buildTableRow(item, index));
        });
        tbody.appendChild(frag);
        renderIcons(tbody);
    }

    // 渲染完后立刻把已有选中状态同步到 DOM(避免重新进入目录后高亮丢失)
    updateRowSelectionUI();
}

/**
 * HTML 属性值转义:用于 onclick="..." 等场景,防止单/双引号逃逸导致 XSS。
 * 与 escapeHtml 区别:属性上下文里还要转义单/双引号。
 */
function escapeAttr(s) {
    return String(s).replace(/[&"'<>]/g, c => ({"&":"&amp;",'"':"&quot;","'":"&#39;","<":"&lt;",">":"&gt;"}[c]));
}
/**
 * HTML 文本节点转义:用于 innerHTML 插入文本内容,只防 < > &。
 * textContent 场景不需要这个函数。
 */
function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}

/**
 * 行点击统一入口：
 *   普通点击          -> 单选（替换当前选择）
 *   Ctrl/Cmd + 点击    -> 切换该行是否在选择中（多选）
 *   Shift + 点击       -> 从锚点（lastSelectedIndex）到当前行做范围选择
 *   Ctrl + Shift + 点击 -> 在已有选择基础上扩展范围
 */
function handleRowClick(e, idx) {
    const item = displayedItems[idx];
    if (!item) return;

    // ============= 移动端：彻底走单击打开,禁用多选 =============
    if (window.IS_MOBILE) {
        // 移动端单次点击即视为"打开",不依赖双击;_attachDblclickHandler 仍绑定但不会被触发。
        // 文件夹 → 进入目录;可预览的文件 → 预览;不可预览的文件 → 交给下方按钮触发下载/其它。
        if (item.is_dir) {
            loadPath(joinPath(currentPath, item.name));
        } else {
            const ext = (item.name.split(".").pop() || "").toLowerCase();
            const previewKind = canPreview(item, ext);
            if (previewKind) previewFile(item, previewKind);
            // 非预览类型的文件不做事,让用户点行尾 ⋮ 操作
        }
        return;
    }

    const additive = e.ctrlKey || e.metaKey;     // 多选修饰键
    const range = e.shiftKey && lastSelectedIndex >= 0;

    if (range) {
        const start = Math.min(lastSelectedIndex, idx);
        const end = Math.max(lastSelectedIndex, idx);
        if (!additive) {
            // 纯 shift：先清空，再选范围
            selectedItems = [];
        }
        for (let i = start; i <= end; i++) {
            const it = displayedItems[i];
            if (it && !selectedItems.includes(it)) {
                selectedItems.push(it);
            }
        }
        // 锚点保持不变，方便后续继续 shift+click
    } else if (additive) {
        // Ctrl/Cmd+点击：切换
        const existingIdx = selectedItems.indexOf(item);
        if (existingIdx >= 0) {
            selectedItems.splice(existingIdx, 1);
            // 移除时锚点保持不变，仍可继续 shift+click
        } else {
            selectedItems.push(item);
            lastSelectedIndex = idx;
        }
    } else {
        // 普通点击：单选
        selectedItems = [item];
        lastSelectedIndex = idx;
    }

    updateRowSelectionUI();
    updateSelectionState();
}

function updateRowSelectionUI() {
    const rows = document.querySelectorAll("#fileTableBody tr");
    rows.forEach(tr => {
        const idx = parseInt(tr.getAttribute("data-index"), 10);
        if (Number.isNaN(idx)) return;
        const item = displayedItems[idx];
        if (item && selectedItems.includes(item)) {
            tr.classList.add("selected");
        } else {
            tr.classList.remove("selected");
        }
    });
}

function clearSelection() {
    selectedItems = [];
    lastSelectedIndex = -1;
    document.querySelectorAll(".file-table tr").forEach(tr => tr.classList.remove("selected"));
    updateSelectionState();
}

function updateSelectionState() {
    const selBar = document.getElementById("selectionBar");
    const selCountText = document.getElementById("selectCount");

    if (selectedItems.length > 0) {
        selCountText.innerText = `已选择 ${selectedItems.length} 项内容`;
        selBar.classList.add("active");
        // 给 body 加 has-selection 类，触发 top-bar 内容渐隐 / selection-bar 渐显
        document.body.classList.add("has-selection");

        if (currentView === "files") {
            document.getElementById("selDownload").style.display = "block";
            document.getElementById("selMove").style.display = "block";
            document.getElementById("selTrash").style.display = "block";
            document.getElementById("selLink").style.display = "block";
            document.getElementById("selRestore").style.display = "none";
            document.getElementById("selDeletePerm").style.display = "none";
        } else if (currentView === "pinned") {
            // pinned 视图下只有下载（解压 zip）有意义；移动/复制链接对文件夹意义不大
            document.getElementById("selDownload").style.display = "block";
            document.getElementById("selMove").style.display = "none";
            document.getElementById("selTrash").style.display = "none";
            document.getElementById("selLink").style.display = "none";
            document.getElementById("selRestore").style.display = "none";
            document.getElementById("selDeletePerm").style.display = "none";
        } else {
            // 回收站视图:文件本体在 .trash 下且凭 trashed_name 才能定位,
            // 常规下载接口(按原始路径)拿不到它,隐藏下载按钮避免必然失败的请求。
            document.getElementById("selDownload").style.display = "none";
            document.getElementById("selMove").style.display = "none";
            document.getElementById("selTrash").style.display = "none";
            document.getElementById("selLink").style.display = "none";
            document.getElementById("selRestore").style.display = "block";
            document.getElementById("selDeletePerm").style.display = "block";
        }
    } else {
        selBar.classList.remove("active");
        document.body.classList.remove("has-selection");
    }
}

/* 拖拽期间隐藏多选操作条、恢复地址栏显示（由 drive_drag.js 在拖拽开始/结束时调用）。 */
function syncSelectionOverlay() {
    const visible = selectedItems.length > 0 && !document.body.classList.contains("drive-dragging");
    const selBar = document.getElementById("selectionBar");
    const toolbar = document.querySelector(".explorer-toolbar");
    if (selBar) selBar.setAttribute("aria-hidden", String(!visible));
    if (toolbar) toolbar.inert = visible;
}

/* ================= 移动端:侧边栏抽屉 + 行动作面板 =================
   全部用 window.IS_MOBILE 守卫,不污染 PC 端逻辑。
   DOM 钩子：.mobile-hamburger / .sidebar-mask / .sidebar
   装饰面板容器：动态创建 #mobileActionSheetOverlay,只在点击 ⋮ 时插入。 */

function toggleSidebar(force) {
    if (!window.IS_MOBILE) return;
    const sidebar = document.querySelector(".sidebar");
    const mask = document.getElementById("sidebarMask");
    if (!sidebar || !mask) return;
    const willOpen = (force === undefined) ? !sidebar.classList.contains("is-open") : !!force;
    sidebar.classList.toggle("is-open", willOpen);
    mask.classList.toggle("is-open", willOpen);
    document.body.classList.toggle("no-scroll", willOpen);
}

function closeSidebar() {
    toggleSidebar(false);
}

/**
 * 移动端行动作面板
 * @param {number} index   currentItemsList 中的索引
 * @param {"files"|"pinned"|"trash"} viewType   视图类型,决定显示哪些操作项
 */
function openMobileActions(index, viewType) {
    if (!window.IS_MOBILE) return;
    const item = displayedItems[index];
    if (!item) return;
    closeMobileActions();

    const overlay = document.createElement("div");
    overlay.className = "mobile-action-sheet-overlay";
    // 统一使用 click 监听：不要使用 touchstart/touchend 立即关闭遮罩。
    // 否则在移动端 300ms 幽灵点击机制下,合成 click 会在遮罩消失后命中下方元素,
    // 造成"穿透点击"。配合 CSS touch-action:manipulation,click 几乎无延迟触发。
    overlay.addEventListener("click", (e) => {
        // 必须严格匹配 overlay 本身,避免点击 .mobile-action-sheet 内冒泡上来误关。
        if (e.target !== overlay) return;
        e.preventDefault();
        e.stopPropagation();
        closeMobileActions();
    });

    const sheet = document.createElement("div");
    sheet.className = "mobile-action-sheet";

    // 头部:文件名 + 关闭按钮(Material 风格 close 图标,18x18)
    const name = item.display_name || item.name || item.trashed_name || "未命名";
    const head = document.createElement("div");
    head.className = "mobile-action-sheet-header";
    head.innerHTML = `
        <span class="mobile-action-sheet-title" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
        <button type="button" class="mobile-action-sheet-close" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="#444746" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg></button>
    `;
    head.querySelector("button").onclick = closeMobileActions;
    sheet.appendChild(head);

    // 中部:列表滚动区 —— 与 header 分离,使 header 彻底脱离滚动区域,
    // 避免 sticky 方案下"列表项穿过 header"的视觉瑕疵。
    const body = document.createElement("div");
    body.className = "mobile-action-sheet-body";

    // 操作列表:按视图构造
    const actions = [];
    if (viewType === "files") {
        actions.push({ label: "预览", icon: previewIcon(), run: () => {
            const ext = (item.name.split(".").pop() || "").toLowerCase();
            const previewKind = canPreview(item, ext);
            if (previewKind) previewFile(item, previewKind);
            else showToast("该文件类型暂不支持预览");
        }});
        actions.push({ label: "下载", icon: downloadIcon(), run: () => {
            if (item.is_dir) downloadFolder(item.name);
            else downloadFile(item.name);
        }});
        actions.push({ label: "复制链接", icon: linkIcon(), run: () => {
            // 复用 PC 端的 copyLink,但只让当前项入选中
            selectedItems = [item];
            lastSelectedIndex = index;
            copyLink();
        }});
        actions.push({ label: "重命名", icon: renameIcon(), run: () => openRenameDialog(index) });
        actions.push({ label: "移动到...", icon: moveIcon(), run: () => moveSingle(item.name) });
        actions.push({ label: "移至回收站", icon: trashIcon(), danger: true, run: () => trashSingle(item.name) });
    } else if (viewType === "pinned") {
        actions.push({ label: "进入目录", icon: enterIcon(), run: () => openPinnedItem(index) });
        actions.push({ label: "下载", icon: downloadIcon(), run: () => downloadFolderByPath(item.full_path) });
        actions.push({ label: "取消固定", icon: unpinIcon(), run: () => unpinFromMain(index) });
    } else { // trash
        actions.push({ label: "还原", icon: restoreIcon(), run: () => restoreSingle(item.trashed_name) });
        actions.push({ label: "永久删除", icon: trashIcon(), danger: true, run: () => deletePermSingle(item.trashed_name) });
    }

    actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mobile-action-sheet-item" + (a.danger ? " danger" : "");
        btn.innerHTML = `${a.icon}<span>${escapeHtml(a.label)}</span>`;
        btn.onclick = () => { closeMobileActions(); a.run(); };
        body.appendChild(btn);
    });

    // 底部:取消
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mobile-action-sheet-cancel";
    cancel.textContent = "取消";
    cancel.onclick = closeMobileActions;
    body.appendChild(cancel);

    sheet.appendChild(body);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    // 让浏览器后退 / 移动端侧滑返回 / 物理返回键能关闭面板而不退到上一级路由：
    // 打开面板时往历史栈推一条 mobileSheet 标记，popstate 监听器会优先消费它来关闭面板。
    if (!_actionSheetHistoryActive) {
        try {
            window.history.pushState({ ...(window.history.state || {}), mobileSheet: true }, "");
            _actionSheetHistoryActive = true;
        } catch (e) {
            console.warn("[openMobileActions] history.pushState 失败:", e);
        }
    }
}

function closeMobileActions() {
    const existing = document.querySelector(".mobile-action-sheet-overlay");
    if (!existing) return;  // 幂等保护
    existing.remove();

    // 处理面板项与历史栈的协作：见 _actionSheetHistoryActive 注释。
    if (_actionSheetClosingFromPopstate) {
        // 系统返回键 / 侧滑触发：浏览器已自己回到上一项，仅清标记。
        _actionSheetHistoryActive = false;
    } else if (_actionSheetHistoryActive) {
        // 点 X / 取消 / 点击遮罩空白：主动 back() 消化面板项，避免下次按返回时
        // 再次"穿越"到这条无意义的历史项；抑制随之而来的 popstate 以防重复加载数据。
        _actionSheetHistoryActive = false;
        _suppressNextPopstateForActionSheet = true;
        try {
            window.history.back();
        } catch (e) {
            console.warn("[closeMobileActions] history.back 失败:", e);
        }
    }
}

// === 操作图标 ===
function previewIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`;
}
function downloadIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4.8 21.6q-0.99 0-1.695-0.705T2.4 19.2V15.6h2.4v3.6h14.4V15.6h2.4v3.6q0 0.99-0.705 1.695T19.2 21.6H4.8Zm7.2-4.8L6 10.8l1.68-1.74 3.12 3.12V2.4h2.4v9.78l3.12-3.12 1.68 1.74-6 6Z"/></svg>`;
}
function linkIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.7 1.4-3.1 3.1-3.1h4V7H7c-2.8 0-5 2.2-5 5s2.2 5 5 5h4v-1.9H7C5.3 15.1 3.9 13.7 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.7 0 3.1 1.4 3.1 3.1s-1.4 3.1-3.1 3.1h-4V17h4c2.8 0 5-2.2 5-5s-2.2-5-5-5z"/></svg>`;
}
function renameIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
}
function moveIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10zm-8.01-9l-1.41 1.41L12.16 12H8v2h4.16l-1.59 1.59L11.99 17 16 13.01 11.99 9z"/></svg>`;
}
function trashIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
}
function enterIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>`;
}
function unpinIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" transform="rotate(45 12 12)"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
}
function restoreIcon() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/></svg>`;
}

// 绑定汉堡按钮 + 遮罩点击
document.addEventListener("DOMContentLoaded", () => {
    const burger = document.getElementById("mobileHamburger");
    if (burger) burger.addEventListener("click", () => toggleSidebar());
    const mask = document.getElementById("sidebarMask");
    if (mask) mask.addEventListener("click", () => closeSidebar());

    // 移动端：点击 sidebar 内的导航项/链接/固定项后,抽屉自动收起。
    // 用事件委托避免给每个 onclick 单独补 closeSidebar() —— 包括
    // 主目录 / 已固定的文件夹 / 回收站 / 回主页 / 退出登录 / 动态渲染的 pinned-item。
    // 例外:
    //   - .nav-expander-clickable (▶/▼ 切换 pinned 列表展开):收起会让用户看不到结果
    //   - 「新建」按钮及其下拉菜单项:打开的是 dropdown,收起会立即丢掉菜单
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) {
        sidebar.addEventListener("click", (e) => {
            if (!window.IS_MOBILE) return;
            if (!sidebar.classList.contains("is-open")) return;
            const navTarget = e.target.closest(".nav-item, .pinned-item");
            if (!navTarget) return;
            if (e.target.closest(".nav-expander-clickable")) return;
            // 「新建」按钮(class="new-btn")和它的下拉菜单项(class="new-menu-item")
            // 都不属于 .nav-item / .pinned-item,所以这里的 navTarget 自然为 null,
            // 不需要在 closeSidebar() 之前再加额外判断。
            closeSidebar();
        });
    }
});

// 跨断点切换时,清理掉移动端才有的抽屉状态,避免 PC 端看到奇怪的 fixed 侧边栏
(function () {
    const mq = window.matchMedia("(max-width: 768px)");
    if (!mq) return;
    const handler = () => {
        if (!mq.matches) {
            const sidebar = document.querySelector(".sidebar");
            const mask = document.getElementById("sidebarMask");
            if (sidebar) sidebar.classList.remove("is-open");
            if (mask) mask.classList.remove("is-open");
            document.body.classList.remove("no-scroll");
            closeMobileActions();
        }
        // 断点两侧都重新检测 path 溢出
        requestAnimationFrame(() => truncateBreadcrumb());
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", handler);
    else if (typeof mq.addListener === "function") mq.addListener(handler);

    // 防抖 resize:窗口拉宽拉窄都会影响 path-box 可用宽度
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => truncateBreadcrumb(), 100);
    });
})();

// Esc 清空选择（重命名输入框里的 Esc 由各自监听器自行处理，不冒泡到这里）
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.tagName !== "INPUT") {
        clearSelection();
        // 顺手关掉面包屑省略号下拉,保持 ESC 语义统一
        if (_bcDropdownEl) closeBreadcrumbDropdown();
    }
});

/**
 * 点击空白处关闭面包屑省略号下拉:
 * 排除 trigger 本身(由 toggleBreadcrumbDropdown 处理)和下拉内部(菜单项自己处理)。
 * 与现有的「点击空白处取消选择」逻辑分开,这里只针对面包屑下拉。
 */
document.addEventListener("mousedown", (e) => {
    if (!_bcDropdownEl) return;
    const t = e.target;
    if (_bcDropdownTrigger && t === _bcDropdownTrigger) return;
    if (t.closest && t.closest(".bc-ellipsis-dropdown")) return;
    closeBreadcrumbDropdown();
});
document.addEventListener("touchstart", (e) => {
    if (!_bcDropdownEl) return;
    const t = e.target;
    if (_bcDropdownTrigger && t === _bcDropdownTrigger) return;
    if (t.closest && t.closest(".bc-ellipsis-dropdown")) return;
    closeBreadcrumbDropdown();
}, { passive: true });

/**
 * Ctrl/Cmd + A：选中当前文件列表中所有可见条目。
 * 仅在 files 视图下生效，pinned/trash 视图由各自动作接管或暂不支持。
 * 当焦点在 input/textarea/contenteditable 内时让浏览器自己处理（全选文字），
 * 避免与 pathInput / rename input 等冲突。
 */
document.addEventListener("keydown", (e) => {
    const isSelectAll = (e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A");
    if (!isSelectAll) return;

    // 焦点在文本输入控件里：交给浏览器默认行为（全选文字）
    const t = e.target;
    if (t && (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
    )) {
        return;
    }

    if (currentView !== "files") return;
    if (!displayedItems || displayedItems.length === 0) return;

    e.preventDefault();
    // 选中当前可见(搜索过滤后)的全部条目;保持顺序以便后续范围选择行为一致
    selectedItems = displayedItems.slice();
    lastSelectedIndex = displayedItems.length - 1;
    updateRowSelectionUI();
    updateSelectionState();
});

/**
 * 单击空白处取消选择。
 * 排除以下区域：选中态下的 row 自身（行点击已经自行处理选择）、操作条本身、
 * 模态、上传小窗、下拉菜单、explorer-toolbar（路径/搜索/大头针）。
 */
document.addEventListener("click", (e) => {
    if (selectedItems.length === 0) return;

    const t = e.target;
    if (t.closest("#selectionBar")) return;        // 操作条内部
    if (t.closest(".file-table")) return;          // 表格行/表头自身处理选择
    if (t.closest(".modal-overlay")) return;       // 模态对话框
    if (t.closest(".upload-widget")) return;       // 右下角上传小窗
    if (t.closest(".new-menu")) return;            // 新建下拉
    if (t.closest(".explorer-toolbar")) return;    // 路径框/搜索/大头针
    if (t.closest(".drop-overlay")) return;        // 拖拽上传遮罩

    clearSelection();
});

// ================= 表格行操作按钮:事件委托 =================
// 行内按钮只携带 data-action / data-index,统一在这里查 displayedItems[index]
// 取名字后调用对应函数。彻底消除"onclick 字符串里内嵌文件名"的注入面:
// escapeAttr 的 &#39; 经 HTML 属性解码后会破坏 JS 字符串,含单引号的文件名
// 曾让该行的下载/移动/删除等按钮全部失效(SyntaxError)。
// 行的 click 监听器(_attachDblclickHandler)已排除 .action-btn/.action-more,
// 不会与按钮点击互相干扰。
document.addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest("[data-action]") : null;
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const index = parseInt(btn.getAttribute("data-index"), 10);
    if (Number.isNaN(index)) return;
    const item = displayedItems[index];
    if (!item) return;
    switch (action) {
        case "rename": openRenameDialog(index); break;
        case "move": moveSingle(item.name); break;
        case "download":
            if (item.is_dir) downloadFolder(item.name);
            else downloadFile(item.name);
            break;
        case "trash": trashSingle(item.name); break;
        case "open-pinned": openPinnedItem(index); break;
        case "download-pinned": downloadFolderByPath(item.full_path); break;
        case "unpin": unpinFromMain(index); break;
        case "restore": restoreSingle(item.trashed_name); break;
        case "delete-perm": deletePermSingle(item.trashed_name); break;
        case "more": openMobileActions(index, btn.getAttribute("data-view") || "files"); break;
    }
});

// 面包屑路径段:容器级事件委托,读取 data-path(不再内嵌 onclick 字符串)。
// stopPropagation 阻止冒泡到 pathBox 触发"进入路径编辑模式"。
(function setupBreadcrumbNav() {
    const bc = document.getElementById("breadcrumb");
    if (!bc) return;
    bc.addEventListener("click", (e) => {
        const seg = e.target.closest ? e.target.closest("span[data-path]") : null;
        if (!seg) return;
        e.stopPropagation();
        const path = seg.getAttribute("data-path");
        if (path) loadPath(path);
    });
})();

// 侧边栏固定项:容器级事件委托(innerHTML 会被 renderPinnedSidebar 重写,
// 绑在容器上比每项绑一次更稳)。注意不要 stopPropagation -- 移动端
// ".sidebar 上的委托"依赖事件继续冒泡来实现"点击导航项后收起抽屉"。
(function setupPinnedNav() {
    const box = document.getElementById("pinnedList");
    if (!box) return;
    box.addEventListener("click", (e) => {
        const item = e.target.closest ? e.target.closest(".pinned-item[data-path]") : null;
        if (!item) return;
        goToPinned(item.getAttribute("data-path"));
    });
})();

async function trashSingle(filename) {
    const path = joinPath(currentPath, filename);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_trash`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: [path]})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("删除失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert("部分项目未删除", data.errors.join("\n"));
        }
    } catch (e) {
        return showAlert("删除失败", errMessage(e));
    }
    loadPath(currentPath);
    updateStorage();
}

// ================= 拖拽移动 / 拖拽回收（供 drive_drag.js 调用） =================
async function movePaths(paths, targetDir) {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/move`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: paths, target_dir: targetDir})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(`移动失败：${data.detail || `HTTP ${res.status}`}`);
            return false;
        }
        if (data.errors && data.errors.length) {
            showAlert(`已移动 ${data.moved} 项`, "以下项未移动：\n" + data.errors.join("\n"));
        } else if (data.moved) {
            showToast(`已移动 ${data.moved} 项`);
        }
        clearSelection();
        loadPath(currentPath);
        updateStorage();
        return true;
    } catch (e) {
        showToast(`移动失败：${errMessage(e)}`);
        return false;
    }
}

async function trashPaths(paths) {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_trash`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: paths})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(`移至回收站失败：${data.detail || `HTTP ${res.status}`}`);
            return false;
        }
        if (data.errors && data.errors.length) {
            showAlert(`已删除 ${data.count} 项`, "以下项未删除：\n" + data.errors.join("\n"));
        } else if (data.count) {
            showToast(`已删除 ${data.count} 项`);
        }
        clearSelection();
        loadPath(currentPath);
        updateStorage();
        return true;
    } catch (e) {
        showToast(`移至回收站失败：${errMessage(e)}`);
        return false;
    }
}

async function bulkTrash() {
    if (selectedItems.length === 0) return;
    const paths = selectedItems.map(item => joinPath(currentPath, item.name));
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_trash`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: paths})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("批量删除失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert(`已删除 ${data.count} 项`, "以下项未删除：\n" + data.errors.join("\n"));
        }
        clearSelection();
        loadPath(currentPath);
        updateStorage();
    } catch (e) { showAlert("批量删除失败", errMessage(e)); }
}

async function restoreSingle(trashedName) {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_restore`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: [trashedName]})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("还原失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert("部分项目未还原", data.errors.join("\n"));
        }
    } catch (e) {
        return showAlert("还原失败", errMessage(e));
    }
    loadTrash();
    updateStorage();
}

async function bulkRestore() {
    if (selectedItems.length === 0) return;
    const names = selectedItems.map(item => item.trashed_name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_restore`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: names})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("批量恢复失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert(`已恢复 ${data.count} 项`, "以下项未恢复：\n" + data.errors.join("\n"));
        }
        clearSelection();
        loadTrash();
        updateStorage();
    } catch (e) { showAlert("批量恢复失败", errMessage(e)); }
}

async function deletePermSingle(trashedName) {
    if (!(await showConfirm("永久删除", "确定要永久删除该项内容吗？此操作不可逆。", { confirmText: "删除" }))) return;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_delete_permanently`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: [trashedName]})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("永久删除失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert("部分项目未删除", data.errors.join("\n"));
        }
    } catch (e) {
        return showAlert("永久删除失败", errMessage(e));
    }
    loadTrash();
    updateStorage();
}

async function bulkDeletePermanently() {
    if (selectedItems.length === 0) return;
    if (!(await showConfirm("永久删除", `确定要永久删除选中的 ${selectedItems.length} 项内容吗？此操作不可恢复。`, { confirmText: "删除" }))) return;
    const names = selectedItems.map(item => item.trashed_name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_delete_permanently`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: names})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("批量永久删除失败", data.detail || `HTTP ${res.status}`);
        }
        if (data.errors && data.errors.length) {
            showAlert(`已删除 ${data.count} 项`, "以下项未删除：\n" + data.errors.join("\n"));
        }
        clearSelection();
        loadTrash();
        updateStorage();
    } catch (e) { showAlert("批量永久删除失败", errMessage(e)); }
}

async function bulkDownload() {
    if (selectedItems.length === 0) return;
    // 回收站条目无法按原始路径下载(见 updateSelectionState 的说明)
    if (currentView === "trash") return;
    for (const item of selectedItems) {
        if (item.is_dir) {
            // pinned 视图条目携带完整路径(full_path);files 视图按当前目录拼接
            await downloadFolderByPath(item.full_path || joinPath(currentPath, item.name));
        } else {
            await downloadFile(item.name);
        }
    }
    clearSelection();
}

async function downloadFile(filename) {
    const p = joinPath(currentPath, filename);
    let res;
    try {
        res = await fetch(`${CONFIG.API_BASE}/api/download/ticket`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: p})
        });
    } catch (e) {
        return showAlert("下载失败", "网络错误：" + e.message);
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return showAlert("下载失败", data.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const a = document.createElement("a");
    a.href = `${CONFIG.API_BASE}/api/download/file?ticket=${data.ticket}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function downloadFolder(foldername) {
    // 当前目录下的子文件夹(仅传相对名):与 currentPath 拼接后走完整路径下载
    return downloadFolderByPath(joinPath(currentPath, foldername));
}

/**
 * 按完整相对路径下载文件夹(zip)。pinned 视图等场景直接持有完整路径,
 * 不能再与(可能陈旧的)currentPath 拼接 -- 那会拼出错误路径导致 404。
 */
async function downloadFolderByPath(folderPath) {
    const p = folderPath;
    const displayName = String(p || "").split("/").pop() || "folder";
    let res;
    try {
        res = await fetch(`${CONFIG.API_BASE}/api/download/folder/ticket`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: p})
        });
    } catch (e) {
        return showAlert("下载失败", "网络错误：" + errMessage(e));
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.detail || data.error || `HTTP ${res.status}`;
        showAlert("文件夹下载失败", msg);
        return;
    }

    const data = await res.json();
    const a = document.createElement("a");
    a.href = `${CONFIG.API_BASE}/api/download/file?ticket=${data.ticket}`;
    a.download = data.filename || `${displayName}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * 通用提示弹窗（无取消逻辑、仅确定按钮）。
 * 复用 openModal，保持样式与已有弹窗一致。
 * body 使用 white-space:pre-line,多行错误列表(\n 分隔)也能正常显示。
 */
function showAlert(title, message) {
    openModal({
        title,
        bodyHTML: `<div style="padding: 12px 0; color: var(--text-primary); line-height: 1.6; white-space: pre-line;">${escapeHtml(message)}</div>`,
        confirmText: "确定",
        onConfirm: () => true,
    });
}

/** 把任意 catch 到的错误转成可读文案(reject 的可能是 Error/字符串/响应对象)。 */
function errMessage(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    return String(err);
}

// ================= 通用弹窗基础设施 =================
let _modalKeydownHandler = null;
// 当前 modal 的取消回调(用户点取消/X/遮罩/Esc 时触发,且未点过确认);
// 配合 showConfirm/showPrompt 把"取消"也变成可 await 的结果。
let _modalOnCancel = null;
let _modalConfirmed = false;

function closeModal() {
    const overlay = document.getElementById("modalOverlay");
    if (overlay) overlay.remove();
    if (_modalKeydownHandler) {
        document.removeEventListener("keydown", _modalKeydownHandler, true);
        _modalKeydownHandler = null;
    }
    const cancel = _modalOnCancel;
    _modalOnCancel = null;
    if (cancel && !_modalConfirmed) cancel();
    _modalConfirmed = false;
}

// ================= 预览（全页遮罩 + 中央白色画布） =================
let _previewKeydownHandler = null;
let _previewWheelHandler = null;
let _previewZoom = 1;
// 当前预览中的 Artplayer 实例（仅 kind=video|audio 时存在），用于关闭预览时显式 destroy 释放解码器。
let _activeArtplayer = null;
// artplayer.js 是否已加载完成(单次缓存)。Promise 形态便于并发请求共享同一个加载任务。
let _artplayerLoaderPromise = null;
// 移动端预览与浏览器历史的协作：
// _previewHistoryActive 表示"我们已经往历史栈推过一条 preview 标记项"，
// _previewClosingFromPopstate 表示"当前 closePreviewModal 是由 popstate 触发的"
//   —— 此时浏览器已经自己回退到上一项，不能再 history.back()，否则会回退过头。
// _suppressNextPopstateForPreview 表示"我们刚主动 history.back() 消化掉了预览项，
//   随之而来的 popstate 是自家副作用，应直接吞掉、不要再走 navigateFromUrl 重新加载数据"。
let _previewHistoryActive = false;
let _previewClosingFromPopstate = false;
let _suppressNextPopstateForPreview = false;

// 图片预览翻页状态：
// _previewImageList    当前文件夹中所有可预览图片(currentItemsList 中 is_dir=false 且可作为 image 预览的)
// _previewImageIndex   当前正在显示的图片在 _previewImageList 中的索引
// 仅在 _previewImageList.length > 1 时启用翻页按钮,避免单图文件夹抖动
let _previewImageList = [];
let _previewImageIndex = -1;

// 图片加载请求竞态保护：快速连切图片时(键盘 ← → 或移动端滑动),
// 旧 XHR 还在飞;若不作处理,旧响应可能在新响应之后到达,覆盖刚显示好的最新图。
// 解决:每次 _loadPreviewImage 调用先 xhr.abort() 旧请求;
// 再用 _previewImageReqToken 单调递增,onload/onerror 比较 token,过期回调直接忽略。
let _previewImageXhr = null;
// PDF 预览：用于超时/关闭时中断预检请求，并停止 iframe 内原生阅读器的后续分段拉取。
let _previewPdfController = null;
let _previewImageReqToken = 0;

// 移动端操作面板（mobile-action-sheet）与浏览器历史的协作，含义同上。
let _actionSheetHistoryActive = false;
let _actionSheetClosingFromPopstate = false;
let _suppressNextPopstateForActionSheet = false;

function closePreviewModal() {
    const overlay = document.getElementById("previewOverlay");
    if (!overlay) return;  // 已经关闭，幂等保护
    // 先释放 Artplayer(若存在)。destroy(true) 会同步清理内部 video/audio 元素
    // 及已注册的事件,避免在 overlay 被 remove 之后解码器还在后台跑。
    if (_activeArtplayer && _activeArtplayer !== true) {
        try { _activeArtplayer.destroy(true); } catch (e) { console.warn("[closePreviewModal] art.destroy 失败:", e); }
    }
    _activeArtplayer = null;
    if (_previewPdfController) {
        _previewPdfController.abort();
        _previewPdfController = null;
    }
    // 清空地址停止原生 PDF 阅读器的后续分段请求。
    const pdfFrame = overlay.querySelector(".preview-pdf-frame");
    if (pdfFrame) pdfFrame.src = "about:blank";
    overlay.remove();
    if (_previewKeydownHandler) {
        document.removeEventListener("keydown", _previewKeydownHandler, true);
        _previewKeydownHandler = null;
    }
    if (_previewWheelHandler) {
        // handler 绑在 stage 上，stage 会随 overlay 一起被移除，无需解绑
        _previewWheelHandler = null;
    }
    // 取消仍在飞行的图片请求,避免 onload 在 overlay 被移除之后回写 DOM
    if (_previewImageXhr) {
        try { _previewImageXhr.abort(); } catch (_) {}
        _previewImageXhr = null;
    }

    // 处理预览项与历史栈的协作：见 _previewHistoryActive 注释。
    if (_previewClosingFromPopstate) {
        // 系统返回键 / 侧滑触发：浏览器已自己回到上一项，仅清标记。
        _previewHistoryActive = false;
    } else if (_previewHistoryActive) {
        // 用户点 X / Esc / 点击遮罩空白：主动 back() 消化预览项，避免下次按返回时
        // 再次"穿越"到这条无意义的历史项；抑制随之而来的 popstate 以防重复加载数据。
        _previewHistoryActive = false;
        _suppressNextPopstateForPreview = true;
        try {
            window.history.back();
        } catch (e) {
            console.warn("[closePreviewModal] history.back 失败:", e);
        }
    }
    _previewZoom = 1;
    // 重置图片翻页状态,避免下次打开非图片预览时旧 list/index 残留干扰
    _previewImageList = [];
    _previewImageIndex = -1;
}

/* PDF 预览：先用五字节 Range 请求预检（权限/文件头/大小），再交给 iframe 内
 * 浏览器原生阅读器分段拉取（后续 Range 请求由 /api/preview?kind=pdf 响应）。 */
async function _loadPreviewPdf({stage, contentEl, paperEl, loaderEl, title, src}) {
    const controller = new AbortController();
    _previewPdfController = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    stage.classList.add("preview-pdf-stage");
    loaderEl.innerHTML = '<div class="preview-loader-text">正在加载 PDF…</div>';
    loaderEl.hidden = false;
    try {
        // 先以五字节 Range 请求检查权限和文件类型，避免 iframe 把错误 JSON 当成文档。
        const response = await fetch(src, {headers: {Range: "bytes=0-4"}, signal: controller.signal});
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.detail || result.error || `PDF 加载失败：HTTP ${response.status}`);
        }
        if (response.body) await response.body.cancel();
        if (!document.getElementById("previewOverlay")) return;
        const frame = document.createElement("iframe");
        frame.className = "preview-pdf-frame";
        frame.title = `${title} — PDF 预览`;
        frame.src = `${src}#view=FitH`;
        contentEl.appendChild(frame);
        paperEl.hidden = false;
    } catch (error) {
        if (!document.getElementById("previewOverlay")) return;
        const message = document.createElement("div");
        message.className = "preview-message preview-error";
        message.textContent = error.name === "AbortError" ? "PDF 加载超时，请重试或下载文件" : error.message;
        contentEl.appendChild(message);
        paperEl.hidden = false;
    } finally {
        clearTimeout(timeout);
        if (_previewPdfController === controller) _previewPdfController = null;
        loaderEl.hidden = true;
    }
}

function _setPreviewZoom(z) {
    _previewZoom = Math.max(0.1, Math.min(10, z));
    const paper = document.getElementById("previewPaper");
    if (paper) paper.style.setProperty("--preview-zoom", String(_previewZoom));
}

function _setupImageZoom(stage) {
    _previewWheelHandler = (e) => {
        // 阻止页面/外层滚动
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        _setPreviewZoom(_previewZoom * factor);
    };
    stage.addEventListener("wheel", _previewWheelHandler, { passive: false });
}

/**
 * 在已有的 preview overlay 里加载并显示一张图片。
 * 同时支持首次打开与导航切换,共用同一套 XHR 进度环 + _setupImageZoom,
 * 避免 overlay 销毁/重建带来的闪烁、artplayer 重建、history 项污染等副作用。
 *
 * 注意:切换前后 zoom 会回到 1,旧的 wheel 监听器也会被显式移除,
 * 否则多次调用 _setupImageZoom 会在 stage 上累加 listener,zoom 步进翻倍。
 *
 * 快速连切(键盘连按 ← / →,或移动端快速滑动)时,旧 XHR 还没完成就被新请求覆盖。
 * 用 _previewImageReqToken 单调递增 + xhr.abort() 旧请求,避免旧响应回写到 DOM。
 */
function _loadPreviewImage({ title, src, contentEl, paperEl, loaderEl, stage }) {
    // 取消上一次仍在飞行的请求,丢弃其回调
    if (_previewImageXhr) {
        try { _previewImageXhr.abort(); } catch (_) {}
        _previewImageXhr = null;
    }

    // 加载阶段：隐藏 paper，展示 loader 圆环
    loaderEl.hidden = false;
    paperEl.hidden = true;

    const ringEl = loaderEl.querySelector("#previewRing");
    const pctEl = loaderEl.querySelector("#previewPct");
    // 与上传队列的 .circular-progress 一致：r=10，圆周约 63
    const RING_LEN = 63;
    const setProgress = (p) => {
        const clamped = Math.max(0, Math.min(100, p));
        // 到达 100% 时去掉过渡，避免"文字已 100%、圆环还在转"的延迟
        ringEl.style.transition = clamped >= 100 ? "none" : "";
        ringEl.style.strokeDashoffset = String(RING_LEN * (1 - clamped / 100));
        pctEl.textContent = `${Math.round(clamped)}%`;
    };
    setProgress(0);

    // 切图前重置 zoom + 清理旧 wheel handler,避免 _setupImageZoom 在同一 stage 上叠加监听器
    _setPreviewZoom(1);
    if (_previewWheelHandler) {
        try { stage.removeEventListener("wheel", _previewWheelHandler); } catch (_) {}
        _previewWheelHandler = null;
    }

    // 取本次请求的 token;后续 onload/onerror 与 _previewImageReqToken 比对,过期直接 return
    const myToken = ++_previewImageReqToken;
    const isStale = () => myToken !== _previewImageReqToken;

    // 用 XHR 拿进度事件：new Image() 没有 progress，没法反映真实加载量
    const xhr = new XMLHttpRequest();
    _previewImageXhr = xhr;
    xhr.open("GET", src, true);
    xhr.responseType = "blob";
    xhr.onprogress = (e) => {
        if (isStale()) return;
        if (e.lengthComputable) {
            setProgress((e.loaded / e.total) * 100);
        }
    };
    const finishWithError = () => {
        if (isStale()) return;
        loaderEl.hidden = true;
        paperEl.hidden = false;
        contentEl.innerHTML = `<div class="preview-message preview-error">无法加载图片(文件可能已损坏)</div>`;
    };
    xhr.onload = () => {
        // 哪怕 token 已过期,blob URL 也得释放,避免泄漏
        const blobUrl = URL.createObjectURL(xhr.response);
        if (isStale()) { URL.revokeObjectURL(blobUrl); return; }
        if (xhr.status < 200 || xhr.status >= 300) { finishWithError(); return; }
        setProgress(100);
        const img = new Image();
        img.alt = title;
        img.className = "preview-image";
        img.onload = () => {
            URL.revokeObjectURL(blobUrl);
            if (isStale()) return;
            loaderEl.hidden = true;
            paperEl.hidden = false;
            contentEl.innerHTML = "";
            contentEl.appendChild(img);
            _setupImageZoom(stage);
        };
        img.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            if (isStale()) return;
            finishWithError();
        };
        img.src = blobUrl;
    };
    xhr.onerror = () => { if (isStale()) return; finishWithError(); };
    // 主动 abort 时安静吞掉,不显示错误
    xhr.onabort = () => {};
    xhr.send();
}

/**
 * 打开图片预览时,基于当前目录列表(currentItemsList) 计算可作为图片预览的全部条目,
 * 并把当前 item 在该子集中的索引写入 _previewImageIndex。
 * 调用前提:_previewImageList 为空或与 currentItemsList 已脱钩(list 的元素不会被外部 mutate)。
 *
 * 不强依赖 getIconName/canPreview 的目录一致:currentItemsList 与打开预览时的视图同源。
 */
function _buildPreviewImageList(currentItemName) {
    const list = [];
    let idx = -1;
    if (Array.isArray(displayedItems)) {
        displayedItems.forEach((it) => {
            if (!it || it.is_dir) return;
            const ext = (String(it.name).split(".").pop() || "").toLowerCase();
            if (canPreview(it, ext) === "image") {
                if (it.name === currentItemName) idx = list.length;
                list.push(it);
            }
        });
    }
    _previewImageList = list;
    _previewImageIndex = idx;
}

/**
 * 同步 nav 按钮的禁用态:列表长度 ≤ 1 时双侧都禁用,否则只在首/末边界禁用对应侧。
 * 同时维护按钮的 hidden 状态(列表为空/单图时整组隐藏)。
 */
function _updatePreviewNavButtons() {
    const overlay = document.getElementById("previewOverlay");
    if (!overlay) return;
    const prevBtn = overlay.querySelector(".preview-nav-prev");
    const nextBtn = overlay.querySelector(".preview-nav-next");
    if (!prevBtn || !nextBtn) return;

    const count = _previewImageList.length;
    if (count <= 1) {
        prevBtn.hidden = true;
        nextBtn.hidden = true;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }
    prevBtn.hidden = false;
    nextBtn.hidden = false;
    const atStart = _previewImageIndex <= 0;
    const atEnd = _previewImageIndex >= count - 1;
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
}

/**
 * 切换到当前图片的前/后一张(delta = -1 / +1)。
 * 不在边界时:重置 zoom、清旧 wheel handler、加载新图,并刷新顶部文件名 + 按钮状态。
 * 在边界或仅有 1 张图片时静默返回,不做任何 DOM 变更。
 */
function _navigatePreviewImage(delta) {
    if (!delta || _previewImageList.length <= 1) return;
    const newIdx = _previewImageIndex + delta;
    if (newIdx < 0 || newIdx >= _previewImageList.length) return;
    const item = _previewImageList[newIdx];
    if (!item) return;

    const overlay = document.getElementById("previewOverlay");
    if (!overlay) return;

    _previewImageIndex = newIdx;

    const stage = overlay.querySelector("#previewStage");
    const contentEl = overlay.querySelector("#previewContent");
    const paperEl = overlay.querySelector("#previewPaper");
    const loaderEl = overlay.querySelector("#previewLoader");
    const filenameEl = overlay.querySelector(".preview-filename");
    if (filenameEl) {
        filenameEl.textContent = item.name;
        filenameEl.setAttribute("title", item.name);
    }

    const relPath = joinPath(currentPath, item.name);
    const url = `${CONFIG.API_BASE}/api/preview?path=${encodeURIComponent(relPath)}&kind=image`;
    _loadPreviewImage({ title: item.name, src: url, contentEl, paperEl, loaderEl, stage });
    _updatePreviewNavButtons();
}

/**
 * 移动端图片预览左右滑动翻页手势。
 * 仅在 _previewImageList.length > 1 时生效(单图文件夹不挂监听,减少无意义的事件触发)。
 * 阈值判定:水平位移 ≥ 50px 且明显大于垂直位移(>1.5 倍 + 绝对值 ≤ 80),才视为一次有效滑动;
 * 避免下拉刷新 / 上下滚动 / 偶尔的横向抖动误触发翻页。
 *
 * 同一个 stage 只挂一次监听(dataset 标记),多次 _loadPreviewImage 不会叠加。
 * 滑动方向:左滑(dx < 0)→ 下一张;右滑(dx > 0)→ 上一张。
 */
function _setupImageSwipe(stage) {
    if (!stage || stage.dataset.swipeBound === "1") return;
    stage.dataset.swipeBound = "1";

    const SWIPE_THRESHOLD = 50;   // 最小水平位移(px)
    const VERTICAL_LIMIT = 80;    // 允许的最大垂直位移(px)

    let startX = 0;
    let startY = 0;
    let tracking = false;

    stage.addEventListener("touchstart", (e) => {
        // 仅响应单指,避免多指捏合 / 多点操作误触
        if (!e.touches || e.touches.length !== 1) { tracking = false; return; }
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
    }, { passive: true });

    stage.addEventListener("touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        if (_previewImageList.length <= 1) return;
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) return;

        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        // 水平位移够大 + 明显大于垂直位移,才判定为水平滑动
        if (Math.abs(dx) >= SWIPE_THRESHOLD &&
            Math.abs(dx) > Math.abs(dy) * 1.5 &&
            Math.abs(dy) <= VERTICAL_LIMIT) {
            _navigatePreviewImage(dx < 0 ? 1 : -1);
        }
    }, { passive: true });
    // 用户中途取消(touchcancel)时,丢弃这次追踪,避免误触发
    stage.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
}

/**
 * 按需加载 artplayer.js。已本地托管到 vendor/(锁定 5.4.0,与后端同源),
 * 仅首次视频/音频预览时拉取,后续预览复用同一份 promise。
 * 失败时抛出，调用方负责给出错误提示。
 */
function _loadArtplayer() {
    if (typeof window.Artplayer !== "undefined") return Promise.resolve(window.Artplayer);
    if (_artplayerLoaderPromise) return _artplayerLoaderPromise;
    _artplayerLoaderPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        // 相对路径:与 index.html 同源的 vendor 目录,自动适配 BASE_PATH 部署
        s.src = "vendor/artplayer.js";
        s.async = true;
        s.onload = () => {
            if (typeof window.Artplayer !== "undefined") resolve(window.Artplayer);
            else reject(new Error("artplayer.js 加载完成但全局变量缺失"));
        };
        s.onerror = () => {
            _artplayerLoaderPromise = null;  // 下次重试
            reject(new Error("无法加载 artplayer.js"));
        };
        document.head.appendChild(s);
    });
    return _artplayerLoaderPromise;
}

/**
 * 在容器里实例化 Artplayer。仅保留核心播放必需/通用的开关,
 * 移除示例中 demo-only 的组件(subtitle/settings/contextmenu/layers/quality/
 * thumbnails/highlight/controls/icons/custom attr)。
 *
 * Artplayer 默认会随 <video>/<audio> 的容器尺寸自适应;这里直接把 container 放在
 * previewContent 里,样式由 CSS 给一个最大宽高限制即可。
 */
function _buildArtplayer(ArtplayerCtor, container, { src, ext, title, kind }) {
    return new ArtplayerCtor({
        container,
        url: src,
        // 显式声明 MIME,避免部分浏览器把 webm/ogg 误判导致无法播放。
        type: _artplayerMimeFor(ext, kind),
        title,
        volume: 0.5,
        isLive: false,
        muted: false,
        autoplay: false,
        // 视频专属开关(音频场景 Artplayer 内部会忽略,放在一起不增加风险)
        pip: true,
        autoSize: true,
        autoMini: true,
        screenshot: false,
        setting: true,
        loop: true,
        flip: true,
        playbackRate: true,
        aspectRatio: true,
        fullscreen: true,
        fullscreenWeb: true,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: true,
        airplay: true,
        theme: "#23ade5",
        lang: (navigator.language || "zh-cn").toLowerCase(),
    });
}

function _artplayerMimeFor(ext, kind) {
    const map = {
        mp4: "video/mp4", m4v: "video/mp4",
        webm: "video/webm", ogv: "video/ogg",
        mov: "video/quicktime",
        mp3: "audio/mpeg", wav: "audio/wav",
        ogg: "audio/ogg", oga: "audio/ogg",
        m4a: "audio/mp4", aac: "audio/aac",
        opus: "audio/ogg",
    };
    return map[ext] || (kind === "audio" ? "audio/mpeg" : "video/mp4");
}

/**
 * 打开文件预览。kind=image 时 src 是后端 URL，浏览器直接渲染；
 * kind=text 时由调用方预先 fetch 拿到 content 再传入。
 * iconName 决定左上角 logo（默认 image / file）。
 * item 可选:传入后用于建立图片翻页状态(同一文件夹下前后切换)。
 */
function openPreviewModal({ title, kind, src, content, error, iconName, ext, item }) {
    closePreviewModal();
    // 顺带关掉可能残留的重命名/移动弹窗
    closeModal();

    // 让浏览器后退 / 移动端侧滑返回 / 物理返回键可以关闭预览而不是退回上一级路由：
    // 打开预览时往历史栈推一条 preview 标记，popstate 监听器会优先消费它来关闭预览。
    if (!_previewHistoryActive) {
        try {
            window.history.pushState({ ...(window.history.state || {}), preview: true }, "");
            _previewHistoryActive = true;
        } catch (e) {
            console.warn("[openPreviewModal] history.pushState 失败:", e);
        }
    }

    const logoName = iconName || (kind === "image" ? "image" : "file");
    const logoSrc = `${CONFIG.API_BASE}/api/icon/${encodeURIComponent(logoName)}`;

    // 是否为 markdown 文件 —— 显示原文/渲染 切换按钮
    const isMarkdown = (ext === "md" || ext === "markdown");

    const overlay = document.createElement("div");
    overlay.className = "preview-overlay";
    overlay.id = "previewOverlay";
    overlay.innerHTML = `
        <header class="preview-topbar">
            <button class="preview-close" title="关闭" aria-label="关闭">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#ececec">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.41 13.41 12z"/>
                </svg>
            </button>
            <img class="preview-logo" src="${escapeAttr(logoSrc)}" width="24" height="24" alt="" />
            <span class="preview-filename" title="${escapeAttr(title)}">${escapeHtml(title)}</span>
            ${isMarkdown ? `<button class="preview-toggle" id="previewToggle" type="button" title="切换纯文本 / 渲染" aria-label="切换视图">
                <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M1 0C0.447715 0 0 0.447715 0 1C0 1.55228 0.447715 2 1 2H13C13.5523 2 14 1.55228 14 1C14 0.447715 13.5523 0 13 0H1ZM0 6C0 5.44772 0.447715 5 1 5H13C13.5523 5 14 5.44772 14 6C14 6.55228 13.5523 7 13 7H1C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12H13C13.5523 12 14 11.5523 14 11C14 10.4477 13.5523 10 13 10H1Z" fill="currentColor"/>
                </svg>
                <span id="previewToggleLabel">查看原文</span>
            </button>` : ""}
        </header>
        <div class="preview-stage" id="previewStage">
            <div class="preview-paper" id="previewPaper" hidden>
                <div class="preview-content" id="previewContent"></div>
            </div>
            <div class="preview-loader" id="previewLoader" hidden>
                <div class="preview-circular-progress" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <circle class="bg" cx="12" cy="12" r="10"></circle>
                        <circle class="value" id="previewRing" cx="12" cy="12" r="10"></circle>
                    </svg>
                    <span class="preview-cp-pct" id="previewPct">0%</span>
                </div>
                <div class="preview-loader-text">加载中…</div>
            </div>
            <!-- 图片翻页按钮：absolute 贴屏幕两侧,_updatePreviewNavButtons 在 kind=image 且列表 > 1 时清掉 hidden -->
            <button class="preview-nav-btn preview-nav-prev" type="button" aria-label="上一张" title="上一张(←)" data-tooltip="上一张(←)" hidden>
                <svg focusable="false" viewBox="0 -960 960 960" height="24" width="24" aria-hidden="true"><path d="M400-240L160-480L400-720l56,58L314-520H800v80H314L456-298l-56,58Z"></path></svg>
            </button>
            <button class="preview-nav-btn preview-nav-next" type="button" aria-label="下一张" title="下一张(→)" data-tooltip="下一张(→)" hidden>
                <svg height="24" viewBox="0 0 24 24" width="24px" focusable="false" aria-hidden="true"><path d="M14 6l-1.41 1.41L16.17 11H4v2h12.17l-3.58 3.59L14 18l6-6z"></path></svg>
            </button>
        </div>`;
    document.body.appendChild(overlay);

    const stage = overlay.querySelector("#previewStage");
    const contentEl = overlay.querySelector("#previewContent");
    const paperEl = overlay.querySelector("#previewPaper");
    const loaderEl = overlay.querySelector("#previewLoader");
    const prevBtn = overlay.querySelector(".preview-nav-prev");
    const nextBtn = overlay.querySelector(".preview-nav-next");
    overlay.querySelector(".preview-close").onclick = closePreviewModal;

    // 图片翻页:用 mousedown 而不是 click,避免点按钮的合成 click 命中下方 paper 触发关闭逻辑。
    // (overlay 自带的 mousedown 点击空白关闭不会受影响,因为按钮内部的 mousedown 由 stopPropagation 阻断冒泡。)
    if (prevBtn) {
        prevBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });
        prevBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            _navigatePreviewImage(-1);
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });
        nextBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            _navigatePreviewImage(1);
        });
    }

    // 点击舞台空白处（不在 paper 上）关闭
    overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay || e.target === stage) closePreviewModal();
    });

    // ESC 关闭 + 上下/前后箭头翻页（仅图片预览且列表 > 1 时启用；capture 阶段拦截）
    _previewKeydownHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            closePreviewModal();
            return;
        }
        // 图片左右翻页：仅当 _previewImageList 长度 > 1 时响应;否则不会进入任何分支
        if (_previewImageList.length > 1) {
            if (e.key === "ArrowLeft") {
                e.preventDefault(); e.stopPropagation();
                _navigatePreviewImage(-1);
                return;
            }
            if (e.key === "ArrowRight") {
                e.preventDefault(); e.stopPropagation();
                _navigatePreviewImage(1);
                return;
            }
        }
    };
    document.addEventListener("keydown", _previewKeydownHandler, true);

    _setPreviewZoom(1);

    if (error) {
        contentEl.innerHTML = `<div class="preview-message preview-error">${escapeHtml(error)}</div>`;
        paperEl.hidden = false;
        return;
    }

    if (kind === "image") {
        // 基于当前目录列表建立图片导航状态(item 缺失则不启用翻页)
        if (item && item.name) {
            _buildPreviewImageList(item.name);
        } else {
            _previewImageList = [];
            _previewImageIndex = -1;
        }
        // 同步翻页按钮 visible / disabled 态(列表 ≤ 1 时整体隐藏)
        _updatePreviewNavButtons();
        _loadPreviewImage({ title, src, contentEl, paperEl, loaderEl, stage });
        // 移动端走 touch swipe gesture 翻页(PC 端也有键盘 ← → + 按钮,这里只补齐触屏)
        _setupImageSwipe(stage);
        return;
    }

    if (kind === "pdf") {
        _loadPreviewPdf({stage, contentEl, paperEl, loaderEl, title, src});
        return;
    }

    if (kind === "video" || kind === "audio") {
        // 走 Artplayer 流式播放：先把 paper 展开、loader 维持可见，等 Artplayer 实例化完成再隐藏。
        paperEl.hidden = false;
        // 给 Artplayer 一个干净的容器(div.artplayer-app 风格),避免其默认样式与 previewContent 冲突。
        contentEl.innerHTML = "";
        contentEl.classList.add("preview-media");
        const playerHost = document.createElement("div");
        playerHost.className = "preview-media-host";
        contentEl.appendChild(playerHost);

        // 任何早退路径都需要清掉 _activeArtplayer 引用 + loader,避免下次打开时残留。
        const cleanup = (errMsg) => {
            if (_activeArtplayer && _activeArtplayer !== true) {
                try { _activeArtplayer.destroy(true); } catch (_) {}
            }
            _activeArtplayer = null;
            loaderEl.hidden = true;
            paperEl.hidden = false;
            contentEl.classList.remove("preview-media");
            if (errMsg) {
                contentEl.innerHTML = `<div class="preview-message preview-error">${escapeHtml(errMsg)}</div>`;
            }
        };

        _loadArtplayer().then((ArtplayerCtor) => {
            // 加载期间用户可能已关闭预览
            if (!document.getElementById("previewContent")) return;
            try {
                const art = _buildArtplayer(ArtplayerCtor, playerHost, {
                    src, ext, title, kind,
                });
                _activeArtplayer = art;
                loaderEl.hidden = true;
            } catch (e) {
                console.error("[openPreviewModal] Artplayer 初始化失败:", e);
                cleanup("播放器初始化失败：" + (e && e.message ? e.message : String(e)));
            }
        }).catch((e) => {
            console.error("[openPreviewModal] artplayer.js 加载失败:", e);
            if (!document.getElementById("previewContent")) return;
            cleanup("播放器加载失败，请检查网络后重试");
        });
        return;
    }

    if (kind === "text") {
        if (content !== undefined) {
            renderPreviewText(contentEl, content, { ext, isMarkdown });
            paperEl.hidden = false;
        }
    }
}

// ================= Markdown 数学公式(KaTeX)================
// 流程:marked 行内扩展在解析阶段把 $...$ / $$...$$ 截成占位符(纯文本,
// 能原样通过 DOMPurify 的严格白名单),消毒后再把占位符替换为 KaTeX
// 渲染结果。分两步而非先渲染再消毒,是因为 LaTeX 源码若先过 markdown 的
// 转义/强调/代码规则会被破坏(\_ 、x*y*z、` 反引号等);
// 而行内扩展在代码块/行内代码的记号之前不会触发,天然跳过代码内容。
let _mdMathStore = [];

const _mdInlineMathExt = {
    name: "inlineMath",
    level: "inline",
    // 告诉 marked:纯文本 token 遇到 $ 要停下来,否则整段被吞掉轮不到本扩展
    start(src) { return src.indexOf("$"); },
    tokenizer(src) {
        if (src[0] !== "$") return;
        // $$...$$ 展示公式(支持多行)
        if (src[1] === "$") {
            const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
            if (m && m[1].trim()) {
                return { type: "inlineMath", raw: m[0], latex: m[1].trim(), display: true };
            }
            return; // 未闭合的 $$ 按普通文本处理
        }
        // $...$ 行内公式。防货币误伤:内容非空、首尾不能是空白、
        // 闭合 $ 后不能紧跟数字("$5 and $10"、"$100$200" 都不算公式)
        const m = /^\$(?!\s)((?:\\.|[^$])+?)\$(?!\d)/.exec(src);
        if (!m || /\s$/.test(m[1])) return;
        return { type: "inlineMath", raw: m[0], latex: m[1], display: false };
    },
    renderer(token) {
        const i = _mdMathStore.push({ latex: token.latex, display: token.display }) - 1;
        return `%%MATH${i}%%`;
    },
};
if (typeof marked !== "undefined" && typeof marked.use === "function") {
    marked.use({ extensions: [_mdInlineMathExt] });
}

// ================= Markdown 加粗容错 =================
// CommonMark 规定:闭合 ** 前有空白(或开启 ** 后紧跟空白)时不是强调,
// 于是 **第一轮 **计划 会原样显示星号。中文写作里这类多余空格很常见,
// 这里放宽为:仅单侧有空白时仍渲染加粗;两侧都有空白(** foo **)按规范
// 保持原样。正常写法(**foo**)、斜体(*foo*)与代码块/行内代码不受影响
// (marked 先对代码分词,扩展根本看不到代码里的内容)。
// 注意:内容含 * 的写法(**a *b* **)仍按严格规则处理,避免与嵌套
// 强调/斜体产生歧义。
const _mdLenientStrongExt = {
    name: "lenientStrong",
    level: "inline",
    tokenizer(src) {
        if (!src.startsWith("**")) return;
        // 与 marked 内置 strong token 同构:type/raw/text/tokens
        const strong = (raw, text) => ({
            type: "strong", raw, text,
            tokens: this.lexer.inlineTokens(text),
        });
        // 闭合 ** 前有空白:**第一轮 **计划 -- 保留一个空格在加粗内维持间距
        let m = /^\*\*([^*\n]+?)[ \t]+\*\*(?!\*)/.exec(src);
        if (m && !/^[ \t]/.test(m[1])) return strong(m[0], m[1] + " ");
        // 开启 ** 后紧跟空白:** 第一轮**计划 -- 前导空格无法保留,丢弃
        m = /^\*\*[ \t]+([^*\n]+?)\*\*(?!\*)/.exec(src);
        if (m && !/[ \t]$/.test(m[1])) return strong(m[0], m[1]);
    },
};
if (typeof marked !== "undefined" && typeof marked.use === "function") {
    marked.use({ extensions: [_mdLenientStrongExt] });
}

/**
 * 单条公式 -> HTML。KaTeX 缺失/渲染失败时退化为行内代码显示原文,
 * 绝不让一条坏公式破坏整篇文档的渲染。
 */
function _renderMdMathHtml(tok) {
    const fallback = () => `<code class="math-fallback">${escapeHtml(tok.latex)}</code>`;
    if (typeof katex === "undefined" || typeof katex.renderToString !== "function") {
        return fallback();
    }
    try {
        const html = katex.renderToString(tok.latex, {
            displayMode: !!tok.display,
            throwOnError: false,
            strict: "ignore",
            trust: false,
        });
        // KaTeX 输出再过一遍 DOMPurify 默认白名单(HTML+MathML+SVG,禁脚本/
        // 事件属性)作双保险,与"所有进入 innerHTML 的内容都消毒"的原则一致
        if (typeof DOMPurify !== "undefined") return DOMPurify.sanitize(html);
        return fallback();
    } catch (e) {
        return fallback();
    }
}

/**
 * 把文本内容写入预览区：
 *   - md/markdown：默认渲染为 HTML（marked.js），切换按钮可在 渲染 ↔ 原文 之间切
 *   - 其它文本（含代码文件）：保持纯文本展示，不做语法高亮
 */
/** 把 Markdown 里的相对/绝对图片引用改写为云盘预览接口地址。
 *  外部 URL 和内嵌图片保留原值；调用方只处理 DOMPurify 消毒后的属性。 */
function markdownImagePreviewUrl(reference, documentPath) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) return reference;
    const imagePath = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    const parts = imagePath.startsWith("/") ? [] : documentPath.split("/").slice(0, -1);
    for (const part of imagePath.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (!parts.length) throw new Error("图片路径超出云盘根目录");
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return `${CONFIG.API_BASE}/api/preview?path=${encodeURIComponent(parts.join("/"))}&kind=image`;
}

function renderPreviewText(contentEl, raw, { ext, isMarkdown, documentPath = "" }) {
    contentEl.innerHTML = "";

    // ================ Markdown 分支 ================
    if (isMarkdown) {
        // 状态保存在 contentEl.dataset 上，避免污染全局变量
        contentEl.dataset.mode = "rendered";
        contentEl.dataset.raw = raw || "";

        const renderRendered = () => {
            if (typeof marked === "undefined") {
                // 极端兜底：marked 未加载就退回原文
                renderRaw();
                return;
            }
            const raw = contentEl.dataset.raw || "";
            // 必须用 DOMPurify 消毒 marked 的输出,否则 `<img onerror=...>` 等可触发 XSS。
            // DOMPurify 未加载时(理论上不应发生 -- 已本地托管)绝不输出未消毒 HTML,
            // 一律回退纯文本渲染。
            if (typeof DOMPurify === "undefined") {
                renderRaw();
                return;
            }
            // 占位符要在 parse 之前清空:renderer 在解析过程中往里写
            _mdMathStore = [];
            const html = DOMPurify.sanitize(marked.parse(raw), {
                ALLOWED_TAGS: [
                    "a","b","i","em","strong","code","pre","blockquote",
                    "ul","ol","li","p","br","hr","h1","h2","h3","h4","h5","h6",
                    "img","table","thead","tbody","tr","th","td","del","sup","sub",
                    "span","div",
                ],
                ALLOWED_ATTR: ["href","title","alt","src","colspan","rowspan"],
                ALLOW_DATA_ATTR: false,
            });
            // 公式占位符 -> KaTeX HTML(_renderMdMathHtml 内部已消毒;
            // 原文里恰好出现 %%MATHn%% 字样且序号越界时保持原样)
            let finalHtml = html;
            if (_mdMathStore.length) {
                finalHtml = html.replace(/%%MATH(\d+)%%/g, (m, i) => {
                    const tok = _mdMathStore[+i];
                    return tok ? _renderMdMathHtml(tok) : m;
                });
            }
            contentEl.innerHTML = "";
            const wrap = document.createElement("div");
            wrap.className = "preview-md";
            // template 内容保持惰性，先改好图片 URL 再插入，避免请求站点下的错误路径。
            const template = document.createElement("template");
            template.innerHTML = finalHtml;
            template.content.querySelectorAll("img[src]").forEach(image => {
                try {
                    image.setAttribute("src", markdownImagePreviewUrl(image.getAttribute("src"), documentPath));
                } catch (_) {
                    image.removeAttribute("src");
                }
            });
            wrap.appendChild(template.content);
            contentEl.appendChild(wrap);
        };

        const renderRaw = () => {
            contentEl.innerHTML = "";
            const pre = document.createElement("pre");
            pre.className = "preview-text";
            pre.textContent = contentEl.dataset.raw || "";
            contentEl.appendChild(pre);
        };

        // 暴露给 toggle 按钮
        contentEl._rendered = renderRendered;
        contentEl._raw = renderRaw;
        renderRendered();

        // 绑定切换按钮
        const btn = document.getElementById("previewToggle");
        const label = document.getElementById("previewToggleLabel");
        if (btn) {
            btn.onclick = () => {
                const next = contentEl.dataset.mode === "rendered" ? "raw" : "rendered";
                contentEl.dataset.mode = next;
                if (next === "rendered") {
                    renderRendered();
                    label.textContent = "查看原文";
                } else {
                    renderRaw();
                    label.textContent = "查看渲染";
                }
            };
        }
        return;
    }

    // ================ 其它纯文本（含代码文件） ================
    contentEl.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = raw || "";  // textContent 永不解析 HTML
    contentEl.appendChild(pre);
}

/**
 * 触发文件预览（双击文件行调用）。
 * - image: 直接打开弹窗，<img> 走 GET /api/preview?kind=image
 * - video / audio: 直接打开弹窗，Artplayer 走 GET /api/preview?kind=video|audio
 * - text : 先 fetch JSON，再把 content 注入 <pre>
 */
async function previewFile(item, kind) {
    const relPath = joinPath(currentPath, item.name);
    const url = `${CONFIG.API_BASE}/api/preview?path=${encodeURIComponent(relPath)}&kind=${kind}`;
    const ext = item.name.split(".").pop().toLowerCase();

    if (kind === "pdf") {
        // 原生阅读器 iframe：走 GET /api/preview?kind=pdf（支持 HTTP Range 分段拉取）。
        openPreviewModal({title: item.name, kind, src: url, iconName: "pdf"});
        return;
    }

    if (kind === "image") {
        // 传 item 给 openPreviewModal,用于建立"同文件夹内前后图片翻页"状态
        openPreviewModal({ title: item.name, kind: "image", src: url, iconName: "image", item });
        return;
    }

    if (kind === "video" || kind === "audio") {
        // 先开 loading 弹窗（kind=video|audio 时不再走 XHR 进度，Artplayer 自己拉流），
        // 待 Artplayer CDN 注入并实例化后再隐藏 loader。
        openPreviewModal({
            title: item.name,
            kind,
            src: url,
            iconName: iconNameForExt(false, ext),
            ext,
        });
        return;
    }

    // text: 先开 loading 弹窗，再 fetch。
    // logo 名称按扩展名取 —— 代码文件用 code.svg，markdown 用 md.svg，
    // 与 file-list 行首图标保持完全一致。ext 透传给弹窗，让 Markdown 走渲染分支。
    openPreviewModal({
        title: item.name,
        kind: "text",
        iconName: iconNameForExt(false, ext),
        ext,
    });
    // 异步 fetch 期间显示 loader 圆环，避免预览区空白
    const loaderEl = document.getElementById("previewLoader");
    const paperEl = document.getElementById("previewPaper");
    if (loaderEl) loaderEl.hidden = false;
    if (paperEl) paperEl.hidden = true;
    try {
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        const contentEl = document.getElementById("previewContent");
        if (!contentEl) return;  // 弹窗已被关闭
        if (!res.ok) {
            const msg = (data && (data.error || data.detail)) || `HTTP ${res.status}`;
            contentEl.innerHTML = `<div class="preview-message preview-error">${escapeHtml(msg)}</div>`;
            if (loaderEl) loaderEl.hidden = true;
            if (paperEl) paperEl.hidden = false;
            return;
        }
        renderPreviewText(contentEl, data.content || "", { ext, isMarkdown: ext === "md" || ext === "markdown", documentPath: relPath });
        // fetch 返回后必须取消 paper 的 hidden,否则 paper 整层保持 display:none,
        if (loaderEl) loaderEl.hidden = true;
        if (paperEl) paperEl.hidden = false;
    } catch (e) {
        const contentEl = document.getElementById("previewContent");
        if (contentEl) {
            contentEl.innerHTML = `<div class="preview-message preview-error">加载失败：${escapeHtml(e.message || String(e))}</div>`;
        }
        if (loaderEl) loaderEl.hidden = true;
        if (paperEl) paperEl.hidden = false;
    }
}

/**
 * 构建并显示一个居中弹窗。
 * @param {object} opts { title, bodyHTML, onConfirm, confirmText, onOpen, onCancel }
 *   onConfirm 返回 false 可阻止关闭（用于校验失败）。
 *   onCancel 在用户以"未确认"方式关闭(取消按钮/X/遮罩/Esc)时触发;
 *   打开新 modal 时若旧 modal 仍未确认,其 onCancel 也会被触发。
 */
function openModal({ title, bodyHTML, onConfirm, confirmText = "确定", onOpen, onCancel }) {
    closeModal();
    _modalOnCancel = onCancel || null;
    _modalConfirmed = false;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "modalOverlay";
    overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
            <div class="modal-header">
                <h2 class="modal-title">${escapeHtml(title)}</h2>
                <button class="modal-close" title="关闭" onclick="closeModal()"><svg width="18" height="18" viewBox="0 0 24 24" fill="#444746"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
            </div>
            <div class="modal-body">${bodyHTML}</div>
            <div class="modal-footer">
                <button class="modal-btn modal-btn-text" id="modalCancelBtn">取消</button>
                <button class="modal-btn modal-btn-primary" id="modalConfirmBtn">${escapeHtml(confirmText)}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    // 点击遮罩空白处关闭
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });

    const confirmBtn = overlay.querySelector("#modalConfirmBtn");
    const cancelBtn = overlay.querySelector("#modalCancelBtn");
    cancelBtn.onclick = closeModal;
    confirmBtn.onclick = async () => {
        const ok = onConfirm ? await onConfirm() : true;
        if (ok !== false) {
            _modalConfirmed = true;
            closeModal();
        }
    };

    _modalKeydownHandler = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(); }
    };
    document.addEventListener("keydown", _modalKeydownHandler, true);

    if (onOpen) onOpen(overlay);
    return overlay;
}

/**
 * 确认弹窗(替代原生 confirm):返回 Promise<boolean>。
 * 用户点"确认" -> resolve(true);取消/X/遮罩/Esc -> resolve(false)。
 */
function showConfirm(title, message, { confirmText = "确定" } = {}) {
    return new Promise((resolve) => {
        openModal({
            title,
            bodyHTML: `<div style="padding: 12px 0; color: var(--text-primary); line-height: 1.6; white-space: pre-line;">${escapeHtml(message)}</div>`,
            confirmText,
            onConfirm: () => { resolve(true); return true; },
            onCancel: () => resolve(false),
        });
    });
}

/**
 * 输入弹窗(替代原生 prompt):返回 Promise<string|null>。
 * 用户点"确认" -> resolve(输入值,已 trim);取消 -> resolve(null)。
 * validate(value) 返回错误文案时阻止关闭并 toast 提示,输入框保留。
 */
function showPrompt(title, { value = "", placeholder = "", confirmText = "确定", validate } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        openModal({
            title,
            confirmText,
            bodyHTML: `<input type="text" class="modal-input" id="promptInput" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value)}">`,
            onOpen: (overlay) => {
                const input = overlay.querySelector("#promptInput");
                input.focus();
                input.select();
                input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") { e.preventDefault(); overlay.querySelector("#modalConfirmBtn").click(); }
                });
            },
            onCancel: () => { if (!settled) resolve(null); },
            onConfirm: () => {
                const input = document.getElementById("promptInput");
                const val = (input && input.value ? input.value : "").trim();
                const err = validate ? validate(val) : null;
                if (err) {
                    showToast(err);
                    return false;  // 阻止关闭,用户可修正后重试
                }
                settled = true;
                resolve(val);
                return true;
            },
        });
    });
}

// ================= 重命名（弹窗） =================
const _INVALID_NAME = /[\/\\:*?"<>|\x00-\x1f]/;

function _validateName(name) {
    if (name === "") return "名称不能为空";
    if (_INVALID_NAME.test(name)) return '名称包含非法字符（\\/:*?"<>| 或控制字符）';
    if (name === "." || name === "..") return "名称无效";
    if (name.endsWith(" ") || name.endsWith(".")) return "名称不能以空格或点结尾";
    return null;
}

function openRenameDialog(idx) {
    if (currentView !== "files") return;
    const item = displayedItems[idx];
    if (!item) return;
    const oldName = item.name;

    openModal({
        title: "重命名",
        confirmText: "确定",
        bodyHTML: `<input type="text" class="modal-input" id="renameInput" value="${escapeAttr(oldName)}">`,
        onOpen: (overlay) => {
            const input = overlay.querySelector("#renameInput");
            input.focus();
            // 选中文件名主体（不含扩展名），与常见文件管理器一致
            const dot = item.is_dir ? -1 : oldName.lastIndexOf(".");
            if (dot > 0) input.setSelectionRange(0, dot);
            else input.select();
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); overlay.querySelector("#modalConfirmBtn").click(); }
            });
        },
        onConfirm: async () => {
            const input = document.getElementById("renameInput");
            const newName = input.value.trim();
            if (newName === oldName) return true; // 未修改，直接关闭
            const err = _validateName(newName);
            if (err) { showToast(err); return false; }

            const oldPath = joinPath(currentPath, oldName);
            const newPath = joinPath(currentPath, newName);
            try {
                const res = await fetch(`${CONFIG.API_BASE}/api/action/rename`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({path: oldPath, target_path: newPath})
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { showToast(`重命名失败：${data.detail || `HTTP ${res.status}`}`); return false; }
                loadPath(currentPath);
                return true;
            } catch (e) {
                showToast(`重命名失败：${errMessage(e)}`);
                return false;
            }
        }
    });
}

// ================= 固定路径（Pin） =================
function pathLabel(path) {
    if (!path) return "根目录";
    const parts = path.split("/");
    return parts[parts.length - 1] || "根目录";
}

async function loadPinned() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/pinned`);
        const data = await res.json();
        pinnedPaths = Array.isArray(data.pinned) ? data.pinned : [];
    } catch (e) {
        pinnedPaths = [];
    }
    // 首屏：若已有固定文件夹，自动展开侧边栏「已固定的文件夹」expander。
    // loadPinned() 仅在 init() 中调用一次，此处只覆盖初始默认折叠态，不影响用户后续手动折叠。
    if (pinnedPaths.length > 0 && !pinnedSectionOpen) {
        pinnedSectionOpen = true;
    }
    renderPinnedSidebar();
    updatePinButton();
    // 深链直达 ?view=pinned 时,switchToPinnedView 已先用空的 pinnedPaths 渲染过主面板;
    // fetch 落地后若仍停留在 pinned 视图,重渲染一次以显示真实列表。
    if (currentView === "pinned") renderPinnedMain();
}

function renderPinnedSidebar() {
    const navItem = document.getElementById("navPinned");
    const box = document.getElementById("pinnedList");
    if (!box) return;

    // 始终显示「已固定的文件夹」入口；列表为空时也可点击但里面显示占位
    navItem.style.display = "";
    // 同步 expander 三角的展开态（CSS rotate(90deg) 让 ▶ 变 ▼）
    syncPinnedExpander();

    if (pinnedPaths.length === 0) {
        box.style.display = pinnedSectionOpen ? "block" : "none";
        box.innerHTML = pinnedSectionOpen ? `<div class="pinned-empty">尚未固定任何文件夹</div>` : "";
        return;
    }
    box.style.display = pinnedSectionOpen ? "block" : "none";
    if (!pinnedSectionOpen) { box.innerHTML = ""; return; }
    box.innerHTML = pinnedPaths.map(p => {
        const isCurrent = currentView === "files" && p === currentPath;
        // data-path 由 #pinnedList 上的事件委托统一处理(不内嵌 onclick 字符串)
        return `<div class="pinned-item ${isCurrent ? "current" : ""}" title="${escapeAttr(p || "根目录")}" data-path="${escapeAttr(p)}">
            <svg viewBox="0 0 24 24" height="24" width="24" fill="rgb(68, 71, 70)"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            <span class="pinned-item-name">${escapeHtml(pathLabel(p))}</span>
        </div>`;
    }).join("");
    window.DriveDrag?.refreshTargets();
}

function goToPinned(path) {
    if (currentView === "pinned") {
        switchToFilesView();
    } else if (currentView !== "files") {
        switchToFilesView();
    }
    loadPath(path);
}

/**
 * 从主面板 pinned 视图里点击"取消固定"按钮：调用现有的 toggle_pin 接口，
 * 取消固定后顺手刷新侧边栏 + 主面板列表。
 */
async function unpinFromMain(idx) {
    const item = displayedItems[idx];
    if (!item) return;
    const targetPath = item.full_path || "";
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/pin`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: targetPath})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("操作失败", data.detail || `HTTP ${res.status}`);
        }
        pinnedPaths = Array.isArray(data.pinned_list) ? data.pinned_list : pinnedPaths;
        renderPinnedSidebar();
        // 主面板可能正在显示已固定列表，重渲染
        if (currentView === "pinned") renderPinnedMain();
    } catch (e) {
        showAlert("操作失败", errMessage(e));
    }
}

function updatePinButton() {
    const btn = document.getElementById("bcPinBtn");
    if (!btn) return;
    const isPinned = currentView === "files" && pinnedPaths.includes(currentPath);
    btn.classList.toggle("pinned", isPinned);
    // 使用 data-tooltip 让全局自定义 tooltip 系统接管；
    // 文案根据当前是否已固定动态切换，并带上目标路径让用户清楚自己要钉什么。
    btn.setAttribute("data-tooltip", `${isPinned ? "取消固定" : "固定"}：${currentPath || "根目录"}`);
    // 当前目录变化时高亮 sidebar 对应节点
    document.querySelectorAll(".pinned-item.current").forEach(el => el.classList.remove("current"));
    if (isPinned) {
        const sel = pinnedPaths.includes(currentPath)
            ? `.pinned-item[title="${cssEscape(currentPath || "根目录")}"]`
            : null;
        if (sel) {
            const node = document.querySelector(sel);
            if (node) node.classList.add("current");
        }
    }
}

function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
}

async function togglePinCurrentPath() {
    if (currentView !== "files") return;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/pin`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: currentPath})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showAlert("操作失败", data.detail || `HTTP ${res.status}`);
        pinnedPaths = Array.isArray(data.pinned_list) ? data.pinned_list : pinnedPaths;
        renderPinnedSidebar();
        updatePinButton();
    } catch (e) {
        showAlert("操作失败", errMessage(e));
    }
}

// ================= 移动（弹窗选择目标目录） =================
function moveSingle(filename) {
    const path = joinPath(currentPath, filename);
    openMoveDialog([path], filename);
}

function bulkMove() {
    if (currentView !== "files" || selectedItems.length === 0) return;
    const paths = selectedItems.map(item => joinPath(currentPath, item.name));
    const label = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} 项内容`;
    openMoveDialog(paths, label);
}

// 计算源项目的父目录集合（这些目录作为目标时属于“原地”，禁止）
function _sourceParents(paths) {
    const parents = new Set();
    paths.forEach(p => {
        const i = p.lastIndexOf("/");
        parents.add(i >= 0 ? p.slice(0, i) : "");
    });
    return parents;
}

function openMoveDialog(paths, label) {
    let browsePath = currentPath; // 目标浏览目录，从当前目录开始
    const sourceSet = new Set(paths);
    const sourceParents = _sourceParents(paths);

    const bodyHTML = `
        <div class="move-dialog">
            <div class="move-sub">移动「${escapeHtml(label)}」到：</div>
            <div class="move-pinned" id="movePinned"></div>
            <div class="move-breadcrumb" id="moveBreadcrumb"></div>
            <div class="move-folders" id="moveFolders"></div>
        </div>`;

    const overlay = openModal({
        title: "移动到",
        confirmText: "移动到此处",
        bodyHTML,
        onConfirm: async () => {
            if (sourceParents.has(browsePath)) { showToast("目标与原位置相同，请选择其他目录"); return false; }
            try {
                const res = await fetch(`${CONFIG.API_BASE}/api/action/move`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({paths, target_dir: browsePath})
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { showToast(`移动失败：${data.detail || `HTTP ${res.status}`}`); return false; }
                if (data.errors && data.errors.length) {
                    showAlert(`已移动 ${data.moved} 项`, "以下项未移动：\n" + data.errors.join("\n"));
                }
                clearSelection();
                loadPath(currentPath);
                updateStorage();
                return true;
            } catch (e) {
                showToast(`移动失败：${errMessage(e)}`);
                return false;
            }
        }
    });

    const foldersBox = overlay.querySelector("#moveFolders");
    const bcBox = overlay.querySelector("#moveBreadcrumb");
    const pinnedBox = overlay.querySelector("#movePinned");
    const confirmBtn = overlay.querySelector("#modalConfirmBtn");

    function refreshConfirmState() {
        // 目标为源自身父目录时不可用
        const invalid = sourceParents.has(browsePath);
        confirmBtn.disabled = invalid;
        confirmBtn.title = invalid ? "目标与原位置相同" : "";
    }

    function renderMoveBreadcrumb() {
        let html = `<span class="move-crumb" data-path="">根目录</span>`;
        if (browsePath) {
            let cur = "";
            browsePath.split("/").forEach(p => {
                if (!p) return;
                cur += (cur ? "/" : "") + p;
                html += `<span class="move-crumb-sep">›</span><span class="move-crumb" data-path="${escapeAttr(cur)}">${escapeHtml(p)}</span>`;
            });
        }
        bcBox.innerHTML = html;
        bcBox.querySelectorAll(".move-crumb").forEach(el => {
            el.onclick = () => navigateMove(el.getAttribute("data-path"));
        });
    }

    function renderPinnedChips() {
        if (pinnedPaths.length === 0) { pinnedBox.innerHTML = ""; return; }
        pinnedBox.innerHTML = `<div class="move-pinned-label">快捷位置</div>` +
            pinnedPaths.map(p => `<span class="move-chip" data-path="${escapeAttr(p)}" title="${escapeAttr(p || "根目录")}"><svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>${escapeHtml(pathLabel(p))}</span>`).join("");
        pinnedBox.querySelectorAll(".move-chip").forEach(el => {
            el.onclick = () => navigateMove(el.getAttribute("data-path"));
        });
    }

    async function navigateMove(path) {
        browsePath = path;
        renderMoveBreadcrumb();
        refreshConfirmState();
        foldersBox.innerHTML = `<div class="move-empty">加载中...</div>`;
        try {
            const res = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(path)}`);
            const data = await res.json();
            const dirs = (data.items || []).filter(it => it.is_dir);
            if (dirs.length === 0) {
                foldersBox.innerHTML = `<div class="move-empty">该目录下没有子文件夹</div>`;
                return;
            }
            foldersBox.innerHTML = dirs.map(d => {
                const full = path ? `${path}/${d.name}` : d.name;
                const isSource = sourceSet.has(full); // 不能进入/移入被移动的文件夹自身
                return `<div class="move-folder ${isSource ? "disabled" : ""}" data-path="${escapeAttr(full)}" ${isSource ? "" : `data-nav="1"`}>
                    <svg viewBox="0 0 24 24" height="24" width="24" fill="rgb(68, 71, 70)"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                    <span class="move-folder-name">${escapeHtml(d.name)}</span>
                </div>`;
            }).join("");
            foldersBox.querySelectorAll('.move-folder[data-nav="1"]').forEach(el => {
                el.onclick = () => navigateMove(el.getAttribute("data-path"));
            });
        } catch (e) {
            foldersBox.innerHTML = `<div class="move-empty">加载失败</div>`;
        }
    }

    renderPinnedChips();
    renderMoveBreadcrumb();
    refreshConfirmState();
    navigateMove(browsePath);
}

// ================= 复制链接 =================
async function copyLink() {
    const files = selectedItems.filter(item => !item.is_dir);
    if (files.length === 0) {
        return showToast("请先选择一个文件再复制链接");
    }
    if (files.length > 1) {
        return showToast("一次只能为一个文件生成分享链接，请仅选中一个文件");
    }

    const file = files[0];
    const path = joinPath(currentPath, file.name);

    let data;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/copy_link`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path})
        });
        data = await res.json();
        if (!res.ok) {
            return showAlert("生成链接失败", data.detail || `HTTP ${res.status}`);
        }
    } catch (e) {
        return showAlert("生成链接失败", errMessage(e));
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(data.url);
        } else {
            // 兼容旧浏览器：fallback
            const ta = document.createElement("textarea");
            ta.value = data.url;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        showToast(`链接已复制，1 小时内可使用一次`);
    } catch (e) {
        // 剪贴板不可用时，至少把链接显示给用户
        prompt("请手动复制以下链接（1 小时内有效一次）：", data.url);
    }
    // 复制完成后主动让按钮失焦
    if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
    }
}

let _toastTimer = null;
function showToast(text) {
    let el = document.getElementById("toastBox");
    if (!el) {
        el = document.createElement("div");
        el.id = "toastBox";
        el.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(32,33,36,.92);color:#fff;padding:10px 18px;border-radius:24px;font-size:13px;z-index:2000;opacity:0;transition:opacity .2s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.2);";
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 2200);
}

// ================= 上传窗口折叠 =================
async function toggleUploadWidgetCollapse() {
    const widget = document.getElementById("uploadWidget");
    const btn = document.getElementById("uwCollapseBtn");
    widget.classList.toggle("collapsed");

    // 仅在真正展开/折叠时才需要切换图标 —— 用哪个才请求哪个
    btn.innerHTML = widget.classList.contains("collapsed")
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>';
}

async function closeUploadWidget() {
    if (Object.keys(currentXHRs).length > 0) {
        const ok = await showConfirm("关闭上传窗口", "当前有项目正在上传，关闭窗口将中止传输。确定关闭吗？", { confirmText: "关闭" });
        if (!ok) return;
        cancelAllUploads();
    }
    document.getElementById("uploadWidget").style.display = "none";
    document.getElementById("uwList").innerHTML = "";
}

function cancelAllUploads() {
    // 标记取消:MD5 分片循环与批次循环都会检查该标志并尽快退出
    _uploadsCancelled = true;
    Object.values(currentXHRs).forEach(xhr => xhr.abort());
    currentXHRs = {};
    document.getElementById("uwList").innerHTML = "";
    // 用户主动取消：明确告诉 UI 这是"已完成"态（取消是终态）
    updateUploadTitle("completed");
}

const dropZone = document.getElementById("dropZone");
const overlay = document.getElementById("dropOverlay");

// 拖拽计数器:解决子元素反复触发 dragenter/dragleave 导致的 overlay 闪烁问题。
// 每次 dragenter +1,每次 dragleave -1,只有回到 0 时才真正隐藏遮罩。
let _dragCounter = 0;
function _showDropOverlay() { overlay.classList.add("active"); }
function _hideDropOverlay() { overlay.classList.remove("active"); }
// 仅响应来自操作系统/其它页面的文件拖拽；内部拖拽(文本选中等)不触发上传。
function _isExternalFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
}
["dragenter", "dragover", "dragleave", "drop"].forEach(name => {
    document.body.addEventListener(name, event => {
        if (_isExternalFileDrag(event)) event.preventDefault();
    });
});
dropZone.addEventListener("dragenter", event => {
    if (!_isExternalFileDrag(event)) return;
    _dragCounter++;
    _showDropOverlay();
});
dropZone.addEventListener("dragover", event => {
    if (!_isExternalFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    _showDropOverlay();
});
dropZone.addEventListener("dragleave", () => {
    _dragCounter = Math.max(0, _dragCounter - 1);
    if (!_dragCounter) _hideDropOverlay();
});
dropZone.addEventListener("drop", event => {
    _dragCounter = 0;
    _hideDropOverlay();
    if (!_isExternalFileDrag(event)) return;
    event.preventDefault();
    // 在 drop 同步阶段取得条目及 File 快照，事件返回后拖拽数据仓库不再可读。
    const files = Array.from(event.dataTransfer.files || []);
    const items = Array.from(event.dataTransfer.items || []).filter(item => item.kind === "file").map(item => ({
        entry: (item.getAsEntry || item.webkitGetAsEntry)?.call(item),
        file: item.getAsFile(),
    }));
    handleDroppedUpload(items, files).catch(error => showAlert("上传失败", errMessage(error)));
});

/** 递归展开拖入的目录条目，返回 [{file, relativePath}] 列表。 */
async function collectDroppedFiles(items) {
    const files = [];
    async function visit(entry, parent = "") {
        const relativePath = joinPath(parent, entry.name);
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            files.push({ file, relativePath });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // Chromium 每次只返回一批条目，必须读到空批次才能保证目录完整。
            while (true) {
                const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (!children.length) break;
                for (const child of children) await visit(child, relativePath);
            }
        }
    }
    for (const item of items) {
        if (item.entry) await visit(item.entry);
        else if (item.file) files.push({ file: item.file, relativePath: item.file.name });
    }
    return files;
}

/** 拖放上传入口：含目录时递归收集后走文件夹上传，否则走普通多文件上传。 */
async function handleDroppedUpload(items, fallbackFiles) {
    if (currentView !== "files") {
        switchToFilesView();
        await loadPath("");
    }
    const targetPath = currentPath;
    if (items.some(item => item.entry?.isDirectory)) {
        const files = await collectDroppedFiles(items);
        if (!files.length) { showToast("文件夹中没有可上传的文件"); return; }
        await handleFolderUpload(files, targetPath);
    } else {
        await handleFilesUpload(fallbackFiles);
    }
}

function triggerFileInput() {
    if(currentView !== "files") {
        switchToFilesView();
        loadPath("");  // 上传到根目录
    }
    document.getElementById("fileInput").click();
}

function handleFileSelect(e) {
    // 先把 FileList 快照成数组再清空 input：FileList 是活引用，
    // e.target.value = "" 会立刻把它清空，异步的 handleFilesUpload
    // 在首个 await 恢复后就拿不到任何文件（表现为一直"准备中"不开始上传）。
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    handleFilesUpload(files);
}

// ================= 「新建」下拉菜单 =================
function toggleNewMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById("newMenu");
    if (!menu) return;
    menu.classList.toggle("open");
}

function closeNewMenu() {
    const menu = document.getElementById("newMenu");
    if (menu) menu.classList.remove("open");
}

// 点击页面其它位置时关闭菜单
document.addEventListener("click", (e) => {
    const menu = document.getElementById("newMenu");
    if (!menu || !menu.classList.contains("open")) return;
    if (e.target.closest(".new-btn")) return; // 按钮本身由 toggleNewMenu 处理
    menu.classList.remove("open");
});

// Esc 关闭菜单
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const menu = document.getElementById("newMenu");
        if (menu && menu.classList.contains("open")) {
            menu.classList.remove("open");
        }
    }
});

async function handleNewFolder() {
    closeNewMenu();
    if (currentView !== "files") {
        switchToFilesView();
        await loadPath("");  // 在根目录创建
    }
    const name = await showPrompt("新建文件夹", {
        placeholder: "请输入文件夹名称",
        validate: (v) => {
            if (!v) return "名称不能为空";
            return _validateName(v);
        },
    });
    if (name === null) return;  // 用户取消(空名/非法名由 validate 拦截并 toast)

    const path = joinPath(currentPath, name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/create_folder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return showAlert("创建失败", data.detail || `HTTP ${res.status}`);
        }
        await loadPath(currentPath);
        updateStorage();
    } catch (err) {
        showAlert("创建失败", errMessage(err));
    }
}

function handleUploadFile() {
    closeNewMenu();
    triggerFileInput();
}

function handleUploadFolder() {
    closeNewMenu();
    if (currentView !== "files") {
        switchToFilesView();
        loadPath("");  // 上传到根目录
    }
    // 浏览器原生支持目录选择（Chrome/Edge/Firefox）
    document.getElementById("folderInput").click();
}

async function handleFolderSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // 清空，允许重复选择同一目录
    if (files.length === 0) return;
    if (currentView !== "files") {
        switchToFilesView();
        await loadPath("");  // 上传到根目录
    }

    await handleFolderUpload(files.map(file => ({ file, relativePath: file.webkitRelativePath || file.name })), currentPath);
}

/** 批量上传一组带相对路径的文件到 targetPath 目录。拖拽文件夹与目录选择器共用。 */
async function handleFolderUpload(files, targetPath) {

    const widget = document.getElementById("uploadWidget");
    widget.style.display = "block";
    widget.classList.remove("collapsed");

    _uploadsCancelled = false;
    // 客户端体积预检:超限文件直接标记失败,不在浏览器里白算 MD5
    const cfg = await getServerConfig();
    const sizeLimit = cfg.max_upload_size || 0;
    // 文件夹模式的同名冲突决策:后端对未确认覆盖的同名文件返回 409,
    // 首次遇到时询问一次,决定作用于本批剩余文件(覆盖全部 / 跳过全部)。
    let overwriteAll = null;  // null=未决定, true=覆盖全部, false=跳过全部

    for (let i = 0; i < files.length; i++) {
        if (_uploadsCancelled) break;  // 用户点了"取消",剩余文件不再处理
        const { file, relativePath: relPath } = files[i];
        const fileId = `up_${Date.now()}_${i}_${Math.floor(Math.random() * 1e6)}`;
        _pendingUploadTasks++;

        addUploadTaskUI(fileId, relPath);
        // 关键：这里在 XHR 还没进 currentXHRs 之前就显式声明"正在上传"，
        // 避免 updateUploadTitle 看 currentXHRs.length === 0 而误显示"上传已完成"。
        updateUploadTitle("uploading");

        let md5 = "";
        try {
            if (sizeLimit && file.size > sizeLimit) {
                throw { message: `超过大小限制(${formatBytes(sizeLimit)})` };
            }
            setUploadStatus(fileId, "正在计算 MD5...", 0);
            md5 = await calculateMD5(file);
            await doUploadXHR(fileId, file, md5, relPath, "", overwriteAll === true, targetPath);
        } catch (err) {
            if (err && err.status === 409) {
                // 服务器上已有同名文件:首次询问,之后按既定决策批量处理
                if (overwriteAll === null) {
                    overwriteAll = await askFolderOverwrite();
                }
                if (overwriteAll) {
                    // 覆盖:带显式 overwrite 重试一次
                    try {
                        await doUploadXHR(fileId, file, md5, relPath, "", true, targetPath);
                    } catch (err2) {
                        setUploadStatus(fileId, "失败: " + errMessage(err2), 0, true);
                    }
                } else {
                    setUploadStatus(fileId, "已跳过(已有同名文件)", 0, true);
                }
            } else {
                setUploadStatus(fileId, "失败: " + errMessage(err), 0, true);
            }
        } finally {
            finishUploadTask();
        }
    }
}

/**
 * 文件夹上传遇到服务器同名文件(409)时询问一次,决定作用于整批:
 * resolve(true) = 覆盖全部;resolve(false) = 跳过全部。
 */
function askFolderOverwrite() {
    return new Promise((resolve) => {
        openModal({
            title: "存在同名文件",
            bodyHTML: `<div style="padding: 12px 0; color: var(--text-primary); line-height: 1.6;">服务器上已存在同名文件。<br>本批上传如何处理?</div>`,
            confirmText: "覆盖全部",
            onConfirm: () => { resolve(true); return true; },
            onCancel: () => resolve(false),  // 取消按钮 = 跳过全部
        });
    });
}

async function handleFilesUpload(files) {
    if (files.length === 0) return;
    const widget = document.getElementById("uploadWidget");
    widget.style.display = "block";
    widget.classList.remove("collapsed");

    _uploadsCancelled = false;
    // 客户端体积预检:超限文件直接标记失败,不在浏览器里白算 MD5
    const cfg = await getServerConfig();
    const sizeLimit = cfg.max_upload_size || 0;

    // 上传前先静默刷新一次目录列表，确保冲突检测用的是最新状态（其它 tab / 后台动作可能改动）
    await refreshItemsListForConflict();

    for (let i = 0; i < files.length; i++) {
        if (_uploadsCancelled) break;  // 用户点了"取消",剩余文件不再处理
        let file = files[i];
        let fileId = `up_${Date.now()}_${i}`;

        // 询问同名文件处理：是（覆盖）/ 重命名（自动加 "(1)"）/ 取消
        let decision;
        try {
            decision = await askUploadConflict(file);
        } catch (_) {
            decision = { action: "upload", name: file.name, overwrite: false };
        }

        if (decision.action === "skip") {
            // 用户取消：在上传队列里留一条"已取消"记录，行内给出原文件名
            addUploadTaskUI(fileId, file.name);
            setUploadStatus(fileId, "已取消", 0, true);
            continue;
        }

        // 用 modal 解析后的最终名字作为队列显示名（覆盖 / 重命名后都更新用户可见的标签）
        addUploadTaskUI(fileId, decision.name);
        // 显式声明"正在上传"，XHR 还没创建、currentXHRs 为空也能正确显示
        updateUploadTitle("uploading");

        _pendingUploadTasks++;
        try {
            if (sizeLimit && file.size > sizeLimit) {
                throw { message: `超过大小限制(${formatBytes(sizeLimit)})` };
            }
            setUploadStatus(fileId, "正在计算 MD5...", 0);
            let md5 = await calculateMD5(file);
            await doUploadXHR(fileId, file, md5, "", decision.name, decision.overwrite);
        } catch (err) {
            setUploadStatus(fileId, "失败: " + errMessage(err), 0, true);
        } finally {
            finishUploadTask();
        }
    }
}

// ================= 上传冲突处理（同名文件提示） =================

// 给定一个文件名和当前目录已有名字集合，
// 返回一个不冲突的新名字：在 stem 后追加 "(1)"、"(2)"…直到不与已有名字重复。
// 例如 "foo.txt" + {"foo.txt", "foo (1).txt"} -> "foo (2).txt"
function computeUniqueName(originalName, existingNames) {
    const set = existingNames instanceof Set ? existingNames : new Set(existingNames);
    if (!set.has(originalName)) return originalName;

    // 拆分 stem 和扩展名：以最后一个点为界（隐藏文件如 ".gitignore" 视为无扩展名）
    const dot = originalName.lastIndexOf(".");
    let stem, ext;
    if (dot <= 0) {
        stem = originalName;
        ext = "";
    } else {
        stem = originalName.slice(0, dot);
        ext = originalName.slice(dot); // 包含 "."
    }

    for (let i = 1; i < 10000; i++) {
        const candidate = `${stem} (${i})${ext}`;
        if (!set.has(candidate)) return candidate;
    }
    // 极端情况下 1 万次都没找到唯一名，附加一个时间戳兜底
    return `${stem} (${Date.now()})${ext}`;
}

// 静默地刷新当前目录列表到 currentItemsList，供冲突检测使用。
// 不触发 URL 同步 / breadcrumb 等副作用 —— 仅拉一次 GET /api/files。
async function refreshItemsListForConflict() {
    if (currentView !== "files") return;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(currentPath)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.items)) currentItemsList = data.items;
    } catch (_) { /* 失败时沿用旧列表 */ }
}

// 给定一个待上传文件，返回上传决策：
//   { action: "upload", name, overwrite }
//   { action: "skip" }                     用户取消该文件
// 仅当当前目录已有同名文件时弹出 modal；没冲突时直接放行。
function askUploadConflict(file) {
    const existing = new Set((currentItemsList || []).map(it => it.name));
    if (!existing.has(file.name)) {
        return Promise.resolve({ action: "upload", name: file.name, overwrite: false });
    }

    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2 class="modal-title">文件已存在</h2>
                    <button class="modal-close" title="关闭" data-close>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="#444746"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                <div class="modal-body">
                    <p>当前目录已存在「<strong>${escapeHtml(file.name)}</strong>」文件，是否覆盖现有文件？</p>
                </div>
                <div class="modal-footer">
                    <button class="modal-btn modal-btn-text" data-act="cancel">取消</button>
                    <button class="modal-btn modal-btn-text" data-act="rename">重命名</button>
                    <button class="modal-btn modal-btn-primary" data-act="overwrite">是，覆盖</button>
                </div>
            </div>`;
        // 用专属 id 与其他 modal 区分，避免被 closeModal() 误删
        overlay.id = "conflictModalOverlay";
        document.body.appendChild(overlay);

        // 局部 ESC 处理
        const escHandler = (e) => {
            if (e.key === "Escape") { e.preventDefault(); finish("cancel"); }
        };
        document.addEventListener("keydown", escHandler, true);

        function finish(act) {
            document.removeEventListener("keydown", escHandler, true);
            overlay.remove();
            if (act === "overwrite") {
                resolve({ action: "upload", name: file.name, overwrite: true });
            } else if (act === "rename") {
                const newName = computeUniqueName(file.name, existing);
                resolve({ action: "upload", name: newName, overwrite: false });
            } else {
                resolve({ action: "skip" });
            }
        }

        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) finish("cancel");
            if (e.target.closest("[data-close]")) finish("cancel");
        });
        overlay.querySelector('[data-act="cancel"]').onclick = () => finish("cancel");
        overlay.querySelector('[data-act="rename"]').onclick = () => finish("rename");
        overlay.querySelector('[data-act="overwrite"]').onclick = () => finish("overwrite");
        overlay.querySelector('[data-act="overwrite"]').focus();
    });
}

// ================= MD5 / XHR 上传核心 =================

// ---- 批次状态与服务端配置 ----
//  - _pendingUploadTasks: 本批还有多少任务未到终态。MD5 计算中的任务不在
//    currentXHRs 里,单看 currentXHRs 会把"MD5 中"误判成"全部结束";
//  - _needRefreshAfterUpload: 本批有文件真正上传成功过,整批结束后统一
//    刷新一次目录与存储条(此前每个文件成功都 loadPath 一遍,多文件时列表反复重建);
//  - _uploadsCancelled: 用户点了"取消",MD5 分片循环与批次循环都会检查它。
let _pendingUploadTasks = 0;
let _needRefreshAfterUpload = false;
let _uploadsCancelled = false;

// 服务端只读配置(/api/config),懒加载缓存;拉不到时返回空对象(跳过预检)
let _serverConfig = null;
async function getServerConfig() {
    if (_serverConfig) return _serverConfig;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/config`);
        if (res.ok) _serverConfig = await res.json();
    } catch (_) { /* 网络失败不阻塞上传,只是跳过预检 */ }
    return _serverConfig || {};
}

/** 任务终态统一出口:计数归零时收尾整批(标题 + 单次刷新)。 */
function finishUploadTask() {
    _pendingUploadTasks = Math.max(0, _pendingUploadTasks - 1);
    if (_pendingUploadTasks === 0) {
        updateUploadTitle("completed");
        if (_needRefreshAfterUpload) {
            _needRefreshAfterUpload = false;
            if (currentView === "files") loadPath(currentPath);
            updateStorage();
        }
    }
}

function calculateMD5(file) {
    return new Promise((resolve, reject) => {
        const spark = new SparkMD5.ArrayBuffer();
        const fileReader = new FileReader();
        const chunkSize = 2097152;
        let chunks = Math.ceil(file.size / chunkSize);
        let currentChunk = 0;

        fileReader.onload = function(e) {
            // 用户点了"取消"后立即停止后续分片 -- 大文件的 MD5 可能耗时数分钟
            if (_uploadsCancelled) { reject("已取消"); return; }
            spark.append(e.target.result);
            currentChunk++;
            if (currentChunk < chunks) loadNext();
            else resolve(spark.end());
        };
        fileReader.onerror = () => reject("读取文件失败");

        function loadNext() {
            const start = currentChunk * chunkSize;
            const end = start + chunkSize >= file.size ? file.size : start + chunkSize;
            fileReader.readAsArrayBuffer(file.slice(start, end));
        }
        loadNext();
    });
}

function doUploadXHR(id, file, md5, relativePath = "", resolvedName = "", overwrite = false, targetPath = currentPath) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        currentXHRs[id] = xhr;

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setUploadStatus(id, `正在上传...`, (e.loaded / e.total) * 100);
        };

        xhr.onload = () => {
            delete currentXHRs[id];
            if (xhr.status === 200) {
                setUploadStatus(id, "已完成", 100, false, true);
                // 整批结束后统一刷新一次目录(finishUploadTask),不再每个文件刷一遍
                _needRefreshAfterUpload = true;
                resolve();
            } else {
                // 解析后端 JSON 错误(detail 字段),给用户可读信息而不是原始响应体;
                // 带 status 供调用方识别 409(文件夹上传同名冲突)等场景
                let msg = `HTTP ${xhr.status}`;
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (body && (body.detail || body.error)) msg = body.detail || body.error;
                } catch (_) { /* 响应不是 JSON */ }
                reject({ message: msg, status: xhr.status });
            }
        };

        xhr.onerror = () => { delete currentXHRs[id]; reject({ message: "网络中断" }); };
        xhr.onabort = () => { delete currentXHRs[id]; reject({ message: "已取消" }); };

        const fd = new FormData();
        // 重命名时：用 resolvedName 构造一个新 File 对象，保留原 blob/type。
        // File 对象本身的名字不可改，必须新建。
        const part = (resolvedName && resolvedName !== file.name)
            ? new File([file], resolvedName, { type: file.type, lastModified: file.lastModified })
            : file;
        fd.append("file", part);
        fd.append("path", targetPath);
        fd.append("client_md5", md5);
        if (relativePath) fd.append("relative_path", relativePath);
        if (overwrite) fd.append("overwrite", "1");
        xhr.open("POST", `${CONFIG.API_BASE}/api/upload`);
        xhr.send(fd);
    });
}

async function addUploadTaskUI(id, filename) {
    const list = document.getElementById("uwList");
    const ext = filename.split(".").pop().toLowerCase();
    const html = `
        <div class="uw-item" id="item_${id}">
            <div class="uw-item-left">
                ${getIcon(false, ext)}
                <span class="file-name" style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(filename)}</span>
            </div>
            <div class="uw-item-right" id="status_${id}">
                <svg class="circular-progress" viewBox="0 0 24 24">
                    <circle class="bg" cx="12" cy="12" r="10"></circle>
                    <circle class="value" id="ring_${id}" cx="12" cy="12" r="10"></circle>
                </svg>
            </div>
        </div>`;
    list.insertAdjacentHTML("afterbegin", html);
    // 上传队列里的文件类型图标按需加载
    const node = document.getElementById(`item_${id}`);
    if (node) await renderIcons(node);
}

async function setUploadStatus(id, text, percent, isError=false, isDone=false) {
    const rightBox = document.getElementById(`status_${id}`);
    if(!rightBox) return;

    if (isError) {
        rightBox.innerHTML = `<span style="color:#d93025; font-size:12px;">${escapeHtml(text)}</span>`;
        // 终态收尾(标题/统一刷新)由任务循环的 finally -> finishUploadTask 处理
        return;
    }
    if (isDone) {
        // 成功图标
        rightBox.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#0F9D58"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
        return;
    }

    const ring = document.getElementById(`ring_${id}`);
    if (ring) {
        const offset = 63 - (percent / 100) * 63;
        ring.style.strokeDashoffset = offset;
    }
}

/**
 * 上传窗口标题
 * status 取值：
 *   - 'idle'       准备中（widget 刚打开 / 还没选文件）
 *   - 'uploading'  进行中（MD5 计算中、XHR 飞行中、或仍有未结束的任务）
 *   - 'completed'  全部上传流程结束（成功 / 失败 / 取消之后）
 */
function updateUploadTitle(status) {
    const title = document.getElementById("uwTitle");
    const subbar = document.getElementById("uwSubbar");
    const speed = document.getElementById("uwSpeed");

    if (status === "uploading") {
        title.innerText = "正在上传";
        subbar.style.display = "flex";
        if (speed) speed.innerText = "传输中...";
    } else if (status === "completed") {
        title.innerText = "上传已完成";
        subbar.style.display = "none";
    } else {
        // 'idle' 或未识别值都走"准备上传"，避免空状态被误解为"已完成"
        title.innerText = "准备上传";
        subbar.style.display = "none";
    }
}

/**
 * 任务收尾判定已迁移到 finishUploadTask(基于 _pendingUploadTasks 计数,
 * 覆盖"MD5 计算中"这类不在 currentXHRs 里的任务),此函数保留仅为兼容。
 */
function refreshUploadTitleAfterTaskEnd() {
    if (_pendingUploadTasks === 0) {
        updateUploadTitle("completed");
    }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(timestamp) {
    const d = new Date(timestamp * 1000);
    const now = new Date();
    // 同一年的文件省略年份;跨年文件带年份,避免无法区分
    if (d.getFullYear() === now.getFullYear()) {
        return `${d.getMonth()+1}月${d.getDate()}日`;
    }
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

// 单一事实：根据 isDir + ext 给出图标名（如 "file" / "code" / "md"）。
// 既被 getIcon()（file-list 行首图标）使用，也被 openPreviewModal()
// （预览弹窗左上角 logo）使用，保证两处展示一致。
function iconNameForExt(isDir, ext) {
    if (isDir) return "dir";
    if (["jpg","png","jpeg","gif","webp"].includes(ext)) return "image";
    if (["mp3","wav","flac","ogg","m4a","aac","wma","opus"].includes(ext)) return "audio";
    if (["mp4","mkv","mov","avi","webm","flv","wmv","m4v"].includes(ext)) return "video";
    // Office 文档仅显示专属图标（不提供 Office 在线预览）。
    if (["xls", "xlsx", "xlsm", "ods", "csv"].includes(ext)) return "excel";
    if (["ppt", "pptx", "pptm", "odp"].includes(ext)) return "ppt";
    if (["doc", "docx", "docm", "odt"].includes(ext)) return "word";
    if (ext === "pdf") return "pdf";
    if (["md","markdown"].includes(ext)) return "md";
    if (_CODE_EXTS.has(ext)) return "code";
    if (["zip","rar","7z","tar","gz","bz2","xz","tgz","tbz2","iso","jar","war"].includes(ext)) return "zip";
    return "file";
}

// 返回的是图标占位符，待 renderIcons 异步替换为真正的 SVG。
// 使用 div.icon-wrapper 包裹，SVG 由 CSS 控制在容器内居中缩放，
// 避免直接限制 svg 标签自身的尺寸。
function getIcon(isDir, ext) {
    return `<div class="icon-wrapper" data-icon="${iconNameForExt(isDir, ext)}"></div>`;
}

// 单一来源：判断文件是否可预览以及属于哪一类。
// 与后端 _IMAGE_MIME / _TEXT_EXTS 保持一致。
const _PREVIEW_IMAGE_EXTS = new Set([
    "jpg","jpeg","png","gif","webp","bmp","ico"
]);
// 代码文件扩展名：用于 getIcon() 关联 icons/code.svg。
// 纯文档类型（txt / md / markdown / log / rst）不属于"代码"，仍走各自或默认图标。
const _CODE_EXTS = new Set([
    "js","jsx","ts","tsx","mjs","cjs",
    "py","java","kt","scala","groovy",
    "c","h","cpp","cc","cxx","hpp","hh","cs",
    "go","rs","swift","m","mm","rb","php",
    "sh","bash","zsh","fish","ps1","bat","cmd",
    "sql","lua","pl","r","dart","vue","svelte",
    "css","scss","sass","less","html","htm","xml",
    "json","yml","yaml","toml","ini","env","conf",
    "properties","cfg","gradle","cmake",
]);
// 可预览的文本 = 代码文件 + 纯文本/日志/markdown（含代码但 md 走自己的图标）。
const _PREVIEW_TEXT_EXTS = new Set([
    "txt","md","markdown","log","rst",
    ..._CODE_EXTS,
]);
// 仅收录浏览器原生 <video> 可播放的容器;mkv/avi/flv/wmv 等无法解码,仍走下载。
const _PREVIEW_VIDEO_EXTS = new Set([
    "mp4","m4v","webm","ogv","mov",
]);
const _PREVIEW_AUDIO_EXTS = new Set([
    "mp3","wav","ogg","oga","m4a","aac","opus",
]);
// PDF 用浏览器原生阅读器预览（GET /api/preview?kind=pdf，支持 HTTP Range）。
const _PREVIEW_PDF_EXTS = new Set(["pdf"]);
function canPreview(item, ext) {
    if (!item || item.is_dir) return null;
    if (_PREVIEW_IMAGE_EXTS.has(ext)) return "image";
    if (_PREVIEW_VIDEO_EXTS.has(ext)) return "video";
    if (_PREVIEW_AUDIO_EXTS.has(ext)) return "audio";
    if (_PREVIEW_PDF_EXTS.has(ext)) return "pdf";
    if (_PREVIEW_TEXT_EXTS.has(ext)) return "text";
    return null;
}

async function updateStorage() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/storage`);
        const data = await res.json();
        const fill = data.total > 0 ? (data.used / data.total) * 100 : 0;
        document.getElementById("storageFill").style.width = fill + "%";
        document.getElementById("storageText").innerText = `已使用 ${formatBytes(data.used)}，共 ${formatBytes(data.total)}`;
    } catch (e) { console.error(e); }
}

function updateBreadcrumb() {
    // 主目录(侧边栏「主目录」)高亮:仅 files 视图且 currentPath 为空时
    const navFiles = document.getElementById("navFiles");
    if (navFiles) {
        navFiles.classList.toggle("active", currentView === "files" && currentPath === "");
    }

    const bc = document.getElementById("breadcrumb");
    if (currentView === "trash") {
        bc.innerHTML = `<span class="bc-fixed">回收站</span>`;
        return;
    }
    if (currentView === "pinned") {
        bc.innerHTML = `<span class="bc-fixed">已固定的文件夹</span>`;
        return;
    }
    // files 视图:Home + 每级目录;Home 走 navFilesClick() 回到根目录并擦掉 ?path= / ?view=
    // 路径段导航由 #breadcrumb 容器上的事件委托处理(读取 data-path),
    // 不再内嵌 onclick 字符串 -- 含单引号的目录名曾让 onclick 语法报错。
    let html = `<span onclick="event.stopPropagation(); navFilesClick()">Home</span>`;
    if (currentPath) {
        const parts = currentPath.split("/").filter((p) => p);
        let cur = "";
        parts.forEach((p, idx) => {
            cur += (cur ? "/" : "") + p;
            const isLast = idx === parts.length - 1;
            const cls = isLast ? ' class="bc-current"' : "";
            // 非末段挂 data-path,truncateBreadcrumb 隐藏后能凭此还原出 path,
            // 供省略号下拉菜单做"点击跳转回该目录"。
            const dataPath = isLast ? "" : ` data-path="${escapeAttr(cur)}"`;
            html += `<span class="separator"><svg class="a-s-fa-Ha-pa c-qd" width="24" height="24" viewBox="0 0 24 24" focusable="false" fill="rgb(116,119,117)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg></span><span${cls}${dataPath} title="${escapeAttr(p)}">${escapeHtml(p)}</span>`;
        });
    }
    bc.innerHTML = html;
    window.DriveDrag?.refreshTargets();
    // DOM 渲染后检测溢出并截断;用 rAF 保证拿到正确的 scrollWidth
    requestAnimationFrame(() => truncateBreadcrumb());
}

/**
 * 路径溢出截断:
 *   - 保留 Home 与 current 始终可见
 *   - 从左向右逐对隐藏中间 segment + 它前面的 separator,直到不溢出
 *   - 有任何隐藏则在 Home 后插入 chevron + … 作为占位
 *   - 插入省略号后再检查一次溢出,必要时继续隐藏(省略号本身有宽度)
 *   - 若仍溢出(说明 bc-current 单段就已经超过 path-box),用二分查找直接裁短文本
 * 触发时机:updateBreadcrumb 末尾 / 退出编辑模式 / window resize / 跨断点切换
 *
 * 副作用:把本轮被隐藏的中间段 [{name, path}, ...] 写入模块级 _hiddenSegments,
 * 顺序按"被隐藏的先后" = 从浅到深。省略号下拉菜单在使用时需 reverse() 得到
 * 从深到浅的展示顺序。
 */
let _hiddenSegments = [];  // 被隐藏的中间段元数据,供 bc-ellipsis 下拉菜单使用
function truncateBreadcrumb() {
    const breadcrumb = document.getElementById("breadcrumb");
    const pathBox = document.getElementById("pathBox");
    if (!breadcrumb || !pathBox) return;
    if (pathBox.classList.contains("is-editing")) return;
    if (currentView !== "files") return;

    // 关闭可能残留的下拉菜单,旧引用会随 truncate 失效
    closeBreadcrumbDropdown();
    // 清掉本轮隐藏段列表,后面 hideLeftmostMidPair 会重新填充
    _hiddenSegments = [];

    // 清掉上次插入的省略号 + 占位 separator,恢复子项显示,并把 bc-current 还原成完整文本
    breadcrumb.querySelectorAll(".bc-ellipsis, .separator.is-inserted").forEach((el) => el.remove());
    Array.from(breadcrumb.children).forEach((el) => {
        el.style.display = "";
        el.classList.remove("is-inserted");
    });
    const bcCurrent = breadcrumb.querySelector(".bc-current");
    if (bcCurrent && bcCurrent.dataset.fullText != null) {
        bcCurrent.textContent = bcCurrent.dataset.fullText;
    }

    if (breadcrumb.children.length <= 1) return;

    // current 段索引 = 最后一个非 separator 子元素
    const children = Array.from(breadcrumb.children);
    let currentIdx = -1;
    for (let i = children.length - 1; i >= 0; i--) {
        if (!children[i].classList.contains("separator")) {
            currentIdx = i;
            break;
        }
    }
    if (currentIdx <= 1) return;

    const isOverflowing = () => breadcrumb.scrollWidth > breadcrumb.clientWidth + 1;

    // 隐藏最靠左尚未隐藏的中间 segment 与它前面的 separator
    const hideLeftmostMidPair = () => {
        for (let i = 1; i < currentIdx; i++) {
            const child = children[i];
            if (child.classList.contains("separator")) continue;
            if (child.style.display === "none") continue;
            children[i - 1].style.display = "none";
            child.style.display = "none";
            // 记录被隐藏的中间段:name 是该段中文名,path 是从根到该段的完整相对路径
            // 顺序 = "被隐藏的先后" = 从浅到深(A→B→C),下拉菜单展示时需 reverse
            _hiddenSegments.push({
                name: child.textContent || "",
                path: child.getAttribute("data-path") || "",
            });
            return true;
        }
        return false;
    };

    // 第一轮:隐藏中间段到不溢出
    while (isOverflowing()) {
        if (!hideLeftmostMidPair()) break;
        void breadcrumb.offsetWidth;
    }

    // 统计被隐藏的中间 segment 数量
    let hiddenCount = 0;
    for (let i = 1; i < currentIdx; i++) {
        if (!children[i].classList.contains("separator") &&
            children[i].style.display === "none") {
            hiddenCount++;
        }
    }

    // 有任何隐藏则在 Home 后插入 chevron + 省略号
    if (hiddenCount > 0) {
        const sep = document.createElement("span");
        sep.className = "separator is-inserted";
        sep.innerHTML = `<svg class="a-s-fa-Ha-pa c-qd" width="24" height="24" viewBox="0 0 24 24" focusable="false" fill="rgb(116,119,117)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>`;
        const ell = document.createElement("span");
        ell.className = "bc-ellipsis";
        ell.textContent = "…";
        ell.setAttribute("role", "button");
        ell.setAttribute("aria-label", "显示被隐藏的中间目录");
        ell.setAttribute("aria-haspopup", "menu");
        ell.setAttribute("aria-expanded", "false");
        ell.setAttribute("tabindex", "0");
        ell.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleBreadcrumbDropdown(ell);
        });
        ell.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleBreadcrumbDropdown(ell);
            }
        });
        children[0].after(sep);
        sep.after(ell);
    }

    // 省略号插入后再检查一次溢出,必要时继续隐藏中间段
    while (isOverflowing()) {
        if (!hideLeftmostMidPair()) break;
        void breadcrumb.offsetWidth;
    }

    // 兜底:即使把全部中间段都隐藏仍溢出,说明 bc-current 单段就超出 path-box,
    // 此时直接裁短 bc-current 的文本(用二分找最长能 fit 的前缀)
    trimBcCurrentToFit(breadcrumb, bcCurrent, isOverflowing);
}

/**
 * 直接裁短 bc-current 的文本内容,作为 flex-shrink + text-overflow:ellipsis 之外的兜底。
 * 缓存原始文本到 dataset.fullText,以便 truncateBreadcrumb 每次重算时能恢复。
 */
function trimBcCurrentToFit(breadcrumb, bcCurrent, isOverflowing) {
    if (!bcCurrent) return;

    if (bcCurrent.dataset.fullText == null) {
        bcCurrent.dataset.fullText = bcCurrent.getAttribute("title") || bcCurrent.textContent;
    }
    const fullText = bcCurrent.dataset.fullText;
    if (!fullText) return;

    if (!isOverflowing()) {
        if (bcCurrent.textContent !== fullText) bcCurrent.textContent = fullText;
        return;
    }

    // 二分查找最长能 fit 的前缀(加上省略号字符)
    let lo = 0, hi = fullText.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        bcCurrent.textContent = fullText.slice(0, mid) + "…";
        void breadcrumb.offsetWidth;
        if (isOverflowing()) {
            hi = mid - 1;
        } else {
            lo = mid;
        }
    }
    bcCurrent.textContent = lo > 0 ? fullText.slice(0, lo) + "…" : "…";
}

// ================= 面包屑省略号：下拉菜单 =================
// 当中间段被 truncateBreadcrumb 隐藏时,点击省略号会弹出菜单,按"从深到浅"的
// 顺序列出所有被隐藏的目录,点击任一项直接调 loadPath 跳转(走与现有路径导航
// 完全一致的路由逻辑:history.pushState + 后端拉取 + 面包屑重渲染)。

let _bcDropdownEl = null;     // 当前已挂载的下拉 DOM(单例,避免重复创建)
let _bcDropdownTrigger = null; // 触发该下拉的 .bc-ellipsis,用于 close 时同步 aria-expanded

/**
 * 切换省略号下拉:已开则关,未开则开。
 * 同时维护 aria-expanded,与全局点击关闭逻辑配合。
 */
function toggleBreadcrumbDropdown(triggerEl) {
    if (_bcDropdownEl && triggerEl && triggerEl === _bcDropdownTrigger) {
        closeBreadcrumbDropdown();
        return;
    }
    // 已有别的实例(理论上 truncateBreadcrumb 已 close 过,这里兜底)
    if (_bcDropdownEl) closeBreadcrumbDropdown();
    openBreadcrumbDropdown(triggerEl);
}

/**
 * 真正创建并定位下拉菜单:
 *   - 菜单内容 = _hiddenSegments 的反转(从深到浅)
 *   - 定位策略:absolute 相对 .path-box;优先放在省略号正下方,空间不足则翻到上方
 *   - 横向夹紧到 .path-box 范围内,离边缘留 4px 余量
 */
function openBreadcrumbDropdown(triggerEl) {
    if (!triggerEl) return;
    if (!_hiddenSegments || _hiddenSegments.length === 0) return;

    const pathBox = document.getElementById("pathBox");
    if (!pathBox) return;

    // 菜单:绝对定位,挂在 pathBox 下而非 breadcrumb,避免被 breadcrumb 的 overflow:hidden 裁掉
    const menu = document.createElement("div");
    menu.className = "bc-ellipsis-dropdown";
    menu.setAttribute("role", "menu");

    // 反转 _hiddenSegments:truncate 顺序是 A→B→C (A最浅),展示要求是从深到浅,即 C→B→A
    const reversed = _hiddenSegments.slice().reverse();
    reversed.forEach((seg, idx) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "bc-ellipsis-dropdown-item";
        item.setAttribute("role", "menuitem");
        item.setAttribute("data-path", seg.path || "");
        item.setAttribute("title", seg.path || seg.name || "");
        // 路径过长时截短显示,完整路径放 title 提示
        const displayName = seg.name || seg.path || "(未命名)";
        item.innerHTML = `
            <svg class="bc-dd-icon" width="18" height="18" viewBox="0 0 24 24" focusable="false" fill="currentColor">
                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
            <span class="bc-dd-name">${escapeHtml(displayName)}</span>
        `;
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            navigateToBreadcrumbSegment(seg.path);
        });
        menu.appendChild(item);
    });

    // 挂到 pathBox 里(pathBox 本身需 position:relative,见 CSS)
    pathBox.appendChild(menu);
    _bcDropdownEl = menu;
    _bcDropdownTrigger = triggerEl;
    triggerEl.setAttribute("aria-expanded", "true");
    triggerEl.classList.add("is-open");

    // 定位:获取 trigger 与 pathBox 的位置,优先放在 trigger 正下方,溢出翻到上方
    positionBreadcrumbDropdown(triggerEl, menu);

    // 入场动画(下一帧加 class 触发 transition)
    requestAnimationFrame(() => menu.classList.add("visible"));
}

/**
 * 定位下拉菜单:相对 path-box 坐标,把菜单放到省略号正下方。
 * 若下方空间不够则翻到上方;横向夹紧到 pathBox 内。
 */
function positionBreadcrumbDropdown(triggerEl, menu) {
    const pathBox = document.getElementById("pathBox");
    if (!pathBox || !triggerEl || !menu) return;
    const pbRect = pathBox.getBoundingClientRect();
    const trRect = triggerEl.getBoundingClientRect();

    // 先以 visible 内容拿到高度(menu 此时还未 visible,需先短暂显示测量)
    const prevVisibility = menu.style.visibility;
    menu.style.visibility = "hidden";
    menu.classList.add("visible"); // 强制可视以取尺寸
    const menuRect = menu.getBoundingClientRect();
    menu.classList.remove("visible");
    menu.style.visibility = prevVisibility;

    const GAP = 4;
    const PAD = 4;  // 离 path-box 边缘留 4px

    // 相对 pathBox 的坐标
    let top = trRect.bottom - pbRect.top + GAP;
    const spaceBelow = pbRect.bottom - trRect.bottom;
    if (spaceBelow < menuRect.height + GAP + PAD && trRect.top - pbRect.top > menuRect.height + GAP + PAD) {
        // 翻到上方
        top = trRect.top - pbRect.top - menuRect.height - GAP;
    }
    let left = trRect.left - pbRect.left;
    const maxLeft = pbRect.width - menuRect.width - PAD;
    if (left > maxLeft) left = Math.max(PAD, maxLeft);
    if (left < PAD) left = PAD;

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.maxWidth = `${pbRect.width - PAD * 2}px`;
}

/**
 * 关闭下拉:恢复 aria-expanded、清理 DOM、解绑 trigger 上的 is-open 标记。
 * 幂等,反复调用安全。
 */
function closeBreadcrumbDropdown() {
    if (_bcDropdownEl) {
        _bcDropdownEl.remove();
        _bcDropdownEl = null;
    }
    if (_bcDropdownTrigger) {
        _bcDropdownTrigger.setAttribute("aria-expanded", "false");
        _bcDropdownTrigger.classList.remove("is-open");
        _bcDropdownTrigger = null;
    }
}

/**
 * 点击下拉菜单项:关闭菜单,然后调 loadPath(path) 跳转。
 * loadPath 内部已经会处理 history.pushState + 后端拉取 + 面包屑重渲染,
 * 与用户手动点击面包屑中段 / 双击文件夹行的体验完全一致。
 */
function navigateToBreadcrumbSegment(path) {
    closeBreadcrumbDropdown();
    if (!path) return;
    // 与面包屑非末段 click / 双击文件夹行走的同一条路径
    loadPath(path);
}

// ================= 路径框：点击空白处进入"地址栏编辑"模式 =================
/**
 * 把 path-box 切换到编辑模式：隐藏面包屑、显示真实路径输入框并全选文字。
 * 仅在 files 视图生效；pinned/trash 视图下路径不可编辑。
 */
function enterPathEditMode() {
    if (currentView !== "files") return;
    const pathBox = document.getElementById("pathBox");
    const breadcrumb = document.getElementById("breadcrumb");
    const pathInput = document.getElementById("pathInput");
    if (!pathBox || !breadcrumb || !pathInput) return;

    // 已经在编辑模式，直接退出（兜底，正常情况 onclick 不会重复触发）
    if (pathBox.classList.contains("is-editing")) return;

    pathBox.classList.add("is-editing");
    breadcrumb.style.display = "none";
    pathInput.style.display = "block";
    pathInput.value = currentRawPath || "";
    // 选中所有文字，方便用户直接覆盖
    pathInput.focus();
    pathInput.select();
}

function exitPathEditMode() {
    const pathBox = document.getElementById("pathBox");
    const breadcrumb = document.getElementById("breadcrumb");
    const pathInput = document.getElementById("pathInput");
    if (!pathBox || !breadcrumb || !pathInput) return;

    // 若已经在退出状态（双触发），无需重复操作
    if (!pathBox.classList.contains("is-editing")) return;

    pathBox.classList.remove("is-editing");
    pathInput.style.display = "none";
    breadcrumb.style.display = "flex";
    // 编辑模式下隐藏了面包屑,刚显示出来需要重新检测溢出
    requestAnimationFrame(() => truncateBreadcrumb());
}

/**
 * 输入框按键：Enter 提交跳转，Esc 取消。
 */
function handlePathKeydown(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        const newPath = (event.target.value || "").trim();
        // 退出编辑模式优先，避免 loadPath 再次触发 UI 更新时与正在隐藏的 input 冲突
        exitPathEditMode();
        loadPath(newPath);
    } else if (event.key === "Escape") {
        event.preventDefault();
        exitPathEditMode();
    }
}

/**
 * 搜索:同时支持纯文本子串匹配和简单 glob：
 *  - 输入含 * 或 ? 时，按 glob 解析为正则（* 匹配任意串、? 匹配单个字符）
 *    例如 *.json -> /^.*\.json$/i
 *  - 否则按大小写不敏感的子串匹配
 *
 * 过滤作用于数据源(currentItemsList -> displayedItems)后整体重渲染,
 * 而不是操作 DOM 行:虚拟滚动(>=200 条只渲染可见行)场景下,
 * 遍历 DOM 做 display:none 既搜不到未渲染的行,滚动重渲染后结果还会丢失。
 */
function buildSearchMatcher(raw) {
    if (raw.includes("*") || raw.includes("?")) {
        // 字符级把 glob 转成正则：
        //   * -> .*   ? -> .   正则元字符自动转义
        let pattern = "";
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (ch === "*") pattern += ".*";
            else if (ch === "?") pattern += ".";
            else if (/[.+^${}()|[\]\\]/.test(ch)) pattern += "\\" + ch;
            else pattern += ch;
        }
        // 整名匹配（^/$ 锚定），符合 glob 语义
        return new RegExp("^" + pattern + "$", "i");
    }
    // 纯文本：大小写不敏感子串
    const needle = raw.toLowerCase();
    return { test: (s) => String(s).toLowerCase().includes(needle) };
}

/** 按当前 searchQuery 重建 displayedItems;无搜索时直接复用 currentItemsList 引用。 */
function rebuildDisplayedItems() {
    if (!searchQuery) {
        displayedItems = currentItemsList;
        return;
    }
    const matcher = buildSearchMatcher(searchQuery);
    displayedItems = currentItemsList.filter(
        it => it && matcher.test(String(it.name || "")),
    );
}

function handleSearch() {
    if (window.DriveDrag?.isBusy()) { document.getElementById("searchInput").value = searchQuery; return; }
    const raw = document.getElementById("searchInput").value.trim();
    searchQuery = raw;
    renderTableBody();
}
