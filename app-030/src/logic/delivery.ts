/**
 * 交货批次拆分与补量（纯整数运算，禁止按比例四舍五入）。
 *
 * 约定：
 * - 每个号型在每一批要么不排、要么不少于最小起订量（MOQ）；
 * - 非该号型收尾批的批次，数量必须凑成整箱（每箱件数的整数倍）；
 * - 每个号型的零头只落在它自己的收尾批；align='end' 时各号型靠后排，
 *   零头自然集中到末批；align='start' 时靠前排，零头会出现在更早的批次，
 *   此时由诊断区点名「哪一批零头最难看」并给出两种调法的代价。
 */
import type { Gender } from './types'

export type DeliveryAlign = 'end' | 'start'

export type DeliverySettings = {
  /** 与厂方约定的批次数 */
  batchCount: number
  /** 每批交货时间（长度 = batchCount，允许空串占位） */
  dates: string[]
  /** 每批每号型最小起订量（件） */
  minQty: number
  /** 每箱件数（件/箱） */
  perCarton: number
  /** end = 靠后排（零头集中末批，默认）；start = 靠前排 */
  align: DeliveryAlign
  /** 相邻号型零头并成一箱时，混装一箱的打包加价（元/箱） */
  mixedCartonFee: number
  /** 挪档：该档货晚交一批的延迟加价（元/件·档） */
  delayFeePerBatch: number
  /** 每件单价，补量多做的件按此计价（元/件） */
  piecePrice: number
  /** 并箱时是否把混装箱补满整箱（补满要多做件） */
  fillMixed: boolean
}

export type DeliveryLineInput = {
  /** 号型唯一键：特殊/常规 | 号型 | 性别 */
  key: string
  sizeLabel: string
  gender: Gender
  kind: '常规档' | '特殊单列'
  /** 下单数量（该号型总件数，必须为非负整数） */
  qty: number
}

/** 每个号型可单独覆盖的装箱/起订参数（null = 跟随全局） */
export type LineParamOverride = { minQty: number | null; perCarton: number | null }

export type LineProblemCode =
  | 'below_moq_total'
  | 'cell_below_moq'
  | 'cell_not_fullbox'
  | 'sum_mismatch'

export type LineProblem = {
  code: LineProblemCode
  /** 涉及的批次下标；总量类问题为 null */
  batchIndex: number | null
  message: string
}

export type CellInfo = {
  qty: number
  /** 整箱数 floor(qty/c) */
  fullCartons: number
  /** 零头 qty%c（0 = 恰好整箱或未排产） */
  loose: number
  /** 该批占用箱数 ceil(qty/c) */
  cartons: number
}

export type LineMatrixRow = {
  line: DeliveryLineInput
  moq: number
  perCarton: number
  cells: number[]
  cellInfo: CellInfo[]
  /** 实际排产的批次下标 */
  spanBatches: number[]
  /** 被拆到了几批 */
  spanCount: number
  /** 收尾批（最后一个有数量的批），零头落在这里 */
  endBatchIndex: number | null
  /** 收尾批零头件数 */
  remainder: number
  /** 是否由手工覆盖产生（否则为算法自动拆分） */
  manual: boolean
  problems: LineProblem[]
}

export type BatchSummary = {
  index: number
  date: string
  qty: number
  fullCartons: number
  loose: number
  cartons: number
  /** 本批有零头的号型个数 */
  looseKinds: number
}

export type GapWarning = {
  key: string
  sizeLabel: string
  /** 夹在两个有数量批次之间的空批下标 */
  batchIndex: number
}

export type UglyBatch = {
  batchIndex: number
  loose: number
  looseKinds: number
  /** 零头最难看的批是否就是末批（end 策略下属约定内的正常集中） */
  isLast: boolean
}

export type DeliveryPlan = {
  batchCount: number
  dates: string[]
  rows: LineMatrixRow[]
  batches: BatchSummary[]
  totalQty: number
  totalCartons: number
  totalLoose: number
  gaps: GapWarning[]
  ugly: UglyBatch | null
  /** 阻塞性问题（不足 MOQ / 手工数量加总不等于下单量），导出工厂清单前必须处理 */
  blocking: LineProblem[]
  /** 各号型各批之和是否逐档等于下单总量（一档都不能少） */
  conserved: boolean
}

export const DELIVERY_PROBLEM_TEXT: Record<LineProblemCode, string> = {
  below_moq_total: '下单总量不足最小起订量，任何一批都无法排产',
  cell_below_moq: '该批数量低于最小起订量',
  cell_not_fullbox: '非收尾批必须凑成整箱',
  sum_mismatch: '各批数量之和不等于下单总量'
}

export function defaultDeliverySettings(): DeliverySettings {
  return {
    batchCount: 2,
    dates: ['', ''],
    minQty: 50,
    perCarton: 20,
    align: 'end',
    mixedCartonFee: 50,
    delayFeePerBatch: 2,
    piecePrice: 80,
    fillMixed: true
  }
}

/** 调整批次数时保留已有交货时间，新批补空串 */
export function resizeDates(dates: string[], batchCount: number): string[] {
  const next = Array.from({ length: batchCount }, (_v, index) => dates[index] ?? '')
  return next
}

export function normalizeSettings(input: DeliverySettings): DeliverySettings {
  const positiveInt = (value: number, fallback: number): number => {
    if (!Number.isFinite(value) || value < 1) return fallback
    return Math.trunc(value)
  }
  const nonNegativeMoney = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0)
  const batchCount = Math.min(20, Math.max(1, Math.trunc(input.batchCount) || 1))
  return {
    batchCount,
    dates: resizeDates(input.dates ?? [], batchCount),
    minQty: positiveInt(input.minQty, 50),
    perCarton: positiveInt(input.perCarton, 20),
    align: input.align === 'start' ? 'start' : 'end',
    mixedCartonFee: nonNegativeMoney(input.mixedCartonFee),
    delayFeePerBatch: nonNegativeMoney(input.delayFeePerBatch),
    piecePrice: nonNegativeMoney(input.piecePrice),
    fillMixed: input.fillMixed !== false
  }
}

function resolveMoq(settings: DeliverySettings, override?: LineParamOverride): number {
  const value = override?.minQty
  return value !== null && value !== undefined && value >= 1 ? Math.trunc(value) : settings.minQty
}

function resolvePerCarton(settings: DeliverySettings, override?: LineParamOverride): number {
  const value = override?.perCarton
  return value !== null && value !== undefined && value >= 1 ? Math.trunc(value) : settings.perCarton
}

/**
 * 单个号型的自动拆分（纯整数）。
 * 返回每批件数；可行性靠循环枚举 k 而不是比例近似。
 */
export function autoSplitCells(
  qty: number,
  batchCount: number,
  moq: number,
  perCarton: number,
  align: DeliveryAlign
): { cells: number[]; chosenK: number; problems: LineProblem[] } {
  const cells = new Array<number>(batchCount).fill(0)
  const problems: LineProblem[] = []

  if (qty <= 0) return { cells, chosenK: 0, problems }

  // 总量连一批的 MOQ 都不够：无法拆分，整件放在约定位置并由上层标红拦截
  if (qty < moq) {
    const index = align === 'end' ? batchCount - 1 : 0
    cells[index] = qty
    problems.push({ code: 'below_moq_total', batchIndex: null, message: DELIVERY_PROBLEM_TEXT.below_moq_total })
    return { cells, chosenK: 1, problems }
  }

  /** 给定拆成 k 批时，非收尾批是否全部能整箱且 ≥ MOQ；能则返回每箱分配，否则 null */
  const tryK = (k: number): number[] | null => {
    if (k === 1) return []
    const boxes = Math.floor(qty / perCarton)
    const remainder = qty % perCarton
    const nonEnd = k - 1
    const minBoxesEach = Math.ceil(moq / perCarton)
    // 收尾批要靠「整箱 + 零头」凑够 MOQ，先按整数算出至少要给它留几箱
    const endMinBoxes = Math.max(0, Math.ceil((moq - remainder) / perCarton))
    if (boxes < nonEnd * minBoxesEach + endMinBoxes) return null
    // 余下整箱在非收尾批之间用最大余数法摊匀（两批至多差 1 箱）
    const nonEndBoxes = boxes - endMinBoxes
    const extraBoxes = nonEndBoxes - nonEnd * minBoxesEach
    const base = minBoxesEach + Math.floor(extraBoxes / nonEnd)
    let bonus = extraBoxes % nonEnd
    const alloc: number[] = []
    for (let i = 0; i < nonEnd; i += 1) {
      const add = bonus > 0 ? 1 : 0
      if (bonus > 0) bonus -= 1
      alloc.push((base + add) * perCarton)
    }
    const allocated = alloc.reduce((sum, value) => sum + value, 0)
    if (qty - allocated < moq) return null // 整数恒等式兜底
    return alloc
  }

  const kLimit = Math.min(batchCount, Math.floor(qty / moq))
  let chosenK = 0
  let nonEndQtys: number[] = []
  for (let k = kLimit; k >= 1; k -= 1) {
    const alloc = tryK(k)
    if (alloc !== null) {
      chosenK = k
      nonEndQtys = alloc
      break
    }
  }

  // qty >= moq 时 k=1 必然可行
  if (chosenK === 0) {
    chosenK = 1
    nonEndQtys = []
  }

  const start = align === 'end' ? batchCount - chosenK : 0
  nonEndQtys.forEach((value, offset) => {
    cells[start + offset] = value
  })
  const used = nonEndQtys.reduce((sum, value) => sum + value, 0)
  cells[start + chosenK - 1] = qty - used
  return { cells, chosenK, problems }
}

/** 对一份每批数量做通用体检（自动拆分与手工编辑共用同一套判定） */
export function evaluateCells(
  qty: number,
  cells: number[],
  moq: number,
  perCarton: number
): {
  spanBatches: number[]
  spanCount: number
  endBatchIndex: number | null
  remainder: number
  problems: LineProblem[]
} {
  const spanBatches: number[] = []
  cells.forEach((value, index) => {
    if (value > 0) spanBatches.push(index)
  })
  const endBatchIndex = spanBatches.length > 0 ? spanBatches[spanBatches.length - 1] : null
  const remainder = endBatchIndex !== null ? cells[endBatchIndex] % perCarton : 0
  const problems: LineProblem[] = []
  const sum = cells.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0)

  if (sum !== qty) {
    problems.push({
      code: 'sum_mismatch',
      batchIndex: null,
      message: `${DELIVERY_PROBLEM_TEXT.sum_mismatch}（各批合计 ${sum}，下单 ${qty}，差 ${qty - sum}）`
    })
  }
  if (qty < moq && qty > 0) {
    problems.push({ code: 'below_moq_total', batchIndex: null, message: DELIVERY_PROBLEM_TEXT.below_moq_total })
  }
  cells.forEach((value, index) => {
    if (value <= 0) return
    if (value < moq) {
      problems.push({ code: 'cell_below_moq', batchIndex: index, message: `第${index + 1}批 ${value} 件：${DELIVERY_PROBLEM_TEXT.cell_below_moq}（${moq} 件）` })
    }
    if (index !== endBatchIndex && value % perCarton !== 0) {
      problems.push({ code: 'cell_not_fullbox', batchIndex: index, message: `第${index + 1}批 ${value} 件：${DELIVERY_PROBLEM_TEXT.cell_not_fullbox}（每箱 ${perCarton} 件）` })
    }
  })

  return { spanBatches, spanCount: spanBatches.length, endBatchIndex, remainder, problems }
}

export type DeliveryOverrides = Record<string, number[] | null>
export type DeliveryLineParams = Record<string, LineParamOverride>

/**
 * 下单数量或批次数变动后，丢弃已经对不上的手工覆盖：
 * 长度不符或加总不等于新下单量的覆盖不再沿用，改由算法重新拆。
 */
export function reconcileOverrides(
  lines: DeliveryLineInput[],
  batchCount: number,
  overrides: DeliveryOverrides
): { overrides: DeliveryOverrides; droppedKeys: string[] } {
  const next: DeliveryOverrides = {}
  const droppedKeys: string[] = []
  for (const line of lines) {
    const override = overrides[line.key]
    if (!override) {
      next[line.key] = null
      continue
    }
    const valid =
      override.length === batchCount &&
      override.every((value) => Number.isInteger(value) && value >= 0) &&
      override.reduce((sum, value) => sum + value, 0) === line.qty
    if (valid) next[line.key] = [...override]
    else {
      next[line.key] = null
      droppedKeys.push(line.key)
    }
  }
  return { overrides: next, droppedKeys }
}

export function buildDeliveryPlan(
  lines: DeliveryLineInput[],
  rawSettings: DeliverySettings,
  overrides: DeliveryOverrides = {},
  lineParams: DeliveryLineParams = {}
): DeliveryPlan {
  const settings = normalizeSettings(rawSettings)
  const n = settings.batchCount

  const rows: LineMatrixRow[] = lines.map((line) => {
    const moq = resolveMoq(settings, lineParams[line.key])
    const perCarton = resolvePerCarton(settings, lineParams[line.key])
    const manualCells = overrides[line.key] ?? null
    const manual = manualCells !== null
    const split = manualCells
      ? { cells: [...manualCells], problems: [] as LineProblem[] }
      : autoSplitCells(line.qty, n, moq, perCarton, settings.align)
    const cells = split.cells
    const evaluated = evaluateCells(line.qty, cells, moq, perCarton)
    const cellInfo: CellInfo[] = cells.map((value) => ({
      qty: value,
      fullCartons: Math.floor(value / perCarton),
      loose: value % perCarton,
      cartons: value === 0 ? 0 : Math.ceil(value / perCarton)
    }))
    return {
      line,
      moq,
      perCarton,
      cells,
      cellInfo,
      spanBatches: evaluated.spanBatches,
      spanCount: evaluated.spanCount,
      endBatchIndex: evaluated.endBatchIndex,
      remainder: evaluated.remainder,
      manual,
      problems: evaluated.problems
    }
  })

  const gaps: GapWarning[] = []
  for (const row of rows) {
    const first = row.spanBatches[0]
    const last = row.spanBatches[row.spanBatches.length - 1]
    if (first === undefined || last === undefined || first === last) continue
    for (let b = first + 1; b < last; b += 1) {
      if (row.cells[b] === 0) gaps.push({ key: row.line.key, sizeLabel: row.line.sizeLabel, batchIndex: b })
    }
  }

  const batches: BatchSummary[] = Array.from({ length: n }, (_v, index) => {
    let qty = 0
    let fullCartons = 0
    let loose = 0
    let looseKinds = 0
    for (const row of rows) {
      const info = row.cellInfo[index]
      qty += info.qty
      fullCartons += info.fullCartons
      loose += info.loose
      if (info.loose > 0) looseKinds += 1
    }
    return {
      index,
      date: settings.dates[index] ?? '',
      qty,
      fullCartons,
      loose,
      looseKinds,
      cartons: rows.reduce((sum, row) => sum + row.cellInfo[index].cartons, 0)
    }
  })

  let ugly: UglyBatch | null = null
  batches.forEach((batch) => {
    if (batch.loose <= 0) return
    if (!ugly || batch.loose > ugly.loose || (batch.loose === ugly.loose && batch.looseKinds > ugly.looseKinds)) {
      ugly = { batchIndex: batch.index, loose: batch.loose, looseKinds: batch.looseKinds, isLast: batch.index === n - 1 }
    }
  })

  const blocking: LineProblem[] = []
  for (const row of rows) {
    for (const problem of row.problems) {
      if (problem.code === 'below_moq_total' || problem.code === 'sum_mismatch') blocking.push(problem)
    }
  }

  return {
    batchCount: n,
    dates: settings.dates,
    rows,
    batches,
    totalQty: batches.reduce((sum, batch) => sum + batch.qty, 0),
    totalCartons: batches.reduce((sum, batch) => sum + batch.cartons, 0),
    totalLoose: batches.reduce((sum, batch) => sum + batch.loose, 0),
    gaps,
    ugly,
    blocking,
    conserved: rows.every((row) => row.cells.reduce((sum, value) => sum + value, 0) === row.line.qty)
  }
}

/* ------------------------- 两种调法与代价对照 ------------------------- */

export type MergeOption = {
  kind: 'merge'
  batchIndex: number
  keyA: string
  labelA: string
  looseA: number
  keyB: string
  labelB: string
  looseB: number
  perCarton: number
  /** 并箱后为补满整箱多做的件数 */
  addedPieces: number
  pieceCost: number
  mixedFee: number
  totalCost: number
  feasible: boolean
  reason: string
}

export type ShiftOption = {
  kind: 'shift'
  key: string
  label: string
  fromBatchIndex: number
  toBatchIndex: number
  qtyMoved: number
  /** 目标批为凑整箱/够 MOQ 需要补做的件数 */
  addedPieces: number
  pieceCost: number
  delayCost: number
  totalCost: number
  /** 是否会在相邻档之间形成断档（本号型两批有货、中间空一批） */
  opensGap: boolean
  targetIsLast: boolean
  feasible: boolean
  reason: string
}

export type AdjustmentGroup = {
  batchIndex: number
  key: string
  label: string
  loose: number
  merge: MergeOption | null
  /** 本行只是某个相邻并箱方案里的「另一档」（并箱明细记在搭档行） */
  pairedBy: string | null
  shift: ShiftOption | null
  /** 两种调法都可行时，更便宜的那个 */
  cheaper: 'merge' | 'shift' | null
  /** 更不划算的调法比便宜方案多花的金额（元） */
  waste: number
  note: string
}

/** 向上把 newTarget 凑成整箱且不低于 MOQ，返回需要补做的件数 */
function topUpToFullBox(newTarget: number, moq: number, perCarton: number): number {
  const toBox = (perCarton - (newTarget % perCarton)) % perCarton
  let target = newTarget + toBox
  while (target < moq) target += perCarton
  return target - newTarget
}

export function buildAdjustmentGroups(plan: DeliveryPlan, settings: DeliverySettings): AdjustmentGroup[] {
  const n = plan.batchCount

  // 先贪心确定相邻并箱配对：同批（各自行的收尾批相同）、箱规一致、零头能装进一箱，
  // 每档至多参与一次并箱（避免 A+B 与 B+C 把 B 用两次）。
  type Pair = { batchIndex: number; aIndex: number; bIndex: number; looseA: number; looseB: number; perCarton: number }
  const pairs: Pair[] = []
  const consumed = new Set<number>()
  for (let index = 0; index < plan.rows.length - 1; index += 1) {
    if (consumed.has(index)) continue
    const row = plan.rows[index]
    if (row.endBatchIndex === null || row.remainder <= 0) continue
    for (let next = index + 1; next < plan.rows.length; next += 1) {
      if (consumed.has(next)) continue
      const neighbor = plan.rows[next]
      if (neighbor.endBatchIndex !== row.endBatchIndex) break // 相邻档的收尾批已经不在同一批，再往后更不相邻
      if (neighbor.remainder <= 0) continue
      if (neighbor.perCarton !== row.perCarton) continue
      if (row.remainder + neighbor.remainder > row.perCarton) continue
      pairs.push({
        batchIndex: row.endBatchIndex,
        aIndex: index,
        bIndex: next,
        looseA: row.remainder,
        looseB: neighbor.remainder,
        perCarton: row.perCarton
      })
      consumed.add(index)
      consumed.add(next)
      break
    }
  }
  const pairByRow = new Map<number, Pair>()
  const pairedBy = new Map<number, number>()
  for (const pair of pairs) {
    pairByRow.set(pair.aIndex, pair)
    pairedBy.set(pair.bIndex, pair.aIndex)
  }

  const groups: AdjustmentGroup[] = []

  plan.rows.forEach((row, rowIndex) => {
    const end = row.endBatchIndex
    if (end === null || row.remainder <= 0) return

    // —— 调法一：相邻号型在同批的零头并成一箱 ——
    let merge: MergeOption | null = null
    const partnerIndex = pairedBy.get(rowIndex)
    const pair = pairByRow.get(rowIndex)
    if (pair) {
      const neighbor = plan.rows[pair.bIndex]
      const sum = pair.looseA + pair.looseB
      const addedPieces = settings.fillMixed ? pair.perCarton - sum : 0
      const pieceCost = addedPieces * settings.piecePrice
      const totalCost = settings.mixedCartonFee + pieceCost
      const reason =
        addedPieces > 0
          ? `并为混装整箱需多做 ${addedPieces} 件，另付混装打包费`
          : '两档零头恰好凑成整箱，只付混装打包费'
      merge = {
        kind: 'merge',
        batchIndex: pair.batchIndex,
        keyA: row.line.key,
        labelA: row.line.sizeLabel,
        looseA: pair.looseA,
        keyB: neighbor.line.key,
        labelB: neighbor.line.sizeLabel,
        looseB: pair.looseB,
        perCarton: pair.perCarton,
        addedPieces,
        pieceCost,
        mixedFee: settings.mixedCartonFee,
        totalCost,
        feasible: true,
        reason
      }
    }

    // —— 调法二：把收尾批这一档整体挪到下一批 ——
    let shift: ShiftOption | null = null
    if (end < n - 1) {
      const to = end + 1
      const qtyMoved = row.cells[end]
      const targetCurrent = row.cells[to]
      const targetIsLast = to === n - 1
      const addedPieces = targetIsLast ? 0 : topUpToFullBox(targetCurrent + qtyMoved, row.moq, row.perCarton)
      const pieceCost = addedPieces * settings.piecePrice
      const delayCost = qtyMoved * settings.delayFeePerBatch
      // 目标批原本空着、而前面还有本号型的货：挪过去后中间空一批 → 断档
      const opensGap = targetCurrent === 0 && end > 0 && row.cells[end - 1] > 0
      const reasons: string[] = []
      if (targetIsLast) reasons.push('末批兜底，不要求整箱也不要求 MOQ，不用补件')
      else reasons.push(`目标批凑成整箱需多做 ${addedPieces} 件`)
      if (opensGap) reasons.push('会在相邻档之间断档（页面将提前标出）')
      reasons.push(`该档 ${qtyMoved} 件晚交一批`)
      shift = {
        kind: 'shift',
        key: row.line.key,
        label: row.line.sizeLabel,
        fromBatchIndex: end,
        toBatchIndex: to,
        qtyMoved,
        addedPieces,
        pieceCost,
        delayCost,
        totalCost: pieceCost + delayCost,
        opensGap,
        targetIsLast,
        feasible: true,
        reason: reasons.join('；')
      }
    }

    const partnerRow = partnerIndex !== undefined ? plan.rows[partnerIndex] : null
    const notes: string[] = []
    if (partnerRow) {
      notes.push(`本档零头已在搭档行「${partnerRow.line.sizeLabel}」的并箱方案里一并处理，无需重复并箱`)
    } else if (!merge) {
      notes.push(
        end === n - 1
          ? '零头已在末批，不能再往后挪，也没有相邻号型零头可并'
          : '同批没有箱规一致且装得下一箱的相邻号型零头可并，只能考虑挪档'
      )
    }
    if (!shift && end === n - 1) notes.push('末批无法再挪到下一批')

    let cheaper: 'merge' | 'shift' | null = null
    let waste = 0
    if (!partnerRow && merge?.feasible && shift?.feasible) {
      if (merge.totalCost < shift.totalCost) {
        cheaper = 'merge'
        waste = shift.totalCost - merge.totalCost
      } else if (shift.totalCost < merge.totalCost) {
        cheaper = 'shift'
        waste = merge.totalCost - shift.totalCost
      }
    }

    groups.push({
      batchIndex: end,
      key: row.line.key,
      label: row.line.sizeLabel,
      loose: row.remainder,
      merge,
      pairedBy: partnerRow ? partnerRow.line.key : null,
      shift,
      cheaper,
      waste,
      note: notes.join('；')
    })
  })

  // 最难看的批在前，批内按号型表顺序
  groups.sort((a, b) => a.batchIndex - b.batchIndex || plan.rows.findIndex((r) => r.line.key === a.key) - plan.rows.findIndex((r) => r.line.key === b.key))
  return groups
}

/* ------------------------------- 文案与导出 ------------------------------- */

export function genderText(gender: Gender): string {
  return gender === 'male' ? '男' : '女'
}

export type DeliverySheetContext = {
  projectName: string
  operator: string
  generatedAt: Date
  settings: DeliverySettings
}

function dateTimeText(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 交给工厂的清单（CSV 单表 / 打印 / Excel 第一张表共用，保证逐行一致） */
export function deliverySheetRows(plan: DeliveryPlan, ctx: DeliverySheetContext): (string | number)[][] {
  const s = normalizeSettings(ctx.settings)
  const rows: (string | number)[][] = []
  rows.push(['服装分批交货清单'])
  rows.push(['项目名称', ctx.projectName])
  rows.push(['约定批次数', s.batchCount])
  rows.push(['最小起订量（件/号型·批）', s.minQty])
  rows.push(['每箱件数', s.perCarton])
  rows.push(['排法', s.align === 'end' ? '靠后排（零头集中末批）' : '靠前排'])
  rows.push(['制表人', ctx.operator])
  rows.push(['生成时间', dateTimeText(ctx.generatedAt)])
  rows.push(['守恒校验', plan.conserved ? `通过：各号型各批之和 = 下单总量 ${plan.totalQty} 件` : '不通过：各批合计与下单总量不一致，禁止交付'])
  rows.push([])
  rows.push(['批次', '交货时间', '序号', '号型', '性别', '类型', '数量(件)', '整箱(箱)', '零头(件)', '本号型本批箱数'])

  plan.batches.forEach((batch) => {
    let indexInBatch = 0
    plan.rows.forEach((row) => {
      const info = row.cellInfo[batch.index]
      if (info.qty <= 0) return
      indexInBatch += 1
      rows.push([
        `第${batch.index + 1}批`,
        batch.date || '—',
        indexInBatch,
        row.line.sizeLabel,
        genderText(row.line.gender),
        row.line.kind,
        info.qty,
        info.fullCartons,
        info.loose,
        info.cartons
      ])
    })
    rows.push([`第${batch.index + 1}批 小计`, batch.date || '', '', '', '', '', batch.qty, batch.fullCartons, batch.loose, batch.cartons])
  })

  rows.push(['总计', '', '', '', '', '', plan.totalQty, plan.batches.reduce((sum, b) => sum + b.fullCartons, 0), plan.totalLoose, plan.totalCartons])
  rows.push([])

  if (plan.ugly) {
    const where = plan.ugly.isLast ? '末批（约定内的零头集中批）' : `第${plan.ugly.batchIndex + 1}批`
    rows.push(['零头说明', `零头最集中：${where}，零头合计 ${plan.ugly.loose} 件、涉及 ${plan.ugly.looseKinds} 个号型`])
  }
  if (plan.gaps.length > 0) {
    const text = plan.gaps.map((gap) => `${gap.sizeLabel} 第${gap.batchIndex + 1}批断档`).join('；')
    rows.push(['断档提示', text])
  }
  const below = plan.rows.filter((row) => row.problems.some((p) => p.code === 'below_moq_total'))
  if (below.length > 0) {
    rows.push(['未达起订量', below.map((row) => `${row.line.sizeLabel} 仅 ${row.line.qty} 件（MOQ ${row.moq}）`).join('；')])
  }
  return rows
}

/** 第二张表：两种调法各自的代价对照（页面分析区同源） */
export function adjustmentSheetRows(plan: DeliveryPlan, settings: DeliverySettings): (string | number)[][] {
  const groups = buildAdjustmentGroups(plan, normalizeSettings(settings))
  const rows: (string | number)[][] = [
    ['零头所在批', '号型', '零头(件)', '调法', '具体做法', '多做件数', '补件金额(元)', '其他费用(元)', '合计代价(元)', '结论']
  ]
  for (const group of groups) {
    if (group.merge) {
      const m = group.merge
      rows.push([
        `第${group.batchIndex + 1}批`,
        group.label,
        group.loose,
        '相邻号型并箱',
        m.feasible ? `${m.labelA}(${m.looseA}) + ${m.labelB}(${m.looseB}) 并成一箱` : m.reason,
        m.feasible ? m.addedPieces : '—',
        m.feasible ? m.pieceCost : '—',
        m.feasible ? m.mixedFee : '—',
        m.feasible ? m.totalCost : '不可行',
        m.feasible ? m.reason : '不可行'
      ])
    }
    if (group.shift) {
      const sh = group.shift
      rows.push([
        `第${group.batchIndex + 1}批`,
        group.label,
        group.loose,
        '整档挪到下一批',
        `第${sh.fromBatchIndex + 1}批 ${sh.qtyMoved} 件挪到第${sh.toBatchIndex + 1}批；${sh.reason}`,
        sh.addedPieces,
        sh.pieceCost,
        sh.delayCost,
        sh.totalCost,
        sh.opensGap ? '会断档' : '不断档'
      ])
    }
    if (group.cheaper && group.waste > 0) {
      const worse = group.cheaper === 'merge' ? '挪档' : '并箱'
      rows.push([
        `第${group.batchIndex + 1}批`,
        group.label,
        group.loose,
        '对照结论',
        `${worse}更不划算，比${group.cheaper === 'merge' ? '并箱' : '挪档'}多花 ${group.waste} 元`,
        '',
        '',
        '',
        '',
        ''
      ])
    }
    if (!group.merge && !group.shift) {
      rows.push([`第${group.batchIndex + 1}批`, group.label, group.loose, '无可调法', group.note, '', '', '', '', ''])
    }
  }
  return rows
}
