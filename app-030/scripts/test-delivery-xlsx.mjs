/**
 * 导出端到端：生成交货清单 xlsx 落盘，用系统 unzip 校验 ZIP 结构与关键中文文本。
 * 一次性脚本（不入库 package.json）。
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

globalThis.Blob = class Blob {
  constructor(parts, opts) {
    this.parts = parts
    this.type = opts?.type
  }
  async arrayBuffer() {
    const bufs = this.parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(String(p))))
    return Buffer.concat(bufs).buffer.slice(0)
  }
}

const entry = `
import { buildDeliveryPlan, deliverySheetRows, adjustmentSheetRows, defaultDeliverySettings } from './src/logic/delivery'
import { buildXlsxBlob } from './src/logic/xlsx'
const settings = { ...defaultDeliverySettings(), batchCount: 3, dates: ['2026-11-01','2026-12-01','2027-01-10'], minQty: 30, perCarton: 20, align: 'start' }
const lines = [
  { key: 'A', sizeLabel: '160/80A', gender: 'male', kind: '常规档', qty: 130 },
  { key: 'B', sizeLabel: '165/84A', gender: 'male', kind: '常规档', qty: 86 }
]
const plan = buildDeliveryPlan(lines, settings)
const ctx = { projectName: '测试', operator: '员', generatedAt: new Date(), settings }
const blob = buildXlsxBlob([
  { name: '清单', rows: deliverySheetRows(plan, ctx) },
  { name: '调法', rows: adjustmentSheetRows(plan, settings) }
])
const fs = await import('node:fs')
fs.writeFileSync(${JSON.stringify(join(root, 'node_modules/.delivery.xlsx'))}, Buffer.from(await blob.arrayBuffer()))
`
writeFileSync(join(root, '.rt-entry.mjs'), entry)
const result = await build({
  absWorkingDir: root,
  entryPoints: ['.rt-entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false
})
const outFile = join(root, 'node_modules/.rt.mjs')
writeFileSync(outFile, result.outputFiles[0].text)
await import(outFile + `?t=${Date.now()}`)

const xlsx = join(root, 'node_modules/.delivery.xlsx')
const names = execFileSync('unzip', ['-l', xlsx], { encoding: 'utf-8' })
const sheet1 = execFileSync('unzip', ['-p', xlsx, 'xl/worksheets/sheet1.xml'], { encoding: 'utf-8' })
const sheet2 = execFileSync('unzip', ['-p', xlsx, 'xl/worksheets/sheet2.xml'], { encoding: 'utf-8' })

let ok = true
const check = (cond, message) => {
  if (!cond) {
    ok = false
    console.error(`✗ ${message}`)
  } else console.log(`✓ ${message}`)
}
check(names.includes('sheet1.xml') && names.includes('sheet2.xml'), 'xlsx 含两张工作表')
check(sheet1.includes('服装分批交货清单'), '工厂清单标题在表内')
check(sheet1.includes('第1批') && sheet1.includes('2026-11-01'), '批次号与交货时间在表内')
check(sheet1.includes('守恒'), '守恒校验行在表内')
check(sheet1.includes('160/80A'), '号型行在表内')
check(sheet2.includes('挪到下一批'), '调法对照表含挪档')
check(/<v>216<\/v>/.test(sheet1), '两号型总量 216 以数字单元格写入（非比例文本）')

rmSync(join(root, '.rt-entry.mjs'), { force: true })
rmSync(outFile, { force: true })
rmSync(xlsx, { force: true })
console.log(ok ? '\n导出端到端通过' : '\n导出校验失败')
process.exit(ok ? 0 : 1)
