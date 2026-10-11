import { createApp, reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import zhCn from 'element-plus/locale/zh-cn'

const MOBILE_MEDIA = '(max-width: 768px)'
const STORAGE_KEY = 'sgbhsd.priceShare.form.v1'
const NICK_KEY = 'sgbhsd.nickname.v1'

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
  if (json.code !== 0) throw new Error(json.message || '请求失败')
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
    }

    const loadServers = async () => {
      const res = await api('/api/servers')
      serverList.value = res.items
    }

    /* 未查询时也用全部商品铺满列表（其他列显示 -） */
    const buildRowsFromDict = () => rows.value = commodities.value.map(c => ({
      commodityId: c.id, commodity: c.name, burden: c.burden,
      buy: '', sell: '', updatedAt: null, operator: null,
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

    /** 将输入框中的新名称写入字典表，返回是否新增 */
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

    /* 选择 / 回车提交新城池、新商品时立即入字典 */
    const onDictChange = async (type, val) => {
      if (!val) return
      const created = await ensureDictItem(type, val)
      if (created) await loadDict()
      if (queried.value) await doFetch(false)
    }

    /* 查询 / 保存前，把下拉框里未回车提交的新名称也写入字典 */
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
          // 输入框用空串表示无值；fmt 的 '-' 仅用于展示，不能写回可编辑字段
          buy: r.buy == null ? '' : String(r.buy),
          sell: r.sell == null ? '' : String(r.sell),
          _base: { buy: r.buy, sell: r.sell }, // 保存前的数据库原值，用于脏值比对
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

    /* ---------- 跨城利润展示（比价弹窗：（卖出城卖价 - 本城买价）/ 负重） ---------- */
    const profitText = v => (v == null ? '-' : (v > 0 ? '+' : '') + Number(v).toFixed(2))
    const profitClass = v => (v == null ? '' : v > 0 ? 'profit-pos' : v < 0 ? 'profit-neg' : '')

    /* ---------- 脏值与统计 ---------- */
    const hasBaseValue = row => row._base && (row._base.buy != null || row._base.sell != null)

    const isDirty = row => {
      const b = row._base || { buy: null, sell: null }
      return numOrNull(row.buy) !== b.buy || numOrNull(row.sell) !== b.sell
    }

    /** 表格行样式：有未保存修改时整行高亮 */
    const rowClass = row => (queried.value && isDirty(row.row) ? 'row-dirty' : '')

    const changedRows = computed(() => rows.value
      .filter(r => queried.value && isDirty(r))
      .map(r => ({ ...r, _baseBuy: fmt(r._base && r._base.buy), _baseSell: fmt(r._base && r._base.sell) })))

    const changedCount = computed(() => changedRows.value.length)
    const canSave = computed(() => queried.value && changedCount.value > 0)

    const stats = computed(() => {
      let filled = 0
      for (const r of rows.value) {
        if (numOrNull(r.buy) != null || numOrNull(r.sell) != null) filled++
      }
      return { filled }
    })

    /* ---------- 保存 ---------- */
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

    const confirmSave = async () => {
      saving.value = true
      try {
        const clean = v => (v == null || v === '' || v === '-' ? '' : v)
        const items = changedRows.value.map(r => ({ commodity: r.commodity, buy: clean(r.buy), sell: clean(r.sell) }))
        const res = await api('/api/prices', {
          method: 'POST',
          body: { server: form.server.trim(), city: form.city, operator: nickname.value, items },
        })
        ElMessage.success(`保存成功：新增 ${res.created} 条，更新 ${res.updated} 条${res.cleared ? `，清空 ${res.cleared} 条` : ''}`)
        saveVisible.value = false
        await doFetch(false)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        saving.value = false
      }
    }

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

    /* 负重维护 */
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

    /* ---------- 价格趋势（SVG 折线图，支持滚轮缩放/拖拽平移） ---------- */
    const trendVisible = ref(false)
    const trendCommodity = ref('')
    const trendDays = ref(30)
    const trendLoading = ref(false)
    const trendData = ref({ points: [], summary: {}, burden: null })
    const trendPoints = computed(() => trendData.value.points || [])
    // 视窗窗口：可见区间 [i0, i1]（浮点索引）；null = 全量
    const trendView = ref(null)
    const trendDragging = ref(false)

    const clampView = (i0, i1, n) => {
      const span = Math.min(Math.max(i1 - i0, 0), Math.max(n - 1, 0))
      let a = Math.min(Math.max(i0, 0), Math.max(n - 1 - span, 0))
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

      // Y 轴始终覆盖全部数据（两条线任何缩放级别都可见）
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

      // 路径：取可见区间±1 个点，边缘线段完整
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

      // X 轴：日期+时间（数据点为时间粒度）
      const fmtT = t => String(t).slice(5, 16) // MM-DD HH:mm
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

    /* ---------- 跨城池比价（利润 =（卖出城卖价 - 本城买价）/ 负重） ---------- */
    const matrixVisible = ref(false)
    const matrixCommodity = ref('')
    const matrixLoading = ref(false)
    const matrixData = ref({ items: null, summary: null, commodity: '', burden: null, server: '' })
    const matrixSellCity = ref('') // 空 = 自动取最高卖价城

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

    /** 目标卖出城：手动指定，或自动取卖价最高的城 */
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

    /** 每行附加跨城利润 = （目标卖出城卖价 − 本城买价）/ 负重 */
    const matrixRows = computed(() => {
      const t = matrixSellTarget.value
      const burden = matrixData.value.burden
      const div = (burden != null && burden > 0) ? burden : null
      return (matrixData.value.items || []).map(i => ({
        ...i,
        profit: (t && i.buy != null && div) ? Math.round((t.sell - i.buy) / div * 100) / 100 : null,
      }))
    })

    /** 推荐路线：最便宜买入城 → 目标卖出城 */
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

    /* ---------- 批量导入（Excel） ---------- */
    const importVisible = ref(false)
    const importFileName = ref('')
    const importPreview = ref([]) // [{ commodity, buy, sell, burden }]
    const importAutoCreate = ref(true)
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

    const cellStr = v => {
      if (v == null) return ''
      return String(v).trim()
    }

    const onImportFile = async ev => {
      const file = ev.target.files && ev.target.files[0]
      if (!file) return
      try {
        const buf = await file.arrayBuffer()
        const wb = window.XLSX.read(buf, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        if (!sheet) throw new Error('Excel 中没有工作表')
        const aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })
        // 跳过表头：首行第一格含「商品」则视为表头
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
          if (buy != null && !Number.isFinite(buy)) { ElMessage.warning(`第 ${i + 1} 行买价不是数字，已按空处理`); }
          if (sell != null && !Number.isFinite(sell)) { ElMessage.warning(`第 ${i + 1} 行卖价不是数字，已按空处理`); }
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

    const submitImport = async () => {
      if (!importPreview.value.length) { ElMessage.warning('请先选择要导入的 Excel 文件'); return }
      importing.value = true
      try {
        const res = await api('/api/prices/import', {
          method: 'POST',
          body: {
            server: form.server.trim(),
            city: form.city,
            operator: nickname.value,
            rows: importPreview.value,
            createCommodities: importAutoCreate.value,
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

    onMounted(async () => {
      mql.addEventListener('change', onMqlChange)
      window.addEventListener('keydown', onKeydown)

      // PWA Service Worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {})
      }

      // 恢复上次搜索条件
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        if (saved.server) form.server = String(saved.server).replace(/\D/g, '')
        if (saved.city) form.city = saved.city
        if (saved.commodity) form.commodity = saved.commodity
      } catch (e) { /* ignore */ }

      // 已缓存昵称：直接进入并加载数据
      if (entered.value) {
        try {
          await Promise.all([loadDict(), loadServers()])
          buildRowsFromDict()
          dataLoaded.value = true
        } catch (e) {
          ElMessage.error('数据加载失败，请刷新重试')
        }
      }
    })

    onUnmounted(() => {
      mql.removeEventListener('change', onMqlChange)
      window.removeEventListener('keydown', onKeydown)
    })

    return {
      // 昵称入口
      nickname, nicknameInput, entering, entered, enterSite, switchNickname,
      // 基础
      isMobile, form, cities, commodities, serverList, rows, queried, loading,
      citySelect, commoditySelect,
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
      matrixSellCity, matrixSellTarget, matrixRows, matrixBestRoute,
      // 导入导出
      importVisible, importFileName, importPreview, importAutoCreate, importing,
      importFileEl, openImport, clearImportFile, onImportFile, downloadImportTemplate, submitImport,
      exportCsv,
    }
  },
}).use(ElementPlus, { locale: zhCn }).mount('#app')
