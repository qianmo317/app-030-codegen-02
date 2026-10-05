/**
 * 交货批次拆分与补量（分批交货约定）。
 *
 * 硬性规则：
 *  - 凑箱数量全部用整数运算：整除（Math.floor）与取余（%），绝不按比例四舍五入；
 *  - 每个号型在每一批要么不排、要么 ≥ 最小起订量（整单不足 MOQ 的会单独标记，等补量）；
 *  - 非末批只排整箱，凑不满一箱的零头集中到末批；
 *  - Σ各批数量 = 下单总量（守恒，一件不差），不满足时禁止导出清单。
 */
import type { DeliveryBatchConfig, DeliveryOrderLine, DeliveryPlan, Gender, SizeRule } from './types'
import { specialFlagLabel } from './sizeRules'
import type { Summary } from './merge'

export function makeSizeKey(row: { sizeCode: string; gender: Gender; isSpecial: boolean }): string {
  return `${row.isSpecial ? 'S' : 'R'}|${row.sizeCode}|${row.gender}`
}

/** 号型展示名：特殊档用中文标记，常规档用号型代码 */
export function deliveryLineLabel(rule: SizeRule, line: DeliveryOrderLine): string {
  return line.isSpecial ? `${specialFlagLabel(rule, line.sizeCode)}（${line.sizeCode}）` : line.sizeCode
}

/** 整数向上整除：ceil(a / b)，只用整数加减与 Math.floor，不产生浮点比例 */
export function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b)
}

/* ------------------------------- 初始化 ------------------------------- */

/** 从下单汇总生成默认拆分明细（数量 = 汇总数量，之后可在页面改） */
export function linesFromSummary(summary: Summary): DeliveryOrderLine[] {
  return summary.allRows.map((row) => ({
    sizeKey: makeSizeKey(row),
    sizeCode: row.sizeCode,
    gender: row.gender,
    isSpecial: row.isSpecial,
    qty: row.qty
  }))
}

export function toDateText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 默认批次：从今天起每隔 30 天一批 */
export function defaultBatchDates(count: number, from: Date = new Date()): DeliveryBatchConfig[] {
  const batches: DeliveryBatchConfig[] = []
  for (let index = 0; index < count; index += 1) {
    batches.push({ index: index + 1, date: toDateText(new Date(from.getTime() + index * 30 * 86400000)) })
  }
  return batches
}

export function createDeliveryPlan(summary: Summary): DeliveryPlan {
  return {
    moq: 10,
    cartonSize: 10,
    batches: defaultBatchDates(2),
    lines: linesFromSummary(summary),
    updatedAt: Date.now()
  }
}

/* ------------------------------- 拆分结果类型 ------------------------------- */

export type DeliveryCell = {
  sizeKey: string
  batchIndex: number
  qty: number
  /** 整箱数 = qty 整除每箱件数 */
  cartons: number
  /** 零头 = qty 取余每箱件数（只有末批允许 > 0） */
  remainder: number
  /** 该格数量低于最小起订量（只可能出现在整单不足 MOQ 的号型上） */
  belowMoq: boolean
}

export type GapInfo = { from: number; to: number }

export type SizeSplitInfo = {
  line: DeliveryOrderLine
  cells: DeliveryCell[]
  /** 被拆到的批数（有数量的批） */
  batchCount: number
  batchesUsed: number[]
  /** 断档：两个相邻排产批之间夹着空批 */
  gaps: GapInfo[]
  /** 整单数量不足最小起订量 */
  belowMoqTotal: boolean
}

export type BatchInfo = {
  index: number
  date: string
  totalQty: number
  cartons: number
  remainderPieces: number
  /** 零头最难看的一格：零头最少（>0）的号型，越少越难凑箱 */
  ugliest: { sizeKey: string; remainder: number; shortToFull: number } | null
}

export type MixedCartonPiece = { sizeKey: string; label: string; qty: number }
export type MixedCarton = { pieces: MixedCartonPiece[]; total: number }

/** 调法一：把相邻号型的零头并成一箱 */
export type MergeCartonPlan = {
  cartons: MixedCarton[]
  /** 凑满整箱的数量 */
  fullCount: number
  /** 混码箱（≥2 个号型并成）数量 */
  mixedCount: number
  /** 并完后仍凑不满一箱的件数 */
  leftoverPieces: number
  /** 末批零头总件数 */
  remainderTotal: number
  /** 对照方案「各自补量凑整」需要多订的件数 */
  topUpExtra: number
}

/** 一条调法对比（断档或起订量不足） */
export type AdjustmentNote = {
  kind: 'gap' | 'moq'
  sizeKey: string
  title: string
  optionMove: string
  optionMoveFeasible: boolean
  optionOther: string
  verdict: string
}

export type DeliveryResult = {
  moq: number
  cartonSize: number
  batchCount: number
  cells: DeliveryCell[]
  bySize: SizeSplitInfo[]
  byBatch: BatchInfo[]
  totalOrder: number
  totalSplit: number
  conserved: boolean
  /** 被拆到 ≥2 批的号型 */
  splitSizes: SizeSplitInfo[]
  gapCount: number
  belowMoqCount: number
  /** 零头最多的批（正常就是末批） */
  ugliestBatch: BatchInfo | null
  mergePlan: MergeCartonPlan
  mergeVerdict: string
  adjustments: AdjustmentNote[]
}

/* ------------------------------- 整数拆分核心 ------------------------------- */

/** 把 cartons 箱尽量均匀地铺到从 startBatch 开始的 k 个连续批（靠前的批各多一箱，早批多交） */
function layCartons(
  cells: DeliveryCell[],
  sizeKey: string,
  cartons: number,
  k: number,
  startBatch: number,
  cartonSize: number
): void {
  const base = Math.floor(cartons / k)
  const extra = cartons - base * k
  for (let i = 0; i < k; i += 1) {
    const count = base + (i < extra ? 1 : 0)
    cells.push({ sizeKey, batchIndex: startBatch + i, qty: count * cartonSize, cartons: count, remainder: 0, belowMoq: false })
  }
}

/**
 * 单个号型的整数拆分：
 *  - 非末批只排整箱，每批 ≥ 最小起订量，不够的档宁可不排；
 *  - 零头集中到末批，末批先用整箱补到 ≥ 最小起订量；
 *  - 整单不足 MOQ：全部放末批并标记 belowMoq（等补量或与厂里协商）。
 */
export function splitSizeQty(
  sizeKey: string,
  qty: number,
  batchCount: number,
  moq: number,
  cartonSize: number
): DeliveryCell[] {
  if (!Number.isInteger(qty) || qty <= 0) return []
  const last = batchCount
  if (qty < moq) {
    return [
      {
        sizeKey,
        batchIndex: last,
        qty,
        cartons: Math.floor(qty / cartonSize),
        remainder: qty % cartonSize,
        belowMoq: true
      }
    ]
  }
  const remainder = qty % cartonSize
  const fullCartons = (qty - remainder) / cartonSize
  // 一个排产批至少需要的箱数（保证该批 ≥ moq）
  const minCartons = Math.max(1, ceilDiv(moq, cartonSize))
  const cells: DeliveryCell[] = []
  if (remainder === 0) {
    // 没有零头：箱数尽量摊到前面的连续批
    const k = Math.max(1, Math.min(batchCount, Math.floor(fullCartons / minCartons)))
    layCartons(cells, sizeKey, fullCartons, k, 1, cartonSize)
    return cells
  }
  // 有零头：零头放末批；末批先用整箱补到 ≥ moq（qty ≥ moq 保证 lastCartons ≤ fullCartons）
  const lastCartons = Math.max(0, ceilDiv(moq - remainder, cartonSize))
  const rest = fullCartons - lastCartons
  const k = Math.min(batchCount - 1, Math.floor(rest / minCartons))
  if (k >= 1) {
    layCartons(cells, sizeKey, rest, k, 1, cartonSize)
    cells.push({
      sizeKey,
      batchIndex: last,
      qty: lastCartons * cartonSize + remainder,
      cartons: lastCartons,
      remainder,
      belowMoq: false
    })
  } else {
    // 前面的批连一个起订量都排不下，全部并入末批
    cells.push({ sizeKey, batchIndex: last, qty, cartons: fullCartons, remainder, belowMoq: false })
  }
  return cells
}

/** 断档检测：排产批不连续（中间夹着空批） */
export function findGaps(batchesUsed: number[]): GapInfo[] {
  const sorted = [...new Set(batchesUsed)].sort((a, b) => a - b)
  const gaps: GapInfo[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] > 1) gaps.push({ from: sorted[i - 1], to: sorted[i] })
  }
  return gaps
}

/* ------------------------------- 调法一：相邻号型零头并箱 ------------------------------- */

function buildMergeCartonPlan(
  cells: DeliveryCell[],
  lines: DeliveryOrderLine[],
  cartonSize: number,
  batchCount: number,
  labelOf: (sizeKey: string) => string
): MergeCartonPlan {
  const order = new Map(lines.map((line, index) => [line.sizeKey, index]))
  const rems = cells
    .filter((cell) => cell.batchIndex === batchCount && cell.remainder > 0)
    .sort((a, b) => (order.get(a.sizeKey) ?? 0) - (order.get(b.sizeKey) ?? 0))
  const cartons: MixedCarton[] = []
  let current: MixedCarton = { pieces: [], total: 0 }
  for (const cell of rems) {
    // 按号型表顺序相邻并箱：放不下就封箱另起
    if (current.total > 0 && current.total + cell.remainder > cartonSize) {
      cartons.push(current)
      current = { pieces: [], total: 0 }
    }
    current.pieces.push({ sizeKey: cell.sizeKey, label: labelOf(cell.sizeKey), qty: cell.remainder })
    current.total += cell.remainder
  }
  if (current.pieces.length > 0) cartons.push(current)
  const remainderTotal = rems.reduce((sum, cell) => sum + cell.remainder, 0)
  const topUpExtra = rems.reduce((sum, cell) => sum + (cartonSize - cell.remainder), 0)
  return {
    cartons,
    fullCount: cartons.filter((carton) => carton.total === cartonSize).length,
    mixedCount: cartons.filter((carton) => carton.pieces.length > 1).length,
    leftoverPieces: cartons.filter((carton) => carton.total < cartonSize).reduce((sum, carton) => sum + carton.total, 0),
    remainderTotal,
    topUpExtra
  }
}

/* ------------------------------- 调法对比（挪档 / 补量 / 维持） ------------------------------- */

function buildAdjustments(
  bySize: SizeSplitInfo[],
  moq: number,
  labelOf: (sizeKey: string) => string
): AdjustmentNote[] {
  const notes: AdjustmentNote[] = []
  for (const info of bySize) {
    const label = labelOf(info.line.sizeKey)
    for (const gap of info.gaps) {
      const cell = info.cells.find((item) => item.batchIndex === gap.from)
      const moveQty = cell?.qty ?? 0
      notes.push({
        kind: 'gap',
        sizeKey: info.line.sizeKey,
        title: `${label} 在第 ${gap.from} 批与第 ${gap.to} 批之间断档（第 ${gap.from + 1}${gap.to - 1 > gap.from + 1 ? `–${gap.to - 1}` : ''} 批未排产）`,
        optionMove: `挪档：把第 ${gap.from} 批的 ${moveQty} 件挪到第 ${gap.from + 1} 批，断档消除、仍是整箱；代价 = 这 ${moveQty} 件晚交 1 个档期，不多花一件`,
        optionMoveFeasible: true,
        optionOther: `维持断档：件数与交期都不变，但产线要在第 ${gap.from} 批与第 ${gap.to} 批之间换款两次，需厂里同意断档生产（可能加收换款费）`,
        verdict: `两者都不多花件数：挪档代价是 ${moveQty} 件晚交 1 档，维持断档代价是产线换款。交期能商量时挪档更划算；交期卡死只能维持断档，若厂里因此对断档加收费用，则维持断档更不划算。`
      })
    }
    if (info.belowMoqTotal) {
      const shortage = moq - info.line.qty
      notes.push({
        kind: 'moq',
        sizeKey: info.line.sizeKey,
        title: `${label} 整单 ${info.line.qty} 件，不足最小起订量 ${moq} 件`,
        optionMove: `挪档：不可行——该号型只有末批一格，后面没有下一批可挪`,
        optionMoveFeasible: false,
        optionOther: `补量：多订 ${shortage} 件凑到起订量 ${moq} 件（下单总量 +${shortage}），或与厂里协商通融小单`,
        verdict: `并箱、挪档都解决不了起订量：只能补量（多花 ${shortage} 件的钱）或协商。补量是唯一不依赖厂里的办法，协商不成时不得不选。`
      })
    }
  }
  return notes
}

/* ------------------------------- 整体拆分 ------------------------------- */

/**
 * 按约定拆分整个交货计划。labelOf 用于把 sizeKey 翻译成展示名（页面与导出传同一个，保证一致）。
 * 全程整数运算：整除 / 取余 / ceilDiv，没有任何比例四舍五入。
 */
export function splitDelivery(plan: DeliveryPlan, labelOf: (sizeKey: string) => string = (key) => key): DeliveryResult {
  const moq = Math.max(1, Math.floor(plan.moq))
  const cartonSize = Math.max(1, Math.floor(plan.cartonSize))
  const batchCount = Math.max(1, plan.batches.length)

  const cells: DeliveryCell[] = []
  const bySize: SizeSplitInfo[] = []
  for (const line of plan.lines) {
    const qty = Number.isInteger(line.qty) && line.qty > 0 ? line.qty : 0
    const sizeCells = splitSizeQty(line.sizeKey, qty, batchCount, moq, cartonSize)
    cells.push(...sizeCells)
    const batchesUsed = [...new Set(sizeCells.map((cell) => cell.batchIndex))].sort((a, b) => a - b)
    bySize.push({
      line: { ...line, qty },
      cells: sizeCells,
      batchCount: batchesUsed.length,
      batchesUsed,
      gaps: findGaps(batchesUsed),
      belowMoqTotal: qty > 0 && qty < moq
    })
  }

  const byBatch: BatchInfo[] = []
  for (let index = 1; index <= batchCount; index += 1) {
    const batchCells = cells.filter((cell) => cell.batchIndex === index)
    let ugliest: BatchInfo['ugliest'] = null
    for (const cell of batchCells) {
      if (cell.remainder > 0 && (!ugliest || cell.remainder < ugliest.remainder)) {
        ugliest = { sizeKey: cell.sizeKey, remainder: cell.remainder, shortToFull: cartonSize - cell.remainder }
      }
    }
    byBatch.push({
      index,
      date: plan.batches[index - 1]?.date ?? '',
      totalQty: batchCells.reduce((sum, cell) => sum + cell.qty, 0),
      cartons: batchCells.reduce((sum, cell) => sum + cell.cartons, 0),
      remainderPieces: batchCells.reduce((sum, cell) => sum + cell.remainder, 0),
      ugliest
    })
  }

  const totalOrder = bySize.reduce((sum, info) => sum + info.line.qty, 0)
  const totalSplit = cells.reduce((sum, cell) => sum + cell.qty, 0)
  const ugliestBatch =
    byBatch.filter((batch) => batch.remainderPieces > 0).sort((a, b) => b.remainderPieces - a.remainderPieces)[0] ?? null

  const mergePlan = buildMergeCartonPlan(cells, plan.lines, cartonSize, batchCount, labelOf)
  const mergeVerdict =
    mergePlan.remainderTotal === 0
      ? '末批没有零头，两种调法都用不上。'
      : `末批零头共 ${mergePlan.remainderTotal} 件：并箱不多花一件，代价是 ${mergePlan.mixedCount} 只混码箱（要厂里同意拼码、到货分码）${
          mergePlan.leftoverPieces > 0 ? `，并完仍剩 ${mergePlan.leftoverPieces} 件凑不满一箱` : ''
        }；补量凑整没有混码箱，但要多订 ${mergePlan.topUpExtra} 件。厂里接受混码时，补量更不划算（白多订 ${mergePlan.topUpExtra} 件）；厂里不收混码箱时，并箱不可行，只能补量。`

  const adjustments = buildAdjustments(bySize, moq, labelOf)

  return {
    moq,
    cartonSize,
    batchCount,
    cells,
    bySize,
    byBatch,
    totalOrder,
    totalSplit,
    conserved: totalOrder === totalSplit,
    splitSizes: bySize.filter((info) => info.batchCount >= 2),
    gapCount: bySize.reduce((sum, info) => sum + info.gaps.length, 0),
    belowMoqCount: bySize.filter((info) => info.belowMoqTotal).length,
    ugliestBatch,
    mergePlan,
    mergeVerdict,
    adjustments
  }
}

/* ------------------------------- 导出清单行（与页面共用同一拆分结果） ------------------------------- */

export function deliveryMatrixRows(
  plan: DeliveryPlan,
  result: DeliveryResult,
  labelOf: (sizeKey: string) => string
): (string | number)[][] {
  const cellMap = new Map(result.cells.map((cell) => [`${cell.sizeKey}|${cell.batchIndex}`, cell]))
  const header: (string | number)[] = ['号型', '性别', '类型', '下单合计']
  for (const batch of plan.batches) header.push(`第${batch.index}批（${batch.date || '日期待定'}）`)
  header.push('拆分合计', '校验')
  const rows: (string | number)[][] = [header]
  for (const info of result.bySize) {
    if (info.line.qty <= 0) continue
    const row: (string | number)[] = [
      labelOf(info.line.sizeKey),
      info.line.gender === 'male' ? '男' : '女',
      info.line.isSpecial ? '特殊单列' : '常规档',
      info.line.qty
    ]
    let splitSum = 0
    for (const batch of plan.batches) {
      const cell = cellMap.get(`${info.line.sizeKey}|${batch.index}`)
      row.push(cell ? cell.qty : '')
      splitSum += cell?.qty ?? 0
    }
    row.push(splitSum, splitSum === info.line.qty ? '一致' : '不一致')
    rows.push(row)
  }
  const totals: (string | number)[] = ['各批合计', '', '', result.totalOrder]
  for (const batch of result.byBatch) totals.push(batch.totalQty)
  totals.push(result.totalSplit, result.conserved ? '守恒' : '不守恒')
  rows.push(totals)
  return rows
}

export function deliveryDetailRows(
  plan: DeliveryPlan,
  result: DeliveryResult,
  labelOf: (sizeKey: string) => string
): (string | number)[][] {
  const rows: (string | number)[][] = [['批次', '交货日期', '号型', '性别', '类型', '件数', '整箱数', '零头', '备注']]
  const lineMap = new Map(result.bySize.map((info) => [info.line.sizeKey, info.line]))
  for (const batch of result.byBatch) {
    const batchCells = result.cells
      .filter((cell) => cell.batchIndex === batch.index)
      .sort((a, b) => {
        const la = plan.lines.findIndex((line) => line.sizeKey === a.sizeKey)
        const lb = plan.lines.findIndex((line) => line.sizeKey === b.sizeKey)
        return la - lb
      })
    for (const cell of batchCells) {
      const line = lineMap.get(cell.sizeKey)
      const notes: string[] = []
      if (cell.belowMoq) notes.push(`不足最小起订量 ${result.moq} 件，需补量或协商`)
      if (cell.remainder > 0) notes.push('零头集中末批')
      rows.push([
        `第${batch.index}批`,
        batch.date,
        labelOf(cell.sizeKey),
        line?.gender === 'male' ? '男' : '女',
        line?.isSpecial ? '特殊单列' : '常规档',
        cell.qty,
        cell.cartons,
        cell.remainder > 0 ? cell.remainder : '',
        notes.join('；')
      ])
    }
    rows.push([`第${batch.index}批小计`, batch.date, '', '', '', batch.totalQty, batch.cartons, batch.remainderPieces, ''])
  }
  rows.push(['总计', '', '', '', '', result.totalSplit, '', '', result.conserved ? '与下单总量一致' : '与下单总量不一致'])
  return rows
}

/** 调法说明行：断档预警 + 并箱/挪档/补量对比，随清单一起给工厂 */
export function deliveryNotesRows(result: DeliveryResult, labelOf: (sizeKey: string) => string): (string | number)[][] {
  const rows: (string | number)[][] = []
  rows.push(['一、拆分说明'])
  rows.push(['被拆到多批的号型数', result.splitSizes.length])
  for (const info of result.splitSizes) {
    rows.push(['', `${labelOf(info.line.sizeKey)}：拆到 ${info.batchCount} 批（第 ${info.batchesUsed.join('、')} 批）`])
  }
  if (result.ugliestBatch) {
    const batch = result.ugliestBatch
    rows.push([
      '零头最难看的批',
      `第 ${batch.index} 批：零头共 ${batch.remainderPieces} 件` +
        (batch.ugliest
          ? `；最难看的是 ${labelOf(batch.ugliest.sizeKey)}，只剩 ${batch.ugliest.remainder} 件（距满箱差 ${batch.ugliest.shortToFull} 件）`
          : '')
    ])
  }
  rows.push([])
  rows.push(['二、断档预警（排产批不连续，提前与厂里确认）'])
  const gaps = result.adjustments.filter((note) => note.kind === 'gap')
  if (gaps.length === 0) rows.push(['无断档'])
  for (const note of gaps) {
    rows.push([note.title])
    rows.push(['', `调法一（挪档）：${note.optionMove}`])
    rows.push(['', `调法二（维持）：${note.optionOther}`])
    rows.push(['', `结论：${note.verdict}`])
  }
  rows.push([])
  rows.push(['三、末批零头调法对比'])
  rows.push(['调法一（相邻号型零头并箱）', `并成 ${result.mergePlan.cartons.length} 只箱（其中混码 ${result.mergePlan.mixedCount} 只、凑满 ${result.mergePlan.fullCount} 只），仍剩 ${result.mergePlan.leftoverPieces} 件凑不满；不多花一件`])
  for (const carton of result.mergePlan.cartons) {
    rows.push([
      '',
      `一箱 ${carton.total} 件（${carton.total === result.cartonSize ? '凑满' : '未满'}）：${carton.pieces.map((piece) => `${piece.label} ${piece.qty} 件`).join(' + ')}`
    ])
  }
  rows.push(['调法二（各自补量凑整）', `各号型零头分别补到整箱：多订 ${result.mergePlan.topUpExtra} 件，箱子全整、不用拼码`])
  rows.push(['结论', result.mergeVerdict])
  const moqNotes = result.adjustments.filter((note) => note.kind === 'moq')
  if (moqNotes.length > 0) {
    rows.push([])
    rows.push(['四、起订量不足（只能补量或协商）'])
    for (const note of moqNotes) {
      rows.push([note.title])
      rows.push(['', note.optionOther])
      rows.push(['', `结论：${note.verdict}`])
    }
  }
  return rows
}
