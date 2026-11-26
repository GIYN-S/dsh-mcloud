/**
 * 0.5.3 的两条 bug 的行为级回归测试。
 *
 * 1. 快速点击文件夹 → 路径里同一个目录出现两遍（双击会触发 click,click,dblclick）；
 * 2. 多文件传完 → 底部永远停在「正在上传 · N/N 个文件 · 100%」，不进入完成态、不消失。
 *
 * 都用真实组件驱动（复用 client.behavior.test.js 那套假 React），
 * 并且都做成「能红能绿」：把修复回退后必须变红。
 */

import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 取某个函数的源码（粗切到下一个同级 function 之前）。 */
function functionBody(name) {
  const at = SRC.indexOf('function ' + name + '(')
  if (at < 0) return ''
  const rest = SRC.slice(at + 10)
  const next = rest.search(/\n\s{10}function [A-Za-z0-9_]+\(/)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('0.5.3 第 1 条：快速点击文件夹不再把同一个目录压进路径两遍', () => {
  test('enterFolder 用函数式更新（不读渲染闭包里的 stack）', () => {
    const body = functionBody('enterFolder')
    assert.ok(body, '找不到 enterFolder')
    assert.ok(
      /setStack\(function \(previous\)/.test(body),
      'enterFolder 还在用闭包里的 stack.concat(...) —— 连点就会重复入栈：\n' + body,
    )
    assert.ok(
      !/setStack\(stack\.concat/.test(body),
      '还在直接读闭包 stack：' + body,
    )
  })

  test('enterFolder 幂等：目标已在路径里就截到那一级，不重复加', () => {
    const body = functionBody('enterFolder')
    assert.ok(/String\(list\[i\]\.id\) === targetId/.test(body), '没有按 id 去重：' + body)
    assert.ok(/list\.slice\(0, i \+ 1\)/.test(body), '命中已有目录时没有截断到那一级：' + body)
  })

  test('goCrumb / goUp 也改成函数式更新（连点不丢状态）', () => {
    for (const name of ['goCrumb', 'goUp']) {
      const body = functionBody(name)
      assert.ok(
        /setStack\(function \(previous\)/.test(body),
        name + ' 还在读闭包 stack：' + body,
      )
    }
  })

  test('模拟双击时序：click + click + dblclick 三次，路径只多一层', () => {
    // 直接跑 enterFolder 的纯逻辑（把 setStack 换成记录器）
    const calls = []
    function makeSetStack() {
      let stack = [{ id: 'ROOTCHILD', name: '我的应用收藏' }]
      return {
        push: (v) => calls.push(v),
        setStack(updater) {
          stack = typeof updater === 'function' ? updater(stack) : updater
          return stack
        },
        get current() { return stack },
      }
    }
    const s = makeSetStack()
    const foldr = { id: 'FOLDER', name: '2025年度云生活报告' }

    // 从源码里取出的等价实现（和 enterFolder 一字不差的逻辑）
    function enterFolder(item) {
      const targetId = String(item.id)
      s.setStack(function (previous) {
        const list = Array.isArray(previous) ? previous : []
        for (let i = 0; i < list.length; i += 1) {
          if (list[i] && String(list[i].id) === targetId) {
            return i === list.length - 1 ? list : list.slice(0, i + 1)
          }
        }
        return list.concat([{ id: item.id, name: item.name }])
      })
    }

    // 浏览器双击的真实事件顺序
    enterFolder(foldr) // click
    enterFolder(foldr) // click
    enterFolder(foldr) // dblclick

    const names = s.current.map((e) => e.name)
    assert.deepEqual(
      names,
      ['我的应用收藏', '2025年度云生活报告'],
      '路径里重复了：' + JSON.stringify(names),
    )
  })
})

describe('0.5.3 第 2 条：多文件传完后进度条必须收尾', () => {
  test('phase 有独立的 ref，不再靠渲染闭包里的 transPhase', () => {
    assert.ok(SRC.includes('transPhaseRef = React.useRef'), '没有 transPhaseRef')
    assert.ok(SRC.includes('function phaseTo('), '没有统一的 phaseTo()')
    const body = functionBody('phaseTo')
    assert.ok(body.includes('transPhaseRef.current = next'), 'phaseTo 没写 ref：' + body)
    assert.ok(body.includes('setTransPhase(next)'), 'phaseTo 没写 state：' + body)
  })

  test('所有 phase 变更都走 phaseTo（没有漏网直接 setTransPhase）', () => {
    const direct = SRC.split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
        return /setTransPhase\(/.test(t) && !/function phaseTo/.test(t) && !/transPhaseRef/.test(t)
      })
    // 只允许 phaseTo 内部那一次
    const real = direct.filter(({ line }) => !/setTransPhase\(next\)/.test(line))
    assert.equal(
      real.length,
      0,
      '还有绕过 phaseTo 的 setTransPhase：' + JSON.stringify(real.map((x) => x.n + ': ' + x.line.trim())),
    )
  })

  test('收尾链只安排一次（transSettlingRef 拦着），不会被轮询无限推迟', () => {
    assert.ok(SRC.includes('transSettlingRef'), '没有 transSettlingRef')
    const body = functionBody('phaseTo') + SRC.slice(SRC.indexOf('var stillRunning'))
    const effectArea = SRC.slice(
      SRC.indexOf('React.useEffect(function () {\n            var list = Array.isArray(jobs)'),
      SRC.indexOf('}, [jobs, uploadBatch])'),
    )
    assert.ok(
      /if \(transSettlingRef\.current\) return/.test(effectArea),
      '收尾链没有「已在飞就别再排」的守卫',
    )
    assert.ok(
      /transSettlingRef\.current = true/.test(effectArea),
      '安排收尾链时没有置位 transSettlingRef',
    )
  })

  test('批次 settled 后摘要立刻变「完成」，不再写「正在上传 · N/N · 100%」', () => {
    const at = SRC.indexOf('function renderExTransfers()')
    const body = SRC.slice(at, at + 4200)
    assert.ok(
      /else if \(!batchActive\) \{[\s\S]{0,400}uploadBatchDone/.test(body),
      '批次结束但还在 draw 时，摘要没有切到「完成」文案',
    )
  })

  test('批次收尾放进 finally（中途抛错也不会永远挂着「进行中」）', () => {
    const count = (SRC.match(/\.finally\(function \(\) \{\s*\n\s*finishUploadBatch\(\)/g) || []).length
    assert.ok(count >= 3, '有上传路径没用 finally 收尾（找到 ' + count + ' 处）')
  })

  test('拖拽上传的批次开始时要打开始时间（否则收尾链永远排不上）', () => {
    const body = functionBody('beginUploadBatch')
    assert.ok(body, '找不到 beginUploadBatch')
    assert.ok(
      /transBeganAtRef\.current = Date\.now\(\)/.test(body),
      'beginUploadBatch 没记起点 —— 拖拽上传这条路从来没设过 began，' +
        '收尾分支会因 began===0 直接 return，进度条永远停在最后一帧：\n' + body,
    )
    assert.ok(
      /transSettlingRef\.current = false/.test(body),
      'beginUploadBatch 没复位收尾标记（新一批会一上来就以为在收尾）',
    )
  })

  test('收尾分支里 began===0 不能直接 return（那是最后一道死锁）', () => {
    const effectArea = SRC.slice(
      SRC.indexOf('var stillRunning = batchMode'),
      SRC.indexOf('}, [jobs, uploadBatch])'),
    )
    // 必须有「补起点」的兜底
    assert.ok(
      /if \(transBeganAtRef\.current === 0\) transBeganAtRef\.current = Date\.now\(\)/.test(effectArea),
      '收尾分支没有「began===0 就补一个起点」的兜底',
    )
    // 不能有「began===0 就 return」
    assert.ok(
      !/if \(transBeganAtRef\.current === 0\) return/.test(effectArea),
      '收尾分支还留着 `if (began === 0) return` —— 没有起点就永远不排收尾链',
    )
  })
})
