/**
 * 0.5.2 第 2 条：手机号只显示后四位。
 *
 * 用户原话：「手机号码只显示后四位」。
 * 之前是「前 3 后 2」（`138******00`）—— 前 3 位能定位到号段，信息量并不小。
 *
 * 🔴 这条测的是**宿主返回层**的脱敏，不是界面隐藏：
 *   界面隐藏不算脱敏，用户 F12 就能看到完整号码。
 *
 * 跑法：node --test test/mask-account.test.js
 */

import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialDir = mkdtempSync(join(tmpdir(), 'mcloud-mask-test-'))
process.env.DSH_MCLOUD_CREDENTIAL_DIR = credentialDir

const { __test } = await import('../lib/index.js')
const { maskAccount } = __test

describe('0.5.2 第 2 条：手机号只显示后四位', () => {
  test('11 位手机号 → 前 7 位全隐藏，只留后 4 位', () => {
    const masked = maskAccount('12345678901')
    assert.equal(masked, '*******8901', '脱敏结果不对：' + masked)
    assert.equal(masked.length, 11, '长度应该和号码一致（不泄露位数之外的信息）')
    // 关键：前 3 位不能再露出来
    assert.ok(!masked.startsWith('138'), '前 3 位还露着（用户要求只留后 4 位）')
    // 后 4 位必须对
    assert.ok(masked.endsWith('8901'), '后四位不对：' + masked)
  })

  test('任意号段的 11 位号码都只留后四位', () => {
    for (const phone of ['12345678901', '12345670002', '12345000003', '12345600004']) {
      const masked = maskAccount(phone)
      assert.equal(masked, '*******' + phone.slice(-4), '脱敏不对：' + phone + ' → ' + masked)
    }
  })

  test('不再出现「前 3 后 2」的老格式', () => {
    const masked = maskAccount('12345678901')
    // 老格式是 3 位前缀 + 6 个星 + 2 位后缀
    assert.ok(!/^\d{3}\*{6}\d{2}$/.test(masked), '还是前 3 后 2 的老格式：' + masked)
    assert.equal((masked.match(/\*/g) || []).length, 7, '星号个数不对（应该是 7 个）')
  })

  test('空值 / null 返回 null（不崩、也不回空字符串冒充号码）', () => {
    assert.equal(maskAccount(''), null)
    assert.equal(maskAccount(null), null)
    assert.equal(maskAccount(undefined), null)
  })

  test('邮箱账号：域名保留，本地部分只留前两位', () => {
    const masked = maskAccount('zhangsan@139.com')
    assert.ok(masked.endsWith('@139.com'), '域名被改坏了：' + masked)
    assert.ok(!masked.includes('zhangsan'), '邮箱本地部分没脱敏：' + masked)
  })

  test('短串（≤5）全部打码，不泄露任何字符', () => {
    for (const value of ['abc', 'abcd', 'abcde']) {
      const masked = maskAccount(value)
      assert.equal(masked, '*'.repeat(value.length), '短串没全打码：' + value + ' → ' + masked)
    }
  })

  test('非手机号的普通账号：也只留后四位', () => {
    const account = 'useraccount123'
    const masked = maskAccount(account)
    assert.equal(masked, '*'.repeat(account.length - 4) + account.slice(-4), '普通账号脱敏不对：' + masked)
    assert.equal(masked.length, account.length, '脱敏后长度应该和原账号一致')
    assert.ok(masked.endsWith('t123'), '后四位没保留：' + masked)
    assert.ok(!masked.includes('useraccount'), '普通账号的正文没脱敏：' + masked)
  })
})

process.on('exit', () => {
  try {
    rmSync(credentialDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
