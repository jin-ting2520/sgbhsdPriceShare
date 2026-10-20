import { createApp, reactive, ref } from 'vue'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import zhCn from 'element-plus/locale/zh-cn'

const TOKEN_KEY = 'sgbhsd.admin.v1'

const readToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

createApp({
  setup() {
    const token = ref(readToken())
    const password = ref('')
    const loggingIn = ref(false)
    const tab = ref('overview')

    const loading = reactive({ overview: false, keys: false, accounts: false, dict: false, servers: false, settings: false, logs: false })
    const overview = reactive({ accounts: 0, banned: 0, expired: 0, sessions: 0, keysUnused: 0, keysUsed: 0, prices: 0, history: 0, servers: 0, syncOk: 0, syncTotal: 0, adminTtlHours: 168 })

    async function api(path, { method = 'GET', body } = {}) {
      const headers = { 'X-Admin-Token': token.value }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!json) throw new Error(`服务异常（HTTP ${res.status}）`)
      if (json.code !== 0) {
        const err = new Error(json.message || '请求失败')
        err.status = res.status
        err.code = json.code
        err.data = json.data
        if (res.status === 401) {
          token.value = ''
          try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
          ElMessage.warning('管理登录已过期，请重新登录')
        }
        throw err
      }
      return json.data
    }

    const run = async (key, fn) => {
      loading[key] = true
      try { return await fn() } catch (e) { ElMessage.error(e.message); return null } finally { loading[key] = false }
    }

    const isCancel = e => e === 'cancel' || e === 'close' || (e && (e.action === 'cancel' || e.action === 'close'))

    const ask = async (message, title, options = {}) => {
      const res = await ElMessageBox.prompt(message, title, { confirmButtonText: '确 定', cancelButtonText: '取 消', ...options })
      return String(res.value || '').trim()
    }

    const confirm = (message, title, options = {}) => ElMessageBox.confirm(message, title, {
      type: 'warning', confirmButtonText: '确 定', cancelButtonText: '取 消', ...options,
    })

    const login = async () => {
      if (!password.value) { ElMessage.warning('请输入管理密码'); return }
      loggingIn.value = true
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.value }),
        })
        const json = await res.json().catch(() => null)
        if (!json) throw new Error(`服务异常（HTTP ${res.status}）`)
        if (json.code !== 0) throw new Error(json.message || '登录失败')
        token.value = json.data.token
        try { localStorage.setItem(TOKEN_KEY, token.value) } catch { /* ignore */ }
        password.value = ''
        ElMessage.success('已登录管理后台')
        await Promise.all([loadOverview(), loadKeys(1)])
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        loggingIn.value = false
      }
    }

    const logout = async () => {
      try { await api('/api/admin/logout', { method: 'POST' }) } catch { /* ignore */ }
      token.value = ''
      try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
    }

    const loadOverview = () => run('overview', async () => {
      Object.assign(overview, await api('/api/admin/overview'))
    })

    const keys = reactive({ items: [], total: 0, page: 1, pageSize: 50 })
    const keyFilter = reactive({ q: '', status: '', type: '' })
    const keyForm = reactive({ type: 'month', count: 10, note: '' })
    const createdCodes = ref([])
    const createdBatch = ref('')
    const batches = ref([])

    const loadKeys = page => run('keys', async () => {
      const p = Number(page) || keys.page
      const q = new URLSearchParams({ page: String(p), pageSize: String(keys.pageSize) })
      if (keyFilter.q) q.set('q', keyFilter.q)
      if (keyFilter.status) q.set('status', keyFilter.status)
      if (keyFilter.type) q.set('type', keyFilter.type)
      const data = await api(`/api/admin/keys?${q.toString()}`)
      keys.items = data.items
      keys.total = data.total
      keys.page = data.page
    })

    const loadBatches = () => run('keys', async () => {
      batches.value = await api('/api/admin/batches')
    })

    const createKeys = () => run('keys', async () => {
      const data = await api('/api/admin/keys', {
        method: 'POST',
        body: { type: keyForm.type, count: keyForm.count, note: keyForm.note },
      })
      createdCodes.value = data.codes
      createdBatch.value = data.batchId
      ElMessage.success(`已生成 ${data.codes.length} 张${data.typeName}卡密`)
      await Promise.all([loadKeys(1), loadBatches()])
    })

    const exportKeys = async () => {
      try {
        const q = new URLSearchParams()
        if (keyFilter.q) q.set('q', keyFilter.q)
        if (keyFilter.status) q.set('status', keyFilter.status)
        if (keyFilter.type) q.set('type', keyFilter.type)
        const res = await fetch(`/api/admin/keys/export?${q.toString()}`, {
          headers: { 'X-Admin-Token': token.value },
        })
        if (!res.ok) {
          const j = await res.json().catch(() => null)
          throw new Error((j && j.message) || `导出失败（HTTP ${res.status}）`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = '卡密导出.csv'
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (e) { ElMessage.error(e.message) }
    }

    const copyCodes = async () => {
      try {
        await navigator.clipboard.writeText(createdCodes.value.join('\n'))
        ElMessage.success('已复制到剪贴板')
      } catch { ElMessage.warning('复制失败，请手动选择文本复制') }
    }

    const bindKey = async row => {
      try {
        const accountName = await ask(
          `卡密：${row.code}\n类型：${row.typeName}\n\n输入要绑定的账号昵称。绑定后立即消耗卡密，有效期从账号当前到期时间（已过期则从现在）顺延；永久有效账号从现在按卡密时长重新计时。`,
          '绑定卡密',
          { inputPlaceholder: '账号昵称' }
        )
        if (!accountName) return
        const data = await api(`/api/admin/keys/${row.id}/bind`, {
          method: 'POST',
          body: { accountName },
        })
        ElMessage.success(data.expiresAt
          ? `已绑定到「${data.accountName}」，到期 ${data.expiresAt}`
          : `已绑定到「${data.accountName}」，永久有效`)
        await Promise.all([loadKeys(keys.page), loadBatches(), loadOverview(), loadAccounts(accounts.page)])
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const revokeKey = async row => {
      try {
        await confirm(`确定作废卡密 ${row.code}？作废后不可使用。`, '作废卡密')
        await api('/api/admin/keys/revoke', { method: 'POST', body: { ids: [row.id] } })
        ElMessage.success('卡密已作废')
        await Promise.all([loadKeys(keys.page), loadBatches()])
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const revokeBatch = async row => {
      try {
        await confirm(`确定作废批次 ${row.batchId} 中全部未使用卡密？`, '作废批次')
        const data = await api('/api/admin/keys/revoke', { method: 'POST', body: { batchId: row.batchId } })
        ElMessage.success(`已作废 ${data.revoked} 张卡密`)
        await Promise.all([loadKeys(1), loadBatches()])
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const accounts = reactive({ items: [], total: 0, page: 1, pageSize: 50 })
    const accountFilter = reactive({ q: '', status: '' })

    const loadAccounts = page => run('accounts', async () => {
      const p = Number(page) || accounts.page
      const q = new URLSearchParams({ page: String(p), pageSize: String(accounts.pageSize) })
      if (accountFilter.q) q.set('q', accountFilter.q)
      if (accountFilter.status) q.set('status', accountFilter.status)
      const data = await api(`/api/admin/accounts?${q.toString()}`)
      accounts.items = data.items
      accounts.total = data.total
      accounts.page = data.page
    })

    const afterAccountChange = async () => {
      await loadAccounts(accounts.page)
      await loadOverview()
    }

    const accountAction = async (row, cmd) => {
      try {
        if (cmd === 'extend') {
          const days = await ask('续期天数（从当前到期时间与现在二者较晚者起算）', '续期', {
            inputValue: '30', inputPattern: /^\d+$/, inputErrorMessage: '请输入正整数天数',
          })
          await api(`/api/admin/accounts/${row.id}/expires`, { method: 'POST', body: { extendDays: Number(days) } })
          ElMessage.success(`已续期 ${days} 天`)
        } else if (cmd === 'renew') {
          const code = await ask('输入未使用的卡密（每张卡密只能使用一次，有效期从当前到期时间顺延；永久账号从现在重新计时）', '使用卡密续期', {
            inputPlaceholder: 'XXXX-XXXX-XXXX-XXXX',
          })
          const data = await api(`/api/admin/accounts/${row.id}/expires`, { method: 'POST', body: { keyCode: code } })
          ElMessage.success(data.expiresAt ? `卡密已绑定，到期 ${data.expiresAt}` : '永久卡密已绑定')
        } else if (cmd === 'expires') {
          const value = await ask('格式 YYYY-MM-DD HH:MM:SS；留空表示永久', '设置到期时间', {
            inputValue: row.expiresAt || '', inputPlaceholder: '2026-12-31 23:59:59',
          })
          await api(`/api/admin/accounts/${row.id}/expires`, { method: 'POST', body: { expiresAt: value } })
          ElMessage.success('到期时间已更新')
        } else if (cmd === 'device') {
          const limit = await ask('该账号最多同时登录设备数（1~50）', '设备上限', {
            inputValue: String(row.deviceLimit), inputPattern: /^\d+$/, inputErrorMessage: '请输入 1~50 的整数',
          })
          await api(`/api/admin/accounts/${row.id}/device-limit`, { method: 'POST', body: { limit: Number(limit) } })
          ElMessage.success('设备上限已更新')
        } else if (cmd === 'allow-server' || cmd === 'deny-server') {
          const allow = cmd === 'allow-server'
          await confirm(
            allow
              ? `允许「${row.name}」在同步时手动提交区服参数？开启后该用户可覆盖 token 自动识别的区服。`
              : `禁止「${row.name}」提交区服参数？同步将恢复为按 token 自动识别区服。`,
            '区服参数权限'
          )
          await api(`/api/admin/accounts/${row.id}/sync-server`, { method: 'POST', body: { allow } })
          ElMessage.success(allow ? '已允许传区服参数' : '已禁止传区服参数')
        } else if (cmd === 'allow-master-prices' || cmd === 'deny-master-prices') {
          const allowed = cmd === 'allow-master-prices'
          await confirm(
            allowed
              ? `允许「${row.name}」共享主账号价格？用户端将显示「主账号价」开关并默认开启共享。`
              : `禁止「${row.name}」共享主账号价格？用户端将隐藏「主账号价」开关并停止共享。`,
            '主账号价格共享',
            { type: allowed ? 'info' : 'warning' }
          )
          await api(`/api/admin/accounts/${row.id}/master-prices`, { method: 'POST', body: { allowed } })
          ElMessage.success(allowed ? '已开启主账号价格共享' : '已关闭主账号价格共享')
          await afterAccountChange()
        } else if (cmd === 'set-current-master' || cmd === 'clear-current-master') {
          if (!row.currentServer) { ElMessage.warning('该账号尚未设置当前区服'); return }
          const master = cmd === 'set-current-master'
          await confirm(
            master
              ? `把「${row.name}」设为区服 ${row.currentServer} 的主账号？该区服普通账号将默认开启主账号价格共享。`
              : `取消「${row.name}」在区服 ${row.currentServer} 的主账号身份？该区服的主账号价格共享将关闭。`,
            '主账号设置',
            { type: master ? 'warning' : 'warning' }
          )
          await api(`/api/admin/accounts/${row.id}/master`, { method: 'POST', body: { master } })
          ElMessage.success(master ? `已设为 ${row.currentServer} 的主账号` : `已取消 ${row.currentServer} 的主账号`)
          await loadServers()
        } else if (cmd === 'password') {
          const pwd = await ask(`为「${row.name}」设置新密码（4~64 位），保存后该账号全部设备将下线`, '重置密码', {
            inputType: 'password', inputPattern: /^.{4,64}$/, inputErrorMessage: '密码长度应为 4~64 位',
          })
          await api(`/api/admin/accounts/${row.id}/password`, { method: 'POST', body: { password: pwd } })
          ElMessage.success('密码已重置，全部会话已注销')
        } else if (cmd === 'kick') {
          await confirm(`确定让「${row.name}」的全部设备立即下线？`, '踢下线')
          const data = await api(`/api/admin/accounts/${row.id}/kick`, { method: 'POST' })
          ElMessage.success(`已注销 ${data.count} 个会话`)
        } else if (cmd === 'ban' || cmd === 'unban') {
          const status = cmd === 'ban' ? 'banned' : 'active'
          await confirm(cmd === 'ban' ? `确定封禁「${row.name}」？封禁后立即下线且无法登录。` : `确定解封「${row.name}」？`, '账号状态')
          await api(`/api/admin/accounts/${row.id}/status`, { method: 'POST', body: { status } })
          ElMessage.success(cmd === 'ban' ? '已封禁' : '已解封')
        } else if (cmd === 'delete') {
          await confirm(`删除账号「${row.name}」将清空其全部价格、历史、同步日志且不可恢复。`, '删除账号', {
            type: 'error', confirmButtonText: '继续',
          })
          const typed = await ask(`请输入账号昵称「${row.name}」以确认删除`, '危险操作', {
            inputPlaceholder: row.name,
          })
          if (typed !== row.name) { ElMessage.warning('昵称不一致，已取消'); return }
          await api(`/api/admin/accounts/${row.id}?confirm=${encodeURIComponent(row.name)}`, { method: 'DELETE' })
          ElMessage.success('账号已删除')
        }
        await afterAccountChange()
      } catch (e) {
        if (!isCancel(e)) ElMessage.error(e.message)
      }
    }

    const dictType = ref('city')
    const dictItems = ref([])
    const newDictName = ref('')
    const newDictBurden = ref('')

    const loadDict = () => run('dict', async () => {
      dictItems.value = await api(`/api/admin/dict?type=${encodeURIComponent(dictType.value)}`)
    })

    const addDict = () => run('dict', async () => {
      const name = newDictName.value.trim()
      if (!name) { ElMessage.warning('请输入名称'); return }
      const body = { type: dictType.value, name }
      if (dictType.value === 'commodity' && newDictBurden.value !== '') body.burden = Number(newDictBurden.value)
      await api('/api/admin/dict', { method: 'POST', body })
      ElMessage.success('已新增')
      newDictName.value = ''
      newDictBurden.value = ''
      await loadDict()
    })

    const renameDict = async row => {
      try {
        const name = await ask('输入新名称', '修改名称', { inputValue: row.name, inputPattern: /^.{1,50}$/ })
        await api(`/api/admin/dict/${row.id}`, { method: 'PUT', body: { name } })
        ElMessage.success('已改名')
        await loadDict()
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const setBurden = async row => {
      try {
        const value = await ask('输入负重（留空表示未设置）', '修改负重', {
          inputValue: row.burden == null ? '' : String(row.burden), inputPlaceholder: '如 18',
        })
        await api(`/api/admin/dict/${row.id}`, { method: 'PUT', body: { burden: value } })
        ElMessage.success('负重已更新')
        await loadDict()
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const deleteDict = async row => {
      try {
        await confirm(`确定删除「${row.name}」？`, '删除字典项')
        try {
          await api(`/api/admin/dict/${row.id}`, { method: 'DELETE' })
        } catch (e) {
          if (e.code !== 40901) throw e
          await confirm(e.message, '该项已被价格引用', { type: 'error', confirmButtonText: '连同价格一起删除' })
          await api(`/api/admin/dict/${row.id}?force=1`, { method: 'DELETE' })
        }
        ElMessage.success('已删除')
        await loadDict()
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const servers = ref([])
    const newServer = ref('')
    const serverMasterSaving = ref(0)

    const loadServers = () => run('servers', async () => {
      servers.value = await api('/api/admin/servers')
    })

    const setServerMaster = async (row, accountId) => {
      serverMasterSaving.value = row.id
      try {
        const id = accountId == null || accountId === '' ? null : Number(accountId)
        await api(`/api/admin/servers/${row.id}/master`, { method: 'POST', body: { accountId: id } })
        ElMessage.success(id ? '已设置本区服主账号' : '已取消本区服主账号')
        await Promise.all([loadServers(), loadAccounts(accounts.page)])
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        serverMasterSaving.value = 0
      }
    }

    const addServer = () => run('servers', async () => {
      const name = newServer.value.trim()
      if (!name) { ElMessage.warning('请输入区服名称'); return }
      await api('/api/admin/servers', { method: 'POST', body: { name } })
      ElMessage.success('已新增区服')
      newServer.value = ''
      await loadServers()
    })

    const renameServer = async row => {
      try {
        const name = await ask('输入新区服名称（会同步更新定时设置与账号当前区服）', '区服改名', { inputValue: row.name })
        await api(`/api/admin/servers/${row.id}`, { method: 'PUT', body: { name } })
        ElMessage.success('已改名')
        await loadServers()
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const deleteServer = async row => {
      try {
        await confirm(`确定删除区服「${row.name}」？`, '删除区服')
        try {
          await api(`/api/admin/servers/${row.id}`, { method: 'DELETE' })
        } catch (e) {
          if (e.code !== 40902) throw e
          await confirm(e.message, '该区服已有价格数据', { type: 'error', confirmButtonText: '连同价格一起删除' })
          await api(`/api/admin/servers/${row.id}?force=1`, { method: 'DELETE' })
        }
        ElMessage.success('已删除')
        await loadServers()
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const appSettings = reactive({
      registrationEnabled: true,
      announcement: '',
      keyHelpMd: '',
      tokenHelpMd: '',
      keyHelpHtml: '',
      tokenHelpHtml: '',
      keyRequiredAt: '2026-10-22 00:00:00',
      keyRequired: false,
      defaultDeviceLimit: 3,
    })
    const previewing = reactive({ key: false, token: false })

    const loadSettings = () => run('settings', async () => {
      Object.assign(appSettings, await api('/api/admin/settings'))
    })

    const saveSettings = () => run('settings', async () => {
      const body = {
        registrationEnabled: appSettings.registrationEnabled,
        announcement: appSettings.announcement,
        keyHelpMd: appSettings.keyHelpMd,
        tokenHelpMd: appSettings.tokenHelpMd,
        keyRequiredAt: appSettings.keyRequiredAt,
        defaultDeviceLimit: appSettings.defaultDeviceLimit,
      }
      const data = await api('/api/admin/settings', { method: 'PUT', body })
      Object.assign(appSettings, data)
      ElMessage.success('设置已保存')
    })

    const previewHelp = async kind => {
      const isKey = kind === 'key'
      previewing[kind] = true
      try {
        const data = await api('/api/admin/markdown/preview', {
          method: 'POST',
          body: { text: isKey ? appSettings.keyHelpMd : appSettings.tokenHelpMd },
        })
        if (isKey) appSettings.keyHelpHtml = data.html
        else appSettings.tokenHelpHtml = data.html
      } catch (e) {
        ElMessage.error(e.message)
      } finally {
        previewing[kind] = false
      }
    }

    const logs = reactive({ items: [], total: 0, page: 1, pageSize: 50 })
    const logAccountId = ref('')

    const loadLogs = page => run('logs', async () => {
      const p = Number(page) || logs.page
      const q = new URLSearchParams({ page: String(p), pageSize: String(logs.pageSize) })
      if (logAccountId.value) q.set('accountId', String(Number(logAccountId.value) || ''))
      const data = await api(`/api/admin/sync-logs?${q.toString()}`)
      logs.items = data.items
      logs.total = data.total
      logs.page = data.page
    })

    const clearLogs = async () => {
      try {
        await confirm('确定清空全部同步日志？该操作不可恢复。', '清空日志', { type: 'error' })
        const data = await api('/api/admin/sync-logs', { method: 'DELETE' })
        ElMessage.success(`已删除 ${data.deleted} 条日志`)
        await loadLogs(1)
      } catch (e) { if (!isCancel(e)) ElMessage.error(e.message) }
    }

    const onTabChange = name => {
      if (name === 'overview') loadOverview()
      else if (name === 'keys') { loadKeys(keys.page); loadBatches() }
      else if (name === 'accounts') loadAccounts(accounts.page)
      else if (name === 'dict') loadDict()
      else if (name === 'servers') loadServers()
      else if (name === 'settings') loadSettings()
      else if (name === 'logs') loadLogs(logs.page)
    }

    if (token.value) {
      loadOverview()
      loadKeys(1)
    }

    return {
      token, password, loggingIn, login, logout,
      tab, onTabChange, loading, overview, loadOverview,
      keys, keyFilter, keyForm, createdCodes, createdBatch, batches,
      loadKeys, loadBatches, createKeys, exportKeys, copyCodes, bindKey, revokeKey, revokeBatch,
      accounts, accountFilter, loadAccounts, accountAction,
      dictType, dictItems, newDictName, newDictBurden, loadDict, addDict, renameDict, setBurden, deleteDict,
      servers, newServer, serverMasterSaving, loadServers, addServer, setServerMaster, renameServer, deleteServer,
      appSettings, previewing, loadSettings, saveSettings, previewHelp,
      logs, logAccountId, loadLogs, clearLogs,
    }
  },
}).use(ElementPlus, { locale: zhCn }).mount('#admin')
