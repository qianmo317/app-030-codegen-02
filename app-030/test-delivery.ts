import { splitDelivery, splitSizeQty, findGaps, createDeliveryPlan, ceilDiv } from './src/logic/delivery.ts'
import type { DeliveryPlan } from './src/logic/types.ts'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    failures += 1
    console.error(`FAIL ${name} ${extra}`)
  } else {
    console.log(`ok   ${name}`)
  }
}
const sum = (cells) => cells.reduce((s, c) => s + c.qty, 0)

// 1. 基本拆分：95 件 / 每箱 10 / MOQ 10 / 3 批 → 40/40/15，零头 5 在末批
{
  const cells = splitSizeQty('A', 95, 3, 10, 10)
  check('95/3批 守恒', sum(cells) === 95, JSON.stringify(cells))
  check('95/3批 非末批整箱', cells.filter((c) => c.batchIndex < 3).every((c) => c.qty % 10 === 0))
  check('95/3批 零头在末批', cells.filter((c) => c.remainder > 0).every((c) => c.batchIndex === 3))
  check('95/3批 全部>=MOQ', cells.every((c) => c.qty >= 10))
}

// 2. MOQ 约束：23 件 / 箱 10 / MOQ 10 / 3 批 → 前批整箱 + 末批 13，第 2 批空（断档）
{
  const cells = splitSizeQty('A', 23, 3, 10, 10)
  check('23/3批 守恒', sum(cells) === 23, JSON.stringify(cells))
  check('23/3批 每格>=MOQ', cells.every((c) => c.qty >= 10))
  check('23/3批 非末批整箱', cells.filter((c) => c.batchIndex < 3).every((c) => c.qty % 10 === 0))
  const used = [...new Set(cells.map((c) => c.batchIndex))].sort((a, b) => a - b)
  check('23/3批 断档检出', JSON.stringify(findGaps(used)) === JSON.stringify([{ from: 1, to: 3 }]), JSON.stringify(used))
}

// 3. MOQ > 每箱：MOQ 20 / 箱 10 / 45 件 / 3 批 → 排产批至少 2 箱
{
  const cells = splitSizeQty('A', 45, 3, 20, 10)
  check('45 MOQ20 守恒', sum(cells) === 45, JSON.stringify(cells))
  check('45 MOQ20 每格>=20', cells.every((c) => c.qty >= 20), JSON.stringify(cells))
}

// 4. 整单不足 MOQ：7 件 / MOQ 10 → 全放末批并标记
{
  const cells = splitSizeQty('A', 7, 3, 10, 10)
  check('7<MOQ 守恒', sum(cells) === 7)
  check('7<MOQ 末批+标记', cells.length === 1 && cells[0].batchIndex === 3 && cells[0].belowMoq)
}

// 5. 整除无零头：100 件 / 箱 10 / MOQ 10 / 3 批 → 40/30/30
{
  const cells = splitSizeQty('A', 100, 3, 10, 10)
  check('100/3批 守恒', sum(cells) === 100)
  check('100/3批 分布', JSON.stringify(cells.map((c) => c.qty)) === JSON.stringify([40, 30, 30]), JSON.stringify(cells))
}

// 6. 单批：全部进第 1 批（末批）
{
  const cells = splitSizeQty('A', 37, 1, 10, 10)
  check('单批守恒', sum(cells) === 37 && cells.length === 1 && cells[0].batchIndex === 1)
}

// 7. 不足一箱但 >= MOQ：MOQ 5 / 箱 10 / 7 件 → 末批 7
{
  const cells = splitSizeQty('A', 7, 3, 5, 10)
  check('7件 MOQ5 末批', sum(cells) === 7 && cells[0].batchIndex === 3 && !cells[0].belowMoq)
}

// 8. ceilDiv 整数向上整除
check('ceilDiv', ceilDiv(10, 10) === 1 && ceilDiv(11, 10) === 2 && ceilDiv(0, 10) === 0 && ceilDiv(1, 8) === 1)

// 9. 整体拆分：守恒 + 报告字段
{
  const plan: DeliveryPlan = {
    moq: 10,
    cartonSize: 10,
    batches: [
      { index: 1, date: '2026-11-01' },
      { index: 2, date: '2026-12-01' },
      { index: 3, date: '2027-01-01' }
    ],
    lines: [
      { sizeKey: 'R|170/88A|male', sizeCode: '170/88A', gender: 'male', isSpecial: false, qty: 95 },
      { sizeKey: 'R|175/92A|male', sizeCode: '175/92A', gender: 'male', isSpecial: false, qty: 23 },
      { sizeKey: 'R|160/84A|female', sizeCode: '160/84A', gender: 'female', isSpecial: false, qty: 7 },
      { sizeKey: 'S|XL|male', sizeCode: 'XL', gender: 'male', isSpecial: true, qty: 0 }
    ],
    updatedAt: 0
  }
  const result = splitDelivery(plan, (k) => k)
  check('整体守恒', result.conserved && result.totalOrder === 125 && result.totalSplit === 125)
  check('整体 各批合计=125', result.byBatch.reduce((s, b) => s + b.totalQty, 0) === 125)
  check('整体 零头只在末批', result.byBatch.slice(0, -1).every((b) => b.remainderPieces === 0))
  check('整体 末批零头=5+3+7=15', result.byBatch[2].remainderPieces === 15, JSON.stringify(result.byBatch))
  check('整体 断档计数=1', result.gapCount === 1, JSON.stringify(result.adjustments))
  check('整体 MOQ不足=1', result.belowMoqCount === 1)
  check('整体 被拆分号型=2', result.splitSizes.length === 2)
  check('整体 最难看批=第3批', result.ugliestBatch?.index === 3)
  check('整体 最难看格=175/92A 余3', result.ugliestBatch?.ugliest?.sizeKey === 'R|175/92A|male' && result.ugliestBatch?.ugliest?.remainder === 3)
  // 并箱：末批零头 5(170/88A) + 3(175/92A) + 7(160/84A) → 5+3=8 封箱, 7 → 两箱都未满
  check('并箱 总零头=15', result.mergePlan.remainderTotal === 15)
  check('并箱 补量对照=(10-5)+(10-3)+(10-7)=15', result.mergePlan.topUpExtra === 15)
  check('并箱 箱数=2', result.mergePlan.cartons.length === 2, JSON.stringify(result.mergePlan.cartons))
  check('并箱 第一箱=170+175 共8件', result.mergePlan.cartons[0].total === 8 && result.mergePlan.cartons[0].pieces.length === 2)
  // 调法建议：断档 1 条 + MOQ 1 条
  check('调法 2 条', result.adjustments.length === 2)
  check('调法 断档可挪档', result.adjustments.find((a) => a.kind === 'gap')?.optionMoveFeasible === true)
  check('调法 MOQ不可挪档', result.adjustments.find((a) => a.kind === 'moq')?.optionMoveFeasible === false)
}

// 10. 随机守恒压测：任意数量都守恒、非末批整箱、排产格>=MOQ（除整单不足）
{
  let ok = true
  for (let t = 0; t < 2000; t += 1) {
    const qty = 1 + Math.floor(Math.random() * 500)
    const B = 1 + Math.floor(Math.random() * 6)
    const carton = [4, 5, 6, 8, 10, 12][Math.floor(Math.random() * 6)]
    const moq = [1, 5, 10, 20, 30][Math.floor(Math.random() * 5)]
    const cells = splitSizeQty('A', qty, B, moq, carton)
    if (sum(cells) !== qty) { ok = false; console.error('守恒失败', qty, B, moq, carton, cells); break }
    if (cells.some((c) => c.batchIndex < B && c.qty % carton !== 0)) { ok = false; console.error('非末批非整箱', qty, B, moq, carton, cells); break }
    if (cells.some((c) => c.remainder > 0 && c.batchIndex !== B)) { ok = false; console.error('零头不在末批', qty, B, moq, carton, cells); break }
    if (qty >= moq && cells.some((c) => c.qty < moq)) { ok = false; console.error('排产格不足MOQ', qty, B, moq, carton, cells); break }
    if (qty < moq && !(cells.length === 1 && cells[0].belowMoq)) { ok = false; console.error('整单不足未标记', qty, B, moq, carton, cells); break }
  }
  check('随机 2000 组守恒+约束', ok)
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
