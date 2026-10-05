<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, persistProject, store } from '../logic/store'
import { buildSummary } from '../logic/merge'
import {
  createDeliveryPlan,
  defaultBatchDates,
  deliveryDetailRows,
  deliveryLineLabel,
  deliveryMatrixRows,
  deliveryNotesRows,
  linesFromSummary,
  makeSizeKey,
  splitDelivery,
  toDateText,
  type DeliveryResult
} from '../logic/delivery'
import { downloadBlob, downloadText, toCsvText, todayStamp } from '../logic/csv'
import { buildXlsxBlob } from '../logic/xlsx'
import type { DeliveryBatchConfig } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

/** 首次进入时按下单汇总建立交货拆分约定；之后约定与数量都存在本机，改了数量自动重拆 */
if (project.value && summary.value && !project.value.delivery) {
  project.value.delivery = createDeliveryPlan(summary.value)
  persistProject(project.value)
}

const plan = computed(() => project.value?.delivery ?? null)

const labelMap = computed(() => {
  const map = new Map<string, string>()
  if (plan.value && rule.value) {
    for (const line of plan.value.lines) map.set(line.sizeKey, deliveryLineLabel(rule.value, line))
  }
  return map
})

function labelOf(sizeKey: string): string {
  return labelMap.value.get(sizeKey) ?? sizeKey
}

/** 拆分结果：数量 / 约定任何改动都会触发重新拆分（纯整数运算） */
const result = computed<DeliveryResult | null>(() => (plan.value ? splitDelivery(plan.value, labelOf) : null))

const message = ref('')

function notify(text: string): void {
  message.value = text
}

function touch(): void {
  const current = project.value
  if (!current?.delivery) return
  current.delivery.updatedAt = Date.now()
  persistProject(current)
}

function asInt(raw: string | number, min: number, fallback: number): number {
  const value = Math.floor(Number(raw))
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, value)
}

function updateMoq(raw: string | number): void {
  if (!plan.value) return
  plan.value.moq = asInt(raw, 1, plan.value.moq)
  touch()
}

function updateCartonSize(raw: string | number): void {
  if (!plan.value) return
  plan.value.cartonSize = asInt(raw, 1, plan.value.cartonSize)
  touch()
}

function updateBatchCount(raw: string | number): void {
  const current = plan.value
  if (!current) return
  const count = Math.min(12, asInt(raw, 1, current.batches.length))
  if (count === current.batches.length) return
  if (count < current.batches.length) {
    current.batches = current.batches.slice(0, count)
  } else {
    const lastDate = current.batches[current.batches.length - 1]?.date
    const parsed = lastDate ? new Date(`${lastDate}T00:00:00`) : null
    const base = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
    const extra = defaultBatchDates(count - current.batches.length, new Date(base.getTime() + 30 * 86400000))
    let index = current.batches.length
    for (const batch of extra) {
      index += 1
      current.batches.push({ index, date: batch.date })
    }
  }
  current.batches = current.batches.map((batch, i) => ({ ...batch, index: i + 1 }))
  touch()
}

function updateBatchDate(batch: DeliveryBatchConfig, raw: string): void {
  batch.date = raw
  touch()
}

function updateQty(sizeKey: string, raw: string | number): void {
  const line = plan.value?.lines.find((item) => item.sizeKey === sizeKey)
  if (!line) return
  line.qty = asInt(raw, 0, line.qty)
  touch()
}

/** 与下单汇总的差异（改了下单数量以后会提示，可一键按最新汇总重拆） */
const summaryDiff = computed(() => {
  const currentPlan = plan.value
  const snapshot = summary.value
  if (!currentPlan || !snapshot) return null
  const summaryMap = new Map(snapshot.allRows.map((row) => [makeSizeKey(row), row.qty]))
  let changed = 0
  let added = 0
  let removed = 0
  for (const line of currentPlan.lines) {
    const qty = summaryMap.get(line.sizeKey)
    if (qty === undefined) removed += 1
    else if (qty !== line.qty) changed += 1
  }
  for (const key of summaryMap.keys()) {
    if (!currentPlan.lines.some((line) => line.sizeKey === key)) added += 1
  }
  return changed + added + removed > 0 ? { changed, added, removed } : null
})

function syncFromSummary(): void {
  const current = project.value
  const snapshot = summary.value
  if (!current?.delivery || !snapshot) return
  current.delivery.lines = linesFromSummary(snapshot)
  touch()
  notify('已按最新下单汇总重拆（原手工改量已被覆盖）')
}

/* ------------------------------- 矩阵展示 ------------------------------- */

const cellMap = computed(() => {
  const map = new Map<string, { qty: number; cartons: number; remainder: number; belowMoq: boolean }>()
  if (result.value) {
    for (const cell of result.value.cells) map.set(`${cell.sizeKey}|${cell.batchIndex}`, cell)
  }
  return map
})

function cellOf(sizeKey: string, batchIndex: number) {
  return cellMap.value.get(`${sizeKey}|${batchIndex}`) ?? null
}

/** 断档区间内的空批：该号型前后都排了产，唯独这批空着 → 页面提前标出 */
function isGapCell(sizeKey: string, batchIndex: number): boolean {
  const info = result.value?.bySize.find((item) => item.line.sizeKey === sizeKey)
  if (!info) return false
  return info.gaps.some((gap) => batchIndex > gap.from && batchIndex < gap.to)
}

/** 矩阵只画有数量的行；下单数量编辑表保留全部行（改成 0 的行也要能改回来） */
const visibleSizes = computed(() => (result.value ? result.value.bySize.filter((info) => info.line.qty > 0) : []))
const editableSizes = computed(() => result.value?.bySize ?? [])

const gapNotes = computed(() => result.value?.adjustments.filter((note) => note.kind === 'gap') ?? [])
const moqNotes = computed(() => result.value?.adjustments.filter((note) => note.kind === 'moq') ?? [])

const conservationEquation = computed(() => {
  const current = result.value
  if (!current) return ''
  const parts = current.byBatch.map((batch) => `第${batch.index}批 ${batch.totalQty}`)
  return `${parts.join(' + ')} = 拆分合计 ${current.totalSplit} / 下单总量 ${current.totalOrder}`
})

/* ------------------------------- 导出 ------------------------------- */

const exportBlocked = computed(() => !result.value || !result.value.conserved || result.value.totalOrder === 0)

function exportName(suffix: string, ext: string): string {
  const safeName = (project.value?.name ?? '交货拆分').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  return `${safeName}-${suffix}-${todayStamp()}.${ext}`
}

async function exportXlsx(): Promise<void> {
  const current = project.value
  const currentPlan = plan.value
  const currentResult = result.value
  if (!current || !currentPlan || !currentResult || exportBlocked.value) return
  await flushProject(current)
  const meta: (string | number)[][] = [
    ['项目名称', current.name],
    ['约定', `最小起订量 ${currentPlan.moq} 件/档 · 每箱 ${currentPlan.cartonSize} 件 · 共 ${currentPlan.batches.length} 批`],
    ['守恒校验', `${conservationEquation.value} → ${currentResult.conserved ? '守恒' : '不守恒'}`],
    ['生成时间', new Date().toLocaleString('zh-CN')],
    ['制表', store.operator || '—'],
    []
  ]
  const fileName = exportName('交货批次清单', 'xlsx')
  downloadBlob(
    buildXlsxBlob([
      { name: '分批交货清单', rows: [...meta, ...deliveryMatrixRows(currentPlan, currentResult, labelOf)] },
      { name: '分批明细', rows: [...meta, ...deliveryDetailRows(currentPlan, currentResult, labelOf)] },
      { name: '调法说明', rows: deliveryNotesRows(currentResult, labelOf) }
    ]),
    fileName
  )
  notify(`已导出交货批次清单（Excel，3 个工作表）→ ${fileName}`)
}

async function exportCsv(): Promise<void> {
  const current = project.value
  const currentPlan = plan.value
  const currentResult = result.value
  if (!current || !currentPlan || !currentResult || exportBlocked.value) return
  await flushProject(current)
  const fileName = exportName('交货批次清单', 'csv')
  downloadText(toCsvText(deliveryMatrixRows(currentPlan, currentResult, labelOf)), fileName)
  notify(`已导出交货批次清单（CSV）→ ${fileName}`)
}

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')
const today = toDateText(new Date())
</script>

<template>
  <section v-if="!project || !summary || !plan || !result" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 交货批次拆分与补量</h1>
        <div class="sub">
          按约定的批次数与交货时间拆分下单数量 ｜ 凑箱只用整数整除与取余，不按比例四舍五入 ｜ 改数量后自动重拆并存本机
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/summary/${project.id}`">返回汇总</RouterLink>
        <RouterLink class="btn btn-sm" :to="`/export/${project.id}`">去导出下单表</RouterLink>
      </div>
    </div>

    <div v-if="summaryDiff" class="notice notice-warn">
      下单汇总与当前拆分数量不一致（{{ summaryDiff.changed }} 档数量变了、{{ summaryDiff.added }} 档新增、{{ summaryDiff.removed }} 档已不在汇总里）。
      若是改单，请直接在下方「下单数量」列改；若要按最新汇总重拆，
      <button class="btn btn-sm" type="button" @click="syncFromSummary">按汇总重新拆分</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>分批交货约定</h2>
        <div class="spacer"></div>
        <span class="badge badge-info">整数凑箱：整除 + 取余</span>
        <span class="badge">改动即重拆、自动存本机</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">最小起订量（件/号型/批）<span class="req">*</span></span>
            <input
              class="input"
              type="number"
              min="1"
              step="1"
              :value="plan.moq"
              @change="updateMoq(($event.target as HTMLInputElement).value)"
            />
            <span class="hint">每个号型在每一批要么不排、要么不少于这个数</span>
          </label>
          <label class="field">
            <span class="field-label">每箱件数（装箱固定）<span class="req">*</span></span>
            <input
              class="input"
              type="number"
              min="1"
              step="1"
              :value="plan.cartonSize"
              @change="updateCartonSize(($event.target as HTMLInputElement).value)"
            />
            <span class="hint">非末批只排整箱，凑不满一箱的零头集中到末批</span>
          </label>
          <label class="field">
            <span class="field-label">批次数<span class="req">*</span></span>
            <input
              class="input"
              type="number"
              min="1"
              max="12"
              step="1"
              :value="plan.batches.length"
              @change="updateBatchCount(($event.target as HTMLInputElement).value)"
            />
            <span class="hint">与服装厂约定的交货批次数（1–12）</span>
          </label>
        </div>
        <div class="batch-date-row">
          <label v-for="batch in plan.batches" :key="batch.index" class="field">
            <span class="field-label">第 {{ batch.index }} 批交货{{ batch.index === plan.batches.length ? '（末批·零头集中）' : '' }}</span>
            <input
              class="input"
              type="date"
              :value="batch.date"
              :min="today"
              @change="updateBatchDate(batch, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>
    </div>

    <div class="card" :class="result.conserved ? 'card-accent-ok' : 'card-accent-danger'">
      <div class="card-head">
        <h2>守恒校验（各批之和 = 下单总量，一档不能少）</h2>
        <div class="spacer"></div>
        <span class="badge" :class="result.conserved ? 'badge-ok' : 'badge-danger'">
          {{ result.conserved ? '守恒：可以导出清单' : '不守恒：禁止导出' }}
        </span>
      </div>
      <div class="card-body">
        <div class="equation" :class="result.conserved ? 'equation-ok' : 'equation-bad'">{{ conservationEquation }}</div>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><div class="stat-label">下单总量</div><div class="stat-value">{{ result.totalOrder }}</div></div>
          <div v-for="batch in result.byBatch" :key="batch.index" class="stat">
            <div class="stat-label">第 {{ batch.index }} 批（{{ batch.date || '日期待定' }}）</div>
            <div class="stat-value">{{ batch.totalQty }}</div>
            <div class="hint">整箱 {{ batch.cartons }} 箱<span v-if="batch.remainderPieces > 0"> ｜ 零头 {{ batch.remainderPieces }} 件</span></div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="result.gapCount > 0" class="card card-accent-warn">
      <div class="card-head">
        <h2>断档预警（{{ result.gapCount }} 处，交货前请先与厂里确认）</h2>
        <div class="spacer"></div>
        <span class="badge badge-warn">号型在相邻档期之间断档</span>
      </div>
      <div class="card-body tight">
        <p v-for="note in gapNotes" :key="note.title" class="notice notice-warn" style="margin-bottom: 6px">
          {{ note.title }}
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>下单数量（可改，改完自动重拆）</h2>
        <div class="spacer"></div>
        <span class="badge badge-info">{{ editableSizes.length }} 个号型档</span>
        <button class="btn btn-sm" type="button" @click="syncFromSummary">按汇总重新拆分</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>号型</th>
              <th>性别</th>
              <th>类型</th>
              <th class="num">下单数量（件）</th>
              <th class="num">拆到几批</th>
              <th>排产批</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="info in editableSizes" :key="info.line.sizeKey" :class="info.belowMoqTotal ? 'row-invalid' : ''">
              <td><b>{{ labelOf(info.line.sizeKey) }}</b></td>
              <td>{{ genderText(info.line.gender) }}</td>
              <td>
                <span class="badge" :class="info.line.isSpecial ? 'badge-warn' : 'badge-info'">
                  {{ info.line.isSpecial ? '特殊单列' : '常规档' }}
                </span>
              </td>
              <td class="num">
                <input
                  class="input qty-input"
                  type="number"
                  min="0"
                  step="1"
                  :value="info.line.qty"
                  @change="updateQty(info.line.sizeKey, ($event.target as HTMLInputElement).value)"
                />
              </td>
              <td class="num">
                <span v-if="info.line.qty > 0" class="badge" :class="info.batchCount >= 2 ? 'badge-info' : ''">{{ info.batchCount }} 批</span>
                <span v-else class="hint">不排产</span>
              </td>
              <td>
                <template v-if="info.line.qty > 0">
                  <span v-if="info.belowMoqTotal" class="badge badge-danger">整单不足起订量 {{ result.moq }} 件</span>
                  <span v-else>第 {{ info.batchesUsed.join('、') }} 批</span>
                  <span v-if="info.gaps.length > 0" class="badge badge-warn" style="margin-left: 4px">断档</span>
                </template>
                <span v-else class="hint">数量为 0，不下单</span>
              </td>
            </tr>
            <tr v-if="editableSizes.length === 0" class="row-subtotal">
              <td colspan="6">暂无下单数量，请先在「汇总与守恒」确认下单表，或点「按汇总重新拆分」</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>分批拆分矩阵（号型 × 批次）</h2>
        <div class="spacer"></div>
        <span class="badge">非末批只排整箱</span>
        <span class="badge badge-warn">末批（第 {{ result.batchCount }} 批）集中零头</span>
      </div>
      <div class="table-wrap">
        <table class="data-table delivery-matrix">
          <thead>
            <tr>
              <th>号型</th>
              <th class="num">下单合计</th>
              <th v-for="batch in plan.batches" :key="batch.index" class="num">
                第 {{ batch.index }} 批<br />
                <span class="hint">{{ batch.date || '日期待定' }}{{ batch.index === plan.batches.length ? ' · 末批' : '' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="info in visibleSizes" :key="info.line.sizeKey">
              <td>
                <b>{{ labelOf(info.line.sizeKey) }}</b>
                <span class="hint"> {{ genderText(info.line.gender) }}</span>
              </td>
              <td class="num"><b>{{ info.line.qty }}</b></td>
              <td
                v-for="batch in plan.batches"
                :key="batch.index"
                class="num"
                :class="{
                  'cell-moq-bad': cellOf(info.line.sizeKey, batch.index)?.belowMoq,
                  'cell-gap': isGapCell(info.line.sizeKey, batch.index),
                  'cell-remainder': (cellOf(info.line.sizeKey, batch.index)?.remainder ?? 0) > 0
                }"
              >
                <template v-if="cellOf(info.line.sizeKey, batch.index)">
                  <b>{{ cellOf(info.line.sizeKey, batch.index)?.qty }}</b>
                  <div class="hint">
                    {{ cellOf(info.line.sizeKey, batch.index)?.cartons }} 箱
                    <template v-if="(cellOf(info.line.sizeKey, batch.index)?.remainder ?? 0) > 0">
                      + 零 {{ cellOf(info.line.sizeKey, batch.index)?.remainder }}
                    </template>
                  </div>
                  <div v-if="cellOf(info.line.sizeKey, batch.index)?.belowMoq" class="hint" style="color: var(--danger)">
                    不足起订量
                  </div>
                </template>
                <span v-else-if="isGapCell(info.line.sizeKey, batch.index)" class="badge badge-warn">断档</span>
                <span v-else class="hint">—</span>
              </td>
            </tr>
            <tr class="row-subtotal">
              <td>各批合计</td>
              <td class="num">{{ result.totalOrder }}</td>
              <td v-for="batch in result.byBatch" :key="batch.index" class="num">
                {{ batch.totalQty }}
                <div class="hint">{{ batch.cartons }} 箱<span v-if="batch.remainderPieces > 0"> + 零 {{ batch.remainderPieces }}</span></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>拆分说明（分不匀的地方都在这里）</h2>
      </div>
      <div class="card-body tight">
        <h4>哪个号型被拆到了几批</h4>
        <div v-if="result.splitSizes.length === 0" class="hint">没有号型被拆到多批，全部整单一批交清。</div>
        <div v-else class="pill-list" style="margin-bottom: 10px">
          <span v-for="info in result.splitSizes" :key="info.line.sizeKey" class="badge badge-info">
            {{ labelOf(info.line.sizeKey) }}：拆到 {{ info.batchCount }} 批（第 {{ info.batchesUsed.join('、') }} 批）
          </span>
        </div>
        <p class="hint">其余 {{ visibleSizes.length - result.splitSizes.length }} 个号型整单一批交清。</p>

        <h4 style="margin-top: 10px">哪一批的零头最难看</h4>
        <p v-if="!result.ugliestBatch" class="hint">各批都没有零头，全是整箱。</p>
        <p v-else class="notice notice-warn">
          第 {{ result.ugliestBatch.index }} 批{{ result.ugliestBatch.index === result.batchCount ? '（末批）' : '' }}零头共
          <b>{{ result.ugliestBatch.remainderPieces }}</b> 件
          <template v-if="result.ugliestBatch.ugliest">
            ；最难看的是 <b>{{ labelOf(result.ugliestBatch.ugliest.sizeKey) }}</b>，只剩
            {{ result.ugliestBatch.ugliest.remainder }} 件（距满箱差 {{ result.ugliestBatch.ugliest.shortToFull }} 件）
          </template>
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>调法对比：并箱 / 挪档 / 补量，哪个更不划算</h2>
        <div class="spacer"></div>
        <span class="badge">三种调法都不改拆分守恒，代价写在一起</span>
      </div>
      <div class="card-body tight">
        <h4>末批零头：调法一「相邻号型零头并成一箱」 vs 调法二「各自补量凑整」</h4>
        <div v-if="result.mergePlan.remainderTotal === 0" class="hint">末批没有零头，两种调法都用不上。</div>
        <template v-else>
          <div class="table-wrap" style="margin-bottom: 8px">
            <table class="data-table">
              <thead>
                <tr>
                  <th>调法</th>
                  <th>做法</th>
                  <th class="num">多花件数</th>
                  <th>代价</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><b>并箱</b></td>
                  <td>
                    末批 {{ result.mergePlan.remainderTotal }} 件零头按相邻号型并成 {{ result.mergePlan.cartons.length }} 只箱
                    （凑满 {{ result.mergePlan.fullCount }} 只、混码 {{ result.mergePlan.mixedCount }} 只）
                    <div v-for="(carton, index) in result.mergePlan.cartons" :key="index" class="hint">
                      第 {{ index + 1 }} 箱 {{ carton.total }} 件{{ carton.total === result.cartonSize ? '（凑满）' : '（没凑满）' }}：
                      {{ carton.pieces.map((piece) => `${piece.label} ${piece.qty} 件`).join(' + ') }}
                    </div>
                  </td>
                  <td class="num">0</td>
                  <td>混码箱要厂里同意拼码、到货要分码；仍剩 {{ result.mergePlan.leftoverPieces }} 件凑不满一箱</td>
                </tr>
                <tr>
                  <td><b>补量</b></td>
                  <td>各号型零头分别补到整箱，箱子全整、不用拼码</td>
                  <td class="num">+{{ result.mergePlan.topUpExtra }}</td>
                  <td>下单总量多 {{ result.mergePlan.topUpExtra }} 件，多花这 {{ result.mergePlan.topUpExtra }} 件的钱</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="notice notice-info"><b>哪个更不划算：</b>{{ result.mergeVerdict }}</p>
        </template>

        <template v-if="gapNotes.length > 0">
          <h4 style="margin-top: 12px">断档：调法一「挪档」 vs 调法二「维持断档」</h4>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>断档位置</th>
                  <th>调法一（挪档）</th>
                  <th>调法二（维持）</th>
                  <th>哪个更不划算</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="note in gapNotes" :key="note.title">
                  <td>{{ note.title }}</td>
                  <td>{{ note.optionMove }}</td>
                  <td>{{ note.optionOther }}</td>
                  <td>{{ note.verdict }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-if="moqNotes.length > 0">
          <h4 style="margin-top: 12px">起订量不足：只能补量或协商</h4>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>号型</th>
                  <th>挪档</th>
                  <th>补量 / 协商</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="note in moqNotes" :key="note.title">
                  <td>{{ note.title }}</td>
                  <td>{{ note.optionMove }}</td>
                  <td>{{ note.optionOther }}</td>
                  <td>{{ note.verdict }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>导出交给工厂的清单</h2>
        <div class="spacer"></div>
        <span class="badge" :class="exportBlocked ? 'badge-danger' : 'badge-ok'">
          {{ exportBlocked ? '不守恒或数量为 0 · 已禁用' : '守恒通过 · 可导出' }}
        </span>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <button class="btn btn-primary" type="button" :disabled="exportBlocked" @click="exportXlsx">
            交货批次清单（Excel：清单 / 明细 / 调法说明）
          </button>
          <button class="btn" type="button" :disabled="exportBlocked" @click="exportCsv">交货批次清单（CSV）</button>
        </div>
        <p v-if="message" class="notice notice-ok" style="margin-top: 10px">{{ message }}</p>
        <p class="hint" style="margin-top: 8px">
          清单与上方矩阵逐行一致；约定与数量自动存在本机浏览器（IndexedDB），下次打开接着改、改完自动重拆。
        </p>
      </div>
    </div>
  </section>
</template>
