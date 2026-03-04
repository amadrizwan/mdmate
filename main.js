const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const crypto = require("crypto");
const chokidar = require("chokidar");
const { Worker } = require("worker_threads");

const workspaces = new Map();
let nextWorkspaceId = 1;
let mainWindow = null;

function normalizeText(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function fromPosix(p) {
  return p.split("/").join(path.sep);
}

function isMarkdownPath(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

async function hashContent(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function computeVersion(absPath, contentHint = null) {
  const stat = await fs.stat(absPath);
  const content = contentHint == null ? normalizeText(await fs.readFile(absPath, "utf8")) : normalizeText(contentHint);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: await hashContent(content)
  };
}

function sameVersion(a, b) {
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function getWorkspace(workspaceId) {
  const ws = workspaces.get(Number(workspaceId));
  if (!ws) throw new Error("Workspace not found.");
  return ws;
}

function resolveWorkspacePath(ws, relativePath) {
  const rel = fromPosix(relativePath || "");
  const absPath = path.resolve(ws.rootPath, rel);
  const root = path.resolve(ws.rootPath);
  if (!(absPath === root || absPath.startsWith(`${root}${path.sep}`))) {
    throw new Error("Path is outside the workspace.");
  }
  return absPath;
}

function relPath(rootPath, absPath) {
  return toPosix(path.relative(rootPath, absPath));
}

async function indexMarkdownFiles(rootPath) {
  const files = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isMarkdownPath(entry.name)) continue;
      files.push(relPath(rootPath, abs));
    }
  }

  await walk(rootPath);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function ensureWorkspaceFromPath(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const existing = [...workspaces.values()].find((ws) => ws.rootPath === resolvedRoot);
  if (existing) {
    const files = await indexMarkdownFiles(existing.rootPath);
    return { workspaceId: existing.workspaceId, rootPath: existing.rootPath, files };
  }

  const stat = await fs.stat(resolvedRoot);
  if (!stat.isDirectory()) throw new Error("Selected path is not a directory.");

  const workspaceId = nextWorkspaceId++;
  workspaces.set(workspaceId, {
    workspaceId,
    rootPath: resolvedRoot,
    watcher: null,
    pendingUnlinks: []
  });

  const files = await indexMarkdownFiles(resolvedRoot);
  return { workspaceId, rootPath: resolvedRoot, files };
}

function emitWorkspaceEvent(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:event", payload);
    }
  }
}

async function buildFileEvent(workspaceId, type, relativePath, oldRelativePath = null) {
  const ws = getWorkspace(workspaceId);
  const payload = {
    workspaceId,
    type,
    relativePath: toPosix(relativePath)
  };
  if (oldRelativePath) payload.oldRelativePath = toPosix(oldRelativePath);

  if (type !== "deleted") {
    try {
      const abs = resolveWorkspacePath(ws, relativePath);
      payload.version = await computeVersion(abs);
    } catch (err) {
      // Ignore version lookup errors for transient watcher events.
    }
  }
  return payload;
}

async function startWorkspaceWatch(workspaceId) {
  const ws = getWorkspace(workspaceId);
  if (ws.watcher) return { ok: true };
  ws.pendingUnlinks = [];
  const RENAME_WINDOW_MS = 800;

  const watcher = chokidar.watch(["**/*.md", "**/*.markdown", "**/*.mdx"], {
    cwd: ws.rootPath,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 120,
      pollInterval: 20
    }
  });

  watcher.on("add", async (relativePath) => {
    const normalized = toPosix(relativePath);
    const addDir = path.posix.dirname(normalized);
    const now = Date.now();

    ws.pendingUnlinks = ws.pendingUnlinks.filter((candidate) => now - candidate.ts <= RENAME_WINDOW_MS);
    const candidateIdx = ws.pendingUnlinks.findIndex((candidate) => candidate.dir === addDir);
    if (candidateIdx >= 0) {
      const candidate = ws.pendingUnlinks.splice(candidateIdx, 1)[0];
      if (candidate.timer) clearTimeout(candidate.timer);
      const payload = await buildFileEvent(workspaceId, "renamed", normalized, candidate.relativePath);
      emitWorkspaceEvent(payload);
      return;
    }

    const payload = await buildFileEvent(workspaceId, "added", normalized);
    emitWorkspaceEvent(payload);
  });

  watcher.on("change", async (relativePath) => {
    const payload = await buildFileEvent(workspaceId, "changed", relativePath);
    emitWorkspaceEvent(payload);
  });

  watcher.on("unlink", async (relativePath) => {
    const normalized = toPosix(relativePath);
    const pending = {
      relativePath: normalized,
      dir: path.posix.dirname(normalized),
      ts: Date.now(),
      timer: null
    };

    pending.timer = setTimeout(async () => {
      const idx = ws.pendingUnlinks.findIndex((candidate) => candidate === pending);
      if (idx >= 0) ws.pendingUnlinks.splice(idx, 1);
      const payload = await buildFileEvent(workspaceId, "deleted", normalized);
      emitWorkspaceEvent(payload);
    }, RENAME_WINDOW_MS);

    ws.pendingUnlinks.push(pending);
  });

  watcher.on("error", (error) => {
    emitWorkspaceEvent({ workspaceId, type: "error", message: String(error) });
  });

  ws.watcher = watcher;
  return { ok: true };
}

async function stopWorkspaceWatch(workspaceId) {
  const ws = getWorkspace(workspaceId);
  for (const pending of ws.pendingUnlinks || []) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  ws.pendingUnlinks = [];
  if (!ws.watcher) return { ok: true };
  await ws.watcher.close();
  ws.watcher = null;
  return { ok: true };
}

async function openFilePayload(workspaceId, relativePath) {
  const ws = getWorkspace(workspaceId);
  const absPath = resolveWorkspacePath(ws, relativePath);
  const raw = await fs.readFile(absPath, "utf8");
  const content = normalizeText(raw);
  const version = await computeVersion(absPath, content);
  return { content, version };
}

async function saveFileWithVersion(workspaceId, relativePath, content, baseVersion) {
  const ws = getWorkspace(workspaceId);
  const absPath = resolveWorkspacePath(ws, relativePath);

  let diskContent;
  let diskVersion;
  try {
    const raw = await fs.readFile(absPath, "utf8");
    diskContent = normalizeText(raw);
    diskVersion = await computeVersion(absPath, diskContent);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      diskContent = "";
      diskVersion = null;
    } else {
      throw err;
    }
  }

  if (baseVersion && diskVersion && !sameVersion(baseVersion, diskVersion)) {
    return {
      conflict: true,
      diskContent,
      diskVersion
    };
  }

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const normalizedContent = normalizeText(content);
  await fs.writeFile(absPath, normalizedContent, "utf8");
  const version = await computeVersion(absPath, normalizedContent);

  return {
    ok: true,
    version
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 660,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

// MDX worker thread (lazy-spawned)
let mdxWorker = null;
let mdxRequestId = 0;
const mdxPending = new Map();

function flushMdxPending(error) {
  for (const entry of mdxPending.values()) {
    clearTimeout(entry.timeout);
    entry.resolve({ html: null, error });
  }
  mdxPending.clear();
}

function getMdxWorker() {
  if (!mdxWorker) {
    mdxWorker = new Worker(path.join(__dirname, "mdx-worker.mjs"));
    mdxWorker.on("message", ({ id, html, error }) => {
      const entry = mdxPending.get(id);
      if (entry) {
        clearTimeout(entry.timeout);
        mdxPending.delete(id);
        entry.resolve({ html, error });
      }
    });
    mdxWorker.on("error", (err) => {
      flushMdxPending(String(err.message || err));
      mdxWorker = null;
    });
    mdxWorker.on("exit", (code) => {
      flushMdxPending(`MDX worker exited unexpectedly (code ${code})`);
      mdxWorker = null;
    });
  }
  return mdxWorker;
}

const MDX_COMPILE_TIMEOUT_MS = 10000;

ipcMain.handle("mdx:compile", (_event, source) => {
  if (typeof source !== "string") {
    return { html: null, error: "Invalid source: expected string" };
  }
  return new Promise((resolve) => {
    const id = ++mdxRequestId;
    const timeout = setTimeout(() => {
      mdxPending.delete(id);
      resolve({ html: null, error: "MDX compilation timed out" });
    }, MDX_COMPILE_TIMEOUT_MS);
    mdxPending.set(id, { resolve, timeout });
    getMdxWorker().postMessage({ id, source });
  });
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (mdxWorker) {
    flushMdxPending("Application shutting down");
    await mdxWorker.terminate();
    mdxWorker = null;
  }
  await Promise.all(
    [...workspaces.values()].map(async (ws) => {
      for (const pending of ws.pendingUnlinks || []) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      ws.pendingUnlinks = [];
      if (ws.watcher) {
        await ws.watcher.close();
      }
    })
  );
});

ipcMain.handle("workspace:open-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  return ensureWorkspaceFromPath(result.filePaths[0]);
});

ipcMain.handle("workspace:open-folder-from-path", async (_event, rootPath) => {
  try {
    if (!rootPath || typeof rootPath !== "string") return { canceled: true };
    if (!fssync.existsSync(rootPath)) return { canceled: true };
    return await ensureWorkspaceFromPath(rootPath);
  } catch (err) {
    return { canceled: true, error: String(err) };
  }
});

ipcMain.handle("workspace:list-files", async (_event, workspaceId) => {
  const ws = getWorkspace(workspaceId);
  const files = await indexMarkdownFiles(ws.rootPath);
  return { files };
});

ipcMain.handle("workspace:open-file", async (_event, workspaceId, relativePath) => {
  return openFilePayload(workspaceId, relativePath);
});

ipcMain.handle("workspace:save-file", async (_event, workspaceId, relativePath, content, baseVersion) => {
  return saveFileWithVersion(workspaceId, relativePath, content, baseVersion);
});

ipcMain.handle("workspace:save-file-as", async (_event, workspaceId, suggestedName, content) => {
  const ws = getWorkspace(workspaceId);
  const defaultPath = path.join(ws.rootPath, suggestedName || "copy.md");
  const result = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const absPath = path.resolve(result.filePath);
  const root = path.resolve(ws.rootPath);
  if (!(absPath === root || absPath.startsWith(`${root}${path.sep}`))) {
    throw new Error("Save As target must be inside the current workspace.");
  }

  const normalizedContent = normalizeText(content);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, normalizedContent, "utf8");

  const version = await computeVersion(absPath, normalizedContent);
  return {
    relativePath: relPath(ws.rootPath, absPath),
    version
  };
});

ipcMain.handle("workspace:start-watch", async (_event, workspaceId) => {
  return startWorkspaceWatch(workspaceId);
});

ipcMain.handle("workspace:stop-watch", async (_event, workspaceId) => {
  return stopWorkspaceWatch(workspaceId);
});
