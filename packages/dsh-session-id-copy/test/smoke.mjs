/**
 * dsh-session-id-copy 冒烟测试。
 *
 * 分五段：
 *   1. loader 契约：client.js 是 window.__ModuleLoader__.load({ id, factory }) 形态，且不含 ESM 语句
 *   2. 纯逻辑：会话菜单识别、语言判定、fiber 祖先链收集（用假 fiber 链）
 *   3. 注入：往假 DOM 的会话菜单里追加复制项，幂等、非会话菜单不注入
 *   4. 点击：写剪贴板（成功 / 失败 / 回落）、反馈文案、失败可重试、成功关菜单
 *   5. 生命周期：apply 装 observer、重复 apply 先拆旧的
 *
 * DOM 用一个几十行的极简实现（够了：只需要 querySelector 的 [attr] / [attr="v"] /
 * [class*="v"] / tag[attr] 四种形态、cloneNode、textContent/innerHTML、事件）。因此仓库
 * 保持零依赖、离线可测；真实浏览器里的行为另有 README 记录的实测结论。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundleSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('  ok  ' + name)
}

// ── 极简假 DOM ───────────────────────────────────────────────────────────────
function matchesSelector(el, selector) {
  const parsed = /^([A-Za-z][A-Za-z0-9]*)?(.*)$/.exec(selector.trim())
  if (parsed === null) return false
  if (parsed[1] && el.tagName !== parsed[1].toUpperCase()) return false
  const tokenRe = /\[([^\]]*)\]|\.[A-Za-z0-9_-]+/g
  let token
  while ((token = tokenRe.exec(parsed[2])) !== null) {
    if (token[0][0] === '.') {
      if (!el.classList.includes(token[0].slice(1))) return false
      continue
    }
    const body = token[1]
    const star = /^([A-Za-z0-9_-]+)\*="([^"]*)"$/.exec(body)
    if (star !== null) {
      const value = el.getAttribute(star[1])
      if (value === null || !value.includes(star[2])) return false
      continue
    }
    const eq = /^([A-Za-z0-9_-]+)="([^"]*)"$/.exec(body)
    if (eq !== null) {
      if (el.getAttribute(eq[1]) !== eq[2]) return false
      continue
    }
    if (/^[A-Za-z0-9_-]+$/.test(body)) {
      if (el.getAttribute(body) === null) return false
      continue
    }
    return false
  }
  return true
}

class FakeElement {
  constructor(tag, className = '', attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.className = className
    this.attrs = { ...attrs }
    this.children = []
    this.parentElement = null
    this.listeners = new Map()
    this.style = {}
    this.value = ''
    this._text = ''
    this._innerHTML = null
  }
  get classList() {
    return this.className.split(/\s+/).filter(Boolean)
  }
  get textContent() {
    let out = this._text
    for (const child of this.children) out += child.textContent
    return out
  }
  set textContent(value) {
    this._text = String(value)
    this.children = []
  }
  get innerHTML() {
    return this._innerHTML === null ? this.children.map((child) => child.tagName.toLowerCase()).join('') : this._innerHTML
  }
  set innerHTML(value) {
    this._innerHTML = String(value)
    this.children = []
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = String(value)
    else this.attrs[name] = String(value)
  }
  getAttribute(name) {
    if (name === 'class') return this.className === '' ? null : this.className
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  removeAttribute(name) {
    delete this.attrs[name]
  }
  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentElement = null
    return child
  }
  cloneNode(deep) {
    const copy = new FakeElement(this.tagName.toLowerCase(), this.className, { ...this.attrs })
    copy.style = { ...this.style }
    copy.value = this.value
    copy._text = this._text
    copy._innerHTML = this._innerHTML
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true))
    return copy
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  dispatchEvent(event) {
    const ev = event ?? {}
    if (!ev.target) ev.target = this
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => {}
    if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => {}
    for (const listener of this.listeners.get(ev.type) ?? []) listener(ev)
    return true
  }
  select() {}
  setSelectionRange() {}
  querySelectorAll(selector) {
    const out = []
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (matchesSelector(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
}

class FakeDocument {
  constructor({ execCommand = () => true } = {}) {
    this.body = new FakeElement('body')
    this.documentElement = new FakeElement('html')
    this.execCommand = execCommand
  }
  createElement(tag) {
    return new FakeElement(tag)
  }
  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector)
  }
  querySelector(selector) {
    return this.body.querySelector(selector)
  }
}

class FakeMutationObserver {
  static instances = []
  constructor(callback) {
    this.callback = callback
    this.observed = false
    this.options = null
    FakeMutationObserver.instances.push(this)
  }
  observe(target, options) {
    this.target = target
    this.options = options
    this.observed = true
  }
  disconnect() {
    this.observed = false
  }
}

// ── 菜单装配 ─────────────────────────────────────────────────────────────────
function fakeItemWrap(label) {
  const wrap = new FakeElement('div', '_itemWrap_1nxmc_92')
  const button = new FakeElement('button', '_item_1nxmc_92', { type: 'button', role: 'menuitem' })
  const icon = new FakeElement('span', '_itemIcon_1nxmc_144')
  icon.innerHTML = '<svg></svg>'
  const text = new FakeElement('span', '_itemLabel_1nxmc_144')
  text.textContent = label
  button.appendChild(icon)
  button.appendChild(text)
  wrap.appendChild(button)
  return wrap
}

function fakeMenu({ sessionId, labels, items, onClose }) {
  const menu = new FakeElement('div', '_list_1nxmc_8 _portal_1nxmc_44', { role: 'menu' })
  const viewport = new FakeElement('div', '_viewport_1nxmc_22', { role: 'presentation' })
  menu.appendChild(viewport)
  for (const label of labels ?? ['重命名', '分叉会话', '归档会话']) viewport.appendChild(fakeItemWrap(label))
  menu['__reactFiber$test'] = {
    memoizedProps: {
      items: items ?? [{ id: 'rename' }, { id: 'fork' }, { id: 'archive' }],
      onClose: onClose ?? (() => {}),
      onSelect: () => {}
    },
    return: { memoizedProps: { node: { id: sessionId ?? 'session-1111-2222' } }, return: null }
  }
  return menu
}

// ── 环境 ─────────────────────────────────────────────────────────────────────
let entry = null
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
new Function(bundleSource)()

const doc = new FakeDocument()
globalThis.document = doc
// Node 21+ 自带只读的 globalThis.navigator，必须用 defineProperty 覆盖。
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}
setNavigator({ clipboard: { writeText: () => Promise.resolve() } })
globalThis.MutationObserver = FakeMutationObserver
const rafQueue = []
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length }
const timers = []
globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length }

const plugin = entry.factory()
const internals = plugin.__internals
const {
  isSessionMenuItems,
  pickLabels,
  reactFiber,
  inspectFiber,
  copyText,
  injectIntoMenu,
  scanMenus,
  start,
  MENU_SELECTOR,
  MARK_ATTR,
  FEEDBACK_MS,
  LABELS,
  COPY_ICON_SVG
} = internals

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

// ── 1. loader 契约 ───────────────────────────────────────────────────────────
await check('client.js 调用 window.__ModuleLoader__.load 且 id 正确', () => {
  assert.ok(entry !== null, '没有调用 __ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-session-id-copy')
  assert.equal(typeof entry.factory, 'function')
})

await check('client.js 是手写 bundle：不含顶层 import/export', () => {
  assert.doesNotMatch(bundleSource, /^\s*(?:import|export)\s/m)
})

await check('factory 导出 apply / inject，且不需要任何 require', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual(plugin.inject, [])
})

// ── 2. 纯逻辑 ────────────────────────────────────────────────────────────────
await check('isSessionMenuItems 只认 rename+fork+archive 三件套', () => {
  assert.equal(isSessionMenuItems([{ id: 'rename' }, { id: 'fork' }, { id: 'archive' }]), true)
  assert.equal(isSessionMenuItems([{ id: 'archive' }, { id: 'rename' }, { id: 'fork' }]), true)
  assert.equal(isSessionMenuItems([{ id: 'rename' }, { id: 'delete' }]), false)
  assert.equal(isSessionMenuItems([{ id: 'rename' }, { id: 'fork' }]), false)
  assert.equal(isSessionMenuItems([{ id: 'fork' }, { id: 'archive' }]), false)
  assert.equal(isSessionMenuItems(undefined), false)
  assert.equal(isSessionMenuItems('rename'), false)
})

await check('pickLabels 按菜单已有文案选语言', () => {
  assert.equal(pickLabels('重命名'), LABELS.zh)
  assert.equal(pickLabels('Rename'), LABELS.en)
  assert.equal(pickLabels(''), LABELS.en)
  assert.equal(pickLabels(undefined), LABELS.en)
})

await check('reactFiber 只认 __reactFiber$ 前缀', () => {
  const node = new FakeElement('div')
  assert.equal(reactFiber(node), null)
  const fiber = { memoizedProps: {} }
  node['__reactFiber$abc123'] = fiber
  assert.equal(reactFiber(node), fiber)
})

await check('inspectFiber 沿祖先链同时取到 Menu props 与会话 id', () => {
  const menu = fakeMenu({ sessionId: 'session-xyz' })
  const info = inspectFiber(reactFiber(menu))
  assert.equal(info.sessionId, 'session-xyz')
  assert.deepEqual(info.menu.items.map((item) => item.id), ['rename', 'fork', 'archive'])
  assert.equal(typeof info.menu.onClose, 'function')
})

await check('inspectFiber 对工作区菜单（rename+delete）给出 menu=null', () => {
  const menu = fakeMenu({ sessionId: 'session-xyz', items: [{ id: 'rename' }, { id: 'delete' }] })
  const info = inspectFiber(reactFiber(menu))
  assert.equal(info.menu, null)
  assert.equal(info.sessionId, 'session-xyz')
})

// ── 3. 注入 ─────────────────────────────────────────────────────────────────
await check('注入会话菜单：追加复制项、改文案/图标、打标记', () => {
  const menu = fakeMenu({ sessionId: 'session-abc' })
  const row = injectIntoMenu(menu)
  assert.ok(row !== null, '没有注入')
  const viewport = menu.querySelector('[class*="_viewport"]')
  assert.equal(viewport.children.length, 4)
  assert.equal(row.getAttribute(MARK_ATTR), 'true')
  assert.equal(row.querySelector('[class*="_itemLabel"]').textContent, '复制会话 ID')
  assert.match(row.querySelector('[class*="_itemIcon"]').innerHTML, /M6\.14929/)
  assert.equal(row.querySelector('button[role="menuitem"]').getAttribute('role'), 'menuitem')
  assert.equal(row.querySelector('button[role="menuitem"]').getAttribute('aria-haspopup'), null)
})

await check('注入幂等：同一菜单第二次注入不改动 DOM', () => {
  const menu = fakeMenu({ sessionId: 'session-abc' })
  assert.ok(injectIntoMenu(menu) !== null)
  assert.equal(injectIntoMenu(menu), null)
  assert.equal(menu.querySelectorAll('[' + MARK_ATTR + ']').length, 1)
  assert.equal(menu.querySelector('[class*="_viewport"]').children.length, 4)
})

await check('非会话菜单 / 无 fiber 的菜单不注入', () => {
  const workspace = fakeMenu({ sessionId: 'session-abc', items: [{ id: 'rename' }, { id: 'delete' }] })
  assert.equal(injectIntoMenu(workspace), null)
  assert.equal(workspace.querySelectorAll('[' + MARK_ATTR + ']').length, 0)
  const orphan = new FakeElement('div', '_list_1nxmc_8', { role: 'menu' })
  assert.equal(injectIntoMenu(orphan), null)
  assert.equal(injectIntoMenu(null), null)
})

await check('语言跟随菜单：英文菜单注入英文文案', () => {
  const menu = fakeMenu({ sessionId: 'session-en', labels: ['Rename', 'Fork session', 'Archive session'] })
  const row = injectIntoMenu(menu)
  assert.equal(row.querySelector('[class*="_itemLabel"]').textContent, 'Copy session ID')
})

await check('scanMenus 扫到并注入所有打开的会话菜单', () => {
  const fresh = new FakeDocument()
  globalThis.document = fresh
  const first = fakeMenu({ sessionId: 'session-1' })
  const second = fakeMenu({ sessionId: 'session-2' })
  fresh.body.appendChild(first)
  fresh.body.appendChild(second)
  assert.equal(scanMenus(), 2)
  assert.equal(first.querySelectorAll('[' + MARK_ATTR + ']').length, 1)
  assert.equal(second.querySelectorAll('[' + MARK_ATTR + ']').length, 1)
  globalThis.document = doc
})

// ── 4. 点击 ─────────────────────────────────────────────────────────────────
await check('点击复制项：把会话 id 写进剪贴板，文案变「已复制」', async () => {
  const clipboardCalls = []
  setNavigator({ clipboard: { writeText: (text) => { clipboardCalls.push(text); return Promise.resolve() } } })
  const closed = []
  const menu = fakeMenu({ sessionId: 'session-copy-me', onClose: () => closed.push(true) })
  const row = injectIntoMenu(menu)
  const button = row.querySelector('button[role="menuitem"]')
  timers.length = 0
  button.dispatchEvent({ type: 'click' })
  await settle()
  assert.deepEqual(clipboardCalls, ['session-copy-me'])
  assert.equal(row.querySelector('[class*="_itemLabel"]').textContent, '已复制')
  assert.notEqual(button.getAttribute('disabled'), null)
  assert.equal(closed.length, 0, '反馈期间不应该立刻关菜单')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, FEEDBACK_MS)
  timers[0].fn()
  assert.equal(closed.length, 1, '反馈结束后应关菜单')
})

await check('剪贴板失败：文案变「复制失败」、恢复可点、不关菜单', async () => {
  setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
  globalThis.document.execCommand = () => false
  const closed = []
  const menu = fakeMenu({ sessionId: 'session-nope', onClose: () => closed.push(true) })
  const row = injectIntoMenu(menu)
  const button = row.querySelector('button[role="menuitem"]')
  timers.length = 0
  button.dispatchEvent({ type: 'click' })
  await settle()
  assert.equal(row.querySelector('[class*="_itemLabel"]').textContent, '复制失败')
  assert.equal(button.getAttribute('disabled'), null)
  assert.equal(timers.length, 0)
  assert.equal(closed.length, 0)
  globalThis.document.execCommand = () => true
})

await check('无 Clipboard API 时回落到 execCommand', async () => {
  setNavigator({})
  const menu = fakeMenu({ sessionId: 'session-legacy' })
  const row = injectIntoMenu(menu)
  const button = row.querySelector('button[role="menuitem"]')
  button.dispatchEvent({ type: 'click' })
  await settle()
  assert.equal(row.querySelector('[class*="_itemLabel"]').textContent, '已复制')
})

await check('copyText 成功/失败都返回 Promise', async () => {
  setNavigator({ clipboard: { writeText: () => Promise.resolve() } })
  await copyText('x')
  setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('x')) } })
  globalThis.document.execCommand = () => false
  await assert.rejects(copyText('x'))
  globalThis.document.execCommand = () => true
})

// ── 5. 生命周期 ──────────────────────────────────────────────────────────────
await check('apply 安装 observer，重复 apply 先拆旧的', () => {
  FakeMutationObserver.instances.length = 0
  plugin.apply()
  assert.equal(FakeMutationObserver.instances.length, 1)
  assert.equal(FakeMutationObserver.instances[0].observed, true)
  assert.equal(FakeMutationObserver.instances[0].options.subtree, true)
  assert.equal(typeof window.__dshSessionIdCopyDispose, 'function')
  plugin.apply()
  assert.equal(FakeMutationObserver.instances[0].observed, false, '旧 observer 应被拆掉')
  assert.equal(FakeMutationObserver.instances.length, 2)
  window.__dshSessionIdCopyDispose()
  assert.equal(FakeMutationObserver.instances[1].observed, false)
})

await check('start 在没有 document 的环境里安全返回空函数', () => {
  const saved = globalThis.document
  delete globalThis.document
  const stop = start()
  assert.equal(typeof stop, 'function')
  stop()
  globalThis.document = saved
})

await check('复制图标用的是官方 IconCopyOutline16 的 path', () => {
  assert.match(COPY_ICON_SVG, /^<svg width="16" height="16" viewBox="0 0 16 16"/)
  assert.match(COPY_ICON_SVG, /fill="currentColor"/)
  assert.equal(MENU_SELECTOR, '[role="menu"]')
})

console.log('\n' + passed + ' checks passed')
