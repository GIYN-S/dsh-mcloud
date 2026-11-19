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
    prompt() { return null },
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
    if (path.startsWith('/api/dsh-mcloud/reveal')) return json({ ok: true, path: 'D:\\x' })
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

  async function settle(rounds = 12) {
    for (let r = 0; r < rounds; r += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const { fn } of state.pendingEffects.splice(0)) fn()
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

  return { mod, backend, calls, slots, renderTree, settle, byClass, mount, xhrLog }
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

  test('拖文件夹：给出提示且不发请求', async () => {
    const h = createHarness()
    const host = await h.mount()
    const main = h.byClass(host, 'mc-exMain')[0]
    h.xhrLog.length = 0
    main.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: {
        items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => null }],
        files: [],
      },
    })
    await h.settle(6)
    assert.equal(h.xhrLog.length, 0, '拖文件夹不该发起上传')
    const host2 = h.renderTree()
    const banners = h.byClass(host2, 'mc-exBanner').map((n) => JSON.stringify(n)).join(' ')
    assert.match(banners, /上传文件夹/, '拖文件夹没有提示改用「上传文件夹」')
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
    const banners = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exBanner'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(banners, /无法定位/, '没有提示「无法定位」：' + banners.slice(0, 300))
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

    const banners = host
      .filter((n) => String((n.props && n.props.className) || '').includes('mc-exBanner'))
      .map((n) => JSON.stringify(n))
      .join(' ')
    assert.match(banners, /无法定位|移动|删除/, '没有把「文件已被移动」的原因提示给用户：' + banners.slice(0, 300))
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
