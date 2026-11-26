/**
 * 0.5.2 的 UI 行为回归测试（单独一个文件，避免把 client.behavior.test.js 撑得更大）。
 *
 * 覆盖用户提的这几条：
 *   1. 正常点一下文件**不该**冒出多选提示条（只有多选模式 / 真的加选 ≥2 项才出）；
 *   3. 容量条加高；
 *   4. 账号行里没有那个「✎」按钮了，有效期和手机号在同一行，下载目录按钮放大；
 *   6. 多文件上传时底部只报整批进度；
 *   7. 左树按钮是「创建文件夹」四个字，不再是孤零零的「+」。
 *
 * 注意：这些断言读的是**源码**，所以取规则时要按行取（CSS 字符串里有
 * `' + LINE + '` 这种拼接，按引号截会截断在半个规则上）。
 *
 * 跑法：node --test test/client.052.test.js
 */

import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const LINES = SRC.split(/\r?\n/)

/** 取第一条以 `'.className{` 开头的**整行**（含后面的字符串拼接）。 */
function cssRule(className) {
  const needle = `'.${className}{`
  const line = LINES.find((text) => text.trim().startsWith(needle))
  return line ? line.trim() : null
}

/** 去掉注释再搜：避免断言被说明文字里的关键字「假通过」。 */
function codeOnly() {
  return SRC
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/** 从某个函数定义开始，取到下一个同级 `function ` 为止（粗切，够用）。 */
function functionBody(name) {
  const at = SRC.indexOf('function ' + name + '(')
  if (at < 0) return ''
  const rest = SRC.slice(at + 10)
  const next = rest.search(/\n\s{10}function [A-Za-z0-9_]+\(/)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('0.5.2 UI：源码级断言（纯结构 / 样式要求）', () => {
  test('容量条加高了（原来 15px → 26px），文字也放大', () => {
    const rule = cssRule('mc-exQuotaLine')
    assert.ok(rule, '找不到 .mc-exQuotaLine 规则')
    const height = /height:(\d+)px/.exec(rule)
    assert.ok(height, '容量条没有写死高度：' + rule)
    assert.ok(
      Number(height[1]) >= 24,
      '容量条还是太细（' + height[1] + 'px），用户要求做大一点',
    )
    const textRule = cssRule('mc-exQuotaLineText')
    const fontSize = /font-size:(\d+)px/.exec(textRule || '')
    assert.ok(fontSize && Number(fontSize[1]) >= 12, '容量文字没放大：' + textRule)
  })

  test('账号行右边那个「✎」按钮没了（连状态和读写函数一起删）', () => {
    const code = codeOnly()
    assert.ok(
      !code.includes('mc-exAcctEdit'),
      '账号行还留着铅笔按钮（mc-exAcctEdit 样式或元素）',
    )
    assert.ok(!/['"]\u270e['"]/.test(code), '代码里还有 ✎ 这个字形（不是注释里的说明）')
    assert.ok(!code.includes('openDisplayNameEdit'), '显示名编辑函数还在（应该整体删掉）')
    assert.ok(!code.includes('DISPLAY_NAME_KEY ='), 'displayName 的 localStorage key 还在')
    assert.ok(!code.includes('function readDisplayName'), 'readDisplayName 还在')
  })

  test('有效期在账号行里、紧跟在手机号后面（同一行）', () => {
    const acctStart = SRC.indexOf("className: 'mc-exAcct'")
    assert.ok(acctStart > 0, '找不到账号行')
    // 账号行这个 div 的子元素范围：到「下载目录按钮」之前
    const chipAt = SRC.indexOf("className: 'mc-exChip'", acctStart)
    const block = SRC.slice(acctStart, chipAt > 0 ? chipAt : acctStart + 1600)
    assert.ok(block.includes('mc-exExpiry'), '有效期没有放进账号行（还是单独一行）')
    assert.ok(block.includes('mc-exAcctName'), '账号行里没有号码元素')
    // 顺序：号码在前、有效期在后
    assert.ok(
      block.indexOf('mc-exAcctName') < block.indexOf('mc-exExpiry'),
      '有效期跑到手机号前面去了',
    )
  })

  test('下载目录按钮放大了（字号 ≥13px / 内边距更大），并且限宽', () => {
    const rule = cssRule('mc-exChip')
    assert.ok(rule, '找不到 .mc-exChip 规则')
    const fontSize = /font-size:(\d+)px/.exec(rule)
    assert.ok(fontSize && Number(fontSize[1]) >= 13, '下载目录按钮的字号没放大：' + rule)
    const padding = /padding:(\d+)px (\d+)px/.exec(rule)
    assert.ok(padding, '下载目录按钮没有显式 padding：' + rule)
    assert.ok(
      Number(padding[1]) >= 5 && Number(padding[2]) >= 10,
      '下载目录按钮的内边距还是老样子：' + padding[0],
    )
    assert.ok(/max-width:/.test(rule), '下载目录按钮没有 max-width，长路径会撑破布局')
  })

  test('左树按钮是「创建文件夹」而不是「+」，并且仍然有框', () => {
    const at = SRC.indexOf("className: 'mc-exTreeAdd'")
    assert.ok(at > 0, '找不到左树的创建按钮')
    const tail = SRC.slice(at, at + 700)
    assert.ok(/t\('newFolder'\)/.test(tail), '按钮文案不是 t(newFolder)：' + tail.slice(0, 200))
    assert.ok(!/\},\s*'\+'\)/.test(tail), '按钮还是那个「+」')
    const rule = cssRule('mc-exTreeAdd')
    assert.ok(/border:0\.5px solid/.test(rule || ''), '按钮没框了：' + rule)
    assert.ok(/padding:/.test(rule || ''), '按钮还是 18×18 的方格子（没有 padding）')
  })

  test('多选提示条的显示判据走 multiSelectionActive()（普通模式要 >1）', () => {
    const body = functionBody('multiSelectionActive').replace(/\s+/g, ' ')
    assert.ok(body, '没有 multiSelectionActive() —— 很容易又退回「点一行就出批量条」')
    assert.ok(
      /multiSelectMode\) return selectedIds\.length > 0/.test(body),
      '多选模式分支不对：' + body,
    )
    assert.ok(
      /return selectedIds\.length > 1/.test(body),
      '普通模式应该要求「真的加选了 2 项以上」：' + body,
    )
    // 提示条本身必须走这个函数
    assert.ok(
      /multiSelectionActive\(\)\s*\n?\s*\? h\('div', \{ className: 'mc-exBanner mc-exSelectBar'/.test(
        SRC.replace(/\/\*[\s\S]*?\*\//g, ''),
      ),
      '多选提示条没有用 multiSelectionActive() 当条件',
    )
  })

  test('传输进度条支持「整批」口径（uploadBatch）', () => {
    for (const name of [
      'beginUploadBatch',
      'updateUploadBatchFile',
      'publishUploadBatch',
      'finishUploadBatch',
      'uploadBatchPercent',
      'uploadBatchSettled',
    ]) {
      assert.ok(SRC.includes('function ' + name), '缺少 ' + name)
    }
    const body = functionBody('renderExTransfers')
    assert.ok(body.includes('batchActive'), '底部进度条没有走整批分支')
    assert.ok(body.includes('uploadBatchProgress'), '底部进度条没有「整批」的摘要文案')
    // 进度 effect 也要在批次进行中直接接管（不能被逐个 job 的 0→100% 拽着走）
    const effectAt = SRC.indexOf('var stillRunning = batchMode ? !batchSettled : running.length > 0')
    assert.ok(effectAt > 0, '进度 effect 没有接管多文件批次')
    const effectTail = SRC.slice(effectAt, effectAt + 1400)
    // 「还在传」这一支必须自己结束（后面不该再落到读 jobs 的分支）
    const stillIdx = effectTail.indexOf('if (stillRunning) {')
    assert.ok(stillIdx >= 0, '没有 stillRunning 分支：' + effectTail.slice(0, 200))
    const stillBlock = effectTail.slice(stillIdx, stillIdx + 1200)
    assert.ok(
      /phaseTo\('draw'\)/.test(stillBlock) && /return/.test(stillBlock),
      '批次还在传时没有回到 draw 并提前 return：' + stillBlock,
    )
  })

  test('左树 / 转移面板共用同一份子目录缓存（提速）', () => {
    assert.ok(SRC.includes('function loadFolderChildren('), '没有共享的 loadFolderChildren()')
    assert.ok(SRC.includes('folderChildrenCacheRef'), '没有子目录共享缓存')
    const treeBody = functionBody('loadTreeChildren')
    assert.ok(treeBody.includes('loadFolderChildren('), '左树还在自己 api.list')
    const moveBody = functionBody('loadMoveTreeChildren')
    assert.ok(moveBody.includes('loadFolderChildren('), '转移面板还在自己 api.list')
    const probeBody = functionBody('probeMoveKidRows')
    assert.ok(probeBody.includes('Promise.all'), '转移面板的子目录探测还是串行的')
  })
})
