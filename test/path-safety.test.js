/**
 * 0.5.2 的两处安全加固回归测试。
 *
 * 覆盖：
 *   1. 文件夹下载（逐个文件回落路径）的**路径穿越**防护
 *      —— 云端文件名可能是 `../../evil.txt` / `..\..\evil.txt` / `/tmp/evil.txt`
 *      / `C:\Windows\evil.txt` / `\\server\share\evil.txt`；
 *   2. explorer 定位的**命令行边界**，verbatim 模式下双引号就是唯一边界。
 *
 * 每条都做成「能红能绿」：断言的是具体行为（返回 null / 抛错），
 * 把修复回退之后这些断言必然失败。
 *
 * 跑法：node --test test/path-safety.test.js
 */

import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialDir = mkdtempSync(join(tmpdir(), 'mcloud-path-safety-'))
process.env.DSH_MCLOUD_CREDENTIAL_DIR = credentialDir

const { __test } = await import('../lib/index.js')

const BASE = process.platform === 'win32' ? 'D:\\downloads\\dsh-mcloud' : '/tmp/downloads/dsh-mcloud'

describe('0.5.2 问题 1：文件夹下载的路径穿越防护', () => {
  test('正常的多层嵌套相对路径照旧拼进目标目录', () => {
    assert.equal(
      resolve(__test.safeJoin(BASE, 'a/b/c.txt')),
      resolve(BASE, 'a/b/c.txt'),
    )
    // 反斜杠形式也接受（Windows 上云端可能给任意一种）
    assert.equal(
      resolve(__test.safeJoin(BASE, 'a\\b\\c.txt')),
      resolve(BASE, 'a/b/c.txt'),
    )
  })

  test('正常路径都在 baseDir 里（isInside 为真）', () => {
    assert.equal(__test.isInside(BASE, resolve(BASE, 'a/b.txt')), true)
    assert.equal(__test.isInside(BASE, resolve(BASE)), true, 'baseDir 自己应该算「在里面」')
  })

  const evil = [
    ['../../evil.txt（正斜杠爬两级）', '../../evil.txt'],
    ['..\\..\\evil.txt（反斜杠爬两级）', '..\\..\\evil.txt'],
    ['/tmp/evil.txt（POSIX 绝对路径）', '/tmp/evil.txt'],
    ['C:\\Windows\\evil.txt（盘符绝对路径）', 'C:\\Windows\\evil.txt'],
    ['\\\\server\\share\\evil.txt（UNC）', '\\\\server\\share\\evil.txt'],
    ['a/../../evil.txt（中间夹一段 ..）', 'a/../../evil.txt'],
    ['a/../../../../../../evil.txt（深穿越）', 'a/../../../../../../evil.txt'],
    ['..（只有上级）', '..'],
  ]

  for (const [label, relative] of evil) {
    test('越界写法一律返回 null：' + label, () => {
      assert.equal(__test.safeJoin(BASE, relative), null, '没有被挡住：' + relative)
    })
  }

  test('前缀相近的兄弟目录不算「在里面」', () => {
    // D:\downloads\dsh-mcloud-evil 不是 D:\downloads\dsh-mcloud 的子目录
    const sibling = resolve(BASE + '-evil', 'x.txt')
    assert.equal(__test.isInside(BASE, sibling), false, '根 + 分隔符前缀判断写错了')
  })

  test('云端名字 → 相对路径：越界名字被过滤成 null', () => {
    assert.equal(__test.safeRelativeName('', 'ok.txt'), 'ok.txt')
    assert.equal(__test.safeRelativeName('a', 'b.txt'), 'a/b.txt')
    assert.equal(__test.safeRelativeName('', '../../evil.txt'), null)
    assert.equal(__test.safeRelativeName('', '..\\..\\evil.txt'), null)
    assert.equal(__test.safeRelativeName('', '/tmp/evil.txt'), null)
    assert.equal(__test.safeRelativeName('', 'C:\\Windows\\evil.txt'), null)
    assert.equal(__test.safeRelativeName('', '\\\\server\\share\\evil.txt'), null)
    assert.equal(__test.safeRelativeName('', ''), null)
  })

  test('safeFileName 只留纯文件名（打包 zip 落盘用）', () => {
    assert.equal(__test.safeFileName('照片 2024'), '照片 2024')
    assert.equal(__test.safeFileName('..\\..\\evil'), 'evil')
    assert.equal(__test.safeFileName('a/b.zip'), 'b.zip')
    assert.equal(__test.safeFileName('..'), 'download')
    assert.equal(__test.safeFileName(''), 'download')
    // 非法字符被替换，且不会跑出目录
    assert.ok(!__test.safeFileName('a<b>c').includes('<'))
  })

  test('实际落盘：越界条目不会写到 localDir 之外（真建文件）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcloud-write-check-'))
    const localDir = join(root, 'downloads')
    const outsideMarker = join(root, 'evil.txt')
    try {
      const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
      mkdirSync(localDir, { recursive: true })

      // 模拟 downloadFolderFileByFile 的两道检查：safeJoin + isInside
      const attempts = ['../../evil.txt', '..\\..\\evil.txt', '/tmp/evil.txt', 'C:\\Windows\\evil.txt']
      for (const relative of attempts) {
        const target = __test.safeJoin(localDir, relative)
        assert.equal(target, null, 'safeJoin 放过了越界路径：' + relative)
      }
      // 正常文件照常写
      const okTarget = __test.safeJoin(localDir, 'a/b/ok.txt')
      assert.ok(okTarget, '正常路径被误杀')
      mkdirSync(join(localDir, 'a/b'), { recursive: true })
      writeFileSync(okTarget, 'ok')

      assert.equal(existsSync(okTarget), true, '正常文件没写出来')
      assert.equal(existsSync(outsideMarker), false, '竟然写到了目标目录之外')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('空目录（dirs）仍然会被保留下来', () => {
    // collectFolder 把空目录 push 进 out.dirs，safeRelativeName 对合法名字返回相对路径
    assert.equal(__test.safeRelativeName('照片', '2024'), '照片/2024')
    const target = __test.safeJoin(BASE, '照片/2024')
    assert.ok(target, '空目录的落点被误判成越界')
  })
})

describe('0.5.2 问题 2：explorer 定位不能带双引号 / 控制字符', () => {
  test('路径含双引号 → 直接抛错（不 spawn）', () => {
    assert.throws(
      () => __test.explorerLocateArgs('C:\\tmp\\a" b\\x.txt', false),
      /双引号/,
      '含双引号的路径没被拒绝 —— verbatim 下它能闭合引号塞参数',
    )
  })

  test('assertLocatablePath 也单独拒绝双引号', () => {
    assert.throws(() => __test.assertLocatablePath('C:\\a"b'), /双引号/)
  })

  test('换行 / 回车 / 控制字符一律拒绝', () => {
    for (const value of ['C:\\a\nb', 'C:\\a\rb', 'C:\\a\u0000b', 'C:\\a\u001fb', 'C:\\a\u007fb']) {
      assert.throws(
        () => __test.assertLocatablePath(value),
        /控制字符|换行/,
        '没拒绝：' + JSON.stringify(value),
      )
      assert.throws(() => __test.explorerLocateArgs(value, false))
    }
  })

  test('空路径也拒绝（不给 explorer 传空参数）', () => {
    assert.throws(() => __test.assertLocatablePath(''), /没有可定位/)
  })

  test('含空格 / 逗号 / 中文 / & 的正常路径仍然能定位（文件模式）', () => {
    const funny = 'C:\\tmp\\a,b & 中文 目录\\x y.txt'
    const { args, options } = __test.explorerLocateArgs(funny, false)
    assert.deepEqual(args, [`/select,"${funny}"`])
    assert.equal(options.windowsVerbatimArguments, true)
    assert.ok(!args[0].includes('""'), '出现了重复引号')
  })

  test('正常目录仍然能定位（目录模式，不带 /select）', () => {
    const dir = 'C:\\Users\\somebody\\Downloads\\dsh-mcloud\\照片 2024'
    const { args, options } = __test.explorerLocateArgs(dir, true)
    assert.deepEqual(args, [`"${dir}"`])
    assert.equal(options.windowsVerbatimArguments, true)
    assert.ok(!args[0].includes('/select'))
  })
})

// 收尾：临时凭据目录不留垃圾
process.on('exit', () => {
  try {
    rmSync(credentialDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
