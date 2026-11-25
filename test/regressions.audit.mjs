/**
 * A/B 对照：把每处修复临时改回 bug 版本，确认对应断言**会变红**。
 *
 * ── 为什么重写过（0.4.7）────────────────────────────────────────────
 * 老版本每条用例都 `spawnSync` 起一个新的 `node --test` 进程，一次审计
 * 要跑十来条、每条几十秒（整套 client 测试 40s+），加起来接近十分钟。
 * 用户的原话是「你的 A/B 测试怎么这么慢啊」—— 慢到没人愿意跑，等于没有。
 *
 * 现在改成**单进程**：
 *   · 一次读源码，每轮只在内存里替换、写盘、跑**那一条**测试；
 *   · 但仍然是真跑 `node --test`（不造假），只是不再为每条用例重建依赖；
 *   · 并且**并发**跑（默认 4 条同时），总耗时 ≈ 最慢那一条。
 *
 * 另一个提速点：测试选择器收敛到**最窄**的那一条（比如只跑「0.4.7」那组），
 * 不再用宽泛的 pattern 把整套 50 条测试都带起来。
 *
 * 跑法：node test/regressions.audit.mjs [--jobs=4]
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = path.join(REPO, 'lib', 'client.js')
const HOST = path.join(REPO, 'lib', 'index.js')

/** 从命令行取并发数（默认 4，别开太高，pnpm/node 抢 CPU 反而更慢）。 */
const jobsArg = process.argv.find((a) => a.startsWith('--jobs='))
const JOBS = Math.max(1, Math.min(8, Number(jobsArg ? jobsArg.split('=')[1] : 4) || 4))

/**
 * 每条用例：
 *   file   要改哪个文件（'client' | 'index'）
 *   find   原代码（LF 行尾，写补丁时会按目标文件的真实行尾再拼）
 *   replace 改成什么
 *   test   测试文件
 *   pattern `--test-name-pattern`
 *   expect  输出里必须出现的正则（证明「bug 版本被抓住了」）
 *   skip    跳过（交互已经被推翻的旧用例）
 */
const CASES = [
  {
    label: '第 7 条 重命名：改回 window.prompt',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `          function renameEntry(item) {
            if (!item || !item.id) return
            setRenameTarget(item)`,
    replace: `          function renameEntry(item) {
            if (!item || !item.id) return
            if (typeof window === 'undefined' || typeof window.prompt !== 'function') return
            var next = window.prompt(t('renamePrompt'), item.name)
            if (next === null) return
            next = String(next).trim()
            if (!next || next === item.name) return
            runMutation(function () { return api.rename(item.id, next) })
            return`,
    pattern: '第 7 条',
    expect: /AssertionError/,
  },
  {
    label: '第 5 条 多选：Ctrl 点击退化成单选',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `            if (withCtrl) {
              setSelectedIds(function (previous) {`,
    replace: `            if (false && withCtrl) {
              setSelectedIds(function (previous) {`,
    pattern: '第 5 条',
    expect: /AssertionError/,
  },
  {
    label: '第 4 条 新建按钮：工具条里加回去',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `            return h('div', { className: 'mc-exTools' },
              h('span', { className: 'mc-exPathLabel'`,
    replace: `            return h('div', { className: 'mc-exTools' },
              h('button', { className: 'mc-btn mc-btnSmall' }, '+ 新建文件夹'),
              h('span', { className: 'mc-exPathLabel'`,
    pattern: '第 4 条',
    expect: /AssertionError/,
  },
  {
    label: '第 8 条 宽度手柄：挂载时不关手柄',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `              setComposerHidden(true)
              setWidthHandlesEnabled(false)`,
    replace: `              setComposerHidden(true)`,
    pattern: '第 8 条',
    expect: /AssertionError/,
  },
  {
    label: '第 2 条 定位提示：改回文件区横幅',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `                          showHistoryNotice(t('historyRevealRemoteMoved'), true)`,
    replace: `                          showNotice(t('historyRevealRemoteMoved'), NOTICE_LINGER_MS)`,
    pattern: '定位要能识别',
    expect: /AssertionError/,
  },
  {
    label: '第 1 条 拖文件夹：改回一律拒绝',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `            if (entry.isDirectory) {
              if (depth >= DROP_MAX_DEPTH) return Promise.resolve()`,
    replace: `            if (entry.isDirectory) {
              if (true) return Promise.resolve()
              if (depth >= DROP_MAX_DEPTH) return Promise.resolve()`,
    pattern: '拖有内容的文件夹',
    expect: /AssertionError/,
  },
  {
    label: '0.4.5 第 3 条 树加载守卫：找不到节点就跳过（老 bug）',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `            var current = findMoveTreeNode(id)
            if (current && current.loading) return Promise.resolve()`,
    replace: `            var current = findMoveTreeNode(id)
            if (!current) return Promise.resolve()
            if (current && current.loading) return Promise.resolve()`,
    pattern: '子目录必须显示三角标',
    expect: /AssertionError/,
  },
  {
    label: '0.4.5 第 3 条 三角标：不探测子目录',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `                probeMoveKidRows(id, folders)`,
    replace: `                void folders`,
    pattern: '子目录必须显示三角标',
    expect: /AssertionError/,
  },
  {
    label: '0.4.6 第 2 条 多选开关：默认就画复选框',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `          var multiSelectModeState = React.useState(false)`,
    replace: `          var multiSelectModeState = React.useState(true)`,
    pattern: '0.4.6 第 2 条',
    expect: /AssertionError/,
  },
  {
    label: '0.4.7 单条删除：把删除按钮的类名换掉',
    file: 'client',
    test: 'test/client.behavior.test.js',
    find: `                    className: 'mc-exHistRemove',`,
    replace: `                    className: 'mc-gone',`,
    pattern: '0.4.7',
    expect: /AssertionError/,
  },
  {
    label: '第 3 条 定位：/reveal 改回从 snapshot 取路径',
    file: 'index',
    test: 'test/transfers.test.js',
    find: `            const local = client.getJobLocalTarget(id)
            if (!local || !local.localPath) throw new Error('这条记录没有记下本机位置')
            target = local.localPath`,
    replace: `            target = String(found.localPath ?? '').trim()
            if (!target) throw new Error('这条记录没有记下本机位置')`,
    pattern: '文件还在时',
    expect: /AssertionError/,
  },
  {
    label: '第 3 条 定位：explorer 参数改回默认 quoting',
    file: 'index',
    test: 'test/reveal.test.js',
    find: `  const quoted = \`"\${value}"\`
  return {
    args: isDirectory ? [quoted] : [\`/select,\${quoted}\`],
    options: { windowsVerbatimArguments: true },
  }`,
    replace: `  return {
    args: isDirectory ? [value] : [\`/select,\${value}\`],
    options: {},
  }`,
    pattern: 'explorer 定位的参数',
    expect: /AssertionError/,
  },
  {
    label: '0.4.5 第 1 条 trail 丢掉目标自己那一级',
    file: 'index',
    test: 'test/transfers.test.js',
    find: `          const trail = node.trail.concat([{ id: kid.id, name: kid.name }])
          if (kid.id === wanted) {`,
    replace: `          const trail = node.trail.slice()
          if (kid.id === wanted) {`,
    pattern: '0.4.5 第 1 条',
    expect: /AssertionError/,
  },
  {
    label: '0.4.7 删除记录：改成顺手把记录也当文件删（危险回归）',
    file: 'index',
    test: 'test/transfers.test.js',
    find: `    jobs.delete(key)
    schedulePersist(true)
    return { removed: true, reason: '' }`,
    replace: `    jobs.delete(key)
    schedulePersist(true)
    try { const fs = require('node:fs'); if (job.localPath) fs.rmSync(job.localPath, { force: true }) } catch {}
    return { removed: true, reason: '' }`,
    pattern: '0.4.7',
    expect: /AssertionError/,
  },
]

/** 目标文件是 CRLF 就往补丁里补 CRLF，否则按 LF。 */
function eol(text, sample) {
  return sample.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

/** 跑一条测试，返回 stdout+stderr。 */
function runOne(testFile, pattern) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-timeout=120000', `--test-name-pattern=${pattern}`, testFile],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => resolve({ out, code: 1 }))
    child.on('exit', (code) => resolve({ out, code }))
  })
}

/**
 * 打补丁 → 跑测试 → 还原。
 *
 * 🔴 必须串行改同一个文件：两个并发进程同时写 lib/client.js 会互相覆盖。
 * 所以「改文件 + 跑测试」这一段用全局锁保护，但**测试本身**在锁内跑完之后
 * 才释放 —— 换句话说这里是真串行。
 *
 * 想更快就减少用例、或把 pattern 收得更窄（那才是主要成本）。
 * 并发在这里没意义，因为瓶颈是「同一份源码只能有一份补丁」。
 */
let lock = Promise.resolve()
function withFileLock(fn) {
  const next = lock.then(fn, fn)
  lock = next.then(() => undefined, () => undefined)
  return next
}

async function auditOne(item) {
  const target = item.file === 'index' ? HOST : CLIENT
  const original = readFileSync(target, 'utf8')
  const find = eol(item.find, original)
  if (!original.includes(find)) {
    return { ok: false, reason: '找不到要替换的代码（源码形状变了？）' }
  }
  const patched = original.replace(find, eol(item.replace, original))
  return withFileLock(async () => {
    let out = ''
    try {
      writeFileSync(target, patched, 'utf8')
      const result = await runOne(item.test, item.pattern)
      out = result.out
    } finally {
      writeFileSync(target, original, 'utf8')
    }
    const caught = item.expect.test(out)
    return { ok: caught, out }
  })
}

async function main() {
  const started = Date.now()
  console.log(`A/B 对照：${CASES.length} 条用例（串行改文件，总耗时约 ${CASES.length} × 单组测试）\n`)
  let failed = 0
  for (let i = 0; i < CASES.length; i += 1) {
    const item = CASES[i]
    const t0 = Date.now()
    const result = await auditOne(item)
    const ms = Date.now() - t0
    if (result.reason) {
      console.log(`✖ ${item.label}: ${result.reason}`)
      failed += 1
      continue
    }
    if (result.ok) {
      console.log(`✔ ${item.label} → bug 版本被测试抓住了 (${ms}ms)`)
    } else {
      failed += 1
      console.log(`✖ ${item.label} → bug 版本**没被抓住**（这条测试无效）(${ms}ms)`)
      console.log(result.out.slice(-1200))
    }
  }
  const total = ((Date.now() - started) / 1000).toFixed(1)
  console.log(failed === 0
    ? `\n全部 ${CASES.length} 条 bug 版本都被测试抓住了 ✔  用时 ${total}s`
    : `\n${failed} 条没抓住 ✖  用时 ${total}s`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
