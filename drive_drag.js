/* 鼠标拖拽条目（从 wanlab 移植）：
 * - 仅支持鼠标左键内部拖拽；外部文件拖入上传仍走原生 HTML drag/drop。
 * - 拖拽目标：回收站(navTrash)、主目录(navFiles)、面包屑段、省略号下拉项、
 *   侧边栏固定目录、列表中的目录行。
 * - 拖拽期间给 body 加 .drive-dragging：CSS 据此隐藏多选操作条、恢复显示地址栏。
 */
(function () {
    "use strict";
    let gesture = null;
    let submitting = false;
    let suppressClick = false;
    let suppressTimer = null;
    let hoverTimer = null;
    let hoveredExpander = null;
    let frame = null;

    function itemPath(item) {
        return joinPath(currentPath, item.name);
    }

    function mark(element, kind, path) {
        if (!element) return;
        element.dataset.dropKind = kind;
        element.dataset.dropPath = path ?? "";
    }

    /** 收集当前可放置目标（面包屑/固定目录的 data-path 即相对路径，直接可用）。 */
    function refreshTargets() {
        mark(document.getElementById("navTrash"), "trash");
        mark(document.getElementById("navFiles"), "directory", "");
        document.querySelectorAll("#breadcrumb [data-path], .bc-ellipsis-dropdown-item[data-path]").forEach(element => {
            mark(element, "directory", element.dataset.path);
        });
        document.querySelectorAll(".pinned-item[data-path]").forEach(element => {
            mark(element, "directory", element.dataset.path);
        });
    }

    function inhibitClick() {
        suppressClick = true;
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(() => { suppressClick = false; }, 500);
        _lastClickTs = 0;
        _lastClickIndex = -1;
    }

    function clearHighlight() {
        document.querySelectorAll(".drive-drop-target").forEach(element => element.classList.remove("drive-drop-target"));
    }

    function cleanup() {
        const previous = gesture;
        gesture = null;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        clearTimeout(hoverTimer);
        hoveredExpander = null;
        clearHighlight();
        document.querySelectorAll(".drive-drag-source").forEach(element => element.classList.remove("drive-drag-source"));
        document.body.classList.remove("drive-dragging");
        syncSelectionOverlay();
        if (previous) {
            previous.card?.remove();
            try {
                if (document.body.hasPointerCapture(previous.pointerId)) document.body.releasePointerCapture(previous.pointerId);
            } catch (_) { /* pointer already cancelled */ }
            if (previous.started) {
                inhibitClick();
                closeBreadcrumbDropdown();
            }
        }
        return previous;
    }

    function begin() {
        gesture.started = true;
        document.body.setPointerCapture(gesture.pointerId);
        document.body.classList.add("drive-dragging");
        syncSelectionOverlay();
        closeBreadcrumbDropdown();
        _lastClickTs = 0;
        _lastClickIndex = -1;
        const card = document.createElement("div");
        card.className = "drive-drag-card";
        card.setAttribute("aria-hidden", "true");
        const source = gesture.sources[0];
        const ext = source.name.split(".").pop().toLowerCase();
        card.innerHTML = `${getIcon(source.is_dir, ext)}<span class="drive-drag-name"></span><span class="drive-drag-badge" hidden></span><span class="drive-drag-blocked" hidden>⊘</span>`;
        card.querySelector(".drive-drag-name").textContent = gesture.sources.length === 1 ? source.name : `已选择 ${gesture.sources.length} 项`;
        const badge = card.querySelector(".drive-drag-badge");
        badge.hidden = gesture.sources.length === 1;
        badge.textContent = gesture.sources.length;
        if (gesture.sources.length > 1) card.classList.add("is-multiple");
        gesture.card = card;
        document.body.appendChild(card);
        renderIcons(card);
        document.querySelectorAll("#fileTableBody tr[data-index]").forEach(row => {
            const item = displayedItems[Number(row.dataset.index)];
            if (item && isSourcePath(itemPath(item))) row.classList.add("drive-drag-source");
        });
        tick();
    }

    function targetAt(x, y) {
        const hit = document.elementFromPoint(x, y);
        const element = hit?.closest("[data-drop-kind]");
        if (!element || element.dataset.dropDisabled === "true") return null;
        const kind = element.dataset.dropKind;
        if (kind === "trash") return {element, kind};
        if (kind !== "directory") return null;
        const path = element.dataset.dropPath;
        const invalid = gesture.sources.some(source => {
            const parent = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
            return path === parent || (source.is_dir && (path === source.path || path.startsWith(source.path + "/")));
        });
        return invalid ? null : {element, kind, path};
    }

    function trackTarget() {
        if (!gesture?.started) return;
        const {x, y} = gesture;
        const hit = document.elementFromPoint(x, y);
        const expander = hit?.closest(".bc-ellipsis, #navPinned");
        if (expander !== hoveredExpander) {
            clearTimeout(hoverTimer);
            hoveredExpander = expander;
            if (expander) hoverTimer = setTimeout(() => {
                if (!gesture?.started || !expander.isConnected) return;
                if (expander.id === "navPinned") {
                    if (!pinnedSectionOpen) {
                        pinnedSectionOpen = true;
                        renderPinnedSidebar();
                    }
                } else {
                    openBreadcrumbDropdown(expander);
                }
            }, 500);
        }
        clearHighlight();
        const target = targetAt(x, y);
        gesture.target = target;
        target?.element.classList.add("drive-drop-target");
        gesture.card.classList.toggle("is-invalid", !target);
        gesture.card.querySelector(".drive-drag-blocked").hidden = !!target;
        const width = gesture.card.offsetWidth;
        const height = gesture.card.offsetHeight;
        const left = Math.max(4, Math.min(x + 16, window.innerWidth - width - 4));
        const top = Math.max(4, Math.min(y + 18, window.innerHeight - height - 4));
        gesture.card.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    function tick() {
        if (!gesture?.started) return;
        const hit = document.elementFromPoint(gesture.x, gesture.y);
        const container = hit?.closest(".file-list, .pinned-list, .bc-ellipsis-dropdown");
        if (container) {
            const rect = container.getBoundingClientRect();
            const margin = Math.min(48, rect.height / 4);
            const before = container.scrollTop;
            if (gesture.y < rect.top + margin) container.scrollTop -= Math.ceil((rect.top + margin - gesture.y) / 4);
            else if (gesture.y > rect.bottom - margin) container.scrollTop += Math.ceil((gesture.y - rect.bottom + margin) / 4);
            if (before !== container.scrollTop && container.classList.contains("file-list")) _vscrollOnScroll();
        }
        trackTarget();
        frame = requestAnimationFrame(tick);
    }

    function isSourcePath(path) {
        return !!gesture?.started && gesture.sources.some(source => source.path === path);
    }

    document.addEventListener("pointerdown", event => {
        if (window.IS_MOBILE || currentView !== "files" || submitting || gesture
                || event.pointerType !== "mouse" || event.button !== 0
                || event.target.closest(".action-btn, .action-more, button, input, a")) return;
        const row = event.target.closest("#fileTableBody tr[data-index]");
        if (!row) return;
        const item = displayedItems[Number(row.dataset.index)];
        // 拖拽仅对已选中的条目生效（选择必须先于本次按下建立）。
        if (!item || !selectedItems.includes(item)) return;
        const all = selectedItems.map(source => ({name: source.name, path: itemPath(source), is_dir: source.is_dir}));
        // 已选集合里嵌套在其它所选目录内的子项不参与拖拽（父目录移动即包含它们）。
        const sources = all.filter(source => !all.some(parent => parent !== source && parent.is_dir && source.path.startsWith(parent.path + "/")));
        gesture = {pointerId: event.pointerId, originX: event.clientX, originY: event.clientY,
            x: event.clientX, y: event.clientY, sources, started: false, target: null, card: null};
    }, true);

    document.addEventListener("pointermove", event => {
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        if (!gesture.started && Math.hypot(gesture.x - gesture.originX, gesture.y - gesture.originY) >= 6) begin();
        if (gesture.started) {
            event.preventDefault();
            trackTarget();
        }
    }, {capture: true, passive: false});

    document.addEventListener("pointerup", async event => {
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (gesture.started) {
            gesture.x = event.clientX;
            gesture.y = event.clientY;
            trackTarget();
            event.preventDefault();
        }
        const finished = cleanup();
        if (!finished.started || !finished.target) return;
        submitting = true;
        document.body.classList.add("drive-drag-submitting");
        try {
            const paths = finished.sources.map(source => source.path);
            if (finished.target.kind === "trash") await trashPaths(paths);
            else await movePaths(paths, finished.target.path);
        } finally {
            submitting = false;
            document.body.classList.remove("drive-drag-submitting");
        }
    }, true);

    document.addEventListener("click", event => {
        if (suppressClick || submitting) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (suppressClick) {
                suppressClick = false;
                clearTimeout(suppressTimer);
            }
        }
    }, true);
    document.addEventListener("dragstart", event => {
        if (event.target.closest(".file-list, .pinned-list, #breadcrumb")) event.preventDefault();
    }, true);
    document.addEventListener("pointercancel", () => cleanup(), true);
    document.addEventListener("keydown", event => {
        if (gesture && event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            cleanup();
        }
    }, true);
    window.addEventListener("blur", () => cleanup());
    window.addEventListener("pagehide", () => cleanup());
    window.DriveDrag = {
        refreshTargets, isSourcePath, cancel: cleanup,
        isBusy: () => !!gesture?.started || submitting,
    };
    refreshTargets();
})();
