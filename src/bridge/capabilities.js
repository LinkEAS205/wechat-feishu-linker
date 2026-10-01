/**
 * Host capabilities the bridge drives on the contact's behalf.
 *
 * Every operation here is the *same* one the GUI performs, and every write lands
 * in the session event log — the single source of truth both surfaces render
 * from. Nothing is cached and nothing is owned here, which is why a switch made
 * from WeChat cannot leave the desktop showing a different value: the desktop is
 * a projection of the very log this module appends to.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0): each host service is
 * read structurally and every call is guarded, because a deployment may mount
 * only some of them.
 *
 * @module wechat-feishu-linker/bridge/capabilities
 */

/** Ascending reasoning effort, used only to order whatever a provider declares. */
const EFFORT_ORDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'max'])

/**
 * Resolve one host service without importing its package.
 *
 * @param {object} ctx - plugin context.
 * @param {string} name - service name (`llm`, `permissionPresets`, …).
 * @returns {object | undefined} the service, or undefined when it is not mounted.
 */
function serviceOf(ctx, name) {
  // `ctx.get` may throw for a service the host never provided — the exact case
  // every caller here is written to degrade through — so the read itself is
  // guarded, not just the use.
  try {
    const fromGetter = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    return fromGetter ?? ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * The live LLM registry, when the host exposes one.
 *
 * @param {object} ctx - plugin context.
 * @returns {object | undefined} `{ listProviders, listModels, resolveModelInfo }`.
 */
function llmOf(ctx) {
  const llm = serviceOf(ctx, 'llm')
  return llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function' ? llm : undefined
}

/**
 * Order a provider's declared efforts the way a person reads them.
 *
 * @param {object[]} efforts - `{ id, name, description? }`.
 * @returns {object[]} a sorted copy.
 */
function orderEfforts(efforts) {
  return [...efforts].sort((left, right) => {
    const a = EFFORT_ORDER.indexOf(String(left?.id))
    const b = EFFORT_ORDER.indexOf(String(right?.id))
    if (a === -1 && b === -1) return String(left?.id).localeCompare(String(right?.id))
    if (a === -1) return 1
    if (b === -1) return -1
    return a - b
  })
}

/**
 * Read the same model catalog the GUI renders.
 *
 * Mirrors `buildModelCatalog` in the host's session controller: providers, their
 * advertised models, and each model's reasoning efforts. A provider whose models
 * cannot be listed becomes a reported failure rather than sinking the whole
 * catalog.
 *
 * @param {object} ctx - plugin context.
 * @returns {Promise<{ available: boolean, reason?: string, groups: object[], failures: object[] }>}
 * the catalog, or `available: false` when the LLM registry is not mounted.
 */
export async function readModelCatalog(ctx) {
  const llm = llmOf(ctx)
  if (!llm) return { available: false, reason: 'no-llm', groups: [], failures: [] }

  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return { available: false, reason: String(error), groups: [], failures: [] }
  }
  if (!Array.isArray(providers)) return { available: false, reason: 'no-providers', groups: [], failures: [] }

  const groups = []
  const failures = []
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (!id) continue
    const name = typeof provider?.name === 'string' && provider.name ? provider.name : id
    try {
      const models = await llm.listModels(id)
      const entries = []
      for (const model of Array.isArray(models) ? models : []) {
        const modelId = typeof model?.id === 'string' ? model.id : ''
        if (!modelId) continue
        const entry = {
          id: modelId,
          name: typeof model?.name === 'string' && model.name ? model.name : modelId,
          ...(typeof model?.description === 'string' && model.description ? { description: model.description } : {}),
        }
        const reasoning = await readReasoning(llm, id, modelId)
        if (reasoning) entry.reasoning = reasoning
        entries.push(entry)
      }
      if (entries.length > 0) groups.push({ id, name, models: entries })
    } catch (error) {
      failures.push({ id, name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { available: true, groups, failures }
}

/**
 * Read one model's reasoning metadata.
 *
 * @param {object} llm - the LLM registry.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {Promise<{ efforts: object[], defaultEffort?: string } | undefined>} the metadata.
 */
async function readReasoning(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const resolved = await llm.resolveModelInfo(provider, model)
    const reasoning = resolved?.reasoning
    if (!reasoning || !Array.isArray(reasoning.efforts)) return undefined
    const efforts = orderEfforts(
      reasoning.efforts
        .filter((effort) => typeof effort?.id === 'string' && effort.id)
        .map((effort) => ({
          id: effort.id,
          name: typeof effort.name === 'string' && effort.name ? effort.name : effort.id,
          ...(typeof effort.description === 'string' && effort.description ? { description: effort.description } : {}),
        })),
    )
    if (efforts.length === 0) return undefined
    const defaultEffort = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined
    return { efforts, ...(defaultEffort ? { defaultEffort } : {}) }
  } catch {
    // A model that cannot describe its reasoning simply has no effort selector.
    return undefined
  }
}

/**
 * Find one model in a catalog.
 *
 * @param {object} catalog - a catalog from {@link readModelCatalog}.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {object | undefined} the catalog entry.
 */
export function findModel(catalog, provider, model) {
  const group = catalog?.groups?.find((candidate) => candidate.id === provider)
  return group?.models?.find((candidate) => candidate.id === model)
}

/**
 * Read one session's model selection.
 *
 * `pending` is an explicit switch that the next request has not used yet;
 * `lastUsed` is what the last request actually ran with. The GUI's own picker
 * shows `pending ?? lastUsed`, and so does this.
 *
 * @param {object} session - the session to read.
 * @returns {{ lastUsed: object | null, pending: object | null, next: object | null }} the selection.
 */
export function readSessionSelection(session) {
  let pending = null
  try {
    const seq = Number(session?.seq ?? 0)
    for (let index = seq - 1; index >= 0; index -= 1) {
      const event = session?.eventAt?.(index)
      if (event?.type !== 'model/selection') continue
      pending = normalizeSelection(event.data)
      break
    }
  } catch {
    // An unreadable log simply means no explicit selection was recorded.
  }
  let lastUsed = null
  try {
    lastUsed = normalizeSelection(session?.requestHeader?.()?.config)
  } catch {
    lastUsed = null
  }
  return { lastUsed, pending, next: pending ?? lastUsed }
}

/**
 * Keep only the fields a `model/selection` event carries.
 *
 * @param {unknown} value - raw selection.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} the selection.
 */
export function normalizeSelection(value) {
  const provider = typeof value?.provider === 'string' ? value.provider : ''
  const model = typeof value?.model === 'string' ? value.model : ''
  if (!provider || !model) return null
  const effort = typeof value?.reasoningEffort === 'string' && value.reasoningEffort ? value.reasoningEffort : ''
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
}

/**
 * Append a model selection to a session, exactly as the GUI's picker does.
 *
 * The append is what makes both surfaces agree: the desktop renders the
 * `modelSelection` projection of this log, so it shows the new model as "next"
 * without any notification passing between them.
 *
 * @param {object} session - the session to switch.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection - the new selection.
 * @returns {{ ok: true, selection: object } | { ok: false, message: string }} the outcome.
 */
export function selectModel(session, selection) {
  const normalized = normalizeSelection(selection)
  if (!normalized) return { ok: false, message: '需要同时给出 provider 和 model' }
  if (typeof session?.append !== 'function') return { ok: false, message: '当前会话不可写（宿主未提供会话日志）' }
  try {
    session.append('model/selection', normalized)
    return { ok: true, selection: normalized }
  } catch (error) {
    return { ok: false, message: `切换模型失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Read the permission presets a session can switch between.
 *
 * @param {object} ctx - plugin context.
 * @param {object} session - the session whose current preset is reported.
 * @returns {{ available: boolean, reason?: string, current: string, presets: object[] }} the state.
 */
export function readPermissionState(ctx, session) {
  const presets = serviceOf(ctx, 'permissionPresets')
  if (!presets || typeof presets.set !== 'function') {
    return { available: false, reason: 'no-permission-presets', current: '', presets: [] }
  }
  let current = ''
  try {
    current = String(presets.current?.(session) ?? '')
  } catch {
    current = ''
  }
  let options = []
  try {
    const catalog = presets.catalog?.()
    const list = Array.isArray(catalog?.options) ? catalog.options : Array.isArray(catalog) ? catalog : []
    options = list
      .filter((option) => typeof option?.value === 'string' && option.value)
      .map((option) => ({
        name: option.value,
        label: typeof option.label === 'string' && option.label ? option.label : option.value,
        ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}),
      }))
  } catch {
    options = []
  }
  if (options.length === 0 && Array.isArray(presets.names)) {
    options = presets.names.map((name) => ({ name: String(name), label: String(name) }))
  }
  return { available: true, current, presets: options }
}

/**
 * Switch one session's permission preset, exactly as the GUI's selector does.
 *
 * The service appends `permission/preset` plus the sandbox and approval knob
 * events, so the desktop's selector follows without being told.
 *
 * @param {object} ctx - plugin context.
 * @param {object} session - the session to switch.
 * @param {string} name - the preset name.
 * @returns {{ ok: true, name: string } | { ok: false, message: string }} the outcome.
 */
export function selectPermission(ctx, session, name) {
  const presets = serviceOf(ctx, 'permissionPresets')
  if (!presets || typeof presets.set !== 'function') {
    return { ok: false, message: '当前宿主不提供权限预设（permissionPresets 未挂载）' }
  }
  const wanted = typeof name === 'string' ? name.trim() : ''
  if (!wanted) return { ok: false, message: '请给出预设名' }
  try {
    presets.set(session, wanted)
    return { ok: true, name: wanted }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
