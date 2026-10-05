/**
 * 交货批次拆分：纯整数守恒与规则测试。
 * 运行：node --experimental-strip-types scripts/test-delivery.mjs 不通用，
 * 这里用项目自带 esbuild 把 TS 即时打包后再跑（无第三方运行时依赖）。
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outFile = join(root, 'node_modules/.delivery-test.mjs')

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/logic/delivery.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  loader: { '.ts': 'ts' }
})
writeFileSync(outFile, result.outputFiles[0].text)
const delivery = await import(outFile)

let failures = 0
function assert(condition, message) {
  if (!condition) {
    failures += 1
    console.error(`✗ ${message}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

function line(key, qty, label = key, gender = 'male', kind = '常规档') {
  return { key, sizeLabel: label, gender, kind, qty }
}

const baseSettings = delivery.defaultDeliverySettings()

/* 1. q=100, MOQ=30, c=20, n=3, end：
   零头 0 → 收尾批至少要 2 箱（40 件）才够 MOQ；k=3 需 2×2+2=6 箱 > 5 箱，失败；
   k=2：非收尾拿 3 箱=60，收尾 40 ✓ → [0,60,40] */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''], minQty: 30, perCarton: 20, align: 'end' }
  const plan = delivery.buildDeliveryPlan([line('A', 100)], s)
  assert(plan.totalQty === 100, '总量守恒 100')
  assert(JSON.stringify(plan.rows[0].cells) === JSON.stringify([0, 60, 40]), `拆两批 [0,60,40]，实际 ${JSON.stringify(plan.rows[0].cells)}`)
}

/* 2. q=130, MOQ=30, c=20, n=3, end:
   零头 10 → 收尾批预留 1 箱；k=3 需 4+1=5 箱 ≤ 6 ✓
   非收尾 5 箱最大余数法摊成 [60,40]，收尾批 20+10=30 ✓ → [60,40,30] */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''], minQty: 30, perCarton: 20, align: 'end' }
  const plan = delivery.buildDeliveryPlan([line('A', 130)], s)
  const cells = plan.rows[0].cells
  assert(JSON.stringify(cells) === JSON.stringify([60, 40, 30]), `end 拆三批 [60,40,30]，实际 ${JSON.stringify(cells)}`)
  assert(cells.reduce((a, b) => a + b, 0) === 130, '各批之和=130')
  assert(plan.rows[0].remainder === 10, '收尾批零头 10')
  assert(plan.totalLoose === 10, '零头集中在末批：全计划零头 10')
  assert(plan.blocking.length === 0, '无阻塞问题')
}

/* 3. q=130, MOQ=30, c=20, n=4, start：
   k=4 需 6+1=7 箱 > 6 箱 ✗；k=3 可行，非收尾 [60,40]，收尾 30
   → [60,40,30,0]，零头在第3批而非末批 */
{
  const s = { ...baseSettings, batchCount: 4, dates: ['', '', '', ''], minQty: 30, perCarton: 20, align: 'start' }
  const plan = delivery.buildDeliveryPlan([line('A', 130)], s)
  const cells = plan.rows[0].cells
  assert(JSON.stringify(cells) === JSON.stringify([60, 40, 30, 0]), `start 靠前排 [60,40,30,0]，实际 ${JSON.stringify(cells)}`)
  assert(plan.rows[0].remainder === 10, '收尾批（第3批）零头 10')
  assert(plan.ugly.batchIndex === 2 && plan.ugly.isLast === false, '点名第3批零头最难看（不是末批）')
}

/* 4. 不足 MOQ：q=20, MOQ=30 → 阻塞 */
{
  const s = { ...baseSettings, batchCount: 2, dates: ['', ''], minQty: 30, perCarton: 20 }
  const plan = delivery.buildDeliveryPlan([line('A', 20)], s)
  assert(plan.blocking.length === 1, '总量不足 MOQ 被标为阻塞')
  assert(plan.totalQty === 20, '阻塞时数量仍然守恒（一件不丢）')
}

/* 5. 零头并箱：start 下 A=130 自动拆成 [60,40,30]（第3批零头10）；
   B=86 手工 [0,40,46]（第3批零头6）。两档零头 10+6=16 ≤ 20，补 4 件满箱 */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''], minQty: 30, perCarton: 20, align: 'start', mixedCartonFee: 50, piecePrice: 80, fillMixed: true }
  const overrides = { B: [0, 40, 46] }
  const plan = delivery.buildDeliveryPlan([line('A', 130), line('B', 86)], s, overrides)
  const groups = delivery.buildAdjustmentGroups(plan, s)
  const gA = groups.find((g) => g.key === 'A')
  assert(gA?.merge?.feasible === true, 'A 可与相邻 B 在第3批并箱')
  assert(gA.merge.addedPieces === 4, `并箱补 4 件，实际 ${gA.merge.addedPieces}`)
  assert(gA.merge.totalCost === 50 + 4 * 80, '并箱代价 = 混装费 50 + 4×80 = 370')
}

/* 6. 挪档代价：start [60,40,30,0] 的 A 收尾批在第3批（30件，零头10），
   挪到末批(第4批)：末批兜底，不补件；延迟费 = 30×2=60；目标批原空且前一批有货 → 断档 */
{
  const s = { ...baseSettings, batchCount: 4, dates: ['', '', '', ''], minQty: 30, perCarton: 20, align: 'start', delayFeePerBatch: 2 }
  const plan = delivery.buildDeliveryPlan([line('A', 130)], s)
  const groups = delivery.buildAdjustmentGroups(plan, s)
  const sh = groups[0].shift
  assert(sh !== null && sh.targetIsLast === true, '有挪到下一批的选项，目标是末批')
  assert(sh.addedPieces === 0, '挪到末批不补件')
  assert(sh.totalCost === 60, '挪档代价 = 30 件 × 2 元 = 60')
  assert(sh.opensGap === true, '挪走后第3批空、第2/4批有货 → 断档')
  assert(plan.gaps.length === 0, '原始方案不断档（断档在调法说明里提前标出）')
}

/* 7. 挪到中间批要凑整箱：A 手工 [40,0,50,0]（收尾批第3批），
   挪到第4批是末批；改为 n=5：[40,0,50,0,0] 收尾第3批挪第4批（中间批）
   目标 50 件 → ceil 到整箱 60，补 10 件；同时第2批本来空，第1批40、第3批挪空后…
   opensGap 判定针对的是"挪完后"的形态，这里检查补件 10 */
{
  const s = { ...baseSettings, batchCount: 5, dates: ['', '', '', '', ''], minQty: 30, perCarton: 20, align: 'start', piecePrice: 80, delayFeePerBatch: 2 }
  const plan = delivery.buildDeliveryPlan([line('A', 90)], s, { A: [40, 0, 50, 0, 0] })
  const groups = delivery.buildAdjustmentGroups(plan, s)
  const sh = groups.find((g) => g.key === 'A').shift
  assert(sh.toBatchIndex === 3, '从第3批挪到第4批')
  assert(sh.targetIsLast === false, '第4批是中间批')
  assert(sh.addedPieces === 10, `中间批凑整箱补 10 件，实际 ${sh.addedPieces}`)
  assert(sh.totalCost === 10 * 80 + 50 * 2, '挪中间批代价 = 补件 800 + 延迟 100 = 900')
}

/* 8. 断档预警：手工 [40,0,50]（第2批夹空）→ gaps 标出 */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''], minQty: 30, perCarton: 20 }
  const plan = delivery.buildDeliveryPlan([line('A', 90)], s, { A: [40, 0, 50] })
  assert(plan.gaps.length === 1 && plan.gaps[0].batchIndex === 1, '相邻档之间断档提前标出（第2批）')
}

/* 9. 手工合计不等于下单量 → sum_mismatch 阻塞，守恒 false */
{
  const s = { ...baseSettings, batchCount: 2, dates: ['', ''], minQty: 30, perCarton: 20 }
  const plan = delivery.buildDeliveryPlan([line('A', 90)], s, { A: [40, 40] })
  assert(plan.conserved === false, '手工 40+40 ≠ 90：不守恒')
  assert(plan.blocking.some((p) => p.code === 'sum_mismatch'), '加总不等被拦截')
}

/* 10. reconcileOverrides：下单数量改了，旧覆盖自动作废 */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''] }
  const { overrides, droppedKeys } = delivery.reconcileOverrides([line('A', 130), line('B', 86)], 3, { A: [40, 40, 40], B: [0, 40, 46] })
  assert(droppedKeys.includes('A'), 'A 旧拆分 120 ≠ 新下单 130，标记作废重拆')
  assert(overrides.B !== null, 'B 合计仍等于下单量，保留手工')
}

/* 11. 多号型守恒：随机整数批量，每个号型各批之和必须等于下单量 */
{
  const s = { ...baseSettings, batchCount: 4, dates: ['', '', '', ''], minQty: 25, perCarton: 12, align: 'end' }
  const lines = []
  for (let i = 0; i < 40; i += 1) lines.push(line(`S${i}`, 1 + ((i * 37) % 400)))
  const plan = delivery.buildDeliveryPlan(lines, s)
  const allConserved = plan.rows.every((row) => row.cells.reduce((a, b) => a + b, 0) === row.line.qty)
  assert(allConserved, '40 个号型逐档守恒')
  assert(plan.totalQty === lines.reduce((a, b) => a + b.qty, 0), '批次总计 = 下单总计')
  const validRows = plan.rows.filter((r) => r.line.qty >= 25)
  const rulesHeld = validRows.every((row) =>
    row.cells.every((value, index) => {
      if (value === 0) return true
      if (value < 25) return false
      if (index !== row.endBatchIndex && value % 12 !== 0) return false
      return true
    })
  )
  assert(rulesHeld, '非零批 ≥ MOQ 且非收尾批均为整箱')
  // end 策略：所有零头必须在末批
  const looseOnlyLast = validRows.every((row) =>
    row.cellInfo.slice(0, -1).every((info) => info.loose === 0)
  )
  assert(looseOnlyLast, 'end 策略下零头只出现在末批')
}

/* 12. 非收尾批摊匀（最大余数法，两批至多差 1 箱；先给收尾批预留整箱）：
   q=310 boxes=15 rem=10, MOQ=30, c=20, n=3, end：k=3 用满三批（不补前导零）
   收尾批预留 1 箱；非收尾 14 箱，保底各 2 箱后余 10 箱 → 各 +5
   → [140,140]，收尾 20+10=30 ✓ → [140,140,30] */
{
  const s = { ...baseSettings, batchCount: 3, dates: ['', '', ''], minQty: 30, perCarton: 20, align: 'end' }
  const plan = delivery.buildDeliveryPlan([line('A', 310)], s)
  assert(JSON.stringify(plan.rows[0].cells) === JSON.stringify([140, 140, 30]), `[140,140,30] 实际 ${JSON.stringify(plan.rows[0].cells)}`)
}

/* 13. 每号型独立箱规：A c=10，B 沿用全局 c=20 */
{
  const s = { ...baseSettings, batchCount: 2, dates: ['', ''], minQty: 15, perCarton: 20, align: 'end' }
  const plan = delivery.buildDeliveryPlan(
    [line('A', 45), line('B', 30)],
    s,
    {},
    { A: { minQty: null, perCarton: 10 } }
  )
  // A(c=10): boxes=4 rem=5, 收尾预留 1 箱，非收尾 3 箱 → [30,15] ✓
  // B(c=20): q=30 零头 10，收尾预留 1 箱 + 非收尾 1 箱 = 2 箱，实际只有 1 箱 ✗ → 退回 k=1 [0,30]
  assert(JSON.stringify(plan.rows[0].cells) === JSON.stringify([30, 15]), `A(c=10) 拆两批 [30,15]，实际 ${JSON.stringify(plan.rows[0].cells)}`)
  assert(JSON.stringify(plan.rows[1].cells) === JSON.stringify([0, 30]), 'B(c=20) 整箱不够分给两批时退回一批')
  assert(plan.rows[0].perCarton === 10 && plan.rows[1].perCarton === 20, '各行保留独立箱规')
}

/* 14. 链式相邻：A、B、C 收尾批（第3批，非末批）都有零头且能两两装一箱 → A+B 配对，C 不与 B 再配 */
{
  const s = { ...baseSettings, batchCount: 4, dates: ['', '', '', ''], minQty: 30, perCarton: 20, align: 'start', mixedCartonFee: 50, piecePrice: 80 }
  // 三个号型手工：A [0,40,50,0] 零10；B [0,40,46,0] 零6；C [0,40,44,0] 零4；收尾批都在第3批
  const plan = delivery.buildDeliveryPlan(
    [line('A', 90), line('B', 86), line('C', 84)],
    s,
    { A: [0, 40, 50, 0], B: [0, 40, 46, 0], C: [0, 40, 44, 0] }
  )
  const groups = delivery.buildAdjustmentGroups(plan, s)
  const gA = groups.find((g) => g.key === 'A')
  const gB = groups.find((g) => g.key === 'B')
  const gC = groups.find((g) => g.key === 'C')
  assert(gA.merge && gA.merge.labelB === 'B', 'A 与 B 并箱')
  assert(gA.pairedBy === null, 'A 不是别人的搭档')
  assert(gB.merge === null && gB.pairedBy === 'A', 'B 已作为 A 的搭档，不再单独并箱（不与 C 重复配）')
  assert(gC.merge === null, 'C 没有相邻搭档（B 已被用），只能挪档')
  assert(gC.shift !== null, 'C 仍给出挪到下一批的调法')
}

/* 15. 零头加起来超过一箱 → 不配对，给出只能挪档的结论 */
{
  const s = { ...baseSettings, batchCount: 4, dates: ['', '', '', ''], minQty: 30, perCarton: 20, align: 'start' }
  // A 零 14，B 零 15 → 合计 29 > 20；收尾批在第3批（非末批），可挪到第4批
  const plan = delivery.buildDeliveryPlan(
    [line('A', 94), line('B', 95)],
    s,
    { A: [0, 40, 54, 0], B: [0, 40, 55, 0] }
  )
  const groups = delivery.buildAdjustmentGroups(plan, s)
  const gA = groups.find((g) => g.key === 'A')
  assert(gA.merge === null, '零头合计超过一箱，不产生并箱方案')
  assert(gA.shift !== null, '仍可挪档')
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
rmSync(outFile, { force: true })
process.exit(failures === 0 ? 0 : 1)