/**
 * DeliveryView 运行时冒烟：手写最小 DOM 桩 + @vue/runtime-dom 真实挂载，
 * 走到 onMounted（内存 IndexedDB）、全部计算属性与模板渲染。
 * vue-router/store/merge 用虚拟模块桩。
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outFile = join(root, 'node_modules/.delivery-mount.mjs')

/* ----------------- 内存 IndexedDB 桩 ----------------- */
const dbData = { projects: [], rules: [], meta: [], delivery: [] }
globalThis.indexedDB = {
  open() {
    const req = {
      onupgradeneeded: null,
      onsuccess: null,
      result: {
        objectStoreNames: { contains: () => true },
        transaction(storeName) {
          const rows = dbData[storeName]
          const tx = { oncomplete: null }
          const fire = () => queueMicrotask(() => tx.oncomplete && tx.oncomplete())
          tx.objectStore = () => ({
            getAll() {
              fire()
              return { result: [...rows] }
            },
            get(key) {
              fire()
              return { result: rows.find((r) => r.id === key || r.version === key || r.key === key) }
            },
            put(value) {
              const id = value.id ?? value.version ?? value.key
              const index = rows.findIndex((r) => (r.id ?? r.version ?? r.key) === id)
              if (index >= 0) rows[index] = value
              else rows.push(value)
              fire()
              return {}
            },
            delete(key) {
              const index = rows.findIndex((r) => (r.id ?? r.version ?? r.key) === key)
              if (index >= 0) rows.splice(index, 1)
              fire()
              return {}
            }
          })
          return tx
        }
      }
    }
    queueMicrotask(() => {
      req.onupgradeneeded && req.onupgradeneeded()
      req.onsuccess && req.onsuccess()
    })
    return req
  }
}

/* ----------------- 最小 DOM 桩 ----------------- */
globalThis.Node = class Node {
  constructor() {
    this.parentNode = null
  }
}
globalThis.Element = class Element extends globalThis.Node {
  constructor() {
    super()
    this.attributes = {}
    this.style = {}
    this.dataset = {}
    this.listeners = {}
    this.children = []
  }
  contains() {
    return false
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] || (this.listeners[type] = [])).push(fn)
  }
  removeEventListener() {}
  attachShadow() {
    return new El('shadow')
  }
  get classList() {
    const tokens = new Set(String(this.className || '').split(/\s+/).filter(Boolean))
    return {
      add: (...names) => names.forEach((name) => tokens.add(name)),
      remove: (...names) => names.forEach((name) => tokens.delete(name)),
      contains: (name) => tokens.has(name),
      toggle: (name) => (tokens.has(name) ? tokens.delete(name) : tokens.add(name))
    }
  }
}
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
class El extends globalThis.Element {
  constructor(tag) {
    super()
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.parentNode = null
    this.listeners = {}
    this._text = ''
    this.className = ''
    this.value = ''
    this.type = ''
    this.options = []
    this.selectedIndex = -1
    this.checked = false
    this.disabled = false
    this.dataset = {}
  }
  get nodeType() {
    return 1
  }
  get textContent() {
    if (this._text !== '') return this._text
    return this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    this._text = String(value)
    this.children = []
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value)
    if (key === 'class') this.className = String(value)
  }
  getAttribute(key) {
    return key in this.attributes ? this.attributes[key] : null
  }
  hasAttribute(key) {
    return key in this.attributes
  }
  removeAttribute(key) {
    delete this.attributes[key]
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  insertBefore(child, reference) {
    child.parentNode = this
    const index = this.children.indexOf(reference)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] || (this.listeners[type] = [])).push(fn)
  }
  removeEventListener() {}
  contains() {
    return false
  }
  get firstChild() {
    return this.children[0] ?? null
  }
  get nextSibling() {
    if (!this.parentNode) return null
    const index = this.parentNode.children.indexOf(this)
    return this.parentNode.children[index + 1] ?? null
  }
  get innerHTML() {
    return serialize(this)
  }
}
class TextNode extends globalThis.Node {
  constructor(text) {
    super()
    this._text = String(text)
  }
  get nodeType() {
    return 3
  }
  get textContent() {
    return this._text
  }
  set textContent(value) {
    this._text = String(value)
  }
}
class CommentNode extends globalThis.Node {
  constructor(text) {
    super()
    this._text = String(text)
  }
  get nodeType() {
    return 8
  }
  get textContent() {
    return ''
  }
}
function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function serialize(node) {
  if (node instanceof TextNode) return escapeHtml(node._text)
  if (node instanceof CommentNode) return `<!--${node._text}-->`
  const attrs = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('')
  const inner = node._text !== '' ? escapeHtml(node._text) : node.children.map(serialize).join('')
  if (['INPUT', 'BR', 'IMG', 'META', 'LINK'].includes(node.tagName)) return `<${node.tagName.toLowerCase()}${attrs} />`
  return `<${node.tagName.toLowerCase()}${attrs}>${inner}</${node.tagName.toLowerCase()}>`
}
const rootEl = new El('body')
globalThis.SVGElement = class SVGElement {}
globalThis.document = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (text) => new TextNode(text),
  createComment: (text) => new CommentNode(text),
  createDocumentFragment: () => new El('fragment'),
  body: rootEl,
  documentElement: new El('html')
}
globalThis.window = globalThis
globalThis.navigator = { userAgent: 'node-smoke' }
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

/* ----------------- .vue SFC 编译插件（@vue/compiler-sfc） ----------------- */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileScript, compileTemplate } from '@vue/compiler-sfc'

function hashFilename(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

const sfcPlugin = {
  name: 'sfc',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: join(args.resolveDir, args.path), namespace: 'sfc' }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'sfc' }, (args) => {
      const filename = args.path
      const source = readFileSync(filename, 'utf-8')
      const { descriptor } = parseSfc(source, { filename })
      const id = 'data-v-' + hashFilename(filename)
      const script = compileScript(descriptor, { id })
      const template = compileTemplate({
        source: descriptor.template.content,
        filename,
        id,
        scoped: descriptor.styles.some((style) => style.scoped),
        compilerOptions: { bindingMetadata: script.bindings }
      })
      let code = script.content.replace(/export default/, 'const __sfc_default =')
      const renderCode = template.code
        .replace('export function render', 'function render')
        .replace(/\nexport \{[^}]*render[^}]*\}\n?/g, '')
      code += '\n' + renderCode
      code += '\nconst script_default = { ...__sfc_default, render }\nexport default script_default\n'
      return { contents: code, resolveDir: dirname(filename), loader: 'ts' }
    })
  }
}

/* ----------------- 虚拟桩模块 ----------------- */
const virtualPlugin = {
  name: 'virtual-stubs',
  setup(pluginBuild) {
    const stub = (name, contents) => {
      pluginBuild.onResolve({ filter: new RegExp(`stub:${name}$`) }, () => ({ path: `stub:${name}`, namespace: 'stub' }))
      pluginBuild.onLoad({ filter: new RegExp(`^stub:${name}$`), namespace: 'stub' }, () => ({ contents, resolveDir: root }))
    }
    stub(
      'router',
      `
      import { defineComponent, h } from 'vue'
      export function useRoute() { return { params: { id: 'p1' } } }
      export const RouterLink = defineComponent({
        props: ['to'],
        setup(props, { slots }) { return () => h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default && slots.default()) }
      })
      export const RouterView = defineComponent({ setup: () => () => h('div') })
    `
    )
    stub(
      'store',
      `
      import { reactive } from 'vue'
      export const store = reactive({ ready: true, error: '', operator: '测试员', projects: [], rules: [] })
      export function getProject() {
        return { id: 'p1', name: '演示学校校服', kind: 'school', ruleVersion: 'v-test', batches: [], persons: [], imports: [], createdAt: 0, updatedAt: 0 }
      }
      export function getRule() { return { version: 'v-test', label: '测试规则' } }
      export function ensureMerged() {}
      export async function flushProject() {}
    `
    )
    stub(
      'merge',
      `
      export const conservationText = () => ''
      export function buildSummary() {
        return {
          regularRows: [
            { sizeCode: '160/80A', gender: 'male', qty: 130, isSpecial: false },
            { sizeCode: '165/84A', gender: 'male', qty: 86, isSpecial: false },
            { sizeCode: '155/76A', gender: 'female', qty: 20, isSpecial: false }
          ],
          specialRows: [],
          totals: { specialQty: 0, accountedQty: 236, validRows: 236 }
        }
      }
    `
    )
    // 把真实的 ../logic/store、../logic/merge 与 vue-router 重定向到桩
    pluginBuild.onResolve({ filter: /logic[\\/]store(\.ts)?$/ }, () => ({ path: 'stub:store', namespace: 'stub' }))
    pluginBuild.onResolve({ filter: /logic[\\/]merge(\.ts)?$/ }, () => ({ path: 'stub:merge', namespace: 'stub' }))
    pluginBuild.onResolve({ filter: /^vue-router$/ }, () => ({ path: 'stub:router', namespace: 'stub' }))
  }
}

const entry = `
import { createApp, h, defineComponent } from 'vue'
import DeliveryView from './src/views/DeliveryView.vue'

const container = document.createElement('div')
document.body.appendChild(container)
const app = createApp(DeliveryView)
const StubLink = defineComponent({
  props: ['to'],
  setup(props, { slots }) { return () => h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default && slots.default()) }
})
app.component('RouterLink', StubLink)
app.mount(container)
await new Promise((r) => setTimeout(r, 80))
console.log('@@HTML@@' + container.innerHTML)
`
writeFileSync(join(root, '.mount-entry.mjs'), entry)

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ['.mount-entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [sfcPlugin, virtualPlugin],
  define: { 'import.meta.env': JSON.stringify({}) }
})
writeFileSync(outFile, bundled.outputFiles[0].text)

let captured = ''
const origLog = console.log
console.log = (...args) => {
  captured += args.join(' ') + '\n'
}
try {
  await import(outFile + `?t=${Date.now()}`)
} catch (error) {
  console.log = origLog
  rmSync(join(root, '.mount-entry.mjs'), { force: true })
  rmSync(outFile, { force: true })
  console.error('挂载抛错：', error)
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 120))
console.log = origLog
rmSync(join(root, '.mount-entry.mjs'), { force: true })
rmSync(outFile, { force: true })

const html = (captured.match(/@@HTML@@([\s\S]*)$/)?.[1] ?? '').trim()
let failures = 0
const check = (cond, message) => {
  if (!cond) {
    failures += 1
    console.error(`✗ ${message}`)
  } else console.log(`✓ ${message}`)
}

check(html.includes('交货批次拆分与补量'), '页面标题渲染')
check(html.includes('演示学校校服'), '项目名渲染')
check(html.includes('160/80A') && html.includes('165/84A') && html.includes('155/76A'), '三个号型档都渲染')
check(html.includes('130') && html.includes('86') && html.includes('20'), '下单数量渲染')
// 默认 MOQ50 / 每箱20 / 2批 / end：
// 130 → 非收尾 80（4箱）+ 末批 50（零10）；86 → 非收尾 40 + 末批 46（零6）
check(html.includes('80'), '130 号型非收尾批整箱 80')
check(html.includes('50'), '130 号型末批 50')
check(html.includes('不足最小起订量'), '20 件档被标出总量不足 MOQ')
check(html.includes('不能导出工厂清单') || html.includes('阻塞'), '有阻塞项时导出锁定')
check(html.includes('相邻号型并成一箱'), '调法一（并箱）渲染')
check(html.includes('整档挪到下一批') || html.includes('没有下一批可挪'), '调法二（挪档）渲染')
check(html.includes('零头最难看'), '零头点名区域渲染')
check(!/Cannot read propert|is not a function|undefined is not/.test(html), '无运行时异常文本')
const saved = dbData.delivery.find((row) => row.id === 'p1')
check(!!saved && saved.settings.batchCount === 2, '方案已写入本机（delivery 仓库）')

/* ---------- 交互：找到 130 号型行的第一个数量输入框，模拟手工改单元格 ---------- */
function walk(node, predicate, hits = []) {
  if (node instanceof El) {
    if (predicate(node)) hits.push(node)
    node.children.forEach((child) => walk(child, predicate, hits))
  }
  return hits
}
const allInputs = walk(rootEl, (el) => el.tagName === 'INPUT' && el.type !== 'date')
check(allInputs.length > 0, `矩阵里有可编辑的数量输入框（${allInputs.length} 个）`)

// 130 行的第一个单元格（第1批=80）改成 70：70 不是 20 的倍数且不是收尾批 → 应报非整箱
const firstRow = walk(rootEl, (el) => el.tagName === 'TR').find((tr) => tr.textContent.includes('160/80A'))
check(!!firstRow, '找到 160/80A 所在行')
if (firstRow) {
  const rowInputs = walk(firstRow, (el) => el.tagName === 'INPUT' && el.type === 'number')
  check(rowInputs.length >= 2, '每行每批都有数字输入框')
  if (rowInputs[0] && rowInputs[0].listeners.change) {
    rowInputs[0].value = '70'
    for (const fn of rowInputs[0].listeners.change) fn({ target: rowInputs[0] })
    await new Promise((r) => setTimeout(r, 400))
    const reHtml = firstRow.parentNode.innerHTML
    check(/非收尾批必须凑成整箱/.test(reHtml) || reHtml.includes('非收尾批'), '手工改成 70 后标红：非收尾批必须整箱')
  }
  // 恢复：点该行的"自动"按钮
  const autoBtn = walk(firstRow, (el) => el.tagName === 'BUTTON').find((btn) => btn.textContent === '自动')
  check(!!autoBtn, '有恢复自动拆分按钮')
  if (autoBtn && autoBtn.listeners.click) {
    for (const fn of autoBtn.listeners.click) fn({})
    await new Promise((r) => setTimeout(r, 400))
  }
}

/* ---------- 交互：改批次数 → 手工/自动重算（走 updateBatchCount 的日期 resize） ---------- */
const batchInput = walk(rootEl, (el) => el.tagName === 'INPUT' && Number(el.attributes.min) === 1 && Number(el.attributes.max) === 20).find(
  (el) => el.type === 'number' && el.value === '2'
)
check(!!batchInput, '找到批次数输入框')
if (batchInput && batchInput.listeners.change) {
  batchInput.value = '3'
  for (const fn of batchInput.listeners.change) fn({ target: batchInput })
  await new Promise((r) => setTimeout(r, 400))
  const savedAfter = dbData.delivery.find((row) => row.id === 'p1')
  check(savedAfter.settings.batchCount === 3 && savedAfter.settings.dates.length === 3, '批次数改 3：交货时间数组同步扩到 3 并落盘')
}

console.log(failures === 0 ? '\n挂载冒烟全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
