import { createApp, reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/locale/zh-cn'

const { ElMessage, ElMessageBox } = ElementPlus

const MOBILE_MEDIA = '(max-width: 768px)'
const STORAGE_KEY = 'sgbhsd.priceShare.form.v1'

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

    /* ---------- 字典数据 ---------- */
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
      commodityId: c.id, commodity: c.name, buy: '', sell: '', updatedAt: null,
    }))

    /* ---------- 区服输入联想 ---------- */
    const searchServers = (query, cb) => {
      api(`/api/servers${query ? `?keyword=${encodeURIComponent(query)}` : ''}`)
        .then(res => cb(res.items.map(i => ({ value: i.name }))))
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
          buy: fmt(r.buy),
          sell: fmt(r.sell),
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

    /* ---------- 脏值与统计 ---------- */
    const hasBaseValue = row => row._base && (row._base.buy != null || row._base.sell != null)

    const isDirty = row => {
      const b = row._base || { buy: null, sell: null }
      return numOrNull(row.buy) !== b.buy || numOrNull(row.sell) !== b.sell
    }

    /** 表格行样式：有未保存修改时整行高亮 */
    const rowClass = row => (queried.value && isDirty(row.row) ? 'row-dirty' : '')

    /** 买价 ≥ 卖价 的疑似录入错误提示 */
    const spreadWarn = row => {
      const b = numOrNull(row.buy)
      const s = numOrNull(row.sell)
      return b != null && s != null && b > s
    }

    const changedRows = computed(() => rows.value
      .filter(r => queried.value && isDirty(r))
      .map(r => ({ ...r, _baseBuy: fmt(r._base && r._base.buy), _baseSell: fmt(r._base && r._base.sell) })))

    const changedCount = computed(() => changedRows.value.length)
    const canSave = computed(() => queried.value && changedCount.value > 0)

    const stats = computed(() => {
      let filled = 0, buySum = 0, buyN = 0, sellSum = 0, sellN = 0, spreadSum = 0, spreadN = 0, bad = 0
      for (const r of rows.value) {
        const b = numOrNull(r.buy)
        const s = numOrNull(r.sell)
        if (b != null || s != null) filled++
        if (b != null) { buySum += b; buyN++ }
        if (s != null) { sellSum += s; sellN++ }
        if (b != null && s != null) { spreadSum += s - b; spreadN++; if (b > s) bad++ }
      }
      const avg = (sum, n) => (n ? (sum / n).toFixed(2) : '-')
      return { filled, avgBuy: avg(buySum, buyN), avgSell: avg(sellSum, sellN), avgSpread: avg(spreadSum, spreadN), badCount: bad }
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
        const items = changedRows.value.map(r => ({ commodity: r.commodity, buy: r.buy, sell: r.sell }))
        const res = await api('/api/prices', {
          method: 'POST',
          body: { server: form.server.trim(), city: form.city, items },
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

    const openDict = async () => {
      dictVisible.value = true
      try {
        const res = await api('/api/dict/summary')
        dictData.city = res.city.map(i => ({ ...i, _draft: i.name }))
        dictData.commodity = res.commodity.map(i => ({ ...i, _draft: i.name }))
        loadServers().catch(() => {})
      } catch (e) { ElMessage.error(e.message) }
    }

    const addDictItem = async type => {
      const name = (type === 'city' ? newCity.value : newCommodity.value).trim()
      if (!name) { ElMessage.warning(`请输入${type === 'city' ? '城池' : '商品'}名称`); return }
      try {
        await api('/api/dict', { method: 'POST', body: { type, name } })
        ElMessage.success(`已新增「${name}」`)
        if (type === 'city') newCity.value = ''
        else newCommodity.value = ''
        await Promise.all([openDictQuiet(), loadDict()])
      } catch (e) { ElMessage.error(e.message) }
    }

    const openDictQuiet = async () => {
      const res = await api('/api/dict/summary')
      dictData.city = res.city.map(i => ({ ...i, _draft: i.name }))
      dictData.commodity = res.commodity.map(i => ({ ...i, _draft: i.name }))
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

    /* ---------- 批量导入 ---------- */
    const importVisible = ref(false)
    const importText = ref('')
    const importAutoCreate = ref(true)
    const importing = ref(false)

    const openImport = () => {
      if (!form.server.trim() || !form.city) {
        ElMessage.warning('请先选择区服与城池，再执行批量导入')
        return
      }
      importText.value = ''
      importVisible.value = true
    }

    const submitImport = async () => {
      if (!importText.value.trim()) { ElMessage.warning('请先粘贴要导入的数据'); return }
      importing.value = true
      try {
        const res = await api('/api/prices/import', {
          method: 'POST',
          body: {
            server: form.server.trim(),
            city: form.city,
            text: importText.value,
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
    const exportCsv = () => {
      if (!form.server.trim() || !form.city) {
        ElMessage.warning('请先选择区服与城池，再执行导出')
        return
      }
      const q = new URLSearchParams({ server: form.server.trim(), city: form.city })
      window.location.href = `/api/prices/export?${q.toString()}`
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
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        if (saved.server) form.server = saved.server
        if (saved.city) form.city = saved.city
        if (saved.commodity) form.commodity = saved.commodity
      } catch (e) { /* ignore */ }

      try {
        await Promise.all([loadDict(), loadServers()])
        buildRowsFromDict()
      } catch (e) {
        ElMessage.error('字典数据加载失败，请刷新重试')
      }
    })

    onUnmounted(() => {
      mql.removeEventListener('change', onMqlChange)
      window.removeEventListener('keydown', onKeydown)
    })

    return {
      // 基础
      isMobile, form, cities, commodities, serverList, rows, queried, loading,
      citySelect, commoditySelect,
      // 查询
      searchServers, onQuery, onReset, doFetch,
      // 编辑
      onPriceInput, onPriceBlur, copyPrev, clearRow, isDirty, stats,
      rowClass, spreadWarn,
      changedCount, changedRows, canSave,
      // 保存
      saveVisible, onSave, confirmSave, saving, rowOpType, rowOpText,
      // 字典
      dictVisible, dictTab, dictData, newCity, newCommodity,
      openDict, addDictItem, saveDictRename, toggleDict, moveDict, removeDictItem, removeServer,
      onDictChange, ensureDictItem,
      // 日志 / 导入 / 导出
      historyVisible, historyList, openHistory, loadHistory,
      importVisible, importText, importAutoCreate, importing, openImport, submitImport,
      exportCsv,
    }
  },
}).use(ElementPlus, { locale: zhCn }).mount('#app')
