const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mdtoolFs", {
  openFolder: () => ipcRenderer.invoke("workspace:open-folder"),
  openFolderFromPath: (rootPath) => ipcRenderer.invoke("workspace:open-folder-from-path", rootPath),
  listFiles: (workspaceId) => ipcRenderer.invoke("workspace:list-files", workspaceId),
  openFile: (workspaceId, relativePath) => ipcRenderer.invoke("workspace:open-file", workspaceId, relativePath),
  saveFile: (workspaceId, relativePath, content, baseVersion) =>
    ipcRenderer.invoke("workspace:save-file", workspaceId, relativePath, content, baseVersion),
  saveFileAs: (workspaceId, suggestedName, content) =>
    ipcRenderer.invoke("workspace:save-file-as", workspaceId, suggestedName, content),
  startWatch: (workspaceId) => ipcRenderer.invoke("workspace:start-watch", workspaceId),
  stopWatch: (workspaceId) => ipcRenderer.invoke("workspace:stop-watch", workspaceId),
  compileMdx: (source) => ipcRenderer.invoke("mdx:compile", source),
  onWorkspaceEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:event", handler);
    return () => ipcRenderer.removeListener("workspace:event", handler);
  }
});
