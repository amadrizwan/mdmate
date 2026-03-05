const SESSION_KEY = "mdtool.session.v1";
const AUTOSAVE_DEBOUNCE_MS = 500;
const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const copyBtn = document.getElementById("copy-btn");
const refreshBtn = document.getElementById("refresh-btn");
const scrollLockBtn = document.getElementById("scroll-lock-btn");
const newBtn = document.getElementById("new-btn");
const openFolderBtn = document.getElementById("open-folder-btn");
const saveFileBtn = document.getElementById("save-file-btn");
const split = document.querySelector(".split");
const paneResizer = document.getElementById("pane-resizer");
const editorPane = document.querySelector(".editor-pane");
const previewPane = document.querySelector(".preview-pane");
const syncState = document.getElementById("sync-state");
const fileSyncState = document.getElementById("file-sync-state");
const workspaceRoot = document.getElementById("workspace-root");
const activeFileState = document.getElementById("active-file-state");
const workspaceMeta = document.getElementById("workspace-meta");
const workspaceFiles = document.getElementById("workspace-files");
const formatbar = document.getElementById("formatbar");
const tablePicker = document.getElementById("table-picker");
const tableGrid = document.getElementById("table-grid");
const tableSizeLabel = document.getElementById("table-size-label");
const sectionSelect = document.getElementById("section-select");
const sectionUpBtn = document.getElementById("section-up");
const sectionDownBtn = document.getElementById("section-down");

const SAMPLE = `# Product Notes

This is a side-by-side markdown workspace.

## Mermaid example

\`\`\`mermaid
flowchart LR
  User --> Editor
  Editor --> Preview
  Preview --> Confluence
\`\`\`

## Checklist
- [x] Live markdown preview
- [x] Confluence copy with diagram images
- [ ] DOCX and PDF export
`;
const PANE_SPLIT_KEY = "mdtool.pane.split.v1";
const SCROLL_LOCK_KEY = "mdtool.scroll.lock.v1";
const SCROLL_MAP_LOOKAHEAD = 3;
const FORMATBAR_TOOLTIP_DELAY_MS = 450;
const EXPORTABLE_TEXT_ART_LANGS = new Set(["ascii", "text", "plain", "txt"]);
const TEXT_ART_FONT_STACK = ['"Source Code Pro"', '"DejaVu Sans Mono"', '"Menlo"', '"Consolas"', "monospace"];
const TEXT_ART_TAB_WIDTH = 4;
const TEXT_ART_FONT_SIZE = 15;
const TEXT_ART_LINE_HEIGHT = 1;
const TEXT_ART_PADDING = 20;
const TEXT_ART_PIXEL_RATIO = 2;
const ASCIIFLOW_EMBED_PATH = "./assets/asciiflow/index.html";
const RENDER_CACHE_LIMIT = 240;
const DEBUG_LOG_KEY = "mdtool.debug.logs.v1";
const LOCAL_SAVE_EVENT_TTL_MS = 6000;
const MISSING_IMAGE_RETRY_MS = 6000;
const BLANK_IMAGE_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
const PREVIEW_EDIT_SCROLL_GUARD_MS = 520;
const PREVIEW_EDIT_IDLE_MS = 800;
const PREVIEW_EDIT_SCROLL_REAPPLY_FRAMES = 2;

let isRendering = false;
let pendingRenderFromEditor = false;
let previewSyncTimer;
let editorSyncTimer;
let savedPreviewRange = null;
let suppressSelectionCache = false;
let pendingHeadingRaw = "";
let manualCopyOverlay = null;
let manualCopyKeyHandler = null;
let confluenceAssistantState = null;
let conflictOverlay = null;
let paneResizeState = null;
let textArtFontReadyPromise = null;
let isScrollLockEnabled = true;
let codeMirrorEditor = null;
let editorFallbackTextarea = null;
let editorNoWrapHandles = [];
let editorNoWrapRefreshRaf = null;
let editorNoWrapRefreshTimer = null;
let suppressEditorInputDispatch = 0;
let formatbarTooltipEl = null;
let formatbarTooltipTimer = 0;
let formatbarTooltipAnchor = null;
let linkDialogOverlay = null;
let asciiFlowOverlay = null;
let asciiFlowState = null;
let previewEditSkipLogAtMs = 0;
const mermaidSvgCache = new Map();
const textArtArtifactCache = new Map();
const debugState = {
  enabled: true,
  seq: 0,
  events: []
};
const scrollSyncState = {
  blocks: [],
  sourceGuard: null,
  rafId: 0,
  pendingSource: null,
  pendingMapVersion: 0,
  mapVersion: 0,
  resizeRafId: 0,
  cachedTokens: null,
  suspendUntilMs: 0,
  previewUserScrollUntilMs: 0,
  previewEditGuardUntilMs: 0
};
const workspaceState = {
  workspaceId: null,
  rootPath: "",
  files: [],
  activeFilePath: "",
  activeBaseVersion: null,
  localDirty: false,
  isSaving: false,
  conflictState: null,
  autosaveTimer: null,
  isApplyingRemote: false,
  unsubscribeEvents: null,
  expandedFolders: new Set(),
  recentLocalSaveEvents: new Map()
};
const previewEditSession = {
  active: false,
  anchorEditorTop: 0,
  anchorEditorLeft: 0,
  lastInputAt: 0,
  idleTimer: null,
  pendingMapRebuild: false
};
const previewMissingImageSources = new Map();

function isCurrentFileMdx() {
  return (workspaceState.activeFilePath || "").toLowerCase().endsWith(".mdx");
}

marked.setOptions({
  gfm: true,
  breaks: true,
  mangle: false,
  headerIds: true
});

{
  const originalCodeRenderer = new marked.Renderer().code.bind(new marked.Renderer());
  const customRenderer = { code(code, language, escaped) {
    const langStr = String(language || "");
    const parts = langStr.split(/\s+/);
    const lang = parts[0] || "";
    const meta = parts.slice(1).join(" ");
    if (meta.includes("live") && /^jsx?$/i.test(lang)) {
      const escapedCode = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      return `<pre><code class="language-${lang}" data-meta="live">${escapedCode}</code></pre>`;
    }
    return originalCodeRenderer(code, language, escaped);
  }};
  marked.use({ renderer: customRenderer });
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
  theme: "neutral",
  flowchart: {
    htmlLabels: false
  }
});

init();

function init() {
  initDebugLogging();
  initMarkdownEditor();
  buildTableGrid(10, 10);
  initPaneResizer();
  initScrollSync();

  editor.value = SAMPLE;
  renderFromEditor();
  setFileSyncState("disconnected", "Disconnected");
  updateWorkspaceIndicators();

  editor.addEventListener("input", () => {
    endPreviewEditSession("editor-input");
    debugLog("editor.input");
    setSyncState("Syncing from markdown...");
    clearTimeout(editorSyncTimer);
    const debounceMs = isCurrentFileMdx() ? 300 : 200;
    editorSyncTimer = setTimeout(() => {
      debugLog("editor.input.flush-render");
      renderFromEditor();
    }, debounceMs);
  });

  preview.addEventListener("input", () => {
    debugLog("preview.input");
    setSyncState("Syncing from rendered editor...");
    touchPreviewEditSession("preview-input");
    cachePreviewSelection();
    clearTimeout(previewSyncTimer);
    previewSyncTimer = setTimeout(() => {
      debugLog("preview.input.flush-sync");
      syncPreviewToEditor();
    }, 140);
  });

  preview.addEventListener("mouseup", cachePreviewSelection);
  preview.addEventListener("keyup", cachePreviewSelection);
  preview.addEventListener("focus", cachePreviewSelection);
  preview.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!hasPreviewFocus()) endPreviewEditSession("preview-blur");
    }, 0);
  });
  preview.addEventListener("click", handlePreviewClickActions);

  preview.addEventListener("paste", handlePreviewPaste);
  const editorDom = getEditorDomElement();
  editorDom.addEventListener("paste", handleEditorPaste);
  editorDom.addEventListener("dragover", handleEditorDragOver);
  editorDom.addEventListener("drop", handleEditorDrop);
  editorDom.addEventListener("pointerdown", () => {
    endPreviewEditSession("editor-pointer");
  }, { passive: true });
  editorDom.addEventListener("wheel", () => {
    endPreviewEditSession("editor-wheel");
  }, { passive: true });
  editorDom.addEventListener("keydown", () => {
    endPreviewEditSession("editor-keydown");
  });

  refreshBtn.addEventListener("click", () => {
    closeTablePicker();
    renderFromEditor();
  });
  copyBtn.addEventListener("click", handleCopyForConfluence);
  newBtn.addEventListener("click", resetDocument);
  if (openFolderBtn) openFolderBtn.addEventListener("click", handleOpenFolderClick);
  if (saveFileBtn) saveFileBtn.addEventListener("click", handleSaveFileClick);
  if (workspaceFiles) workspaceFiles.addEventListener("click", handleWorkspaceFileListClick);

  formatbar.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  formatbar.addEventListener("click", handleFormatbarClick);
  initFormatbarTooltips();

  sectionSelect.addEventListener("change", updateSectionMoveButtons);
  sectionUpBtn.addEventListener("click", () => moveSelectedSection(-1));
  sectionDownBtn.addEventListener("click", () => moveSelectedSection(1));

  document.addEventListener("click", (event) => {
    if (
      !tablePicker.classList.contains("hidden") &&
      !tablePicker.contains(event.target) &&
      !event.target.closest("[data-action='table']")
    ) {
      closeTablePicker();
    }
  });

  if (hasWorkspaceApi()) {
    workspaceState.unsubscribeEvents = window.mdtoolFs.onWorkspaceEvent(handleWorkspaceEvent);
    restoreWorkspaceSession();
    window.addEventListener("beforeunload", () => {
      if (workspaceState.unsubscribeEvents) workspaceState.unsubscribeEvents();
      if (workspaceState.workspaceId) {
        window.mdtoolFs.stopWatch(workspaceState.workspaceId).catch(() => {});
      }
    });
  } else {
    if (openFolderBtn) openFolderBtn.disabled = true;
    if (saveFileBtn) saveFileBtn.disabled = true;
    if (workspaceMeta) {
      workspaceMeta.textContent = "Workspace sync requires desktop Electron runtime.";
    }
  }
}

function initDebugLogging() {
  const saved = localStorage.getItem(DEBUG_LOG_KEY);
  if (saved === "0") debugState.enabled = false;
  if (saved === "1") debugState.enabled = true;
  window.__mdtoolDebug = {
    enable() {
      debugState.enabled = true;
      localStorage.setItem(DEBUG_LOG_KEY, "1");
      debugLog("debug.enabled");
    },
    disable() {
      debugLog("debug.disabled");
      debugState.enabled = false;
      localStorage.setItem(DEBUG_LOG_KEY, "0");
    },
    clear() {
      debugState.events = [];
      debugState.seq = 0;
    },
    getEvents() {
      return [...debugState.events];
    },
    dump(limit = 200) {
      const safeLimit = Math.max(1, Number(limit) || 200);
      return debugState.events.slice(-safeLimit);
    }
  };
  debugLog("debug.init", { enabled: debugState.enabled });
}

function debugLog(event, data) {
  if (!debugState.enabled) return;
  const entry = {
    seq: ++debugState.seq,
    ts: new Date().toISOString(),
    event,
    data: data === undefined ? null : data
  };
  debugState.events.push(entry);
  if (debugState.events.length > 500) debugState.events.splice(0, debugState.events.length - 500);
  if (entry.data == null) {
    console.log(`[mdtool-debug:${entry.seq}] ${entry.event}`);
  } else {
    console.log(`[mdtool-debug:${entry.seq}] ${entry.event}`, entry.data);
  }
}

function initPaneResizer() {
  if (!split || !paneResizer || !editorPane) return;

  const stored = Number(localStorage.getItem(PANE_SPLIT_KEY));
  if (Number.isFinite(stored) && stored >= 0.2 && stored <= 0.8) {
    requestAnimationFrame(() => applyPaneSplitRatio(stored));
  }

  paneResizer.addEventListener("pointerdown", startPaneResize);
}

function initScrollSync() {
  const stored = localStorage.getItem(SCROLL_LOCK_KEY);
  if (stored === "0") isScrollLockEnabled = false;
  if (stored === "1") isScrollLockEnabled = true;
  updateScrollLockButton();

  if (scrollLockBtn) {
    scrollLockBtn.addEventListener("click", () => {
      isScrollLockEnabled = !isScrollLockEnabled;
      localStorage.setItem(SCROLL_LOCK_KEY, isScrollLockEnabled ? "1" : "0");
      updateScrollLockButton();
      if (isScrollLockEnabled) scheduleScrollSync("editor");
      else scrollSyncState.sourceGuard = null;
    });
  }

  editor.addEventListener("scroll", handleEditorScrollSync, { passive: true });
  if (previewPane) {
    previewPane.addEventListener("scroll", handlePreviewScrollSync, { passive: true });
    previewPane.addEventListener("wheel", () => markPreviewUserScrollIntent(), { passive: true });
    previewPane.addEventListener("touchstart", () => markPreviewUserScrollIntent(), { passive: true });
    previewPane.addEventListener("pointerdown", () => markPreviewUserScrollIntent(), { passive: true });
  }
  window.addEventListener("resize", handleSyncResize, { passive: true });
}

function updateScrollLockButton() {
  if (!scrollLockBtn) return;
  scrollLockBtn.classList.toggle("active", isScrollLockEnabled);
  scrollLockBtn.setAttribute("aria-pressed", isScrollLockEnabled ? "true" : "false");
  scrollLockBtn.textContent = "Scroll Lock";
  scrollLockBtn.title = isScrollLockEnabled
    ? "Scroll sync is on. Click to unlock panes."
    : "Scroll sync is off. Click to lock panes.";
}

function initMarkdownEditor() {
  if (typeof window.CodeMirror !== "function") {
    initFallbackTextareaEditor();
    return;
  }
  codeMirrorEditor = window.CodeMirror(editor, {
    value: "",
    mode: "markdown",
    lineWrapping: true,
    lineNumbers: false,
    spellcheck: false,
    autofocus: false,
    viewportMargin: 12
  });
  const cmWrapper = codeMirrorEditor.getWrapperElement();
  cmWrapper.classList.add("mdtool-cm");

  Object.defineProperty(editor, "value", {
    configurable: true,
    get() {
      return codeMirrorEditor.getValue();
    },
    set(nextValue) {
      setEditorValue(nextValue, { source: "editor.value.setter" });
    }
  });

  Object.defineProperty(editor, "selectionStart", {
    configurable: true,
    get() {
      return getEditorSelectionRange().start;
    },
    set(nextStart) {
      const current = getEditorSelectionRange();
      setEditorSelectionRange(nextStart, current.end);
    }
  });

  Object.defineProperty(editor, "selectionEnd", {
    configurable: true,
    get() {
      return getEditorSelectionRange().end;
    },
    set(nextEnd) {
      const current = getEditorSelectionRange();
      setEditorSelectionRange(current.start, nextEnd);
    }
  });

  editor.focus = () => codeMirrorEditor.focus();
  editor.setAttribute("data-editor-mode", "codemirror");

  codeMirrorEditor.on("change", () => {
    scheduleEditorNoWrapRefresh();
    if (suppressEditorInputDispatch > 0) return;
    editor.dispatchEvent(new Event("input"));
  });
  codeMirrorEditor.on("scroll", () => {
    editor.dispatchEvent(new Event("scroll"));
  });
}

function initFallbackTextareaEditor() {
  editor.innerHTML = "";
  const textarea = document.createElement("textarea");
  textarea.className = "editor-fallback-textarea";
  textarea.spellcheck = false;
  textarea.placeholder = "# Start writing markdown...";
  editor.appendChild(textarea);
  editorFallbackTextarea = textarea;

  Object.defineProperty(editor, "value", {
    configurable: true,
    get() {
      return textarea.value;
    },
    set(nextValue) {
      setEditorValue(nextValue, { source: "editor.value.setter" });
    }
  });

  Object.defineProperty(editor, "selectionStart", {
    configurable: true,
    get() {
      return textarea.selectionStart;
    },
    set(nextStart) {
      const currentEnd = textarea.selectionEnd;
      textarea.selectionStart = Number(nextStart) || 0;
      textarea.selectionEnd = currentEnd;
    }
  });

  Object.defineProperty(editor, "selectionEnd", {
    configurable: true,
    get() {
      return textarea.selectionEnd;
    },
    set(nextEnd) {
      textarea.selectionEnd = Number(nextEnd) || 0;
    }
  });

  editor.focus = () => textarea.focus();
  textarea.addEventListener("input", () => {
    editor.dispatchEvent(new Event("input"));
  });
  textarea.addEventListener("scroll", () => {
    editor.dispatchEvent(new Event("scroll"));
  });
}

function setEditorValue(nextValue, options = {}) {
  const value = String(nextValue ?? "");
  const restoreSelection = options.restoreSelection !== false;
  const restoreScroll = options.restoreScroll !== false;
  const hasAnchorTop = Number.isFinite(options.anchorTop);
  const hasAnchorLeft = Number.isFinite(options.anchorLeft);
  const immediateNoWrapRefresh = options.immediateNoWrapRefresh === true;

  if (codeMirrorEditor) {
    const infoBefore = codeMirrorEditor.getScrollInfo();
    const selectionsBefore = codeMirrorEditor.listSelections();
    suppressEditorInputDispatch += 1;
    try {
      codeMirrorEditor.setValue(value);
    } finally {
      suppressEditorInputDispatch = Math.max(0, suppressEditorInputDispatch - 1);
    }
    if (restoreSelection && Array.isArray(selectionsBefore) && selectionsBefore.length) {
      try {
        codeMirrorEditor.setSelections(selectionsBefore);
      } catch (_) {
        // Ignore stale selection restoration errors after document rewrites.
      }
    }
    if (restoreScroll || hasAnchorTop || hasAnchorLeft) {
      const nextTop = hasAnchorTop ? Number(options.anchorTop) : infoBefore.top;
      const nextLeft = hasAnchorLeft ? Number(options.anchorLeft) : infoBefore.left;
      codeMirrorEditor.scrollTo(nextLeft, nextTop);
    }
    scheduleEditorNoWrapRefresh(immediateNoWrapRefresh);
    return;
  }

  if (editorFallbackTextarea) {
    const previousTop = editorFallbackTextarea.scrollTop || 0;
    const previousLeft = editorFallbackTextarea.scrollLeft || 0;
    const previousSelectionStart = editorFallbackTextarea.selectionStart || 0;
    const previousSelectionEnd = editorFallbackTextarea.selectionEnd || 0;
    editorFallbackTextarea.value = value;
    if (restoreSelection) {
      editorFallbackTextarea.selectionStart = previousSelectionStart;
      editorFallbackTextarea.selectionEnd = previousSelectionEnd;
    }
    if (restoreScroll || hasAnchorTop || hasAnchorLeft) {
      editorFallbackTextarea.scrollTop = hasAnchorTop ? Number(options.anchorTop) : previousTop;
      editorFallbackTextarea.scrollLeft = hasAnchorLeft ? Number(options.anchorLeft) : previousLeft;
    }
    return;
  }

  const previousTop = editor.scrollTop || 0;
  const previousLeft = editor.scrollLeft || 0;
  editor.value = value;
  if (restoreScroll || hasAnchorTop || hasAnchorLeft) {
    editor.scrollTop = hasAnchorTop ? Number(options.anchorTop) : previousTop;
    editor.scrollLeft = hasAnchorLeft ? Number(options.anchorLeft) : previousLeft;
  }
}

function getEditorDomElement() {
  if (editorFallbackTextarea) return editorFallbackTextarea;
  if (codeMirrorEditor) return codeMirrorEditor.getWrapperElement();
  return editor;
}

function getEditorSelectionRange() {
  if (!codeMirrorEditor) {
    const selectionTarget = editorFallbackTextarea || editor;
    const start = typeof selectionTarget.selectionStart === "number" ? selectionTarget.selectionStart : 0;
    const end = typeof selectionTarget.selectionEnd === "number" ? selectionTarget.selectionEnd : start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }
  const [primary] = codeMirrorEditor.listSelections();
  const anchor = codeMirrorEditor.indexFromPos(primary.anchor);
  const head = codeMirrorEditor.indexFromPos(primary.head);
  return { start: Math.min(anchor, head), end: Math.max(anchor, head) };
}

function getEditorScrollInfo() {
  if (codeMirrorEditor) return codeMirrorEditor.getScrollInfo();
  if (editorFallbackTextarea) {
    return {
      top: editorFallbackTextarea.scrollTop || 0,
      left: editorFallbackTextarea.scrollLeft || 0,
      height: editorFallbackTextarea.scrollHeight || 0,
      clientHeight: editorFallbackTextarea.clientHeight || 0
    };
  }
  return {
    top: editor.scrollTop || 0,
    left: editor.scrollLeft || 0,
    height: editor.scrollHeight || 0,
    clientHeight: editor.clientHeight || 0
  };
}

function getEditorScrollTop() {
  return getEditorScrollInfo().top;
}

function setEditorScrollTop(nextTop) {
  setEditorScrollPosition(nextTop, null);
}

function setEditorScrollPosition(nextTop, nextLeft = null) {
  if (codeMirrorEditor) {
    const info = codeMirrorEditor.getScrollInfo();
    const safeLeft = Number.isFinite(nextLeft) ? Number(nextLeft) : info.left;
    codeMirrorEditor.scrollTo(safeLeft, Number(nextTop) || 0);
    return;
  }
  if (editorFallbackTextarea) {
    editorFallbackTextarea.scrollTop = Number(nextTop) || 0;
    if (Number.isFinite(nextLeft)) editorFallbackTextarea.scrollLeft = Number(nextLeft);
    return;
  }
  editor.scrollTop = Number(nextTop) || 0;
  if (Number.isFinite(nextLeft)) editor.scrollLeft = Number(nextLeft);
}

function setEditorSelectionRange(start, end = start) {
  if (!codeMirrorEditor) {
    if (editorFallbackTextarea) {
      const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
      const safeEnd = Number.isFinite(end) ? Math.max(0, end) : safeStart;
      editorFallbackTextarea.selectionStart = safeStart;
      editorFallbackTextarea.selectionEnd = safeEnd;
      return;
    }
    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
    const safeEnd = Number.isFinite(end) ? Math.max(0, end) : safeStart;
    editor.selectionStart = safeStart;
    editor.selectionEnd = safeEnd;
    return;
  }
  const maxLen = codeMirrorEditor.getValue().length;
  const safeStart = clampNumber(Number(start) || 0, 0, maxLen);
  const safeEnd = clampNumber(Number(end) || 0, 0, maxLen);
  codeMirrorEditor.setSelection(
    codeMirrorEditor.posFromIndex(Math.min(safeStart, safeEnd)),
    codeMirrorEditor.posFromIndex(Math.max(safeStart, safeEnd))
  );
}

function scheduleEditorNoWrapRefresh(immediate = false) {
  if (!codeMirrorEditor) return;
  if (immediate) {
    clearTimeout(editorNoWrapRefreshTimer);
    editorNoWrapRefreshTimer = null;
    if (editorNoWrapRefreshRaf) {
      cancelAnimationFrame(editorNoWrapRefreshRaf);
      editorNoWrapRefreshRaf = null;
    }
    // Apply immediately to avoid one-frame wrap flicker during preview-driven sync.
    refreshEditorNoWrapLines();
    editorNoWrapRefreshRaf = requestAnimationFrame(() => {
      editorNoWrapRefreshRaf = null;
      refreshEditorNoWrapLines();
    });
    return;
  }
  clearTimeout(editorNoWrapRefreshTimer);
  editorNoWrapRefreshTimer = setTimeout(() => {
    editorNoWrapRefreshTimer = null;
    refreshEditorNoWrapLines();
  }, 300);
}

function refreshEditorNoWrapLines() {
  if (!codeMirrorEditor) return;
  const previousHandles = editorNoWrapHandles;
  const previousHandleSet = new Set(previousHandles);
  const nextHandles = [];
  const nextHandleSet = new Set();

  const registerNoWrapLine = (lineNumber) => {
    const handle = codeMirrorEditor.getLineHandle(lineNumber);
    if (!handle || nextHandleSet.has(handle)) return;
    nextHandleSet.add(handle);
    nextHandles.push(handle);
    if (!previousHandleSet.has(handle)) {
      codeMirrorEditor.addLineClass(handle, "text", "cm-nowrap-text");
    }
  };

  const lines = codeMirrorEditor.getValue().replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceToken = "";
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceToken = token[0];
      } else if (token[0] === fenceToken) {
        inFence = false;
        fenceToken = "";
      }
      registerNoWrapLine(i);
      continue;
    }
    if (inFence || isMarkdownTableLine(trimmed)) registerNoWrapLine(i);
  }

  for (const handle of previousHandles) {
    if (!nextHandleSet.has(handle)) {
      codeMirrorEditor.removeLineClass(handle, "text", "cm-nowrap-text");
    }
  }
  editorNoWrapHandles = nextHandles;
}

function isMarkdownTableLine(trimmedLine) {
  if (!trimmedLine || !trimmedLine.includes("|")) return false;
  if (!trimmedLine.startsWith("|") && !trimmedLine.endsWith("|")) return false;
  const pipeCount = (trimmedLine.match(/\|/g) || []).length;
  if (pipeCount < 2) return false;
  if (/^\|?[\s:-]+\|[\s|:-]*$/.test(trimmedLine)) return true;
  return true;
}

function handleEditorScrollSync() {
  if (!isScrollLockEnabled || !previewPane) return;
  if (isScrollSyncSuspended()) return;
  if (previewEditSession.active) {
    logEditorScrollSyncSkippedPreviewEdit("handle-editor-scroll");
    return;
  }
  if (isPreviewEditScrollGuardActive()) return;
  if (scrollSyncState.sourceGuard === "preview") return;
  scheduleScrollSync("editor");
}

function handlePreviewScrollSync() {
  if (!isScrollLockEnabled) return;
  if (isScrollSyncSuspended()) return;
  if (previewEditSession.active) return;
  if (!hasPreviewUserScrollIntent()) return;
  if (scrollSyncState.sourceGuard === "editor") return;
  scheduleScrollSync("preview");
}

function scheduleScrollSync(source) {
  if (!isScrollLockEnabled || !previewPane) return;
  if (isScrollSyncSuspended()) return;
  if (source !== "editor" && source !== "preview") return;
  if (source === "editor" && previewEditSession.active) {
    logEditorScrollSyncSkippedPreviewEdit("schedule-scroll-sync");
    return;
  }
  if (source === "preview" && previewEditSession.active) return;
  if (source === "editor" && isPreviewEditScrollGuardActive()) return;

  scrollSyncState.pendingSource = source;
  scrollSyncState.pendingMapVersion = scrollSyncState.mapVersion;
  if (scrollSyncState.rafId) return;

  scrollSyncState.rafId = requestAnimationFrame(() => {
    scrollSyncState.rafId = 0;
    const sourceToRun = scrollSyncState.pendingSource;
    const mapVersionToRun = scrollSyncState.pendingMapVersion;
    scrollSyncState.pendingSource = null;
    if (!sourceToRun) return;
    if (mapVersionToRun !== scrollSyncState.mapVersion) return;

    scrollSyncState.sourceGuard = sourceToRun;
    if (sourceToRun === "editor") syncFromEditorScroll();
    else syncFromPreviewScroll();

    requestAnimationFrame(() => {
      if (scrollSyncState.sourceGuard === sourceToRun) {
        scrollSyncState.sourceGuard = null;
      }
    });
  });
}

function isScrollSyncSuspended() {
  return Date.now() < (scrollSyncState.suspendUntilMs || 0);
}

function suspendScrollSync(durationMs = 140) {
  const safeDuration = Math.max(0, Number(durationMs) || 0);
  const until = Date.now() + safeDuration;
  scrollSyncState.suspendUntilMs = Math.max(scrollSyncState.suspendUntilMs || 0, until);
}

function markPreviewUserScrollIntent(windowMs = 900) {
  const safeWindow = Math.max(100, Number(windowMs) || 900);
  scrollSyncState.previewUserScrollUntilMs = Date.now() + safeWindow;
}

function hasPreviewUserScrollIntent() {
  if (Date.now() <= (scrollSyncState.previewUserScrollUntilMs || 0)) return true;
  const active = document.activeElement;
  if (!active) return false;
  return active === preview || active === previewPane || preview.contains(active) || previewPane.contains(active);
}

function holdPreviewEditScrollGuard(durationMs = PREVIEW_EDIT_SCROLL_GUARD_MS) {
  const safeDuration = Math.max(80, Number(durationMs) || PREVIEW_EDIT_SCROLL_GUARD_MS);
  scrollSyncState.previewEditGuardUntilMs = Math.max(
    scrollSyncState.previewEditGuardUntilMs || 0,
    Date.now() + safeDuration
  );
}

function isPreviewEditScrollGuardActive() {
  return Date.now() < (scrollSyncState.previewEditGuardUntilMs || 0);
}

function hasPreviewFocus() {
  const active = document.activeElement;
  if (!active) return false;
  return active === preview || preview.contains(active);
}

function logEditorScrollSyncSkippedPreviewEdit(reason) {
  const now = Date.now();
  if (now - previewEditSkipLogAtMs < 140) return;
  previewEditSkipLogAtMs = now;
  debugLog("editor.scroll.sync.skipped.preview-edit-session", { reason });
}

function beginPreviewEditSession(reason = "preview-input") {
  if (previewEditSession.active) {
    touchPreviewEditSession(reason);
    return;
  }
  const info = getEditorScrollInfo();
  previewEditSession.active = true;
  previewEditSession.anchorEditorTop = Number(info.top) || 0;
  previewEditSession.anchorEditorLeft = Number(info.left) || 0;
  previewEditSession.lastInputAt = Date.now();
  previewEditSession.pendingMapRebuild = false;
  resetPreviewEditSessionIdleTimer();
  holdPreviewEditScrollGuard(PREVIEW_EDIT_IDLE_MS + 120);
  debugLog("preview.edit.session.start", {
    reason,
    anchorEditorTop: previewEditSession.anchorEditorTop,
    anchorEditorLeft: previewEditSession.anchorEditorLeft
  });
}

function touchPreviewEditSession(reason = "preview-input") {
  if (!previewEditSession.active) {
    beginPreviewEditSession(reason);
    return;
  }
  previewEditSession.lastInputAt = Date.now();
  resetPreviewEditSessionIdleTimer();
  holdPreviewEditScrollGuard(PREVIEW_EDIT_IDLE_MS + 120);
  debugLog("preview.edit.session.touch", { reason });
}

function resetPreviewEditSessionIdleTimer() {
  if (previewEditSession.idleTimer) {
    clearTimeout(previewEditSession.idleTimer);
    previewEditSession.idleTimer = null;
  }
  previewEditSession.idleTimer = setTimeout(() => {
    endPreviewEditSession("idle");
  }, PREVIEW_EDIT_IDLE_MS);
}

function endPreviewEditSession(reason = "end") {
  if (!previewEditSession.active && !previewEditSession.pendingMapRebuild) return;
  if (previewEditSession.idleTimer) {
    clearTimeout(previewEditSession.idleTimer);
    previewEditSession.idleTimer = null;
  }

  const wasActive = previewEditSession.active;
  const hadPendingMapRebuild = previewEditSession.pendingMapRebuild;
  previewEditSession.active = false;
  previewEditSession.lastInputAt = 0;
  previewEditSession.pendingMapRebuild = false;
  holdPreviewEditScrollGuard(120);

  debugLog("preview.edit.session.end", {
    reason,
    active: wasActive,
    pendingMapRebuild: hadPendingMapRebuild
  });

  if (hadPendingMapRebuild) {
    rebuildScrollMap();
    if (isScrollLockEnabled) scheduleScrollSync("preview");
  }
}

function applyPreviewEditAnchor(logEvent = false) {
  if (!previewEditSession.active) return;
  const before = getEditorScrollInfo();
  setEditorScrollPosition(previewEditSession.anchorEditorTop, previewEditSession.anchorEditorLeft);
  const after = getEditorScrollInfo();
  if (logEvent) {
    debugLog("preview.sync.anchor-left", {
      beforeTop: Math.round((Number(before.top) || 0) * 1000) / 1000,
      afterTop: Math.round((Number(after.top) || 0) * 1000) / 1000,
      delta: Math.round(((Number(after.top) || 0) - (Number(before.top) || 0)) * 1000) / 1000
    });
  }
}

function schedulePreviewEditAnchorReapply(frameCount = PREVIEW_EDIT_SCROLL_REAPPLY_FRAMES) {
  let remaining = Math.max(0, Number(frameCount) || 0);
  if (!remaining) return;
  const step = () => {
    if (!previewEditSession.active) return;
    applyPreviewEditAnchor(false);
    remaining -= 1;
    if (remaining > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function rebuildScrollMap() {
  const cachedTokens = scrollSyncState.cachedTokens;
  scrollSyncState.cachedTokens = null;
  const tokenLines = buildMarkdownTokenLineMap(editor.value, cachedTokens);
  const previewBlocks = collectPreviewBlocks();
  let mapped = mapTokensToPreviewBlocks(tokenLines, previewBlocks);
  if (!mapped.length && previewBlocks.length) {
    mapped = buildEvenFallbackBlocks(previewBlocks, getEditorTotalLineCount());
  }
  scrollSyncState.blocks = mapped;
  scrollSyncState.mapVersion += 1;
}

function buildMarkdownTokenLineMap(markdown, precomputedTokens) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  const tokens = precomputedTokens || marked.lexer(source);
  const tokenLines = [];
  let cursorIndex = 0;
  let cursorLine = 0;

  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (!isVisualMarkdownToken(token)) {
      if (raw) {
        const startIndex = findTokenStartIndex(source, raw, cursorIndex);
        if (startIndex > cursorIndex) {
          cursorLine += countNewlines(source.slice(cursorIndex, startIndex));
        }
        cursorIndex = startIndex + raw.length;
        cursorLine += countNewlines(raw);
      }
      continue;
    }

    const startIndex = raw ? findTokenStartIndex(source, raw, cursorIndex) : cursorIndex;
    if (startIndex > cursorIndex) {
      cursorLine += countNewlines(source.slice(cursorIndex, startIndex));
      cursorIndex = startIndex;
    }

    const mdStartLine = cursorLine;
    let spanLines = 1;
    if (raw) {
      const rawNewlines = countNewlines(raw);
      spanLines = rawNewlines + (raw.endsWith("\n") ? 0 : 1);
      if (spanLines < 1) spanLines = 1;
      cursorIndex = startIndex + raw.length;
      cursorLine = mdStartLine + rawNewlines;
    }

    tokenLines.push({
      id: `sync-token-${tokenLines.length + 1}`,
      tokenType: mapMarkdownTokenType(token),
      mdStartLine,
      mdEndLineExclusive: Math.max(mdStartLine + 1, mdStartLine + spanLines)
    });
  }

  return tokenLines;
}

function isVisualMarkdownToken(token) {
  if (!token || typeof token !== "object") return false;
  if (token.type === "space") return false;
  if (token.type === "def") return false;
  return true;
}

function mapMarkdownTokenType(token) {
  switch (token?.type) {
    case "heading":
      return "heading";
    case "paragraph":
      return "paragraph";
    case "list":
      return "list";
    case "blockquote":
      return "blockquote";
    case "table":
      return "table";
    case "code":
      return "code";
    case "hr":
      return "hr";
    case "html":
      return "html";
    default:
      return "unknown";
  }
}

function findTokenStartIndex(source, raw, fromIndex) {
  const found = source.indexOf(raw, fromIndex);
  return found >= 0 ? found : fromIndex;
}

function countNewlines(text) {
  return (String(text).match(/\n/g) || []).length;
}

function normalizeFenceSourceForComparison(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (normalized.endsWith("\n")) return normalized.slice(0, -1);
  return normalized;
}

function normalizeDiagramPlaceholdersForDiff(root) {
  if (!root) return;
  const mermaidCodes = [...root.querySelectorAll("pre > code.language-mermaid")];
  for (const codeNode of mermaidCodes) {
    const preNode = codeNode.parentElement;
    if (!preNode) continue;
    const source = String(codeNode.textContent || "").trim();
    const container = document.createElement("div");
    container.className = "diagram";
    container.dataset.source = source;
    preNode.replaceWith(container);
  }

  const liveCodes = [...root.querySelectorAll('pre > code[data-meta="live"]')];
  for (const codeNode of liveCodes) {
    const preNode = codeNode.parentElement;
    if (!preNode) continue;
    const source = String(codeNode.textContent || "");
    const container = document.createElement("div");
    container.className = "react-sandbox";
    container.dataset.source = source;
    preNode.replaceWith(container);
  }

  const textArtCodes = [...root.querySelectorAll("pre > code")].filter((node) => isExportableTextArtCodeNode(node));
  for (const codeNode of textArtCodes) {
    const preNode = codeNode.parentElement;
    if (!preNode) continue;
    const sourceText = String(codeNode.textContent || "");
    const language = getCodeLanguage(codeNode) || "text";
    const container = document.createElement("div");
    container.className = "text-art-diagram";
    container.dataset.language = language;
    container.dataset.source = sourceText;
    preNode.replaceWith(container);
  }
}

function readRenderCache(cache, key) {
  if (!cache || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeRenderCache(cache, key, value) {
  if (!cache) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > RENDER_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

function collectPreviewBlocks() {
  if (!preview) return [];
  const contentOffset = preview.offsetTop;
  const nodes = [...preview.children].filter((node) => node.nodeType === Node.ELEMENT_NODE);
  return nodes.map((node, idx) => {
    const previewStart = contentOffset + node.offsetTop;
    const previewEnd = previewStart + Math.max(1, node.offsetHeight);
    return {
      id: `sync-preview-${idx + 1}`,
      tokenType: mapPreviewNodeType(node),
      previewStart,
      previewEnd,
      previewNode: node
    };
  });
}

function mapPreviewNodeType(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return "unknown";
  if (node.classList.contains("diagram") || node.classList.contains("text-art-diagram")) return "code";
  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p") return "paragraph";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "blockquote") return "blockquote";
  if (tag === "table") return "table";
  if (tag === "pre") return "code";
  if (tag === "hr") return "hr";
  return "unknown";
}

function mapTokensToPreviewBlocks(tokenLines, previewBlocks) {
  if (!tokenLines.length || !previewBlocks.length) return [];
  const mapped = [];
  let previewIndex = 0;

  for (const tokenLine of tokenLines) {
    if (previewIndex >= previewBlocks.length) {
      const tail = previewBlocks[previewBlocks.length - 1];
      mapped.push({
        ...tokenLine,
        previewStart: tail.previewStart,
        previewEnd: tail.previewEnd,
        previewNode: tail.previewNode
      });
      continue;
    }

    const matchedIndex = findMatchingPreviewIndex(
      tokenLine.tokenType,
      previewBlocks,
      previewIndex,
      SCROLL_MAP_LOOKAHEAD
    );
    const resolvedIndex = matchedIndex >= 0 ? matchedIndex : previewIndex;
    const block = previewBlocks[resolvedIndex];
    mapped.push({
      ...tokenLine,
      previewStart: block.previewStart,
      previewEnd: block.previewEnd,
      previewNode: block.previewNode
    });
    previewIndex = Math.min(previewBlocks.length, resolvedIndex + 1);
  }
  return mapped;
}

function findMatchingPreviewIndex(tokenType, previewBlocks, fromIndex, lookahead) {
  const limit = Math.min(previewBlocks.length - 1, fromIndex + lookahead);
  for (let i = fromIndex; i <= limit; i += 1) {
    if (tokenMatchesPreviewType(tokenType, previewBlocks[i].tokenType)) return i;
  }
  return -1;
}

function tokenMatchesPreviewType(tokenType, previewType) {
  if (tokenType === previewType) return true;
  if (tokenType === "unknown" || tokenType === "html") return true;
  if (previewType === "unknown") return true;
  return false;
}

function buildEvenFallbackBlocks(previewBlocks, totalLines) {
  const normalizedLineCount = Math.max(1, totalLines);
  return previewBlocks.map((block, idx) => {
    const mdStartLine = Math.floor((idx * normalizedLineCount) / previewBlocks.length);
    const nextStartLine = Math.floor(((idx + 1) * normalizedLineCount) / previewBlocks.length);
    return {
      id: `sync-fallback-${idx + 1}`,
      tokenType: block.tokenType,
      mdStartLine,
      mdEndLineExclusive: Math.max(mdStartLine + 1, nextStartLine),
      previewStart: block.previewStart,
      previewEnd: block.previewEnd,
      previewNode: block.previewNode
    };
  });
}

function getEditorTotalLineCount() {
  const normalized = String(editor.value || "").replace(/\r\n/g, "\n");
  return normalized.length ? normalized.split("\n").length : 1;
}

function syncFromEditorScroll() {
  const topLine = getEditorVisibleTopLine();
  const block = findSyncBlockByEditorLine(topLine);
  if (!block) return;

  const mdSpan = Math.max(1, block.mdEndLineExclusive - block.mdStartLine);
  const previewSpan = Math.max(1, block.previewEnd - block.previewStart);
  const progress = clampNumber((topLine - block.mdStartLine) / mdSpan, 0, 1);
  const targetTop = block.previewStart + progress * previewSpan;
  setPreviewScrollTopSynced(targetTop);
}

function syncFromPreviewScroll() {
  if (!previewPane) return;
  const previewTop = previewPane.scrollTop;
  const block = findSyncBlockByPreviewTop(previewTop);
  if (!block) return;

  const previewSpan = Math.max(1, block.previewEnd - block.previewStart);
  const mdSpan = Math.max(1, block.mdEndLineExclusive - block.mdStartLine);
  const progress = clampNumber((previewTop - block.previewStart) / previewSpan, 0, 1);
  const targetLine = block.mdStartLine + progress * mdSpan;
  setEditorScrollTopForLine(targetLine);
}

function findSyncBlockByEditorLine(line) {
  const blocks = scrollSyncState.blocks;
  if (!blocks.length) return null;
  let nearest = blocks[0];
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    if (line >= block.mdStartLine && line < block.mdEndLineExclusive) return block;
    const distance = line < block.mdStartLine
      ? block.mdStartLine - line
      : line - block.mdEndLineExclusive;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = block;
    }
  }
  return nearest;
}

function findSyncBlockByPreviewTop(top) {
  const blocks = scrollSyncState.blocks;
  if (!blocks.length) return null;
  let nearest = blocks[0];
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    if (top >= block.previewStart && top < block.previewEnd) return block;
    const distance = top < block.previewStart
      ? block.previewStart - top
      : top - block.previewEnd;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = block;
    }
  }
  return nearest;
}

function getEditorVisibleTopLine() {
  if (codeMirrorEditor) {
    const info = codeMirrorEditor.getScrollInfo();
    const line = codeMirrorEditor.lineAtHeight(info.top, "local");
    return clampNumber(line, 0, Math.max(0, codeMirrorEditor.lineCount() - 1));
  }
  return getEditorApproxLineFromScroll(editor.value);
}

function setPreviewScrollTopSynced(nextTop) {
  if (!previewPane) return;
  const maxTop = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  previewPane.scrollTop = clampNumber(nextTop, 0, maxTop);
}

function setEditorScrollTopForLine(lineFloat) {
  if (codeMirrorEditor) {
    const lineCount = Math.max(1, codeMirrorEditor.lineCount());
    const boundedLine = clampNumber(lineFloat, 0, lineCount - 1);
    const baseLine = Math.floor(boundedLine);
    const fractional = boundedLine - baseLine;
    const coords = codeMirrorEditor.charCoords({ line: baseLine, ch: 0 }, "local");
    const lineHeight = Math.max(1, codeMirrorEditor.defaultTextHeight());
    const desiredTop = coords.top + fractional * lineHeight;
    const info = codeMirrorEditor.getScrollInfo();
    const maxTop = Math.max(0, info.height - info.clientHeight);
    codeMirrorEditor.scrollTo(info.left, clampNumber(desiredTop, 0, maxTop));
    return;
  }
  scrollEditorToApproxLine(lineFloat);
}

function handleSyncResize() {
  hideFormatbarTooltip();
  if (scrollSyncState.resizeRafId) cancelAnimationFrame(scrollSyncState.resizeRafId);
  scrollSyncState.resizeRafId = requestAnimationFrame(() => {
    scrollSyncState.resizeRafId = 0;
    rebuildScrollMap();
    if (isScrollLockEnabled) scheduleScrollSync("editor");
  });
}

function initFormatbarTooltips() {
  if (!formatbar) return;
  const buttons = [...formatbar.querySelectorAll("button[data-action]")];
  for (const button of buttons) {
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || button.dataset.action || "";
    button.dataset.tooltip = label;
    button.removeAttribute("title");

    button.addEventListener("pointerenter", () => {
      scheduleFormatbarTooltip(button);
    });
    button.addEventListener("pointerleave", hideFormatbarTooltip);
    button.addEventListener("pointerdown", hideFormatbarTooltip);
    button.addEventListener("focus", () => {
      scheduleFormatbarTooltip(button);
    });
    button.addEventListener("blur", hideFormatbarTooltip);
  }

  formatbar.addEventListener("mouseleave", hideFormatbarTooltip);
  if (previewPane) {
    previewPane.addEventListener("scroll", hideFormatbarTooltip, { passive: true });
  }
  window.addEventListener("resize", hideFormatbarTooltip, { passive: true });
}

function ensureFormatbarTooltipElement() {
  if (formatbarTooltipEl) return formatbarTooltipEl;
  const tooltip = document.createElement("div");
  tooltip.className = "formatbar-tooltip";
  tooltip.setAttribute("role", "tooltip");
  document.body.appendChild(tooltip);
  formatbarTooltipEl = tooltip;
  return tooltip;
}

function scheduleFormatbarTooltip(button) {
  clearTimeout(formatbarTooltipTimer);
  formatbarTooltipTimer = 0;
  if (!button) return;
  const tooltipText = button.dataset.tooltip || "";
  if (!tooltipText) return;
  formatbarTooltipAnchor = button;
  formatbarTooltipTimer = window.setTimeout(() => {
    showFormatbarTooltip(button);
  }, FORMATBAR_TOOLTIP_DELAY_MS);
}

function showFormatbarTooltip(button) {
  if (!button || formatbarTooltipAnchor !== button) return;
  const tooltipText = button.dataset.tooltip || "";
  if (!tooltipText) return;

  const tooltip = ensureFormatbarTooltipElement();
  tooltip.textContent = tooltipText;
  tooltip.classList.add("visible");

  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const spacing = 10;
  const minX = 8;
  const maxX = Math.max(minX, window.innerWidth - tooltipRect.width - 8);
  let left = buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2;
  left = clampNumber(left, minX, maxX);

  let top = buttonRect.top - tooltipRect.height - spacing;
  if (top < 8) {
    top = buttonRect.bottom + spacing;
  }
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideFormatbarTooltip() {
  clearTimeout(formatbarTooltipTimer);
  formatbarTooltipTimer = 0;
  formatbarTooltipAnchor = null;
  if (formatbarTooltipEl) {
    formatbarTooltipEl.classList.remove("visible");
  }
}

function getEditorApproxLineFromScroll(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const maxLineIndex = Math.max(0, lines.length - 1);
  const lineHeight = getEditorLineHeight();
  const estimated = lineHeight > 0 ? Math.round(getEditorScrollTop() / lineHeight) : 0;
  return clampNumber(estimated, 0, maxLineIndex);
}

function scrollEditorToApproxLine(lineNumber) {
  const lineHeight = getEditorLineHeight();
  const info = getEditorScrollInfo();
  const maxTop = Math.max(0, info.height - info.clientHeight);
  const targetTop = lineHeight > 0 ? lineNumber * lineHeight : 0;
  setEditorScrollTop(clampNumber(targetTop, 0, maxTop));
}

function getEditorLineHeight() {
  if (codeMirrorEditor) {
    const cmHeight = codeMirrorEditor.defaultTextHeight();
    if (Number.isFinite(cmHeight) && cmHeight > 0) return cmHeight;
  }
  const style = getComputedStyle(editorFallbackTextarea || editor);
  const lineHeightPx = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeightPx) && lineHeightPx > 0) return lineHeightPx;
  const fontSize = Number.parseFloat(style.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.4;
  return 20;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function startPaneResize(event) {
  if (!split || !paneResizer || !editorPane) return;
  if (window.matchMedia("(max-width: 980px)").matches) return;

  event.preventDefault();
  const splitRect = split.getBoundingClientRect();
  const editorRect = editorPane.getBoundingClientRect();
  paneResizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: editorRect.width,
    totalWidth: splitRect.width,
    handleWidth: paneResizer.getBoundingClientRect().width
  };

  document.body.classList.add("resizing-panes");
  paneResizer.setPointerCapture(event.pointerId);
  paneResizer.addEventListener("pointermove", onPaneResizeMove);
  paneResizer.addEventListener("pointerup", endPaneResize);
  paneResizer.addEventListener("pointercancel", endPaneResize);
}

function onPaneResizeMove(event) {
  if (!paneResizeState || event.pointerId !== paneResizeState.pointerId) return;
  const dx = event.clientX - paneResizeState.startX;
  const minPane = 220;
  const maxLeft = Math.max(minPane, paneResizeState.totalWidth - paneResizeState.handleWidth - minPane);
  const leftWidth = clamp(paneResizeState.startWidth + dx, minPane, maxLeft);
  split.style.setProperty("--left-pane-width", `${leftWidth}px`);
}

function endPaneResize(event) {
  if (!paneResizeState || event.pointerId !== paneResizeState.pointerId) return;
  paneResizer.removeEventListener("pointermove", onPaneResizeMove);
  paneResizer.removeEventListener("pointerup", endPaneResize);
  paneResizer.removeEventListener("pointercancel", endPaneResize);
  document.body.classList.remove("resizing-panes");

  const splitRect = split.getBoundingClientRect();
  const handleWidth = paneResizer.getBoundingClientRect().width;
  const leftWidth = editorPane.getBoundingClientRect().width;
  const ratio = (splitRect.width - handleWidth) > 0 ? leftWidth / (splitRect.width - handleWidth) : 0.5;
  localStorage.setItem(PANE_SPLIT_KEY, String(clamp(ratio, 0.2, 0.8)));

  try {
    paneResizer.releasePointerCapture(event.pointerId);
  } catch (err) {
    // Ignore release errors if capture already ended.
  }
  paneResizeState = null;
  rebuildScrollMap();
  if (isScrollLockEnabled) scheduleScrollSync("editor");
}

function applyPaneSplitRatio(ratio) {
  if (!split || !paneResizer || !editorPane) return;
  if (window.matchMedia("(max-width: 980px)").matches) return;

  const splitRect = split.getBoundingClientRect();
  const handleWidth = paneResizer.getBoundingClientRect().width;
  const usable = Math.max(0, splitRect.width - handleWidth);
  const minPane = 220;
  const leftWidth = clamp(usable * ratio, minPane, Math.max(minPane, usable - minPane));
  split.style.setProperty("--left-pane-width", `${leftWidth}px`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setSyncState(text) {
  if (!syncState) return;
  syncState.textContent = text;
}

let saveDocumentTimer = null;
function saveDocument() {
  clearTimeout(saveDocumentTimer);
  saveDocumentTimer = setTimeout(() => saveWorkspaceSession(), 500);
}

function hasWorkspaceApi() {
  return Boolean(window.mdtoolFs);
}

function sameVersionToken(a, b) {
  if (!a || !b) return false;
  // mtime precision can differ across watcher events; content hash+size is the stable identity.
  return a.hash === b.hash && a.size === b.size;
}

function getVersionEventKey(relativePath, version) {
  if (!version?.hash) return "";
  return `${relativePath || ""}::${version.hash}::${version.size ?? ""}`;
}

function rememberRecentLocalSaveEvent(relativePath, version) {
  const key = getVersionEventKey(relativePath, version);
  if (!key) return;
  const now = Date.now();
  workspaceState.recentLocalSaveEvents.set(key, now + LOCAL_SAVE_EVENT_TTL_MS);
  for (const [entryKey, expiresAt] of workspaceState.recentLocalSaveEvents.entries()) {
    if (expiresAt <= now) workspaceState.recentLocalSaveEvents.delete(entryKey);
  }
}

function isRecentLocalSaveEvent(relativePath, version) {
  const key = getVersionEventKey(relativePath, version);
  if (!key) return false;
  const now = Date.now();
  const expiresAt = workspaceState.recentLocalSaveEvents.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    workspaceState.recentLocalSaveEvents.delete(key);
    return false;
  }
  return true;
}

function forgetRecentLocalSaveEvent(relativePath, version) {
  const key = getVersionEventKey(relativePath, version);
  if (!key) return;
  workspaceState.recentLocalSaveEvents.delete(key);
}

function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function setFileSyncState(mode, label) {
  if (!fileSyncState) return;
  fileSyncState.className = `sync-pill ${mode}`;
  fileSyncState.textContent = label;
}

function updateWorkspaceIndicators() {
  if (workspaceRoot) {
    workspaceRoot.textContent = workspaceState.rootPath || "No workspace linked";
  }
  if (activeFileState) {
    activeFileState.textContent = workspaceState.activeFilePath
      ? `Active: ${workspaceState.activeFilePath}`
      : "No file open";
  }
  if (workspaceMeta) {
    if (!workspaceState.workspaceId) {
      workspaceMeta.textContent = "Open a folder to live-sync markdown files with local edits.";
    } else if (workspaceState.conflictState) {
      workspaceMeta.textContent = "Conflict detected. Resolve conflict before switching files.";
    } else if (workspaceState.localDirty) {
      workspaceMeta.textContent = "Local edits pending autosave.";
    } else {
      workspaceMeta.textContent = "Watching workspace for local file changes.";
    }
  }
  if (saveFileBtn) {
    saveFileBtn.disabled = !workspaceState.workspaceId || !workspaceState.activeFilePath;
  }
}

function saveWorkspaceSession() {
  try {
    const existing = getWorkspaceSession() || {};
    const expandedByWorkspace =
      existing.expandedByWorkspace && typeof existing.expandedByWorkspace === "object"
        ? { ...existing.expandedByWorkspace }
        : {};

    if (workspaceState.rootPath) {
      expandedByWorkspace[workspaceState.rootPath] = [...workspaceState.expandedFolders].sort((a, b) =>
        a.localeCompare(b)
      );
    }

    const payload = {
      lastWorkspacePath: workspaceState.rootPath || existing.lastWorkspacePath || "",
      lastActiveFile: workspaceState.activeFilePath || existing.lastActiveFile || "",
      expandedByWorkspace
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Could not save workspace session state.", err);
  }
}

function getWorkspaceSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    console.warn("Could not parse workspace session state.", err);
    return null;
  }
}

function getExpandedFoldersForWorkspace(rootPath) {
  if (!rootPath) return [];
  const session = getWorkspaceSession();
  const expandedByWorkspace = session?.expandedByWorkspace;
  if (!expandedByWorkspace || typeof expandedByWorkspace !== "object") return [];
  const entries = expandedByWorkspace[rootPath];
  if (!Array.isArray(entries)) return [];
  return entries.filter((item) => typeof item === "string");
}

async function restoreWorkspaceSession() {
  const session = getWorkspaceSession();
  if (!session?.lastWorkspacePath) return;
  try {
    const restored = await window.mdtoolFs.openFolderFromPath(session.lastWorkspacePath);
    if (!restored || restored.canceled) {
      setFileSyncState("disconnected", "Disconnected");
      return;
    }
    await attachWorkspace(restored, session.lastActiveFile || "");
  } catch (err) {
    console.warn("Workspace restore failed.", err);
    setFileSyncState("disconnected", "Disconnected");
  }
}

async function handleOpenFolderClick() {
  if (!hasWorkspaceApi()) return;
  if (workspaceState.conflictState) {
    flash("Resolve current conflict before switching workspace.", true);
    return;
  }
  try {
    const result = await window.mdtoolFs.openFolder();
    if (!result || result.canceled) return;
    await attachWorkspace(result, "");
    flash("Workspace opened.");
  } catch (err) {
    console.error(err);
    flash("Could not open workspace folder.", true);
  }
}

async function attachWorkspace(workspacePayload, preferredFilePath = "") {
  if (!workspacePayload?.workspaceId) return;
  if (workspaceState.workspaceId && workspaceState.workspaceId !== workspacePayload.workspaceId) {
    try {
      await window.mdtoolFs.stopWatch(workspaceState.workspaceId);
    } catch (err) {
      console.warn("Failed to stop old workspace watcher.", err);
    }
  }

  clearTimeout(workspaceState.autosaveTimer);
  workspaceState.workspaceId = workspacePayload.workspaceId;
  workspaceState.rootPath = workspacePayload.rootPath || "";
  workspaceState.files = [...(workspacePayload.files || [])].sort((a, b) => a.localeCompare(b));
  workspaceState.activeFilePath = "";
  workspaceState.activeBaseVersion = null;
  workspaceState.localDirty = false;
  workspaceState.isSaving = false;
  workspaceState.conflictState = null;
  workspaceState.expandedFolders = new Set(getExpandedFoldersForWorkspace(workspaceState.rootPath));
  workspaceState.recentLocalSaveEvents.clear();

  renderWorkspaceFiles();
  updateWorkspaceIndicators();
  setFileSyncState("synced", "Watching");

  await window.mdtoolFs.startWatch(workspaceState.workspaceId);

  const firstFile = preferredFilePath && workspaceState.files.includes(preferredFilePath)
    ? preferredFilePath
    : workspaceState.files[0];
  if (firstFile) {
    await loadWorkspaceFile(firstFile);
  }
  saveWorkspaceSession();
}

function renderWorkspaceFiles() {
  if (!workspaceFiles) return;
  workspaceFiles.innerHTML = "";
  if (!workspaceState.files.length) {
    const empty = document.createElement("p");
    empty.className = "assistant-empty";
    empty.textContent = "No markdown files found in this workspace.";
    workspaceFiles.appendChild(empty);
    return;
  }

  const tree = buildWorkspaceTree(workspaceState.files);
  expandParentsForActiveFile();
  const treeRoot = document.createElement("div");
  treeRoot.className = "workspace-tree";
  renderWorkspaceTreeNode(treeRoot, tree, "", 0);
  workspaceFiles.appendChild(treeRoot);
}

async function handleWorkspaceFileListClick(event) {
  const folderToggle = event.target.closest("button.workspace-folder-toggle");
  if (folderToggle) {
    const folderPath = folderToggle.dataset.folder || "";
    if (workspaceState.expandedFolders.has(folderPath)) {
      workspaceState.expandedFolders.delete(folderPath);
    } else {
      workspaceState.expandedFolders.add(folderPath);
    }
    saveWorkspaceSession();
    renderWorkspaceFiles();
    return;
  }

  const button = event.target.closest("button.workspace-file");
  if (!button) return;
  const relativePath = button.dataset.path;
  if (!relativePath || relativePath === workspaceState.activeFilePath) return;
  if (workspaceState.conflictState) {
    flash("Resolve conflict before switching files.", true);
    return;
  }
  await loadWorkspaceFile(relativePath);
}

function buildWorkspaceTree(paths) {
  const root = { folders: new Map(), files: [] };
  for (const fullPath of paths) {
    const parts = String(fullPath || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    const file = parts.pop();
    let cursor = root;
    for (const part of parts) {
      if (!cursor.folders.has(part)) {
        cursor.folders.set(part, { folders: new Map(), files: [] });
      }
      cursor = cursor.folders.get(part);
    }
    cursor.files.push(file);
  }
  return root;
}

function renderWorkspaceTreeNode(container, node, parentPath, depth) {
  const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
  for (const folderName of folderNames) {
    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    const row = document.createElement("div");
    row.className = "workspace-tree-row";
    row.style.paddingLeft = `${depth * 14}px`;

    const isExpanded = workspaceState.expandedFolders.has(folderPath);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workspace-folder-toggle";
    toggle.dataset.folder = folderPath;
    toggle.textContent = isExpanded ? `▾ ${folderName}` : `▸ ${folderName}`;
    row.appendChild(toggle);
    container.appendChild(row);

    if (isExpanded) {
      renderWorkspaceTreeNode(container, node.folders.get(folderName), folderPath, depth + 1);
    }
  }

  const fileNames = [...node.files].sort((a, b) => a.localeCompare(b));
  for (const fileName of fileNames) {
    const relativePath = parentPath ? `${parentPath}/${fileName}` : fileName;
    const row = document.createElement("div");
    row.className = "workspace-tree-row";
    row.style.paddingLeft = `${depth * 14}px`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-file";
    button.dataset.path = relativePath;
    button.textContent = fileName;
    if (relativePath === workspaceState.activeFilePath) button.classList.add("active");
    if (workspaceState.conflictState && relativePath === workspaceState.activeFilePath) {
      button.classList.add("conflict");
    }
    row.appendChild(button);
    container.appendChild(row);
  }
}

function expandParentsForActiveFile() {
  const activePath = workspaceState.activeFilePath;
  if (!activePath) return;
  const parts = activePath.split("/");
  if (parts.length < 2) return;
  let current = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    workspaceState.expandedFolders.add(current);
  }
}

async function loadWorkspaceFile(relativePath) {
  if (!workspaceState.workspaceId) return;
  try {
    const result = await window.mdtoolFs.openFile(workspaceState.workspaceId, relativePath);
    workspaceState.isApplyingRemote = true;
    editor.value = result.content || "";
    await renderFromEditor();
    workspaceState.isApplyingRemote = false;

    workspaceState.activeFilePath = relativePath;
    workspaceState.activeBaseVersion = result.version || null;
    workspaceState.localDirty = false;
    workspaceState.conflictState = null;
    closeConflictDialog();
    preview.contentEditable = "true";
    setFileSyncState("synced", "Synced");
    updateWorkspaceIndicators();
    renderWorkspaceFiles();
    saveWorkspaceSession();
  } catch (err) {
    workspaceState.isApplyingRemote = false;
    console.error(err);
    flash(`Could not open ${relativePath}.`, true);
  }
}

async function handleSaveFileClick() {
  const saved = await flushAutosaveNow(true);
  if (saved) flash("Saved.");
}

function notifyLocalContentChange() {
  if (!workspaceState.workspaceId || !workspaceState.activeFilePath) return;
  if (workspaceState.isApplyingRemote || workspaceState.conflictState) return;
  const wasDirty = workspaceState.localDirty;
  workspaceState.localDirty = true;
  setFileSyncState("saving", "Pending");
  if (!wasDirty) renderWorkspaceFiles();
  updateWorkspaceIndicators();
  scheduleAutosave();
}

function scheduleAutosave() {
  if (!workspaceState.workspaceId || !workspaceState.activeFilePath) return;
  clearTimeout(workspaceState.autosaveTimer);
  debugLog("autosave.schedule", { path: workspaceState.activeFilePath, delayMs: AUTOSAVE_DEBOUNCE_MS });
  workspaceState.autosaveTimer = setTimeout(() => {
    flushAutosaveNow(false);
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function flushAutosaveNow(isManual) {
  if (!workspaceState.workspaceId || !workspaceState.activeFilePath) return false;
  if (workspaceState.conflictState) {
    if (isManual) flash("Resolve conflict before saving.", true);
    return false;
  }
  if (workspaceState.isSaving) return false;
  if (!workspaceState.localDirty && !isManual) return true;

  clearTimeout(workspaceState.autosaveTimer);
  workspaceState.isSaving = true;
  debugLog("autosave.flush.start", {
    manual: Boolean(isManual),
    path: workspaceState.activeFilePath,
    dirty: workspaceState.localDirty
  });
  setFileSyncState("saving", "Saving...");

  const localSnapshot = editor.value;
  try {
    const result = await window.mdtoolFs.saveFile(
      workspaceState.workspaceId,
      workspaceState.activeFilePath,
      localSnapshot,
      workspaceState.activeBaseVersion
    );

    if (result?.conflict) {
      debugLog("autosave.flush.conflict", { path: workspaceState.activeFilePath });
      workspaceState.conflictState = {
        diskContent: result.diskContent || "",
        diskVersion: result.diskVersion || null,
        localContent: localSnapshot
      };
      setFileSyncState("conflict", "Conflict");
      openConflictDialog();
      renderWorkspaceFiles();
      updateWorkspaceIndicators();
      return false;
    }

    if (result?.ok) {
      workspaceState.activeBaseVersion = result.version || workspaceState.activeBaseVersion;
      rememberRecentLocalSaveEvent(workspaceState.activeFilePath, result.version);
      workspaceState.localDirty = false;
      workspaceState.conflictState = null;
      setFileSyncState("synced", "Synced");
      renderWorkspaceFiles();
      updateWorkspaceIndicators();
      saveWorkspaceSession();
      debugLog("autosave.flush.ok", {
        path: workspaceState.activeFilePath,
        versionHash: result.version?.hash || ""
      });
      return true;
    }

    setFileSyncState("disconnected", "Save failed");
    debugLog("autosave.flush.failed", { path: workspaceState.activeFilePath, reason: "no-ok-result" });
    flash("Save failed.", true);
    return false;
  } catch (err) {
    console.error(err);
    setFileSyncState("disconnected", "Save failed");
    debugLog("autosave.flush.failed", { path: workspaceState.activeFilePath, reason: String(err?.message || err) });
    flash("Save failed. Check workspace permissions.", true);
    return false;
  } finally {
    workspaceState.isSaving = false;
  }
}

async function refreshWorkspaceFilesFromDisk() {
  if (!workspaceState.workspaceId) return;
  try {
    const result = await window.mdtoolFs.listFiles(workspaceState.workspaceId);
    workspaceState.files = [...(result.files || [])].sort((a, b) => a.localeCompare(b));
    if (workspaceState.activeFilePath && !workspaceState.files.includes(workspaceState.activeFilePath)) {
      if (workspaceState.localDirty) {
        workspaceState.conflictState = {
          diskContent: "",
          diskVersion: null,
          localContent: editor.value,
          reason: "deleted"
        };
        openConflictDialog();
        setFileSyncState("conflict", "Conflict");
      } else {
        await clearActiveFileAfterDelete();
      }
    }
    renderWorkspaceFiles();
    updateWorkspaceIndicators();
    saveWorkspaceSession();
  } catch (err) {
    console.warn("Could not refresh workspace files.", err);
  }
}

async function handleWorkspaceEvent(event) {
  if (!event || event.workspaceId !== workspaceState.workspaceId) return;
  debugLog("workspace.event", {
    type: event.type,
    path: event.relativePath || "",
    oldPath: event.oldRelativePath || "",
    saving: workspaceState.isSaving,
    localDirty: workspaceState.localDirty
  });

  if (event.type === "error") {
    setFileSyncState("disconnected", "Watcher error");
    flash(`Workspace watcher error: ${event.message || "unknown error"}`, true);
    return;
  }

  if (event.type === "renamed") {
    if (event.oldRelativePath && event.oldRelativePath === workspaceState.activeFilePath) {
      workspaceState.activeFilePath = event.relativePath;
      workspaceState.activeBaseVersion = event.version || workspaceState.activeBaseVersion;
      renderWorkspaceFiles();
      updateWorkspaceIndicators();
      saveWorkspaceSession();
      if (!workspaceState.localDirty && !workspaceState.conflictState) {
        await loadWorkspaceFile(event.relativePath);
      } else {
        flash(`Active file renamed to ${event.relativePath}.`);
      }
    }
    await refreshWorkspaceFilesFromDisk();
    return;
  }

  if (event.type === "deleted") {
    if (event.relativePath === workspaceState.activeFilePath) {
      if (workspaceState.localDirty) {
        workspaceState.conflictState = {
          diskContent: "",
          diskVersion: null,
          localContent: editor.value,
          reason: "deleted"
        };
        openConflictDialog();
        setFileSyncState("conflict", "Conflict");
        renderWorkspaceFiles();
        updateWorkspaceIndicators();
      } else {
        await clearActiveFileAfterDelete();
      }
    }
    await refreshWorkspaceFilesFromDisk();
    return;
  }

  if (event.type === "added") {
    await refreshWorkspaceFilesFromDisk();
    return;
  }

  if (event.type === "changed" && event.relativePath === workspaceState.activeFilePath) {
    if (workspaceState.isSaving || workspaceState.isApplyingRemote) {
      debugLog("workspace.event.changed.ignore", { reason: workspaceState.isSaving ? "isSaving" : "isApplyingRemote" });
      return;
    }
    if (sameVersionToken(event.version, workspaceState.activeBaseVersion)) {
      debugLog("workspace.event.changed.ignore", { reason: "same-version" });
      return;
    }
    if (isRecentLocalSaveEvent(event.relativePath, event.version)) {
      workspaceState.activeBaseVersion = event.version || workspaceState.activeBaseVersion;
      forgetRecentLocalSaveEvent(event.relativePath, event.version);
      debugLog("workspace.event.changed.ignore", { reason: "local-save-echo" });
      return;
    }
    try {
      const latest = await window.mdtoolFs.openFile(workspaceState.workspaceId, workspaceState.activeFilePath);
      const latestContent = normalizeLineEndings(latest.content || "");
      const localContent = normalizeLineEndings(editor.value || "");
      if (latestContent === localContent) {
        workspaceState.activeBaseVersion = latest.version || workspaceState.activeBaseVersion;
        workspaceState.localDirty = false;
        workspaceState.conflictState = null;
        setFileSyncState("synced", "Synced");
        renderWorkspaceFiles();
        updateWorkspaceIndicators();
        saveWorkspaceSession();
        debugLog("workspace.event.changed.ignore", { reason: "same-content" });
        return;
      }
      if (workspaceState.localDirty) {
        workspaceState.conflictState = {
          diskContent: latestContent,
          diskVersion: latest.version || null,
          localContent: editor.value,
          reason: "changed"
        };
        openConflictDialog();
        setFileSyncState("conflict", "Conflict");
        renderWorkspaceFiles();
        updateWorkspaceIndicators();
        return;
      }
      workspaceState.isApplyingRemote = true;
      editor.value = latestContent;
      await renderFromEditor();
      workspaceState.isApplyingRemote = false;
      workspaceState.activeBaseVersion = latest.version || workspaceState.activeBaseVersion;
      workspaceState.localDirty = false;
      setFileSyncState("synced", "Synced");
      renderWorkspaceFiles();
      updateWorkspaceIndicators();
      saveWorkspaceSession();
      debugLog("workspace.event.changed.apply", { reason: "external-content-diff" });
      flash("Applied external file update.");
    } catch (err) {
      workspaceState.isApplyingRemote = false;
      console.warn("Could not apply external file change.", err);
    }
  }
}

async function clearActiveFileAfterDelete(showToast = true) {
  workspaceState.isApplyingRemote = true;
  editor.value = "";
  await renderFromEditor();
  workspaceState.isApplyingRemote = false;
  workspaceState.activeFilePath = "";
  workspaceState.activeBaseVersion = null;
  workspaceState.localDirty = false;
  workspaceState.conflictState = null;
  workspaceState.recentLocalSaveEvents.clear();
  setFileSyncState("disconnected", "Missing");
  renderWorkspaceFiles();
  updateWorkspaceIndicators();
  saveWorkspaceSession();
  if (showToast) flash("Active file was deleted from disk.");
}

function openConflictDialog() {
  closeConflictDialog();
  if (!workspaceState.conflictState) return;
  const reason = workspaceState.conflictState.reason || "changed";

  const overlay = document.createElement("div");
  overlay.className = "conflict-overlay";

  const panel = document.createElement("div");
  panel.className = "conflict-panel";

  const header = document.createElement("div");
  header.className = "conflict-header";
  header.innerHTML =
    reason === "deleted"
      ? "<strong>File Conflict</strong><div>The active file was deleted while local edits were pending.</div>"
      : "<strong>File Conflict</strong><div>Agent changed the file while local edits were pending.</div>";

  const body = document.createElement("div");
  body.className = "conflict-body";

  const text = document.createElement("p");
  text.textContent =
    reason === "deleted"
      ? "Choose whether to recreate the deleted file from local edits, accept deletion, or save local edits as a copy."
      : "Choose how to resolve this conflict before continuing.";

  const actions = document.createElement("div");
  actions.className = "conflict-actions";

  const keepLocalBtn = document.createElement("button");
  keepLocalBtn.type = "button";
  keepLocalBtn.textContent = "Keep Local (Overwrite Disk)";

  const acceptDiskBtn = document.createElement("button");
  acceptDiskBtn.type = "button";
  acceptDiskBtn.className = "ghost";
  acceptDiskBtn.textContent = reason === "deleted" ? "Accept Deletion" : "Accept Disk (Reload)";

  const saveCopyBtn = document.createElement("button");
  saveCopyBtn.type = "button";
  saveCopyBtn.className = "ghost";
  saveCopyBtn.textContent = "Save Local As Copy";

  actions.append(keepLocalBtn, acceptDiskBtn, saveCopyBtn);

  const columns = document.createElement("div");
  columns.className = "conflict-columns";

  const localWrap = document.createElement("div");
  const localLabel = document.createElement("label");
  localLabel.textContent = "Local edits";
  const localText = document.createElement("textarea");
  localText.readOnly = true;
  localText.value = workspaceState.conflictState.localContent || "";
  localWrap.append(localLabel, localText);

  const diskWrap = document.createElement("div");
  const diskLabel = document.createElement("label");
  diskLabel.textContent = "Disk version";
  const diskText = document.createElement("textarea");
  diskText.readOnly = true;
  diskText.value = workspaceState.conflictState.diskContent || "";
  diskWrap.append(diskLabel, diskText);

  columns.append(localWrap, diskWrap);
  body.append(text, actions, columns);
  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  conflictOverlay = overlay;

  keepLocalBtn.addEventListener("click", resolveConflictKeepLocal);
  acceptDiskBtn.addEventListener("click", resolveConflictAcceptDisk);
  saveCopyBtn.addEventListener("click", resolveConflictSaveCopy);
}

function closeConflictDialog() {
  if (!conflictOverlay) return;
  conflictOverlay.remove();
  conflictOverlay = null;
}

async function resolveConflictKeepLocal() {
  const conflict = workspaceState.conflictState;
  if (!conflict || !workspaceState.activeFilePath) return;

  try {
    const result = await window.mdtoolFs.saveFile(
      workspaceState.workspaceId,
      workspaceState.activeFilePath,
      conflict.localContent,
      conflict.diskVersion || workspaceState.activeBaseVersion
    );
    if (result?.conflict) {
      workspaceState.conflictState = {
        diskContent: result.diskContent || "",
        diskVersion: result.diskVersion || null,
        localContent: conflict.localContent,
        reason: "changed"
      };
      openConflictDialog();
      return;
    }
    if (result?.ok) {
      workspaceState.activeBaseVersion = result.version || workspaceState.activeBaseVersion;
      rememberRecentLocalSaveEvent(workspaceState.activeFilePath, result.version);
      workspaceState.localDirty = false;
      workspaceState.conflictState = null;
      closeConflictDialog();
      setFileSyncState("synced", "Synced");
      renderWorkspaceFiles();
      updateWorkspaceIndicators();
      flash("Conflict resolved using local content.");
    }
  } catch (err) {
    console.error(err);
    flash("Could not resolve conflict with local content.", true);
  }
}

async function resolveConflictAcceptDisk() {
  const conflict = workspaceState.conflictState;
  if (!conflict) return;

  if (conflict.reason === "deleted") {
    await clearActiveFileAfterDelete(false);
    closeConflictDialog();
    workspaceState.conflictState = null;
    flash("Conflict resolved by accepting file deletion.");
    return;
  }

  workspaceState.isApplyingRemote = true;
  editor.value = conflict.diskContent || "";
  await renderFromEditor();
  workspaceState.isApplyingRemote = false;

  workspaceState.activeBaseVersion = conflict.diskVersion || workspaceState.activeBaseVersion;
  workspaceState.localDirty = false;
  workspaceState.conflictState = null;
  closeConflictDialog();
  setFileSyncState("synced", "Synced");
  renderWorkspaceFiles();
  updateWorkspaceIndicators();
  flash("Conflict resolved using disk content.");
}

async function resolveConflictSaveCopy() {
  const conflict = workspaceState.conflictState;
  if (!conflict || !workspaceState.activeFilePath) return;

  const suggestedName = workspaceState.activeFilePath.replace(/\\.md$/i, "-copy.md");
  try {
    const saved = await window.mdtoolFs.saveFileAs(
      workspaceState.workspaceId,
      suggestedName,
      conflict.localContent
    );
    if (!saved || saved.canceled || !saved.relativePath) return;

    workspaceState.conflictState = null;
    closeConflictDialog();
    await refreshWorkspaceFilesFromDisk();
    await loadWorkspaceFile(saved.relativePath);
    flash("Local copy saved and opened.");
  } catch (err) {
    console.error(err);
    flash("Could not save local copy.", true);
  }
}

async function renderFromEditor() {
  if (isRendering) {
    pendingRenderFromEditor = true;
    debugLog("render.queue", { reason: "isRendering" });
    return;
  }
  isRendering = true;
  const startedAt = performance.now();
  debugLog("render.start", { markdownLength: editor.value.length });
  try {
    let passCount = 0;
    do {
      passCount += 1;
      pendingRenderFromEditor = false;
      await renderFromEditorPass();
    } while (pendingRenderFromEditor);
    debugLog("render.done", {
      passCount,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100
    });
  } finally {
    isRendering = false;
  }
}

async function renderFromEditorPass() {
  const previewTopBefore = previewPane ? previewPane.scrollTop : 0;
  const shouldRestoreEditorTop = workspaceState.isApplyingRemote || Boolean(workspaceState.conflictState);
  const editorTopBefore = shouldRestoreEditorTop ? getEditorScrollTop() : 0;
  suspendScrollSync(220);
  const passStartedAt = performance.now();
  try {
    if (asciiFlowOverlay) closeAsciiFlowEditor();
    scrollSyncState.sourceGuard = "editor";
    let html;
    if (isCurrentFileMdx()) {
      const sourceSnapshot = editor.value;
      const result = await window.mdtoolFs.compileMdx(sourceSnapshot);
      if (editor.value !== sourceSnapshot) {
        pendingRenderFromEditor = true;
        return;
      }
      if (result.error) {
        preview.innerHTML = `<div class="mdx-error"><pre>${escapeHtml(result.error)}</pre></div>`;
        return;
      }
      html = result.html;
      scrollSyncState.cachedTokens = null;
    } else {
      const tokens = marked.lexer(editor.value);
      html = marked.parser(tokens);
      scrollSyncState.cachedTokens = tokens;
    }
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = html;
    normalizeDiagramPlaceholdersForDiff(tempContainer);
    tempContainer.querySelectorAll("img[src]").forEach((imageNode) => {
      const rawSrc = imageNode.getAttribute("src") || "";
      if (!imageNode.dataset.markdownSrc) {
        imageNode.dataset.markdownSrc = rawSrc;
      }
      const resolvedSrc = resolveImageSourceForPreview(rawSrc);
      if (resolvedSrc) imageNode.setAttribute("src", resolvedSrc);
    });
    morphdom(preview, tempContainer, {
      childrenOnly: true,
      onBeforeElUpdated(fromEl, toEl) {
        if (fromEl.classList.contains("diagram") && toEl.classList?.contains("diagram")) {
          const nextSource = normalizeFenceSourceForComparison(toEl.dataset.source || "");
          const currentSource = normalizeFenceSourceForComparison(fromEl.dataset.source || "");
          if (nextSource && nextSource === currentSource) {
            return false;
          }
        }
        if (fromEl.classList.contains("react-sandbox") && toEl.classList?.contains("react-sandbox")) {
          const nextSource = normalizeFenceSourceForComparison(toEl.dataset.source || "");
          const currentSource = normalizeFenceSourceForComparison(fromEl.dataset.source || "");
          if (nextSource && nextSource === currentSource) {
            return false;
          }
        }
        if (fromEl.classList.contains("text-art-diagram") && toEl.classList?.contains("text-art-diagram")) {
          const nextSource = normalizeFenceSourceForComparison(toEl.dataset.source || "");
          const nextLanguage = String(toEl.dataset.language || "text").trim().toLowerCase();
          const currentLanguage = String(fromEl.dataset.language || "text").trim().toLowerCase();
          const currentSource = normalizeFenceSourceForComparison(fromEl.dataset.source || "");
          if (nextSource === currentSource && nextLanguage === currentLanguage) {
            return false;
          }
        }
        return true;
      },
    });
    const mermaidStats = await hydrateMermaid(preview);
    const textArtStats = await hydrateTextArt(preview);
    const sandboxStats = await hydrateReactSandbox(preview);
    resolvePreviewImageSources(preview);
    makeProtectedBlocksReadonly(preview);
    rebuildScrollMap();
    refreshSectionControls();
    saveDocument();
    notifyLocalContentChange();
    setSyncState("Synced");
    cachePreviewSelection();
    if (previewPane) {
      const maxTop = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
      previewPane.scrollTop = clampNumber(previewTopBefore, 0, maxTop);
    }
    if (shouldRestoreEditorTop) setEditorScrollTop(editorTopBefore);
    requestAnimationFrame(() => {
      suspendScrollSync(160);
      rebuildScrollMap();
    });
    debugLog("render.pass.done", {
      durationMs: Math.round((performance.now() - passStartedAt) * 100) / 100,
      mermaid: mermaidStats,
      textArt: textArtStats,
      sandbox: sandboxStats
    });
  } catch (err) {
    console.error(err);
    debugLog("render.pass.error", { message: String(err?.message || err) });
    flash("Render failed. Check markdown syntax.", true);
    setSyncState("Render failed");
  } finally {
    suspendScrollSync(140);
    scrollSyncState.sourceGuard = null;
  }
}

async function hydrateMermaid(root) {
  const codeBlocks = root.querySelectorAll("pre > code.language-mermaid");
  const placeholderBlocks = [...root.querySelectorAll(".diagram")].filter(
    (node) => (node.dataset.source || "").trim() && !node.querySelector("svg")
  );
  let idx = 0;
  const stats = { total: codeBlocks.length + placeholderBlocks.length, cacheHits: 0, rendered: 0, failed: 0 };
  for (const block of codeBlocks) {
    const code = String(block.textContent || "").trim();
    const parent = block.parentElement;
    if (!parent) continue;
    const container = document.createElement("div");
    container.className = "diagram";
    container.dataset.source = code;
    await renderMermaidContainer(container, code, () => `m-${Date.now()}-${idx++}`, stats);
    parent.replaceWith(container);
  }

  for (const container of placeholderBlocks) {
    const code = String(container.dataset.source || "").trim();
    if (!code) continue;
    await renderMermaidContainer(container, code, () => `m-${Date.now()}-${idx++}`, stats);
  }
  return stats;
}

async function renderMermaidContainer(container, source, idFactory, stats) {
  container.contentEditable = "false";
  try {
    const cacheKey = `mermaid:${source}`;
    let svg = readRenderCache(mermaidSvgCache, cacheKey);
    if (!svg) {
      const rendered = await mermaid.render(idFactory(), source);
      svg = rendered.svg;
      writeRenderCache(mermaidSvgCache, cacheKey, svg);
      stats.rendered += 1;
    } else {
      stats.cacheHits += 1;
    }
    container.innerHTML = svg;
  } catch (err) {
    stats.failed += 1;
    container.innerHTML = `<pre class="error">Mermaid render error:\n${String(err)}</pre>`;
  }
}

async function hydrateTextArt(root) {
  const codeBlocks = [...root.querySelectorAll("pre > code")].filter((node) =>
    isExportableTextArtCodeNode(node)
  );
  const placeholderBlocks = [...root.querySelectorAll(".text-art-diagram")].filter(
    (node) => Boolean(node.dataset.source || "") && !node.querySelector("img")
  );
  const stats = { total: codeBlocks.length + placeholderBlocks.length, cacheHits: 0, rendered: 0, failed: 0 };

  for (const block of codeBlocks) {
    const language = getCodeLanguage(block) || "text";
    const sourceText = block.textContent || "";
    const pre = block.parentElement;
    if (!pre) continue;
    try {
      const artifact = await buildTextArtRenderArtifact(language, sourceText, {
        sourceNode: block,
        pixelRatio: TEXT_ART_PIXEL_RATIO
      });
      if (artifact.fromCache) stats.cacheHits += 1;
      else stats.rendered += 1;
      const container = document.createElement("div");
      container.className = "text-art-diagram";
      container.dataset.language = artifact.language;
      container.dataset.source = artifact.sourceText;
      container.dataset.width = String(artifact.width);
      container.dataset.height = String(artifact.height);
      attachTextArtDiagramContent(container, artifact);

      pre.replaceWith(container);
    } catch (err) {
      stats.failed += 1;
      console.warn(`Text-art render failed for language '${language}'. Keeping source block.`, err);
    }
  }

  for (const container of placeholderBlocks) {
    const language = (container.dataset.language || "text").trim().toLowerCase() || "text";
    const sourceText = container.dataset.source || "";
    try {
      const artifact = await buildTextArtRenderArtifact(language, sourceText, {
        sourceNode: null,
        pixelRatio: TEXT_ART_PIXEL_RATIO
      });
      if (artifact.fromCache) stats.cacheHits += 1;
      else stats.rendered += 1;
      container.dataset.language = artifact.language;
      container.dataset.source = artifact.sourceText;
      container.dataset.width = String(artifact.width);
      container.dataset.height = String(artifact.height);
      attachTextArtDiagramContent(container, artifact);
    } catch (err) {
      stats.failed += 1;
      console.warn(`Text-art render failed for language '${language}'. Keeping source block.`, err);
    }
  }
  return stats;
}

function attachTextArtDiagramContent(container, artifact) {
  container.innerHTML = "";

  const actions = document.createElement("div");
  actions.className = "text-art-diagram-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "text-art-edit-btn ghost";
  editButton.dataset.action = "edit-asciiflow";
  editButton.title = "Edit this diagram in AsciiFlow";
  editButton.textContent = "Edit";
  actions.appendChild(editButton);
  container.appendChild(actions);

  const image = document.createElement("img");
  image.src = artifact.pngDataUrl;
  image.alt = `Text art diagram (${artifact.language})`;
  image.width = artifact.width;
  image.height = artifact.height;
  container.appendChild(image);
}

function makeProtectedBlocksReadonly(root) {
  root.querySelectorAll("pre, .diagram, .text-art-diagram, .react-sandbox, [data-mdx-component], [data-mdx-expr]").forEach((node) => {
    if (node.getAttribute("contenteditable") !== "false") {
      node.setAttribute("contenteditable", "false");
    }
  });
}

let _reactSandboxSrcDocPromise = null;

async function loadReactSandboxVendorScripts() {
  const files = ["./vendor/react.production.min.js", "./vendor/react-dom.production.min.js", "./vendor/babel.min.js"];
  const scripts = await Promise.all(files.map(async (f) => {
    const resp = await fetch(f);
    return resp.text();
  }));
  return scripts.map((s) => `<script>${s}<\/script>`).join("");
}

async function buildReactSandboxSrcDoc() {
  if (_reactSandboxSrcDocPromise) return _reactSandboxSrcDocPromise;
  _reactSandboxSrcDocPromise = (async () => {
    const reactScript = await loadReactSandboxVendorScripts();
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;padding:12px;color:#171717}
button{cursor:pointer}
.sandbox-error{color:#991b1b;background:#fef2f2;padding:8px 10px;border-radius:6px;font-size:12px;margin-top:8px;white-space:pre-wrap;font-family:monospace}
</style>${reactScript}</head><body>
<div id="root"></div>
<script>
window.__sandbox__ = {
  render: function(source) {
    var root = document.getElementById("root");
    try {
      var transformed = Babel.transform(source + "\\nReactDOM.render(React.createElement(typeof App !== 'undefined' ? App : function(){return React.createElement('div',null,'Define an App component')}), document.getElementById('root'));", {
        presets: ["react"],
        filename: "sandbox.jsx"
      }).code;
      root.innerHTML = "";
      var errorEl = document.getElementById("sandbox-error");
      if (errorEl) errorEl.remove();
      new Function("React", "ReactDOM", transformed)(React, ReactDOM);
      return { error: null };
    } catch (err) {
      var existing = document.getElementById("sandbox-error");
      if (!existing) {
        existing = document.createElement("div");
        existing.id = "sandbox-error";
        existing.className = "sandbox-error";
        document.body.appendChild(existing);
      }
      existing.textContent = err.message;
      return { error: err.message };
    }
  }
};
<\/script></body></html>`;
  })();
  return _reactSandboxSrcDocPromise;
}

function createReactSandboxContainer(source) {
  const wrapper = document.createElement("div");
  wrapper.className = "react-sandbox";
  wrapper.dataset.source = source;

  const header = document.createElement("div");
  header.className = "react-sandbox-header";
  const label = document.createElement("span");
  label.textContent = "JSX Live";
  header.appendChild(label);
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "ghost compact";
  resetBtn.textContent = "Reset";
  header.appendChild(resetBtn);
  wrapper.appendChild(header);

  const body = document.createElement("div");
  body.className = "react-sandbox-body";

  const editorPanel = document.createElement("div");
  editorPanel.className = "react-sandbox-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "react-sandbox-code";
  textarea.spellcheck = false;
  textarea.defaultValue = source;
  editorPanel.appendChild(textarea);
  body.appendChild(editorPanel);

  const previewPanel = document.createElement("div");
  previewPanel.className = "react-sandbox-preview";
  const iframe = document.createElement("iframe");
  iframe.className = "react-sandbox-frame";
  iframe.sandbox = "allow-scripts";
  previewPanel.appendChild(iframe);
  body.appendChild(previewPanel);

  wrapper.appendChild(body);

  return { wrapper, textarea, iframe, resetBtn };
}

function renderSandboxCode(iframe, source) {
  if (!iframe.contentWindow || !iframe.contentWindow.__sandbox__) return;
  iframe.contentWindow.__sandbox__.render(source);
}

async function populateReactSandboxContainer(container) {
  if (container.querySelector(".react-sandbox-body")) return;
  const source = container.dataset.source || "";
  const { wrapper } = createReactSandboxContainer(source);

  container.innerHTML = wrapper.innerHTML;
  container.className = wrapper.className;

  const ta = container.querySelector(".react-sandbox-code");
  const fr = container.querySelector(".react-sandbox-frame");
  const rb = container.querySelector(".react-sandbox-header button");
  if (!ta || !fr) return;

  let debounceTimer = 0;
  fr.addEventListener("load", () => {
    clearTimeout(debounceTimer);
    renderSandboxCode(fr, ta.value);
  });

  ta.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderSandboxCode(fr, ta.value);
    }, 400);
  });

  if (rb) {
    rb.addEventListener("click", () => {
      ta.value = source;
      renderSandboxCode(fr, source);
    });
  }

  const srcdoc = await buildReactSandboxSrcDoc();
  fr.srcdoc = srcdoc;
}

async function hydrateReactSandbox(root) {
  const placeholders = [...root.querySelectorAll(".react-sandbox")];
  const tasks = [];
  for (const container of placeholders) {
    if (container.querySelector(".react-sandbox-body")) continue;
    tasks.push(populateReactSandboxContainer(container));
  }
  await Promise.all(tasks);
  return { total: placeholders.length, hydrated: tasks.length };
}

function resolvePreviewImageSources(root) {
  if (!root) return;
  const images = root.querySelectorAll("img");
  for (const image of images) {
    if (image.closest(".text-art-diagram")) continue;
    bindPreviewImageErrorTracking(image);
    const originalSrc = image.dataset.markdownSrc || image.getAttribute("src") || "";
    if (!originalSrc) continue;
    if (!image.dataset.markdownSrc) image.dataset.markdownSrc = originalSrc;
    const resolved = resolveImageSourceForPreview(originalSrc);
    if (!resolved) continue;
    if (shouldDelayMissingImageRetry(resolved)) {
      image.src = BLANK_IMAGE_DATA_URL;
      image.dataset.pendingImageSrc = resolved;
      image.classList.add("image-missing");
      continue;
    }
    if (image.src !== resolved) image.src = resolved;
    image.classList.remove("image-missing");
    delete image.dataset.pendingImageSrc;
  }
}

function bindPreviewImageErrorTracking(image) {
  if (!image || image.dataset.mdtoolImageBound === "1") return;
  image.dataset.mdtoolImageBound = "1";
  image.addEventListener("error", () => {
    const failedSrc = image.currentSrc || image.dataset.pendingImageSrc || image.dataset.markdownSrc || image.getAttribute("src") || "";
    if (!failedSrc) return;
    previewMissingImageSources.set(failedSrc, Date.now());
    debugLog("preview.image.error", { src: failedSrc });
    image.classList.add("image-missing");
  });
  image.addEventListener("load", () => {
    const loadedSrc = image.currentSrc || image.dataset.pendingImageSrc || image.dataset.markdownSrc || image.getAttribute("src") || "";
    if (loadedSrc) previewMissingImageSources.delete(loadedSrc);
    if (loadedSrc) debugLog("preview.image.load", { src: loadedSrc });
    image.classList.remove("image-missing");
    delete image.dataset.pendingImageSrc;
  });
}

function shouldDelayMissingImageRetry(resolvedSrc) {
  const failedAt = previewMissingImageSources.get(resolvedSrc);
  if (!failedAt) return false;
  if (Date.now() - failedAt >= MISSING_IMAGE_RETRY_MS) {
    previewMissingImageSources.delete(resolvedSrc);
    return false;
  }
  return true;
}

function resolveImageSourceForPreview(src) {
  const raw = String(src || "").trim();
  if (!raw) return raw;
  if (isAlreadyAbsoluteAssetSrc(raw)) return raw;
  if (!workspaceState.rootPath) return raw;

  const { pathPart, suffix } = splitSrcSuffix(raw);

  // Root-relative paths (e.g. /assets/foo.png) resolve from public dir or workspace root
  if (pathPart.startsWith("/")) {
    const rel = pathPart.replace(/^\/+/, "");
    const parentDir = workspaceState.rootPath.replace(/\\/g, "/").replace(/\/[^/]+\/?$/, "");
    const publicRoot = parentDir ? `${parentDir}/public` : "public";
    return `${toFileUrlPath(publicRoot, rel)}${suffix}`;
  }

  const relPath = resolveWorkspaceRelativeAssetPath(pathPart, workspaceState.activeFilePath || "");
  if (!relPath) return raw;
  return `${toFileUrlPath(workspaceState.rootPath, relPath)}${suffix}`;
}

function isAlreadyAbsoluteAssetSrc(src) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src);
}

function splitSrcSuffix(src) {
  const match = String(src || "").match(/^([^?#]*)([?#].*)?$/);
  return {
    pathPart: match?.[1] || "",
    suffix: match?.[2] || ""
  };
}

function resolveWorkspaceRelativeAssetPath(pathPart, activeFilePath) {
  const cleanPath = String(pathPart || "").trim();
  if (!cleanPath) return null;

  const baseSegments = [];
  const activeDir = getPosixDirname(activeFilePath);
  if (activeDir) baseSegments.push(...activeDir.split("/").filter(Boolean));

  const parts = cleanPath.split("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!baseSegments.length) return null;
      baseSegments.pop();
      continue;
    }
    baseSegments.push(part);
  }

  return baseSegments.length ? baseSegments.join("/") : null;
}

function getPosixDirname(relativePath) {
  const pathValue = String(relativePath || "");
  const idx = pathValue.lastIndexOf("/");
  if (idx < 0) return "";
  return pathValue.slice(0, idx);
}

function toFileUrlPath(rootPath, relativePosixPath) {
  const root = String(rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = String(relativePosixPath || "").replace(/^\/+/, "");
  const absolute = rel ? `${root}/${rel}` : root;
  return absolutePathToFileUrl(absolute);
}

function absolutePathToFileUrl(absolutePath) {
  const normalized = String(absolutePath || "").replace(/\\/g, "/");
  const pathPart = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = pathPart
    .split("/")
    .map((segment, index) => {
      if (index === 0) return "";
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join("/");
  return `file://${encoded}`;
}

function syncPreviewToEditor() {
  if (isRendering) return;
  if (!previewEditSession.active && hasPreviewFocus()) beginPreviewEditSession("preview-sync");
  if (previewEditSession.active) touchPreviewEditSession("preview-sync");
  debugLog("preview.sync.start", { previewScrollTop: previewPane ? previewPane.scrollTop : 0 });
  cachePreviewSelection();
  const hadPreviewFocus = hasPreviewFocus();
  const savedRangeSnapshot = savedPreviewRange ? savedPreviewRange.cloneRange() : null;
  holdPreviewEditScrollGuard();
  suspendScrollSync(260);
  scrollSyncState.sourceGuard = "preview";
  try {
    const previewTopBefore = previewPane ? previewPane.scrollTop : 0;
    const sessionAnchorTop = previewEditSession.active ? previewEditSession.anchorEditorTop : null;
    const sessionAnchorLeft = previewEditSession.active ? previewEditSession.anchorEditorLeft : null;
    const nextMarkdown = previewToMarkdown(preview).trimEnd() + "\n";
    if (normalizeLineEndings(editor.value) !== normalizeLineEndings(nextMarkdown)) {
      setEditorValue(nextMarkdown, {
        source: "preview-sync",
        restoreSelection: !previewEditSession.active,
        restoreScroll: true,
        anchorTop: sessionAnchorTop,
        anchorLeft: sessionAnchorLeft,
        immediateNoWrapRefresh: previewEditSession.active
      });
    }
    if (previewEditSession.active) {
      applyPreviewEditAnchor(true);
      schedulePreviewEditAnchorReapply(PREVIEW_EDIT_SCROLL_REAPPLY_FRAMES);
      previewEditSession.pendingMapRebuild = true;
    } else {
      rebuildScrollMap();
    }
    refreshSectionControls();
    saveDocument();
    notifyLocalContentChange();
    setSyncState("Synced");
    if (previewPane) {
      const maxTop = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
      previewPane.scrollTop = clampNumber(previewTopBefore, 0, maxTop);
    }
    if (hadPreviewFocus) {
      try {
        if (savedRangeSnapshot) savedPreviewRange = savedRangeSnapshot.cloneRange();
        preview.focus({ preventScroll: true });
        if (savedRangeSnapshot) restorePreviewSelection();
      } catch (_) {
        // Ignore selection restore errors if nodes changed while editing.
      }
    }
    debugLog("preview.sync.done", { markdownLength: nextMarkdown.length });
  } finally {
    holdPreviewEditScrollGuard(360);
    suspendScrollSync(220);
    requestAnimationFrame(() => {
      if (scrollSyncState.sourceGuard === "preview") {
        scrollSyncState.sourceGuard = null;
      }
    });
  }
}

function handlePreviewClickActions(event) {
  const editButton = event.target.closest("button[data-action='edit-asciiflow']");
  if (!editButton) return;
  event.preventDefault();
  event.stopPropagation();

  const block = editButton.closest(".text-art-diagram");
  if (!block) return;
  openAsciiFlowEditor(block);
}

async function handleFormatbarClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  hideFormatbarTooltip();
  const action = button.dataset.action;

  if (action === "table") {
    toggleTablePicker(button);
    return;
  }
  closeTablePicker();

  restorePreviewSelection();
  preview.focus();
  setSyncState("Applying format...");

  switch (action) {
    case "h1":
      document.execCommand("formatBlock", false, "h1");
      break;
    case "h2":
      document.execCommand("formatBlock", false, "h2");
      break;
    case "h3":
      document.execCommand("formatBlock", false, "h3");
      break;
    case "bold":
      document.execCommand("bold");
      break;
    case "italic":
      document.execCommand("italic");
      break;
    case "link":
      if (!(await insertLinkAtSelection())) {
        setSyncState("Synced");
        return;
      }
      break;
    case "ul":
      document.execCommand("insertUnorderedList");
      break;
    case "ol":
      document.execCommand("insertOrderedList");
      break;
    case "quote":
      document.execCommand("formatBlock", false, "blockquote");
      break;
    case "code":
      insertCodeBlockAtCursor();
      break;
    case "mermaid":
      insertMermaidBlockAtCursor();
      break;
    default:
      return;
  }

  cachePreviewSelection();
  syncPreviewToEditor();

  if (action === "mermaid") {
    renderFromEditor();
  }
}

async function insertLinkAtSelection() {
  const selected = getSelectedText() || "link text";
  cachePreviewSelection();
  const url = await openLinkDialog("https://");
  if (!url) return false;
  restorePreviewSelection();
  preview.focus();
  document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(selected)}</a>`);
  return true;
}

function openLinkDialog(defaultUrl = "https://") {
  closeLinkDialog();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "link-dialog-overlay";

    const panel = document.createElement("div");
    panel.className = "link-dialog-panel";

    const title = document.createElement("div");
    title.className = "link-dialog-title";
    title.textContent = "Insert Link";

    const input = document.createElement("input");
    input.className = "link-dialog-input";
    input.type = "url";
    input.placeholder = "https://example.com";
    input.value = defaultUrl;
    input.autocomplete = "off";
    input.spellcheck = false;

    const actions = document.createElement("div");
    actions.className = "link-dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost";
    cancelBtn.textContent = "Cancel";

    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.textContent = "Insert";

    actions.append(cancelBtn, insertBtn);
    panel.append(title, input, actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    linkDialogOverlay = overlay;

    const closeWith = (value) => {
      if (!linkDialogOverlay) return;
      closeLinkDialog();
      resolve(value);
    };

    cancelBtn.addEventListener("click", () => closeWith(null));
    insertBtn.addEventListener("click", () => {
      const value = input.value.trim();
      closeWith(value || null);
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeWith(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWith(null);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        closeWith(value || null);
      }
    });

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

function closeLinkDialog() {
  if (!linkDialogOverlay) return;
  linkDialogOverlay.remove();
  linkDialogOverlay = null;
}

async function openAsciiFlowEditor(targetNode) {
  if (!targetNode || !targetNode.classList?.contains("text-art-diagram")) return;
  closeAsciiFlowEditor();

  const sourceText = targetNode.dataset.source || "";
  const language = (targetNode.dataset.language || "text").trim().toLowerCase() || "text";
  const drawingId = `mdtool-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const overlay = document.createElement("div");
  overlay.className = "asciiflow-overlay";

  const panel = document.createElement("div");
  panel.className = "asciiflow-panel";

  const header = document.createElement("div");
  header.className = "asciiflow-header";
  header.innerHTML = "<strong>Edit In AsciiFlow</strong><span>Draw in AsciiFlow, then apply changes back to this markdown block.</span>";

  const actions = document.createElement("div");
  actions.className = "asciiflow-actions";

  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "ghost";
  reloadBtn.textContent = "Reload Source";

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Apply";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost";
  closeBtn.textContent = "Close";

  actions.append(reloadBtn, applyBtn, closeBtn);

  const status = document.createElement("div");
  status.className = "asciiflow-status";
  status.textContent = "Loading AsciiFlow editor...";

  const frameWrap = document.createElement("div");
  frameWrap.className = "asciiflow-frame-wrap";

  const iframe = document.createElement("iframe");
  iframe.className = "asciiflow-frame";
  iframe.title = "AsciiFlow editor";
  iframe.loading = "eager";
  iframe.srcdoc = buildAsciiFlowSrcDoc(drawingId);
  frameWrap.appendChild(iframe);

  panel.append(header, actions, status, frameWrap);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  asciiFlowOverlay = overlay;
  asciiFlowState = {
    overlay,
    iframe,
    targetNode,
    language,
    bridge: null
  };

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  };

  const loadSource = async () => {
    if (!asciiFlowState || asciiFlowState.targetNode !== targetNode) return false;
    const bridge = asciiFlowState.bridge;
    if (!bridge || typeof bridge.setCommittedText !== "function") return false;
    const desired = targetNode.dataset.source || "";
    return seedAsciiFlowText(bridge, desired);
  };

  const applyChanges = async () => {
    if (!asciiFlowState || asciiFlowState.targetNode !== targetNode) return;
    const bridge = asciiFlowState.bridge;
    if (!bridge || typeof bridge.getCommittedText !== "function") {
      setStatus("AsciiFlow bridge is not ready yet.", true);
      return;
    }

    let nextSource = "";
    try {
      nextSource = String(bridge.getCommittedText() ?? "");
    } catch (err) {
      console.error(err);
      setStatus("Could not read text from AsciiFlow.", true);
      return;
    }

    try {
      await updateTextArtDiagramSource(targetNode, language, nextSource);
      syncPreviewToEditor();
      await renderFromEditor();
      closeAsciiFlowEditor();
      flash("Updated diagram from AsciiFlow.");
    } catch (err) {
      console.error(err);
      setStatus("Could not apply AsciiFlow changes.", true);
    }
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeAsciiFlowEditor();
  });
  closeBtn.addEventListener("click", closeAsciiFlowEditor);
  reloadBtn.addEventListener("click", async () => {
    const loaded = await loadSource();
    setStatus(loaded ? "Source reloaded from markdown block." : "AsciiFlow bridge is not ready yet.", !loaded);
  });
  applyBtn.addEventListener("click", applyChanges);

  const keyHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAsciiFlowEditor();
    }
  };
  document.addEventListener("keydown", keyHandler);
  asciiFlowState.keyHandler = keyHandler;

  iframe.addEventListener("load", async () => {
    if (!asciiFlowState || asciiFlowState.iframe !== iframe) return;
    setStatus("Connecting to AsciiFlow...");
    try {
      const bridge = await waitForAsciiFlowBridge(iframe.contentWindow, 12000);
      asciiFlowState.bridge = bridge;
      if (typeof bridge.setDarkMode === "function") bridge.setDarkMode(false);
      const loaded = await loadSource();
      setStatus(loaded ? "AsciiFlow ready." : "AsciiFlow opened, but source sync is delayed. Click Reload Source.");
    } catch (err) {
      console.error(err);
      setStatus("AsciiFlow bridge unavailable in this session.", true);
    }
  });
}

function buildAsciiFlowSrcDoc(drawingId) {
  const baseHref = ASCIIFLOW_EMBED_PATH.replace(/[^/]+$/, "");
  const safeBase = escapeHtml(baseHref || "./assets/asciiflow/");
  const safeId = encodeURIComponent(String(drawingId || "mdtool"));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <base href="${safeBase}" />
  <link rel="stylesheet" href="bundle.css" />
  <style>
    @font-face {
      font-family: "Source Code Pro";
      font-style: normal;
      font-weight: 400;
      font-display: block;
      src: url("./public/fonts/SourceCodePro-Regular.ttf") format("truetype");
    }
    @font-face {
      font-family: "Source Code Pro";
      font-style: normal;
      font-weight: 500;
      font-display: block;
      src: url("./public/fonts/SourceCodePro-Medium.ttf") format("truetype");
    }
    html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    * { font-family: "Source Code Pro", monospace; }
  </style>
</head>
<body style="margin:0;padding:0;overflow:hidden">
  <div id="root"></div>
  <script>window.location.hash = "/local/${safeId}";<\/script>
  <script src="bundle.js"><\/script>
</body>
</html>`;
}

function closeAsciiFlowEditor() {
  if (asciiFlowState?.keyHandler) {
    document.removeEventListener("keydown", asciiFlowState.keyHandler);
  }
  if (asciiFlowOverlay) {
    asciiFlowOverlay.remove();
    asciiFlowOverlay = null;
  }
  asciiFlowState = null;
}

function waitForAsciiFlowBridge(win, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const probe = () => {
      if (!win) {
        reject(new Error("AsciiFlow window unavailable."));
        return;
      }
      try {
        const bridge = win.__asciiflow__;
        if (
          bridge &&
          typeof bridge.getCommittedText === "function" &&
          typeof bridge.setCommittedText === "function"
        ) {
          resolve(bridge);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for AsciiFlow bridge."));
        return;
      }
      setTimeout(probe, 80);
    };

    probe();
  });
}

function normalizeAsciiFlowText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedAsciiFlowText(bridge, sourceText) {
  if (!bridge || typeof bridge.setCommittedText !== "function" || typeof bridge.getCommittedText !== "function") {
    return false;
  }
  const desired = normalizeAsciiFlowText(sourceText);
  const attempts = 24;
  for (let i = 0; i < attempts; i += 1) {
    try {
      bridge.setCommittedText(desired);
      const actual = normalizeAsciiFlowText(bridge.getCommittedText());
      if (actual === desired) return true;
    } catch (_) {
      // Keep retrying while AsciiFlow route/store hydrates.
    }
    await sleepMs(70);
  }
  try {
    bridge.setCommittedText(desired);
  } catch (_) {}
  return false;
}

async function updateTextArtDiagramSource(node, language, sourceText) {
  const safeLanguage = (language || node?.dataset?.language || "text").trim().toLowerCase() || "text";
  const safeSource = String(sourceText ?? "");
  const artifact = await buildTextArtRenderArtifact(safeLanguage, safeSource, {
    sourceNode: null,
    pixelRatio: TEXT_ART_PIXEL_RATIO
  });

  node.dataset.language = artifact.language;
  node.dataset.source = artifact.sourceText;
  node.dataset.width = String(artifact.width);
  node.dataset.height = String(artifact.height);
  attachTextArtDiagramContent(node, artifact);
  node.setAttribute("contenteditable", "false");
}

function buildTableGrid(maxRows, maxCols) {
  tableGrid.innerHTML = "";
  for (let row = 1; row <= maxRows; row += 1) {
    for (let col = 1; col <= maxCols; col += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "table-cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.setAttribute("aria-label", `${row} x ${col}`);
      cell.addEventListener("mouseover", () => {
        highlightTableGrid(row, col);
      });
      cell.addEventListener("focus", () => {
        highlightTableGrid(row, col);
      });
      cell.addEventListener("click", () => {
        insertTableAtCursor(row, col);
        closeTablePicker();
      });
      tableGrid.appendChild(cell);
    }
  }
  highlightTableGrid(0, 0);
}

function highlightTableGrid(rows, cols) {
  tableSizeLabel.textContent = rows && cols ? `${rows} x ${cols}` : "0 x 0";
  const cells = tableGrid.querySelectorAll(".table-cell");
  for (const cell of cells) {
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    cell.classList.toggle("active", r <= rows && c <= cols);
  }
}

function toggleTablePicker(anchorButton) {
  if (!tablePicker.classList.contains("hidden")) {
    closeTablePicker();
    return;
  }
  cachePreviewSelection();
  const rect = anchorButton.getBoundingClientRect();
  const paneRect = preview.parentElement.getBoundingClientRect();
  tablePicker.style.top = `${rect.bottom - paneRect.top + 8}px`;
  tablePicker.style.left = `${Math.max(8, rect.left - paneRect.left)}px`;
  tablePicker.classList.remove("hidden");
  tablePicker.setAttribute("aria-hidden", "false");
  highlightTableGrid(0, 0);
}

function closeTablePicker() {
  tablePicker.classList.add("hidden");
  tablePicker.setAttribute("aria-hidden", "true");
  highlightTableGrid(0, 0);
}

function insertCodeBlockAtCursor() {
  restorePreviewSelection();
  const selected = getSelectedText();
  const code = document.createElement("code");
  code.textContent = selected || "const example = true;";
  const pre = document.createElement("pre");
  pre.setAttribute("contenteditable", "false");
  pre.appendChild(code);
  insertBlockAtCursor(pre);
}

function insertMermaidBlockAtCursor() {
  restorePreviewSelection();
  const source = [
    "flowchart TD",
    "  A[Start] --> B{Decision}",
    "  B -->|Yes| C[Done]",
    "  B -->|No| D[Update]"
  ].join("\n");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = source;
  const pre = document.createElement("pre");
  pre.appendChild(code);
  insertBlockAtCursor(pre);
}

function insertTableAtCursor(rows, cols) {
  const tableBlock = buildMarkdownTableSnippet(rows, cols);
  const insertedAtPreviewCursor = insertMarkdownBlockAtPreviewCursor(tableBlock);
  if (!insertedAtPreviewCursor) {
    insertMarkdownIntoEditor(`\n${tableBlock}\n`);
  }
  flash(`Inserted ${rows} x ${cols} markdown table.`);
}

function buildMarkdownTableSnippet(rows, cols) {
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(2, rows);
  const header = [];
  for (let c = 1; c <= safeCols; c += 1) {
    header.push(`Column ${c}`);
  }
  const divider = new Array(safeCols).fill("---");
  const bodyLines = [];
  for (let r = 1; r < safeRows; r += 1) {
    const bodyCells = [];
    for (let c = 1; c <= safeCols; c += 1) {
      bodyCells.push(`Value ${r}.${c}`);
    }
    bodyLines.push(`| ${bodyCells.join(" | ")} |`);
  }
  return `| ${header.join(" | ")} |\n| ${divider.join(" | ")} |\n${bodyLines.join("\n")}`;
}

function insertMarkdownBlockAtPreviewCursor(markdownBlock) {
  const marker = `MDTOOL_TABLE_MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const markerNode = document.createElement("p");
  markerNode.textContent = marker;

  insertBlockAtCursor(markerNode);
  const idx = editor.value.indexOf(marker);
  if (idx < 0) return false;

  editor.value = `${editor.value.slice(0, idx)}${markdownBlock}${editor.value.slice(idx + marker.length)}`;
  renderFromEditor();
  return true;
}

function insertMarkdownIntoEditor(snippet) {
  const start = typeof editor.selectionStart === "number" ? editor.selectionStart : editor.value.length;
  const end = typeof editor.selectionEnd === "number" ? editor.selectionEnd : editor.value.length;
  const current = editor.value;
  editor.value = `${current.slice(0, start)}${snippet}${current.slice(end)}`;
  const nextCaret = start + snippet.length;
  editor.focus();
  editor.selectionStart = editor.selectionEnd = nextCaret;
  renderFromEditor();
}

function insertBlockAtCursor(blockNode) {
  const range = getCurrentPreviewRange();
  if (!range) {
    preview.appendChild(blockNode);
    preview.appendChild(document.createElement("p"));
    syncPreviewToEditor();
    return;
  }

  range.deleteContents();
  range.insertNode(blockNode);

  const spacer = document.createElement("p");
  spacer.appendChild(document.createElement("br"));
  if (blockNode.nextSibling) {
    blockNode.parentNode.insertBefore(spacer, blockNode.nextSibling);
  } else {
    blockNode.parentNode.appendChild(spacer);
  }

  const nextRange = document.createRange();
  nextRange.setStart(spacer, 0);
  nextRange.collapse(true);
  suppressSelectionCache = true;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(nextRange);
  suppressSelectionCache = false;
  savedPreviewRange = nextRange.cloneRange();
  syncPreviewToEditor();
}

function getCurrentPreviewRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const liveRange = sel.getRangeAt(0);
    if (preview.contains(liveRange.startContainer)) return liveRange;
  }
  if (savedPreviewRange) return savedPreviewRange.cloneRange();

  const endRange = document.createRange();
  endRange.selectNodeContents(preview);
  endRange.collapse(false);
  return endRange;
}

function cachePreviewSelection() {
  if (suppressSelectionCache) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) return;
  savedPreviewRange = range.cloneRange();
}

function restorePreviewSelection() {
  if (!savedPreviewRange) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  suppressSelectionCache = true;
  sel.removeAllRanges();
  sel.addRange(savedPreviewRange.cloneRange());
  suppressSelectionCache = false;
  return true;
}

function getSelectedText() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  return sel.toString().trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function previewToMarkdown(root) {
  const blocks = [];
  for (const node of root.childNodes) {
    const md = nodeToMarkdown(node).trim();
    if (md) blocks.push(md);
  }
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return sanitizeText(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${"#".repeat(level)} ${inlineToMarkdown(node)}`;
  }
  if (tag === "p") return inlineToMarkdown(node);
  if (tag === "blockquote") {
    return nodeToMarkdownLines(node)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (tag === "ul") return listToMarkdown(node, false);
  if (tag === "ol") return listToMarkdown(node, true);
  if (tag === "hr") return "---";
  if (tag === "pre") {
    const codeNode = node.querySelector("code");
    if (codeNode && codeNode.dataset.mdxEsm) {
      return codeNode.textContent || "";
    }
    if (codeNode && codeNode.dataset.mdxExpr) {
      return codeNode.textContent || "";
    }
    return fencedCodeMarkdown(node);
  }
  if (tag === "table") return tableToMarkdown(node);
  if (tag === "img") return `![${node.getAttribute("alt") || ""}](${getImageMarkdownSrc(node)})`;
  if (node.classList.contains("diagram")) {
    const src = node.dataset.source || "";
    return src ? `\`\`\`mermaid\n${src}\n\`\`\`` : "";
  }
  if (node.classList.contains("text-art-diagram")) {
    const sourceLanguage = (node.dataset.language || "text").trim().toLowerCase();
    const sourceText = node.dataset.source || "";
    return `\`\`\`${sourceLanguage}\n${sourceText}\n\`\`\``;
  }
  if (node.classList.contains("react-sandbox")) {
    const sandboxTextarea = node.querySelector(".react-sandbox-code");
    const sourceText = sandboxTextarea ? sandboxTextarea.value : (node.dataset.source || "");
    return `\`\`\`jsx live\n${sourceText}\n\`\`\``;
  }
  if (node.dataset && node.dataset.mdxComponent) {
    const name = node.dataset.mdxComponent;
    const props = node.dataset.mdxProps ? JSON.parse(node.dataset.mdxProps) : {};
    const propsStr = Object.entries(props)
      .filter(([, v]) => v != null && v !== undefined)
      .map(([k, v]) => typeof v === "string" ? `${k}="${v}"` : `${k}={${JSON.stringify(v)}}`)
      .join(" ");
    const inner = nodeToMarkdownLines(node).trim();
    const openTag = propsStr ? `<${name} ${propsStr}>` : `<${name}>`;
    return inner ? `${openTag}\n${inner}\n</${name}>` : `<${name} />`;
  }
  if (tag === "div" || tag === "section" || tag === "article") return nodeToMarkdownLines(node);
  return inlineToMarkdown(node);
}

function nodeToMarkdownLines(node) {
  const lines = [];
  for (const child of node.childNodes) {
    const value = nodeToMarkdown(child).trim();
    if (value) lines.push(value);
  }
  return lines.join("\n");
}

function inlineToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return sanitizeText(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  const children = [...node.childNodes].map(inlineToMarkdown).join("");

  if (tag === "strong" || tag === "b") return `**${children}**`;
  if (tag === "em" || tag === "i") return `*${children}*`;
  if (tag === "code" && node.dataset && node.dataset.mdxExpr) {
    return node.textContent || "";
  }
  if (tag === "code") return `\`${sanitizeInlineCode(node.textContent)}\``;
  if (tag === "a") {
    const href = node.getAttribute("href") || "#";
    return `[${children || href}](${href})`;
  }
  if (tag === "br") return "\n";
  if (tag === "img") {
    const alt = node.getAttribute("alt") || "";
    const src = getImageMarkdownSrc(node);
    return `![${alt}](${src})`;
  }
  if (tag === "span" || tag === "mark" || tag === "small" || tag === "u") return children;
  if (tag === "li") return children;
  return children;
}

function sanitizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ");
}

function sanitizeInlineCode(value) {
  return String(value || "").replace(/`/g, "\\`");
}

function getImageMarkdownSrc(imageNode) {
  if (!imageNode || imageNode.nodeType !== Node.ELEMENT_NODE) return "";
  return imageNode.dataset.markdownSrc || imageNode.getAttribute("src") || "";
}

function fencedCodeMarkdown(pre) {
  const codeNode = pre.querySelector("code");
  if (!codeNode) return "";
  const className = codeNode.className || "";
  const lang = className.replace("language-", "").trim();
  const content = codeNode.textContent || "";
  return `\`\`\`${lang}\n${content}\n\`\`\``.trim();
}

function listToMarkdown(listNode, ordered) {
  const lines = [];
  let idx = 1;
  for (const child of listNode.children) {
    if (child.tagName.toLowerCase() !== "li") continue;
    const checkbox = child.querySelector("input[type='checkbox']");
    const text = inlineToMarkdown(child).trim().replace(/\s+/g, " ");
    if (checkbox) {
      const marker = checkbox.checked ? "[x]" : "[ ]";
      lines.push(`- ${marker} ${text.replace(/\[[x ]\]\s*/i, "")}`);
      continue;
    }
    const prefix = ordered ? `${idx}.` : "-";
    lines.push(`${prefix} ${text}`);
    idx += 1;
  }
  return lines.join("\n");
}

function tableToMarkdown(table) {
  const rows = [...table.querySelectorAll("tr")];
  if (!rows.length) return "";
  const cells = rows.map((row) =>
    [...row.querySelectorAll("th,td")].map((cell) => normalizeTableCell(inlineToMarkdown(cell)))
  );
  const headerWidth = Math.max(1, ...cells.map((row) => row.length));
  const header = padTableRow(cells[0] || [], headerWidth).map((value, idx) => value || `Column ${idx + 1}`);
  const divider = new Array(headerWidth).fill("---");
  const body = cells.slice(1).map((row) => padTableRow(row, headerWidth));
  const lines = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${divider.join(" | ")} |`);
  for (const row of body) lines.push(`| ${row.join(" | ")} |`);
  if (!body.length) {
    lines.push(`| ${new Array(headerWidth).fill("").join(" | ")} |`);
  }
  return lines.join("\n");
}

function normalizeTableCell(value) {
  return sanitizeText(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function padTableRow(row, width) {
  const padded = [...row];
  while (padded.length < width) padded.push("");
  return padded.slice(0, width);
}

function refreshSectionControls() {
  const previousRaw = pendingHeadingRaw || sectionSelect.dataset.raw || "";
  pendingHeadingRaw = "";
  const headings = parseHeadings(editor.value);
  sectionSelect.innerHTML = "";

  if (!headings.length) {
    const option = document.createElement("option");
    option.textContent = "No headings";
    option.value = "-1";
    sectionSelect.appendChild(option);
    sectionSelect.disabled = true;
    sectionUpBtn.disabled = true;
    sectionDownBtn.disabled = true;
    sectionSelect.dataset.raw = "";
    return;
  }

  sectionSelect.disabled = false;
  headings.forEach((heading, idx) => {
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = `${"  ".repeat(heading.level - 1)}${"#".repeat(heading.level)} ${heading.text}`;
    option.dataset.raw = heading.raw;
    sectionSelect.appendChild(option);
  });

  let selectedIndex = headings.findIndex((h) => h.raw === previousRaw);
  if (selectedIndex < 0) selectedIndex = 0;
  sectionSelect.value = String(selectedIndex);
  sectionSelect.dataset.raw = headings[selectedIndex].raw;
  updateSectionMoveButtons(headings);
}

function parseHeadings(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  const stack = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2];

    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].index : -1;
    const index = headings.length;
    headings.push({
      index,
      line: i,
      level,
      text,
      parent,
      raw: line.trim(),
      end: lines.length
    });
    stack.push({ level, index });
  }

  for (let i = 0; i < headings.length; i += 1) {
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= headings[i].level) {
        headings[i].end = headings[j].line;
        break;
      }
    }
  }
  return headings;
}

function updateSectionMoveButtons(headings) {
  if (!Array.isArray(headings)) headings = parseHeadings(editor.value);
  const idx = Number(sectionSelect.value);
  if (!headings.length || Number.isNaN(idx) || !headings[idx]) {
    sectionUpBtn.disabled = true;
    sectionDownBtn.disabled = true;
    return;
  }
  sectionSelect.dataset.raw = headings[idx].raw;
  sectionUpBtn.disabled = findSiblingHeadingIndex(headings, idx, -1) < 0;
  sectionDownBtn.disabled = findSiblingHeadingIndex(headings, idx, 1) < 0;
}

function findSiblingHeadingIndex(headings, idx, direction) {
  const current = headings[idx];
  if (!current) return -1;
  if (direction < 0) {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (headings[i].level === current.level && headings[i].parent === current.parent) return i;
    }
    return -1;
  }
  for (let i = idx + 1; i < headings.length; i += 1) {
    if (headings[i].level === current.level && headings[i].parent === current.parent) return i;
  }
  return -1;
}

function moveSelectedSection(direction) {
  const headings = parseHeadings(editor.value);
  const idx = Number(sectionSelect.value);
  if (!headings.length || Number.isNaN(idx) || !headings[idx]) return;
  const siblingIdx = findSiblingHeadingIndex(headings, idx, direction);
  if (siblingIdx < 0) {
    flash("Section cannot move in that direction.");
    return;
  }

  const lines = editor.value.replace(/\r\n/g, "\n").split("\n");
  const current = headings[idx];
  const sibling = headings[siblingIdx];
  const currentSegment = lines.slice(current.line, current.end);
  const siblingSegment = lines.slice(sibling.line, sibling.end);
  let newLines;

  if (direction < 0) {
    const before = lines.slice(0, sibling.line);
    const between = lines.slice(sibling.end, current.line);
    const after = lines.slice(current.end);
    newLines = before.concat(currentSegment, between, siblingSegment, after);
  } else {
    const before = lines.slice(0, current.line);
    const between = lines.slice(current.end, sibling.line);
    const after = lines.slice(sibling.end);
    newLines = before.concat(siblingSegment, between, currentSegment, after);
  }

  pendingHeadingRaw = current.raw;
  editor.value = newLines.join("\n");
  renderFromEditor();
  flash(direction < 0 ? "Section moved up." : "Section moved down.");
}

async function handleCopyForConfluence() {
  try {
    closeConfluenceAssistant();
    const payload = await buildConfluencePayload();
    openConfluenceAssistant(payload);
    flash(
      payload.diagrams.length
        ? "Confluence assistant ready: copy text first, then each visual."
        : "Confluence assistant ready: copy text."
    );
  } catch (err) {
    console.error(err);
    const reason = err?.message ? ` ${err.message}` : "";
    flash(`Copy failed. Could not prepare clipboard payload.${reason}`, true);
  }
}

async function buildConfluencePayload() {
  const clone = preview.cloneNode(true);
  clone.removeAttribute("contenteditable");
  clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));

  const diagramNodes = [...clone.querySelectorAll(".diagram, .text-art-diagram, pre > code")].filter((node) => {
    if (node.classList?.contains("diagram")) return true;
    if (node.classList?.contains("text-art-diagram")) return true;
    return isExportableTextArtCodeNode(node);
  });
  const diagrams = [];
  for (let i = 0; i < diagramNodes.length; i += 1) {
    const target = diagramNodes[i];
    const index = i + 1;
    const placeholder = `[DIAGRAM ${index}]`;

    let pngBlob = null;
    let previewDataUrl = "";
    let fallbackSvgDataUrl = "";
    let downloadBlob = null;
    let downloadFilename = `diagram-${index}.png`;
    let downloadLabel = "Download PNG";
    let unavailableForClipboard = true;
    let kind = "mermaid";
    let sourceLanguage = "mermaid";
    let sourceText = "";
    let replaceNode = target;

    if (target.classList?.contains("diagram")) {
      const wrapper = target;
      const svg = wrapper.querySelector("svg");
      sourceText = wrapper.dataset.source || "";

      if (svg) {
        const normalizedSvg = normalizeSvgForRasterization(svg.outerHTML);
        fallbackSvgDataUrl = svgToDataUrl(normalizedSvg);
        previewDataUrl = fallbackSvgDataUrl;
        downloadBlob = new Blob([normalizedSvg], { type: "image/svg+xml;charset=utf-8" });
        downloadFilename = `diagram-${index}.svg`;
        downloadLabel = "Download SVG";

        try {
          const pngDataUrl = await svgToPngDataUrl(normalizedSvg, 1400);
          pngBlob = dataUrlToBlob(pngDataUrl);
          previewDataUrl = pngDataUrl;
          downloadBlob = pngBlob;
          downloadFilename = `diagram-${index}.png`;
          downloadLabel = "Download PNG";
          unavailableForClipboard = false;
        } catch (err) {
          console.warn(`Mermaid diagram ${index} PNG conversion failed; SVG fallback only.`, err);
        }
      } else {
        const fallbackText = sourceText || placeholder;
        downloadBlob = new Blob([fallbackText], { type: "text/plain;charset=utf-8" });
        downloadFilename = `diagram-${index}.txt`;
        downloadLabel = "Download Source";
        previewDataUrl = "";
      }
    } else if (target.classList?.contains("text-art-diagram")) {
      kind = "text-art";
      sourceLanguage = (target.dataset.language || "text").trim().toLowerCase() || "text";
      sourceText = target.dataset.source || "";
      replaceNode = target;

      const previewImage = target.querySelector("img");
      const dataUrl = previewImage?.src || "";
      try {
        if (dataUrl.startsWith("data:image/png")) {
          pngBlob = dataUrlToBlob(dataUrl);
          previewDataUrl = dataUrl;
          downloadBlob = pngBlob;
          downloadFilename = `diagram-${index}.png`;
          downloadLabel = "Download PNG";
          unavailableForClipboard = false;
        } else {
          const artifact = await buildTextArtRenderArtifact(sourceLanguage, sourceText, {
            pixelRatio: TEXT_ART_PIXEL_RATIO
          });
          pngBlob = dataUrlToBlob(artifact.pngDataUrl);
          previewDataUrl = artifact.pngDataUrl;
          downloadBlob = pngBlob;
          downloadFilename = `diagram-${index}.png`;
          downloadLabel = "Download PNG";
          unavailableForClipboard = false;
        }
      } catch (err) {
        console.warn(`Text-art diagram ${index} PNG conversion failed; source fallback only.`, err);
        downloadBlob = new Blob([sourceText], { type: "text/plain;charset=utf-8" });
        downloadFilename = `diagram-${index}.txt`;
        downloadLabel = "Download Source";
      }
    } else {
      const codeNode = target;
      const language = getCodeLanguage(codeNode);
      sourceLanguage = language || "text";
      sourceText = codeNode.textContent || "";
      kind = "text-art";
      replaceNode = codeNode.parentElement?.tagName?.toLowerCase() === "pre" ? codeNode.parentElement : codeNode;
      try {
        const artifact = await buildTextArtRenderArtifact(sourceLanguage, sourceText, {
          sourceNode: codeNode,
          pixelRatio: TEXT_ART_PIXEL_RATIO
        });
        pngBlob = dataUrlToBlob(artifact.pngDataUrl);
        previewDataUrl = artifact.pngDataUrl;
        downloadBlob = pngBlob;
        downloadFilename = `diagram-${index}.png`;
        downloadLabel = "Download PNG";
        unavailableForClipboard = false;
      } catch (err) {
        console.warn(`Text-art diagram ${index} PNG conversion failed; source fallback only.`, err);
        downloadBlob = new Blob([sourceText], { type: "text/plain;charset=utf-8" });
        downloadFilename = `diagram-${index}.txt`;
        downloadLabel = "Download Source";
      }
    }

    const marker = document.createElement("p");
    marker.textContent = placeholder;
    replaceNode.replaceWith(marker);

    diagrams.push({
      index,
      placeholder,
      kind,
      sourceLanguage,
      sourceText,
      pngBlob,
      previewDataUrl,
      fallbackSvgDataUrl,
      unavailableForClipboard,
      downloadBlob,
      downloadFilename,
      downloadLabel
    });
  }

  clone.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("style");
    if (el.tagName.toLowerCase() === "table") el.setAttribute("border", "1");
  });

  const htmlFragment = clone.innerHTML;
  const html = `<!doctype html><html><body>${htmlFragment}</body></html>`;
  const plainText = `${previewToMarkdown(clone).trimEnd()}\n`;

  return {
    html,
    htmlFragment,
    plainText,
    diagrams
  };
}

async function copyConfluenceTextPayload(payload) {
  const richBlob = new Blob([payload.html], { type: "text/html" });
  const plainBlob = new Blob([payload.plainText], { type: "text/plain" });

  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": richBlob,
          "text/plain": plainBlob
        })
      ]);
      return true;
    } catch (err) {
      console.warn("ClipboardItem rich text write failed.", err);
    }
  }

  if (tryLegacyRichCopy(payload.htmlFragment, payload.plainText)) return true;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(payload.plainText);
      return true;
    } catch (err) {
      console.warn("navigator.clipboard.writeText failed.", err);
    }
  }

  if (tryLegacyPlainCopy(payload.plainText)) return true;
  return false;
}

function tryLegacyRichCopy(htmlFragment, plainText) {
  if (typeof document.execCommand !== "function") return false;

  const selection = window.getSelection();
  const previousRanges = captureSelectionRanges(selection);
  const container = document.createElement("div");
  container.setAttribute("contenteditable", "true");
  container.innerHTML = htmlFragment;
  container.style.position = "fixed";
  container.style.left = "-99999px";
  container.style.top = "0";
  container.style.opacity = "0";
  document.body.appendChild(container);

  let copied = false;
  const onCopy = (event) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/html", htmlFragment);
    event.clipboardData.setData("text/plain", plainText);
    copied = true;
  };

  document.addEventListener("copy", onCopy, true);
  try {
    const range = document.createRange();
    range.selectNodeContents(container);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    copied = document.execCommand("copy") || copied;
  } catch (err) {
    console.warn("Legacy rich copy failed.", err);
  } finally {
    document.removeEventListener("copy", onCopy, true);
    container.remove();
    restoreSelectionRanges(selection, previousRanges);
  }

  return copied;
}

function tryLegacyPlainCopy(text) {
  if (typeof document.execCommand !== "function") return false;

  const selection = window.getSelection();
  const previousRanges = captureSelectionRanges(selection);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-99999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy");
  } catch (err) {
    console.warn("Legacy plain-text copy failed.", err);
  } finally {
    textarea.remove();
    restoreSelectionRanges(selection, previousRanges);
  }

  return copied;
}

function captureSelectionRanges(selection) {
  if (!selection) return [];
  const ranges = [];
  for (let i = 0; i < selection.rangeCount; i += 1) {
    ranges.push(selection.getRangeAt(i).cloneRange());
  }
  return ranges;
}

function restoreSelectionRanges(selection, ranges) {
  if (!selection) return;
  selection.removeAllRanges();
  for (const range of ranges) {
    selection.addRange(range);
  }
}

function openConfluenceAssistant(payload) {
  closeConfluenceAssistant();

  const overlay = document.createElement("div");
  overlay.className = "manual-copy-overlay";

  const panel = document.createElement("div");
  panel.className = "manual-copy-panel";

  const header = document.createElement("div");
  header.className = "manual-copy-header";
  header.innerHTML = "<strong>Copy for Confluence</strong><span>Step 1: paste text. Step 2: paste each visual PNG.</span>";

  const actions = document.createElement("div");
  actions.className = "manual-copy-actions";

  const copyTextBtn = document.createElement("button");
  copyTextBtn.type = "button";
  copyTextBtn.textContent = "Copy Text";

  const textStatus = document.createElement("span");
  textStatus.className = "assistant-text-status";
  textStatus.textContent = "Paste this first in Confluence.";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.className = "ghost";

  actions.append(copyTextBtn, textStatus, closeBtn);

  const body = document.createElement("div");
  body.className = "manual-copy-body";

  const note = document.createElement("p");
  note.className = "assistant-note";
  note.textContent = "After copying text, copy each visual below and paste at matching placeholder [DIAGRAM N].";

  const manualPlainWrap = document.createElement("div");
  manualPlainWrap.className = "assistant-manual hidden";
  const manualPlainLabel = document.createElement("label");
  manualPlainLabel.textContent = "Manual text copy fallback (Ctrl/Cmd+C):";
  const manualPlainBox = document.createElement("textarea");
  manualPlainBox.className = "manual-copy-plain";
  manualPlainBox.setAttribute("readonly", "true");
  manualPlainWrap.append(manualPlainLabel, manualPlainBox);

  const list = document.createElement("div");
  list.className = "assistant-diagram-list";
  if (!payload.diagrams.length) {
    const empty = document.createElement("p");
    empty.className = "assistant-empty";
    empty.textContent = "No exportable Mermaid or text-art visuals detected in this document.";
    list.appendChild(empty);
  }

  const diagramRows = new Map();
  for (const diagram of payload.diagrams) {
    const row = document.createElement("div");
    row.className = "assistant-diagram-item";

    const meta = document.createElement("div");
    meta.className = "assistant-diagram-meta";
    const title = document.createElement("strong");
    title.textContent = `Diagram ${diagram.index}${diagram.kind === "text-art" ? " (Text Art)" : ""}`;
    const placeholder = document.createElement("span");
    placeholder.textContent = diagram.placeholder;
    meta.append(title, placeholder);

    const controls = document.createElement("div");
    controls.className = "assistant-diagram-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = `Copy Diagram ${diagram.index}`;
    copyBtn.disabled = diagram.unavailableForClipboard;
    copyBtn.className = diagram.unavailableForClipboard ? "ghost" : "";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.textContent = diagram.downloadLabel;
    downloadBtn.className = "ghost";
    controls.append(copyBtn, downloadBtn);

    row.append(meta, controls);
    if (diagram.previewDataUrl) {
      const previewImage = document.createElement("img");
      previewImage.className = "assistant-diagram-preview";
      previewImage.src = diagram.previewDataUrl;
      previewImage.alt = `Diagram ${diagram.index} preview`;
      row.appendChild(previewImage);
    }
    if (diagram.unavailableForClipboard) {
      const unavailable = document.createElement("span");
      unavailable.className = "assistant-diagram-warning";
      unavailable.textContent = "Clipboard PNG unavailable for this diagram. Use download fallback.";
      row.appendChild(unavailable);
    }

    copyBtn.addEventListener("click", async () => {
      const state = confluenceAssistantState;
      if (!state) return;
      const artifact = state.payload.diagrams.find((d) => d.index === diagram.index);
      if (!artifact) return;
      if (!artifact.pngBlob || !navigator.clipboard || !window.ClipboardItem) {
        if (downloadArtifact(artifact)) {
          flash(`Diagram ${artifact.index} clipboard blocked; downloaded instead.`);
        } else {
          flash(`Diagram ${artifact.index} clipboard and download unavailable.`, true);
        }
        return;
      }
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "image/png": artifact.pngBlob
          })
        ]);
        copyBtn.textContent = `Diagram ${artifact.index} Copied`;
        copyBtn.disabled = true;
        flash(`Diagram ${artifact.index} copied as PNG.`);
      } catch (err) {
        console.warn(`Diagram ${artifact.index} PNG clipboard write failed.`, err);
        if (downloadArtifact(artifact)) {
          flash(`Diagram ${artifact.index} clipboard blocked; downloaded instead.`);
        } else {
          flash(`Diagram ${artifact.index} clipboard and download unavailable.`, true);
        }
      }
    });

    downloadBtn.addEventListener("click", () => {
      if (downloadArtifact(diagram)) {
        flash(`Diagram ${diagram.index} downloaded.`);
      } else {
        flash(`Diagram ${diagram.index} download unavailable.`, true);
      }
    });

    diagramRows.set(diagram.index, { row, copyBtn, downloadBtn });
    list.appendChild(row);
  }

  copyTextBtn.addEventListener("click", async () => {
    const state = confluenceAssistantState;
    if (!state) return;
    const copied = await copyConfluenceTextPayload(state.payload);
    if (copied) {
      copyTextBtn.textContent = "Text Copied";
      copyTextBtn.disabled = true;
      textStatus.textContent = "Text copied for Confluence.";
      textStatus.classList.remove("error");
      flash("Text copied for Confluence.");
      return;
    }
    textStatus.textContent = "Clipboard blocked. Use manual plain-text fallback below.";
    textStatus.classList.add("error");
    manualPlainWrap.classList.remove("hidden");
    manualPlainBox.value = state.payload.plainText;
    manualPlainBox.focus();
    manualPlainBox.select();
    manualPlainBox.setSelectionRange(0, manualPlainBox.value.length);
    flash("Text clipboard blocked. Manual plain-text fallback selected.", true);
  });

  body.append(note, manualPlainWrap, list);
  panel.append(header, actions, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  closeBtn.addEventListener("click", closeConfluenceAssistant);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeConfluenceAssistant();
  });

  manualCopyOverlay = overlay;
  confluenceAssistantState = {
    overlay,
    payload,
    manualPlainWrap,
    manualPlainBox,
    textStatus,
    diagramRows
  };
  manualCopyKeyHandler = (event) => {
    if (event.key === "Escape") closeConfluenceAssistant();
  };
  document.addEventListener("keydown", manualCopyKeyHandler);
}

function closeConfluenceAssistant() {
  if (manualCopyOverlay) {
    manualCopyOverlay.remove();
    manualCopyOverlay = null;
  }
  confluenceAssistantState = null;
  if (manualCopyKeyHandler) {
    document.removeEventListener("keydown", manualCopyKeyHandler);
    manualCopyKeyHandler = null;
  }
}

function downloadArtifact(artifact) {
  if (!artifact || !artifact.downloadBlob || !artifact.downloadFilename) return false;
  const url = URL.createObjectURL(artifact.downloadBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.downloadFilename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function getCodeLanguage(codeNode) {
  if (!codeNode) return "";
  const className = codeNode.className || "";
  const parts = className.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  const languageClass = parts.find((part) => part.startsWith("language-"));
  if (!languageClass) return "";
  return languageClass.slice("language-".length).toLowerCase();
}

function isExportableTextArtCodeNode(node) {
  if (!node || node.tagName?.toLowerCase() !== "code") return false;
  const language = getCodeLanguage(node);
  return EXPORTABLE_TEXT_ART_LANGS.has(language);
}

function resolveTextArtRenderOptions(sourceNode, language, sourceText) {
  const shouldAvoidDirectProbe =
    sourceNode &&
    sourceNode.nodeType === Node.ELEMENT_NODE &&
    sourceNode.classList?.contains("text-art-diagram");
  let probeNode = shouldAvoidDirectProbe ? null : sourceNode;
  let cleanup = null;
  if (!probeNode || !document.contains(probeNode)) {
    const host = document.createElement("div");
    host.className = "preview";
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "0";
    host.style.visibility = "hidden";
    host.style.pointerEvents = "none";

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = `language-${language || "text"}`;
    code.textContent = sourceText && sourceText.length ? sourceText : "M│";
    pre.appendChild(code);
    host.appendChild(pre);
    document.body.appendChild(host);
    probeNode = code;
    cleanup = () => host.remove();
  }

  let fontSize = TEXT_ART_FONT_SIZE;
  let lineHeight = TEXT_ART_LINE_HEIGHT;
  let rowAdvancePx = 0;
  let tabWidth = TEXT_ART_TAB_WIDTH;
  let fontFamily = TEXT_ART_FONT_STACK.join(", ");
  try {
    const codeStyle = getComputedStyle(probeNode);
    const parsedFontSize = Number.parseFloat(codeStyle.fontSize);
    if (Number.isFinite(parsedFontSize) && parsedFontSize > 0) fontSize = parsedFontSize;

    if (codeStyle.fontFamily) {
      fontFamily = codeStyle.fontFamily;
    }

    const lineHeightRaw = codeStyle.lineHeight || "";
    const parsedLineHeight = Number.parseFloat(lineHeightRaw);
    if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0) {
      if (lineHeightRaw.includes("px")) {
        rowAdvancePx = parsedLineHeight;
        lineHeight = parsedLineHeight / fontSize;
      } else {
        lineHeight = parsedLineHeight;
      }
    }

    const tabSizeRaw = codeStyle.getPropertyValue("tab-size") || codeStyle.getPropertyValue("-moz-tab-size");
    const parsedTabSize = Number.parseFloat(tabSizeRaw);
    if (Number.isFinite(parsedTabSize) && parsedTabSize > 0) {
      tabWidth = Math.floor(parsedTabSize);
    }
  } finally {
    if (cleanup) cleanup();
  }

  return {
    fontSize,
    lineHeight,
    rowAdvancePx,
    tabWidth,
    fontFamily
  };
}

async function buildTextArtRenderArtifact(language, sourceText, context = {}) {
  const safeLanguage = String(language || "text").trim().toLowerCase() || "text";
  const safeSourceText = String(sourceText ?? "");
  const renderOptions = resolveTextArtRenderOptions(context.sourceNode || null, safeLanguage, safeSourceText);
  const safePadding = Number(context.padding) >= 0 ? Number(context.padding) : TEXT_ART_PADDING;
  const safePixelRatio = Number(context.pixelRatio) > 0 ? Number(context.pixelRatio) : TEXT_ART_PIXEL_RATIO;
  const cacheKey = [
    "text-art",
    safeLanguage,
    normalizeFenceSourceForComparison(safeSourceText),
    Number(renderOptions.fontSize) || TEXT_ART_FONT_SIZE,
    Number(renderOptions.lineHeight) || TEXT_ART_LINE_HEIGHT,
    Number(renderOptions.rowAdvancePx) || 0,
    Number(renderOptions.tabWidth) || TEXT_ART_TAB_WIDTH,
    String(renderOptions.fontFamily || TEXT_ART_FONT_STACK.join(", ")),
    safePadding,
    safePixelRatio
  ].join("|");

  const cached = readRenderCache(textArtArtifactCache, cacheKey);
  if (cached) {
    return {
      language: cached.language,
      sourceText: cached.sourceText,
      pngDataUrl: cached.pngDataUrl,
      width: cached.width,
      height: cached.height,
      metrics: { ...(cached.metrics || {}) },
      fromCache: true
    };
  }

  const raster = await rasterizeTextArtToPng(safeSourceText, {
    ...renderOptions,
    padding: safePadding,
    pixelRatio: safePixelRatio
  });

  const artifact = {
    language: safeLanguage,
    sourceText: safeSourceText,
    pngDataUrl: raster.pngDataUrl,
    width: raster.width,
    height: raster.height,
    metrics: raster.metrics,
    fromCache: false
  };
  writeRenderCache(textArtArtifactCache, cacheKey, artifact);
  return artifact;
}

async function rasterizeTextArtToPng(sourceText, options = {}) {
  await ensureTextArtFontReady(options.fontSize || TEXT_ART_FONT_SIZE);
  const normalizedText = normalizeTextArtForRasterization(sourceText, options.tabWidth ?? TEXT_ART_TAB_WIDTH);
  const lines = normalizedText.split("\n");
  const fontSize = Number(options.fontSize) > 0 ? Number(options.fontSize) : TEXT_ART_FONT_SIZE;
  const lineHeight = Number(options.lineHeight) > 0 ? Number(options.lineHeight) : TEXT_ART_LINE_HEIGHT;
  const rowAdvancePx = Number(options.rowAdvancePx) > 0 ? Number(options.rowAdvancePx) : 0;
  const padding = Number(options.padding) >= 0 ? Number(options.padding) : TEXT_ART_PADDING;
  const pixelRatio = Number(options.pixelRatio) > 0 ? Number(options.pixelRatio) : TEXT_ART_PIXEL_RATIO;
  const fontFamily = options.fontFamily || TEXT_ART_FONT_STACK.join(", ");
  const font = `${fontSize}px ${fontFamily}`;
  const metrics = measureTextArtFontMetrics(font, fontSize, lineHeight, rowAdvancePx);

  const lineChars = lines.map((line) => Array.from(line));
  const rowCount = Math.max(1, lineChars.length);
  const colCount = Math.max(1, ...lineChars.map((chars) => chars.length));
  const contentWidth = Math.max(1, colCount * metrics.charAdvance);
  const contentHeight = Math.max(1, rowCount * metrics.rowAdvance);
  const cssWidth = Math.max(1, contentWidth + padding * 2);
  const cssHeight = Math.max(1, contentHeight + padding * 2);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
  canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111111";
  for (let row = 0; row < lineChars.length; row += 1) {
    const chars = lineChars[row];
    const y = padding + row * metrics.rowAdvance + metrics.baseline;
    for (let col = 0; col < chars.length; col += 1) {
      const value = chars[col];
      if (value === " ") continue;
      const x = padding + col * metrics.charAdvance;
      ctx.fillText(value, x, y);
    }
  }

  return {
    pngDataUrl: canvas.toDataURL("image/png"),
    width: Math.round(cssWidth),
    height: Math.round(cssHeight),
    metrics: {
      ...metrics,
      fontSize,
      lineHeight,
      tabWidth: Number(options.tabWidth) > 0 ? Number(options.tabWidth) : TEXT_ART_TAB_WIDTH,
      fontFamily
    }
  };
}

function measureTextArtFontMetrics(font, fontSize, lineHeight, rowAdvancePx) {
  const probeCanvas = document.createElement("canvas");
  const probeCtx = probeCanvas.getContext("2d");
  if (!probeCtx) throw new Error("Canvas 2D context unavailable.");
  probeCtx.font = font;

  const widthMetrics = probeCtx.measureText("M");
  const boxVertMetrics = probeCtx.measureText("│");
  const charAdvance = Math.max(1, Math.ceil(widthMetrics.width || Number(fontSize) * 0.6));

  let ascent = NaN;
  let descent = NaN;
  if (
    Number.isFinite(boxVertMetrics.actualBoundingBoxAscent) &&
    Number.isFinite(boxVertMetrics.actualBoundingBoxDescent)
  ) {
    ascent = Math.ceil(boxVertMetrics.actualBoundingBoxAscent);
    descent = Math.ceil(boxVertMetrics.actualBoundingBoxDescent);
  } else if (
    Number.isFinite(widthMetrics.fontBoundingBoxAscent) &&
    Number.isFinite(widthMetrics.fontBoundingBoxDescent)
  ) {
    ascent = Math.ceil(widthMetrics.fontBoundingBoxAscent);
    descent = Math.ceil(widthMetrics.fontBoundingBoxDescent);
  } else {
    ascent = Math.ceil(Number(fontSize) * 0.8);
    descent = Math.ceil(Number(fontSize) * 0.2);
  }

  if (!(ascent > 0)) ascent = Math.max(1, Math.ceil(Number(fontSize) * 0.8));
  if (!(descent >= 0)) descent = Math.max(0, Math.ceil(Number(fontSize) * 0.2));
  const glyphHeight = Math.max(1, ascent + descent);
  const multiplier = Number(lineHeight) > 0 ? Number(lineHeight) : 1;
  const rowAdvance = Number(rowAdvancePx) > 0
    ? Math.max(1, Math.round(Number(rowAdvancePx)))
    : Math.max(1, Math.ceil(glyphHeight * multiplier));
  const charHeight = Math.max(1, glyphHeight);
  const topInset = Math.max(0, Math.floor((rowAdvance - glyphHeight) / 2));
  const baseline = topInset + ascent;

  return {
    charWidth: charAdvance,
    charAdvance,
    charRenderWidth: charAdvance,
    charHeight,
    rowAdvance,
    baseline
  };
}

function normalizeTextArtForRasterization(text, tabWidth) {
  const width = Number(tabWidth) > 0 ? Math.floor(Number(tabWidth)) : TEXT_ART_TAB_WIDTH;
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ".repeat(width));
}

async function ensureTextArtFontReady(fontSize) {
  if (!document.fonts || typeof document.fonts.load !== "function") return;
  if (!textArtFontReadyPromise) {
    const size = Number(fontSize) > 0 ? Number(fontSize) : TEXT_ART_FONT_SIZE;
    textArtFontReadyPromise = document.fonts.load(`${size}px "Source Code Pro"`).catch((err) => {
      console.warn("Source Code Pro font load failed; using fallback monospace fonts.", err);
    });
  }
  await textArtFontReadyPromise;
}

async function svgToPngDataUrl(svgString, maxWidth) {
  const normalized = normalizeSvgForRasterization(svgString);
  const blob = new Blob([normalized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const safeWidth = img.width || maxWidth || 1400;
    const safeHeight = img.height || Math.round(safeWidth * 0.62);
    const scale = safeWidth > maxWidth ? maxWidth / safeWidth : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(safeWidth * scale));
    canvas.height = Math.max(1, Math.round(safeHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function normalizeSvgForRasterization(svgString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") return svgString;

  if (!svg.getAttribute("xmlns")) {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!svg.getAttribute("xmlns:xlink")) {
    svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  }

  let width = parseFloat(svg.getAttribute("width"));
  let height = parseFloat(svg.getAttribute("height"));
  if (!(width > 0) || !(height > 0)) {
    const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/\s+/);
    if (viewBox.length === 4) {
      width = Number(viewBox[2]);
      height = Number(viewBox[3]);
    }
  }
  if (!(width > 0) || !(height > 0)) {
    width = 1400;
    height = 860;
  }

  svg.setAttribute("width", `${Math.round(width)}`);
  svg.setAttribute("height", `${Math.round(height)}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");

  const serializer = new XMLSerializer();
  return serializer.serializeToString(svg);
}

function svgToDataUrl(svgString) {
  const normalized = normalizeSvgForRasterization(svgString);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized)}`;
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  if (parts.length < 2) {
    throw new Error("Invalid data URL.");
  }
  const mimeMatch = parts[0].match(/data:(.*?)(;base64)?$/);
  const mime = mimeMatch && mimeMatch[1] ? mimeMatch[1] : "application/octet-stream";
  const isBase64 = /;base64$/i.test(parts[0]);
  if (isBase64) {
    const binary = atob(parts[1]);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(parts[1])], { type: mime });
}

async function handleEditorPaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  await insertImageIntoEditor(file);
}

async function handlePreviewPaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  await insertImageIntoEditor(file);
}

function handleEditorDragOver(event) {
  event.preventDefault();
}

async function handleEditorDrop(event) {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  const image = files.find((f) => f.type.startsWith("image/"));
  if (!image) return;
  await insertImageIntoEditor(image);
}

async function insertImageIntoEditor(file) {
  const dataUrl = await fileToDataUrl(file);
  const safeName = file.name || "screenshot.png";
  const snippet = `\n![${safeName}](${dataUrl})\n`;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const current = editor.value;
  editor.value = `${current.slice(0, start)}${snippet}${current.slice(end)}`;
  editor.selectionStart = editor.selectionEnd = start + snippet.length;
  renderFromEditor();
  flash("Image inserted into markdown.");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resetDocument() {
  editor.value = SAMPLE;
  renderFromEditor();
}

function flash(message, isError = false) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = isError ? "toast error" : "toast";
  toast.style.opacity = "1";
  setTimeout(() => {
    toast.style.opacity = "0";
  }, 2200);
}
