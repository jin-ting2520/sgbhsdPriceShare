import { createApp, reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import zhCn from 'element-plus/locale/zh-cn'

const MOBILE_MEDIA = '(max-width: 768px)'
const STORAGE_KEY = 'sgbhsd.priceShare.form.v1'
const NICK_KEY = 'sgbhsd.nickname.v1'

const CRON_PRESETS = [
  { label: '每 1 小时', value: '0 * * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '每 6 小时', value: '0 */6 * * *' },
  { label: '每 12 小时', value: '0 */12 * * *' },
  { label: '每天 08:00', value: '0 8 * * *' },
  { label: '每天 20:00', value: '0 20 * * *' },
  { label: '自定义 cron', value: 'custom' },
]

/* ------------------------------ 请求封装 ------------------------------ */

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  const res = await fetch(path, init)
  let json = null
  try { json = await res.json() } catch (e) { json = null }
  if (!json) throw new Error(`服务异常（HTTP ${res.status}）`)
  if (json.code !== 0) {
    const err = new Error(json.message || '请求失败')
    err.code = json.code
    err.data = json.data
    throw err
  }
  return json.data
}

const numOrNull = v => {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const fmt = n => (n == null ? '-' : String(n))

/* ------------------------------ 应用 ------------------------------ */

createApp({
  setup() {
    /* ---------- 昵称（进入即用，本机缓存） ---------- */
    const nickname = ref((localStorage.getItem(NICK_KEY) || '').slice(0, 20))
    const nicknameInput = ref('')
    const entering = ref(false)
    const entered = computed(() => !!nickname.value)
    const dataLoaded = ref(false)

    /* ---------- 基础状态 ---------- */
    const isMobile = ref(window.matchMedia(MOBILE_MEDIA).matches)
    const form = reactive({ server: '', city: '', commodity: '' })
    const cities = ref([])
    const commodities = ref([])
    const serverList = ref([])

    const citySelect = ref(null)
    const commoditySelect = ref(null)

    const rows = ref([])
    const queried = ref(false)
    const loading = ref(false)
    const saving = ref(false)

    const loadDict = async () => {
      const [cityRes, commodityRes] = await Promise.all([
        api('/api/dict?type=city'),
        api('/api/dict?type=commodity'),
      ])
      cities.value = cityRes.items
      commodities.value = commodityRes.items
      if (!queried.value) buildRowsFromDict()
    }

    const loadServers = async () => {
      const res = await api('/api/servers')
      serverList.value = res.items
    }

    /* 未查询时也用全部商品铺满列表（其他列显示 -） */
    const buildRowsFromDict = () => rows.value = commodities.value.map(c => ({
      commodityId: c.id, commodity: c.name, burden: c.burden,
      buy: '', sell: '', updatedAt: null, operator: null, _base: { buy: null, sell: null }, _baseUpdatedAt: null,
    }))

    /** 点击「进入」：校验昵称 → 缓存 → 加载数据 */
    const enterSite = async () => {
      const name = nicknameInput.value.trim().replace(/\s+/g, ' ')
      if (!name) { ElMessage.warning('请输入你的三国冰河时代昵称'); return }
      if (name.length > 20) { ElMessage.warning('昵称不能超过 20 个字符'); return }
      entering.value = true
      nickname.value = name
      try {
        localStorage.setItem(NICK_KEY, name)
        if (!dataLoaded.value) {
          await Promise.all([loadDict(), loadServers()])
          buildRowsFromDict()
          dataLoaded.value = true
        }
        ElMessage.success(`欢迎，${name}`)
      } catch (e) {
        nickname.value = ''
        localStorage.removeItem(NICK_KEY)
        ElMessage.error(e.message)
      } finally {
        entering.value = false
      }
    }

    /** 右上角「切换昵称」：回到入口，重新输入 */
    const switchNickname = () => {
      nicknameInput.value = nickname.value
      nickname.value = ''
      localStorage.removeItem(NICK_KEY)
    }

    /* ---------- 区服输入联想（纯数字） ---------- */
    const searchServers = (query, cb) => {
      api(`/api/servers${query ? `?keyword=${encodeURIComponent(query)}` : ''}`)
        .then(res => cb(res.items.filter(i => /^\d+$/.test(i.name)).map(i => ({ value: i.name }))))
        .catch(() => cb([]))
    }

    /* ---------- 下拉框“已输入未提交”内容 ---------- */
    const getPendingInput = selectRef => {
      try {
        const input = selectRef && selectRef.$el && selectRef.$el.querySelector('input')
        return input && input.value ? input.value.trim() : ''
      } catch (e) { return '' }
    }

    const isKnown = (type, name) =>
      (type === 'city' ? cities.value : commodities.value).some(i => i.name === name)

    const ensureDictItem = async (type, name) => {
      if (!name || isKnown(type, name)) return false
      try {
        await api('/api/dict', { method: 'POST', body: { type, name } })
        ElMessage.success(`已将${type === 'city' ? '城池' : '商品'}「${name}」加入字典`)
        return true
      } catch (e) {
        ElMessage.error(e.message)
        return false
      }
    }

    const onDictChange = async (type, val) => {
      if (!val) return
      const created = await ensureDictItem(type, val)
      if (created) await loadDict()
      if (queried.value) await doFetch(false)
    }

    const commitPendingDict = async (mode = 'query') => {
      let changed = false
      const pendingCity = getPendingInput(citySelect.value)
      if (pendingCity && pendingCity !== form.city) {
        if (await ensureDictItem('city', pendingCity)) { form.city = pendingCity; changed = true }
      }
      const pendingCommodity = getPendingInput(commoditySelect.value)
      if (pendingCommodity && pendingCommodity !== form.commodity) {
        if (await ensureDictItem('commodity', pendingCommodity)) {
          if (mode === 'query') form.commodity = pendingCommodity
          changed = true
        }
      }
      if (changed) await loadDict()
    }

    /* ---------- 查询 ---------- */
    const doFetch = async (showLoading = true) => {
      if (showLoading) loading.value = true
      try {
        const q = new URLSearchParams({ server: form.server.trim(), city: form.city })
        if (form.commodity) q.set('commodity', form.commodity)
        const res = await api(`/api/prices?${q.toString()}`)
        rows.value = res.items.map(r => ({
          ...r,
          buy: r.buy == null ? '' : String(r.buy),
          sell: r.sell == null ? '' : String(r.sell),
          _base: { buy: r.buy, sell: r.sell },
          _baseUpdatedAt: r.updatedAt,
        }))
        queried.value = true
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        loading.value = false
      }
    }

    const onQuery = async () => {
      if (!form.server.trim()) { ElMessage.warning('请先输入区服'); return }
      if (!form.city) { ElMessage.warning('请先选择城池'); return }
      await commitPendingDict('query')
      if (!form.city) { ElMessage.warning('请先选择城池'); return }
      await doFetch()
    }

    const onReset = () => {
      form.server = ''
      form.city = ''
      form.commodity = ''
      queried.value = false
      buildRowsFromDict()
    }

    /* ---------- 行内编辑 ---------- */
    const onPriceInput = (row, field, val) => {
      let v = String(val == null ? '' : val)
        .replace(/[^\d.]/g, '')
        .replace(/(\..*)\./g, '$1')
      if (v.length > 12) v = v.slice(0, 12)
      row[field] = v
    }

    const onPriceBlur = (row, field) => {
      const n = numOrNull(row[field])
      row[field] = n == null ? '' : String(n)
    }

    const copyPrev = i => {
      if (i <= 0) return
      rows.value[i].buy = rows.value[i - 1].buy
      rows.value[i].sell = rows.value[i - 1].sell
    }

    const clearRow = row => { row.buy = ''; row.sell = '' }

    /* ---------- 跨城利润展示 ---------- */
    const profitText = v => (v == null ? '-' : (v > 0 ? '+' : '') + Number(v).toFixed(2))
    const profitClass = v => (v == null ? '' : v > 0 ? 'profit-pos' : v < 0 ? 'profit-neg' : '')

    /* ---------- 脏值与统计 ---------- */
    const hasBaseValue = row => row._base && (row._base.buy != null || row._base.sell != null)

    const isDirty = row => {
      const b = row._base || { buy: null, sell: null }
      return numOrNull(row.buy) !== b.buy || numOrNull(row.sell) !== b.sell
    }

    const rowClass = row => (queried.value && (isDirty(row.row) || row.row._remoteConflict) ? 'row-dirty' : '')

    const changedRows = computed(() => rows.value
      .filter(r => queried.value && isDirty(r))
      .map(r => ({
        ...r,
        baseUpdatedAt: r._baseUpdatedAt,
        _baseBuy: fmt(r._base && r._base.buy),
        _baseSell: fmt(r._base && r._base.sell),
      })))

    const changedCount = computed(() => changedRows.value.length)
    const canSave = computed(() => queried.value && changedCount.value > 0)
    const conflictCount = computed(() => rows.value.filter(r => r._remoteConflict).length)

    const stats = computed(() => {
      let filled = 0
      for (const r of rows.value) {
        if (numOrNull(r.buy) != null || numOrNull(r.sell) != null) filled++
      }
      return { filled }
    })

    /* ---------- 实时协作 WebSocket ---------- */
    const wsConnected = ref(false)
    const wsClients = ref(0)
    let ws = null
    let wsRetry = null
    let wsPing = null

    const connectWs = () => {
      if (ws || !entered.value) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`)
      } catch (e) { return }
      ws.onopen = () => {
        wsConnected.value = true
        clearInterval(wsPing)
        wsPing = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, 25000)
      }
      ws.onmessage = ev => {
        let msg = null
        try { msg = JSON.parse(ev.data) } catch { return }
        handleWsMessage(msg)
      }
      ws.onclose = () => {
        wsConnected.value = false
        ws = null
        clearInterval(wsPing)
        clearTimeout(wsRetry)
        if (entered.value) wsRetry = setTimeout(connectWs, 3000)
      }
      ws.onerror = () => { try { ws.close() } catch { /* ignore */ } }
    }

    const disconnectWs = () => {
      clearTimeout(wsRetry)
      clearInterval(wsPing)
      if (ws) { try { ws.close() } catch { /* ignore */ } }
      ws = null
      wsConnected.value = false
    }

    const applyRemoteItems = payload => {
      if (!queried.value) return
      if (payload.server !== form.server.trim() || payload.city !== form.city) return
      if (!payload.items || !payload.items.length) {
        if (rows.value.some(isDirty)) {
          ElMessage.warning('他人批量更新了价格，你本地有未保存修改；保存时会提示冲突')
          return
        }
        doFetch(false)
        return
      }
      for (const item of payload.items) {
        const row = rows.value.find(r => Number(r.commodityId) === Number(item.commodityId))
        if (!row) continue
        if (isDirty(row)) {
          row._remoteConflict = {
            buy: item.buy, sell: item.sell, operator: item.operator, updatedAt: item.updatedAt,
          }
          continue
        }
        row.buy = item.buy == null ? '' : String(item.buy)
        row.sell = item.sell == null ? '' : String(item.sell)
        row.updatedAt = item.updatedAt
        row.operator = item.operator
        row._base = { buy: item.buy, sell: item.sell }
        row._baseUpdatedAt = item.updatedAt
        delete row._remoteConflict
      }
    }

    const handleWsMessage = msg => {
      if (msg.type === 'hello' || msg.type === 'pong') {
        if (msg.type === 'hello') { wsConnected.value = true; wsClients.value = msg.clients || 1 }
        return
      }
      if (msg.type === 'price.updated') {
        applyRemoteItems(msg)
        if (msg.operator && msg.operator !== nickname.value) {
          const name = msg.items && msg.items.length
            ? msg.items.map(i => i.commodity).slice(0, 3).join('、') + (msg.items.length > 3 ? ' 等' : '')
            : '价格'
          ElMessage.info(`${msg.operator} 更新了 ${msg.server} · ${msg.city} 的${name}`)
        }
        return
      }
      if (msg.type === 'dict.changed') {
        loadDict().catch(() => {})
        loadServers().catch(() => {})
        return
      }
      if (msg.type === 'sync.finished' && msg.result) {
        const r = msg.result
        ElMessage.success(`游戏同步完成：${r.queried}/${r.cities} 城，写入 ${r.saved} 条${r.failed && r.failed.length ? `，失败 ${r.failed.length} 城` : ''}`)
        loadServers().catch(() => {})
        if (queried.value && msg.result.server === form.server.trim()) {
          if (rows.value.some(isDirty)) ElMessage.warning('同步已更新当前城池，你本地有未保存修改；保存时会提示冲突')
          else doFetch(false)
        }
        if (reportVisible.value) loadReport()
        return
      }
      if (msg.type === 'sync.failed') {
        if (msg.trigger !== 'manual' || !syncing.value) ElMessage.error(`游戏同步失败：${msg.message}`)
        return
      }
      if (msg.type === 'settings.updated') {
        if (settingsVisible.value) applySettings(msg.settings)
        return
      }
      if (msg.type === 'server.deleted') {
        if (form.server === msg.name) onReset()
        loadServers().catch(() => {})
      }
    }

    /* ---------- 保存（含乐观并发冲突处理） ---------- */
    const saveVisible = ref(false)

    const rowOpType = r => {
      if (!hasBaseValue(r)) return 'success'
      if (numOrNull(r.buy) == null && numOrNull(r.sell) == null) return 'danger'
      return 'warning'
    }
    const rowOpText = r => (rowOpType(r) === 'success' ? '新增' : rowOpType(r) === 'danger' ? '清空' : '修改')

    const onSave = () => {
      if (!queried.value) { ElMessage.warning('请先选择区服与城池并查询'); return }
      if (!changedCount.value) { ElMessage.warning('暂无修改需要保存'); return }
      commitPendingDict('save')
      saveVisible.value = true
    }

    const submitSave = async force => {
      saving.value = true
      try {
        const clean = v => (v == null || v === '' || v === '-' ? '' : v)
        const items = changedRows.value.map(r => ({
          commodity: r.commodity,
          buy: clean(r.buy),
          sell: clean(r.sell),
          baseUpdatedAt: r.baseUpdatedAt || null,
        }))
        const res = await api('/api/prices', {
          method: 'POST',
          body: { server: form.server.trim(), city: form.city, operator: nickname.value, items, force: force === true },
        })
        ElMessage.success(`保存成功：新增 ${res.created} 条，更新 ${res.updated} 条${res.cleared ? `，清空 ${res.cleared} 条` : ''}`)
        saveVisible.value = false
        await doFetch(false)
        return true
      } catch (e) {
        if (e.code === 40903 && !force) {
          const conflicts = (e.data && e.data.conflicts) || []
          const detail = conflicts.map(c =>
            `${c.commodity}：数据库最新 买 ${fmt(c.buy)} / 卖 ${fmt(c.sell)}（${c.operator || '匿名'} ${c.updatedAt}）`
          ).join('\n')
          try {
            await ElMessageBox.confirm(
              `${detail}\n\n你正在修改的数据已被他人更新。覆盖保存将丢弃对方的最新值，建议先使用最新数据。`,
              '价格已被他人更新',
              {
                type: 'warning',
                confirmButtonText: '覆盖保存',
                cancelButtonText: '使用最新数据',
                customClass: 'pre-wrap-confirm',
              }
            )
            saving.value = false
            await submitSave(true)
            return false
          } catch (err) {
            saveVisible.value = false
            await doFetch(false)
            ElMessage.info('已载入最新数据，请确认后再保存')
            return false
          }
        }
        ElMessage.error(e.message)
        return false
      } finally {
        saving.value = false
      }
    }

    const confirmSave = () => submitSave(false)

    /* ---------- 字典管理 ---------- */
    const dictVisible = ref(false)
    const dictTab = ref('city')
    const dictData = reactive({ city: [], commodity: [] })
    const newCity = ref('')
    const newCommodity = ref('')
    const newBurden = ref('')

    const toDrafts = res => {
      dictData.city = res.city.map(i => ({ ...i, _draft: i.name }))
      dictData.commodity = res.commodity.map(i => ({
        ...i,
        _draft: i.name,
        _burdenDraft: i.burden != null ? String(i.burden) : '',
      }))
    }

    const openDictQuiet = async () => toDrafts(await api('/api/dict/summary'))

    const openDict = async () => {
      dictVisible.value = true
      try {
        await openDictQuiet()
        loadServers().catch(() => {})
      } catch (e) { ElMessage.error(e.message) }
    }

    const addDictItem = async type => {
      const name = (type === 'city' ? newCity.value : newCommodity.value).trim()
      if (!name) { ElMessage.warning(`请输入${type === 'city' ? '城池' : '商品'}名称`); return }
      const body = { type, name }
      if (type === 'commodity') body.burden = newBurden.value
      try {
        await api('/api/dict', { method: 'POST', body })
        ElMessage.success(`已新增「${name}」`)
        if (type === 'city') newCity.value = ''
        else { newCommodity.value = ''; newBurden.value = '' }
        await Promise.all([openDictQuiet(), loadDict()])
      } catch (e) { ElMessage.error(e.message) }
    }

    const saveDictRename = async row => {
      const name = (row._draft || '').trim()
      if (!name || name === row.name) { row._draft = row.name; return }
      if (name.length > 20) { ElMessage.error('名称不能超过 20 个字符'); row._draft = row.name; return }
      try {
        const updated = await api(`/api/dict/${row.id}`, { method: 'PUT', body: { name } })
        ElMessage.success(`已重命名为「${updated.name}」`)
        await Promise.all([openDictQuiet(), loadDict()])
        if (form.city === row.name) { form.city = updated.name; if (queried.value) doFetch(false) }
        if (form.commodity === row.name) { form.commodity = updated.name; if (queried.value) doFetch(false) }
      } catch (e) { ElMessage.error(e.message); row._draft = row.name }
    }

    const saveDictBurden = async row => {
      const raw = String(row._burdenDraft == null ? '' : row._burdenDraft).trim()
      const original = row.burden != null ? String(row.burden) : ''
      if (raw === original) return
      if (raw !== '' && !(Number(raw) > 0)) {
        ElMessage.error('负重必须是大于 0 的数字')
        row._burdenDraft = original
        return
      }
      try {
        const updated = await api(`/api/dict/${row.id}`, { method: 'PUT', body: { burden: raw } })
        row.burden = updated.burden
        row._burdenDraft = updated.burden != null ? String(updated.burden) : ''
        ElMessage.success(`「${row.name}」负重已更新为 ${updated.burden ?? '-'}`)
        await loadDict()
        if (queried.value) doFetch(false)
      } catch (e) { ElMessage.error(e.message); row._burdenDraft = original }
    }

    const toggleDict = async row => {
      try {
        await api(`/api/dict/${row.id}`, { method: 'PUT', body: { status: row.status ? 1 : 0 } })
        await loadDict()
        if (queried.value) doFetch(false)
      } catch (e) { ElMessage.error(e.message) }
    }

    const moveDict = async (row, type, dir) => {
      const list = type === 'city' ? dictData.city : dictData.commodity
      const i = list.findIndex(x => x.id === row.id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return
      const target = list[j]
      try {
        await Promise.all([
          api(`/api/dict/${row.id}`, { method: 'PUT', body: { sort_order: target.sort_order } }),
          api(`/api/dict/${target.id}`, { method: 'PUT', body: { sort_order: row.sort_order } }),
        ])
        await Promise.all([openDictQuiet(), loadDict()])
        if (queried.value) doFetch(false)
      } catch (e) { ElMessage.error(e.message) }
    }

    const removeDictItem = async (row, type) => {
      try {
        await ElMessageBox.confirm(
          `确定删除${type === 'city' ? '城池' : '商品'}「${row.name}」？删除后不可恢复。`,
          '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
        )
      } catch (e) { return }
      try {
        await api(`/api/dict/${row.id}`, { method: 'DELETE' })
        ElMessage.success(`已删除「${row.name}」`)
        await Promise.all([openDictQuiet(), loadDict()])
        if (form.city === row.name) { form.city = ''; if (queried.value) { queried.value = false; buildRowsFromDict() } }
        if (form.commodity === row.name) { form.commodity = ''; if (queried.value) doFetch(false) }
      } catch (e) { ElMessage.error(e.message) }
    }

    const removeServer = async srv => {
      try {
        await ElMessageBox.confirm(
          `确定删除区服「${srv.name}」及其全部价格记录？删除后不可恢复。`,
          '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
        )
      } catch (e) { return }
      try {
        await api(`/api/servers/${srv.id}`, { method: 'DELETE' })
        ElMessage.success(`已删除区服「${srv.name}」`)
        await loadServers()
        if (form.server === srv.name) onReset()
      } catch (e) { ElMessage.error(e.message) }
    }

    /* ---------- 更新日志 ---------- */
    const historyVisible = ref(false)
    const historyList = ref([])

    const loadHistory = async () => {
      try {
        const res = await api(`/api/prices/history?server=${encodeURIComponent(form.server.trim())}&city=${encodeURIComponent(form.city)}&limit=100`)
        historyList.value = res.items
      } catch (e) { ElMessage.error(e.message) }
    }
    const openHistory = () => {
      historyVisible.value = true
      if (queried.value) loadHistory()
    }

    /* ---------- 价格趋势（SVG 折线图） ---------- */
    const trendVisible = ref(false)
    const trendCommodity = ref('')
    const trendDays = ref(30)
    const trendLoading = ref(false)
    const trendData = ref({ points: [], summary: {}, burden: null })
    const trendPoints = computed(() => trendData.value.points || [])
    const trendView = ref(null)
    const trendDragging = ref(false)

    const clampView = (i0, i1, n) => {
      const span = Math.min(Math.max(i1 - i0, 0), Math.max(n - 1, 0))
      const a = Math.min(Math.max(i0, 0), Math.max(n - 1 - span, 0))
      return { i0: a, i1: a + span }
    }

    const resetTrendView = () => { trendView.value = null }

    const zoomTrend = (factor, anchorFrac = 0.5) => {
      const n = trendPoints.value.length
      if (n < 2) return
      const v = trendView.value || { i0: 0, i1: n - 1 }
      const span = v.i1 - v.i0
      const anchor = v.i0 + anchorFrac * span
      const newSpan = Math.min(Math.max(span * factor, 0.04), Math.max(n - 1, 0.04))
      const i0 = anchor - anchorFrac * newSpan
      trendView.value = clampView(i0, i0 + newSpan, n)
    }

    const onTrendWheel = e => {
      const rect = e.currentTarget.getBoundingClientRect()
      const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      zoomTrend(e.deltaY > 0 ? 1.25 : 0.8, Math.min(Math.max(frac, 0), 1))
    }

    let dragState = null
    const onTrendMouseDown = e => {
      const n = trendPoints.value.length
      if (n < 2) return
      dragState = {
        x: e.clientX,
        view: trendView.value ? { ...trendView.value } : { i0: 0, i1: n - 1 },
      }
      trendDragging.value = true
    }
    const onTrendMouseMove = e => {
      if (!dragState) return
      const svg = e.currentTarget
      const rect = svg.getBoundingClientRect()
      const n = trendPoints.value.length
      const span = dragState.view.i1 - dragState.view.i0
      const dFrac = rect.width ? (e.clientX - dragState.x) / rect.width : 0
      trendView.value = clampView(dragState.view.i0 - dFrac * span, dragState.view.i1 - dFrac * span, n)
    }
    const onTrendMouseUp = () => { dragState = null; trendDragging.value = false }

    const trendChart = computed(() => {
      const W = 640, H = 260, PL = 44, PR = 14, PT = 14, PB = 30
      const pts = trendPoints.value
      const empty = { W, H, grid: [], buyPath: '', sellPath: '', buyDots: [], sellDots: [], xLabels: [], zoomed: false }
      if (!pts.length) return empty
      const n = pts.length
      const v = trendView.value && n > 1 ? clampView(trendView.value.i0, trendView.value.i1, n) : { i0: 0, i1: n - 1 }

      const vals = []
      pts.forEach(p => { if (p.buy != null) vals.push(p.buy); if (p.sell != null) vals.push(p.sell) })
      if (!vals.length) return empty
      let min = Math.min(...vals)
      let max = Math.max(...vals)
      if (min === max) { min -= 1; max += 1 }
      const pad = (max - min) * 0.1
      min -= pad
      max += pad

      const span = Math.max(v.i1 - v.i0, 1e-9)
      const x = i => PL + ((i - v.i0) / span) * (W - PL - PR)
      const y = val => PT + (1 - (val - min) / (max - min)) * (H - PT - PB)

      const from = Math.max(Math.floor(v.i0) - 1, 0)
      const to = Math.min(Math.ceil(v.i1) + 1, n - 1)
      const buildPath = key => {
        let d = ''
        let pen = false
        for (let i = from; i <= to; i++) {
          const p = pts[i]
          if (p[key] == null) { pen = false; continue }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)} `
          pen = true
        }
        return d.trim()
      }
      const dots = key => {
        const out = []
        for (let i = Math.ceil(v.i0); i <= Math.floor(v.i1) && i < n; i++) {
          const p = pts[i]
          if (p[key] == null) continue
          out.push({
            x: +x(i).toFixed(1),
            y: +y(p[key]).toFixed(1),
            tip: `${p.date} ${key === 'buy' ? '买价' : '卖价'} ${p[key]}`,
          })
        }
        return out
      }

      const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
        const val = min + t * (max - min)
        return { y: +y(val).toFixed(1), label: val.toFixed(1) }
      })

      const fmtT = t => String(t).slice(5, 16)
      const i0r = Math.round(v.i0)
      const i1r = Math.min(Math.round(v.i1), n - 1)
      const im = Math.round((v.i0 + v.i1) / 2)
      const xLabels = [{ x: x(i0r), label: fmtT(pts[i0r].date), anchor: 'start' }]
      if (im > i0r + 1 && im < i1r - 1) {
        xLabels.push({ x: x(im), label: fmtT(pts[im].date), anchor: 'middle' })
      }
      if (i1r > i0r) {
        xLabels.push({ x: x(i1r), label: fmtT(pts[i1r].date), anchor: 'end' })
      }

      return {
        W, H, grid,
        buyPath: buildPath('buy'),
        sellPath: buildPath('sell'),
        buyDots: dots('buy'),
        sellDots: dots('sell'),
        xLabels,
        zoomed: v.i0 > 0.001 || v.i1 < n - 1.001,
      }
    })

    const loadTrend = async () => {
      if (!queried.value) { ElMessage.warning('请先选择区服与城池并查询'); return }
      if (!trendCommodity.value) { ElMessage.warning('请选择商品'); return }
      trendLoading.value = true
      try {
        const q = new URLSearchParams({
          server: form.server.trim(), city: form.city,
          commodity: trendCommodity.value, days: String(trendDays.value),
        })
        trendData.value = await api(`/api/prices/trend?${q.toString()}`)
        trendView.value = null
      } catch (e) { ElMessage.error(e.message) } finally { trendLoading.value = false }
    }

    const openTrend = () => {
      trendVisible.value = true
      if (!trendCommodity.value) trendCommodity.value = form.commodity || (commodities.value[0] && commodities.value[0].name) || ''
      if (queried.value && trendCommodity.value) loadTrend()
    }

    /* ---------- 跨城池比价 ---------- */
    const matrixVisible = ref(false)
    const matrixCommodity = ref('')
    const matrixLoading = ref(false)
    const matrixData = ref({ items: null, summary: null, commodity: '', burden: null, server: '' })
    const matrixSellCity = ref('')

    const loadMatrix = async () => {
      if (!matrixCommodity.value) { ElMessage.warning('请选择商品'); return }
      matrixLoading.value = true
      try {
        const q = new URLSearchParams({ server: form.server.trim(), commodity: matrixCommodity.value })
        matrixData.value = await api(`/api/prices/matrix?${q.toString()}`)
        matrixSellCity.value = ''
      } catch (e) { ElMessage.error(e.message) } finally { matrixLoading.value = false }
    }

    const openMatrix = () => {
      matrixVisible.value = true
      if (!matrixCommodity.value) matrixCommodity.value = form.commodity || (commodities.value[0] && commodities.value[0].name) || ''
      if (matrixCommodity.value) loadMatrix()
    }

    const matrixSellTarget = computed(() => {
      const items = matrixData.value.items || []
      if (matrixSellCity.value) {
        const it = items.find(i => i.city === matrixSellCity.value)
        return it && it.sell != null ? it : null
      }
      let best = null
      for (const i of items) if (i.sell != null && (best == null || i.sell > best.sell)) best = i
      return best
    })

    const matrixRows = computed(() => {
      const t = matrixSellTarget.value
      const burden = matrixData.value.burden
      const div = (burden != null && burden > 0) ? burden : null
      return (matrixData.value.items || []).map(i => ({
        ...i,
        profit: (t && i.buy != null && div) ? Math.round((t.sell - i.buy) / div * 100) / 100 : null,
      }))
    })

    const matrixBestRoute = computed(() => {
      let buyCity = null
      for (const i of matrixRows.value) if (i.buy != null && (buyCity == null || i.buy < buyCity.buy)) buyCity = i
      const sell = matrixSellTarget.value
      const burden = matrixData.value.burden
      if (!buyCity || !sell || buyCity.city === sell.city || !(burden > 0)) return null
      return {
        buyCity: buyCity.city, buyPrice: buyCity.buy,
        sellCity: sell.city, sellPrice: sell.sell,
        profit: Math.round((sell.sell - buyCity.buy) / burden * 100) / 100,
      }
    })

    /* ---------- 批量导入（Excel / 文本） ---------- */
    const importVisible = ref(false)
    const importFileName = ref('')
    const importPreview = ref([])
    const importAutoCreate = ref(true)
    const importMerge = ref(false)
    const importing = ref(false)
    const importFileEl = ref(null)

    const openImport = () => {
      if (!form.server.trim() || !form.city) {
        ElMessage.warning('请先选择区服与城池，再执行批量导入')
        return
      }
      clearImportFile()
      importVisible.value = true
    }

    const clearImportFile = () => {
      importFileName.value = ''
      importPreview.value = []
      if (importFileEl.value) importFileEl.value.value = ''
    }

    const downloadImportTemplate = () => {
      const rows = [
        ['商品', '买价', '卖价', '负重'],
        ['毛皮', 10.5, 15, 18],
        ['谷物', '', 12, 10],
        ['兵器', 45, 60, ''],
      ]
      const ws = window.XLSX.utils.aoa_to_sheet(rows)
      ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }]
      const wb = window.XLSX.utils.book_new()
      window.XLSX.utils.book_append_sheet(wb, ws, '价格导入')
      window.XLSX.writeFile(wb, '价格导入模板.xlsx')
    }

    const cellStr = v => (v == null ? '' : String(v).trim())

    const onImportFile = async ev => {
      const file = ev.target.files && ev.target.files[0]
      if (!file) return
      try {
        const buf = await file.arrayBuffer()
        const wb = window.XLSX.read(buf, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        if (!sheet) throw new Error('Excel 中没有工作表')
        const aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })
        const start = (aoa.length && cellStr(aoa[0][0]).includes('商品')) ? 1 : 0
        const preview = []
        for (let i = start; i < aoa.length; i++) {
          const r = aoa[i] || []
          const commodity = cellStr(r[0])
          if (!commodity) continue
          const buy = r[1] == null || cellStr(r[1]) === '' ? null : Number(cellStr(r[1]).replace(/[^\d.-]/g, ''))
          const sell = r[2] == null || cellStr(r[2]) === '' ? null : Number(cellStr(r[2]).replace(/[^\d.-]/g, ''))
          const burdenRaw = r[3] == null ? '' : cellStr(r[3])
          const burden = burdenRaw === '' ? null : Number(burdenRaw.replace(/[^\d.]/g, ''))
          preview.push({
            commodity,
            buy: buy != null && Number.isFinite(buy) && buy >= 0 ? buy : null,
            sell: sell != null && Number.isFinite(sell) && sell >= 0 ? sell : null,
            burden: burden != null && Number.isFinite(burden) && burden > 0 ? burden : null,
          })
        }
        if (!preview.length) { ElMessage.warning('未解析到有效数据行，请确认模板格式'); clearImportFile(); return }
        importFileName.value = file.name
        importPreview.value = preview
      } catch (e) {
        ElMessage.error('Excel 解析失败：' + e.message)
        clearImportFile()
      }
    }

    const sanitizePreviewRows = () => importPreview.value.map(r => {
      const num = v => {
        if (v === '' || v == null) return null
        const n = Number(String(v).replace(/[^\d.-]/g, ''))
        return Number.isFinite(n) && n >= 0 ? n : null
      }
      return { commodity: String(r.commodity || '').trim(), buy: num(r.buy), sell: num(r.sell), burden: num(r.burden) }
    }).filter(r => r.commodity)

    const submitImport = async () => {
      const rowsIn = sanitizePreviewRows()
      if (!rowsIn.length) { ElMessage.warning('请先上传 Excel 文件'); return }
      importing.value = true
      try {
        const res = await api('/api/prices/import', {
          method: 'POST',
          body: {
            server: form.server.trim(),
            city: form.city,
            operator: nickname.value,
            rows: rowsIn,
            createCommodities: importAutoCreate.value,
            merge: importMerge.value,
          },
        })
        ElMessage.success(`导入完成：新增 ${res.created} 条，更新 ${res.updated} 条${res.newDictCount ? `，创建商品 ${res.newDictCount} 个` : ''}`)
        importVisible.value = false
        await loadDict()
        if (queried.value) await doFetch(false)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        importing.value = false
      }
    }

    /* ---------- 导出 ---------- */
    const exportCsv = async () => {
      if (!form.server.trim() || !form.city) {
        ElMessage.warning('请先选择区服与城池，再执行导出')
        return
      }
      try {
        const q = new URLSearchParams({ server: form.server.trim(), city: form.city })
        const res = await fetch(`/api/prices/export?${q.toString()}`)
        if (!res.ok) {
          const j = await res.json().catch(() => null)
          throw new Error((j && j.message) || `导出失败（HTTP ${res.status}）`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${form.server}-${form.city}-价格表.csv`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (e) {
        ElMessage.error(e.message)
      }
    }

    /* ---------- 游戏同步（手动） ---------- */
    const syncVisible = ref(false)
    const syncing = ref(false)
    const syncToken = ref('')
    const syncServer = ref('')
    const syncOperator = ref('')
    const syncResult = ref(null)
    const syncHasSavedToken = ref(false)

    const openSync = async () => {
      syncVisible.value = true
      syncResult.value = null
      syncServer.value = form.server.trim()
      syncOperator.value = nickname.value
      if (!syncToken.value) syncToken.value = ''
      try {
        const s = await api('/api/sync-settings')
        syncHasSavedToken.value = !!s.hasToken
      } catch (e) { /* ignore */ }
    }

    const doSync = async () => {
      const server = String(syncServer.value || '').replace(/\D/g, '')
      syncServer.value = server
      if (!server) { ElMessage.warning('请输入纯数字区服，如 1344'); return }
      if (!syncToken.value.trim() && !syncHasSavedToken.value) {
        ElMessage.warning('请粘贴游戏登录 token（或先在「定时」中保存）')
        return
      }
      syncing.value = true
      syncResult.value = null
      try {
        const result = await api('/api/game/sync', {
          method: 'POST',
          body: {
            token: syncToken.value.trim() || undefined,
            server,
            operator: syncOperator.value || nickname.value,
          },
        })
        syncResult.value = result
        if (result.saved > 0) ElMessage.success(`同步完成：${result.queried}/${result.cities} 城，写入 ${result.saved} 条`)
        else ElMessage.warning(`同步完成，但没有写入价格（${result.queried}/${result.cities} 城）`)
        await loadServers()
        if (form.server.trim() === result.server && queried.value) await doFetch(false)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        syncing.value = false
      }
    }

    /* ---------- 定时同步设置 ---------- */
    const settingsVisible = ref(false)
    const settingsLoading = ref(false)
    const settingsSaving = ref(false)
    const settingsRunning = ref(false)
    const cronPreset = ref('0 */2 * * *')
    const cronCustom = ref('0 */2 * * *')
    const syncLogs = ref([])
    const settings = reactive({
      enabled: false, cron: '0 */2 * * *', token: '', server: '', operator: '自动同步',
      hasToken: false, tokenHint: '', lastRunAt: null, lastStatus: null, lastMessage: null,
      energy: { energyCost: 1, energyLimit: 10, energyCDHours: 4 },
    })

    const applySettings = data => {
      if (!data) return
      settings.enabled = !!data.enabled
      settings.cron = data.cron || '0 */2 * * *'
      settings.server = String(data.server || '').replace(/\D/g, '')
      settings.operator = data.operator || '自动同步'
      settings.hasToken = !!data.hasToken
      settings.tokenHint = data.tokenHint || ''
      settings.lastRunAt = data.lastRunAt
      settings.lastStatus = data.lastStatus
      settings.lastMessage = data.lastMessage
      if (data.energy) settings.energy = data.energy
      settings.token = ''
      if (CRON_PRESETS.some(p => p.value === settings.cron)) {
        cronPreset.value = settings.cron
      } else {
        cronPreset.value = 'custom'
        cronCustom.value = settings.cron
      }
    }

    const openSettings = async () => {
      settingsVisible.value = true
      settingsLoading.value = true
      try {
        const [data, logs] = await Promise.all([
          api('/api/sync-settings'),
          api('/api/sync-settings/logs?limit=10'),
        ])
        applySettings(data)
        syncLogs.value = logs.items
        if (!settings.server) settings.server = form.server.trim()
        if (!settings.operator) settings.operator = nickname.value
      } catch (e) { ElMessage.error(e.message) } finally { settingsLoading.value = false }
    }

    const saveSettings = async () => {
      const cron = cronPreset.value === 'custom' ? cronCustom.value.trim() : cronPreset.value
      const server = String(settings.server || '').replace(/\D/g, '')
      settings.server = server
      if (!cron) { ElMessage.warning('请填写 cron 表达式'); return }
      if (settings.enabled && !server) { ElMessage.warning('启用自动同步需要填写纯数字区服，如 1344'); return }
      if (settings.enabled && !settings.hasToken && !settings.token.trim()) {
        ElMessage.warning('启用自动同步需要填写登录 token')
        return
      }
      settingsSaving.value = true
      try {
        const body = {
          enabled: settings.enabled,
          cron,
          server,
          operator: settings.operator,
        }
        if (settings.token.trim()) body.token = settings.token.trim()
        const data = await api('/api/sync-settings', { method: 'PUT', body })
        applySettings(data)
        ElMessage.success(settings.enabled ? '自动同步已启用' : '同步设置已保存')
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        settingsSaving.value = false
      }
    }

    const runSettingsSync = async () => {
      settingsRunning.value = true
      try {
        const result = await api('/api/sync-settings/run', { method: 'POST' })
        ElMessage.success(`同步完成：${result.queried}/${result.cities} 城，写入 ${result.saved} 条`)
        const [data, logs] = await Promise.all([
          api('/api/sync-settings'),
          api('/api/sync-settings/logs?limit=10'),
        ])
        applySettings(data)
        syncLogs.value = logs.items
        await loadServers()
        if (queried.value && result.server === form.server.trim()) await doFetch(false)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        settingsRunning.value = false
      }
    }

    /* ---------- 报表 ---------- */
    const reportVisible = ref(false)
    const reportTab = ref('movers')
    const reportServer = ref('')
    const reportLoading = ref(false)
    const reportDays = ref(7)
    const moversData = ref({ items: [] })
    const arbData = ref({ items: [], params: {}, energyInfo: {} })
    const arbParams = reactive({ load: 200, energyPrice: 0, energyPerTrip: 1, returnTrip: true, all: false })
    const heatData = ref({ buckets: [], totalChanges: 0, totalSyncs: 0 })
    const heatBucket = ref('day')
    const heatDays = ref(30)

    const openReports = () => {
      reportVisible.value = true
      if (!reportServer.value) reportServer.value = form.server.trim() || (serverList.value[0] && serverList.value[0].name) || ''
      loadReport()
    }

    const loadReport = async () => {
      if (!reportServer.value.trim()) {
        ElMessage.warning('请先输入区服')
        return
      }
      reportLoading.value = true
      try {
        if (reportTab.value === 'movers') {
          const q = new URLSearchParams({ server: reportServer.value.trim(), days: String(reportDays.value), limit: '30' })
          moversData.value = await api(`/api/reports/movers?${q.toString()}`)
        } else if (reportTab.value === 'arbitrage') {
          const q = new URLSearchParams({
            server: reportServer.value.trim(),
            load: String(arbParams.load),
            energyPrice: String(arbParams.energyPrice),
            energyPerTrip: String(arbParams.energyPerTrip),
            returnTrip: arbParams.returnTrip ? '1' : '0',
            all: arbParams.all ? '1' : '0',
          })
          arbData.value = await api(`/api/reports/arbitrage?${q.toString()}`)
        } else {
          const q = new URLSearchParams({
            server: reportServer.value.trim(),
            days: String(heatDays.value),
            bucket: heatBucket.value,
          })
          heatData.value = await api(`/api/reports/heat?${q.toString()}`)
        }
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        reportLoading.value = false
      }
    }

    const onReportTabChange = () => loadReport()

    const heatMax = computed(() => {
      const list = heatData.value.buckets || []
      return Math.max(1, ...list.map(b => b.changes + b.syncs))
    })

    const heatBars = computed(() => (heatData.value.buckets || []).map((b, i) => {
      const total = b.changes + b.syncs
      return {
        ...b,
        height: total ? Math.max(4, Math.round((total / heatMax.value) * 100)) : 2,
        showLabel: i === 0 || i === heatData.value.buckets.length - 1 || i % Math.ceil(heatData.value.buckets.length / 8) === 0,
      }
    }))

    const changeClass = v => (v == null ? '' : v > 0 ? 'profit-pos' : v < 0 ? 'profit-neg' : '')

    const openArbitrageFromMatrix = () => {
      matrixVisible.value = false
      reportTab.value = 'arbitrage'
      reportVisible.value = true
      if (!reportServer.value) reportServer.value = form.server.trim()
      loadReport()
    }

    /* ---------- 生命周期 ---------- */
    const mql = window.matchMedia(MOBILE_MEDIA)
    const onMqlChange = e => { isMobile.value = e.matches }

    const onKeydown = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSave.value) {
        e.preventDefault()
        onSave()
      }
    }

    watch(() => [form.server, form.city, form.commodity], () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          server: form.server, city: form.city, commodity: form.commodity,
        }))
      } catch (e) { /* 忽略隐私模式等 */ }
    })

    watch(entered, v => { if (v) connectWs(); else disconnectWs() })

    onMounted(async () => {
      mql.addEventListener('change', onMqlChange)
      window.addEventListener('keydown', onKeydown)

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {})
      }

      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        if (saved.server) form.server = String(saved.server).replace(/\D/g, '')
        if (saved.city) form.city = saved.city
        if (saved.commodity) form.commodity = saved.commodity
      } catch (e) { /* ignore */ }

      if (entered.value) {
        try {
          await Promise.all([loadDict(), loadServers()])
          buildRowsFromDict()
          dataLoaded.value = true
          connectWs()
        } catch (e) {
          ElMessage.error('数据加载失败，请刷新重试')
        }
      }
    })

    onUnmounted(() => {
      mql.removeEventListener('change', onMqlChange)
      window.removeEventListener('keydown', onKeydown)
      disconnectWs()
    })

    return {
      // 昵称入口
      nickname, nicknameInput, entering, entered, enterSite, switchNickname,
      // 基础
      isMobile, form, cities, commodities, serverList, rows, queried, loading,
      citySelect, commoditySelect,
      // 实时协作
      wsConnected, wsClients, conflictCount,
      // 查询
      searchServers, onQuery, onReset, doFetch,
      // 编辑
      onPriceInput, onPriceBlur, copyPrev, clearRow, isDirty, stats,
      rowClass, profitText, profitClass,
      changedCount, changedRows, canSave,
      // 保存
      saveVisible, onSave, confirmSave, saving, rowOpType, rowOpText,
      // 字典
      dictVisible, dictTab, dictData, newCity, newCommodity, newBurden,
      openDict, addDictItem, saveDictRename, saveDictBurden, toggleDict, moveDict,
      removeDictItem, removeServer, onDictChange, ensureDictItem,
      // 日志 / 趋势 / 比价
      historyVisible, historyList, openHistory, loadHistory,
      trendVisible, trendCommodity, trendDays, trendLoading, trendData, trendPoints,
      trendChart, openTrend, loadTrend,
      trendView, trendDragging, zoomTrend, resetTrendView, onTrendWheel,
      onTrendMouseDown, onTrendMouseMove, onTrendMouseUp,
      matrixVisible, matrixCommodity, matrixLoading, matrixData, openMatrix, loadMatrix,
      matrixSellCity, matrixSellTarget, matrixRows, matrixBestRoute, openArbitrageFromMatrix,
      // 导入导出
      importVisible, importFileName, importPreview, importAutoCreate, importMerge, importing,
      importFileEl, openImport, clearImportFile, onImportFile, downloadImportTemplate, submitImport,
      exportCsv,
      // 游戏同步
      syncVisible, syncing, syncToken, syncServer, syncOperator, syncResult, syncHasSavedToken,
      openSync, doSync,
      // 定时设置
      settingsVisible, settingsLoading, settingsSaving, settingsRunning, settings, cronPreset, cronCustom,
      cronPresets: CRON_PRESETS, syncLogs, openSettings, saveSettings, runSettingsSync,
      // 报表
      reportVisible, reportTab, reportServer, reportLoading, reportDays, moversData, arbData, arbParams,
      heatData, heatBucket, heatDays, heatBars, openReports, loadReport, onReportTabChange, changeClass,
    }
  },
}).use(ElementPlus, { locale: zhCn }).mount('#app')
