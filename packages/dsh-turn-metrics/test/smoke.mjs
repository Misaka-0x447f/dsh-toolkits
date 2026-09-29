/**
 * dsh-turn-metrics 冒烟测试。
 *
 * 分四段：
 *   1. loader 契约：client.js 必须是 window.__ModuleLoader__.load({ id, factory }) 形态
 *   2. apply：必须注册进 conversation.input.dock
 *   3. 纯逻辑：时长格式化、open turn 识别、工具计数折叠、文案拼装
 *   4. 组件渲染：给出快照时渲染出计数与时长，非运行 / 无 useChat 时渲染空
 *
 * 渲染器优先用真实的 react + react-dom/server；两者版本不一致时（本机 profiles 里是
 * react@18.3.1 配 react-dom@19.2.8，pnpm dlx 缓存留下的错配）退回内置极简 shim。
 * shim 同时替换 require('react')，并记录每个组件实例的 hook 调用序列，能在“运行中”
 * 与“空闲”两次渲染之间校验 hook 顺序稳定 —— 这是 Rules of Hooks 里最容易在运行时
 * 炸掉的一条。仓库因此保持零依赖、离线可测。
 *
 * react / react-dom 从 DSH 装机处的 node_modules 解析（浏览器里这一步由宿主的 require
 * 注册表完成）。可用 DSH_NODE_MODULES 覆盖，默认 ~/.dsh/profiles/node_modules。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundleSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('  ok  ' + name)
}

// ── 0. 选渲染器 ──────────────────────────────────────────────────────────────
const hostRequire = createRequire(
  path.join(process.env.DSH_NODE_MODULES ?? path.join(process.env.HOME, '.dsh', 'profiles', 'node_modules'), '/')
)

function loadRealRenderer() {
  try {
    const react = hostRequire('react')
    const server = hostRequire('react-dom/server')
    const domVersion = hostRequire('react-dom/package.json').version
    return react.version === domVersion ? { react, renderToStaticMarkup: server.renderToStaticMarkup } : null
  } catch {
    return null
  }
}

function createShim() {
  const state = { current: null, instances: [] }
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const renderNode = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return escape(node)
    if (Array.isArray(node)) return node.map(renderNode).join('')
    const { type, props } = node
    if (typeof type === 'function') {
      const outer = state.current
      state.current = { name: type.name, hooks: [] }
      let rendered
      try {
        rendered = type(props)
      } finally {
        state.instances.push(state.current)
        state.current = outer
      }
      return renderNode(rendered)
    }
    const attributes = Object.entries(props)
      .filter(([key]) => key !== 'children')
      .map(([key, value]) => ' ' + key + '="' + escape(value) + '"')
      .join('')
    return '<' + type + attributes + '>' + renderNode(props.children) + '</' + type + '>'
  }
  return {
    react: {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children }
      }),
      useState: (initial) => {
        state.current.hooks.push('state')
        return [typeof initial === 'function' ? initial() : initial, () => {}]
      },
      useEffect: () => {
        state.current.hooks.push('effect')
      }
    },
    hooks: () => state.instances.map((instance) => instance.name + ':' + instance.hooks.join(',')),
    renderToStaticMarkup(element) {
      state.instances = []
      state.current = { name: 'root', hooks: [] }
      const html = renderNode(element)
      state.instances.push(state.current)
      return html
    }
  }
}

const real = loadRealRenderer()
const engine = real ?? createShim()
console.log(real === null
  ? '  (react/react-dom 版本不匹配，用内置 shim 渲染器；hook 顺序仍被校验)'
  : '  (用真实 react ' + real.react.version + ' + react-dom/server 渲染)')

// ── 1. loader 契约 ────────────────────────────────────────────────────────────
let entry = null
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
new Function(bundleSource)()
check('client.js 调用 window.__ModuleLoader__.load 且 id 正确', () => {
  assert.ok(entry !== null, '没有调用 __ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-turn-metrics')
  assert.equal(typeof entry.factory, 'function')
})

// 组件内部的 hook 必须来自当前选中的渲染器，所以 require('react') 由它提供。
const plugin = entry.factory((specifier) => (specifier === 'react' ? engine.react : hostRequire(specifier)))
check('factory 导出 apply / inject', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots'])
})

// ── 2. apply 注册 ────────────────────────────────────────────────────────────
const registrations = []
const ctx = {
  slots: {
    inject: (name, callback) => {
      assert.equal(name, 'conversation.input.dock')
      callback()
    },
    register: (options, Component) => registrations.push({ options, Component })
  }
}
plugin.apply(ctx)
check('apply 把组件注册到 conversation.input.dock', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'conversation.input.dock')
  assert.equal(registrations[0].options.id, 'turn-metrics')
  assert.equal(typeof registrations[0].Component, 'function')
})

// ── 3. 纯逻辑 ────────────────────────────────────────────────────────────────
const {
  formatDuration,
  openTurn,
  deriveStats,
  composeFacts,
  composeLabel,
  selectKey,
  TurnMetrics,
  css,
  builtinStatusSelector,
  hideBuiltinStatus
} = plugin.__internals

check('样式：隐藏自带状态行、按 composer 宽度对齐、黄点规则都在', () => {
  assert.equal(hideBuiltinStatus, true)
  assert.equal(builtinStatusSelector, '[class*="_turnStatus"]')
  assert.match(css, /--dsh-composer-side-clearance/)
  assert.match(css, /--dsh-composer-card-max-width/)
  assert.match(css, /padding:0 2px 12px 2px/)
  assert.match(css, /\.dtm-dot\{flex:none;width:16px;height:16px;margin-right:6px;/)
  assert.match(css, /\.dtm-dot\[data-running="true"\]\{background:radial-gradient\(circle at center,var\(--dsw-alias-state-warn-primary/)
})

check('formatDuration', () => {
  assert.equal(formatDuration(0), '0秒')
  assert.equal(formatDuration(42000), '42秒')
  assert.equal(formatDuration(162000), '2分42秒')
  assert.equal(formatDuration(3720000), '1时02分')
  assert.equal(formatDuration(-5), '0秒')
})

const NOW = Date.now()
const openSnapshot = {
  timeline: { turns: new Map([[7, { turn: 7, status: 'open', start: { time: NOW - 84000 } }]]) },
  locations: { getTurn: (turn) => (turn === 7 ? ['n1', 'n2', 'n3'] : []) },
  nodes: {
    get: (key) => (key === 'n1'
      ? { kind: 'turn-process', data: { toolCallCount: 5, subagentCount: 2 } }
      : { kind: 'assistant-step', data: {} })
  },
  legacy: { runningCalls: [{ turn: 7 }, { turn: 7 }, { turn: 6 }] }
}

check('openTurn 只认未关闭的轮次', () => {
  assert.deepEqual(openTurn(openSnapshot.timeline), { turn: 7, startMs: NOW - 84000 })
  assert.equal(openTurn({ turns: new Map([[7, { turn: 7, status: 'closed' }]]) }), null)
  assert.equal(openTurn(undefined), null)
})

check('deriveStats 读 turn-process 节点并只数本轮的运行中工具', () => {
  assert.deepEqual(deriveStats(openSnapshot, 7), { toolCalls: 5, subagents: 2, running: 2 })
  assert.deepEqual(deriveStats(openSnapshot, 6), { toolCalls: 0, subagents: 0, running: 1 })
})

check('turn-process 缺失时回落到 tool-call 节点计数', () => {
  const fallback = {
    timeline: openSnapshot.timeline,
    locations: { getTurn: () => ['a', 'b', 'c'] },
    nodes: { get: (key) => (key === 'c' ? { kind: 'assistant-step', data: {} } : { kind: 'tool-call', data: {} }) },
    legacy: { runningCalls: [] }
  }
  assert.deepEqual(deriveStats(fallback, 7), { toolCalls: 2, subagents: 0, running: 0 })
})

check('selectKey 是原始字符串且随事实变化', () => {
  assert.equal(selectKey(openSnapshot), '7:' + (NOW - 84000) + ':5:2:2')
  const idle = { timeline: { turns: new Map() }, locations: { getTurn: () => [] }, nodes: { get: () => undefined }, legacy: { runningCalls: [] } }
  assert.equal(selectKey(idle), '')
})

check('composeFacts / composeLabel：执行中不再出文字，只由点色表达', () => {
  assert.equal(composeFacts({ toolCalls: 5, subagents: 2, running: 1 }), '5 次工具调用 · 2 个子代理')
  assert.equal(composeFacts({ toolCalls: 5, subagents: 0, running: 3 }), '5 次工具调用')
  assert.equal(composeFacts({ toolCalls: 0, subagents: 0, running: 2 }), '')
  assert.equal(composeLabel({ toolCalls: 5, subagents: 2, running: 1 }, 84000), '5 次工具调用 · 2 个子代理 · 1分24秒')
  assert.equal(composeLabel({ toolCalls: 5, subagents: 0, running: 0 }, 84000), '5 次工具调用 · 1分24秒')
  assert.equal(composeLabel({ toolCalls: 0, subagents: 0, running: 2 }, 5000), '5秒')
  assert.equal(composeLabel({ toolCalls: 0, subagents: 0, running: 0 }, 12000), '12秒')
})

check('文案里不再出现「执行中」字样', () => {
  const label = composeLabel({ toolCalls: 5, subagents: 2, running: 1 }, 84000)
  assert.doesNotMatch(label, /执行中|个工具执行/)
})

// ── 4. 组件渲染 ──────────────────────────────────────────────────────────────
const render = (snapshot, props = {}) =>
  engine.renderToStaticMarkup(engine.react.createElement(TurnMetrics, { useChat: (selector) => selector(snapshot), ...props }))

check('运行中渲染出工具计数与本轮用时', () => {
  const html = render(openSnapshot)
  assert.match(html, /dtm-root/)
  assert.match(html, /dtm-dot/)
  assert.match(html, /5 次工具调用 · 2 个子代理/)
  assert.match(html, /1分2[0-9]秒/)
  assert.doesNotMatch(html, /执行中/)
})

check('有工具在执行时点标成黄色，否则保持蓝色', () => {
  assert.match(render(openSnapshot), /dtm-dot[^>]*data-running="true"/)
  const idleTools = { ...openSnapshot, legacy: { runningCalls: [{ turn: 6 }] } }
  assert.match(render(idleTools), /dtm-dot[^>]*data-running="false"/)
})

check('每秒 tick 的计时对读屏器隐藏，静态标签负责播报', () => {
  const html = render(openSnapshot)
  assert.match(html, /dtm-sr[^>]*>本轮运行中</)
  assert.match(html, /dtm-time[^>]*aria-hidden/)
})

check('没有运行中的轮次时渲染空', () => {
  const idle = { ...openSnapshot, timeline: { turns: new Map([[7, { turn: 7, status: 'closed', start: { time: NOW - 84000 } }]]) } }
  assert.equal(render(idle), '')
})

check('缺 useChat 时渲染空且不抛', () => {
  assert.equal(engine.renderToStaticMarkup(engine.react.createElement(TurnMetrics, {})), '')
})

if (real === null) {
  check('hook 顺序在运行/空闲两种渲染之间保持稳定', () => {
    render(openSnapshot)
    const running = engine.hooks()
    render({ ...openSnapshot, timeline: { turns: new Map([[7, { turn: 7, status: 'closed' }]]) } })
    assert.deepEqual(engine.hooks(), running)
  })
}

console.log('\n' + passed + ' checks passed')
