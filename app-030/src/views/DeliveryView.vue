<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, store } from '../logic/store'
import { buildSummary } from '../logic/merge'
import { summaryRowLabel } from '../logic/exporter'
import {
  adjustmentSheetRows,
  buildAdjustmentGroups,
  buildDeliveryPlan,
  deliverySheetRows,
  normalizeSettings,
  resizeDates,
  type DeliveryLineInput,
  type DeliverySettings
} from '../logic/delivery'
import { loadDeliveryDoc, reconcileDoc, saveDeliveryDoc, type DeliveryDoc } from '../logic/deliveryStore'
import { downloadBlob, downloadText, toCsvText, todayStamp } from '../logic/csv'
import { buildXlsxBlob, type Sheet } from '../logic/xlsx'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => (project.value ? getRule(project.value.ruleVersion) : undefined))

if (project.value) ensureMerged(project.value)

const doc = ref<DeliveryDoc | null>(null)
const loading = ref(true)
const notice = ref('')
const dirty = ref(false)

/* ---------------- 下单行（来自守恒通过的汇总表，特殊单列不进分批） ---------------- */

const summarySnapshot = computed(() => {
  const current = project.value
  const sizeRule = rule.value
  if (!current || !sizeRule) return null
  return buildSummary(current, sizeRule)
})

const conserved = computed(() => summarySnapshot.value?.conserved ?? false)

const lines = computed<DeliveryLineInput[]>(() => {
  const summary = summarySnapshot.value
  const sizeRule = rule.value
  if (!summary || !sizeRule) return []
  return summary.regularRows.map((row) => ({
    key: `R|${row.sizeCode}|${row.gender}`,
    sizeLabel: summaryRowLabel(sizeRule, row),
    gender: row.gender,
    kind: '常规档',
    qty: row.qty
  }))
})

const specialQty = computed(() => summarySnapshot.value?.totals.specialQty ?? 0)

const settings = computed<DeliverySettings>(() => doc.value?.settings ?? normalizeSettings({} as DeliverySettings))

const plan = computed(() =>
  doc.value ? buildDeliveryPlan(lines.value, doc.value.settings, doc.value.overrides, doc.value.lineParams) : null
)

const adjustmentGroups = computed(() => (plan.value && doc.value ? buildAdjustmentGroups(plan.value, doc.value.settings) : []))

/* --------------------------------- 持久化 --------------------------------- */

let saveTimer: number | null = null
function scheduleSave(): void {
  dirty.value = true
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void persist(true)
  }, 350)
}

async function persist(quiet = false): Promise<void> {
  if (!doc.value) return
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  await saveDeliveryDoc(doc.value)
  dirty.value = false
  if (!quiet) notice.value = `已存到本机（${new Date().toLocaleTimeString('zh-CN')}）`
}

onMounted(async () => {
  const current = project.value
  if (current) {
    const loaded = await loadDeliveryDoc(current.id)
    doc.value = reactive(loaded)
    const dropped = reconcileDoc(doc.value, lines.value)
    lastLineSignature = lineSignature()
    if (dropped.length > 0) {
      notice.value = `下单数量或批次数变了，${dropped.length} 个号型原来的手工拆分已自动作废并重新拆分`
    }
    await saveDeliveryDoc(doc.value)
  }
  loading.value = false
})

onBeforeUnmount(() => {
  if (doc.value && dirty.value) void saveDeliveryDoc(doc.value)
})

/* 下单数量变化（在量体/导入/归并页改了数据）：手工拆分对不上就重拆 */
let lastLineSignature = ''
function lineSignature(): string {
  return lines.value.map((line) => `${line.key}:${line.qty}`).join(',')
}
function syncAfterOrderChange(): void {
  if (!doc.value) return
  const signature = lineSignature()
  if (signature !== lastLineSignature) {
    const dropped = reconcileDoc(doc.value, lines.value)
    lastLineSignature = signature
    if (dropped.length > 0) {
      notice.value = `下单数量已改，${dropped.length} 个号型重新自动拆分（其余手工拆分不变）`
    }
    scheduleSave()
  }
}
watch(lines, syncAfterOrderChange, { flush: 'post' })

/* --------------------------------- 编辑操作 --------------------------------- */

function updateBatchCount(value: number): void {
  if (!doc.value) return
  const count = Math.min(20, Math.max(1, Math.trunc(value) || 1))
  doc.value.settings.batchCount = count
  doc.value.settings.dates = resizeDates(doc.value.settings.dates, count)
  const dropped = reconcileDoc(doc.value, lines.value)
  notice.value = dropped.length > 0 ? `批次数变为 ${count}，${dropped.length} 个号型重新自动拆分` : `批次数已调整为 ${count}`
  scheduleSave()
}

function onSettingsInput(): void {
  if (!doc.value) return
  doc.value.settings = normalizeSettings(doc.value.settings)
  scheduleSave()
}

function setAlign(align: 'end' | 'start'): void {
  if (!doc.value) return
  doc.value.settings.align = align
  // 改排法后所有自动行重算；手工行保持手工（用户明确编辑过）
  scheduleSave()
}

function setCell(rowKey: string, batchIndex: number, raw: number): void {
  if (!doc.value) return
  const value = Math.max(0, Math.trunc(Number.isFinite(raw) ? raw : 0))
  const line = lines.value.find((item) => item.key === rowKey)
  if (!line) return
  const n = doc.value.settings.batchCount
  const current = doc.value.overrides[rowKey]
  const base = current ? [...current] : (plan.value?.rows.find((row) => row.line.key === rowKey)?.cells ?? [])
  const next = Array.from({ length: n }, (_v, index) => base[index] ?? 0)
  next[batchIndex] = value
  doc.value.overrides[rowKey] = next
  scheduleSave()
}

function resetRow(rowKey: string): void {
  if (!doc.value) return
  doc.value.overrides[rowKey] = null
  scheduleSave()
}

function autoSplitAll(): void {
  if (!doc.value) return
  doc.value.overrides = {}
  notice.value = '全部恢复为自动拆分（纯整数、零头按排法集中）'
  scheduleSave()
}

/* 每行的问题与断档格（页面提前标出） */
const gapCellKeys = computed(() => {
  const set = new Set<string>()
  for (const gap of plan.value?.gaps ?? []) set.add(`${gap.key}@${gap.batchIndex}`)
  return set
})

const problemRows = computed(() =>
  (plan.value?.rows ?? [])
    .filter((row) => row.problems.length > 0)
    .map((row) => ({ key: row.line.key, label: row.line.sizeLabel, messages: row.problems.map((p) => p.message) }))
)

const splitSummary = computed(() => {
  const rows = plan.value?.rows ?? []
  const multi = rows.filter((row) => row.spanCount > 1)
  return multi
    .sort((a, b) => b.spanCount - a.spanCount)
    .map((row) => `${row.line.sizeLabel} 拆到 ${row.spanCount} 批（第${row.spanBatches.map((b) => b + 1).join('、')}批）`)
})

const blocked = computed(() => (plan.value ? !plan.value.conserved || plan.value.blocking.length > 0 : true))

/* --------------------------------- 导出 --------------------------------- */

function safeProjectName(): string {
  return (project.value?.name ?? '项目').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
}

async function beforeExport(): Promise<boolean> {
  const current = project.value
  if (!current || !doc.value || !plan.value) return false
  await persist(true)
  await flushProject(current)
  return true
}

async function exportXlsx(): Promise<void> {
  if (blocked.value || !(await beforeExport()) || !plan.value || !doc.value) return
  const context = {
    projectName: project.value!.name,
    operator: store.operator,
    generatedAt: new Date(),
    settings: doc.value.settings
  }
  const sheets: Sheet[] = [
    { name: '分批交货清单', rows: deliverySheetRows(plan.value, context) },
    { name: '零头调法代价对照', rows: adjustmentSheetRows(plan.value, doc.value.settings) }
  ]
  const fileName = `${safeProjectName()}-分批交货清单-${todayStamp()}.xlsx`
  downloadBlob(buildXlsxBlob(sheets), fileName)
  notice.value = `已导出工厂清单（Excel，2 张表）→ ${fileName}`
}

async function exportCsv(): Promise<void> {
  if (blocked.value || !(await beforeExport()) || !plan.value || !doc.value) return
  const context = {
    projectName: project.value!.name,
    operator: store.operator,
    generatedAt: new Date(),
    settings: doc.value.settings
  }
  const fileName = `${safeProjectName()}-分批交货清单-${todayStamp()}.csv`
  downloadText(toCsvText(deliverySheetRows(plan.value, context)), fileName)
  notice.value = `已导出工厂清单（CSV）→ ${fileName}`
}

async function exportAdjustCsv(): Promise<void> {
  if (!(await beforeExport()) || !plan.value || !doc.value) return
  const fileName = `${safeProjectName()}-零头调法代价-${todayStamp()}.csv`
  downloadText(toCsvText(adjustmentSheetRows(plan.value, doc.value.settings)), fileName)
  notice.value = `已导出两种调法代价对照（CSV）→ ${fileName}`
}

async function printSheet(): Promise<void> {
  if (blocked.value || !(await beforeExport())) return
  window.print()
}

const money = (value: number): string => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
</script>

<template>
  <section v-if="loading" class="empty">正在读取本机方案…</section>
  <section v-else-if="!project || !rule || !doc || !plan" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head no-print">
      <div>
        <h1>{{ project.name }} · 交货批次拆分与补量</h1>
        <div class="sub">
          约定 <b>{{ plan.batchCount }}</b> 批交货 ｜ 最小起订量
          <b>{{ settings.minQty }}</b> 件/号型·批 ｜ 每箱 <b>{{ settings.perCarton }}</b> 件
          ｜ 全部按整数凑箱，不做比例四舍五入
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/summary/${project.id}`">返回汇总</RouterLink>
        <RouterLink class="btn btn-sm btn-primary" :to="`/export/${project.id}`">去导出下单表</RouterLink>
      </div>
    </div>

    <p v-if="notice" class="notice notice-info no-print">{{ notice }}</p>

    <div v-if="!conserved" class="card card-accent-danger no-print">
      <div class="card-body tight">
        <p class="notice notice-error" style="margin-bottom: 6px">
          本项目守恒校验还没通过：有未归并行或汇总数与有效人数不一致。当前拆分只基于已归并的
          <b>{{ plan.totalQty }}</b> 件常规档，数量可能不全，补量/代价测算仅供参考，处理完归并后再回来核对。
        </p>
        <RouterLink class="btn btn-sm btn-danger" :to="`/merge/${project.id}`">去归并页处理未归并行</RouterLink>
      </div>
    </div>

    <!-- 参数约定 -->
    <div class="card no-print">
      <div class="card-head">
        <h2>与厂方约定的交货参数</h2>
        <div class="spacer"></div>
        <span class="badge" :class="dirty ? 'badge-warn' : 'badge-ok'">{{ dirty ? '改动待落盘' : '已存在本机' }}</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">约定批次数</span>
            <input
              class="input"
              type="number"
              min="1"
              max="20"
              step="1"
              :value="settings.batchCount"
              @change="updateBatchCount(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <label class="field">
            <span class="field-label">最小起订量 MOQ（件/号型·批）</span>
            <input class="input" type="number" min="1" step="1" v-model.number="doc.settings.minQty" @change="onSettingsInput" />
          </label>
          <label class="field">
            <span class="field-label">每箱件数（件/箱）</span>
            <input class="input" type="number" min="1" step="1" v-model.number="doc.settings.perCarton" @change="onSettingsInput" />
          </label>
          <div class="field">
            <span class="field-label">排法（零头落点）</span>
            <div class="gender-switch" style="grid-template-columns: 1fr 1fr">
              <button type="button" class="btn btn-sm" :class="settings.align === 'end' ? 'btn-primary' : ''" @click="setAlign('end')">
                靠后排（零头集中末批）
              </button>
              <button type="button" class="btn btn-sm" :class="settings.align === 'start' ? 'btn-primary' : ''" @click="setAlign('start')">
                靠前排
              </button>
            </div>
          </div>
        </div>
        <div class="form-grid" style="margin-top: 10px">
          <label class="field" v-for="index in doc.settings.dates.length" :key="index - 1">
            <span class="field-label">第{{ index }}批交货时间</span>
            <input class="input" type="date" v-model="doc.settings.dates[index - 1]" @change="scheduleSave" />
          </label>
        </div>

        <h4 style="margin: 14px 0 6px">两种调法的代价口径（只影响「多花多少」的测算，不改变拆分规则）</h4>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">混装打包加价（元/并箱）</span>
            <input class="input" type="number" min="0" step="0.01" v-model.number="doc.settings.mixedCartonFee" @change="onSettingsInput" />
          </label>
          <label class="field">
            <span class="field-label">晚交一批加价（元/件）</span>
            <input class="input" type="number" min="0" step="0.01" v-model.number="doc.settings.delayFeePerBatch" @change="onSettingsInput" />
          </label>
          <label class="field">
            <span class="field-label">单件单价（元/件，补量多做时计价）</span>
            <input class="input" type="number" min="0" step="0.01" v-model.number="doc.settings.piecePrice" @change="onSettingsInput" />
          </label>
          <label class="field">
            <span class="field-label">并箱时补满整箱</span>
            <select class="select" v-model="doc.settings.fillMixed" @change="onSettingsInput">
              <option :value="true">补满（多做的件算进代价）</option>
              <option :value="false">不补（按实际零头混装，只付打包费）</option>
            </select>
          </label>
        </div>
      </div>
    </div>

    <!-- 总览与守恒 -->
    <div class="card" :class="plan.conserved && !blocked ? 'card-accent-ok' : 'card-accent-danger'">
      <div class="card-head">
        <h2>拆分总览与守恒</h2>
        <div class="spacer"></div>
        <span class="badge" :class="plan.conserved && !blocked ? 'badge-ok' : 'badge-danger'">
          {{ plan.conserved && !blocked ? '守恒通过：可交工厂' : '有阻塞项：不能导出工厂清单' }}
        </span>
      </div>
      <div class="card-body">
        <div class="equation" :class="plan.conserved && !blocked ? 'equation-ok' : 'equation-bad'">
          下单总量 {{ plan.totalQty }} 件 ＝ 各批合计
          <span v-for="(batch, index) in plan.batches" :key="batch.index">
            {{ index === 0 ? '' : '＋' }} 第{{ index + 1 }}批 {{ batch.qty }}
          </span>
        </div>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><div class="stat-label">号型档数</div><div class="stat-value">{{ plan.rows.length }}</div></div>
          <div class="stat"><div class="stat-label">拆到多批的号型</div><div class="stat-value">{{ plan.rows.filter((r) => r.spanCount > 1).length }}</div></div>
          <div class="stat"><div class="stat-label">总箱数（含零头箱）</div><div class="stat-value">{{ plan.totalCartons }}</div></div>
          <div class="stat"><div class="stat-label">零头合计</div><div class="stat-value">{{ plan.totalLoose }} 件</div></div>
          <div class="stat"><div class="stat-label">断档格</div><div class="stat-value" :class="plan.gaps.length ? 'bad' : 'ok'">{{ plan.gaps.length }}</div></div>
        </div>
        <p v-if="specialQty > 0" class="hint" style="margin-top: 8px">
          另有特殊单列 {{ specialQty }} 套按单独约定交货，不参与整箱/MOQ 拆分。
        </p>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn btn-sm" type="button" @click="autoSplitAll">全部恢复自动拆分</button>
          <button class="btn btn-sm" type="button" @click="persist(false)">立即存到本机</button>
          <span class="hint">改了数量或参数会自动保存；直接改表格里的数字即为手工拆分，档尾按钮可恢复自动。</span>
        </div>
      </div>
    </div>

    <!-- 断档预警（提前标在页面上） -->
    <div v-if="plan.gaps.length > 0" class="card card-accent-warn">
      <div class="card-head">
        <h2>断档预警：号型在相邻交货批之间断档</h2>
        <div class="spacer"></div>
        <span class="badge badge-warn">{{ plan.gaps.length }} 处</span>
      </div>
      <div class="card-body tight">
        <div class="pill-list">
          <span v-for="(gap, index) in plan.gaps" :key="`${gap.key}-${gap.batchIndex}-${index}`" class="badge badge-warn">
            {{ gap.sizeLabel }}：第{{ gap.batchIndex }}批有货 → 第{{ gap.batchIndex + 1 }}批断档 → 第{{ gap.batchIndex + 2 }}批又有货
          </span>
        </div>
        <p class="hint" style="margin-top: 8px">断档格在下方矩阵中以斜纹底标出，交厂前需确认厂方排产能接受。</p>
      </div>
    </div>

    <!-- 阻塞项 -->
    <div v-if="plan.blocking.length > 0" class="card card-accent-danger no-print">
      <div class="card-head">
        <h2>必须先处理（{{ plan.blocking.length }} 项）</h2>
      </div>
      <div class="card-body tight">
        <ul style="margin: 0; padding-left: 18px">
          <li v-for="(problem, index) in plan.blocking" :key="index" style="margin-bottom: 4px">{{ problem.message }}</li>
        </ul>
      </div>
    </div>

    <!-- 拆分矩阵 -->
    <div class="card">
      <div class="card-head">
        <h2>分批数量矩阵（件）</h2>
        <div class="spacer"></div>
        <span class="badge badge-info">非收尾批必须整箱，每格非零即 ≥ MOQ</span>
        <button class="btn btn-sm no-print" type="button" @click="autoSplitAll">重算自动拆分</button>
      </div>
      <div class="table-wrap">
        <table class="data-table delivery-matrix">
          <thead>
            <tr>
              <th>号型</th>
              <th>性别</th>
              <th class="num">下单</th>
              <th class="num">拆几批</th>
              <th v-for="batch in plan.batches" :key="batch.index" class="num">
                第{{ batch.index + 1 }}批<span class="batch-date">{{ batch.date || '' }}</span>
              </th>
              <th class="num no-print">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in plan.rows" :key="row.line.key" :class="{ 'row-invalid': row.problems.length > 0 }">
              <td><b>{{ row.line.sizeLabel }}</b><div class="hint">MOQ {{ row.moq }} / 每箱 {{ row.perCarton }}</div></td>
              <td>{{ row.line.gender === 'male' ? '男' : '女' }}</td>
              <td class="num">{{ row.line.qty }}</td>
              <td class="num">
                <span class="badge" :class="row.spanCount > 1 ? 'badge-info' : ''">{{ row.spanCount }}</span>
                <span v-if="row.manual" class="badge badge-warn">手工</span>
              </td>
              <td
                v-for="(info, batchIndex) in row.cellInfo"
                :key="batchIndex"
                class="num cell-edit"
                :class="{ 'cell-gap': gapCellKeys.has(`${row.line.key}@${batchIndex}`), 'cell-loose': info.loose > 0 }"
              >
                <input
                  class="cell-input no-print"
                  type="number"
                  min="0"
                  step="1"
                  :value="info.qty"
                  @change="setCell(row.line.key, batchIndex, Number(($event.target as HTMLInputElement).value))"
                />
                <span class="print-only">
                  {{ info.qty }}<span v-if="info.loose > 0" class="loose-mark">（零{{ info.loose }}）</span>
                </span>
                <div class="cell-sub no-print">
                  <span v-if="info.qty > 0">{{ info.fullCartons }}箱<span v-if="info.loose > 0">+{{ info.loose }}零</span></span>
                </div>
              </td>
              <td class="no-print">
                <button class="btn btn-sm" type="button" :disabled="!row.manual" @click="resetRow(row.line.key)">自动</button>
              </td>
            </tr>
            <tr v-for="problem in problemRows" :key="`prob-${problem.key}`" class="row-invalid problem-row no-print">
              <td colspan="4" class="problem-text">{{ problem.label }}</td>
              <td :colspan="plan.batchCount + 1" class="problem-text">
                <span v-for="(message, index) in problem.messages" :key="index">⚠️ {{ message }}　</span>
              </td>
              <td></td>
            </tr>
            <tr class="row-subtotal">
              <td colspan="4">批次合计</td>
              <td v-for="batch in plan.batches" :key="batch.index" class="num">
                {{ batch.qty }}<div class="hint">{{ batch.cartons }}箱 · 零{{ batch.loose }}</div>
              </td>
              <td class="no-print"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 拆分说明：哪个号型拆到几批 + 哪批零头最难看 -->
    <div class="card no-print">
      <div class="card-head">
        <h2>分不匀时的说明</h2>
      </div>
      <div class="card-body tight">
        <h4>被拆到多批的号型</h4>
        <p v-if="splitSummary.length === 0" class="hint">所有号型都能在一批内交完，没有跨批拆分。</p>
        <div v-else class="pill-list" style="margin: 6px 0 10px">
          <span v-for="(text, index) in splitSummary" :key="index" class="badge badge-info">{{ text }}</span>
        </div>
        <h4>零头最难看的一批</h4>
        <p v-if="!plan.ugly" class="hint">全部凑成整箱，没有零头。</p>
        <div v-else class="notice" :class="plan.ugly.isLast ? 'notice-ok' : 'notice-warn'">
          零头集中在<b>第{{ plan.ugly.batchIndex + 1 }}批{{ plan.ugly.batchIndex === plan.batchCount - 1 ? '（末批）' : '' }}</b>：零头合计
          <b>{{ plan.ugly.loose }}</b> 件、涉及 <b>{{ plan.ugly.looseKinds }}</b> 个号型。
          <span v-if="plan.ugly.isLast">末批按约定兜底收零头，属正常集中。</span>
          <span v-else>零头不在末批，要么与相邻号型并箱，要么挪到下一批，代价见下表。</span>
        </div>
      </div>
    </div>

    <!-- 两种调法的代价对照 -->
    <div class="card no-print">
      <div class="card-head">
        <h2>零头处理：两种调法各自的代价（谁更不划算）</h2>
        <div class="spacer"></div>
        <button class="btn btn-sm" type="button" @click="exportAdjustCsv">导出代价对照 CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>零头所在批</th>
              <th>号型</th>
              <th class="num">零头</th>
              <th>调法一：相邻号型并成一箱</th>
              <th class="num">并箱代价</th>
              <th>调法二：整档挪到下一批</th>
              <th class="num">挪档代价</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(group, index) in adjustmentGroups" :key="`${group.key}-${group.batchIndex}-${index}`">
              <td>第{{ group.batchIndex + 1 }}批</td>
              <td><b>{{ group.label }}</b></td>
              <td class="num">{{ group.loose }}</td>
              <td>
                <template v-if="group.merge">
                  <div>{{ group.merge.labelA }}（{{ group.merge.looseA }}）＋{{ group.merge.labelB }}（{{ group.merge.looseB }}）</div>
                  <div class="hint">{{ group.merge.reason }}</div>
                </template>
                <span v-else-if="group.pairedBy" class="hint">{{ group.note }}</span>
                <span v-else class="hint">{{ group.note || '同批没有箱规一致且装得下一箱的相邻号型零头可并' }}</span>
              </td>
              <td class="num">
                <span v-if="group.merge">{{ money(group.merge.totalCost) }} 元</span>
                <span v-else>—</span>
              </td>
              <td>
                <template v-if="group.shift">
                  <div>{{ group.shift.qtyMoved }} 件：第{{ group.shift.fromBatchIndex + 1 }}批 → 第{{ group.shift.toBatchIndex + 1 }}批</div>
                  <div class="hint">{{ group.shift.reason }}</div>
                </template>
                <span v-else class="hint">已经是末批，没有下一批可挪</span>
              </td>
              <td class="num">
                <span v-if="group.shift">{{ money(group.shift.totalCost) }} 元</span>
                <span v-else>—</span>
              </td>
              <td>
                <span v-if="group.cheaper" class="badge" :class="group.cheaper === 'merge' ? 'badge-ok' : 'badge-ok'">
                  {{ group.cheaper === 'merge' ? '并箱' : '挪档' }}更省
                </span>
                <span v-if="group.waste > 0" class="badge badge-danger">
                  {{ group.cheaper === 'merge' ? '挪档' : '并箱' }}多花 {{ money(group.waste) }} 元，更不划算
                </span>
                <span v-if="!group.cheaper && group.merge?.feasible && group.shift && group.merge.totalCost === group.shift.totalCost" class="badge">
                  两种调法代价相同
                </span>
              </td>
            </tr>
            <tr v-if="adjustmentGroups.length === 0">
              <td colspan="8">没有零头，不需要调。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 导出 -->
    <div class="card no-print">
      <div class="card-head">
        <h2>导出交给工厂的清单</h2>
        <div class="spacer"></div>
        <span class="badge" :class="blocked ? 'badge-danger' : 'badge-ok'">{{ blocked ? '存在阻塞项，导出已锁定' : '可以导出' }}</span>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <button class="btn btn-primary" type="button" :disabled="blocked" @click="exportXlsx">工厂清单（Excel）</button>
          <button class="btn" type="button" :disabled="blocked" @click="exportCsv">工厂清单（CSV）</button>
          <button class="btn btn-accent" type="button" :disabled="blocked" @click="printSheet">打印 / 另存 PDF</button>
        </div>
        <p v-if="blocked" class="notice notice-error" style="margin-top: 10px">
          有号型不足 MOQ 或手工各批合计不等于下单量——先在矩阵里改齐（每档合计必须正好等于下单数，一件不多一件不少），再导出。
        </p>
        <p v-else class="hint" style="margin-top: 8px">清单按「批次 → 号型」逐行列数量、整箱、零头与箱数，含守恒校验、断档与未达起订量说明。</p>
      </div>
    </div>

    <!-- 打印页 -->
    <div class="card">
      <div class="card-head no-print"><h3>打印预览（与导出的工厂清单逐行一致）</h3></div>
      <div class="card-body">
        <div class="print-sheet">
          <h2>分批交货清单</h2>
          <div class="print-sub">
            项目：{{ project.name }} ｜ 约定批次：{{ plan.batchCount }} ｜ MOQ：{{ settings.minQty }} 件 ｜ 每箱：{{ settings.perCarton }} 件
            ｜ 打印时间：{{ new Date().toLocaleString('zh-CN') }}
          </div>
          <div class="print-meta">
            <div>制表：{{ store.operator || '—' }}</div>
            <div>守恒：各号型各批合计 ＝ 下单总量 {{ plan.totalQty }} 件</div>
          </div>
          <table v-for="batch in plan.batches" :key="batch.index" style="margin-bottom: 10px">
            <thead>
              <tr>
                <th colspan="7">第{{ batch.index + 1 }}批 ｜ 交货时间：{{ batch.date || '待厂方确认' }} ｜ 合计 {{ batch.qty }} 件 / {{ batch.cartons }} 箱 / 零头 {{ batch.loose }} 件</th>
              </tr>
              <tr>
                <th style="width: 40px">序号</th>
                <th>号型</th>
                <th style="width: 48px">性别</th>
                <th style="width: 70px">数量</th>
                <th style="width: 70px">整箱</th>
                <th style="width: 70px">零头</th>
                <th style="width: 70px">箱数</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, rowIndex) in plan.rows.filter((r) => r.cellInfo[batch.index].qty > 0)" :key="row.line.key">
                <tr>
                  <td>{{ rowIndex + 1 }}</td>
                  <td>{{ row.line.sizeLabel }}</td>
                  <td>{{ row.line.gender === 'male' ? '男' : '女' }}</td>
                  <td class="num">{{ row.cellInfo[batch.index].qty }}</td>
                  <td class="num">{{ row.cellInfo[batch.index].fullCartons }}</td>
                  <td class="num">{{ row.cellInfo[batch.index].loose }}</td>
                  <td class="num">{{ row.cellInfo[batch.index].cartons }}</td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="plan.gaps.length > 0" class="hint">断档：{{ plan.gaps.map((g) => `${g.sizeLabel}第${g.batchIndex + 1}批`).join('；') }}</div>
          <div class="print-sign">
            <span>制表：{{ store.operator || '—' }}</span>
            <span>厂方确认：________________</span>
            <span>日期：{{ new Date().toLocaleDateString('zh-CN') }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.delivery-matrix th,
.delivery-matrix td {
  min-width: 86px;
}
.batch-date {
  display: block;
  font-weight: 400;
  color: var(--ink-soft);
  font-size: 10.5px;
}
.cell-edit {
  padding: 4px 6px;
}
.cell-input {
  width: 64px;
  text-align: right;
  font-family: var(--mono);
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  font-size: 13px;
}
.cell-input:hover {
  border-color: var(--line);
}
.cell-input:focus {
  outline: none;
  border-color: var(--brand);
  background: #fff;
}
.cell-sub {
  font-size: 10.5px;
  color: var(--ink-soft);
  font-family: var(--mono);
}
.cell-loose {
  background: #fff8ec;
}
.cell-gap {
  background-image: repeating-linear-gradient(45deg, rgba(179, 38, 30, 0.12) 0 5px, transparent 5px 10px);
}
.cell-gap.cell-loose {
  background-image: repeating-linear-gradient(45deg, rgba(179, 38, 30, 0.12) 0 5px, rgba(255, 248, 236, 1) 5px 10px);
}
.problem-row td {
  font-size: 11.5px;
  color: var(--danger);
}
.problem-text {
  white-space: normal !important;
}
.loose-mark {
  color: var(--warn);
  font-size: 11px;
}
.print-only {
  display: none;
}
@media print {
  .no-print {
    display: none !important;
  }
  .print-only {
    display: table-cell !important;
  }
}
</style>
