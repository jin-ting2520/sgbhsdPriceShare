import { createApp, reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import zhCn from 'element-plus/locale/zh-cn'
import { randomHex, signHeaders } from './request-sign.js'

const MOBILE_MEDIA = '(max-width: 768px)'
const STORAGE_KEY = 'sgbhsd.priceShare.form.v1'
const ACCOUNT_KEY = 'sgbhsd.account.v1'
const RELIEF_KEY = 'sgbhsd.taxRelief.v1'
const DEVICE_KEY = 'sgbhsd.device.v1'
const DEVICE_COOKIE = 'sgbhsd_device_id'
const DEFAULT_RELIEF = 5

const readSavedAccount = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null')
    if (saved && saved.name && saved.session) return { name: String(saved.name).slice(0, 20), session: saved.session }
  } catch (e) { /* 忽略隐私模式等 */ }
  return null
}

const isDeviceId = value => /^[A-Za-z0-9_-]{8,64}$/.test(String(value || ''))

const readCookie = name => {
  try {
    const prefix = `${name}=`
    const hit = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))
    return hit ? decodeURIComponent(hit.slice(prefix.length)) : ''
  } catch (e) {
    return ''
  }
}

const writeCookie = (name, value) => {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=63072000; SameSite=Lax${secure}`
    return readCookie(name) === value
  } catch (e) {
    return false
  }
}

const rememberDeviceId = id => {
  let persisted = false
  try {
    localStorage.setItem(DEVICE_KEY, id)
    persisted = true
  } catch (e) { /* 忽略隐私模式等 */ }
  if (writeCookie(DEVICE_COOKIE, id)) persisted = true
  return persisted
}

/* localStorage 与 first-party cookie 互为备份；都不可用时交给服务端设备指纹兜底 */
const readDeviceId = () => {
  let local = ''
  let cookie = ''
  try { local = localStorage.getItem(DEVICE_KEY) || '' } catch (e) { /* 忽略隐私模式等 */ }
  try { cookie = readCookie(DEVICE_COOKIE) } catch (e) { /* 忽略隐私模式等 */ }
  const saved = isDeviceId(local) ? local : (isDeviceId(cookie) ? cookie : '')
  const id = saved || randomHex(16)
  const persisted = rememberDeviceId(id) || !!saved
  return persisted ? id : ''
}

const collectDeviceMeta = () => {
  const uaData = navigator.userAgentData || {}
  let timezone = ''
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch (e) { /* 忽略 */ }
  return {
    platform: uaData.platform || navigator.platform || '',
    language: navigator.language || '',
    timezone,
    screen: `${screen.width || 0}x${screen.height || 0}@${window.devicePixelRatio || 1}`,
    cores: navigator.hardwareConcurrency || 0,
    memory: navigator.deviceMemory || 0,
    touch: navigator.maxTouchPoints || 0,
    standalone: matchMedia('(display-mode: standalone)').matches,
  }
}

const deviceLabel = (id = '') => {
  const ua = navigator.userAgent
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
        : /Mac OS X/i.test(ua) ? 'macOS'
          : /Linux/i.test(ua) ? 'Linux' : '设备'
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /Chrome\//i.test(ua) ? 'Chrome'
      : /Firefox\//i.test(ua) ? 'Firefox'
        : /Safari\//i.test(ua) ? 'Safari' : '浏览器'
  const suffix = id ? ` · ${id.slice(-4).toUpperCase()}` : ''
  return `${os} · ${browser}${suffix}`
}

let DEVICE_ID = readDeviceId()
let DEVICE_NAME = deviceLabel(DEVICE_ID)
const DEVICE_META = collectDeviceMeta()

let accountSession = (readSavedAccount() || {}).session || ''
let onAuthInvalid = null

async function signedFetch(path, { method = 'GET', body } = {}) {
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  const headers = { 'X-Device-Id': DEVICE_ID }
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  if (accountSession) {
    headers['X-Account-Token'] = accountSession
    if (path !== '/api/auth/login') Object.assign(headers, signHeaders(accountSession, method, path, payload))
  }
  return fetch(path, { method, headers, body: payload })
}

const clampRelief = v => {
  if (v == null || v === '') return DEFAULT_RELIEF
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_RELIEF
  return Math.min(Math.max(n, 0), 100)
}

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
  const res = await signedFetch(path, options)
  let json = null
  try { json = await res.json() } catch (e) { json = null }
  if (!json) throw new Error(`服务异常（HTTP ${res.status}）`)
  if (json.code !== 0) {
    const err = new Error(json.message || '请求失败')
    err.status = res.status
    err.code = json.code
    err.data = json.data
    if (res.status === 401 && path !== '/api/auth/login' && onAuthInvalid) onAuthInvalid()
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
    /* ---------- 账号（昵称 + 密码 + 卡密，本机缓存会话） ---------- */
    const savedAccount = readSavedAccount()
    const nickname = ref(savedAccount ? savedAccount.name : '')
    const nicknameInput = ref('')
    const passwordInput = ref('')
    const keyInput = ref('')
    const authMode = ref('login')
    const renewVisible = ref(false)
    const renewKey = ref('')
    const renewMessage = ref('')
    const accountToken = ref('')
    const accountServer = ref('')
    const serverVisible = ref(false)
    const serverInput = ref('')
    const serverSaving = ref(false)
    const serverRequired = ref(false)
    const allowSyncServer = ref(false)
    const accountExpiresAt = ref(null)
    const accountHasKey = ref(true)
    const masterAccountId = ref(null)
    const masterAccountName = ref('')
    const isMaster = ref(false)
    const masterPricesAllowed = ref(false)
    const viewMasterPrices = ref(false)
    const masterSaving = ref(false)
    const expiryLoaded = ref(false)
    const keyRequired = ref(false)
    const keyRequiredAt = ref('2026-10-22 00:00:00')
    const keyHelpHtml = ref('')
    const tokenHelpHtml = ref('')
    const sessionOk = ref(!!accountSession)
    const entering = ref(false)
    const entered = computed(() => !!nickname.value && sessionOk.value)
    const dataLoaded = ref(false)
    const deviceName = ref(DEVICE_NAME)

    const applyExpiry = data => {
      accountExpiresAt.value = (data && data.expiresAt) || null
      accountHasKey.value = !!(data && data.hasKey)
      expiryLoaded.value = true
    }

    const applyMasterMeta = data => {
      if (data && data.currentServer !== undefined) accountServer.value = data.currentServer || ''
      masterAccountId.value = (data && data.masterAccountId) || null
      masterAccountName.value = (data && data.masterAccountName) || ''
      isMaster.value = !!(data && data.isMaster)
      masterPricesAllowed.value = !!(data && data.masterPricesAllowed)
      viewMasterPrices.value = !!(data && data.viewMasterPrices)
    }

    const refreshMasterMeta = async () => {
      try { applyMasterMeta(await api('/api/auth/me')) } catch { /* ignore */ }
    }

    const onViewMasterChange = async enabled => {
      if (queried.value && rows.value.some(isDirty)) {
        try {
          await ElMessageBox.confirm(
            '切换主账号价格共享会重新加载当前价格，未保存的修改将丢失。是否继续？',
            '有未保存修改',
            { type: 'warning', confirmButtonText: '继续切换', cancelButtonText: '取消' }
          )
        } catch (e) {
          viewMasterPrices.value = !enabled
          return
        }
      }
      const prev = !enabled
      masterSaving.value = true
      try {
        await api('/api/auth/master-prices', { method: 'PUT', body: { enabled } })
        viewMasterPrices.value = enabled
        ElMessage.success(enabled ? `已开启查看主账号「${masterAccountName.value}」的价格` : '已关闭主账号价格共享')
        if (queried.value) await doFetch(false)
      } catch (e) {
        viewMasterPrices.value = prev
        ElMessage.error(e.message)
      } finally {
        masterSaving.value = false
      }
    }

    const loadPublicConfig = async () => {
      try {
        const config = await api('/api/public/config')
        keyRequired.value = !!config.keyRequired
        keyRequiredAt.value = config.keyRequiredAt || '2026-10-22 00:00:00'
        keyHelpHtml.value = config.keyHelpHtml || ''
        tokenHelpHtml.value = config.tokenHelpHtml || ''
      } catch (e) { /* 配置加载失败时保留静态提示 */ }
    }

    const keyRequiredAtText = computed(() => String(keyRequiredAt.value || '').slice(0, 16))
    const keyPlaceholder = computed(() => (keyRequired.value
      ? '卡密（注册必填，如 ABCD-EFGH-JKLM-NPQR）'
      : '卡密（试用期可留空，如 ABCD-EFGH-JKLM-NPQR）'))
    const authHint = computed(() => (authMode.value === 'login'
      ? '已有账号直接输入昵称和密码登录；没有账号请先注册。'
      : (keyRequired.value
        ? '注册需要填写有效卡密；已有账号请返回登录，试用结束可在登录页续期。'
        : `注册可先不填卡密试用至 ${keyRequiredAtText.value}，也可填写卡密直接开通。`)))
    const expirySoon = computed(() => {
      if (!accountHasKey.value || !accountExpiresAt.value) return false
      const ts = Date.parse(`${String(accountExpiresAt.value).replace(' ', 'T')}+08:00`)
      return Number.isFinite(ts) && ts > Date.now() && ts - Date.now() < 86400000
    })
    const expiryText = computed(() => {
      if (!expiryLoaded.value) return '到期时间…'
      if (!accountHasKey.value) return '试用中'
      if (!accountExpiresAt.value) return '永久有效'
      return `有效期至 ${String(accountExpiresAt.value).slice(0, 16)}`
    })
    const expiryShortText = computed(() => {
      if (!expiryLoaded.value) return '到期时间…'
      if (!accountHasKey.value) return '试用中'
      if (!accountExpiresAt.value) return '永久有效'
      const ts = Date.parse(`${String(accountExpiresAt.value).replace(' ', 'T')}+08:00`)
      if (!Number.isFinite(ts)) return '有效期'
      if (ts <= Date.now()) return '已到期'
      return `剩余 ${Math.max(1, Math.ceil((ts - Date.now()) / 86400000))} 天`
    })
    const expiryTooltip = computed(() => {
      if (!expiryLoaded.value) return '正在读取卡密到期时间'
      if (!accountHasKey.value) return `试用期至 ${keyRequiredAtText.value}；启用卡密后需输入卡密继续使用`
      if (!accountExpiresAt.value) return '卡密永久有效'
      return `卡密到期时间：${accountExpiresAt.value}`
    })
    const expiryTagType = computed(() => {
      if (!expiryLoaded.value) return 'info'
      if (!accountHasKey.value) return 'success'
      if (!accountExpiresAt.value) return 'info'
      return expirySoon.value ? 'warning' : 'info'
    })

    /* ---------- 基础状态 ---------- */
    const isMobile = ref(window.matchMedia(MOBILE_MEDIA).matches)
    const form = reactive({ server: '', city: '', commodity: '' })
    const cities = ref([])
    const commodities = ref([])
    const serverList = ref([])

    /* ---------- 个人赋税减免（随账号保存，本地缓存兜底，默认 5%） ---------- */
    const taxRelief = ref(clampRelief(localStorage.getItem(RELIEF_KEY)))
    const savedRelief = ref(taxRelief.value)
    const currentTax = ref(null)
    const effTax = tax => {
      const t = Number(tax)
      if (!Number.isFinite(t) || t <= 0) return 0
      return t * (1 - taxRelief.value / 100)
    }
    const eventCorrection = events => {
      const list = Array.isArray(events) ? events : []
      for (const event of list) {
        if (!event || event.priceCorrection == null) continue
        const correction = Number(event.priceCorrection)
        if (Number.isFinite(correction)) return correction
      }
      return 0
    }
    const correctionFactor = correction => {
      const n = Number(correction)
      return Number.isFinite(n) ? Math.max(0.01, 1 + n) : 1
    }
    const viewBuy = (raw, tax, correction = 0) => (raw == null
      ? null
      : Math.round(Number(raw) * (1 + effTax(tax)) * correctionFactor(correction) * 10) / 10)
    const viewSell = (raw, tax, correction = 0) => (raw == null
      ? null
      : Math.round(Number(raw) * (1 - effTax(tax)) * correctionFactor(correction) * 10) / 10)

    const rows = ref([])
    const cityEvents = ref([])
    const queried = ref(false)
    const loading = ref(false)
    const saving = ref(false)

    const eventTip = events => {
      const list = Array.isArray(events) ? events : []
      const descriptions = list.map(e => e && e.description).filter(Boolean)
      const endsAt = list.map(e => e.endsAt).filter(Boolean).sort()
      const title = descriptions.length ? descriptions.join('；') : '大事件进行中，价格可能上涨或下跌'
      return `${title}${endsAt.length ? `；最近结束 ${String(endsAt[0]).slice(5, 16)}` : ''}`
    }
    const eventLabel = events => {
      const list = Array.isArray(events) ? events : []
      if (list.length > 1) return `大事件×${list.length}`
      const correction = Number(list[0] && list[0].priceCorrection)
      if (Number.isFinite(correction) && correction !== 0) {
        const percent = Math.round(Math.abs(correction) * 10000) / 100
        return `大事件 ${correction > 0 ? '↑' : '↓'}${percent}%`
      }
      return '大事件'
    }
    const activeEventCount = computed(() => new Set(
      cityEvents.value.map(e => Number(e.commodityId)).filter(Number.isFinite)
    ).size)
    const cityEventText = computed(() => {
      const descriptions = cityEvents.value.map(e => e && e.description).filter(Boolean)
      return descriptions.length
        ? descriptions.join('；')
        : `本城有 ${activeEventCount.value} 种商品受大事件影响，价格可能上涨或下跌`
    })

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
      commodityId: c.id, commodity: c.name, burden: c.burden, source: null, events: [],
      buy: '', sell: '', updatedAt: null, operator: null, _base: { buy: null, sell: null }, _baseUpdatedAt: null,
    }))

    const loadData = async () => {
      if (dataLoaded.value) return
      await Promise.all([loadDict(), loadServers()])
      buildRowsFromDict()
      dataLoaded.value = true
    }

    const setAuthMode = mode => {
      if (authMode.value === mode) return
      authMode.value = mode
      passwordInput.value = ''
      keyInput.value = ''
      renewVisible.value = false
    }

    const openRenew = () => {
      if (!nicknameInput.value.trim() || !passwordInput.value) {
        ElMessage.warning('请先填写昵称和密码，再输入新卡密续期')
        return
      }
      renewMessage.value = '输入新卡密，有效期将从当前到期时间顺延；永久卡密直接生效。'
      renewKey.value = ''
      renewVisible.value = true
    }

    /** 登录 / 注册共用提交：只有注册模式读取卡密，登录模式不发送 key */
    const submitAuth = async ({ mode = authMode.value, key = '', kick = false } = {}) => {
      const name = nicknameInput.value.trim().replace(/\s+/g, ' ')
      const password = passwordInput.value
      if (!name) { ElMessage.warning('请输入你的三国冰河时代昵称'); return }
      if (name.length > 20) { ElMessage.warning('昵称不能超过 20 个字符'); return }
      if (!password) { ElMessage.warning(mode === 'register' ? '请设置密码' : '请输入密码'); return }
      if (password.length < 4) { ElMessage.warning('密码至少 4 位'); return }
      if (mode === 'register' && keyRequired.value && !key) {
        ElMessage.warning('卡密已启用，注册需要填写卡密')
        return
      }
      entering.value = true
      try {
        const body = {
          name, password, mode, deviceId: DEVICE_ID, deviceName: DEVICE_NAME, deviceMeta: DEVICE_META,
        }
        if (key) body.key = key
        if (kick) body.kick = 'all'
        const data = await api('/api/auth/login', { method: 'POST', body })
        if (data.deviceId && data.deviceId !== DEVICE_ID) {
          DEVICE_ID = data.deviceId
          DEVICE_NAME = deviceLabel(DEVICE_ID)
          deviceName.value = DEVICE_NAME
          rememberDeviceId(DEVICE_ID)
        }
        accountSession = data.session
        sessionOk.value = true
        nickname.value = data.name
        accountToken.value = data.token || ''
        accountServer.value = data.currentServer || ''
        allowSyncServer.value = !!data.allowSyncServer
        applyExpiry(data)
        applyMasterMeta(data)
        if (!form.server && accountServer.value) form.server = accountServer.value
        taxRelief.value = clampRelief(data.relief)
        savedRelief.value = taxRelief.value
        try { localStorage.setItem(RELIEF_KEY, String(taxRelief.value)) } catch (e) { /* 忽略隐私模式等 */ }
        passwordInput.value = ''
        keyInput.value = ''
        renewKey.value = ''
        renewVisible.value = false
        try {
          localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ name: data.name, session: data.session }))
        } catch (e) { /* 忽略隐私模式等 */ }
        const expiry = !data.hasKey
          ? (data.expiresAt ? `，试用中（至 ${String(data.expiresAt).slice(0, 10)}）` : '，试用中')
          : (data.expiresAt ? `，有效期至 ${String(data.expiresAt).slice(0, 10)}` : '，永久有效')
        const prefix = data.created ? '注册成功并进入' : (data.renewed ? '续期成功，欢迎回来' : '欢迎回来')
        ElMessage.success(`${prefix}，${data.name}${expiry}`)
        try {
          await loadData()
        } catch (e) {
          ElMessage.error('数据加载失败，请刷新重试')
        }
        if (!accountServer.value) openServerPicker(true)
      } catch (e) {
        if (e.code === 40910) {
          const devices = (e.data && (e.data.devices || e.data.sessions)) || []
          const list = devices.map(d => {
            const state = d.online ? `在线 ${d.activeSessions || 1} 个会话` : '离线'
            return `· ${d.deviceName || '未知设备'}（${state}，${d.lastSeenAt || '未知时间'}）`
          }).join('\n')
          try {
            await ElMessageBox.confirm(
              `该账号最多保存 ${(e.data && e.data.limit) || 3} 台设备记录，当前已有：\n${list}\n\n是否移除全部旧设备记录并继续登录？`,
              '设备记录已达上限',
              {
                type: 'warning',
                confirmButtonText: '移除旧设备并登录',
                cancelButtonText: '取消',
                customClass: 'pre-wrap-confirm',
              }
            )
            await submitAuth({ mode, key, kick: true })
            return
          } catch (err) { /* 用户取消 */ }
        } else if (e.code === 40301 && mode === 'login') {
          renewMessage.value = e.message
          renewKey.value = key
          renewVisible.value = true
        } else if (e.code === 40401) {
          authMode.value = 'register'
          keyInput.value = ''
          ElMessage.info('该昵称尚未注册，请先注册')
        } else if (e.code === 40012) {
          authMode.value = 'login'
          keyInput.value = ''
          ElMessage.info('该昵称已注册，请直接登录')
        } else {
          ElMessage.error(e.message)
        }
      } finally {
        entering.value = false
      }
    }

    const enterSite = () => {
      if (authMode.value === 'register') {
        return submitAuth({ mode: 'register', key: keyInput.value.trim() })
      }
      return submitAuth({ mode: 'login' })
    }

    const submitRenew = () => {
      const key = renewKey.value.trim()
      if (!key) { ElMessage.warning('请输入卡密'); return }
      return submitAuth({ mode: 'login', key })
    }

    /** 右上角「退出登录」：注销当前会话，回到入口 */
    const switchAccount = async () => {
      try { await api('/api/auth/logout', { method: 'POST' }) } catch (e) { /* 忽略 */ }
      accountSession = ''
      sessionOk.value = false
      nickname.value = ''
      accountToken.value = ''
      accountServer.value = ''
      serverVisible.value = false
      serverRequired.value = false
      serverInput.value = ''
      allowSyncServer.value = false
      accountExpiresAt.value = null
      accountHasKey.value = true
      applyMasterMeta(null)
      expiryLoaded.value = false
      nicknameInput.value = ''
      passwordInput.value = ''
      keyInput.value = ''
      authMode.value = 'login'
      renewVisible.value = false
      renewKey.value = ''
      syncToken.value = ''
      syncResult.value = null
      devicesVisible.value = false
      try { localStorage.removeItem(ACCOUNT_KEY) } catch (e) { /* 忽略 */ }
    }

    onAuthInvalid = () => {
      accountSession = ''
      sessionOk.value = false
      nickname.value = ''
      accountToken.value = ''
      serverVisible.value = false
      serverRequired.value = false
      allowSyncServer.value = false
      accountExpiresAt.value = null
      accountHasKey.value = true
      applyMasterMeta(null)
      expiryLoaded.value = false
      authMode.value = 'login'
      renewVisible.value = false
      try { localStorage.removeItem(ACCOUNT_KEY) } catch (e) { /* 忽略 */ }
      ElMessage.warning('登录已失效，请重新登录')
    }

    /* ---------- 区服输入联想（纯数字） ---------- */
    const searchServers = (query, cb) => {
      api(`/api/servers${query ? `?keyword=${encodeURIComponent(query)}` : ''}`)
        .then(res => cb(res.items.filter(i => /^\d+$/.test(i.name)).map(i => ({ value: i.name }))))
        .catch(() => cb([]))
    }

    /* ---------- 查询 ---------- */
    const doFetch = async (showLoading = true) => {
      if (showLoading) loading.value = true
      try {
        const q = new URLSearchParams({ server: form.server.trim(), city: form.city, relief: String(taxRelief.value) })
        if (form.commodity) q.set('commodity', form.commodity)
        const res = await api(`/api/prices?${q.toString()}`)
        applyMasterMeta(res)
        currentTax.value = res.tax == null ? null : Number(res.tax)
        cityEvents.value = Array.isArray(res.events) ? res.events : []
        rows.value = res.items.map(r => ({
          ...r,
          source: r.source || null,
          events: Array.isArray(r.events) ? r.events : [],
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
      await doFetch()
    }

    const onReset = () => {
      form.server = ''
      form.city = ''
      form.commodity = ''
      queried.value = false
      currentTax.value = null
      cityEvents.value = []
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

    const openServerPicker = (required = false) => {
      serverRequired.value = !!required
      serverInput.value = accountServer.value || form.server.trim()
      serverVisible.value = true
    }

    const saveServer = async () => {
      const server = serverInput.value.trim()
      if (!server) { ElMessage.warning('请输入当前所在区服'); return }
      if (server.length > 50) { ElMessage.warning('区服名称不能超过 50 个字符'); return }
      if (queried.value && rows.value.some(isDirty)) {
        try {
          await ElMessageBox.confirm(
            '切换当前区服会重新加载价格，未保存的修改将丢失。是否继续？',
            '有未保存修改',
            { type: 'warning', confirmButtonText: '继续切换', cancelButtonText: '取消' }
          )
        } catch { return }
      }
      serverSaving.value = true
      try {
        const data = await api('/api/auth/server', { method: 'PUT', body: { server } })
        accountServer.value = data.currentServer || server
        applyMasterMeta(data)
        form.server = accountServer.value
        serverRequired.value = false
        serverVisible.value = false
        ElMessage.success(`当前区服已设为 ${accountServer.value}`)
        await loadServers()
        if (queried.value && form.city) await doFetch(false)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        serverSaving.value = false
      }
    }

    const rowClass = row => (queried.value && (isDirty(row.row) || row.row._remoteConflict) ? 'row-dirty' : '')

    const onReliefChange = async () => {
      const next = clampRelief(taxRelief.value)
      const prev = savedRelief.value
      taxRelief.value = next
      if (next === prev) return
      if (queried.value && rows.value.some(isDirty)) {
        try {
          await ElMessageBox.confirm(
            `将按 ${next}% 减免重新换算当前城池价格，未保存的修改会丢失。是否继续？`,
            '调整赋税减免',
            { type: 'warning', confirmButtonText: '重新加载', cancelButtonText: '取消' }
          )
        } catch {
          taxRelief.value = prev
          return
        }
      }
      savedRelief.value = next
      try { localStorage.setItem(RELIEF_KEY, String(next)) } catch (e) { /* 忽略隐私模式等 */ }
      if (entered.value) {
        try {
          await api('/api/auth/relief', { method: 'PUT', body: { relief: next } })
        } catch (e) {
          ElMessage.error(`赋税减免保存失败：${e.message}`)
        }
      }
      if (queried.value) await doFetch(false)
    }

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

    const sharedCount = computed(() => rows.value.filter(r => r.source === 'master').length)

    /* ---------- 实时协作 WebSocket ---------- */
    const wsConnected = ref(false)
    const wsClients = ref(0)
    let ws = null
    let wsRetry = null
    let wsPing = null
    let wsConnecting = false

    const connectWs = async () => {
      if (ws || wsConnecting || !entered.value) return
      wsConnecting = true
      try {
        const { ticket } = await api('/api/auth/ws-ticket', { method: 'POST', body: {} })
        if (!entered.value || ws) return
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        ws = new WebSocket(`${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`)
      } catch (e) {
        if (entered.value) wsRetry = setTimeout(connectWs, 3000)
        return
      } finally {
        wsConnecting = false
      }
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
      ws.onclose = ev => {
        wsConnected.value = false
        ws = null
        clearInterval(wsPing)
        clearTimeout(wsRetry)
        if (ev && ev.code === 4401) { if (onAuthInvalid) onAuthInvalid(); return }
        if (ev && ev.code === 4403) { ElMessage.error('账号已被封禁或卡密已到期，实时协作已断开'); return }
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
      if (payload.tax != null) currentTax.value = Number(payload.tax)
      if (!payload.items || !payload.items.length) {
        if (rows.value.some(isDirty)) {
          ElMessage.warning('他人批量更新了价格，你本地有未保存修改；保存时会提示冲突')
          return
        }
        doFetch(false)
        return
      }
      let sourceRefresh = false
      for (const item of payload.items) {
        const row = rows.value.find(r => Number(r.commodityId) === Number(item.commodityId))
        if (!row) continue
        const correction = eventCorrection(row.events)
        const buy = viewBuy(item.buy, payload.tax, correction)
        const sell = viewSell(item.sell, payload.tax, correction)
        if (isDirty(row)) {
          row._remoteConflict = {
            buy, sell, operator: item.operator, updatedAt: item.updatedAt,
          }
          continue
        }
        if (row.source === 'master' || (buy == null && sell == null)) sourceRefresh = true
        row.source = (buy == null && sell == null) ? null : 'own'
        row.buy = buy == null ? '' : String(buy)
        row.sell = sell == null ? '' : String(sell)
        row.updatedAt = item.updatedAt
        row.operator = item.operator
        row._base = { buy, sell }
        row._baseUpdatedAt = item.updatedAt
        delete row._remoteConflict
      }
      if (sourceRefresh && !rows.value.some(isDirty)) doFetch(false)
    }

    const handleWsMessage = msg => {
      if (msg.type === 'hello' || msg.type === 'pong') {
        if (msg.type === 'hello') { wsConnected.value = true; wsClients.value = msg.clients || 1 }
        return
      }
      if (msg.type === 'price.updated') {
        if (msg.shared) {
          const sameServer = queried.value && msg.server === form.server.trim()
          const sameScope = sameServer && (!msg.city || msg.city === form.city)
          if (sameScope) {
            if (rows.value.some(isDirty)) {
              ElMessage.warning('主账号价格已更新，你本地有未保存修改；保存时会提示冲突')
            } else {
              doFetch(false)
            }
          } else if (sameServer) {
            loadServers().catch(() => {})
          }
          if (msg.operator && msg.operator !== nickname.value) {
            const name = msg.items && msg.items.length
              ? msg.items.map(i => i.commodity).slice(0, 3).join('、') + (msg.items.length > 3 ? ' 等' : '')
              : '价格'
            ElMessage.info(`主账号${msg.masterAccountName ? `「${msg.masterAccountName}」` : ''}更新了 ${msg.server}${msg.city ? ` · ${msg.city}` : ''} 的${name}`)
          }
          return
        }
        applyRemoteItems(msg)
        if (msg.operator && msg.operator !== nickname.value) {
          const name = msg.items && msg.items.length
            ? msg.items.map(i => i.commodity).slice(0, 3).join('、') + (msg.items.length > 3 ? ' 等' : '')
            : '价格'
          ElMessage.info(`${msg.operator} 更新了 ${msg.server} · ${msg.city} 的${name}`)
        }
        return
      }
      if (msg.type === 'master.changed') {
        if (msg.server && msg.server !== accountServer.value) return
        masterAccountId.value = msg.masterAccountId || null
        masterAccountName.value = msg.masterAccountName || ''
        isMaster.value = !!msg.masterAccountName && msg.masterAccountName === nickname.value
        refreshMasterMeta()
        if (queried.value) {
          if (rows.value.some(isDirty)) ElMessage.warning('主账号已变更，你本地有未保存修改；保存时会提示冲突')
          else doFetch(false)
        }
        ElMessage.info(msg.masterAccountName ? `主账号已变更为「${msg.masterAccountName}」` : '主账号已取消')
        return
      }
      if (msg.type === 'master.preference') {
        if (masterSaving.value) return
        if (msg.allowed !== undefined) masterPricesAllowed.value = !!msg.allowed
        viewMasterPrices.value = !!msg.enabled
        if (queried.value) {
          if (rows.value.some(isDirty)) ElMessage.warning('主账号价格共享设置已更新，你本地有未保存修改')
          else doFetch(false)
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
        ElMessage.success(`游戏同步完成：${r.queried}/${r.cities} 城，写入 ${r.saved} 条${r.events ? `，大事件 ${r.events} 项` : ''}${r.failed && r.failed.length ? `，失败 ${r.failed.length} 城` : ''}`)
        if (r.newCities && r.newCities.length) loadDict().catch(() => {})
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
          body: {
            server: form.server.trim(), city: form.city, operator: nickname.value,
            relief: taxRelief.value, items, force: force === true,
          },
        })
        ElMessage.success(`保存成功：新增 ${res.created} 条，更新 ${res.updated} 条${res.cleared ? `，清空 ${res.cleared} 条` : ''}`)
        accountServer.value = form.server.trim()
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

    /* ---------- 设备管理 ---------- */
    const devicesVisible = ref(false)
    const devicesLoading = ref(false)
    const devices = ref([])
    const deviceLimit = ref(3)

    const loadDevices = async () => {
      devicesLoading.value = true
      try {
        const data = await api('/api/auth/devices')
        devices.value = data.items || []
        deviceLimit.value = Math.max(1, Number(data.limit) || 3)
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        devicesLoading.value = false
      }
    }

    const openDevices = () => {
      devicesVisible.value = true
      loadDevices()
    }

    const kickDevice = async device => {
      try {
        await ElMessageBox.confirm(
          device.current
            ? '移除当前设备记录将注销本机并返回入口，是否继续？'
            : `确定移除设备「${device.deviceName || '未知设备'}」？该设备的全部登录会话将立即失效。`,
          '移除设备记录',
          { type: 'warning', confirmButtonText: '移 除', cancelButtonText: '取 消' }
        )
      } catch (e) { return }
      try {
        await api(`/api/auth/devices/${device.id}`, { method: 'DELETE' })
        if (device.current) { await switchAccount(); return }
        ElMessage.success('已移除该设备记录')
        await loadDevices()
      } catch (e) { ElMessage.error(e.message) }
    }

    const kickOtherDevices = async () => {
      const others = devices.value.filter(device => !device.current).length
      if (!others) { ElMessage.info('没有其他设备记录'); return }
      try {
        await ElMessageBox.confirm(
          `将移除其他 ${others} 台设备记录，并注销这些设备的全部登录会话，是否继续？`,
          '移除其他设备',
          { type: 'warning', confirmButtonText: '移 除', cancelButtonText: '取 消' }
        )
      } catch (e) { return }
      try {
        const res = await api('/api/auth/devices/kick-others', { method: 'POST' })
        ElMessage.success(res.count ? `已移除其他 ${res.count} 台设备记录` : '没有其他设备记录')
        await loadDevices()
      } catch (e) { ElMessage.error(e.message) }
    }

    /* ---------- 更新日志 ---------- */
    const historyVisible = ref(false)
    const historyList = ref([])
    const historySource = ref(null)

    const loadHistory = async () => {
      try {
        const res = await api(`/api/prices/history?server=${encodeURIComponent(form.server.trim())}&city=${encodeURIComponent(form.city)}&limit=100&relief=${taxRelief.value}`)
        historyList.value = res.items
        historySource.value = res.source || null
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
          relief: String(taxRelief.value),
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
        const q = new URLSearchParams({ server: form.server.trim(), commodity: matrixCommodity.value, relief: String(taxRelief.value) })
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
      if (!matrixSellCity.value) return null
      const it = (matrixData.value.items || []).find(i => i.city === matrixSellCity.value)
      return it && it.sell != null ? it : null
    })

    const matrixRows = computed(() => matrixData.value.items || [])

    /* ---------- 批量导入（Excel / 文本） ---------- */
    const importVisible = ref(false)
    const importFileName = ref('')
    const importPreview = ref([])
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
            relief: taxRelief.value,
            rows: rowsIn,
            merge: importMerge.value,
          },
        })
        ElMessage.success(`导入完成：新增 ${res.created} 条，更新 ${res.updated} 条`)
        importVisible.value = false
        accountServer.value = form.server.trim()
        await refreshMasterMeta()
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
        const q = new URLSearchParams({ server: form.server.trim(), city: form.city, relief: String(taxRelief.value) })
        const res = await signedFetch(`/api/prices/export?${q.toString()}`)
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
    const syncServerLoading = ref(false)
    const syncOperator = ref('')
    const syncResult = ref(null)
    const syncHasSavedToken = computed(() => !!accountToken.value)

    const resolveSyncServer = async () => {
      const typed = syncToken.value.trim()
      if (!typed && !syncHasSavedToken.value) { syncServer.value = ''; return }
      syncServerLoading.value = true
      try {
        const info = await api('/api/game/token-info', {
          method: 'POST',
          body: { token: typed || undefined },
        })
        syncServer.value = info.server
        if (!typed) accountServer.value = info.server
      } catch (e) {
        syncServer.value = ''
        if (typed) ElMessage.warning(`区服识别失败：${e.message}`)
      } finally {
        syncServerLoading.value = false
      }
    }

    const onSyncTokenPaste = () => setTimeout(resolveSyncServer, 50)

    const openSync = async () => {
      syncVisible.value = true
      syncResult.value = null
      syncServer.value = ''
      syncOperator.value = nickname.value
      syncToken.value = ''
      try {
        const me = await api('/api/auth/me')
        accountToken.value = me.token || ''
        accountServer.value = me.currentServer || accountServer.value
        allowSyncServer.value = !!me.allowSyncServer
        applyExpiry(me)
        applyMasterMeta(me)
      } catch (e) { /* 忽略 */ }
      await resolveSyncServer()
    }

    const doSync = async () => {
      if (!syncToken.value.trim() && !syncHasSavedToken.value) {
        ElMessage.warning('请粘贴游戏登录 token（保存后仅本账号可见，可复用）')
        return
      }
      syncing.value = true
      syncResult.value = null
      try {
        const typed = syncToken.value.trim()
        const body = {
          token: typed || undefined,
          operator: syncOperator.value || nickname.value,
        }
        if (allowSyncServer.value && syncServer.value.trim()) body.server = syncServer.value.trim()
        const result = await api('/api/game/sync', { method: 'POST', body })
        if (typed) {
          accountToken.value = typed
          syncToken.value = ''
        }
        syncResult.value = result
        syncServer.value = result.server
        accountServer.value = result.server
        const eventSuffix = result.events ? `，大事件 ${result.events} 项` : ''
        if (result.saved > 0) ElMessage.success(`同步完成：${result.queried}/${result.cities} 城，写入 ${result.saved} 条${eventSuffix}`)
        else ElMessage.warning(`同步完成，但没有写入价格（${result.queried}/${result.cities} 城）${eventSuffix}`)
        if (result.newCities && result.newCities.length) await loadDict()
        await loadServers()
        if (form.server.trim() === result.server && queried.value) await doFetch(false)
        else await refreshMasterMeta()
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
      enabled: false, cron: '0 */2 * * *', token: '', server: '', serverOverride: '', operator: '自动同步',
      allowSyncServer: false, hasToken: false, status: 'active', expiresAt: null,
      running: false, lastRunAt: null, lastStatus: null, lastMessage: null,
    })

    const applySettings = (data, ownToken) => {
      if (!data) return
      settings.enabled = !!data.enabled
      settings.cron = data.cron || '0 */2 * * *'
      settings.server = String(data.server || '').trim()
      settings.serverOverride = String(data.serverOverride || '').trim()
      settings.allowSyncServer = !!data.allowSyncServer
      settings.operator = data.operator || '自动同步'
      settings.hasToken = !!data.hasToken
      settings.status = data.status || 'active'
      settings.expiresAt = data.expiresAt || null
      settings.running = !!data.running
      settings.lastRunAt = data.lastRunAt
      settings.lastStatus = data.lastStatus
      settings.lastMessage = data.lastMessage
      if (ownToken !== undefined) settings.token = ownToken
      if (CRON_PRESETS.some(p => p.value === settings.cron)) {
        cronPreset.value = settings.cron
      } else {
        cronPreset.value = 'custom'
        cronCustom.value = settings.cron
      }
    }

    const onSettingsTokenPaste = () => setTimeout(resolveSettingsServer, 50)

    const resolveSettingsServer = async () => {
      const typed = String(settings.token || '').trim()
      if (!typed && !settings.hasToken) { settings.server = ''; return }
      try {
        const info = await api('/api/game/token-info', {
          method: 'POST',
          body: { token: typed || undefined },
        })
        settings.server = info.server
      } catch (e) {
        if (typed) ElMessage.warning(`区服识别失败：${e.message}`)
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
        applySettings(data, '')
        syncLogs.value = logs.items
        if (!settings.operator) settings.operator = nickname.value
        await resolveSettingsServer()
      } catch (e) { ElMessage.error(e.message) } finally { settingsLoading.value = false }
    }

    const saveSettings = async () => {
      const cron = cronPreset.value === 'custom' ? cronCustom.value.trim() : cronPreset.value
      if (!cron) { ElMessage.warning('请填写 cron 表达式'); return }
      const token = String(settings.token || '').trim()
      if (settings.enabled && !token && !settings.hasToken) {
        ElMessage.warning('启用自动同步需要填写登录 token')
        return
      }
      settingsSaving.value = true
      try {
        const body = {
          enabled: settings.enabled,
          cron,
          operator: settings.operator,
        }
        if (settings.allowSyncServer) body.server = String(settings.serverOverride || '').trim()
        if (token) body.token = token
        const data = await api('/api/sync-settings', { method: 'PUT', body })
        if (token) accountToken.value = token
        applySettings(data, '')
        if (token) {
          settings.token = ''
          await resolveSettingsServer()
        }
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
        ElMessage.success(`同步完成：${result.queried}/${result.cities} 城，写入 ${result.saved} 条${result.events ? `，大事件 ${result.events} 项` : ''}`)
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
          const q = new URLSearchParams({ server: reportServer.value.trim(), days: String(reportDays.value), limit: '30', relief: String(taxRelief.value) })
          moversData.value = await api(`/api/reports/movers?${q.toString()}`)
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
      loadPublicConfig()

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
          const me = await api('/api/auth/me')
          accountToken.value = me.token || ''
          accountServer.value = me.currentServer || ''
          allowSyncServer.value = !!me.allowSyncServer
          applyExpiry(me)
          applyMasterMeta(me)
          if (!form.server && accountServer.value) form.server = accountServer.value
          taxRelief.value = clampRelief(me.relief)
          savedRelief.value = taxRelief.value
          try { localStorage.setItem(RELIEF_KEY, String(taxRelief.value)) } catch (e) { /* 忽略隐私模式等 */ }
          if (me.name && me.name !== nickname.value) {
            nickname.value = me.name
            try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ name: me.name, session: accountSession })) } catch (e) { /* 忽略 */ }
          }
        } catch (e) {
          if (e.status === 401 || e.status === 403) {
            accountSession = ''
            sessionOk.value = false
            nickname.value = ''
            try { localStorage.removeItem(ACCOUNT_KEY) } catch (err) { /* 忽略 */ }
            ElMessage.warning(e.status === 403 ? e.message : '登录已失效，请重新登录')
            return
          }
        }
        try {
          await loadData()
          connectWs()
        } catch (e) {
          ElMessage.error('数据加载失败，请刷新重试')
        }
        if (!accountServer.value) openServerPicker(true)
      }
    })

    onUnmounted(() => {
      mql.removeEventListener('change', onMqlChange)
      window.removeEventListener('keydown', onKeydown)
      disconnectWs()
    })

    return {
      // 账号入口
      nickname, nicknameInput, passwordInput, keyInput, entering, entered, enterSite, switchAccount,
      authMode, setAuthMode, authHint, renewVisible, renewKey, renewMessage, openRenew, submitRenew,
      accountServer, serverVisible, serverInput, serverSaving, serverRequired,
      openServerPicker, saveServer, allowSyncServer, deviceName,
      masterAccountId, masterAccountName, isMaster, masterPricesAllowed, viewMasterPrices, masterSaving, onViewMasterChange,
      keyRequired, keyRequiredAtText, keyPlaceholder, keyHelpHtml, tokenHelpHtml,
      expiryText, expiryShortText, expiryTooltip, expiryTagType,
      // 基础
      isMobile, form, cities, commodities, serverList, rows, queried, loading, sharedCount,
      cityEvents, activeEventCount, cityEventText, eventTip, eventLabel,
      // 赋税减免
      taxRelief, currentTax, onReliefChange,
      // 实时协作
      wsConnected, wsClients, conflictCount,
      // 查询
      searchServers, onQuery, onReset, doFetch,
      // 编辑
      onPriceInput, onPriceBlur, copyPrev, clearRow, isDirty, stats,
      rowClass,
      changedCount, changedRows, canSave,
      // 保存
      saveVisible, onSave, confirmSave, saving, rowOpType, rowOpText,
      // 设备
      devicesVisible, devicesLoading, devices, deviceLimit,
      openDevices, loadDevices, kickDevice, kickOtherDevices,
      // 日志 / 趋势 / 比价
      historyVisible, historyList, historySource, openHistory, loadHistory,
      trendVisible, trendCommodity, trendDays, trendLoading, trendData, trendPoints,
      trendChart, openTrend, loadTrend,
      trendView, trendDragging, zoomTrend, resetTrendView, onTrendWheel,
      onTrendMouseDown, onTrendMouseMove, onTrendMouseUp,
      matrixVisible, matrixCommodity, matrixLoading, matrixData, openMatrix, loadMatrix,
      matrixSellCity, matrixSellTarget, matrixRows,
      // 导入导出
      importVisible, importFileName, importPreview, importMerge, importing,
      importFileEl, openImport, clearImportFile, onImportFile, downloadImportTemplate, submitImport,
      exportCsv,
      // 游戏同步
      syncVisible, syncing, syncToken, syncServer, syncServerLoading, syncOperator, syncResult, syncHasSavedToken,
      openSync, doSync, resolveSyncServer, onSyncTokenPaste,
      // 定时设置
      settingsVisible, settingsLoading, settingsSaving, settingsRunning, settings, cronPreset, cronCustom,
      cronPresets: CRON_PRESETS, syncLogs, openSettings, saveSettings, runSettingsSync,
      resolveSettingsServer, onSettingsTokenPaste,
      // 报表
      reportVisible, reportTab, reportServer, reportLoading, reportDays, moversData,
      heatData, heatBucket, heatDays, heatBars, openReports, loadReport, onReportTabChange, changeClass,
    }
  },
}).use(ElementPlus, { locale: zhCn }).mount('#app')
