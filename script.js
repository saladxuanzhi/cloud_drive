const CONFIG = {
    API_BASE: "",
    // 直接走当前 origin 即可,不再单独维护 DIRECT_TRANSFER_URL
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

    const p = fetch(`/api/icon/${encodeURIComponent(name)}`)
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
})();

window.addEventListener("DOMContentLoaded", () => {
    // 启动期异常不再静默:开发阶段如果脚本本身有错,直接弹出提示
    try {
        // 首屏静态图标已内联到 HTML，无需 renderIcons(document.body)；
        // 这里只处理动态按需加载（文件类型 dir/file/image、对话框 rename 等）。
        updateStorage();
        loadPinned();
        switchToFilesView();
        loadPath("");
    } catch (e) {
        console.error("[init]", e);
        alert("页面初始化失败:" + (e && e.message ? e.message : e));
    }
});

// 全局错误兜底:script 错误不再只丢到 console,屏幕也能看到
window.addEventListener("error", (e) => {
    if (e && e.error) {
        console.error("[window.error]", e.error);
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

// 侧边栏「主目录」点击：切到 files 视图并回到 Home。
// 当处于 files 视图且已在 Home 时跳过 loadPath 避免无谓请求；
// 处于 pinned/trash 等非 files 视图或子目录时，强制 loadPath("") 刷新表格内容。
function navFilesClick() {
    const wasNonFilesView = currentView !== "files";
    switchToFilesView();
    if (wasNonFilesView || currentPath !== "") {
        loadPath("");
    }
}

function switchToPinnedView() {
    currentView = "pinned";
    document.body.setAttribute("data-view", "pinned");
    document.getElementById("navFiles").classList.remove("active");
    document.getElementById("navPinned").classList.add("active");
    document.getElementById("navTrash").classList.remove("active");
    // pinned 视图下不需要在面包屑尾部再"固定当前目录"按钮
    document.getElementById("bcPinBtn").style.display = "none";
    clearSelection();
    renderPinnedMain();
}

function switchToTrashView() {
    currentView = "trash";
    document.body.setAttribute("data-view", "trash");
    document.getElementById("navFiles").classList.remove("active");
    document.getElementById("navPinned").classList.remove("active");
    document.getElementById("navTrash").classList.add("active");
    // 回收站视图下固定按钮无意义，隐藏
    document.getElementById("bcPinBtn").style.display = "none";
    clearSelection();
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
    } catch (e) {
        // 主动取消的请求不报错
        if (e && e.name === 'AbortError') return;
        console.error("[loadPath]", e);
        alert("加载目录失败:" + (e && e.message ? e.message : e));
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
    const item = currentItemsList[idx];
    if (!item || !item.is_dir) return;
    switchToFilesView();
    loadPath(item.full_path);
}

async function loadTrash() {
    updateBreadcrumb();
    clearSelection();
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/trash`);
        const data = await res.json();
        currentItemsList = data.items;
        renderTableHeader();
        renderTableBody();
    } catch (e) { alert("加载回收站失败"); }
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
 * 对当前 currentItemsList 原地排序：
 * - 文件夹始终排在文件前（不受字段/方向影响）；
 * - 同类型内按 sortField（name/modified/size）排序；
 * - sortDirection 控制升/降序；"name" 用中文 localeCompare 以正确处理中文文件名。
 */
function sortItems() {
    if (!currentItemsList || currentItemsList.length === 0) return;
    const dir = sortDirection === "asc" ? 1 : -1;
    currentItemsList.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        let cmp = 0;
        if (sortField === "name") {
            cmp = String(a.name || "").localeCompare(
                String(b.name || ""), 'zh-CN', { sensitivity: 'base' });
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
                <th style="width: 140px;"></th>
            </tr>
        `;
    } else if (currentView === "pinned") {
        head.innerHTML = `
            <tr>
                ${sortableTh("名称", "name")}
                <th>完整路径</th>
                <th style="width: 140px;"></th>
            </tr>
        `;
    } else {
        head.innerHTML = `
            <tr>
                ${sortableTh("名称", "name")}
                <th>原位置</th>
                ${sortableTh("删除时间", "modified")}
                ${sortableTh("大小", "size")}
                <th style="width: 100px;">操作</th>
            </tr>
        `;
    }
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
    const total = currentItemsList.length;
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
    const totalH = currentItemsList.length * rowH;
    spacer.firstElementChild.style.height = totalH + "px";

    const old = tbody.querySelectorAll("tr:not(.vscroll-spacer)");
    old.forEach(tr => tr.remove());

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const item = currentItemsList[i];
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
function _buildTableRow(item, index) {
    const ext = item.name.split(".").pop().toLowerCase();
    const tr = document.createElement("tr");
    tr.setAttribute("data-index", index);

    if (currentView === "files" && !item.is_dir) {
        const previewKind = canPreview(item, ext);
        if (previewKind) {
            tr.ondblclick = () => previewFile(item, previewKind);
            tr.style.cursor = "pointer";
        }
    }
    if (currentView === "files" && item.is_dir) {
        tr.ondblclick = () => loadPath(joinPath(currentPath, item.name));
    }
    if (currentView === "pinned") {
        tr.ondblclick = () => openPinnedItem(index);
        tr.style.cursor = "pointer";
    }

    let metaCells = "";
    let actionCell = "";

    if (currentView === "files") {
        metaCells = `<td>${formatDate(item.modified)}</td><td>${formatBytes(item.size)}</td>`;
        actionCell = `
            <td>
                <div style="display:flex;">
                    <div class="action-btn" data-tooltip="重命名" onclick="event.stopPropagation(); openRenameDialog(${index})">
                        <svg height="20" viewBox="0 -960 960 960" width="20" focusable="false" fill="currentColor"><path d="M351-144l144-144h369v144H351Zm-183-72h51l375-375-51-51-375 375v51Zm-72 72v-153l498-498q11-11 23.84-16 12.83-5 27-5 14.16 0 27.16 5t24 16l51 51q11 11 16 24t5 26.54q0 14.45-5.02 27.54T747-642L249-144H96Zm600-549-51-51 51 51Zm-127.95 76.95L543-642l51 51-25.95-25.05Z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="移动" onclick="event.stopPropagation(); moveSingle('${escapeAttr(item.name)}')">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10zm-8.01-9l-1.41 1.41L12.16 12H8v2h4.16l-1.59 1.59L11.99 17 16 13.01 11.99 9z"/></svg>
                    </div>
                    ${!item.is_dir ? `<div class="action-btn" data-tooltip="下载" onclick="event.stopPropagation(); downloadFile('${escapeAttr(item.name)}')">
                        <svg height="20" width="20" viewBox="0 -960 960 960" fill="#444746"><path d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"/></svg>
                    </div>` : `<div class="action-btn" data-tooltip="下载文件夹" onclick="event.stopPropagation(); downloadFolder('${escapeAttr(item.name)}')">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                    </div>`}
                    <div class="action-btn" data-tooltip="移至回收站" onclick="event.stopPropagation(); trashSingle('${escapeAttr(item.name)}')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9zm4 0h2v9h-2z"/></svg>
                    </div>
                </div>
            </td>`;
    } else if (currentView === "pinned") {
        metaCells = `<td style="color:var(--text-muted); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-tooltip="${escapeAttr(item.full_path || "根目录")}">${escapeHtml(item.full_path || "根目录")}</td>`;
        actionCell = `
            <td>
                <div style="display:flex;">
                    <div class="action-btn" data-tooltip="进入目录" onclick="event.stopPropagation(); openPinnedItem(${index})">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="下载" onclick="event.stopPropagation(); downloadFolder('${escapeAttr(item.full_path)}')">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="取消固定" onclick="event.stopPropagation(); unpinFromMain(${index})">
                        <svg width="20" width="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                    </div>
                </div>
            </td>`;
    } else {
        metaCells = `
            <td style="color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-tooltip="${escapeAttr(item.original_path)}">${escapeHtml(item.original_path)}</td>
            <td>${formatDate(item.deleted_at)}</td>
            <td>${formatBytes(item.size)}</td>`;
        actionCell = `
            <td>
                <div style="display:flex;">
                    <div class="action-btn" data-tooltip="还原" onclick="event.stopPropagation(); restoreSingle('${escapeAttr(item.trashed_name)}')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="#444746"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                    </div>
                    <div class="action-btn" data-tooltip="永久删除" onclick="event.stopPropagation(); deletePermSingle('${escapeAttr(item.trashed_name)}')">
                        <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M9.4 16.5l2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6L16 9.9l-1.4-1.4-2.6 2.6-2.6-2.6L8 9.9l2.6 2.6L8 15.1ZM7 21q-.825 0-1.412-.587Q5 19.825 5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413Q17.825 21 17 21ZM17 6H7v13h10ZM7 6v13Z"/></svg>
                    </div>
                </div>
            </td>`;
    }

    tr.innerHTML = `
        <td><div class="file-name-cell" data-name-cell="${index}">${getIcon(item.is_dir, ext)}<span style="font-weight: 500;">${escapeHtml(item.name)}</span></div></td>
        ${metaCells}
        ${actionCell}
    `;
    tr.onclick = (e) => handleRowClick(e, index);
    return tr;
}

function renderTableBody() {
    const tbody = document.getElementById("fileTableBody");
    tbody.innerHTML = "";

    // 始终按当前 sortField/sortDirection 排序后再渲染
    sortItems();

    if (currentItemsList.length === 0) {
        const colCount = currentView === "files" ? 4 : (currentView === "pinned" ? 3 : 5);
        const emptyText = currentView === "pinned" ? "尚未固定任何文件夹" : "空空如也";
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding:32px; color:#aaa;">${emptyText}</td></tr>`;
        _vscrollReset();
        return;
    }

    if (currentItemsList.length >= VSCROLL_THRESHOLD) {
        // 启用虚拟滚动:先临时放一行用于测行高,再清空正式渲染
        const probe = _buildTableRow(currentItemsList[0], 0);
        tbody.appendChild(probe);
        _vscrollRowHeight = Math.max(1, _vscrollMeasureRowHeight());
        _vscrollAttach();
        _vscrollReset();
        const container = _vscrollGetContainer();
        const viewport = (container && container.clientHeight) || 600;
        const start = 0;
        const end = Math.min(
            currentItemsList.length,
            Math.ceil(viewport / _vscrollRowHeight) + VSCROLL_BUFFER * 2,
        );
        _vscrollLastRange = { start, end };
        _vscrollRenderRows(start, end, _vscrollRowHeight);
    } else {
        // 普通全量渲染
        _vscrollReset();
        const frag = document.createDocumentFragment();
        currentItemsList.forEach((item, index) => {
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
    const item = currentItemsList[idx];
    if (!item) return;

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
            const it = currentItemsList[i];
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
        const item = currentItemsList[idx];
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
            document.getElementById("selDownload").style.display = "block";
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

// Esc 清空选择（重命名输入框里的 Esc 由各自监听器自行处理，不冒泡到这里）
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.tagName !== "INPUT") {
        clearSelection();
    }
});

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
    if (!currentItemsList || currentItemsList.length === 0) return;

    e.preventDefault();
    // 把当前列表全部置入 selectedItems；保持顺序以便后续范围选择行为一致
    selectedItems = currentItemsList.slice();
    lastSelectedIndex = currentItemsList.length - 1;
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
            return alert("删除失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert("部分项目未删除：\n" + data.errors.join("\n"));
        }
    } catch (e) {
        return alert("删除失败：" + e.message);
    }
    loadPath(currentPath);
    updateStorage();
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
            return alert("批量删除失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert(`已删除 ${data.count} 项。\n以下项未删除：\n` + data.errors.join("\n"));
        }
        clearSelection();
        loadPath(currentPath);
        updateStorage();
    } catch (e) { alert("批量删除失败：" + e.message); }
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
            return alert("还原失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert("部分项目未还原：\n" + data.errors.join("\n"));
        }
    } catch (e) {
        return alert("还原失败：" + e.message);
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
            return alert("批量恢复失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert(`已恢复 ${data.count} 项。\n以下项未恢复：\n` + data.errors.join("\n"));
        }
        clearSelection();
        loadTrash();
        updateStorage();
    } catch (e) { alert("批量恢复失败：" + e.message); }
}

async function deletePermSingle(trashedName) {
    if (!confirm("确定要永久删除该项内容吗？此操作不可逆。")) return;
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_delete_permanently`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: [trashedName]})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return alert("永久删除失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert("部分项目未删除：\n" + data.errors.join("\n"));
        }
    } catch (e) {
        return alert("永久删除失败：" + e.message);
    }
    loadTrash();
    updateStorage();
}

async function bulkDeletePermanently() {
    if (selectedItems.length === 0) return;
    if (!confirm(`确定要永久删除选中的 ${selectedItems.length} 项内容吗？此操作不可恢复。`)) return;
    const names = selectedItems.map(item => item.trashed_name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_delete_permanently`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trashed_names: names})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return alert("批量永久删除失败：" + (data.detail || `HTTP ${res.status}`));
        }
        if (data.errors && data.errors.length) {
            alert(`已删除 ${data.count} 项。\n以下项未删除：\n` + data.errors.join("\n"));
        }
        clearSelection();
        loadTrash();
        updateStorage();
    } catch (e) { alert("批量永久删除失败：" + e.message); }
}

async function bulkDownload() {
    if (selectedItems.length === 0) return;
    for (const item of selectedItems) {
        if (item.is_dir) {
            await downloadFolder(item.name);
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
    a.href = `/api/download/file?ticket=${data.ticket}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function downloadFolder(foldername) {
    const p = joinPath(currentPath, foldername);
    let res;
    try {
        res = await fetch(`${CONFIG.API_BASE}/api/download/folder/ticket`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: p})
        });
    } catch (e) {
        return showAlert("下载失败", "网络错误：" + e.message);
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.detail || data.error || `HTTP ${res.status}`;
        showAlert("文件夹下载失败", msg);
        return;
    }

    const data = await res.json();
    const a = document.createElement("a");
    a.href = `/api/download/file?ticket=${data.ticket}`;
    a.download = data.filename || `${foldername}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * 通用提示弹窗（无取消逻辑、仅确定按钮）。
 * 复用 openModal，保持样式与已有弹窗一致。
 */
function showAlert(title, message) {
    openModal({
        title,
        bodyHTML: `<div style="padding: 12px 0; color: var(--text-primary); line-height: 1.6;">${escapeHtml(message)}</div>`,
        confirmText: "确定",
        onConfirm: () => true,
    });
}

// ================= 通用弹窗基础设施 =================
let _modalKeydownHandler = null;

function closeModal() {
    const overlay = document.getElementById("modalOverlay");
    if (overlay) overlay.remove();
    if (_modalKeydownHandler) {
        document.removeEventListener("keydown", _modalKeydownHandler, true);
        _modalKeydownHandler = null;
    }
}

// ================= 预览（全页遮罩 + 中央白色画布） =================
let _previewKeydownHandler = null;
let _previewWheelHandler = null;
let _previewZoom = 1;

function closePreviewModal() {
    const overlay = document.getElementById("previewOverlay");
    if (overlay) overlay.remove();
    if (_previewKeydownHandler) {
        document.removeEventListener("keydown", _previewKeydownHandler, true);
        _previewKeydownHandler = null;
    }
    if (_previewWheelHandler) {
        // handler 绑在 stage 上，stage 会随 overlay 一起被移除，无需解绑
        _previewWheelHandler = null;
    }
    _previewZoom = 1;
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
 * 打开文件预览。kind=image 时 src 是后端 URL，浏览器直接渲染；
 * kind=text 时由调用方预先 fetch 拿到 content 再传入。
 * iconName 决定左上角 logo（默认 image / file）。
 */
function openPreviewModal({ title, kind, src, content, error, iconName, ext }) {
    closePreviewModal();
    // 顺带关掉可能残留的重命名/移动弹窗
    closeModal();

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
            <div class="preview-paper" id="previewPaper">
                <div class="preview-content" id="previewContent"></div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const stage = overlay.querySelector("#previewStage");
    const contentEl = overlay.querySelector("#previewContent");
    overlay.querySelector(".preview-close").onclick = closePreviewModal;

    // 点击舞台空白处（不在 paper 上）关闭
    overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay || e.target === stage) closePreviewModal();
    });

    // ESC 关闭（capture 阶段，与 openModal 同样的优先级）
    _previewKeydownHandler = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePreviewModal(); }
    };
    document.addEventListener("keydown", _previewKeydownHandler, true);

    _setPreviewZoom(1);

    if (error) {
        contentEl.innerHTML = `<div class="preview-message preview-error">${escapeHtml(error)}</div>`;
        return;
    }

    if (kind === "image") {
        contentEl.innerHTML = `<div class="preview-loading">加载中…</div>`;
        const img = new Image();
        img.alt = title;
        img.className = "preview-image";
        img.onload = () => {
            contentEl.innerHTML = "";
            contentEl.appendChild(img);
            _setupImageZoom(stage);
        };
        img.onerror = () => {
            contentEl.innerHTML = `<div class="preview-message preview-error">无法加载图片（文件可能已损坏）</div>`;
        };
        img.src = src;
        return;
    }

    if (kind === "text") {
        if (content !== undefined) {
            renderPreviewText(contentEl, content, { ext, isMarkdown });
        }
    }
}

/**
 * 把文本内容写入预览区：
 *   - md/markdown：默认渲染为 HTML（marked.js），切换按钮可在 渲染 ↔ 原文 之间切
 *   - 其它文本（含代码文件）：保持纯文本展示，不做语法高亮
 */
function renderPreviewText(contentEl, raw, { ext, isMarkdown }) {
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
            // 必须用 DOMPurify 消毒 marked 的输出,否则 `<img onerror=...>` 等可触发 XSS
            const html = typeof DOMPurify !== "undefined"
                ? DOMPurify.sanitize(marked.parse(raw), {
                    ALLOWED_TAGS: [
                        "a","b","i","em","strong","code","pre","blockquote",
                        "ul","ol","li","p","br","hr","h1","h2","h3","h4","h5","h6",
                        "img","table","thead","tbody","tr","th","td","del","sup","sub",
                        "span","div",
                    ],
                    ALLOWED_ATTR: ["href","title","alt","src","colspan","rowspan"],
                    ALLOW_DATA_ATTR: false,
                })
                : marked.parse(raw);  // DOMPurify 未加载时回退(理论上 CDN 失败)
            contentEl.innerHTML = "";
            const wrap = document.createElement("div");
            wrap.className = "preview-md";
            wrap.innerHTML = html;
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
 * - text : 先 fetch JSON，再把 content 注入 <pre>
 */
async function previewFile(item, kind) {
    const relPath = joinPath(currentPath, item.name);
    const url = `${CONFIG.API_BASE}/api/preview?path=${encodeURIComponent(relPath)}&kind=${kind}`;
    const ext = item.name.split(".").pop().toLowerCase();

    if (kind === "image") {
        openPreviewModal({ title: item.name, kind: "image", src: url, iconName: "image" });
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
    try {
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        const contentEl = document.getElementById("previewContent");
        if (!contentEl) return;  // 弹窗已被关闭
        if (!res.ok) {
            const msg = (data && (data.error || data.detail)) || `HTTP ${res.status}`;
            contentEl.innerHTML = `<div class="preview-message preview-error">${escapeHtml(msg)}</div>`;
            return;
        }
        renderPreviewText(contentEl, data.content || "", { ext, isMarkdown: ext === "md" || ext === "markdown" });
    } catch (e) {
        const contentEl = document.getElementById("previewContent");
        if (contentEl) {
            contentEl.innerHTML = `<div class="preview-message preview-error">加载失败：${escapeHtml(e.message || String(e))}</div>`;
        }
    }
}

/**
 * 构建并显示一个居中弹窗。
 * @param {object} opts { title, bodyHTML, onConfirm, confirmText, onOpen }
 *   onConfirm 返回 false 可阻止关闭（用于校验失败）。
 */
function openModal({ title, bodyHTML, onConfirm, confirmText = "确定", onOpen }) {
    closeModal();
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
        if (ok !== false) closeModal();
    };

    _modalKeydownHandler = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(); }
    };
    document.addEventListener("keydown", _modalKeydownHandler, true);

    if (onOpen) onOpen(overlay);
    return overlay;
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
    const item = currentItemsList[idx];
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
            if (err) { alert(err); return false; }

            const oldPath = joinPath(currentPath, oldName);
            const newPath = joinPath(currentPath, newName);
            try {
                const res = await fetch(`${CONFIG.API_BASE}/api/action/rename`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({path: oldPath, target_path: newPath})
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { alert("重命名失败：" + (data.detail || `HTTP ${res.status}`)); return false; }
                loadPath(currentPath);
                return true;
            } catch (e) {
                alert("重命名失败：" + e.message);
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
    renderPinnedSidebar();
    updatePinButton();
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
        return `<div class="pinned-item ${isCurrent ? "current" : ""}" title="${escapeAttr(p || "根目录")}" onclick="goToPinned('${escapeAttr(p)}')">
            <svg viewBox="0 0 24 24" height="24" width="24" fill="rgb(68, 71, 70)"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            <span class="pinned-item-name">${escapeHtml(pathLabel(p))}</span>
        </div>`;
    }).join("");
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
    const item = currentItemsList[idx];
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
            return alert("操作失败：" + (data.detail || `HTTP ${res.status}`));
        }
        pinnedPaths = Array.isArray(data.pinned_list) ? data.pinned_list : pinnedPaths;
        renderPinnedSidebar();
        // 主面板可能正在显示已固定列表，重渲染
        if (currentView === "pinned") renderPinnedMain();
    } catch (e) {
        alert("操作失败：" + e.message);
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
        if (!res.ok) return alert("操作失败：" + (data.detail || `HTTP ${res.status}`));
        pinnedPaths = Array.isArray(data.pinned_list) ? data.pinned_list : pinnedPaths;
        renderPinnedSidebar();
        updatePinButton();
    } catch (e) {
        alert("操作失败：" + e.message);
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
            if (sourceParents.has(browsePath)) { alert("目标与原位置相同，请选择其他目录"); return false; }
            try {
                const res = await fetch(`${CONFIG.API_BASE}/api/action/move`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({paths, target_dir: browsePath})
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { alert("移动失败：" + (data.detail || `HTTP ${res.status}`)); return false; }
                if (data.errors && data.errors.length) {
                    alert(`已移动 ${data.moved} 项。\n以下项未移动：\n` + data.errors.join("\n"));
                }
                clearSelection();
                loadPath(currentPath);
                updateStorage();
                return true;
            } catch (e) {
                alert("移动失败：" + e.message);
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
        return alert("请先选择一个文件再复制链接");
    }
    if (files.length > 1) {
        return alert("一次只能为一个文件生成分享链接，请仅选中一个文件");
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
            return alert("生成链接失败：" + (data.detail || `HTTP ${res.status}`));
        }
    } catch (e) {
        return alert("生成链接失败：" + e.message);
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

function closeUploadWidget() {
    if (Object.keys(currentXHRs).length > 0) {
        if (!confirm("当前有项目正在上传，关闭窗口将中止传输。确定关闭吗？")) return;
        cancelAllUploads();
    }
    document.getElementById("uploadWidget").style.display = "none";
    document.getElementById("uwList").innerHTML = "";
}

function cancelAllUploads() {
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

["dragenter", "dragover", "dragleave", "drop"].forEach(eName => {
    document.body.addEventListener(eName, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
dropZone.addEventListener("dragenter", () => { _dragCounter++; _showDropOverlay(); });
dropZone.addEventListener("dragover",  () => { _showDropOverlay(); });
dropZone.addEventListener("dragleave", () => {
    _dragCounter = Math.max(0, _dragCounter - 1);
    if (_dragCounter === 0) _hideDropOverlay();
});
dropZone.addEventListener("drop", (e) => {
    _dragCounter = 0;
    _hideDropOverlay();
    const files = e.dataTransfer.files;
    if (files.length) handleFilesUpload(files);
});

function triggerFileInput() {
    if(currentView !== "files") {
        switchToFilesView();
        loadPath("");  // 上传到根目录
    }
    document.getElementById("fileInput").click();
}

function handleFileSelect(e) {
    handleFilesUpload(e.target.files);
    e.target.value = "";
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
    const raw = prompt("请输入新文件夹的名称");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return alert("文件夹名称不能为空");
    if (/[\/\\:*?"<>|\x00-\x1f]/.test(name)) {
        return alert('名称包含非法字符（\\/:*?"<>| 或控制字符）');
    }
    if (name === "." || name === "..") return alert("名称无效");
    if (name.endsWith(" ") || name.endsWith(".")) {
        return alert("名称不能以空格或点结尾");
    }

    const path = joinPath(currentPath, name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/create_folder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return alert("创建失败：" + (data.detail || `HTTP ${res.status}`));
        }
        await loadPath(currentPath);
        updateStorage();
    } catch (err) {
        alert("创建失败：" + err.message);
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

    const widget = document.getElementById("uploadWidget");
    widget.style.display = "block";
    widget.classList.remove("collapsed");

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // webkitRelativePath 形如 "myfolder/sub/a.txt"，保留完整目录结构
        const relPath = file.webkitRelativePath || file.name;
        const fileId = `up_${Date.now()}_${i}_${Math.floor(Math.random() * 1e6)}`;

        addUploadTaskUI(fileId, relPath);
        // 关键：这里在 XHR 还没进 currentXHRs 之前就显式声明"正在上传"，
        // 避免 updateUploadTitle 看 currentXHRs.length === 0 而误显示"上传已完成"。
        updateUploadTitle("uploading");

        try {
            setUploadStatus(fileId, "正在计算 MD5...", 0);
            const md5 = await calculateMD5(file);
            await doUploadXHR(fileId, file, md5, relPath);
        } catch (err) {
            setUploadStatus(fileId, "失败: " + err, 0, true);
        }
    }
}

async function handleFilesUpload(files) {
    if (files.length === 0) return;
    const widget = document.getElementById("uploadWidget");
    widget.style.display = "block";
    widget.classList.remove("collapsed");

    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        let fileId = `up_${Date.now()}_${i}`;

        addUploadTaskUI(fileId, file.name);
        // 显式声明"正在上传"，XHR 还没创建、currentXHRs 为空也能正确显示
        updateUploadTitle("uploading");

        try {
            setUploadStatus(fileId, "正在计算 MD5...", 0);
            let md5 = await calculateMD5(file);
            await doUploadXHR(fileId, file, md5);
        } catch (err) {
            setUploadStatus(fileId, "失败: " + err, 0, true);
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

function doUploadXHR(id, file, md5, relativePath = "") {
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
                resolve();
                if (currentView === "files") loadPath(currentPath);
                updateStorage();
            } else reject(xhr.responseText || "服务器错误");
        };

        xhr.onerror = () => { delete currentXHRs[id]; reject("网络中断"); };
        xhr.onabort = () => { delete currentXHRs[id]; reject("已取消"); };

        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", currentPath);
        fd.append("client_md5", md5);
        if (relativePath) fd.append("relative_path", relativePath);
        xhr.open("POST", `/api/upload`);
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
        // 失败也是终态：检查是否还有未结束的任务，没有就切到 "已完成"
        refreshUploadTitleAfterTaskEnd();
        return;
    }
    if (isDone) {
        // 成功图标
        rightBox.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#0F9D58"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
        // 成功也是终态：同样按 currentXHRs 是否清空决定是否切到 "已完成"
        refreshUploadTitleAfterTaskEnd();
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
 * 任意一个上传任务结束（成功 / 失败 / 取消）后调用：根据 currentXHRs 是否清空
 * 决定切到 "completed" 还是保持 "uploading"。
 * 集中这一个判定点，避免在每个 onload / onerror / onabort 处都重复判断。
 */
function refreshUploadTitleAfterTaskEnd() {
    if (Object.keys(currentXHRs).length === 0) {
        updateUploadTitle("completed");
    }
    // 仍有活跃任务：标题保持 "正在上传"，无需变化
}

function formatBytes(bytes) {
    if (bytes === 0) return "-";
    const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(timestamp) {
    const d = new Date(timestamp * 1000);
    return `${d.getMonth()+1}月${d.getDate()}日`;
}

// 单一事实：根据 isDir + ext 给出图标名（如 "file" / "code" / "md"）。
// 既被 getIcon()（file-list 行首图标）使用，也被 openPreviewModal()
// （预览弹窗左上角 logo）使用，保证两处展示一致。
function iconNameForExt(isDir, ext) {
    if (isDir) return "dir";
    if (["jpg","png","jpeg","gif","webp"].includes(ext)) return "image";
    if (["mp3","wav","flac","ogg","m4a","aac","wma","opus"].includes(ext)) return "audio";
    if (["mp4","mkv","mov","avi","webm","flv","wmv","m4v"].includes(ext)) return "video";
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
// 注意:已移除 svg(SVG 内嵌脚本可通过 <img> 触发 XSS,改为只能下载不能预览)
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
function canPreview(item, ext) {
    if (!item || item.is_dir) return null;
    if (_PREVIEW_IMAGE_EXTS.has(ext)) return "image";
    if (_PREVIEW_TEXT_EXTS.has(ext)) return "text";
    return null;
}

async function updateStorage() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/storage`);
        const data = await res.json();
        const fill = (data.used / data.total) * 100;
        document.getElementById("storageFill").style.width = fill + "%";
        document.getElementById("storageText").innerText = `已使用 ${formatBytes(data.used)}，共 ${formatBytes(data.total)}`;
    } catch (e) { console.error(e); }
}

function updateBreadcrumb() {
    // navFiles（侧边栏「主目录」）仅在 files 视图且路径为 Home 时高亮，
    // 进入任何子目录后应取消激活。
    const navFiles = document.getElementById("navFiles");
    if (navFiles) {
        navFiles.classList.toggle("active", currentView === "files" && currentPath === "");
    }

    const bc = document.getElementById("breadcrumb");
    if (currentView === "trash") {
        bc.innerHTML = `<span style="cursor:default; padding:2px 4px;">回收站</span>`;
        return;
    }
    if (currentView === "pinned") {
        bc.innerHTML = `<span style="cursor:default; padding:2px 4px;">已固定的文件夹</span>`;
        return;
    }
    // event.stopPropagation() 防止点击面包屑片段时触发 path-box 的 enterPathEditMode
    let html = `<span onclick="event.stopPropagation(); loadPath('')">Home</span>`;
    if (currentPath) {
        const parts = currentPath.split("/");
        let cur = "";
        parts.forEach(p => {
            if(!p) return;
            cur += (cur ? "/" : "") + p;
            html += `<span class="separator"><svg class="a-s-fa-Ha-pa c-qd" width="24" height="24" viewBox="0 0 24 24" focusable="false" fill="rgb(116,119,117)"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg></span><span onclick="event.stopPropagation(); loadPath('${escapeAttr(cur)}')">${escapeHtml(p)}</span>`;
        });
    }
    bc.innerHTML = html;
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
 * 搜索：同时支持纯文本子串匹配和简单 glob：
 *  - 输入含 * 或 ? 时，按 glob 解析为正则（* 匹配任意串、? 匹配单个字符）
 *    例如 *.json → /^.*\.json$/i
 *  - 否则按大小写不敏感的子串匹配
 *
 * 实现说明：用 textContent + trim 而不是 innerText，因为：
 *  1) 某些浏览器对内联 SVG 子节点返回的 innerText 不可预测
 *  2) 模板里可能存在换行/空白导致 trim 前后不一致
 *  3) textContent 不依赖 layout，对 display:none 的行也能正确取值
 */
function handleSearch() {
    const raw = document.getElementById("searchInput").value.trim();
    if (!raw) {
        // 空查询：恢复所有行
        document.querySelectorAll("#fileTableBody tr").forEach(row => { row.style.display = ""; });
        return;
    }

    let matcher;
    if (raw.includes("*") || raw.includes("?")) {
        // 字符级把 glob 转成正则：
        //   * → .*   ? → .   正则元字符自动转义
        // 用 ?<!\\) 负向先行保证我们不会重复转义已经处理过的 \
        let pattern = "";
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (ch === "*") pattern += ".*";
            else if (ch === "?") pattern += ".";
            else if (/[.+^${}()|[\]\\]/.test(ch)) pattern += "\\" + ch;
            else pattern += ch;
        }
        // 整名匹配（^/$ 锚定），符合 glob 语义
        matcher = new RegExp("^" + pattern + "$", "i");
    } else {
        // 纯文本：大小写不敏感子串
        const needle = raw.toLowerCase();
        matcher = { test: (s) => String(s).toLowerCase().includes(needle) };
    }

    document.querySelectorAll("#fileTableBody tr").forEach(row => {
        const nameCell = row.querySelector(".file-name-cell");
        if (nameCell) {
            // 优先用 span 里的纯文件名（不含图标 SVG），兜底用 textContent
            const nameSpan = nameCell.querySelector("span");
            const name = (nameSpan ? nameSpan.textContent : nameCell.textContent).trim();
            row.style.display = matcher.test(name) ? "" : "none";
        }
    });
}