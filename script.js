const CONFIG = {
    API_BASE: "",
    DIRECT_TRANSFER_URL: window.location.origin
};

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
        // outerHTML 直接换掉占位元素；其余占位元素不受影响（各自拥有独立父节点）
        el.outerHTML = svg;
    }
}

window.addEventListener("DOMContentLoaded", () => {
    // 首屏静态图标已内联到 HTML，无需 renderIcons(document.body)；
    // 这里只处理动态按需加载（文件类型 dir/file/image、对话框 rename 等）。
    updateStorage();
    loadPinned();
    switchToFilesView();
});

function switchToFilesView() {
    currentView = "files";
    currentPath = "";
    document.getElementById("navFiles").classList.add("active");
    document.getElementById("navPinned").classList.remove("active");
    document.getElementById("navTrash").classList.remove("active");
    document.getElementById("bcPinBtn").style.display = "";
    clearSelection();
    loadPath("");
}

function switchToPinnedView() {
    currentView = "pinned";
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
    currentPath = path;
    currentRawPath = path || "";
    updateBreadcrumb();
    updatePinButton();
    clearSelection();
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        currentItemsList = data.items;
        renderTableHeader();
        renderTableBody();
    } catch (e) { alert("加载目录失败"); }
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

/**
 * 构造可排序的列头：仅在 sortField === field 时显示箭头徽章，否则渲染占位 span。
 * 占位与箭头同尺寸，避免点击排序时列宽发生跳动。
 */
function sortableTh(label, field) {
    const isActive = sortField === field;
    const arrowHtml = isActive
        ? sortArrowSvg(sortDirection)
        : '<span class="sort-arrow-placeholder" aria-hidden="true"></span>';
    return `<th class="sort-th${isActive ? " active" : ""}" data-field="${field}" onclick="handleSortClick('${field}', event)">
        <span class="sort-th-inner">
            <span class="sort-th-label">${label}</span>
            ${arrowHtml}
        </span>
    </th>`;
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
 * 列头点击：同列切换方向，跨列重置为 asc。
 * stopPropagation 避免触发 document 的 click-outside-clear-selection 逻辑。
 */
function handleSortClick(field, event) {
    if (event) event.stopPropagation();
    if (sortField === field) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
        sortField = field;
        sortDirection = "asc";
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

function renderTableBody() {
    const tbody = document.getElementById("fileTableBody");
    tbody.innerHTML = "";

    // 始终按当前 sortField/sortDirection 排序后再渲染
    sortItems();

    if (currentItemsList.length === 0) {
        const colCount = currentView === "files" ? 4 : (currentView === "pinned" ? 3 : 5);
        const emptyText = currentView === "pinned" ? "尚未固定任何文件夹" : "空空如也";
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding:32px; color:#aaa;">${emptyText}</td></tr>`;
        return;
    }

    currentItemsList.forEach((item, index) => {
        const ext = item.name.split(".").pop().toLowerCase();
        const tr = document.createElement("tr");
        tr.setAttribute("data-index", index);

        if (currentView === "files" && item.is_dir) {
            tr.ondblclick = () => loadPath(currentPath ? `${currentPath}/${item.name}` : item.name);
        }
        if (currentView === "pinned") {
            // 双击进入该 pinned 目录
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
                        <div class="action-btn" title="重命名" onclick="event.stopPropagation(); openRenameDialog(${index})">
                            <svg height="20" viewBox="0 -960 960 960" width="20" focusable="false" fill="currentColor"><path d="M351-144l144-144h369v144H351Zm-183-72h51l375-375-51-51-375 375v51Zm-72 72v-153l498-498q11-11 23.84-16 12.83-5 27-5 14.16 0 27.16 5t24 16l51 51q11 11 16 24t5 26.54q0 14.45-5.02 27.54T747-642L249-144H96Zm600-549-51-51 51 51Zm-127.95 76.95L543-642l51 51-25.95-25.05Z"/></svg>
                        </div>
                        <div class="action-btn" title="移动" onclick="event.stopPropagation(); moveSingle('${escapeAttr(item.name)}')">
                            <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10zm-8.01-9l-1.41 1.41L12.16 12H8v2h4.16l-1.59 1.59L11.99 17 16 13.01 11.99 9z"/></svg>
                        </div>
                        ${!item.is_dir ? `<div class="action-btn" title="下载" onclick="event.stopPropagation(); downloadFile('${escapeAttr(item.name)}')">
                            <svg height="20" width="20" viewBox="0 96 960 960" fill="#444746"><path d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"/></svg>
                        </div>` : `<div class="action-btn" title="下载文件夹" onclick="event.stopPropagation(); downloadFolder('${escapeAttr(item.name)}')">
                            <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                        </div>`}
                        <div class="action-btn" title="移至回收站" onclick="event.stopPropagation(); trashSingle('${escapeAttr(item.name)}')">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9zm4 0h2v9h-2z"/></svg>
                        </div>
                    </div>
                </td>`;
        } else if (currentView === "pinned") {
            metaCells = `<td style="color:var(--text-muted); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeAttr(item.full_path)}">${escapeHtml(item.full_path || "根目录")}</td>`;
            actionCell = `
                <td>
                    <div style="display:flex;">
                        <div class="action-btn" title="进入目录" onclick="event.stopPropagation(); openPinnedItem(${index})">
                            <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path fill="none" d="M0 0h24v24H0V0z"/><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>
                        </div>
                        <div class="action-btn" title="下载" onclick="event.stopPropagation(); downloadFolder('${escapeAttr(item.full_path)}')">
                            <svg height="20" width="20" viewBox="0 0 24 24" fill="#444746"><path d="M13 9h-2v4.2l-1.6-1.6L8 13l4 4 4-4-1.4-1.4-1.6 1.6ZM4 20c-.55 0-1.02-.2-1.41-.59s-.59-.86-.59-1.41V6c0-.55.2-1.02.59-1.41s.86-.59 1.41-.59h6l2 2h8c.55 0 1.02.2 1.41.59s.59.86.59 1.41v10c0 .55-.2 1.02-.59 1.41s-.86.59-1.41.59Zm0-2h16V8h-8.83l-2-2H4Z"/></svg>
                        </div>
                        <div class="action-btn" title="取消固定" onclick="event.stopPropagation(); unpinFromMain(${index})">
                            <svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="#444746"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                        </div>
                    </div>
                </td>`;
        } else {
            metaCells = `
                <td style="color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeAttr(item.original_path)}">${escapeHtml(item.original_path)}</td>
                <td>${formatDate(item.deleted_at)}</td>
                <td>${formatBytes(item.size)}</td>`;
            actionCell = `
                <td>
                    <div style="display:flex;">
                        <div class="action-btn" title="还原" onclick="event.stopPropagation(); restoreSingle('${escapeAttr(item.trashed_name)}')">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="#444746"><path d="M0 0h24v24H0z" fill="none"/><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                        </div>
                        <div class="action-btn" title="永久删除" onclick="event.stopPropagation(); deletePermSingle('${escapeAttr(item.trashed_name)}')">
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
        tbody.appendChild(tr);
    });

    // 渲染完后立刻把已有选中状态同步到 DOM（避免重新进入目录后高亮丢失）
    updateRowSelectionUI();
    // 表格里出现过的图标按需请求并就地替换
    renderIcons(tbody);
}

function escapeAttr(s) {
    return String(s).replace(/[&"'<>]/g, c => ({"&":"&amp;",'"':"&quot;","'":"&#39;","<":"&lt;",">":"&gt;"}[c]));
}
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
    const path = currentPath ? `${currentPath}/${filename}` : filename;
    await fetch(`${CONFIG.API_BASE}/api/action/bulk_trash`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({paths: [path]})
    });
    loadPath(currentPath);
    updateStorage();
}

async function bulkTrash() {
    if (selectedItems.length === 0) return;
    const paths = selectedItems.map(item => currentPath ? `${currentPath}/${item.name}` : item.name);
    try {
        const res = await fetch(`${CONFIG.API_BASE}/api/action/bulk_trash`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: paths})
        });
        if (res.ok) { clearSelection(); loadPath(currentPath); updateStorage(); }
    } catch (e) { alert("批量删除失败"); }
}

async function restoreSingle(trashedName) {
    await fetch(`${CONFIG.API_BASE}/api/action/bulk_restore`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({trashed_names: [trashedName]})
    });
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
        if (res.ok) { clearSelection(); loadTrash(); updateStorage(); }
    } catch (e) { alert("批量恢复失败"); }
}

async function deletePermSingle(trashedName) {
    if (!confirm("确定要永久删除该项内容吗？此操作不可逆。")) return;
    await fetch(`${CONFIG.API_BASE}/api/action/bulk_delete_permanently`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({trashed_names: [trashedName]})
    });
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
        if (res.ok) { clearSelection(); loadTrash(); updateStorage(); }
    } catch (e) { alert("批量永久删除失败"); }
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
    const p = currentPath ? `${currentPath}/${filename}` : filename;
    const res = await fetch(`${CONFIG.API_BASE}/api/download/ticket`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({path: p})
    });
    if(!res.ok) return;
    const data = await res.json();
    const a = document.createElement("a");
    a.href = `${CONFIG.DIRECT_TRANSFER_URL}/api/download/file?ticket=${data.ticket}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function downloadFolder(foldername) {
    const p = currentPath ? `${currentPath}/${foldername}` : foldername;
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
        // 413 = 文件夹过大；其它错误一并弹窗
        const msg = data.detail || data.error || `HTTP ${res.status}`;
        showAlert("文件夹下载失败", msg);
        return;
    }

    const data = await res.json();
    const a = document.createElement("a");
    a.href = `${CONFIG.DIRECT_TRANSFER_URL}/api/download/file?ticket=${data.ticket}`;
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

            const oldPath = currentPath ? `${currentPath}/${oldName}` : oldName;
            const newPath = currentPath ? `${currentPath}/${newName}` : newName;
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
    btn.title = `${isPinned ? "取消固定" : "固定"}：${currentPath || "根目录"}`;
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
    const path = currentPath ? `${currentPath}/${filename}` : filename;
    openMoveDialog([path], filename);
}

function bulkMove() {
    if (currentView !== "files" || selectedItems.length === 0) return;
    const paths = selectedItems.map(item => currentPath ? `${currentPath}/${item.name}` : item.name);
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
    const path = currentPath ? `${currentPath}/${file.name}` : file.name;

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
    updateUploadTitle();
}

const dropZone = document.getElementById("dropZone");
const overlay = document.getElementById("dropOverlay");

["dragenter", "dragover", "dragleave", "drop"].forEach(eName => {
    document.body.addEventListener(eName, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
["dragenter", "dragover"].forEach(eName => {
    dropZone.addEventListener(eName, () => overlay.classList.add("active"), false);
});
["dragleave", "drop"].forEach(eName => {
    dropZone.addEventListener(eName, () => overlay.classList.remove("active"), false);
});
dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files.length) handleFilesUpload(files);
});

function triggerFileInput() {
    if(currentView !== "files") switchToFilesView();
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
        await new Promise(r => setTimeout(r, 0)); // 让目录加载先开始
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

    const path = currentPath ? `${currentPath}/${name}` : name;
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
    // 浏览器原生支持目录选择（Chrome/Edge/Firefox）
    document.getElementById("folderInput").click();
}

async function handleFolderSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // 清空，允许重复选择同一目录
    if (files.length === 0) return;
    if (currentView !== "files") switchToFilesView();

    const widget = document.getElementById("uploadWidget");
    widget.style.display = "block";
    widget.classList.remove("collapsed");

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // webkitRelativePath 形如 "myfolder/sub/a.txt"，保留完整目录结构
        const relPath = file.webkitRelativePath || file.name;
        const fileId = `up_${Date.now()}_${i}_${Math.floor(Math.random() * 1e6)}`;

        addUploadTaskUI(fileId, relPath);
        updateUploadTitle();

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
        updateUploadTitle();

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
        xhr.open("POST", `${CONFIG.DIRECT_TRANSFER_URL}/api/upload`);
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
        return;
    }
    if (isDone) {
        // 成功图标
        rightBox.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#0F9D58"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
        updateUploadTitle();
        return;
    }

    const ring = document.getElementById(`ring_${id}`);
    if (ring) {
        const offset = 63 - (percent / 100) * 63;
        ring.style.strokeDashoffset = offset;
    }
}

function updateUploadTitle() {
    const activeTasks = Object.keys(currentXHRs).length;
    const title = document.getElementById("uwTitle");
    const subbar = document.getElementById("uwSubbar");

    if(activeTasks > 0) {
        title.innerText = `正在上传 ${activeTasks} 项内容`;
        subbar.style.display = "flex";
        document.getElementById("uwSpeed").innerText = "传输中...";
    } else {
        title.innerText = `上传已完成`;
        subbar.style.display = "none";
    }
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

// 返回的是图标占位符，待 renderIcons 异步替换为真正的 SVG
function getIcon(isDir, ext) {
    let name = "file";
    if (isDir) name = "dir";
    else if (["jpg","png","jpeg","gif","webp"].includes(ext)) name = "image";
    return `<i data-icon="${name}"></i>`;
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
            html += `<span class="separator"> &gt; </span><span onclick="event.stopPropagation(); loadPath('${escapeAttr(cur)}')">${escapeHtml(p)}</span>`;
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