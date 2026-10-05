/**
 * 交货批次拆分方案的本机存取（IndexedDB · delivery 仓库，按项目 id 存）。
 * 改了下单数量或批次数后，页面调用 reconcile 自动放弃对不上的手工拆分，
 * 其余设置（MOQ、箱规、交货时间、调法单价）继续保留。
 */
import { STORE_DELIVERY, idbDelete, idbGet, idbPut } from './idb'
import {
  defaultDeliverySettings,
  normalizeSettings,
  reconcileOverrides,
  type DeliveryLineInput,
  type DeliveryLineParams,
  type DeliveryOverrides,
  type DeliverySettings
} from './delivery'

export type DeliveryDoc = {
  id: string
  settings: DeliverySettings
  /** 每个号型手工覆盖的每批件数（null = 用算法自动拆） */
  overrides: DeliveryOverrides
  /** 每号型可单独覆盖的 MOQ / 箱规（null = 跟随全局） */
  lineParams: DeliveryLineParams
  updatedAt: number
}

export function newDeliveryDoc(projectId: string): DeliveryDoc {
  const settings = defaultDeliverySettings()
  return { id: projectId, settings, overrides: {}, lineParams: {}, updatedAt: Date.now() }
}

export async function loadDeliveryDoc(projectId: string): Promise<DeliveryDoc> {
  const existing = await idbGet<DeliveryDoc>(STORE_DELIVERY, projectId)
  if (existing) {
    return { ...existing, settings: normalizeSettings(existing.settings) }
  }
  const doc = newDeliveryDoc(projectId)
  await idbPut(STORE_DELIVERY, doc)
  return doc
}

export async function saveDeliveryDoc(doc: DeliveryDoc): Promise<void> {
  doc.updatedAt = Date.now()
  await idbPut(STORE_DELIVERY, {
    ...doc,
    settings: normalizeSettings(doc.settings)
  })
}

export async function deleteDeliveryDoc(projectId: string): Promise<void> {
  await idbDelete(STORE_DELIVERY, projectId)
}

/**
 * 下单数量/批次数变动后调用：对不上的手工覆盖自动作废重拆，
 * 返回作废了哪几个号型，供页面提示「改了下单数量，已重新拆」。
 */
export function reconcileDoc(doc: DeliveryDoc, lines: DeliveryLineInput[]): string[] {
  const { overrides, droppedKeys } = reconcileOverrides(lines, doc.settings.batchCount, doc.overrides)
  doc.overrides = overrides
  return droppedKeys
}
