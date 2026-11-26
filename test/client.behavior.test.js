/**
 * 客户端行为回归：不起浏览器，用一套最小 React/DOM 假实现把 client.js 真跑起来。
 *
 * 覆盖 0.3.5 的四项改动，每一项都是「能抓到 bug」的断言，不是烟雾测试：
 *
 *   1. 传输提示：开始 → 已完成 → 5 秒后自动消失
 *   2. 拖放上传：右键没有「拖动上传」；拖到右侧文件区松手即传
 *   3. 传输记录「定位」：下载走本机资源管理器，上传跳网盘目录
 *   4. 左树稳定：在根目录刷新之后不会塌成只剩一个 /
 *
 * 跑法：node --test test/client.behavior.test.js
 */

import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { test, describe, before } from 'node:test'
import vm from 'node:vm'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 最小 React
function makeReact() {
  const state = { hookIndex: 0, hookStore: [], pendingEffects: [] }

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      }
    },
    useState(initial) {
      const i = state.hookIndex++
      if (!(i in state.hookStore)) {
        state.hookStore[i] = typeof initial === 'function' ? initial() : initial
      }
      return [
        state.hookStore[i],
        (next) => {
          state.hookStore[i] = typeof next === 'function' ? next(state.hookStore[i]) : next
        },
      ]
    },
    useRef(initial) {
      const i = state.hookIndex++
      if (!(i in state.hookStore)) state.hookStore[i] = { current: initial }
      return state.hookStore[i]
    },
    useEffect(fn, deps) {
      const i = state.hookIndex++
      const prev = state.hookStore[i]
      const changed =
        !prev || !deps || !prev.deps || deps.some((d, idx) => d !== prev.deps[idx])
      if (changed) {
        state.hookStore[i] = { deps, cleanup: null }
        state.pendingEffects.push({ fn })
      }
    },
  }
  React.useLayoutEffect = React.useEffect
  React.useMemo = (fn) => fn()
  React.useCallback = (fn) => fn()
  return { React, state }
}

// ---------------------------------------------------------------- 最小 DOM
function makeElement(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    childNodes: [],
    parentNode: null,
    parentElement: null,
    attributes: {},
    textContent: '',
    className: '',
    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child },
    removeChild(child) { return child },
    setAttribute(k, v) { this.attributes[k] = v },
    getAttribute(k) { return this.attributes[k] },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return { length: 0, item: () => null } },
    contains() { return false },
    focus() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }
    },
  }
}

/**
 * 把面板挂起来，返回一组操作句柄。
 *
 * 这是整套测试的地基：client.js 是 __ModuleLoader__ 里的工厂，所以这里
 * 造一个假 loader 接到注册、给一个假 React、一个假 document / window，
 * 然后就能像 React 一样反复 render + 跑 effect。
 */
function createHarness({ source = SRC } = {}) {
  const { React, state } = makeReact()

  const doc = {
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    createElement: makeElement,
    getElementById() { return null },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return { length: 0, item: () => null } },
    execCommand() { return true },
  }

  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(fn) { return setTimeout(fn, 0) },
    cancelAnimationFrame() {},
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
      setItem(k, v) { this.store.set(k, String(v)) },
      removeItem(k) { this.store.delete(k) },
    },
    document: doc,
    open() { return null },
    confirm() { return true },
    /**
     * 🔴 0.4.4 第 7 条：**故意不提供 window.prompt**。
     *
     * Electron 没有实现 window.prompt —— 老代码 `window.prompt(...)` 永远拿不到
     * 用户输入（返回 null 或直接抛），于是「重命名」静默失效。
     * 这里把 prompt 设为 undefined，就是为了让「又用回 prompt」的退化立刻被测试抓到。
     */
    prompt: undefined,
  }

  const loader = {
    def: null,
    load(def) { this.def = def },
  }
  Object.defineProperty(win, '__ModuleLoader__', { get: () => loader })

  const xhrLog = []
  /**
   * 假 XHR：拖拽 / 选文件上传走的就是它（不是 fetch —— fetch 拿不到上行进度）。
   *
   * 🔴 它会**真的去调 backendUpload**，跟 fetch 那条路共用同一份假后端状态。
   * 以前这里硬编码回 `jobId: 'drop-1'`，而假后端的任务表里登记的是别的 id ——
   * 于是「上传完成后该刷新目录」那条链根本对不上号，测试测了个寂寞。
   */
  let backendUpload = null
  /**
   * 🔴 0.5.4：人为给 /list 加延迟的开关。
   *
   * 为什么要它：乐观更新要验证的是「**网络还没回来**时界面就已经变了」。
   * 假后端是同步返回的，settle(2) 就已经把往返走完了 —— 于是「有没有乐观更新」
   * 测出来一模一样，A/B 对照过不了（去掉修复测试仍然绿，说明没测到真问题）。
   *
   * 打开之后 /list 会延迟 backendListDelayMs 毫秒，我们就能在「请求在飞」的
   * 那一刻检查界面。
   */
  let backendListDelayMs = 0
  /** 让 /move 慢下来（毫秒）。139 的 batchMove 实测确实要好几秒。 */
  let backendMoveDelayMs = 0
  class FakeXHR {
    constructor() {
      this.upload = {}
      this.status = 200
      this.responseText = ''
    }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader() {}
    send(body) {
      xhrLog.push({ method: this.method, url: this.url, body })
      this.status = 200
      const doc = backendUpload ? backendUpload(this.url, body) : { ok: true, jobId: 'drop-1' }
      this.responseText = JSON.stringify(doc)
      if (this.upload && typeof this.upload.onprogress === 'function') {
        this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 })
      }
      setTimeout(() => { if (typeof this.onload === 'function') this.onload() }, 0)
    }
  }

  const sandbox = {
    window: win,
    document: doc,
    navigator: { clipboard: null },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    XMLHttpRequest: FakeXHR,
    localStorage: win.localStorage,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    fetch: (...args) => globalThis.fetch(...args),
    AbortController,
    URL,
    undefined,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  assert.ok(loader.def, 'client.js 没有调用 __ModuleLoader__.load')
  const mod = loader.def.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected require: ' + name)
  })

  // ---- 假后端 ----
  const calls = []
  const backend = {
    status: {
      ok: true,
      authorized: true,
      accountMasked: '138******00',
      expiresAt: Date.now() + 20 * 864e5,
      credentialFileName: 'authorization.dpapi',
      quota: { totalBytes: 1e11, usedBytes: 4e10, freeBytes: 6e10 },
      defaultDownloadDir: 'D:\\Downloads\\dsh-mcloud',
    },
    items: [{ id: 'X', name: 'x.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' }],
    /** 按目录 id 指定该目录下有什么；没指定的目录视为空目录。 */
    children: null,
    jobs: [],
    nextCursor: null,
    locatable: null,
  }

  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const body = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ path, body })
    const json = (data) => ({
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    })
    if (path.startsWith('/api/dsh-mcloud/status')) return json(backend.status)
    /**
     * 上传完成后的假后端状态：任务表 + 目录内容都跟着变。
     *
     * 拖拽上传走 XHR（/upload-body），它的响应也走这里 —— 两条路必须产生**同一个**
     * jobId，否则客户端「盯住自己起的那个上传任务」的机制就失效了。
     */
    const finishUpload = (name) => {
      backend.jobs = [{
        id: 'upload-1', kind: 'upload', label: name || 'new.txt', phase: 'complete',
        done: 10, total: 10, state: 'done', error: null,
        startedAt: Date.now(), finishedAt: Date.now(),
        canRevealLocal: false, hasLocalPath: false,
        parentFileId: '/', parentPath: null,
      }]
      const nextName = name || 'new.txt'
      backend.items = backend.items.filter((it) => it.id !== 'NEWFILE').concat([{
        id: 'NEWFILE', name: nextName, size: 10, type: 'file', updatedAt: '2026-11-19 12:00:00',
      }])
      return { ok: true, jobId: 'upload-1', name: nextName }
    }

    // XHR（/upload-body）与 fetch（/upload）共用这一份逻辑
    backendUpload = (url, body) => {
      const query = String(url).includes('?') ? String(url).slice(String(url).indexOf('?')) : ''
      const params = new URLSearchParams(query)
      return finishUpload(params.get('name') || (body && body.name) || 'new.txt')
    }

    if (path.startsWith('/api/dsh-mcloud/list')) {
      if (backendListDelayMs > 0) {
        await new Promise((r) => setTimeout(r, backendListDelayMs))
      }
      const query = path.includes('?') ? path.slice(path.indexOf('?')) : ''
      const params = new URLSearchParams(query)
      const parent = params.get('parentFileId') || '/'
      /**
       * 🔴 必须按 parentFileId 区分，不能所有目录都回同一份 items。
       *
       * 否则「探测某个目录有没有子文件夹」时会把它**自己**当成子文件夹回给客户端，
       * 于是所有目录都被判成「有下级」—— 测出来的三角标行为全是假的。
       * backend.children 可以按目录 id 指定内容；没指定就是空目录。
       */
      const children = backend.children ? backend.children[parent] : undefined
      // backend.children 为 null（默认）时，只有根目录有内容；
      // 给了就按目录取，但根目录没显式给时仍然回 backend.items。
      const items = children !== undefined
        ? children
        : (parent === '/' ? backend.items : [])
      return json({
        ok: true,
        parentFileId: parent,
        items,
        nextCursor: parent === '/' ? backend.nextCursor : null,
      })
    }
    if (path.startsWith('/api/dsh-mcloud/search')) return json({ ok: true, items: [], truncated: false })
    if (path.startsWith('/api/dsh-mcloud/transfers/check')) {
      const verdict = backend.locatable || { ok: true, canReveal: true, kind: 'local', reason: '' }
      return json(verdict)
    }
    if (path.startsWith('/api/dsh-mcloud/transfers/open-folder')) return json({ ok: true })
    if (path.startsWith('/api/dsh-mcloud/transfers')) {
      // 0.4.0：按 family 分家 + 分页。后端是「全量」，这里自己切。
      const query = path.includes('?') ? path.slice(path.indexOf('?')) : ''
      const params = new URLSearchParams(query)
      const family = params.get('family') || ''
      const offset = Number(params.get('offset')) || 0
      const limit = Number(params.get('limit')) || 50
      let rows = Array.isArray(backend.jobs) ? backend.jobs.slice() : []
      if (family) rows = rows.filter((j) => String(j.kind || '').indexOf(family) === 0)
      return json({
        ok: true,
        jobs: rows.slice(offset, offset + limit),
        total: rows.length,
        offset,
        limit,
        family,
      })
    }
    if (path.startsWith('/api/dsh-mcloud/login/saved')) return json({ ok: true, hasSaved: false })
    /**
     * 拖文件夹上传会按相对路径逐层建远端目录（POST /mkdir-path）。
     * 假后端要回一个稳定的 fileId，并把「建了哪些层」记下来给断言用。
     */
    if (path.startsWith('/api/dsh-mcloud/mkdir-path')) {
      const rel = String((body && body.path) || '')
      const base = String((body && body.parentFileId) || '/')
      return json({ ok: true, fileId: 'DIR:' + base + '/' + rel })
    }
    if (path.startsWith('/api/dsh-mcloud/mkdir')) {
      return json({ ok: true })
    }
    if (path.startsWith('/api/dsh-mcloud/reveal')) return json({ ok: true, path: 'D:\\x' })
    /**
     * 🔴 0.5.4：假后端以前对 /remove 和 /move 一律回 { ok:true } 但**不动数据**，
     * 于是「删完列表里还有这个文件」这种 bug 在测试里根本看不出来（列表本来就没变）。
     * 现在真的从 backend.items 里删 / 挪，让刷新链路可被验证。
     */
    if (path.startsWith('/api/dsh-mcloud/remove')) {
      const ids = (body && Array.isArray(body.fileIds) ? body.fileIds : []).map(String)
      backend.items = backend.items.filter((it) => !ids.includes(String(it.id)))
      if (backend.children) {
        for (const key of Object.keys(backend.children)) {
          if (Array.isArray(backend.children[key])) {
            backend.children[key] = backend.children[key].filter((it) => !ids.includes(String(it.id)))
          }
        }
      }
      return json({ ok: true, removed: ids.length })
    }
    if (path.startsWith('/api/dsh-mcloud/move')) {
      if (backendMoveDelayMs > 0) {
        await new Promise((r) => setTimeout(r, backendMoveDelayMs))
      }
      const ids = (body && Array.isArray(body.fileIds) ? body.fileIds : []).map(String)
      const dest = String((body && body.toParentFileId) || '/')
      if (!backend.children) backend.children = {}
      /**
       * 🔴 必须把**所有**目录里的这些 id 都摘掉，再塞进目标目录。
       * 以前只动了 backend.items 和 children[dest]，于是「源目录」那一边
       * （children['/']）还留着 —— 客户端 reload() 一拉又回来了，
       * 测试就永远看到「移动后还在原位」。
       * 顺带：源目录的 items 和 children 可能是同一个数组引用，统一用「重建」的方式改。
       */
      const moving = []
      const collect = (arr) => {
        if (!Array.isArray(arr)) return []
        const keep = []
        for (const it of arr) {
          if (it && ids.includes(String(it.id))) moving.push(it)
          else keep.push(it)
        }
        return keep
      }
      backend.items = collect(backend.items)
      const sourceDirs = Object.keys(backend.children)
      for (const dir of sourceDirs) {
        backend.children[dir] = collect(backend.children[dir])
      }
      // 去重（同一个对象可能在 items 与 children 里各出现一次）
      const seen = new Set()
      const uniq = moving.filter((it) => {
        const k = String(it && it.id)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      if (!Array.isArray(backend.children[dest])) backend.children[dest] = []
      backend.children[dest] = backend.children[dest].concat(uniq)
      return json({ ok: true, moved: ids.length })
    }
    /**
     * 上传（POST /upload 这条 fetch 路）：回 jobId，并**立刻**把那条任务登记成 done。
     *
     * 这正是在真实环境里踩到坑的时序：小文件传得太快，客户端第一次拉任务列表时
     * 任务已经是 done 了，从来没观察到 running —— 所以「等 running → done 才刷新」
     * 那套逻辑永远不会触发。
     */
    if (path.startsWith('/api/dsh-mcloud/upload')) {
      return json(finishUpload(body && body.name))
    }
    if (path.startsWith('/api/dsh-mcloud/download-folder')) {
      // 文件夹下载：立刻登记一条「已结束」的任务，别把轮询挂在那儿。
      backend.jobs = [{
        id: 'job-folder', kind: 'download-folder', label: '照片', phase: 'complete',
        done: 10, total: 10, state: 'done', error: null,
        startedAt: Date.now(), finishedAt: Date.now(),
        canRevealLocal: true, hasLocalPath: true, parentFileId: 'DIR1', parentPath: null,
      }]
      return json({ ok: true, jobId: 'job-folder' })
    }
    if (path.startsWith('/api/dsh-mcloud/download')) {
      // 真实 Host 的行为：起任务立刻回 jobId，任务先 running，之后才 done。
      // 这里同步登记一条 running，轮询才不会被「没有任务」直接停掉。
      backend.jobs = [{
        id: 'job-1', kind: 'download', label: 'a.zip', phase: 'download',
        done: 0, total: 12345, state: 'running', error: null,
        startedAt: Date.now(), finishedAt: null,
        canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
      }]
      return json({ ok: true, jobId: 'job-1', localPath: 'D:\\Downloads\\dsh-mcloud\\a.zip' })
    }
    return json({ ok: true })
  }

  // ---- 挂载 ----
  const slots = []
  mod.apply({
    effect(fn) { fn(); return () => {} },
    logger: { warn() {}, error() {}, info() {} },
    slots: {
      register(def, component) { slots.push({ def, component }); return () => {} },
      inject(name, cb) { cb(); return () => {} },
    },
    locale: {
      register() { return () => {} },
      bind() {
        return (key, params) => {
          const template = mod.ZH[key] !== undefined ? mod.ZH[key] : key
          if (!params) return template
          return template.replace(/\{(\w+)\}/g, (w, n) => (n in params ? String(params[n]) : w))
        }
      },
    },
  })
  assert.ok(slots.length >= 1, '没有注册 conversation.view')
  const Panel = slots[0].component

  // ---- 渲染 ----
  function renderTree() {
    state.hookIndex = 0
    const host = []
    const seen = new Set()
    function visit(node) {
      if (node === null || node === undefined || node === false) return
      if (Array.isArray(node)) { for (const child of node) visit(child); return }
      if (typeof node !== 'object') return
      if (typeof node.type === 'function') {
        if (seen.has(node)) return
        seen.add(node)
        visit(node.type(node.props || {}))
        return
      }
      host.push(node)
      for (const child of node.children || []) visit(child)
    }
    visit(Panel({}))
    return host
  }

  /**
   * 跑积压的 effect。
   *
   * 0.4.4 起还要**留下 cleanup**：第 8 条（宽度手柄）和第 2 条（提示位置）
   * 都要验证「卸载时还原」，没有 cleanup 就测不到。
   */
  const cleanups = []
  async function settle(rounds = 12) {
    for (let r = 0; r < rounds; r += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const { fn } of state.pendingEffects.splice(0)) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    }
  }

  /** 模拟「切走这个页签」：把所有 effect 的 cleanup 跑一遍。 */
  function unmountView() {
    while (cleanups.length) {
      const cleanup = cleanups.pop()
      try {
        cleanup()
      } catch {
        /* 清理失败不该让测试挂掉 */
      }
    }
  }

  const byClass = (host, cls) =>
    host.filter((n) => String((n.props && n.props.className) || '').split(/\s+/).includes(cls))

  /** 挂载并跑到「已登录 + 列表就绪」的稳定态。 */
  async function mount() {
    let host = renderTree()
    await settle()
    host = renderTree()
    await settle()
    return renderTree()
  }

  return {
    mod,
    backend,
    calls,
    slots,
    renderTree,
    settle,
    byClass,
    mount,
    xhrLog,
    unmountView,
    docHandles: [],
    doc,
    /** 让 /list 慢下来（毫秒）。0 = 关闭。用于验证「网络没回来时界面就已经变了」。 */
    setListDelay(ms) { backendListDelayMs = Number(ms) || 0 },
    /** 让 /move 慢下来（毫秒）。用于验证「点下确认就生效，不等接口返回」。 */
    setMoveDelay(ms) { backendMoveDelayMs = Number(ms) || 0 },
  }
}

// ================================================================
// 需求 1：提示的生命周期
// ================================================================
describe('需求 1：传输提示「已开始 → 已完成 → 5 秒后消失」', () => {
  test('下载：起任务显示「已开始下载」，完成后变「已下载」，5 秒后消失', async () => {
    const h = createHarness()
    // 挂载前就把目录内容定好：挂载会缓存首屏，之后再改 items 不会自动重拉。
    h.backend.items = [
      { id: 'd1', name: 'a.zip', size: 12345, type: 'file', updatedAt: '2026-11-03 10:00:00' },
    ]
    const host = await h.mount()

    const row = h.byClass(host, 'mc-exRow')[0]
    assert.ok(row, '没有渲染出文件行')
    assert.equal(typeof row.props.onDoubleClick, 'function', '文件行没有双击下载')

    h.calls.length = 0
    row.props.onDoubleClick()
    await h.settle()

    assert.ok(
      h.calls.some((c) => c.path.startsWith('/api/dsh-mcloud/download')),
      '双击没有发出 /download',
    )

    let host2 = h.renderTree()
    let bannerText = h.byClass(host2, 'mc-exBanner').map((n) => JSON.stringify(n)).join(' ')
    assert.match(bannerText, /已开始下载/, '起任务后没有显示「已开始下载」')

    // 任务完成：把同一条记录改成 done（模拟后台真的传完了）
    h.backend.jobs = [{
      id: 'job-1', kind: 'download', label: 'a.zip', phase: 'download',
      done: 12345, total: 12345, state: 'done', error: null,
      startedAt: Date.now() - 5000, finishedAt: Date.now(),
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }]
    // 轮询周期 1 秒
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await h.settle(20)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await h.settle(20)

    host2 = h.renderTree()
    bannerText = h.byClass(host2, 'mc-exBanner').map((n) => JSON.stringify(n)).join(' ')
    assert.match(bannerText, /已下载/, '任务完成后提示没有变成「已下载」')

    // 5 秒后应当自己消失
    await new Promise((resolve) => setTimeout(resolve, 5400))
    await h.settle(2)
    host2 = h.renderTree()
    bannerText = h.byClass(host2, 'mc-exBanner').map((n) => JSON.stringify(n)).join(' ')
    assert.doesNotMatch(bannerText, /已下载/, '5 秒后提示没有消失')
  })
})

// ================================================================
// 需求 2：拖到右侧文件区就上传
// ================================================================
describe('需求 2：拖到右侧文件区直接上传', () => {
  test('右键菜单里没有「拖动上传」', async () => {
    const h = createHarness()
    const host = await h.mount()
    const blank = h.byClass(host, 'mc-exScroll')[0]
    assert.ok(blank, '找不到列表空白区')
    blank.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(4)
    const host2 = h.renderTree()
    const labels = h.byClass(host2, 'mc-menuItem').map((b) => (b.children || []).join(''))
    assert.ok(labels.some((l) => /上传文件/.test(l)), '菜单里应该有「上传文件」')
    assert.ok(labels.some((l) => /上传文件夹/.test(l)), '菜单里应该有「上传文件夹」')
    assert.ok(!labels.some((l) => /拖动上传/.test(l)), '右键菜单里还留着「拖动上传」')
  })

  test('整个右侧文件区挂着拖放事件，拖入有蒙层，松手就上传', async () => {
    const h = createHarness()
    let host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]
    assert.ok(main, '找不到 .mc-exMain')
    for (const ev of ['onDragEnter', 'onDragOver', 'onDragLeave', 'onDrop']) {
      assert.equal(typeof main.props[ev], 'function', `.mc-exMain 缺 ${ev}`)
    }

    main.props.onDragEnter({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: { items: [], files: [] },
    })
    host = h.renderTree()
    const layer = h.byClass(host, 'mc-exDropLayer')
    assert.equal(layer.length, 1, '拖入时没有出现投放蒙层')
    assert.match(JSON.stringify(layer[0]), /松开鼠标/, '蒙层上没有投放提示')

    const file = { name: 'photo.jpg', size: 100, type: 'image/jpeg' }
    h.xhrLog.length = 0
    h.byClass(host, 'mc-exMain')[0].props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => ({ isDirectory: false }),
          getAsFile: () => file,
        }],
        files: [file],
      },
    })
    await h.settle(10)

    assert.ok(h.xhrLog.length >= 1, '松手没有发起上传')
    const up = h.xhrLog[0]
    assert.match(up.url, /\/upload-body/, '上传走的不是 /upload-body')
    assert.match(up.url, /name=photo\.jpg/, '上传 URL 里没带文件名')
    assert.match(up.url, /parentFileId=%2F/, '上传 URL 里没带目标目录')

    host = h.renderTree()
    assert.equal(h.byClass(host, 'mc-exDropLayer').length, 0, '松手后蒙层还挂着')
  })

  /**
   * 0.4.4 第 1 条改了这里的行为：**拖文件夹现在是能上传的**（以前是礼貌拒绝）。
   *
   * 这条用例原来断言「拖文件夹不发请求 + 提示改用『上传文件夹』」，
   * 那个约定已经被用户明确要求推翻了。现在改成两条：
   *   · 空目录（读不出文件）→ 不发请求，但要给出「没有可上传的文件」的说明；
   *   · 有内容的目录 → 真的按层级上传（见下一条用例）。
   */
  test('拖空文件夹：不发请求，但要说明「没有可上传的文件」', async () => {
    const h = createHarness()
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]
    h.xhrLog.length = 0
    main.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => ({
            isDirectory: true,
            name: '空目录',
            createReader: () => ({ readEntries: (cb) => cb([]) }),
          }),
          getAsFile: () => null,
        }],
        files: [],
      },
    })
    await h.settle(8)
    assert.equal(h.xhrLog.length, 0, '空文件夹不该发起上传')
    const host2 = h.renderTree()
    const banners = h.byClass(host2, 'mc-exBanner').map((n) => JSON.stringify(n)).join(' ')
    assert.match(banners, /没有可上传的文件/, '空文件夹没有给出说明：' + banners.slice(0, 200))
  })

  test('拖有内容的文件夹：递归展开，按原来的层级建目录并上传', async () => {
    const h = createHarness()
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]

    // 造一棵：照片/2024/a.jpg + 照片/b.png
    function fileEntry(name) {
      return {
        isFile: true,
        isDirectory: false,
        name,
        file(cb) { cb({ name, size: 10, type: 'image/jpeg' }) },
      }
    }
    function dirEntry(name, kids) {
      return {
        isDirectory: true,
        isFile: false,
        name,
        createReader() {
          let served = false
          return {
            readEntries(cb) {
              if (served) return cb([])
              served = true
              cb(kids)
            },
          }
        },
      }
    }

    h.xhrLog.length = 0
    h.calls.length = 0
    main.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => dirEntry('照片', [
            dirEntry('2024', [fileEntry('a.jpg')]),
            fileEntry('b.png'),
          ]),
          getAsFile: () => null,
        }],
        files: [],
      },
    })
    await h.settle(30)

    // 两个文件都该真的传上去
    assert.equal(h.xhrLog.length, 2, '文件夹里的文件没有被遍历上传：' + JSON.stringify(h.xhrLog.map((x) => x.url)))
    const names = h.xhrLog.map((x) => decodeURIComponent(x.url))
    assert.ok(names.some((u) => u.includes('a.jpg')), '漏掉了子目录里的 a.jpg')
    assert.ok(names.some((u) => u.includes('b.png')), '漏掉了顶层的 b.png')

    // 目录要按层级建出来（/mkdir-path），而且父在前、子在后
    const mkdirs = h.calls
      .filter((c) => c.path.startsWith('/api/dsh-mcloud/mkdir-path'))
      .map((c) => c.body && c.body.path)
    assert.ok(mkdirs.includes('照片'), '没有建「照片」这一层：' + JSON.stringify(mkdirs))
    assert.ok(mkdirs.includes('照片/2024'), '没有建「照片/2024」这一层：' + JSON.stringify(mkdirs))
    assert.ok(
      mkdirs.indexOf('照片') < mkdirs.indexOf('照片/2024'),
      '子目录在父目录之前建了：' + JSON.stringify(mkdirs),
    )
  })
})

// ================================================================
// 需求 3：传输记录里的「定位」
// ================================================================
describe('需求 3：传输记录的「定位」按钮', () => {
  test('下载 → 资源管理器（只发 jobId）；上传 → 跳网盘目录；老记录不显示', async () => {
    const h = createHarness()
    h.backend.jobs = [
      {
        id: 'dl1', kind: 'download', label: 'a.zip', phase: 'download',
        done: 100, total: 100, state: 'done', error: null,
        startedAt: Date.now() - 9000, finishedAt: Date.now() - 5000,
        canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
      },
      {
        id: 'up1', kind: 'upload', label: 'r.pdf', phase: 'complete',
        done: 50, total: 50, state: 'done', error: null,
        startedAt: Date.now() - 9000, finishedAt: Date.now() - 5000,
        canRevealLocal: false, hasLocalPath: false, parentFileId: 'FOLDER-B', parentPath: '/windows/实验',
      },
      {
        id: 'old1', kind: 'download', label: 'legacy.bin', phase: 'download',
        done: 1, total: 1, state: 'done', error: null,
        startedAt: Date.now() - 99000, finishedAt: Date.now() - 95000,
      },
    ]

    let host = await h.mount()

    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    assert.ok(histBtn, '找不到「传输记录」按钮')
    histBtn.props.onClick()
    await h.settle(8)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    // 0.4.0 起弹层分成「上传 / 下载」两页，所以要分别在两页里看。
    const switchTab = async (keyword) => {
      const tab = host.find(
        (n) => n.type === 'button' &&
          String((n.props && n.props.className) || '').includes('mc-exHistTab') &&
          (n.children || []).join('').includes(keyword),
      )
      assert.ok(tab, `找不到「${keyword}」页签`)
      tab.props.onClick()
      await h.settle(10)
      host = h.renderTree()
      await h.settle(8)
      host = h.renderTree()
    }

    const revealButtons = () => host.filter(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )

    // 「下载」页（默认）：dl1 能定位；old1 是老记录、没有位置 → 不显示按钮
    let revealBtns = revealButtons()
    assert.equal(revealBtns.length, 1, `下载页应当只有 1 个「定位」，实际 ${revealBtns.length}`)
    assert.match(revealBtns[0].props.title, /资源管理器/, '缺少「在资源管理器里定位」的说明')

    // 下载那条：POST /reveal { jobId }
    h.calls.length = 0
    revealBtns[0].props.onClick({ stopPropagation() {} })
    await h.settle(10)
    const revealCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/reveal'))
    assert.ok(revealCall, '点「定位」没有发出 /reveal')
    assert.deepEqual(revealCall.body, { jobId: 'dl1' }, '/reveal 不应该带本机绝对路径')

    // 上传那条：切目录，不碰本机
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()
    await switchTab('上传')
    revealBtns = revealButtons()
    assert.equal(revealBtns.length, 1, `上传页应当只有 1 个「定位」，实际 ${revealBtns.length}`)
    assert.match(revealBtns[0].props.title, /网盘/, '缺少「跳转到网盘位置」的说明')

    h.calls.length = 0
    revealBtns[0].props.onClick({ stopPropagation() {} })
    host = h.renderTree()
    await h.settle(12)
    host = h.renderTree()
    await h.settle(10)

    assert.ok(
      !h.calls.some((c) => c.path.startsWith('/api/dsh-mcloud/reveal')),
      '上传记录不该调 /reveal',
    )
    const listCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(listCall, '上传记录点定位应该重拉列表（切目录）')
    assert.match(listCall.path, /FOLDER-B/, '没有切到 FOLDER-B')
  })
})

// ================================================================
// 需求 4：左树在刷新后保持稳定
// ================================================================
describe('需求 4：刷新后左树不会塌成只剩一个 /', () => {
  test('在根目录连点两次刷新，子文件夹都还在', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'B-目录', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()

    const treeLabels = (host2) => host2
      .filter((n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exTreeLabel'))
      .map((n) => {
        const nameSpan = (n.children || []).flat().find(
          (c) => c && c.props && c.props.className === 'mc-exTreeName',
        )
        return nameSpan ? (nameSpan.children || []).join('') : '?'
      })

    assert.ok(treeLabels(host).some((l) => l.includes('A-目录')), '初始左树里没有 A-目录')

    for (let round = 0; round < 2; round += 1) {
      const refreshBtn = host.find(
        (n) => n.type === 'button' && n.props && n.props.title === '刷新',
      )
      assert.ok(refreshBtn, '找不到刷新按钮')
      refreshBtn.props.onClick()
      await h.settle(14)
      host = h.renderTree()
      await h.settle(14)
      host = h.renderTree()
      assert.ok(
        treeLabels(host).some((l) => l.includes('A-目录')),
        `第 ${round + 1} 次刷新后左树塌了：` + JSON.stringify(treeLabels(host)),
      )
    }
  })

  test('接口临时返回空：不会立刻把已有子节点清掉', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()

    const treeLabels = (host2) => host2
      .filter((n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exTreeLabel'))
      .map((n) => {
        const nameSpan = (n.children || []).flat().find(
          (c) => c && c.props && c.props.className === 'mc-exTreeName',
        )
        return nameSpan ? (nameSpan.children || []).join('') : '?'
      })

    // 先制造一次空结果（模拟服务端索引滞后）
    h.backend.items = []
    const refreshBtn = host.find((n) => n.type === 'button' && n.props && n.props.title === '刷新')
    refreshBtn.props.onClick()
    await h.settle(12)
    host = h.renderTree()
    assert.ok(
      treeLabels(host).some((l) => l.includes('A-目录')),
      '一次空结果就把树清了：' + JSON.stringify(treeLabels(host)),
    )
  })
})

// ================================================================
// 0.4.0 需求 1：上传后列表要能立刻看到（不能再被宿主 60 秒缓存挡住）
// ================================================================
describe('0.4.0 需求 1：上传完成后的刷新不能被缓存挡住', () => {
  test('列表请求默认不带 cache=1（宿主默认不吃缓存）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'f1', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    await h.mount()

    const listCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(listCalls.length > 0, '没有发出任何 /list')
    for (const call of listCalls) {
      assert.doesNotMatch(call.path, /cache=1/, `/list 带上了 cache=1，会命中宿主 60 秒缓存：${call.path}`)
    }
  })

  test('点「刷新」会真的重新拉列表（不是只读客户端缓存）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'f1', name: 'old.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()

    // 服务端「刚出现」一个新文件
    h.backend.items = [
      { id: 'f2', name: 'new.txt', size: 1, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    const before = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list')).length
    const refreshBtn = host.find((n) => n.type === 'button' && n.props && n.props.title === '刷新')
    assert.ok(refreshBtn, '找不到刷新按钮')
    refreshBtn.props.onClick()
    await h.settle(14)
    host = h.renderTree()
    await h.settle(14)
    host = h.renderTree()

    const after = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list')).length
    assert.ok(after > before, '点刷新没有发出新的 /list 请求')

    const names = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exRow'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(names, /new\.txt/, '刷新后列表里还是旧内容')
  })
})

// ================================================================
// 0.4.0 需求 2：左树箭头点得动、且反应快
// ================================================================
describe('0.4.0 需求 2：左树箭头', () => {
  /** 取树上一共有几个可点的箭头。 */
  const countToggles = (host) => host.filter(
    (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exTreeToggle'),
  )

  test('探测立刻发起（不能延迟到秒级）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    await h.mount()

    /**
     * 「探测有没有子文件夹」必须马上发出去。
     *
     * 0.4.0 把它延后了 2 秒（当时是为了给「点箭头」让路），结果空目录的三角标
     * 要好几秒才消失。现在不延迟 —— 但也不能同步挤在同一帧里发，
     * 所以给 1.5 秒的宽限，够 setTimeout(0) 走完好几轮了。
     */
    const probeCalls = h.calls.filter(
      (c) => c.path.includes('/api/dsh-mcloud/list') && /parentFileId=A\b/.test(c.path),
    )
    assert.ok(probeCalls.length >= 1, '没有对 A-目录 发起「有没有子目录」的探测')
    assert.ok(
      probeCalls.some((c) => /pageSize=50/.test(c.path)),
      '探测没有用 pageSize=50 一次问清：' + probeCalls.map((c) => c.path).join(' | '),
    )
    assert.ok(
      !probeCalls.some((c) => /pageSize=10\b/.test(c.path)),
      '还在用 pageSize=10 逐页翻',
    )
  })

  test('多个目录的探测结果必须各自落到自己头上（不能全写到最后那个）', async () => {
    const h = createHarness()
    /**
     * 9 个文件夹，只有一部分有子文件夹 —— 特意做成「真假混合」，
     * 而且数量超过探测并发，逼出队列多轮调度。
     *
     * 🔴 这一条专门抓一个真实的 `var` 闭包 bug：
     * 原来写的是
     *     var task = probeQueue.shift()
     *     probeKid(task.folderId).then(function (has) {
     *       applyProbeResult(task.parentId, task.folderId, has)
     *     })
     * `var` 是函数作用域，while 每轮赋的是同一个变量 → 所有回调都读到最后那个 task，
     * 9 个目录的结论全写到同一个文件夹上，其余永远停在「未知」。
     * 表现是树里只有 1~2 个三角标，等多久都不补齐。
     */
    const folders = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']
    h.backend.items = folders.map((id, i) => ({
      id, name: id + '-目录', size: 0, type: 'folder', updatedAt: `2026-11-0${(i % 9) + 1} 10:00:00`,
    }))
    // 只有偶数号有子文件夹
    const withKids = folders.filter((_, i) => i % 2 === 0)
    const children = {}
    for (const id of folders) {
      children[id] = withKids.includes(id)
        ? [{ id: id + '-kid', name: id + '-子', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' }]
        : []
    }
    h.backend.children = children

    let host = await h.mount()
    // 等探测全部落地
    for (let round = 0; round < 40; round += 1) {
      await new Promise((r) => setTimeout(r, 60))
      await h.settle(6)
    }
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const tokens = (n) => String((n.props && n.props.className) || '').split(/\s+/)
    const nodes = host.filter((n) => tokens(n).includes('mc-exTreeNode'))
    const toggles = host.filter((n) => n.type === 'button' && tokens(n).includes('mc-exTreeToggle'))

    /** 每个节点是不是画了三角标。 */
    const caretOf = (i) => {
      const toggle = toggles[i]
      if (!toggle) return false
      const slot = (toggle.children || []).flat()[0]
      const inner = slot && slot.children ? (slot.children || []).flat() : []
      return inner.some((c) => {
        const t = String((c && c.props && c.props.className) || '').split(/\s+/)
        return t.includes('mc-exCaret') || t.includes('mc-exCaretOpen')
      })
    }

    // 节点顺序：第 0 个是根 "/"，之后按 backend.items 顺序
    const results = folders.map((id, i) => ({
      id,
      expect: withKids.includes(id),
      actual: caretOf(i + 1),
    }))

    const wrong = results.filter((r) => r.expect !== r.actual)
    assert.equal(
      wrong.length,
      0,
      '三角标和真实内容对不上：' +
        JSON.stringify(wrong) +
        ' | 全部：' + JSON.stringify(results),
    )

    // 再确认一遍：不能残留任何「占位」元素
    const placeholders = host.filter((n) => tokens(n).includes('mc-exCaretPending'))
    assert.equal(placeholders.length, 0, '还留着「未知占位」元素，应该什么都不画')
  })

  test('未知状态下什么都不画（连占位点都不能有）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    h.backend.children = {
      A: [{ id: 'A1', name: 'A1-子目录', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' }],
    }

    // 把探测按住不发，让 A 停在「未知」
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (/\/list\?parentFileId=A&/.test(path) && path.includes('pageSize=50')) {
        return new Promise(() => {})
      }
      return originalFetch(url, init)
    }
    let host
    try {
      host = await h.mount()
    } finally {
      globalThis.fetch = originalFetch
    }
    await h.settle(10)
    host = h.renderTree()

    const tokens = (n) => String((n.props && n.props.className) || '').split(/\s+/)
    const carets = host.filter((n) => {
      const t = tokens(n)
      return t.includes('mc-exCaret') || t.includes('mc-exCaretOpen')
    })
    // 根节点一定有（它已经加载出 A 了）；A 还是未知 → 不能有
    assert.equal(carets.length, 1, `未知状态画出了额外的三角标：` + JSON.stringify(carets.map((n) => n.props.className)))

    /**
     * 关键：不能有「暗点」这类占位元素。
     * 用户明确说过两版都不对 —— 先画三角标不对，换成暗点也不对，
     * 未知就该老老实实留白。
     */
    const placeholders = host.filter((n) => tokens(n).includes('mc-exCaretPending'))
    assert.equal(placeholders.length, 0, '未知状态不该有任何占位元素')
  })

  test('空目录探测出来后：没有三角标，也打不开', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    // A 是空目录（backend.children 里没给它内容 → 空）
    let host = await h.mount()
    // 给探测一点时间落地（真实环境一次往返 ~200-900ms，这里留足）
    await new Promise((r) => setTimeout(r, 300))
    await h.settle(20)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const classTokens = (n) => String((n.props && n.props.className) || '').split(/\s+/)
    const carets = host.filter((n) => {
      const tokens = classTokens(n)
      return tokens.includes('mc-exCaret') || tokens.includes('mc-exCaretOpen')
    })
    // 根节点一定可展开（有 9 个目录），A-目录 是空的 → 不该有三角标
    assert.equal(
      carets.length,
      1,
      '空目录上还挂着三角标：' + JSON.stringify(carets.map((n) => n.props.className)) +
        ' | 全部 caret 类：' +
        JSON.stringify(host
          .filter((n) => String((n.props && n.props.className) || '').includes('Caret'))
          .map((n) => n.props.className)) +
        ' | list 请求：' + JSON.stringify(h.calls.filter((c) => c.path.includes('/list')).map((c) => c.path)),
    )

    // 而且那个「等结果」的淡点也该消失了
    const pending = host.filter((n) => classTokens(n).includes('mc-exCaretPending'))
    assert.equal(pending.length, 0, '探测已经有结论了，占位点还留着')
  })

  test('点箭头只发一次列表请求（不再为了确认下级翻好几页）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'A-目录', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    // A 里确实有子目录，这样它才会有三角标可点
    h.backend.children = {
      A: [{ id: 'A1', name: 'A1-子目录', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' }],
    }
    let host = await h.mount()
    await new Promise((r) => setTimeout(r, 300))
    await h.settle(20)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const toggles = countToggles(host)
    assert.ok(toggles.length >= 2, `箭头数量不对（${toggles.length}）：A 里有子目录，应该能展开`)

    h.calls.length = 0
    toggles[1].props.onClick({ stopPropagation() {} })
    await h.settle(14)

    const probes = h.calls.filter((c) => c.path.includes('parentFileId=A'))
    // 展开 A 自己 1 次 + 可能的后台下探 1 次；关键是**不能**出现 pageSize=10 的翻页连环请求
    assert.ok(
      probes.length <= 3,
      `展开一个目录打出了 ${probes.length} 个请求，太多了：` + probes.map((p) => p.path).join(' | '),
    )
    assert.ok(
      !probes.some((p) => /pageSize=10\b/.test(p.path)),
      '还在用 pageSize=10 逐页探测',
    )

    // 展开后应该真的看到 A1
    host = h.renderTree()
    const names = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exTreeName'))
      .map((n) => (n.children || []).join(''))
    assert.ok(names.includes('A1-子目录'), '点开了却看不到子目录：' + JSON.stringify(names))
  })
})

// ================================================================
// 0.4.0 需求 3：传输记录分「上传 / 下载」两个页面，且永不删除
// ================================================================
describe('0.4.0 需求 3：传输记录弹层', () => {
  async function openHistory(host, h) {
    const btn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    assert.ok(btn, '找不到「传输记录」按钮')
    btn.props.onClick()
    await h.settle(10)
    return h.renderTree()
  }

  test('有「上传」「下载」两个页签，而且各自只列自己的记录', async () => {
    const h = createHarness()
    h.backend.jobs = [
      {
        id: 'u1', kind: 'upload', label: 'up.pdf', phase: 'complete', done: 10, total: 10,
        state: 'done', error: null, startedAt: Date.now() - 8000, finishedAt: Date.now() - 5000,
        canRevealLocal: false, hasLocalPath: false, parentFileId: 'F1', parentPath: '/a',
      },
      {
        id: 'd1', kind: 'download', label: 'down.zip', phase: 'download', done: 10, total: 10,
        state: 'done', error: null, startedAt: Date.now() - 9000, finishedAt: Date.now() - 6000,
        canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
      },
    ]
    let host = await h.mount()
    host = await openHistory(host, h)

    const tabs = host.filter(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistTab'),
    )
    assert.equal(tabs.length, 2, `应该有 2 个页签，实际 ${tabs.length}`)
    const tabText = tabs.map((b) => (b.children || []).join('')).join(' ')
    assert.match(tabText, /上传/, '缺少「上传」页签')
    assert.match(tabText, /下载/, '缺少「下载」页签')

    /** 当前列表里的文件名。 */
    const namesOf = (host2) => host2
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exHistName'))
      .map((n) => (n.children || []).join(''))

    // 默认落在「下载」页：只应有 down.zip
    let names = namesOf(host)
    assert.ok(names.includes('down.zip'), '下载页里没有下载记录：' + JSON.stringify(names))
    assert.ok(!names.includes('up.pdf'), '下载页里混进了上传记录：' + JSON.stringify(names))

    // 切到「上传」页
    const uploadTab = tabs.find((b) => (b.children || []).join('').includes('上传'))
    uploadTab.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()
    names = namesOf(host)
    assert.ok(names.includes('up.pdf'), '上传页里没有上传记录：' + JSON.stringify(names))
    assert.ok(!names.includes('down.zip'), '上传页里混进了下载记录：' + JSON.stringify(names))
  })

  test('界面上没有「清空记录」按钮（记录永不删除）', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'd1', kind: 'download', label: 'a.zip', phase: 'download', done: 1, total: 1,
      state: 'done', error: null, startedAt: Date.now() - 1000, finishedAt: Date.now(),
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }]
    let host = await h.mount()
    host = await openHistory(host, h)

    const buttons = host.filter((n) => n.type === 'button')
    const labels = buttons.map((b) => (b.children || []).flat().join('')).join(' | ')
    assert.doesNotMatch(labels, /清空/, '还留着「清空记录」按钮')
    assert.match(labels, /打开记录文件所在文件夹/, '缺少「打开记录文件所在文件夹」入口')
  })

  test('分页：记录多于每页条数时出现「加载更多」，点了往后翻', async () => {
    const h = createHarness()
    // 造 40 条下载记录（每页 30）
    h.backend.jobs = Array.from({ length: 40 }, (_, i) => ({
      id: 'd' + i, kind: 'download', label: `f${i}.bin`, phase: 'download',
      done: 1, total: 1, state: 'done', error: null,
      startedAt: Date.now() - i * 1000, finishedAt: Date.now() - i * 1000,
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }))
    let host = await h.mount()
    host = await openHistory(host, h)

    const countItems = (host2) => host2.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exHistItem'),
    ).length

    const firstPage = countItems(host)
    assert.equal(firstPage, 30, `首屏应该 30 条，实际 ${firstPage}`)

    const more = host.find(
      (n) => n.type === 'button' && (n.children || []).join('').includes('加载更多'),
    )
    assert.ok(more, '40 条记录却没有「加载更多」')
    more.props.onClick()
    await h.settle(12)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()
    assert.equal(countItems(host), 40, '「加载更多」没有把剩下的接上')
  })
})

// ================================================================
// 0.4.0 需求 4：文件被移动了就显示「无法定位」
// ================================================================
describe('0.4.0 需求 4：定位要能识别「已经被移动」', () => {
  test('上传记录：宿主复核说不在原位 → 不切目录，提示无法定位', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'u1', kind: 'upload', label: 'r.pdf', phase: 'complete', done: 5, total: 5,
      state: 'done', error: null, startedAt: Date.now() - 5000, finishedAt: Date.now() - 2000,
      canRevealLocal: false, hasLocalPath: false, parentFileId: 'FOLDER-B', parentPath: '/windows/实验',
    }]
    // 宿主复核结果：已经不在原来的目录了
    h.backend.locatable = { ok: true, canReveal: false, kind: 'remote', reason: 'remote-moved' }

    let host = await h.mount()
    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(8)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const upTab = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistTab') &&
        (n.children || []).join('').includes('上传'),
    )
    assert.ok(upTab, '找不到上传页签')
    upTab.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const revealBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.ok(revealBtn, '上传记录没有「定位」按钮')

    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(12)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    // 应该问过宿主「还能不能定位」
    assert.ok(
      h.calls.some((c) => c.path.startsWith('/api/dsh-mcloud/transfers/check')),
      '定位上传记录前没有向宿主复核位置',
    )
    // 不应该切目录（没发新的列表请求）
    assert.ok(
      !h.calls.some((c) => c.path.includes('FOLDER-B')),
      '已经移走了却还是切到了旧目录',
    )
    // 应该有「无法定位」提示
    //
    // 🔴 0.4.4 第 2 条改了它显示的位置：以前走文件区的 .mc-exBanner（被弹层整个盖住，
    // 用户说「提示跑到名称下面去了」）；现在显示在**记录弹层内部**的
    // .mc-exHistNotice 里。所以这里断言的是弹层里那一条。
    const histNotice = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exHistNotice'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(histNotice, /无法定位/, '记录弹层里没有「无法定位」提示：' + histNotice.slice(0, 300))

    // 而且不能只丢在文件区横幅里（那条被弹层盖住，用户看不到）
    const fileBanner = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exBanner'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.doesNotMatch(
      fileBanner,
      /无法定位/,
      '定位失败的提示又跑到文件区横幅（会被弹层盖住）：' + fileBanner.slice(0, 200),
    )
  })

  test('下载记录：宿主说本机文件没了 → 把无法定位的理由显示出来', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'd1', kind: 'download', label: 'a.zip', phase: 'download', done: 1, total: 1,
      state: 'done', error: null, startedAt: Date.now() - 5000, finishedAt: Date.now() - 2000,
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }]
    let host = await h.mount()
    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(8)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const revealBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.ok(revealBtn, '下载记录没有「定位」按钮')

    // 模拟宿主：本机文件已经不在了
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (path.startsWith('/api/dsh-mcloud/reveal')) {
        h.calls.push({ path, body: init && init.body ? JSON.parse(init.body) : {} })
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, error: '无法定位：这个文件已经被移动或删除了。' }),
          text: async () => JSON.stringify({ ok: false, error: '无法定位：这个文件已经被移动或删除了。' }),
        }
      }
      return originalFetch(url, init)
    }

    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(12)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()
    globalThis.fetch = originalFetch

    // 0.4.4 第 2 条：理由要显示在记录弹层里（不是被弹层盖住的文件区横幅）
    const histNotice = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exHistNotice'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(
      histNotice,
      /无法定位|移动|删除/,
      '记录弹层里没有把「文件已被移动」的原因说清楚：' + histNotice.slice(0, 300),
    )
  })
})

// ================================================================
// 0.4.0 需求 5：文件夹下载（右键菜单入口 + 走服务端打包）
// ================================================================
describe('0.4.0 需求 5：下载整个文件夹', () => {
  test('文件夹右键菜单里有「下载整个文件夹」', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'DIR1', name: '照片', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()

    // 找文件夹那一行（.mc-exRow 里带 onContextMenu 的那个）
    const rows = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRow') &&
        typeof n.props.onContextMenu === 'function',
    )
    const row = rows.find((n) => typeof n.props.onDoubleClick === 'function')
    assert.ok(row, '没有渲染出可右键的文件夹行')
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(8)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const labels = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-menuItem'))
      .map((b) => (b.children || []).flat().join(''))
    assert.ok(
      labels.some((l) => /下载整个文件夹/.test(l)),
      '文件夹右键里没有「下载整个文件夹」：' + JSON.stringify(labels),
    )
  })

  test('点它会发 POST /download-folder，并带上文件夹名（默认落点不能是 fileId）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'DIR1', name: '照片', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()

    const rows = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRow') &&
        typeof n.props.onContextMenu === 'function',
    )
    const row = rows.find((n) => typeof n.props.onDoubleClick === 'function')
    assert.ok(row, '没有渲染出可右键的文件夹行')
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(8)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const item = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-menuItem') &&
        (n.children || []).flat().join('').includes('下载整个文件夹'),
    )
    assert.ok(item, '找不到「下载整个文件夹」菜单项')

    h.calls.length = 0
    // menuItem 用 onMouseDown 触发（见源码注释）
    item.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(10)

    const call = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/download-folder'))
    assert.ok(call, '没有发出 /download-folder')
    assert.equal(call.body.folderId, 'DIR1', 'folderId 不对')
    assert.equal(call.body.name, '照片', '没有把文件夹名传给宿主（默认落地目录会是 id）')
    // 这个任务被登记成了 running 并开了轮询；关掉它，免得测试进程被 interval 挂住。
    h.backend.jobs = []
    await h.settle(4)
  })
})

// ================================================================
// 0.4.1 需求 1：拖进插件的文件不能同时变成对话附件
// ================================================================
describe('0.4.1 需求 1：拖放事件必须在插件这一层掐断', () => {
  test('drop 要 preventDefault + stopPropagation（否则 DSH 的 document 监听会收走）', async () => {
    const h = createHarness()
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]
    assert.ok(main, '找不到 .mc-exMain')

    const file = { name: 'photo.jpg', size: 100, type: 'image/jpeg' }
    let prevented = false
    let stopped = false

    h.xhrLog.length = 0
    main.props.onDrop({
      preventDefault() { prevented = true },
      stopPropagation() { stopped = true },
      dataTransfer: {
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => ({ isDirectory: false }),
          getAsFile: () => file,
        }],
        files: [file],
      },
    })
    await h.settle(8)

    /**
     * 🔴 这两条就是这次 bug 的护栏。
     *
     * DSH 在 `document` 上直接挂 dragenter/dragover/dragleave/drop
     * （见 @deepseek-ai/dsh-client-ui-attachment 的 registerFileDrop），
     * 只 preventDefault 只是阻止浏览器默认动作，**事件照样冒泡到 document**，
     * 于是文件既被插件上传、又出现在对话附件里。
     */
    assert.equal(prevented, true, 'drop 没有 preventDefault')
    assert.equal(stopped, true, 'drop 没有 stopPropagation —— 会被 DSH 的 document 监听收走，变成对话附件')
    assert.ok(h.xhrLog.length >= 1, '拦了事件却没上传')
  })

  test('dragenter / dragover / dragleave 也都要 stopPropagation', async () => {
    const h = createHarness()
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]

    for (const name of ['onDragEnter', 'onDragOver', 'onDragLeave']) {
      let stopped = false
      main.props[name]({
        preventDefault() {},
        stopPropagation() { stopped = true },
        dataTransfer: { items: [], files: [], types: ['Files'], dropEffect: '' },
      })
      assert.equal(stopped, true, `${name} 没有 stopPropagation`)
    }
  })
})

// ================================================================
// 0.4.1 需求 2：上传完成后列表要立刻出现新文件（不能漏掉「秒完成」的任务）
// ================================================================
describe('0.4.1 需求 2：上传完立刻刷新目录', () => {
  test('任务一落地就已是 done（没观察到 running）也要重拉列表', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'OLD', name: 'old.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()

    const main = h.byClass(host, 'mc-exMain')[0]
    const file = { name: 'new.txt', size: 10, type: 'text/plain' }

    const listBefore = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list')).length
    h.calls.length = 0

    main.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [{
          kind: 'file',
          webkitGetAsEntry: () => ({ isDirectory: false }),
          getAsFile: () => file,
        }],
        files: [file],
      },
    })

    // 让 XHR 回调 + 轮询都跑完
    await h.settle(20)
    await new Promise((r) => setTimeout(r, 1400))
    await h.settle(20)

    /**
     * 🔴 这个断言抓的是「上传完很久才显示」那个 bug。
     *
     * 以前只在「上一轮 running → 这一轮 done」时才 reload()。
     * 但小文件传得飞快，第一次拉任务列表时它**已经是 done 了**，
     * 于是 reload() 一次都没跑，用户要等很久或者手动刷新才看得到文件。
     */
    assert.ok(
      h.calls.some((c) => c.path.startsWith('/api/dsh-mcloud/list')),
      '上传完成后没有重拉目录列表',
    )

    host = h.renderTree()
    await h.settle(10)
    host = h.renderTree()
    const rows = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exRow'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(rows, /new\.txt/, '上传完了列表里还是看不到新文件')

    h.backend.jobs = []
    await h.settle(4)
  })

  test('刷新请求要带 refresh=1，老宿主也不会读到 60 秒缓存', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'OLD', name: 'old.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    const host = await h.mount()

    // 手动点「刷新」
    h.calls.length = 0
    const refreshBtn = host.find((n) => n.type === 'button' && n.props && n.props.title === '刷新')
    assert.ok(refreshBtn, '找不到刷新按钮')
    refreshBtn.props.onClick()
    await h.settle(14)

    const listCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(listCall, '刷新没有发 /list')
    /**
     * refresh=1 是 0.3.x 宿主的「绕过 60 秒缓存」开关。
     * 客户端必须带上它 —— 这样即使宿主进程还是旧代码（没重启），刷新也是有效的。
     */
    assert.match(listCall.path, /refresh=1/, '刷新请求没带 refresh=1，旧宿主会返回缓存里的旧列表')
  })
})

// ================================================================
// 0.4.1 需求 3：宿主版本落后时不能把 HTTP 404 糊到用户脸上
// ================================================================
describe('0.4.1 需求 3：新客户端 + 旧宿主 要优雅降级', () => {
  /** 让 /transfers/check 和 /transfers/open-folder 像旧宿主一样回 HTTP 404。 */
  function makeHostOld(h) {
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (path.startsWith('/api/dsh-mcloud/transfers/check') ||
          path.startsWith('/api/dsh-mcloud/transfers/open-folder')) {
        h.calls.push({ path, body: init && init.body ? JSON.parse(init.body) : {} })
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => 'Not Found',
        }
      }
      return original(url, init)
    }
    return () => { globalThis.fetch = original }
  }

  test('上传记录的「定位」在旧宿主上直接切目录（不弹 HTTP 404）', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'u1', kind: 'upload', label: 'r.pdf', phase: 'complete', done: 5, total: 5,
      state: 'done', error: null, startedAt: Date.now() - 5000, finishedAt: Date.now() - 2000,
      canRevealLocal: false, hasLocalPath: false, parentFileId: 'FOLDER-B', parentPath: '/windows/实验',
    }]
    let host = await h.mount()

    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const upTab = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistTab') &&
        (n.children || []).join('').includes('上传'),
    )
    assert.ok(upTab, '找不到上传页签')
    upTab.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const revealBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.ok(revealBtn, '上传记录没有「定位」按钮')

    // 把宿主伪装成旧版本
    const restore = makeHostOld(h)
    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(14)
    host = h.renderTree()
    await h.settle(10)
    host = h.renderTree()
    restore()

    // 旧宿主没有复核接口 → 直接切目录（重拉列表），这是能用的那条路
    assert.ok(
      h.calls.some((c) => c.path.includes('FOLDER-B')),
      '旧宿主上点「定位」没有切到目标目录',
    )

    // 绝不能把 404 当成人话提示给用户
    const banners = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exBanner'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.doesNotMatch(banners, /404/, '把 HTTP 404 显示给用户了：' + banners.slice(0, 300))
  })

  test('「打开记录文件夹」在旧宿主上给出「重启后可用」而不是 404', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'd1', kind: 'download', label: 'a.zip', phase: 'download', done: 1, total: 1,
      state: 'done', error: null, startedAt: Date.now() - 1000, finishedAt: Date.now(),
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }]
    let host = await h.mount()

    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const openBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.children || []).join('')).includes('打开记录文件所在文件夹'),
    )
    assert.ok(openBtn, '找不到「打开记录文件所在文件夹」')

    const restore = makeHostOld(h)
    openBtn.props.onClick()
    await h.settle(14)
    host = h.renderTree()
    await h.settle(10)
    host = h.renderTree()
    restore()

    const banners = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exBanner'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.doesNotMatch(banners, /HTTP 404/, '把 HTTP 404 显示给用户了：' + banners.slice(0, 300))
    assert.match(banners, /重启/, '没有告诉用户「重启后可用」：' + banners.slice(0, 300))
  })
})

// ================================================================
// 0.4.4 第 3 条：下载「定位」必须真的能在资源管理器里选中文件
// ----------------------------------------------------------------
// 这一条的真因在**宿主**（lib/index.js 的 explorerLocateArgs）：
// 老写法 spawn('explorer.exe', ['/select,' + path]) 走 Node 默认的 quoting，
// 只要路径里有空格，整串会被再包一层引号，explorer 认不出斜杠命令，
// 退化成打开「文档」—— 用户看到的就是「下载定位无效」。
// 宿主侧的纯函数断言在 test/reveal.test.js；这里测客户端仍然只发 jobId。
// ================================================================
describe('0.4.4 第 3 条：下载定位只发 jobId（路径不出前端）', () => {
  test('点定位发的是 { jobId }，请求体里没有任何本机路径', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'dl-path', kind: 'download', label: 'a b.zip', phase: 'download', done: 1, total: 1,
      state: 'done', error: null, startedAt: Date.now() - 4000, finishedAt: Date.now() - 1000,
      canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
    }]
    let host = await h.mount()
    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const revealBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.ok(revealBtn, '下载记录没有「定位」按钮')

    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(12)

    const revealCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/reveal'))
    assert.ok(revealCall, '没有发出 /reveal')
    assert.deepEqual(revealCall.body, { jobId: 'dl-path' }, '请求体里不该出现路径：' + JSON.stringify(revealCall.body))
    assert.doesNotMatch(
      JSON.stringify(revealCall.body),
      /[A-Za-z]:\\\\|Users|Downloads/,
      '本机绝对路径漏到前端了：' + JSON.stringify(revealCall.body),
    )
  })
})

// ================================================================
// 0.4.4 第 4 条：新建文件夹按钮挪到文件夹区右侧 + 「当前路径：」
// ================================================================
describe('0.4.4 第 4 条：新建文件夹按钮在文件夹区右侧，原位置改成「当前路径：」', () => {
  test('左树标题行里有「+ 新建文件夹」，工具条里没有那个按钮了', async () => {
    const h = createHarness()
    const host = await h.mount()

    // 树头里那个 +
    const head = h.byClass(host, 'mc-exTreeHead')[0]
    assert.ok(head, '找不到左树标题行')
    const addBtn = h.byClass(host, 'mc-exTreeAdd')[0]
    assert.ok(addBtn, '文件夹区右侧没有「新建文件夹」按钮')
    assert.equal(typeof addBtn.props.onClick, 'function', '那个按钮点不了')

    // 工具条里不该再有「新建文件夹」按钮
    const tools = h.byClass(host, 'mc-exTools')[0]
    assert.ok(tools, '找不到工具条')
    const toolButtonLabels = (tools.children || [])
      .flat(Infinity)
      .filter((c) => c && typeof c === 'object' && c.type === 'button')
      .map((b) => (b.children || []).flat(Infinity).join(''))
    assert.ok(
      !toolButtonLabels.some((label) => /新建文件夹/.test(label)),
      '工具条里还留着「新建文件夹」按钮：' + JSON.stringify(toolButtonLabels),
    )
  })

  test('工具条里有「当前路径：」标签', async () => {
    const h = createHarness()
    const host = await h.mount()
    const label = h.byClass(host, 'mc-exPathLabel')[0]
    assert.ok(label, '工具条里没有「当前路径：」')
    assert.match(JSON.stringify(label), /当前路径/, '标签文案不对：' + JSON.stringify(label).slice(0, 120))
  })

  test('点树头的 + 会打开新建输入框，建出来落在当前目录', async () => {
    const h = createHarness()
    let host = await h.mount()
    const addBtn = h.byClass(host, 'mc-exTreeAdd')[0]
    addBtn.props.onClick()
    await h.settle(4)
    host = h.renderTree()

    const input = host.find(
      (n) => n.type === 'input' && String((n.props && n.props.placeholder) || '').includes('文件夹名称'),
    )
    assert.ok(input, '点了 + 没有出现新建文件夹的输入框')

    h.calls.length = 0
    input.props.onChange({ target: { value: '新目录' } })
    await h.settle(4)
    host = h.renderTree()
    const createBtn = host.find(
      (n) => n.type === 'button' && (n.children || []).flat().join('').trim() === '创建',
    )
    assert.ok(createBtn, '找不到「创建」按钮')
    createBtn.props.onClick()
    await h.settle(10)

    const mkdirCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/mkdir'))
    assert.ok(mkdirCall, '没有发出 /mkdir')
    assert.equal(mkdirCall.body.name, '新目录')
    assert.equal(mkdirCall.body.parentFileId, '/', '建错了目录')
  })
})

// ================================================================
// 0.4.4 第 5 条：右键多选删除 / 多选移动
// ================================================================
describe('0.4.4 第 5 条：多选删除 / 多选移动', () => {
  function threeRowsHost(h, host) {
    return host.filter(
      (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
    )
  }

  test('Ctrl 点击可以多选，选中集合进入多选提示条', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
      { id: 'C', name: 'c.txt', size: 3, type: 'file', updatedAt: '2026-11-03 10:00:00' },
    ]
    let host = await h.mount()
    let rows = threeRowsHost(h, host)
    assert.equal(rows.length, 3, '没渲染出三行')

    rows[0].props.onClick({ ctrlKey: false, metaKey: false, shiftKey: false })
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)
    rows[1].props.onClick({ ctrlKey: true })
    await h.settle(2)
    host = h.renderTree()

    // 两行都应该是选中态
    const selected = threeRowsHost(h, host)
      .filter((n) => String(n.props.className).includes('mc-exRowSelected'))
    assert.equal(selected.length, 2, 'Ctrl 点击没有加选：选中 ' + selected.length + ' 行')

    // 多选提示条出现
    const bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.ok(bar, '选了两项却没有多选提示条')
    assert.match(JSON.stringify(bar), /已选 2 项/, '提示条上没写选中数量')
  })

  test('Shift 点击是连选（从锚点到当前行）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
      { id: 'C', name: 'c.txt', size: 3, type: 'file', updatedAt: '2026-11-03 10:00:00' },
      { id: 'D', name: 'd.txt', size: 4, type: 'file', updatedAt: '2026-11-04 10:00:00' },
    ]
    let host = await h.mount()
    let rows = threeRowsHost(h, host)
    rows[0].props.onClick({})
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)
    rows[2].props.onClick({ shiftKey: true })
    await h.settle(2)
    host = h.renderTree()

    const selected = threeRowsHost(h, host)
      .filter((n) => String(n.props.className).includes('mc-exRowSelected'))
    assert.equal(selected.length, 3, 'Shift 连选范围不对：' + selected.length + ' 行')
  })

  test('右键落在已选中的行上 → 菜单变成「删除选中的 N 项」', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()
    let rows = threeRowsHost(h, host)
    rows[0].props.onClick({})
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)
    rows[1].props.onClick({ ctrlKey: true })
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)

    rows[0].props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()

    const labels = h.byClass(host, 'mc-menuItem').map((b) => (b.children || []).flat().join(''))
    assert.ok(
      labels.some((l) => /删除选中的 2 项/.test(l)),
      '多选后右键没有批量删除：' + JSON.stringify(labels),
    )
    assert.ok(
      labels.some((l) => /转移选中的 2 项/.test(l)),
      '多选后右键没有批量移动：' + JSON.stringify(labels),
    )
  })

  test('多选删除：一次 /remove 带上全部 id（不是循环发 N 次）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()
    let rows = threeRowsHost(h, host)
    rows[0].props.onClick({})
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)
    rows[1].props.onClick({ ctrlKey: true })
    await h.settle(2)
    host = h.renderTree()

    // 点提示条上的「删除选中的 2 项」
    const bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.ok(bar, '没有多选提示条')
    const removeBtn = (bar.children || [])
      .flat(Infinity)
      .find((n) => n && n.type === 'button' && /删除选中的 2 项/.test((n.children || []).flat().join('')))
    assert.ok(removeBtn, '多选提示条上没有批量删除按钮')

    h.calls.length = 0
    removeBtn.props.onClick()
    await h.settle(10)

    const removeCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/remove'))
    assert.equal(removeCalls.length, 1, '批量删除应该只发一次请求，实际发了 ' + removeCalls.length + ' 次')
    assert.deepEqual(
      (removeCalls[0].body.fileIds || []).slice().sort(),
      ['A', 'B'],
      '一次请求里没带齐所有 id：' + JSON.stringify(removeCalls[0].body),
    )
  })

  test('多选移动：一次 /move 带上全部 id 和目标目录', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.children = {
      '/': [
        { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
        { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
        { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-03 10:00:00' },
      ],
    }
    let host = await h.mount()
    let rows = threeRowsHost(h, host)
    const fileRows = rows.filter((n) => typeof n.props.onDoubleClick === 'function')
    fileRows[0].props.onClick({})
    await h.settle(2)
    host = h.renderTree()
    rows = threeRowsHost(h, host)
    rows.filter((n) => typeof n.props.onDoubleClick === 'function')[1].props.onClick({ ctrlKey: true })
    await h.settle(2)
    host = h.renderTree()

    const bar = h.byClass(host, 'mc-exSelectBar')[0]
    const moveBtn = (bar.children || [])
      .flat(Infinity)
      .find((n) => n && n.type === 'button' && /转移选中的 2 项/.test((n.children || []).flat().join('')))
    assert.ok(moveBtn, '多选提示条上没有批量移动按钮')
    moveBtn.props.onClick()
    await h.settle(10)
    host = h.renderTree()

    // 转移面板打开了，里面有「目标」这个文件夹（0.4.5 起是目录树）
    const movePanel = h.byClass(host, 'mc-movePanel')[0]
    assert.ok(movePanel, '没有打开转移面板')

    const destRow = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-exTreeNode') &&
        JSON.stringify(n).includes('mc-mvNode') &&
        JSON.stringify(n).includes('目标'),
    )
    assert.ok(destRow, '转移树里没有列出目标文件夹')

    /**
     * 0.4.5：转移面板是目录树 —— **单击节点就把它选成目标**（不再需要双击进入）。
     * 双击在树里是「展开/收起」，和左树一致。
     */
    h.calls.length = 0
    destRow.props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()

    const confirmBtn = host.find(
      (n) => n.type === 'button' && /转移 2 项到/.test((n.children || []).flat().join('')),
    )
    assert.ok(confirmBtn, '底部按钮没有体现「转移 2 项」')
    confirmBtn.props.onClick()
    await h.settle(12)

    const moveCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/move'))
    assert.equal(moveCalls.length, 1, '批量移动应该只发一次请求')
    assert.deepEqual(
      (moveCalls[0].body.fileIds || []).slice().sort(),
      ['A', 'B'],
      '一次请求里没带齐所有 id：' + JSON.stringify(moveCalls[0].body),
    )
    assert.equal(moveCalls[0].body.toParentFileId, 'DEST', '目标目录不对')
  })
})

// ================================================================
// 0.4.5 第 3 条：转移面板 = 首页左侧那样的目录树
// ----------------------------------------------------------------
// 用户原话：「转移文件面板是要做成首页左侧文件夹那样的样式，重新修改，
//            不是这种点完一级上级就没了」
// 所以断言的重点是：**展开下级之后，上级仍然在屏幕上**。
// ================================================================
describe('0.4.5 第 3 条：转移面板是树，上级不会消失', () => {
  /** 在右侧列表里按文件名找那一行（.mc-exRow + 文本匹配）。 */
  function rowByText(host, text) {
    return host.find(
      (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow') &&
        JSON.stringify(n).includes(text),
    )
  }

  /** 打开「转移到…」面板（右键 → 菜单项）。 */
  async function openMovePanelFor(h, rowText) {
    let host = h.renderTree()
    const row = rowByText(host, rowText)
    assert.ok(row, '找不到那一行：' + rowText)
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const moveItem = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-menuItem') &&
        /转移到/.test((n.children || []).flat().join('')),
    )
    assert.ok(moveItem, '右键菜单里没有「转移到…」')
    moveItem.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(10)
    return h.renderTree()
  }

  /**
   * 在转移树里按名字找节点。
   *
   * 树节点的结构是：
   *   div[key=mvtnX]
   *     ├─ div.mc-exTreeNode.mc-mvNode      ← 这一行（点击 / 双击挂这儿）
   *     └─ div.mc-exTreeKids                ← 子孙
   *
   * 所以「按名字找」= 找那个 .mc-mvNode 本体的文本等于 name。
   * 注意不能对整棵子树做 JSON.stringify 匹配 —— 父节点会把自己的子孙也包含进去，
   * 那样「一层」永远能在根节点那一大坨里命中，测出来的东西是假的。
   */
  function moveNode(host, name) {
    return host.find((n) => {
      const cls = String((n.props && n.props.className) || '')
      if (!cls.split(/\s+/).includes('mc-mvNode')) return false
      const label = (n.children || [])
        .flat(Infinity)
        .filter((c) => c && typeof c === 'object' && String((c.props && c.props.className) || '').includes('mc-exTreeName'))
        .map((c) => (c.children || []).flat(Infinity).join(''))
        .join('')
      return label === name
    })
  }

  test('展开下级后，根和上级都还在（不是「点完一级上级就没了」）', async () => {
    const h = createHarness()
    h.backend.children = {
      '/': [
        { id: 'src', name: '要移动的.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
        { id: 'L1', name: '一层', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
      ],
      L1: [{ id: 'L2', name: '二层', size: 0, type: 'folder', updatedAt: '2026-11-03 10:00:00' }],
      L2: [{ id: 'L3', name: '三层', size: 0, type: 'folder', updatedAt: '2026-11-04 10:00:00' }],
    }
    await h.mount()
    let host = await openMovePanelFor(h, '要移动的.txt')

    // 一开始只有根 + 一层
    assert.ok(moveNode(host, '一层'), '转移树里没有「一层」')

    // 双击「一层」= 展开（树里的双击是展开，不是「跳走」）
    moveNode(host, '一层').props.onDoubleClick()
    await h.settle(12)
    host = h.renderTree()

    // 🔴 关键：展开之后，「一层」**还在**，而且「二层」出现了
    assert.ok(moveNode(host, '一层'), '展开后上一级「一层」消失了（又变成点一下上级就没了）')
    assert.ok(moveNode(host, '二层'), '双击没有展开出「二层」')

    // 再展开二层，三层出现，且「一层」「二层」都还在
    moveNode(host, '二层').props.onDoubleClick()
    await h.settle(12)
    host = h.renderTree()

    assert.ok(moveNode(host, '一层'), '展开两层后「一层」消失了')
    assert.ok(moveNode(host, '二层'), '展开两层后「二层」消失了')
    assert.ok(moveNode(host, '三层'), '没有展开出「三层」')

    // 根节点也一直可见
    const rootNode = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-mvNode') &&
        JSON.stringify(n).includes('"mc-exTreeName"'),
    )
    assert.ok(rootNode, '根节点不见了')
  })

  test('单击节点 = 选中为目标（不需要双击进入）', async () => {
    const h = createHarness()
    h.backend.children = {
      '/': [
        { id: 'src', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
        { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
      ],
    }
    await h.mount()
    let host = await openMovePanelFor(h, 'a.txt')

    h.calls.length = 0
    moveNode(host, '目标').props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()

    // 单击不该发列表请求（不跳转，只是选中）
    assert.equal(
      h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list')).length,
      0,
      '单击节点就发了列表请求（又变成「点一下就跳走」了）',
    )
    // 底部按钮应该已经指向「目标」
    const confirmBtn = host.find(
      (n) => n.type === 'button' && /转移到「目标」/.test((n.children || []).flat().join('')),
    )
    assert.ok(confirmBtn, '单击选中后底部按钮没有指向「目标」')
  })

  test('🔴 子目录必须显示三角标（否则用户以为「只有 / 这一层」）', async () => {
    const h = createHarness()
    h.backend.children = {
      '/': [
        { id: 'src', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
        { id: 'L1', name: '一层', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
      ],
      // 一层里面有子目录 → 它必须显示三角标
      L1: [{ id: 'L2', name: '二层', size: 0, type: 'folder', updatedAt: '2026-11-03 10:00:00' }],
    }
    await h.mount()
    const host = await openMovePanelFor(h, 'a.txt')

    const node = moveNode(host, '一层')
    assert.ok(node, '转移树里没有「一层」')

    // 三角标是嵌在 <button.mc-exTreeToggle> 里的 <span.mc-exCaretSlot>，
    // 所以要**递归**找（flat 只摊平数组，不会钻进对象）
    function findByClass(root, cls) {
      if (!root || typeof root !== 'object') return null
      const own = String((root.props && root.props.className) || '')
      if (own.split(/\s+/).includes(cls)) return root
      for (const child of root.children || []) {
        const hit = findByClass(child, cls)
        if (hit) return hit
      }
      return null
    }

    const caret = findByClass(node, 'mc-exCaretSlot')
    assert.ok(caret, '「一层」那一行没有三角标格子')

    const caretSvg = findByClass(node, 'mc-exCaret')
    assert.ok(
      caretSvg,
      '🔴「一层」里有子目录，但三角标是留白 —— 用户会以为这一层下面没东西，' +
        '于是以为「转移面板只有 / 目录下的文件」',
    )
  })

  test('三角标可以收起：收起后下级隐藏、上级仍在', async () => {    const h = createHarness()
    h.backend.children = {
      '/': [
        { id: 'src', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
        { id: 'L1', name: '一层', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
      ],
      L1: [{ id: 'L2', name: '二层', size: 0, type: 'folder', updatedAt: '2026-11-03 10:00:00' }],
    }
    await h.mount()
    let host = await openMovePanelFor(h, 'a.txt')

    moveNode(host, '一层').props.onDoubleClick()
    await h.settle(12)
    host = h.renderTree()
    assert.ok(moveNode(host, '二层'), '没有展开出「二层」')

    // 找到「一层」那一行里的三角标按钮，点它收起
    const target = moveNode(host, '一层')
    const toggle = (target.children || [])
      .flat(Infinity)
      .find((c) => c && String((c.props && c.props.className) || '').includes('mc-exTreeToggle'))
    assert.ok(toggle, '树节点里没有三角标按钮')
    toggle.props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()

    assert.ok(moveNode(host, '一层'), '收起后「一层」自己不见了')
    assert.ok(!moveNode(host, '二层'), '收起后「二层」还显示着')
  })

  test('不能把文件夹转移进它自己里面（树里标记为不可选）', async () => {
    const h = createHarness()
    h.backend.children = {
      '/': [
        { id: 'DIR', name: '照片', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
        { id: 'OTHER', name: '别处', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
      ],
      DIR: [{ id: 'SUB', name: '子目录', size: 0, type: 'folder', updatedAt: '2026-11-03 10:00:00' }],
    }
    let host = await h.mount()
    host = await openMovePanelFor(h, '照片')

    // 展开「照片」，它的子目录应该被标成不可选
    moveNode(host, '照片').props.onDoubleClick()
    await h.settle(12)
    host = h.renderTree()

    const sub = moveNode(host, '子目录')
    assert.ok(sub, '没有展开出子目录')
    assert.match(
      JSON.stringify(sub),
      /mc-mvNodeDisabled|moveInside/,
      '往自己里面搬的节点没有被标记为不可选',
    )
  })
})

// ================================================================
// 0.4.4 第 7 条：重命名不再依赖 window.prompt（Electron 里它永远返回 null）
// ================================================================
describe('0.4.4 第 7 条：重命名真的能改名', () => {
  test('即使 window.prompt 不可用，重命名也能发出 /rename', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'DIR1', name: '旧名字', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]

    let host = await h.mount()
    const row = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRow') &&
        typeof n.props.onContextMenu === 'function',
    )
    assert.ok(row, '没有渲染出文件夹行')
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const renameItem = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-menuItem') &&
        /重命名/.test((n.children || []).flat().join('')),
    )
    assert.ok(renameItem, '右键菜单里没有「重命名」')

    renameItem.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(8)
    host = h.renderTree()

    // 应该是面板内的输入框，而不是浏览器原生 prompt
    const input = host.find(
      (n) => n.type === 'input' &&
        String((n.props && n.props.value) || '') === '旧名字' &&
        String((n.props && n.props.className) || '').includes('mc-input'),
    )
    assert.ok(input, '点重命名没有出现输入框（是不是又用回 window.prompt 了？）')

    h.calls.length = 0
    input.props.onChange({ target: { value: '新名字' } })
    await h.settle(4)
    host = h.renderTree()
    const saveBtn = host.find(
      (n) => n.type === 'button' && (n.children || []).flat().join('').trim() === '保存',
    )
    assert.ok(saveBtn, '重命名弹层里没有「保存」')
    saveBtn.props.onClick()
    await h.settle(12)

    const renameCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/rename'))
    assert.ok(renameCall, '没有发出 /rename（重命名还是无效）')
    assert.equal(renameCall.body.fileId, 'DIR1')
    assert.equal(renameCall.body.name, '新名字')
  })

  test('名字没改时不会白发一次请求', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'DIR1', name: '同名', size: 0, type: 'folder', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()
    const row = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRow') &&
        typeof n.props.onContextMenu === 'function',
    )
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const renameItem = host.find(
      (n) => String((n.props && n.props.className) || '').includes('mc-menuItem') &&
        /重命名/.test((n.children || []).flat().join('')),
    )
    renameItem.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(8)
    host = h.renderTree()

    h.calls.length = 0
    const saveBtn = host.find(
      (n) => n.type === 'button' && (n.children || []).flat().join('').trim() === '保存',
    )
    saveBtn.props.onClick()
    await h.settle(10)

    assert.equal(
      h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/rename')).length,
      0,
      '名字没变也发了 /rename',
    )
  })
})

// ================================================================
// 0.4.4 第 8 条：面板边缘不再能拖动外层对话区宽度
// ================================================================
describe('0.4.4 第 8 条：本页签挂载时关掉 DSH 的对话区宽度手柄', () => {
  test('挂载时把 [data-width-handle] 藏掉，卸载时还原', async () => {
    const h = createHarness()

    // 造两条和 DSH 一模一样的宽度手柄
    function makeHandle(side) {
      const el = makeElement('div')
      el.dataset = { widthHandle: side }
      el.style = { display: '' }
      return el
    }
    const left = makeHandle('left')
    const right = makeHandle('right')
    h.docHandles = [left, right]
    h.doc.querySelectorAll = (selector) => {
      if (selector === '[data-width-handle]') return h.docHandles
      return { length: 0, item: () => null }
    }

    await h.mount()
    assert.equal(left.style.display, 'none', '左手柄没被关掉（还能拖外层对话区宽度）')
    assert.equal(right.style.display, 'none', '右手柄没被关掉')

    // 卸载 = 切走这个页签
    h.unmountView()
    await h.settle(2)
    assert.equal(left.style.display, '', '卸载后没把左手柄还原')
    assert.equal(right.style.display, '', '卸载后没把右手柄还原')
  })
})

// ================================================================
// 0.4.6 第 2 条：多选模式是**开关**
// ----------------------------------------------------------------
// 用户原话：「名称左边改成一个按钮叫多选按钮，没点之前就和之前版本那样，
//            点了之后就变成现在的样子」
//
// 所以断言三件事：
//   1. 默认**没有**复选框（和 0.4.3 一样干净）；
//   2. 点「多选」之后复选框出现、能勾、提示条出现；
//   3. 再点一次退出：复选框消失，选中集合也被清空（不留隐形状态）。
// ================================================================
describe('0.4.6 第 2 条：多选是开关，默认和旧版一样', () => {
  const rowChecksOf = (nodes) => nodes.filter(
    (n) => n.type === 'input' &&
      String((n.props && n.props.className) || '').includes('mc-exRowCheck') &&
      String((n.props && n.props.title) || '') === '选中这一项（可多选）',
  )
  const allChecksOf = (nodes) => nodes.filter(
    (n) => n.type === 'input' && String((n.props && n.props.className) || '').includes('mc-exRowCheck'),
  )
  const multiBtnOf = (host) => host.find(
    (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exMultiBtn'),
  )

  test('默认没有复选框和多选条（和 0.4.3 一样）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    const host = await h.mount()

    assert.equal(allChecksOf(host).length, 0, '默认就画了复选框（用户要求默认和旧版一样）')
    assert.equal(h.byClass(host, 'mc-exSelectBar').length, 0, '默认不该出现多选提示条')
    // 但「多选」按钮必须在（那是入口）
    const btn = multiBtnOf(host)
    assert.ok(btn, '「名称」左边没有多选按钮')
    assert.match(JSON.stringify(btn), /多选/, '按钮上没有「多选」字样')
  })

  test('点按钮进入多选：复选框出现，勾两项就出提示条和批量动作', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()

    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()

    const rowChecks = rowChecksOf(allChecksOf(host))
    assert.equal(rowChecks.length, 2, '进入多选后两行应各有复选框，实际 ' + rowChecks.length)
    assert.equal(allChecksOf(host).length, 3, '还应有列头全选，实际总数 ' + allChecksOf(host).length)

    rowChecks[0].props.onChange()
    await h.settle(4)
    host = h.renderTree()
    let bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.ok(bar, '勾了一项却没有出现多选提示条')

    rowChecksOf(allChecksOf(host))[1].props.onChange()
    await h.settle(4)
    host = h.renderTree()
    bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.match(JSON.stringify(bar), /已选 2 项/, '勾选两个后计数不对')
    const barText = JSON.stringify(bar)
    assert.match(barText, /删除选中的 2 项/, '多选提示条上没有「删除」')
    assert.match(barText, /转移选中的 2 项/, '多选提示条上没有「转移」')
  })

  test('再点一次退出：复选框消失，选中集合也清空（不留隐形状态）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()

    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()
    rowChecksOf(allChecksOf(host))[0].props.onChange()
    await h.settle(4)
    host = h.renderTree()
    assert.ok(h.byClass(host, 'mc-exSelectBar')[0], '进入多选并勾选后应有提示条')

    // 退出多选
    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()

    assert.equal(allChecksOf(host).length, 0, '退出后复选框没消失')
    assert.equal(
      h.byClass(host, 'mc-exSelectBar').length,
      0,
      '退出后多选提示条还在（说明选中集合没清空，会留下隐形状态）',
    )
  })

  test('多选模式下点行 = 勾选，不需要按 Ctrl', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()

    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()

    const rowsOf = () => h.renderTree().filter(
      (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
    )
    // 普通点击（没有 ctrlKey）就该勾上
    rowsOf()[0].props.onClick({})
    await h.settle(4)
    host = h.renderTree()
    let selected = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRowSelected'),
    )
    assert.equal(selected.length, 1, '多选模式下点行没有勾上')

    // 再点同一个 = 取消勾选
    rowsOf()[0].props.onClick({})
    await h.settle(4)
    host = h.renderTree()
    selected = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRowSelected'),
    )
    assert.equal(selected.length, 0, '多选模式下再点一次没有取消勾选')
  })

  test('点复选框不会顺带触发「点行」把选择又清掉', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()
    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()

    const check = rowChecksOf(allChecksOf(host))[0]
    assert.ok(check, '进入多选后没有行复选框')
    assert.equal(typeof check.props.onClick, 'function', '复选框没有 onClick（拦不住冒泡）')

    let stopped = false
    check.props.onClick({ stopPropagation() { stopped = true } })
    assert.ok(stopped, '复选框没有阻止冒泡 —— 点它会顺带触发点行，把选择清掉')

    check.props.onChange()
    await h.settle(4)
    host = h.renderTree()
    const selected = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exRowSelected'),
    )
    assert.equal(selected.length, 1, '勾选之后那一行没有进入选中态')
  })

  test('列头全选：一次选中所有可见行，再点一次全清', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
      { id: 'C', name: 'c.txt', size: 3, type: 'file', updatedAt: '2026-11-03 10:00:00' },
    ]
    let host = await h.mount()
    multiBtnOf(host).props.onClick()
    await h.settle(6)
    host = h.renderTree()

    const allBox = () => h.renderTree().find(
      (n) => n.type === 'input' && String((n.props && n.props.className) || '').includes('mc-exRowCheck') &&
        String((n.props && n.props.title) || '').includes('全选'),
    )
    let box = allBox()
    assert.ok(box, '列头没有全选复选框')

    box.props.onChange()
    await h.settle(6)
    host = h.renderTree()
    let bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.match(JSON.stringify(bar), /已选 3 项/, '全选没有选中全部 3 行')

    box = allBox()
    box.props.onChange()
    await h.settle(6)
    host = h.renderTree()
    bar = h.byClass(host, 'mc-exSelectBar')[0]
    assert.equal(bar, undefined, '再点一次全选没有清空选择')
  })
})

// ================================================================
// 0.4.8 布局 / 配色：两个「看着就难受」的真 bug
// ----------------------------------------------------------------
// 1. 「多选按钮和名称糊一块儿，下面的文件也显示不完全，名字被截断」
//    —— 按钮被塞进了 display:grid 的 .mc-exCols，占掉第一个网格列（复选框列），
//       整条网格往后错一格：按钮和「名称」挤在一起，名称列被挤出可视区。
// 2. 「点了是选中色，鼠标移上去又和没选一样」
//    —— hover 用的 LAYER_1(0.06) 比 selected 的 LAYER_2(0.12) 还浅，
//       而且选择器顺序让 hover 盖掉了选中态。
// ================================================================
describe('0.4.8：多选按钮不能挤坏列头，选中色必须压过 hover', () => {
  test('多选按钮不占网格列，也不额外挤压网格宽度', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    const host = await h.mount()

    const btn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exMultiBtn'),
    )
    assert.ok(btn, '找不到多选按钮')

    const cols = h.byClass(host, 'mc-exCols')[0]
    assert.ok(cols, '找不到列头网格 .mc-exCols')

    // ① 网格自己的子元素里不能有那个按钮（不能占掉第一个网格列）
    const gridChildren = (cols.children || []).flat(Infinity).filter((c) => c && typeof c === 'object')
    const btnInGrid = gridChildren.some(
      (c) => c.type === 'button' && String((c.props && c.props.className) || '').includes('mc-exMultiBtn'),
    )
    assert.equal(
      btnInGrid,
      false,
      '🔴 多选按钮被塞进了 .mc-exCols（display:grid）—— 它会占掉第一个网格列，把「名称」列挤出去',
    )

    // ② 不能再用「外面包一层 flex」（0.4.8 的错法：压缩网格宽度）
    assert.equal(
      h.byClass(host, 'mc-exColsRow').length,
      0,
      '🔴 还在用 .mc-exColsRow 包 flex —— 网格宽度被压缩，名称列仍会被挤',
    )

    // ③ 也不能用绝对定位 + 手算 padding（0.4.9/10 的错法）
    assert.equal(
      h.byClass(host, 'mc-exColsHost').length,
      0,
      '🔴 还在用 .mc-exColsHost 绝对定位 —— 手算宽度必然差几像素',
    )

    // ④ 正确：按钮是列头网格里的一个普通格子
    const multiCell = h.byClass(host, 'mc-exColsMultiCell')[0]
    assert.ok(multiCell, '没有 .mc-exColsMultiCell（按钮该是网格里的一个普通格子）')
    const inGrid = gridChildren.some(
      (c) => String((c.props && c.props.className) || '').includes('mc-exColsMultiCell'),
    )
    assert.equal(inGrid, true, '按钮格子不是网格的直接子元素 —— 宽度不会被一起分配')
  })

  /**
   * 🔴 0.4.12 的真根因：**网格子元素个数必须等于列数**。
   *
   * 用户截图里未开多选时：名字整段消失、大小右移、时间被切。
   * 因为那一格的复选框被 `null` 掉了 → 行只剩 3 个子元素 →
   * 名称被塞进 0px 的复选框列（裁没），大小进名称列，时间进大小列。
   *
   * 0.4.13 改成 4 列 4 格（名称 / 复选框 / 大小 / 时间），
   * 列头与行**完全同构**，两个方向都钉住。
   */
  test('网格子元素个数必须等于列数（否则整行错位）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]

    // 未开多选（用户截图里出问题的状态）
    const host = await h.mount()
    const cols = h.byClass(host, 'mc-exCols')[0]
    assert.ok(cols, '找不到列头网格')

    const countCells = (node, classes) => {
      let n = 0
      const walk = (cur) => {
        if (!cur || typeof cur !== 'object') return
        const cls = String((cur.props && cur.props.className) || '')
        if (classes.some((c) => cls.split(/\s+/).includes(c))) n += 1
        for (const child of cur.children || []) walk(child)
      }
      walk(node)
      return n
    }

    // 列头 4 格：名称 / 复选框+多选 / 大小 / 时间
    const headCells = countCells(cols, [
      'mc-exColsName', 'mc-exColsMultiCell', 'mc-exColsSize', 'mc-exColsTime',
    ])
    assert.equal(
      headCells,
      4,
      '🔴 列头有 ' + headCells + ' 个格子，但网格定义了 4 列 —— 会整体错位',
    )

    // 行 4 格：名称 / 复选框 / 大小 / 时间
    const row = host.find(
      (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
    )
    assert.ok(row, '没渲染出行')
    const rowCells = countCells(row, [
      'mc-exRowName', 'mc-exRowCheckCell', 'mc-exRowSize', 'mc-exRowTime',
    ])
    assert.equal(
      rowCells,
      4,
      '🔴 行有 ' + rowCells + ' 个网格格子，但定义了 4 列 —— 会错位' +
        '（**未开多选时也必须渲染复选框那一格**，否则名字会被塞进 0 宽列）',
    )
  })

  test('列头的网格列数与行一致（同一套 4 列模板）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    const host = await h.mount()

    // 列头和行必须用**同一套** grid-template-columns（顺序也一致）
    const colsTpl = (SRC.match(/\.mc-exCols\{[^}]*grid-template-columns:([^;]+);/) || [])[1] || ''
    const rowTpl = (SRC.match(/\.mc-exRow\{[^}]*grid-template-columns:([^;]+);/) || [])[1] || ''
    assert.ok(colsTpl && rowTpl, '没提取到网格模板')
    assert.equal(
      colsTpl.trim(),
      rowTpl.trim(),
      '🔴 列头和行的网格模板不一致 —— 上下必然错位\n列头：' + colsTpl + '\n行  ：' + rowTpl,
    )

    const row = host.find(
      (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
    )
    assert.ok(row, '没渲染出行')
    const cells = (row.children || []).flat(Infinity).filter((c) => c && typeof c === 'object')
    const nameCell = cells.find(
      (c) => String((c.props && c.props.className) || '').includes('mc-exRowName'),
    )
    assert.ok(nameCell, '行里没有名称单元格')
  })

  test('选中色不能和 hover 混为一谈（CSS 层级与颜色都要分开）', async () => {
    const src = SRC

    // 1) 选中态必须显式覆盖 hover，否则鼠标一移上去就「看起来没选中」
    assert.match(
      src,
      /\.mc-exRowSelected,\.mc-exRowSelected:hover\{background:/,
      '没有 `.mc-exRowSelected,.mc-exRowSelected:hover` 规则 —— hover 会盖掉选中色',
    )

    // 2) 树节点同理（转移面板选目标就是这种情形）
    assert.match(
      src,
      /\.mc-exTreeNodeActive:hover/,
      '树节点没有 `选中:hover` 规则 —— 转移面板里鼠标移上去选中色会消失',
    )

    // 3) 选中色必须是独立的变量，不能复用 LAYER_1/LAYER_2
    assert.match(src, /var SELECT_BG = /, '没有独立的 SELECT_BG 变量')
    const selectLine = (src.match(/var SELECT_BG = '([^']+)'/) || [])[1] || ''
    assert.ok(selectLine && !/LAYER_/.test(selectLine), 'SELECT_BG 复用了 LAYER 变量：' + selectLine)

    // 4) 选中色不能太亮（0.4.9：用户说「多选点完之后太亮了」）
    //    取 rgba(...) 里最后一个数字当透明度，必须 <= 0.10
    const alphaMatch = selectLine.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/)
    assert.ok(alphaMatch, 'SELECT_BG 里没解析出 rgba 透明度：' + selectLine)
    const alpha = Number(alphaMatch[1])
    assert.ok(
      alpha <= 0.1,
      '🔴 SELECT_BG 透明度 ' + alpha + ' 太亮了（用户反馈整列选中时刺眼），应 <= 0.10',
    )
  })

  /**
   * 0.4.10：两个残留的问题，各来一条断言钉住。
   *
   * 1. 「不点多选时名称还是被遮住，点了多选反而不遮」
   *    —— 两档预留宽度不一致（或按钮比预留宽）。现在统一用 --mc-multi-w。
   * 2. 「点多选之后按钮变白，字看不见了」
   *    —— ON 态原来写 `color:#fff`，遇到浅色品牌色就是白底白字。
   */
  /**
   * 0.4.11：这个位置改了四次，最后用「多开一列」解决。
   *
   * 三次错法的共同点都是**手算宽度跟自动布局对抗**：
   *   塞进已有网格列 / 包 flex / 绝对定位 + padding-left。
   * 现在不再算宽度 —— 列头网格多一列容纳按钮，浏览器自己分配。
   */
  /**
   * 🔴 0.4.14：用户要求「点击多选后，多选和多选左边的一键选择框交换位置」。
   *
   * 这一格是 flex-end（内容靠右）。0.4.13 顺序是「全选框 → 多选按钮」，
   * 视觉上全选框在左。现在对调成「多选按钮 → 全选框」，
   * 也就是按钮固定靠左、全选框从它右侧长出来。
   */
  test('多选按钮在左、全选框在右（进入多选后位置不跳）', async () => {
    const src = SRC

    // 在这一格的源码片段里，按钮必须出现在复选框之前
    const cellStart = src.indexOf("className: 'mc-exColsMultiCell'")
    assert.ok(cellStart > 0, '找不到 .mc-exColsMultiCell')
    const seg = src.slice(cellStart, cellStart + 1600)
    const btnAt = seg.indexOf('mc-exMultiBtn')
    const checkAt = seg.indexOf('mc-exRowCheck')
    assert.ok(btnAt >= 0, '这一格里没有多选按钮')
    assert.ok(checkAt >= 0, '这一格里没有全选框')
    assert.ok(
      btnAt < checkAt,
      '🔴 顺序还是「全选框在前」—— 用户要求对调：多选按钮在左、全选框在右',
    )
  })

  /**
   * 🔴 0.4.14 用户补充：「一键选择框要和下面的选择框对齐」。
   *
   * 也就是列头的全选框必须和每一行的复选框**竖直对齐**。
   * 这两个格子在不同容器里（一个在列头网格、一个在行网格），
   * 要对齐就必须满足：
   *   ① 它们是各自网格的**同一列**（模板一致）；
   *   ② 内容都靠右（flex-end），且右内边距相同。
   * 任何一条不满足都会左右错开几像素。
   */
  test('列头全选框必须和行复选框竖直对齐', async () => {
    const src = SRC

    // ① 取两个格子的 CSS 规则
    const multiCell = (src.match(/\.mc-exColsMultiCell\{[^}]*\}/) || [])[0] || ''
    const checkCell = (src.match(/\.mc-exRowCheckCell\{[^}]*\}/) || [])[0] || ''
    assert.ok(multiCell && checkCell, '没找到这两个格子的规则')

    // ② 都必须靠右
    assert.match(multiCell, /justify-content:flex-end/, '列头第2格没有靠右对齐')
    assert.match(checkCell, /justify-content:flex-end/, '行第2格没有靠右对齐')

    // ③ 右内边距必须一致（否则复选框会左右错开）
    const rightPad = (rule) => {
      const m = rule.match(/padding(?:-right)?:\s*([^;}]+)/)
      if (!m) return null
      const v = m[1].trim()
      // padding:0 6px 0 0 → 取第 2 个值；padding-right:6px → 取自身
      const parts = v.split(/\s+/)
      return parts.length === 1 ? parts[0] : (parts.length === 2 ? parts[1] : parts[1])
    }
    const a = rightPad(multiCell)
    const b = rightPad(checkCell)
    assert.equal(
      a,
      b,
      '🔴 两个格子的右内边距不一致（列头 ' + a + ' vs 行 ' + b + '）—— 全选框和行复选框会左右错开',
    )
  })

  test('多选控件紧贴「大小」左边线，名称不贴左线', async () => {
    const src = SRC

    // ① 第 2 格（复选框+多选按钮）右对齐 —— 这样它贴着「大小」左边线
    assert.match(
      src,
      /\.mc-exColsMultiCell\{[^}]*justify-content:flex-end/,
      '🔴 多选那一格没有右对齐 —— 控件不会紧贴「大小」左边线',
    )
    // 行里那一格同理
    assert.match(
      src,
      /\.mc-exRowCheckCell\{[^}]*justify-content:flex-end/,
      '🔴 行的复选框格没有右对齐 —— 上下对不齐',
    )

    // ② 名称列必须有足够左边距（用户：「名字不要再贴着左边的线」）
    //    实际写的是 padding:0 8px 0 clamp(12px,1.8vw,20px)，所以取 clamp 的最小值
    const nameRule = (src.match(/\.mc-exColsName\{[^}]*\}/) || [])[0] || ''
    const clampMin = Number((nameRule.match(/clamp\((\d+)px/) || [])[1] || 0)
    assert.ok(
      clampMin >= 12,
      '🔴 名称列左边距只有 ' + clampMin + 'px —— 还是贴着左边线\n' + nameRule,
    )
    // 行里的名称也要用同一档左边距
    assert.match(
      src,
      /\.mc-exRowName\{[^}]*clamp\(12px/,
      '行的名称左边距和列头不一致（或太小）',
    )

    // ③ 网格模板里第 2 列就是「check + multi」，紧跟名称列
    assert.match(
      src,
      /grid-template-columns:minmax\(0,1fr\) calc\(var\(--mc-check-w[^)]*\) \+ var\(--mc-multi-w/,
      '网格第 2 列不是「复选框 + 多选按钮」',
    )
  })

  test('多选按钮 ON 态不能用白字（浅色主题下会看不见）', async () => {
    const src = SRC

    // 抓出所有 .mc-exMultiBtnOn 规则
    const onRules = src.match(/\.mc-exMultiBtnOn[^']*'[^']*'/g) || []
    assert.ok(onRules.length > 0, '找不到 .mc-exMultiBtnOn 规则')

    for (const rule of onRules) {
      assert.doesNotMatch(
        rule,
        /color:\s*#fff|color:\s*white|color:\s*#ffffff/i,
        '🔴 ON 态用了白字：' + rule + ' —— 品牌色一旦是浅色/浅主题就变成白底白字',
      )
    }
  })
})

// ================================================================
// 0.4.7：删除传输**记录**（不是文件）
// ----------------------------------------------------------------
// 用户原话：「每处都加个一键删除记录，就把当下的传输记录全删除了；
//            再在单个传输文件加一个删除按钮，点击就删除该文件的传输记录，
//            注意删除的不是文件，而是记录」
// ================================================================
describe('0.4.7：删除传输记录（不删文件）', () => {
  function makeJobs() {
    return [
      {
        id: 'u1', kind: 'upload', label: '照片.jpg', phase: 'complete', done: 10, total: 10,
        state: 'done', error: null, startedAt: Date.now() - 9000, finishedAt: Date.now() - 5000,
        canRevealLocal: false, hasLocalPath: false, parentFileId: 'P1', parentPath: '/a', fileId: 'F1',
      },
      {
        id: 'd1', kind: 'download', label: 'a.zip', phase: 'download', done: 5, total: 5,
        state: 'done', error: null, startedAt: Date.now() - 8000, finishedAt: Date.now() - 4000,
        canRevealLocal: true, hasLocalPath: true, parentFileId: null, parentPath: null,
      },
    ]
  }

  async function openHistoryTo(h, tab) {
    let host = await h.mount()
    host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    ).props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()
    if (tab === 'upload') {
      host.find(
        (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistTab') &&
          (n.children || []).join('').includes('上传'),
      ).props.onClick()
      await h.settle(10)
      host = h.renderTree()
      await h.settle(8)
      host = h.renderTree()
    }
    return host
  }

  test('每条记录都有「删除」按钮', async () => {
    const h = createHarness()
    h.backend.jobs = makeJobs()
    const host = await openHistoryTo(h, 'download')

    const removeBtns = host.filter(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistRemove'),
    )
    assert.ok(removeBtns.length >= 1, '记录行里没有「删除这条记录」按钮')
  })

  test('单条删除：发 POST /transfers/remove，只带 jobId', async () => {
    const h = createHarness()
    h.backend.jobs = makeJobs()
    const host = await openHistoryTo(h, 'download')

    const btn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistRemove'),
    )
    assert.ok(btn, '找不到删除按钮')

    h.calls.length = 0
    btn.props.onClick({ stopPropagation() {} })
    await h.settle(12)

    const call = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/transfers/remove'))
    assert.ok(call, '没有发出 /transfers/remove（实际调用：' + JSON.stringify(h.calls.map((c) => c.path)) + '）')
    assert.ok(call.body.jobId, '请求里没带 jobId')
    // 🔴 关键：删的是记录，请求体里不该出现任何「删文件」的字段
    assert.equal(call.body.fileId, undefined, '请求里出现了 fileId —— 难道要删文件？')
    assert.equal(call.body.deleteFile, undefined, '请求里出现了 deleteFile')
  })

  test('一键删除：发 POST /transfers/clear，带上当前页签的 family', async () => {
    const h = createHarness()
    h.backend.jobs = makeJobs()
    const host = await openHistoryTo(h, 'upload')

    const clearBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.props && n.props.className) || '').includes('mc-btnDanger') &&
        /一键删除/.test((n.children || []).flat().join('')),
    )
    assert.ok(clearBtn, '上传页签里没有「一键删除」按钮')

    h.calls.length = 0
    clearBtn.props.onClick()
    await h.settle(12)

    const call = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/transfers/clear'))
    assert.ok(call, '没有发出 /transfers/clear')
    assert.equal(call.body.family, 'upload', '一键删除没有指定 family（会误删另一页的记录）')
  })

  test('正在传输中的记录：删除按钮置灰', async () => {
    const h = createHarness()
    h.backend.jobs = [{
      id: 'running1', kind: 'download', label: 'big.iso', phase: 'download', done: 1, total: 100,
      state: 'running', error: null, startedAt: Date.now(), finishedAt: null,
      canRevealLocal: false, hasLocalPath: false, parentFileId: null, parentPath: null,
    }]
    const host = await openHistoryTo(h, 'download')

    const btn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistRemove'),
    )
    assert.ok(btn, '找不到删除按钮')
    assert.equal(btn.props.disabled, true, '传输中的记录删除按钮没有置灰')
  })
})
describe('0.4.5 第 1 条：上传记录的定位要落到真正那一层', () => {
  /** 造一条「parentPath 为 null、只有 parentFileId」的上传记录。 */
  function uploadJobWithoutPath() {
    return {
      id: 'up-nopath',
      kind: 'upload',
      label: '照片.jpg',
      phase: 'complete',
      done: 100,
      total: 100,
      state: 'done',
      error: null,
      startedAt: Date.now() - 9000,
      finishedAt: Date.now() - 5000,
      canRevealLocal: false,
      hasLocalPath: false,
      parentFileId: 'DEEP',
      // 🔴 关键：这里没有路径
      parentPath: null,
      fileId: 'IMG1',
      name: '照片.jpg',
      dedup: false,
    }
  }

  async function openHistoryWith(h) {
    let host = await h.mount()
    const histBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    host = h.renderTree()

    const upTab = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistTab') &&
        (n.children || []).join('').includes('上传'),
    )
    upTab.props.onClick()
    await h.settle(10)
    host = h.renderTree()
    await h.settle(8)
    return h.renderTree()
  }

  test('parentPath 为 null 时，用宿主反查的 trail 铺出完整路径（不再掉回根目录）', async () => {
    const h = createHarness()
    h.backend.jobs = [uploadJobWithoutPath()]
    // 宿主反查出来的完整 trail（含每一级的真实 fileId）
    h.backend.locatable = {
      ok: true,
      canReveal: true,
      kind: 'remote',
      reason: '',
      path: '/Windows/实验/数字图像实验/第一周实验结果',
      trail: [
        { id: 'ROOT-W', name: 'Windows' },
        { id: 'EXP', name: '实验' },
        { id: 'DIMG', name: '数字图像实验' },
        { id: 'DEEP', name: '第一周实验结果' },
      ],
    }

    const host = await openHistoryWith(h)
    const revealBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.ok(revealBtn, '上传记录没有「定位」按钮')

    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(14)
    const after = h.renderTree()
    await h.settle(8)

    // 关键断言：应该按 DEEP 那一层去 list，而不是根
    const listCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(listCalls.length > 0, '定位之后没有去拉那一层目录')
    assert.ok(
      listCalls.some((c) => c.path.includes('DEEP') || decodeURIComponent(c.path).includes('DEEP')),
      '没有定位到「第一周实验结果」那一层，实际请求：' + JSON.stringify(listCalls.map((c) => c.path)),
    )
    assert.ok(
      !listCalls.every((c) => String(c.path).includes('parentFileId=%2F&')),
      '定位又掉回根目录了',
    )
    void after
  })

  test('宿主没给 trail 时，退而用 parentPath 的最后一段，仍然不掉回根', async () => {
    const h = createHarness()
    h.backend.jobs = [Object.assign(uploadJobWithoutPath(), {
      parentPath: '/Windows/实验/数字图像实验/第一周实验结果',
    })]
    h.backend.locatable = { ok: true, canReveal: true, kind: 'remote', reason: '' }

    const host = await openHistoryWith(h)
    const revealBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    h.calls.length = 0
    revealBtn.props.onClick({ stopPropagation() {} })
    await h.settle(14)
    // setStack 之后要靠下一轮渲染才会触发「拉这一层目录」的 effect
    h.renderTree()
    await h.settle(14)

    const listCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(
      listCalls.some((c) => c.path.includes('DEEP')),
      '没有用 parentPath 定位到末级目录：' + JSON.stringify(listCalls.map((c) => c.path)),
    )
  })
})


// ================================================================
// 0.5.2 用户第 1 条：正常点一下文件不该触发「多选」
// ----------------------------------------------------------------
// 用户原话：「正常点击文件时会触发多选的效果修复」。
//
// 根因：普通单击一行也会把这一行写进 selectedIds（那是资源管理器的
// 「选中当前行」），而多选提示条的判据是 selectedIds.length > 0 ——
// 于是点一下文件，下面就冒出「已选 1 项 / 转移 / 删除」。
//
// 现在的判据是 multiSelectionActive()：
//   · 普通模式 → 必须真的加选了 2 项以上（Ctrl / Shift）；
//   · 多选模式 → 勾 1 项就显示（那里就是批量操作的语境）。
// ================================================================
describe('0.5.2 第 1 条：点文件不触发多选', () => {
  const rowsOf = (host) => host.filter(
    (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
  )

  test('普通模式单击一行：有选中态，但不出现多选提示条', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()
    rowsOf(host)[0].props.onClick({})
    await h.settle(4)
    host = h.renderTree()

    const selected = rowsOf(host).filter(
      (n) => String(n.props.className).includes('mc-exRowSelected'),
    )
    assert.equal(selected.length, 1, '单击一行之后没有选中态')
    assert.equal(
      h.byClass(host, 'mc-exSelectBar').length,
      0,
      '只是点了一下文件，却冒出了多选提示条（已选 1 项 / 转移 / 删除）',
    )
  })

  test('普通模式 Ctrl 加选到 2 项：提示条才出现', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()
    rowsOf(host)[0].props.onClick({})
    await h.settle(4)
    host = h.renderTree()
    rowsOf(host)[1].props.onClick({ ctrlKey: true })
    await h.settle(4)
    host = h.renderTree()

    assert.ok(
      h.byClass(host, 'mc-exSelectBar')[0],
      '真的加选了两项，却没有多选提示条',
    )
  })

  test('多选模式里勾 1 项：提示条照旧出现（那里就是批量语境）', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
    ]
    let host = await h.mount()
    const multiBtn = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exMultiBtn'),
    )
    multiBtn.props.onClick()
    await h.settle(6)
    host = h.renderTree()

    const rowCheck = host.find(
      (n) => n.type === 'input' &&
        String((n.props && n.props.className) || '').includes('mc-exRowCheck') &&
        String((n.props && n.props.title) || '') === '选中这一项（可多选）',
    )
    rowCheck.props.onChange()
    await h.settle(4)
    host = h.renderTree()
    assert.ok(h.byClass(host, 'mc-exSelectBar')[0], '多选模式下勾一项应有提示条')
  })
})


// ================================================================
// 0.5.2 用户第 6 条：多文件时底部只报「整批」的进度
// ----------------------------------------------------------------
// 用户原话：「最下面的传输任务进度条在传输多文件时不要不停的显示每一个文件的
// 进度，而是显示整个多文件的进度」。
//
// 之前底部进度条读的是 jobs —— 而串行上传是「一个文件一个 job」，
// 每换一个文件进度就从新开始，看着像是一直在刷当前这个文件。
// 现在批次在跑时摘要是「正在上传 · N/M 个文件 · X%」，口径是整批。
// ================================================================
describe('0.5.2 第 6 条：多文件上传只报整批进度', () => {
  function fileEntry(name, size) {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file(cb) { cb({ name, size, type: 'application/octet-stream' }) },
    }
  }

  test('拖两个文件：底部摘要是整批（N/M 个文件），不是单个文件名', async () => {
    const h = createHarness()
    h.backend.items = []
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]

    h.xhrLog.length = 0
    main.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [
          { kind: 'file', webkitGetAsEntry: () => fileEntry('one.bin', 500), getAsFile: () => ({ name: 'one.bin', size: 500 }) },
          { kind: 'file', webkitGetAsEntry: () => fileEntry('two.bin', 1500), getAsFile: () => ({ name: 'two.bin', size: 1500 }) },
        ],
        files: [],
      },
    })
    /**
     * 🔴 0.5.3 修正：这条断言以前只盯「传的过程中」那一瞬间，
     * 结果它其实是在给 bug 背书 —— 0.5.2 的 bug 正是**永远停在这一句**
     * 「正在上传 · N/N 个文件 · 100%」上。
     *
     * 现在断言完整的生命周期：
     *   ① 传的过程中（如果抓得到）文案是整批、且不含单个文件名；
     *   ② 传完之后必须变成「完成」；
     *   ③ 停留 + 褪色之后整条 bar 消失。
     */
    await h.settle(4)
    h.renderTree()
    const duringNode = h.byClass(h.renderTree(), 'mc-exTransSummary')[0]
    if (duringNode) {
      const during = (duringNode.children || []).flat(Infinity).join('')
      if (/个文件/.test(during) && /正在上传/.test(during)) {
        assert.match(during, /\d+\/\d+ 个文件/, '整批文案格式不对：' + during)
        assert.ok(
          !/one\.bin|two\.bin/.test(during),
          '摘要里还在报单个文件名（用户就是嫌这个）：' + during,
        )
      }
    }

    // 传完之后：必须出现「完成」，不能还挂着「正在上传」
    await h.settle(40)
    h.renderTree()
    const afterNode = h.byClass(h.renderTree(), 'mc-exTransSummary')[0]
    if (afterNode) {
      const after = (afterNode.children || []).flat(Infinity).join('')
      assert.ok(!/正在上传/.test(after), '传完了还显示「正在上传」：' + after)
      assert.match(after, /上传完成|完成/, '传完后没有显示完成：' + after)
    }

    // 再等过「停留 5 秒 + 褪色 1.6 秒」，bar 应该彻底消失
    await new Promise((r) => setTimeout(r, 7200))
    await h.settle(20)
    assert.equal(
      h.byClass(h.renderTree(), 'mc-exTransSummary').length,
      0,
      '进度条传完之后一直不消失',
    )
  })

  test('批次百分比按字节算：大文件权重更高', async () => {
    // 直接读源码里的算法，避免受假后端时序影响
    const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const at = SRC.indexOf('function uploadBatchPercent()')
    assert.ok(at > 0, '没有 uploadBatchPercent()')
    const body = SRC.slice(at, at + 700)
    assert.ok(body.includes('totalBytes'), '整批进度没有按字节算')
    assert.ok(
      body.includes('doneBytes') && body.includes('/ totalBytes'),
      '整批进度不是 doneBytes / totalBytes：' + body.slice(0, 300),
    )
    // 拿不到字节时要退化按文件个数，不能卡在 0
    assert.ok(/settled/.test(body), '没有按文件个数兜底')
  })
})

// ================================================================
// 0.5.3 第 2 条：收尾期间轮询反复刷新 jobs，也不能把收尾状态打回「进行中」
// ----------------------------------------------------------------
// 这是上一条的补充：根因是 effect 依赖 [jobs, uploadBatch]，
// 轮询一秒刷一次 → effect 反复重跑。以前每跑一次都会
// clearTimer() + setTransPhase(draw)，把 5 秒停留定时器杀掉。
// ================================================================
describe('0.5.3 第 2 条：收尾期间轮询不能把状态打回进行中', () => {
  test('空闲时反复刷新，不该有残留的传输摘要', async () => {
    const h = createHarness()
    h.backend.items = []
    await h.mount()

    for (let i = 0; i < 8; i += 1) {
      await h.settle(2)
      h.renderTree()
      await new Promise((r) => setTimeout(r, 60))
    }

    const bars = h.byClass(h.renderTree(), 'mc-exTransSummary')
    assert.equal(bars.length, 0, '空闲状态下不该有传输摘要')
  })
})

// ================================================================
// 0.5.4：删除 / 移动之后，列表必须**立刻**反映结果（不需要手动点刷新）
// ----------------------------------------------------------------
// 用户原话：
//   「删除文件需要手动刷新，否则那个文件不刷新的话会一直存在」
//   「移动文件也是不刷新就不会出现在新的位置」
// ================================================================
describe('0.5.4：删除 / 移动之后列表必须立刻变', () => {
  const rowsOf = (host) => host.filter(
    (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
  )
  const namesOf = (host) => rowsOf(host).map((n) => JSON.stringify(n)).join('|')

  test('删除单个文件：请求成功后该行立刻从列表消失', async () => {
    const h = createHarness()
    h.backend.items = [
      { id: 'A', name: 'a.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'b.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    let host = await h.mount()
    assert.equal(rowsOf(host).length, 2, '初始应有两行')

    // 右键第一行 → 删除
    const row = rowsOf(host)[0]
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const delBtn = host.find(
      (n) => n.type === 'button' && /删除/.test((n.children || []).flat().join('')),
    )
    assert.ok(delBtn, '右键菜单里没有删除')
    h.calls.length = 0

    /**
     * 🔴 关键：把 /list 人为拖慢 400ms，然后在「刷新请求还在飞」的时刻检查界面。
     *
     * 用户要的是「不用刷新、也不用等，删掉就没了」。如果只有 reload()、
     * 没有乐观更新，这个窗口里列表仍然是 2 行 —— 也就是他说的
     * 「不刷新的话会一直存在」。把延迟打开之后，这条断言才能真正区分两种实现。
     */
    h.setListDelay(400)
    delBtn.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(3)

    const rightAfter = h.renderTree()
    assert.equal(
      rowsOf(rightAfter).length,
      1,
      '点删除之后界面没有立刻少一行（' + rowsOf(rightAfter).length + ' 行）—— ' +
        '这就是「必须手动刷新才消失」',
    )
    assert.ok(
      !rowsOf(rightAfter).some((n) => JSON.stringify(n).includes('a.txt')),
      '被删的文件还留在列表里',
    )

    h.setListDelay(0)
    await h.settle(24)
    host = h.renderTree()

    const removeCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/remove'))
    assert.ok(removeCalls.length >= 1, '没有发出 /remove')
    const listCallsAfter = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/list'))
    assert.ok(listCallsAfter.length >= 1, '删除成功后没有重新拉列表')
    assert.equal(
      rowsOf(host).length,
      1,
      '删完之后列表里还有 ' + rowsOf(host).length + ' 行（应该只剩 1 行）—— 必须手动刷新才消失',
    )
    assert.ok(!namesOf(host).includes('删除后不应在的'), '')
  })

  test('移动文件到别的文件夹：源目录里立刻消失', async () => {
    const h = createHarness()
    // ⚠️ /list 对根目录优先返回 backend.children['/']，所以这里两份都设成同一份数据
    // （同一个数组引用），移动时假后端两边一起改，避免测试自己被数据不一致坑到。
    const initial = [
      { id: 'A', name: 'move-me.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.items = initial
    h.backend.children = { '/': initial }
    let host = await h.mount()
    assert.equal(rowsOf(host).length, 2, '初始应有两行')

    const row = rowsOf(host).find((n) => JSON.stringify(n).includes('move-me.txt'))
    assert.ok(row, '找不到要移动的文件行')
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const moveBtn = host.find(
      (n) => n.type === 'button' && /转移到/.test((n.children || []).flat().join('')),
    )
    assert.ok(moveBtn, '右键菜单里没有「转移」')
    moveBtn.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(12)
    host = h.renderTree()

    // 选目标文件夹，然后确认
    // 注意：外层 .mc-exTreeNode 只是容器，真正可点的是内层那个带 onClick 的
    const destRows = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exTreeNode') &&
        JSON.stringify(n).includes('目标'),
    )
    const destRow = destRows.find((n) => typeof (n.props && n.props.onClick) === 'function')
    assert.ok(destRow, '转移面板里没有可点的目标文件夹节点')
    destRow.props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()
    const confirmBtn = host.find(
      (n) => n.type === 'button' && /(转移到|转移 1 项到)/.test((n.children || []).flat().join('')),
    )
    assert.ok(confirmBtn, '底部没有确认按钮')
    h.calls.length = 0
    /**
     * 同样把 /list 拖慢：要在「移动后的刷新还在飞」时检查源目录。
     * 只有乐观更新能在这个窗口里就已经把文件摘掉。
     */
    h.setListDelay(400)
    confirmBtn.props.onClick()
    await h.settle(4)
    const rightAfterMove = h.renderTree()
    assert.ok(
      !rowsOf(rightAfterMove).some((n) => JSON.stringify(n).includes('move-me.txt')),
      '移动请求刚发出、刷新还没回来时，源目录里还能看到这个文件 —— ' +
        '这就是「不刷新就不会出现在新的位置」',
    )
    h.setListDelay(0)
    await h.settle(24)
    host = h.renderTree()

    const moveCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/move'))
    assert.ok(moveCalls.length >= 1, '没有发出 /move')
    assert.ok(
      !rowsOf(host).some((n) => JSON.stringify(n).includes('move-me.txt')),
      '移动成功后源目录里还能看到这个文件 —— 必须手动刷新才消失',
    )
  })
})

// ================================================================
// 0.5.4 补充：139 的索引滞后不能把刚删掉的行又拉回来
// ----------------------------------------------------------------
// 真实环境里 /remove 成功之后立刻 /list，服务端**很可能还返回那一项**
// （0.4.x 就踩过「上传完第一页回空」，是同一类滞后）。
// 如果没有压制，乐观更新刚摘掉、reload 又拉回来 —— 用户看到的还是「删了还在」。
// ================================================================
describe('0.5.4 补充：索引滞后不能把删掉的行拉回来', () => {
  const rowsOf = (host) => host.filter(
    (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
  )

  test('删完之后服务端仍返回该项（模拟滞后），界面上也绝不能复活', async () => {
    const h = createHarness()
    const stale = [
      { id: 'A', name: 'stale.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'B', name: 'keep.txt', size: 2, type: 'file', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.items = stale
    h.backend.children = { '/': stale }
    let host = await h.mount()
    assert.equal(rowsOf(host).length, 2, '初始应有两行')

    // 故意让 /remove **不真的删数据**：模拟「删除成功但索引还没跟上」
    const originalItems = h.backend.items
    h.backend.items = originalItems

    const row = rowsOf(host)[0]
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const delBtn = host.find(
      (n) => n.type === 'button' && /删除/.test((n.children || []).flat().join('')),
    )
    assert.ok(delBtn, '右键菜单里没有删除')

    // 把假后端的 /remove 变成「只回 ok、不动数据」= 索引滞后
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (path.startsWith('/api/dsh-mcloud/remove')) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, removed: 1 }),
          text: async () => JSON.stringify({ ok: true, removed: 1 }),
        }
      }
      return realFetch(url, init)
    }

    delBtn.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(30)
    host = h.renderTree()
    globalThis.fetch = realFetch

    assert.equal(
      rowsOf(host).length,
      1,
      '服务端索引滞后把删掉的行又拉回来了（' + rowsOf(host).length + ' 行）—— ' +
        '用户看到的就是「删了还在，得手动刷新」',
    )
    assert.ok(!rowsOf(host).some((n) => JSON.stringify(n).includes('stale.txt')), '被删的文件复活了')
  })
})

// ================================================================
// 0.5.5：转移要「点下确认就生效」，不能等 /batchMove 这个慢接口
// ----------------------------------------------------------------
// 用户原话：「转移文件大概需要七八秒才能转移到，优化时间能瞬间转移吗」。
//
// 根因：乐观更新写在 api.move(...).then() 里面，必须等请求返回才执行。
// 139 的 batchMove 本身就要好几秒，于是界面一直卡着不动。
// ================================================================
describe('0.5.5：转移点下确认就立刻生效，不等 /move 返回', () => {
  const rowsOf = (host) => host.filter(
    (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
  )

  // 打开转移面板 → 选目标 → 返回确认按钮
  async function openMoveAndPickDest(h, host, fileName, destName) {
    const row = rowsOf(host).find((n) => JSON.stringify(n).includes(fileName))
    assert.ok(row, '找不到 ' + fileName)
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const moveBtn = host.find(
      (n) => n.type === 'button' && /转移到/.test((n.children || []).flat().join('')),
    )
    assert.ok(moveBtn, '右键菜单里没有「转移到」')
    moveBtn.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(12)
    host = h.renderTree()

    const destRows = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exTreeNode') &&
        JSON.stringify(n).includes(destName),
    )
    const destRow = destRows.find((n) => typeof (n.props && n.props.onClick) === 'function')
    assert.ok(destRow, '转移面板里没有目标文件夹')
    destRow.props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()
    const confirmBtn = host.find(
      (n) => n.type === 'button' && /(转移到|转移 1 项到)/.test((n.children || []).flat().join('')),
    )
    assert.ok(confirmBtn, '没有确认按钮')
    return { host, confirmBtn }
  }

  test('接口还在飞（模拟 3 秒）时，源目录里就已经没了、面板也已经关了', async () => {
    const h = createHarness()
    const initial = [
      { id: 'A', name: 'slow-move.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.items = initial
    h.backend.children = { '/': initial }
    const host0 = await h.mount()
    const picked = await openMoveAndPickDest(h, host0, 'slow-move.txt', '目标')

    // 让 /move 卡 3 秒：模拟用户说的「七八秒」那个慢接口
    h.setMoveDelay(3000)
    h.calls.length = 0
    picked.confirmBtn.props.onClick()

    // 只等极短时间：请求肯定还没回来
    await h.settle(3)
    const now = h.renderTree()

    // ① 源目录里必须已经没有了
    assert.ok(
      !rowsOf(now).some((n) => JSON.stringify(n).includes('slow-move.txt')),
      '点下确认之后源目录里还留着文件 —— 界面在等 /move 返回',
    )
    // ② 面板必须已经关了（不能让人盯着一个转圈弹层等七八秒）
    assert.equal(
      h.byClass(now, 'mc-movePanel').length,
      0,
      '转移面板还开着 —— 用户要等接口返回才能看到结果',
    )
    // ③ 请求确实已经发出去了（是「先生效再发请求」，不是「根本没发」）
    const moveCalls = h.calls.filter((c) => c.path.startsWith('/api/dsh-mcloud/move'))
    assert.ok(moveCalls.length >= 1, '根本没发出 /move')

    h.setMoveDelay(0)
    await h.settle(30)
  })

  test('转移失败：把文件放回原位，并明确提示', async () => {
    const h = createHarness()
    const initial = [
      { id: 'A', name: 'will-fail.txt', size: 1, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.items = initial
    h.backend.children = { '/': initial }
    const host0 = await h.mount()
    const picked = await openMoveAndPickDest(h, host0, 'will-fail.txt', '目标')

    // 让 /move 直接失败
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (path.startsWith('/api/dsh-mcloud/move')) {
        return {
          ok: false, status: 400,
          json: async () => ({ ok: false, error: '模拟失败' }),
          text: async () => JSON.stringify({ ok: false, error: '模拟失败' }),
        }
      }
      return realFetch(url, init)
    }

    picked.confirmBtn.props.onClick()
    await h.settle(30)
    const host = h.renderTree()
    globalThis.fetch = realFetch

    assert.ok(
      rowsOf(host).some((n) => JSON.stringify(n).includes('will-fail.txt')),
      '转移失败之后文件没有放回列表 —— 用户会以为文件丢了',
    )
  })
})

// ================================================================
// 0.5.5 补充：移动完点进目标目录，文件应该**已经在那里**
// ----------------------------------------------------------------
// 只让「源目录消失」还不够：用户下一步一定是去看目标目录。
// 如果那时又要等一次网络往返（而且 139 索引滞后可能还看不到），
// 体验上仍然是「移了但看不见」。
// ================================================================
describe('0.5.5 补充：移动后点进目标目录，文件已经在里面（不用等接口）', () => {
  const rowsOf = (host) => host.filter(
    (n) => String((n.props && n.props.className) || '').split(/\s+/).includes('mc-exRow'),
  )

  test('确认移动后立刻进入目标目录：文件已经在列表里', async () => {
    const h = createHarness()
    const initial = [
      { id: 'A', name: 'filed.txt', size: 7, type: 'file', updatedAt: '2026-11-01 10:00:00' },
      { id: 'DEST', name: '目标', size: 0, type: 'folder', updatedAt: '2026-11-02 10:00:00' },
    ]
    h.backend.items = initial
    h.backend.children = { '/': initial }
    let host = await h.mount()

    // 打开转移面板
    const row = rowsOf(host).find((n) => JSON.stringify(n).includes('filed.txt'))
    assert.ok(row, '找不到要移动的文件')
    row.props.onContextMenu({
      preventDefault() {}, stopPropagation() {},
      clientX: 100, clientY: 100, currentTarget: makeElement('div'),
    })
    await h.settle(6)
    host = h.renderTree()
    const moveBtn = host.find(
      (n) => n.type === 'button' && /转移到/.test((n.children || []).flat().join('')),
    )
    assert.ok(moveBtn, '右键菜单里没有「转移到」')
    moveBtn.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
    await h.settle(12)
    host = h.renderTree()

    const destRows = host.filter(
      (n) => String((n.props && n.props.className) || '').includes('mc-exTreeNode') &&
        JSON.stringify(n).includes('目标'),
    )
    const destRow = destRows.find((n) => typeof (n.props && n.props.onClick) === 'function')
    assert.ok(destRow, '转移面板里没有目标文件夹')
    destRow.props.onClick({ stopPropagation() {} })
    await h.settle(10)
    host = h.renderTree()
    const confirmBtn = host.find(
      (n) => n.type === 'button' && /(转移到|转移 1 项到)/.test((n.children || []).flat().join('')),
    )
    assert.ok(confirmBtn, '没有确认按钮')

    /**
     * 让 /move 慢 3 秒，**同时**让 /list 也慢 1 秒。
     *
     * 只慢 /move 是不够的：假后端移动作业会立刻改动数据，进目标目录时
     * reload 一下就把真数据拉到了，测不出「有没有预置缓存」。
     * 把 /list 也拖慢，才能确认「点进去立刻就有」是靠本地预置而不是靠这次往返。
     */
    h.setMoveDelay(3000)
    h.setListDelay(1000)
    confirmBtn.props.onClick()
    await h.settle(3)

    /**
     * 进入「目标」文件夹：直接在**列表里双击**那一行。
     *
     * 不用左树：左树节点要等展开才会渲染，测试里时机不稳；列表里的行更直接，
     * 而且和用户真实操作路径一致（双击文件夹进入）。
     */
    host = h.renderTree()
    const destFolderRow = rowsOf(host).find(
      (n) => JSON.stringify(n).includes('目标') && typeof (n.props && n.props.onDoubleClick) === 'function',
    )
    assert.ok(destFolderRow, '根目录列表里没有「目标」文件夹行')
    // 确认拿到的确实是**文件夹**那一行（文件行的双击是下载）
    assert.ok(
      JSON.stringify(destFolderRow).includes('📁'),
      '拿到的不是文件夹行（双击会触发下载）：' + JSON.stringify(destFolderRow).slice(0, 200),
    )

    destFolderRow.props.onDoubleClick()
    /**
     * 假 React 的 effect 是在**下一次 renderTree()** 时按 deps 变化入队的，
     * 所以顺序必须是：renderTree（触发 effect 入队）→ settle（跑 effect）。
     * 只 settle 不 render 的话，parentId 变化那次拉取永远不会发出去。
     */
    h.renderTree()
    await h.settle(12)
    host = h.renderTree()
    await h.settle(12)
    host = h.renderTree()

    // 确认真的切进了目标目录（面包屑里有「目标」）
    assert.ok(
      JSON.stringify(h.byClass(host, 'mc-crumbs')).includes('目标'),
      '没切进目标目录（仍在根目录）',
    )
    assert.ok(
      rowsOf(host).some((n) => JSON.stringify(n).includes('filed.txt')),
      '点进目标目录后看不到刚移过去的文件（共 ' + rowsOf(host).length + ' 行）' +
        ' —— 用户会以为移动失败了',
    )

    h.setMoveDelay(0)
    h.setListDelay(0)
    await h.settle(30)
  })
})
