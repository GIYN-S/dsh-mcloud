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
      this.responseText = JSON.stringify({ ok: true, jobId: 'drop-1', name: body && body.name })
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
    jobs: [],
    nextCursor: null,
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
    if (path.startsWith('/api/dsh-mcloud/list')) {
      return json({
        ok: true,
        parentFileId: '/',
        items: backend.items,
        nextCursor: backend.nextCursor,
      })
    }
    if (path.startsWith('/api/dsh-mcloud/search')) return json({ ok: true, items: [], truncated: false })
    if (path.startsWith('/api/dsh-mcloud/transfers/clear')) return json({ ok: true, removed: 0 })
    if (path.startsWith('/api/dsh-mcloud/transfers')) return json({ ok: true, jobs: backend.jobs })
    if (path.startsWith('/api/dsh-mcloud/login/saved')) return json({ ok: true, hasSaved: false })
    if (path.startsWith('/api/dsh-mcloud/reveal')) return json({ ok: true, path: 'D:\\x' })
    if (path.startsWith('/api/dsh-mcloud/download')) {
      // 真实 Host 的行为：起任务立刻回 jobId，任务先 running，之后才 done。
      // 这里同步登记一条 running，轮询才不会被「没有任务」直接停掉。
      backend.jobs = [{
        id: 'job-1', kind: 'download', label: 'a.zip', phase: 'download',
        done: 0, total: 12345, state: 'running', error: null,
        startedAt: Date.now(), finishedAt: null,
        canRevealLocal: true, parentFileId: null, parentPath: null,
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
      canRevealLocal: true, parentFileId: null, parentPath: null,
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
        canRevealLocal: true, parentFileId: null, parentPath: null,
      },
      {
        id: 'up1', kind: 'upload', label: 'r.pdf', phase: 'complete',
        done: 50, total: 50, state: 'done', error: null,
        startedAt: Date.now() - 9000, finishedAt: Date.now() - 5000,
        canRevealLocal: false, parentFileId: 'FOLDER-B', parentPath: '/windows/实验',
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
    await h.settle(6)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()

    const revealBtns = host.filter(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistReveal'),
    )
    assert.equal(revealBtns.length, 2, '应当只有 2 个「定位」（老记录没有位置，不该显示）')

    const titles = revealBtns.map((b) => b.props.title)
    assert.ok(titles.some((t) => /资源管理器/.test(t)), '缺少「在资源管理器里定位」的说明')
    assert.ok(titles.some((t) => /网盘/.test(t)), '缺少「跳转到网盘位置」的说明')

    // 下载那条：POST /reveal { jobId }
    h.calls.length = 0
    revealBtns.find((b) => /资源管理器/.test(b.props.title)).props.onClick({ stopPropagation() {} })
    await h.settle(8)
    const revealCall = h.calls.find((c) => c.path.startsWith('/api/dsh-mcloud/reveal'))
    assert.ok(revealCall, '点「定位」没有发出 /reveal')
    assert.deepEqual(revealCall.body, { jobId: 'dl1' }, '/reveal 不应该带本机绝对路径')

    // 上传那条：切目录，不碰本机
    h.calls.length = 0
    // 弹层被上一次点击关掉了，重新打开
    host = h.renderTree()
    const histBtn2 = host.find(
      (n) => n.type === 'button' && String((n.props && n.props.className) || '').includes('mc-exHistoryBtn'),
    )
    histBtn2.props.onClick()
    await h.settle(6)
    host = h.renderTree()
    await h.settle(6)
    host = h.renderTree()
    const upBtn = host.find(
      (n) => n.type === 'button' &&
        String((n.props && n.props.className) || '').includes('mc-exHistReveal') &&
        /网盘/.test(n.props.title || ''),
    )
    assert.ok(upBtn, '找不到上传记录的「定位」')
    upBtn.props.onClick({ stopPropagation() {} })
    host = h.renderTree()
    await h.settle(10)
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
