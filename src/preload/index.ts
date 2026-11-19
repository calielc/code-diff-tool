import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'
import type { CodeDiffApi } from '../shared/types'

// Only typed functions are exposed. No raw ipcRenderer, no way to start a process.
const api: CodeDiffApi = {
  app: {
    checkTools: () => ipcRenderer.invoke(CH.checkTools),
    getState: () => ipcRenderer.invoke(CH.getState),
    findRootCandidate: () => ipcRenderer.invoke(CH.findRootCandidate),
    chooseRoot: () => ipcRenderer.invoke(CH.chooseRoot),
    setRoot: (path) => ipcRenderer.invoke(CH.setRoot, path)
  },
  reviews: {
    addTo: (input) => ipcRenderer.invoke(CH.reviewsAddTo, input),
    list: () => ipcRenderer.invoke(CH.reviewsList),
    check: (input) => ipcRenderer.invoke(CH.reviewsCheck, input),
    create: (input) => ipcRenderer.invoke(CH.reviewsCreate, input),
    open: (slug) => ipcRenderer.invoke(CH.reviewsOpen, slug),
    build: (slug) => ipcRenderer.invoke(CH.reviewsBuild, slug),
    cancelBuild: (slug) => ipcRenderer.invoke(CH.reviewsCancelBuild, slug),
    onBuildProgress: (cb) => {
      const listener = (_e: unknown, p: Parameters<typeof cb>[0]): void => cb(p)
      ipcRenderer.on(CH.reviewsBuildProgress, listener)
      return () => ipcRenderer.removeListener(CH.reviewsBuildProgress, listener)
    },
    deleteInfo: (slug) => ipcRenderer.invoke(CH.reviewsDeleteInfo, slug),
    delete: (slug) => ipcRenderer.invoke(CH.reviewsDelete, slug)
  },
  comments: {
    list: (slug) => ipcRenderer.invoke(CH.commentsList, slug),
    save: (slug, comment) => ipcRenderer.invoke(CH.commentsSave, { slug, comment }),
    remove: (slug, id) => ipcRenderer.invoke(CH.commentsRemove, { slug, id }),
    post: (slug, comment, draft) => ipcRenderer.invoke(CH.commentsPost, { slug, comment, draft })
  },
  notes: { delete: (slug, mr, noteId) => ipcRenderer.invoke(CH.notesDelete, { slug, mr, noteId }) },
  threads: { resolve: (slug, mr, thread, resolved) => ipcRenderer.invoke(CH.threadsResolve, { slug, mr, thread, resolved }) },
  review: { submit: (input) => ipcRenderer.invoke(CH.reviewSubmit, input) },
  watch: {
    start: (slug, heads) => ipcRenderer.invoke(CH.watchStart, { slug, heads }),
    stop: (slug) => ipcRenderer.invoke(CH.watchStop, slug),
    onEvent: (cb) => {
      const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
      ipcRenderer.on(CH.watchEvent, listener)
      return () => ipcRenderer.removeListener(CH.watchEvent, listener)
    }
  },
  issues: {
    getFile: (slug, key) => ipcRenderer.invoke(CH.issuesGetFile, { slug, key }),
    add: (slug, values) => ipcRenderer.invoke(CH.issuesAdd, { slug, values }),
    pickFiles: () => ipcRenderer.invoke(CH.issuesPickFiles),
    addFiles: (slug, pick) => ipcRenderer.invoke(CH.issuesAddFiles, { slug, pick })
  },
  chat: {
    start: (req) => ipcRenderer.invoke(CH.chatStart, req),
    cancel: (id) => ipcRenderer.invoke(CH.chatCancel, id),
    onEvent: (cb) => {
      const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
      ipcRenderer.on(CH.chatEvent, listener)
      return () => ipcRenderer.removeListener(CH.chatEvent, listener)
    }
  },
  flow: {
    get: (slug) => ipcRenderer.invoke(CH.flowGet, slug),
    onState: (cb) => {
      const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
      ipcRenderer.on(CH.flowState, listener)
      return () => ipcRenderer.removeListener(CH.flowState, listener)
    }
  },
  ai: {
    get: (slug) => ipcRenderer.invoke(CH.aiGet, slug),
    start: (req) => ipcRenderer.invoke(CH.aiStart, req),
    stop: (slug, kind) => ipcRenderer.invoke(CH.aiStop, { slug, kind }),
    setPicks: (p) => ipcRenderer.invoke(CH.aiPicks, p),
    pickSkillsFolder: (slug) => ipcRenderer.invoke(CH.aiPickSkills, slug),
    onChanged: (cb) => {
      const listener = (_e: unknown, m: Parameters<typeof cb>[0]): void => cb(m)
      ipcRenderer.on(CH.aiChanged, listener)
      return () => ipcRenderer.removeListener(CH.aiChanged, listener)
    }
  },
  llm: {
    get: () => ipcRenderer.invoke(CH.llmGet),
    set: (config) => ipcRenderer.invoke(CH.llmSet, config)
  },
  access: {
    save: (input) => ipcRenderer.invoke(CH.accessSave, input),
    remove: (kind, host) => ipcRenderer.invoke(CH.accessRemove, { kind, host })
  },
  dev: { readChange: (url) => ipcRenderer.invoke(CH.devReadChange, url) },
  theme: {
    get: () => ipcRenderer.invoke(CH.themeGet),
    choose: (id) => ipcRenderer.invoke(CH.themeChoose, id),
    onSet: (cb) => {
      const listener = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on(CH.themeSet, listener)
      return () => ipcRenderer.removeListener(CH.themeSet, listener)
    }
  },
  launch: {
    take: () => ipcRenderer.invoke(CH.launchTake),
    onNew: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(CH.launchNew, listener)
      return () => ipcRenderer.removeListener(CH.launchNew, listener)
    }
  },
  events: {
    onOpenDev: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(CH.menuOpenDev, listener)
      return () => ipcRenderer.removeListener(CH.menuOpenDev, listener)
    }
  },
  system: {
    copyText: (text) => ipcRenderer.invoke(CH.copyText, text),
    openExternal: (url) => ipcRenderer.invoke(CH.openExternal, url)
  }
}

contextBridge.exposeInMainWorld('codeDiff', api)
