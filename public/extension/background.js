/**
 * Mirage Extension â€” Background Service Worker (v1.5)
 * --------------------------------------------------------------------
 * Auto-capture + Chrome/Edge primaryâ€“fallback sessions.
 * Syncs providers from heartbeat, captures new platforms immediately,
 * runs credential tests, solves Z.AI Aliyun captcha, and executes
 * mirage_* local tools.
 */

const BACKEND_KEY = 'mirage_backend_url'
const DEVICE_KEY = 'mirage_device_id'
const DEVICE_SECRET_KEY = 'mirage_device_secret'
const PROVIDERS_KEY = 'mirage_providers'
const CAPTURE_LOG_KEY = 'mirage_capture_log'
const OBSERVED_TOKENS_KEY = 'mirage_observed_tokens'
const OBSERVED_CAPTCHA_KEY = 'mirage_observed_captcha'
const OPENED_TABS_KEY = 'mirage_opened_for_capture'
const QWEN_BX_KEY = 'mirage_qwen_bx'

/** Latest BaXia risk-control headers from chat.qwen.ai (empty stream without these). */
let latestQwenBx = null

const DEFAULT_BACKEND = 'http://localhost:3000'

const DEFAULT_PROVIDER_DOMAINS = {
  kimi: 'https://www.kimi.com',
  zai: 'https://chat.z.ai',
  deepseek: 'https://chat.deepseek.com',
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  qwen: 'https://tongyi.aliyun.com/qianwen',
  arena: 'https://arena.ai',
  huggingface: 'https://huggingface.co',
  dola: 'https://www.dola.com',
  venice: 'https://venice.ai',
  t3: 'https://t3.chat',
  meta: 'https://www.meta.ai',
}

let PROVIDER_DOMAINS = { ...DEFAULT_PROVIDER_DOMAINS }
let DOMAIN_TO_PROVIDER = rebuildDomainIndex(PROVIDER_DOMAINS)

function rebuildDomainIndex(domains) {
  const m = {}
  for (const [k, v] of Object.entries(domains)) {
    if (!v) continue
    try {
      const host = new URL(v).host
      m[host] = k
      if (host.startsWith('www.')) m[host.slice(4)] = k
    } catch {
      const host = String(v).replace(/^https?:\/\//, '').split('/')[0]
      m[host] = k
    }
  }
  return m
}

function mergeProviderDomains(providers) {
  const next = { ...DEFAULT_PROVIDER_DOMAINS }
  for (const p of providers || []) {
    if (p?.key && p?.websiteUrl) next[p.key] = p.websiteUrl
  }
  PROVIDER_DOMAINS = next
  DOMAIN_TO_PROVIDER = rebuildDomainIndex(next)
}

function detectBrowser() {
  const ua = navigator.userAgent || ''
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'chrome'
  return 'other'
}

function providerKeyFromDomain(domain) {
  if (!domain) return null
  const clean = domain.replace(/^\./, '')
  if (DOMAIN_TO_PROVIDER[clean]) return DOMAIN_TO_PROVIDER[clean]
  for (const [host, key] of Object.entries(DOMAIN_TO_PROVIDER)) {
    if (clean === host || clean.endsWith('.' + host)) return key
  }
  return null
}

async function getBackendUrl() {
  const v = await chrome.storage.local.get(BACKEND_KEY)
  return v[BACKEND_KEY] || DEFAULT_BACKEND
}

async function setBackendUrl(url) {
  await chrome.storage.local.set({ [BACKEND_KEY]: url })
}

async function getDeviceId() {
  const v = await chrome.storage.local.get(DEVICE_KEY)
  if (v[DEVICE_KEY]) return v[DEVICE_KEY]
  const id = 'dev_' + crypto.randomUUID()
  await chrome.storage.local.set({ [DEVICE_KEY]: id })
  return id
}

async function getDeviceSecret() {
  const v = await chrome.storage.local.get(DEVICE_SECRET_KEY)
  return v[DEVICE_SECRET_KEY] || null
}

async function setDeviceSecret(secret) {
  if (!secret) return
  await chrome.storage.local.set({ [DEVICE_SECRET_KEY]: secret })
}

async function getProviders() {
  const v = await chrome.storage.local.get(PROVIDERS_KEY)
  return v[PROVIDERS_KEY] || []
}

async function setProviders(list, opts = {}) {
  await getProviders() // ensure storage ready
  await chrome.storage.local.set({ [PROVIDERS_KEY]: list || [] })
  mergeProviderDomains(list)
  // Debounce content-script re-registration — was thrashing every heartbeat.
  scheduleContentScriptSync(list)

  // OAuth connect is owned ONLY by mirage_capture_provider jobs.
  // Never auto-start 4-minute waits from heartbeat provider sync (that hung the browser).
  if (opts.skipCapture !== false && opts.triggerCapture !== true) return

  const nextList = list || []
  for (const p of nextList) {
    if (!p?.key || !p.captureRequestedAt) continue
    console.log(`[mirage] connect capture requested for ${p.key}`)
    oauthConnectCapture(p.key, {
      trigger: 'connect_oauth',
      websiteUrl: p.websiteUrl,
    }).catch((e) => console.warn('[mirage] connect capture failed', p.key, e))
  }
}

let contentScriptSyncTimer = null
function scheduleContentScriptSync(list) {
  if (contentScriptSyncTimer) clearTimeout(contentScriptSyncTimer)
  contentScriptSyncTimer = setTimeout(() => {
    contentScriptSyncTimer = null
    syncContentScripts(list).catch(() => {})
  }, 1500)
}

async function syncContentScripts(providers) {
  const matches = []
  for (const p of providers || []) {
    if (!p?.websiteUrl) continue
    try {
      matches.push(new URL(p.websiteUrl).origin + '/*')
    } catch {
      // skip
    }
  }
  if (matches.length === 0) return
  const id = 'mirage-dynamic-providers'
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    const spec = {
      id,
      matches,
      js: ['content.js'],
      runAt: 'document_start',
      persistAcrossSessions: true,
    }
    if (existing.length) {
      await chrome.scripting.updateContentScripts([spec])
    } else {
      await chrome.scripting.registerContentScripts([spec])
    }
  } catch (e) {
    console.warn('[mirage] dynamic content scripts:', e)
  }
}

async function getCaptureLog() {
  const v = await chrome.storage.local.get(CAPTURE_LOG_KEY)
  return v[CAPTURE_LOG_KEY] || []
}

async function appendCaptureLog(entry) {
  const log = await getCaptureLog()
  log.unshift(entry)
  await chrome.storage.local.set({ [CAPTURE_LOG_KEY]: log.slice(0, 50) })
}

async function getObservedTokens() {
  const v = await chrome.storage.local.get(OBSERVED_TOKENS_KEY)
  return v[OBSERVED_TOKENS_KEY] || {}
}

async function getObservedCaptcha(providerKey) {
  const v = await chrome.storage.local.get(OBSERVED_CAPTCHA_KEY)
  const all = v[OBSERVED_CAPTCHA_KEY] || {}
  return all[providerKey] || null
}

async function rememberObservedCaptcha(providerKey, param) {
  if (!providerKey || !param) return
  const v = await chrome.storage.local.get(OBSERVED_CAPTCHA_KEY)
  const all = v[OBSERVED_CAPTCHA_KEY] || {}
  all[providerKey] = {
    captcha_verify_param: String(param),
    ts: Date.now(),
  }
  await chrome.storage.local.set({ [OBSERVED_CAPTCHA_KEY]: all })
}

async function rememberObservedToken(providerKey, tokenKind, value) {
  if (!providerKey || !value) return
  const all = await getObservedTokens()
  const cur = all[providerKey] || {}
  if (tokenKind === 'refresh') cur.refreshToken = value
  else if (tokenKind === 'access') cur.accessToken = value
  else if (!cur.accessToken) cur.accessToken = value
  cur.updatedAt = Date.now()
  all[providerKey] = cur
  await chrome.storage.local.set({ [OBSERVED_TOKENS_KEY]: all })
}

async function postJSON(path, body) {
  const base = await getBackendUrl()
  const deviceSecret = await getDeviceSecret()
  const payload = { ...(body || {}) }
  if (deviceSecret && payload.deviceSecret == null) {
    payload.deviceSecret = deviceSecret
  }
  const headers = { 'Content-Type': 'application/json' }
  if (deviceSecret) headers['X-Mirage-Device-Secret'] = deviceSecret
  if (payload.deviceId) headers['X-Mirage-Device-Id'] = payload.deviceId

  const resp = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json()
}

async function getJSON(path) {
  const base = await getBackendUrl()
  const deviceId = await getDeviceId()
  const deviceSecret = await getDeviceSecret()
  const headers = { 'Content-Type': 'application/json' }
  if (deviceSecret) headers['X-Mirage-Device-Secret'] = deviceSecret
  headers['X-Mirage-Device-Id'] = deviceId
  const resp = await fetch(base + path, { method: 'GET', headers })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json()
}

async function registerDevice() {
  const deviceId = await getDeviceId()
  const browser = detectBrowser()
  const existingSecret = await getDeviceSecret()
  const result = await postJSON('/api/extension/register', {
    deviceId,
    displayName: `Mirage Â· ${browser}`,
    browser,
    version: chrome.runtime.getManifest().version,
    deviceSecret: existingSecret || undefined,
  })
  if (result.deviceSecret) {
    await setDeviceSecret(result.deviceSecret)
  }
  await setProviders(result.providers || [])
  return result
}

async function harvestDomain(_providerKey, url) {
  const byKey = new Map()
  const add = (list) => {
    for (const c of list || []) {
      byKey.set(`${c.name}|${c.domain}|${c.path}`, c)
    }
  }
  try {
    add(await chrome.cookies.getAll({ url }))
  } catch {
    // ignore
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    add(await chrome.cookies.getAll({ domain: host }))
    add(await chrome.cookies.getAll({ domain: '.' + host }))
    add(await chrome.cookies.getAll({ domain: 'www.' + host }))
    // Also try the bare origin with trailing slash variants
    add(await chrome.cookies.getAll({ url: `https://${host}/` }))
    add(await chrome.cookies.getAll({ url: `https://www.${host}/` }))
    // Parent eTLD+1 (e.g. chat.qwen.ai â†’ qwen.ai) for shared auth/WAF cookies
    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 3) {
      const parent = parts.slice(-2).join('.')
      add(await chrome.cookies.getAll({ domain: parent }))
      add(await chrome.cookies.getAll({ domain: '.' + parent }))
      add(await chrome.cookies.getAll({ url: `https://${parent}/` }))
    }
    // Kimi OAuth / auth subdomain cookies
    if (host === 'kimi.com' || host.endsWith('.kimi.com')) {
      for (const domain of [
        'kimi.com',
        '.kimi.com',
        'www.kimi.com',
        'auth.kimi.com',
        '.auth.kimi.com',
      ]) {
        try {
          add(await chrome.cookies.getAll({ domain }))
        } catch {
          // ignore
        }
      }
      for (const extra of [
        'https://www.kimi.com/',
        'https://kimi.com/',
        'https://auth.kimi.com/',
      ]) {
        try {
          add(await chrome.cookies.getAll({ url: extra }))
        } catch {
          // ignore
        }
      }
    }
    // Tongyi / Aliyun ticket cookies for Qwen-Free-API path
    if (
      host === 'tongyi.aliyun.com' ||
      host.endsWith('.aliyun.com') ||
      host === 'aliyun.com' ||
      host === 'qwen.ai' ||
      host.endsWith('.qwen.ai')
    ) {
      for (const domain of [
        'tongyi.aliyun.com',
        '.tongyi.aliyun.com',
        'aliyun.com',
        '.aliyun.com',
        'login.aliyun.com',
        '.login.aliyun.com',
        'passport.aliyun.com',
        '.passport.aliyun.com',
        'account.aliyun.com',
        '.account.aliyun.com',
      ]) {
        try {
          add(await chrome.cookies.getAll({ domain }))
        } catch {
          // ignore
        }
      }
      for (const extra of [
        'https://tongyi.aliyun.com/',
        'https://tongyi.aliyun.com/qianwen',
        'https://www.aliyun.com/',
        'https://login.aliyun.com/',
        'https://passport.aliyun.com/',
        'https://account.aliyun.com/',
      ]) {
        try {
          add(await chrome.cookies.getAll({ url: extra }))
        } catch {
          // ignore
        }
      }
    }
    // Legacy chat.qwen.ai jar (kept for old sessions)
    if (
      host === 'chat.qwen.ai' ||
      host.endsWith('.qwen.ai') ||
      host === 'qwen.ai'
    ) {
      for (const domain of [
        'qwen.ai',
        '.qwen.ai',
        'chat.qwen.ai',
        '.chat.qwen.ai',
        'aliyun.com',
        '.aliyun.com',
      ]) {
        try {
          add(await chrome.cookies.getAll({ domain }))
        } catch {
          // ignore
        }
      }
      for (const extra of [
        'https://chat.qwen.ai/',
        'https://www.qwen.ai/',
        'https://qwen.ai/',
        'https://tongyi.aliyun.com/',
      ]) {
        try {
          add(await chrome.cookies.getAll({ url: extra }))
        } catch {
          // ignore
        }
      }
    }
    // Arena auth lives on arena.ai + Clerk subdomain
    if (host === 'arena.ai' || host.endsWith('.arena.ai')) {
      for (const extra of [
        'https://arena.ai/',
        'https://clerk.arena.ai/',
        'https://accounts.arena.ai/',
      ]) {
        try {
          add(await chrome.cookies.getAll({ url: extra }))
        } catch {
          // ignore
        }
      }
      add(await chrome.cookies.getAll({ domain: 'clerk.arena.ai' }))
      add(await chrome.cookies.getAll({ domain: '.clerk.arena.ai' }))
    }
    // Gemini / Google auth cookies are on .google.com
    if (
      host === 'gemini.google.com' ||
      host.endsWith('.gemini.google.com') ||
      host === 'google.com'
    ) {
      for (const extra of [
        'https://gemini.google.com/',
        'https://accounts.google.com/',
        'https://www.google.com/',
      ]) {
        try {
          add(await chrome.cookies.getAll({ url: extra }))
        } catch {
          // ignore
        }
      }
      add(await chrome.cookies.getAll({ domain: '.google.com' }))
      add(await chrome.cookies.getAll({ domain: 'google.com' }))
    }
    // Dola fingerprint / session cookies
    if (host === 'dola.com' || host.endsWith('.dola.com')) {
      add(await chrome.cookies.getAll({ domain: '.dola.com' }))
      add(await chrome.cookies.getAll({ domain: 'dola.com' }))
      add(await chrome.cookies.getAll({ url: 'https://www.dola.com/' }))
    }
  } catch {
    // ignore
  }
  return Array.from(byKey.values()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expirationDate ? c.expirationDate * 1000 : undefined,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))
}

async function readStorageKey(providerKey, key, useSession) {
  const url = PROVIDER_DOMAINS[providerKey]
  if (!url) return null
  const tabs = await chrome.tabs.query({ url: url.replace(/\/$/, '') + '/*' })
  if (tabs.length === 0) return null
  const tab = tabs[0]
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (k, session) => {
        try {
          const store = session ? window.sessionStorage : window.localStorage
          return store.getItem(k)
        } catch {
          return null
        }
      },
      args: [key, !!useSession],
    })
    return results?.[0]?.result || null
  } catch {
    return null
  }
}

async function scanNestedTokens(providerKey) {
  const url = PROVIDER_DOMAINS[providerKey]
  if (!url) return {}
  const tabs = await chrome.tabs.query({ url: url.replace(/\/$/, '') + '/*' })
  if (tabs.length === 0) return {}
  const tab = tabs[0]
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const found = {}
        const KEY_RE = /token|session|auth/i
        function scanStore(store) {
          try {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i)
              if (!key) continue
              const raw = store.getItem(key)
              if (!raw) continue
              if (KEY_RE.test(key) && raw.length > 16 && raw[0] !== '{') {
                found[key] = raw
              }
              if (raw[0] === '{') {
                try {
                  const obj = JSON.parse(raw)
                  for (const [tk, tv] of Object.entries(obj || {})) {
                    if (typeof tv === 'string' && tv.length > 16 && KEY_RE.test(tk)) {
                      found[tk] = tv
                    }
                  }
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // ignore
          }
        }
        scanStore(window.localStorage)
        scanStore(window.sessionStorage)
        return found
      },
    })
    return results?.[0]?.result || {}
  } catch {
    return {}
  }
}

const TOKEN_KEY_CANDIDATES = {
  kimi: ['access_token', 'refresh_token', 'userToken', 'token', 'accessToken', 'refreshToken'],
  zai: ['userToken', 'token', 'access_token', 'accessToken'],
  deepseek: ['userToken', 'token', 'access_token'],
  claude: ['sessionKey', 'access_token'],
  dola: ['s_v_web_id', 'fp', 'sessionid', 'ttwid', 'token', 'access_token'],
  gemini: ['token', 'access_token'],
  _default: [
    'access_token',
    'refresh_token',
    'userToken',
    'token',
    'sessionKey',
    'accessToken',
    'refreshToken',
    'auth_token',
    'api_key',
    'apiKey',
    'jwt',
    'id_token',
  ],
}

async function readAllTokens(providerKey) {
  const candidates =
    TOKEN_KEY_CANDIDATES[providerKey] || TOKEN_KEY_CANDIDATES._default
  const tokens = {}
  for (const k of candidates) {
    const v =
      (await readStorageKey(providerKey, k, false)) ||
      (await readStorageKey(providerKey, k, true))
    if (v) tokens[k] = v
  }
  Object.assign(tokens, await scanNestedTokens(providerKey))
  return tokens
}

function tokenFromCookies(cookies, names) {
  const lower = new Set(names.map((n) => n.toLowerCase()))
  for (const c of cookies) {
    if (lower.has(String(c.name).toLowerCase()) && c.value) return c.value
  }
  return null
}

function looksLikeJwt(value) {
  if (!value || typeof value !== 'string') return false
  const parts = value.replace(/^Bearer\s+/i, '').trim().split('.')
  return parts.length === 3 && parts.every((p) => p.length > 4)
}

/** Tongyi dialog API needs SSO ticket — never treat chat.qwen.ai access JWT
 * as a ticket. Named tongyi cookies are always valid even if JWT-shaped. */
function extractTongyiTicketFromCookies(cookies) {
  const names = [
    'tongyi_sso_ticket',
    'login_aliyunid_ticket',
    'login_aliyunid_sso',
  ]
  for (const name of names) {
    const v = tokenFromCookies(cookies, [name])
    if (v && String(v).length > 8) return v
  }
  return null
}

/** Read tongyi ticket from the live page storage when cookies lag behind login. */
async function probeQwenTicketFromTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://tongyi.aliyun.com/*',
        'https://*.aliyun.com/*',
        'https://www.aliyun.com/*',
      ],
    })
    const tab = tabs.find((t) => t.id != null)
    if (!tab?.id) return null
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const keys = [
          'tongyi_sso_ticket',
          'login_aliyunid_ticket',
          'login_aliyunid_sso',
        ]
        const out = {}
        const scan = (store) => {
          try {
            for (const k of keys) {
              const v = store.getItem(k)
              if (v && v.length > 8) out[k] = v
            }
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i)
              if (!key) continue
              if (!/tongyi|aliyunid|sso|ticket/i.test(key)) continue
              const raw = store.getItem(key)
              if (raw && raw.length > 8 && raw[0] !== '{') out[key] = raw
            }
          } catch {
            // ignore
          }
        }
        scan(window.localStorage)
        scan(window.sessionStorage)
        return out
      },
    })
    const found = results?.[0]?.result || {}
    for (const name of [
      'tongyi_sso_ticket',
      'login_aliyunid_ticket',
      'login_aliyunid_sso',
    ]) {
      if (found[name]) return { name, value: found[name] }
    }
    const first = Object.entries(found)[0]
    if (first) return { name: first[0], value: first[1] }
  } catch {
    // ignore
  }
  return null
}

async function ensureQwenTongyiReady(url) {
  const tongyi = url || 'https://tongyi.aliyun.com/qianwen'
  await ensureProviderTab('qwen', tongyi, { force: true, active: true })
  let cookies = await harvestDomain('qwen', tongyi)
  let ticket = extractTongyiTicketFromCookies(cookies)
  if (ticket) return { cookies, ticket }

  const fromTab = await probeQwenTicketFromTab()
  if (fromTab?.value) {
    cookies = [
      ...cookies.filter((c) => c.name !== fromTab.name),
      {
        name: fromTab.name,
        value: fromTab.value,
        domain: '.aliyun.com',
        path: '/',
        secure: true,
        sameSite: 'no_restriction',
      },
    ]
    return { cookies, ticket: fromTab.value }
  }

  // Soft wait — login redirect may set cookies a moment after load.
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    cookies = await harvestDomain('qwen', tongyi)
    ticket = extractTongyiTicketFromCookies(cookies)
    if (ticket) return { cookies, ticket }
    const again = await probeQwenTicketFromTab()
    if (again?.value) {
      cookies = [
        ...cookies.filter((c) => c.name !== again.name),
        {
          name: again.name,
          value: again.value,
          domain: '.aliyun.com',
          path: '/',
          secure: true,
          sameSite: 'no_restriction',
        },
      ]
      return { cookies, ticket: again.value }
    }
  }
  return { cookies, ticket: null }
}

/** chrome.tabs.create throws "No current window" from SW when no focused window. */
async function createTabSafe(url, active = false) {
  // Prefer an existing window first so we never hit the SW "No current window" path.
  try {
    const wins = await chrome.windows.getAll({
      populate: false,
      windowTypes: ['normal'],
    })
    const win =
      wins.find((w) => w.focused && w.id != null) ||
      wins.find((w) => w.id != null)
    if (win?.id != null) {
      return await chrome.tabs.create({ url, active, windowId: win.id })
    }
  } catch {
    // fall through
  }
  try {
    return await chrome.tabs.create({ url, active })
  } catch (e) {
    const msg = String(e?.message || e || '')
    if (!/No current window/i.test(msg)) throw e
    try {
      const created = await chrome.windows.create({
        url,
        focused: true,
        type: 'normal',
      })
      return created?.tabs?.[0] || null
    } catch (e2) {
      throw new Error(
        'No current window â€” open any Chrome window (keep a normal browser window open), then retry',
      )
    }
  }
}

async function focusTab(tab) {
  if (!tab?.id) return
  try {
    await chrome.tabs.update(tab.id, { active: true })
  } catch {
    // ignore
  }
  if (tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch {
      // ignore
    }
  }
}

/**
 * Open or reuse a provider tab.
 * opts.force â€” bypass open throttle (OAuth connect)
 * opts.active â€” focus the tab (default false; true for OAuth)
 */
async function ensureProviderTab(providerKey, url, opts = {}) {
  const force = opts.force === true
  const active = opts.active === true
  const pattern = url.replace(/\/$/, '') + '/*'
  const existing = await chrome.tabs.query({ url: pattern })
  if (existing.length > 0) {
    if (force || active) await focusTab(existing[0])
    return existing[0]
  }

  const opened = (await chrome.storage.local.get(OPENED_TABS_KEY))[OPENED_TABS_KEY] || {}
  if (
    !force &&
    opened[providerKey] &&
    Date.now() - opened[providerKey] < 10 * 60 * 1000
  ) {
    return null
  }
  opened[providerKey] = Date.now()
  await chrome.storage.local.set({ [OPENED_TABS_KEY]: opened })
  try {
    const tab = await createTabSafe(url, active)
    if (!tab?.id) return null
    await waitTabComplete(tab.id, 15000)
    if (active) await focusTab(tab)
    return tab
  } catch (e) {
    console.warn('[mirage] open tab failed', providerKey, e)
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Scan storage + nudge /api/user so Authorization hits webRequest / MAIN hook. */
async function probeKimiBearer(url) {
  const pattern = String(url || 'https://www.kimi.com').replace(/\/$/, '') + '/*'
  let tabs = await chrome.tabs.query({ url: pattern })
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ url: 'https://kimi.com/*' })
  }
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ url: 'https://*.kimi.com/*' })
  }
  const tab = tabs[0]
  if (!tab?.id) return

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const found = { access: null, refresh: null }
        const take = (kind, v) => {
          if (!v || typeof v !== 'string') return
          const t = v.replace(/^Bearer\s+/i, '').trim()
          if (t.length < 12) return
          if (kind === 'refresh' && !found.refresh) found.refresh = t
          if (kind === 'access' && !found.access) found.access = t
        }
        const scanStore = (store) => {
          try {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i)
              if (!key) continue
              const raw = store.getItem(key)
              if (!raw) continue
              if (/refresh/i.test(key)) take('refresh', raw)
              else if (/access|token|auth|session/i.test(key) && raw[0] !== '{') {
                take('access', raw)
              }
              if (raw[0] === '{') {
                try {
                  const obj = JSON.parse(raw)
                  for (const [k, v] of Object.entries(obj || {})) {
                    if (typeof v !== 'string') continue
                    if (/refresh/i.test(k)) take('refresh', v)
                    else if (/access|token|auth/i.test(k)) take('access', v)
                  }
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // ignore
          }
        }
        try {
          scanStore(localStorage)
          scanStore(sessionStorage)
        } catch {
          // ignore
        }
        // Nudge SPA auth traffic (hook + webRequest pick up Bearer).
        try {
          await fetch('https://www.kimi.com/api/user', {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          })
        } catch {
          // ignore
        }
        return found
      },
    })
    const found = results?.[0]?.result || {}
    if (found.access) await rememberObservedToken('kimi', 'access', found.access)
    if (found.refresh) await rememberObservedToken('kimi', 'refresh', found.refresh)
  } catch (e) {
    console.warn('[mirage] kimi probe failed', e)
  }
}

async function resolveKimiTokens(base) {
  let accessToken = base.accessToken || null
  let refreshToken = base.refreshToken || null
  if (accessToken || refreshToken) return { accessToken, refreshToken }

  await ensureProviderTab('kimi', base.url || 'https://www.kimi.com')
  await probeKimiBearer(base.url || 'https://www.kimi.com')

  for (let i = 0; i < 10; i++) {
    const observed = (await getObservedTokens()).kimi || {}
    accessToken = observed.accessToken || accessToken
    refreshToken = observed.refreshToken || refreshToken
    if (accessToken || refreshToken) break
    await sleep(350)
  }

  if (!accessToken && !refreshToken) {
    const tokens = await readAllTokens('kimi')
    accessToken =
      tokens.access_token ||
      tokens.accessToken ||
      tokens.token ||
      null
    refreshToken = tokens.refresh_token || tokens.refreshToken || null
  }

  return { accessToken, refreshToken }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(false)
    }, timeoutMs)
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve(true)
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function harvestCredentials(providerKey) {
  const providers = await getProviders()
  let provider = providers.find((p) => p.key === providerKey)
  if (!provider) {
    try {
      await registerDevice()
      provider = (await getProviders()).find((p) => p.key === providerKey)
    } catch {
      // ignore
    }
  }
  const url = PROVIDER_DOMAINS[providerKey] || provider?.websiteUrl
  if (!url) throw new Error(`No known domain for ${providerKey}`)

  let cookies = await harvestDomain(providerKey, url)
  return { url, cookies, provider }
}

const pendingCaptures = new Map()
const DEBOUNCE_MS = 3000
/** In-flight OAuth connect waits â€” dedupe setProviders / job / refresh triggers. */
const oauthConnectLocks = new Map()
const OAUTH_WAIT_MS = 4 * 60 * 1000
const OAUTH_POLL_MS = 2000

function cookieNameLooksAuth(name) {
  return /auth|session|token|ticket|sid|psid|userToken|arena-auth|sessionKey|hf-chat|tongyi|clerk|__session|next-auth/i.test(
    String(name || ''),
  )
}

/**
 * True when jar/tokens look like a real login (not analytics-only).
 */
async function probeAuthReady(providerKey, url) {
  let cookies = await harvestDomain(providerKey, url)
  if (providerKey === 'qwen') {
    const tongyiUrl = 'https://tongyi.aliyun.com/qianwen'
    cookies = await harvestDomain('qwen', tongyiUrl)
    let ticket = extractTongyiTicketFromCookies(cookies)
    if (!ticket) {
      const fromTab = await probeQwenTicketFromTab()
      if (fromTab?.value) {
        cookies = [
          ...cookies.filter((c) => c.name !== fromTab.name),
          {
            name: fromTab.name,
            value: fromTab.value,
            domain: '.aliyun.com',
            path: '/',
            secure: true,
            sameSite: 'no_restriction',
          },
        ]
        ticket = fromTab.value
      }
    }
    if (ticket) return { ready: true, cookies }
    return { ready: false, cookies }
  }

  const tokens = await readAllTokens(providerKey)
  const observed = (await getObservedTokens())[providerKey] || {}

  if (providerKey === 'kimi') {
    const access =
      tokens.access_token ||
      tokens.accessToken ||
      tokens.userToken ||
      observed.accessToken ||
      null
    const refresh =
      tokens.refresh_token || tokens.refreshToken || observed.refreshToken || null
    if (access || refresh) return { ready: true, cookies, tokens, observed }
    return { ready: false, cookies, tokens, observed }
  }

  if (providerKey === 'claude') {
    const sk =
      tokens.sessionKey ||
      tokenFromCookies(cookies, ['sessionKey']) ||
      observed.accessToken
    if (sk) return { ready: true, cookies, tokens, observed }
    return { ready: false, cookies, tokens, observed }
  }

  if (providerKey === 'arena') {
    const hasArenaAuth = cookies.some(
      (c) =>
        /arena-auth|__session|clerk|__client/i.test(c.name) &&
        c.value &&
        String(c.value).length > 8,
    )
    if (hasArenaAuth) return { ready: true, cookies, tokens, observed }
    return { ready: false, cookies, tokens, observed }
  }

  const accessToken =
    tokens.access_token ||
    tokens.accessToken ||
    tokens.userToken ||
    tokens.token ||
    tokens.sessionKey ||
    observed.accessToken ||
    tokenFromCookies(cookies, [
      'access_token',
      'accessToken',
      'userToken',
      'token',
      'sessionKey',
      'tongyi_sso_ticket',
      'login_aliyunid_ticket',
    ]) ||
    null
  const refreshToken =
    tokens.refresh_token ||
    tokens.refreshToken ||
    observed.refreshToken ||
    tokenFromCookies(cookies, ['refresh_token', 'refreshToken']) ||
    null
  if (accessToken || refreshToken) {
    return { ready: true, cookies, tokens, observed }
  }

  const authCookie = cookies.find(
    (c) =>
      cookieNameLooksAuth(c.name) &&
      c.value &&
      String(c.value).length > 8 &&
      !/_ga|_gid|_gat|AMP_TOKEN|__gads|NID|IDE|__cf_bm|arena_visit|country/i.test(
        c.name,
      ),
  )
  if (authCookie) return { ready: true, cookies, tokens, observed }
  return { ready: false, cookies, tokens, observed }
}

/**
 * OAuth connect: open login tab, wait until auth cookies/tokens appear, then POST.
 * Without this, capture runs on an empty jar and never returns a session to the web app.
 */
async function oauthConnectCapture(providerKey, opts = {}) {
  if (!providerKey) return { session: null, reason: 'no_provider' }
  const existing = oauthConnectLocks.get(providerKey)
  if (existing) return existing

  const waitMs =
    opts.waitForLogin === false ? 0 : Number(opts.waitMs) || OAUTH_WAIT_MS

  const run = (async () => {
    if (opts.websiteUrl) {
      const list = await getProviders()
      const found = list.find((p) => p.key === providerKey)
      if (!found) {
        list.push({
          key: providerKey,
          websiteUrl: opts.websiteUrl,
          enabled: true,
        })
        await setProviders(list, { skipCapture: true })
      } else if (!found.websiteUrl) {
        found.websiteUrl = opts.websiteUrl
        await setProviders(list, { skipCapture: true })
      } else {
        mergeProviderDomains(list)
      }
    }

    let url
    try {
      ;({ url } = await harvestCredentials(providerKey))
    } catch (e) {
      url = opts.websiteUrl || PROVIDER_DOMAINS[providerKey]
      if (!url) throw e
    }
    if (opts.websiteUrl) url = opts.websiteUrl

    console.log(
      `[mirage] oauth connect: open ${providerKey} â†’ ${url} (wait ${waitMs}ms)`,
    )
    await ensureProviderTab(providerKey, url, { force: true, active: true })

    // Qwen login lives on tongyi, not chat.qwen.ai
    if (providerKey === 'qwen') {
      await ensureProviderTab(providerKey, 'https://tongyi.aliyun.com/qianwen', {
        force: true,
        active: true,
      })
    }

    const deadline = Date.now() + waitMs
    let probe = await probeAuthReady(providerKey, url)
    while (!probe.ready && Date.now() < deadline) {
      if (providerKey === 'kimi') {
        try {
          await probeKimiBearer(url)
        } catch {
          // ignore
        }
      }
      await sleep(OAUTH_POLL_MS)
      probe = await probeAuthReady(providerKey, url)
    }

    if (!probe.ready && waitMs > 0) {
      const detail =
        'Timed out waiting for login. Sign in in the opened tab, then click OAuth login again.'
      console.warn(`[mirage] oauth timeout for ${providerKey}`)
      await appendCaptureLog({
        ts: Date.now(),
        provider: providerKey,
        trigger: opts.trigger || 'oauth_connect',
        status: 'oauth_timeout',
        browser: detectBrowser(),
        cookieCount: probe.cookies?.length || 0,
      })
      try {
        const deviceId = await getDeviceId()
        await postJSON('/api/extension/capture-result', {
          deviceId,
          providerKey,
          status: 'oauth_timeout',
          detail,
        })
      } catch {
        // ignore
      }
      return { session: null, reason: 'oauth_timeout', detail }
    }

    return await captureSession(providerKey, {
      trigger: opts.trigger || 'oauth_connect',
      openIfMissing: true,
      label: opts.label,
    })
  })().finally(() => {
    oauthConnectLocks.delete(providerKey)
  })

  oauthConnectLocks.set(providerKey, run)
  return run
}

async function captureSession(providerKey, opts = {}) {
  let { url, cookies } = await harvestCredentials(providerKey)

  if (cookies.length === 0 && opts.openIfMissing) {
    await ensureProviderTab(providerKey, url, {
      force: opts.trigger === 'oauth_connect' || opts.trigger === 'capture_job',
      active: opts.trigger === 'oauth_connect' || opts.trigger === 'capture_job',
    })
    cookies = await harvestDomain(providerKey, url)
  }

  if (providerKey === 'qwen') {
    const bx = await loadStoredQwenBx()
    const bxEntries = mirageBxCookieEntries(bx)
    if (bxEntries.length) {
      const map = new Map(cookies.map((c) => [`${c.name}|${c.domain}`, c]))
      for (const e of bxEntries) map.set(`${e.name}|${e.domain}`, e)
      cookies = Array.from(map.values())
    }
    // Always re-open/harvest tongyi â€” chat.qwen.ai JWT jars are useless.
    const ready = await ensureQwenTongyiReady(url)
    cookies = ready.cookies.length ? ready.cookies : cookies
  }

  if (cookies.length === 0) {
    await appendCaptureLog({
      ts: Date.now(),
      provider: providerKey,
      trigger: opts.trigger || 'manual',
      status: 'no_cookies',
      browser: detectBrowser(),
      cookieCount: 0,
    })
    try {
      const deviceId = await getDeviceId()
      await postJSON('/api/extension/capture-result', {
        deviceId,
        providerKey,
        status: 'no_cookies',
        detail: 'Open the site and log in, then Retry capture',
      })
    } catch {
      // ignore
    }
    return { session: null, reason: 'no_cookies' }
  }

  const tokens = await readAllTokens(providerKey)
  const observed = (await getObservedTokens())[providerKey] || {}

  const accessToken =
    tokens.access_token ||
    tokens.accessToken ||
    tokens.userToken ||
    tokens.token ||
    tokens.sessionKey ||
    observed.accessToken ||
    tokenFromCookies(cookies, [
      'access_token',
      'accessToken',
      'userToken',
      'token',
      'sessionKey',
      // Qwen-Free-API / Tongyi
      'tongyi_sso_ticket',
      'login_aliyunid_ticket',
    ]) ||
    null

  const refreshToken =
    tokens.refresh_token ||
    tokens.refreshToken ||
    observed.refreshToken ||
    tokenFromCookies(cookies, ['refresh_token', 'refreshToken']) ||
    null

  let accessOut = accessToken
  let refreshOut = refreshToken
  let cookiesOut = cookies

  // Qwen: prefer tongyi ticket cookie (even if JWT-shaped); drop chat.qwen.ai JWTs.
  if (providerKey === 'qwen') {
    const ticket = extractTongyiTicketFromCookies(cookies)
    if (ticket) {
      accessOut = ticket
    } else {
      const fromTab = await probeQwenTicketFromTab()
      if (fromTab?.value) {
        cookiesOut = [
          ...cookies.filter((c) => c.name !== fromTab.name),
          {
            name: fromTab.name,
            value: fromTab.value,
            domain: '.aliyun.com',
            path: '/',
            secure: true,
            sameSite: 'no_restriction',
          },
        ]
        accessOut = fromTab.value
      } else if (looksLikeJwt(accessOut)) {
        accessOut = null
      }
    }
  }

  // Kimi: cookie jars alone are useless — wait for Bearer / refresh before upsert.
  if (providerKey === 'kimi' && !accessOut && !refreshOut) {
    const resolved = await resolveKimiTokens({
      url,
      accessToken: accessOut,
      refreshToken: refreshOut,
    })
    accessOut = resolved.accessToken
    refreshOut = resolved.refreshToken
  }

  if (providerKey === 'kimi' && !accessOut && !refreshOut) {
    const detail =
      'Kimi needs Authorization Bearer (not cookies only). Open www.kimi.com while logged in, send one chat message, then Capture again.'
    await appendCaptureLog({
      ts: Date.now(),
      provider: providerKey,
      trigger: opts.trigger || 'manual',
      status: 'no_bearer',
      browser: detectBrowser(),
      cookieCount: cookies.length,
      hadToken: false,
    })
    try {
      const deviceId = await getDeviceId()
      await postJSON('/api/extension/capture-result', {
        deviceId,
        providerKey,
        status: 'no_bearer',
        detail,
      })
    } catch {
      // ignore
    }
    return { session: null, reason: 'no_bearer', detail }
  }

  if (
    providerKey === 'qwen' &&
    !extractTongyiTicketFromCookies(cookiesOut) &&
    !accessOut
  ) {
    const detail =
      'Qwen needs tongyi_sso_ticket (or login_aliyunid_ticket). Log in at https://tongyi.aliyun.com/qianwen — not chat.qwen.ai — then Capture again.'
    await appendCaptureLog({
      ts: Date.now(),
      provider: providerKey,
      trigger: opts.trigger || 'manual',
      status: 'no_tongyi_ticket',
      browser: detectBrowser(),
      cookieCount: cookiesOut.length,
      hadToken: false,
    })
    try {
      const deviceId = await getDeviceId()
      await postJSON('/api/extension/capture-result', {
        deviceId,
        providerKey,
        status: 'no_tongyi_ticket',
        detail,
      })
    } catch {
      // ignore
    }
    return { session: null, reason: 'no_tongyi_ticket', detail }
  }

  // Attach a recently observed Z.AI captcha token (synthetic cookie).
  if (providerKey === 'zai') {
    const cap = await getObservedCaptcha('zai')
    if (cap?.captcha_verify_param && Date.now() - (cap.ts || 0) < 40_000) {
      cookiesOut = cookiesOut.filter(
        (c) =>
          c.name !== 'mirage_captcha_verify_param' &&
          c.name !== 'mirage_captcha_ts',
      )
      cookiesOut.push({
        name: 'mirage_captcha_verify_param',
        value: cap.captcha_verify_param,
        domain: 'chat.z.ai',
        path: '/',
        secure: true,
        sameSite: 'lax',
      })
      cookiesOut.push({
        name: 'mirage_captcha_ts',
        value: String(cap.ts || Date.now()),
        domain: 'chat.z.ai',
        path: '/',
        secure: true,
        sameSite: 'lax',
      })
    }
  }

  const deviceId = await getDeviceId()
  const result = await postJSON('/api/extension/sessions', {
    deviceId,
    providerKey,
    label: opts.label || null,
    browser: detectBrowser(),
    cookies: cookiesOut,
    accessToken: accessOut,
    refreshToken: refreshOut,
  })

  await appendCaptureLog({
    ts: Date.now(),
    provider: providerKey,
    trigger: opts.trigger || 'manual',
    status: result.session?.status || 'unknown',
    role: result.role || null,
    browser: detectBrowser(),
    cookieCount: cookiesOut.length,
    hadToken: !!accessOut,
    hadRefresh: !!refreshToken,
    valid: result.validation?.valid ?? null,
  })

  return result
}

async function testProvider(providerKey) {
  const { url, cookies } = await harvestCredentials(providerKey)
  if (cookies.length === 0) {
    await ensureProviderTab(providerKey, url)
  }
  const cookies2 = cookies.length
    ? cookies
    : await harvestDomain(providerKey, url)
  const tokens = await readAllTokens(providerKey)
  const observed = (await getObservedTokens())[providerKey] || {}
  const accessToken =
    tokens.access_token ||
    tokens.accessToken ||
    tokens.userToken ||
    tokens.token ||
    observed.accessToken ||
    null
  const refreshToken =
    tokens.refresh_token || tokens.refreshToken || observed.refreshToken || null

  // Optional in-tab probe for cookie sites
  let browserProbe = null
  try {
    const tabs = await chrome.tabs.query({ url: url.replace(/\/$/, '') + '/*' })
    if (tabs[0]?.id) {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: async (targetUrl) => {
          try {
            const r = await fetch(targetUrl, {
              credentials: 'include',
              redirect: 'follow',
            })
            return { status: r.status, ok: r.ok }
          } catch (e) {
            return { ok: false, error: String(e) }
          }
        },
        args: [url],
      })
      browserProbe = probe?.[0]?.result || null
    }
  } catch {
    // ignore
  }

  const deviceId = await getDeviceId()
  const result = await postJSON('/api/extension/sessions/test', {
    deviceId,
    providerKey,
    browser: detectBrowser(),
    cookies: cookies2,
    accessToken,
    refreshToken,
    upsert: true,
    browserProbe,
  })

  await appendCaptureLog({
    ts: Date.now(),
    provider: providerKey,
    trigger: 'test',
    status: result.valid ? 'active' : 'error',
    browser: detectBrowser(),
    cookieCount: cookies2.length,
    valid: result.valid,
    reason: result.reason || null,
  })

  return result
}

function scheduleCapture(providerKey, trigger) {
  const existing = pendingCaptures.get(providerKey)
  if (existing?.timer) clearTimeout(existing.timer)

  const timer = setTimeout(async () => {
    pendingCaptures.delete(providerKey)
    try {
      console.log(`[mirage] auto-capture ${providerKey} (${trigger})`)
      await captureSession(providerKey, { trigger })
    } catch (e) {
      console.warn(`[mirage] auto-capture failed for ${providerKey}:`, e)
    }
  }, DEBOUNCE_MS)

  pendingCaptures.set(providerKey, { timer, trigger })
}

// â”€â”€â”€ Local tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isQwenChatUrl(url) {
  try {
    const host = new URL(url).hostname
    return host === 'chat.qwen.ai' || host.endsWith('.qwen.ai')
  } catch {
    return false
  }
}

function isArenaCreateEvaluationUrl(url) {
  try {
    const u = new URL(url)
    return (
      /(^|\.)arena\.ai$/i.test(u.hostname) &&
      /create-evaluation/i.test(u.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Arena validates UUIDv7 timestamps against its own clock.
 * If the OS clock is skewed (even by minutes), it returns:
 * "Evaluation session ID seems spoofed, offset too big".
 * Sync from Arena's Date header (cached ~60s).
 */
let arenaClockSkewMs = 0
let arenaClockSkewCheckedAt = 0

async function arenaNowMs() {
  const now = Date.now()
  if (now - arenaClockSkewCheckedAt > 60_000) {
    try {
      const r = await fetch('https://arena.ai/text/direct', {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'omit',
      })
      const parsed = Date.parse(r.headers.get('date') || '')
      if (Number.isFinite(parsed)) {
        arenaClockSkewMs = parsed - Date.now()
        arenaClockSkewCheckedAt = Date.now()
        if (Math.abs(arenaClockSkewMs) > 5_000) {
          console.warn(
            '[mirage] arena clock skew ms=',
            Math.round(arenaClockSkewMs),
          )
        }
      }
    } catch (e) {
      console.warn('[mirage] arena clock sync failed', e)
    }
  }
  return Date.now() + arenaClockSkewMs
}

/** RFC 9562 UUIDv7 — optional absolute ms (Arena-synced). */
function mintUuidV7(atMs) {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let ms = Math.max(0, Math.floor(atMs != null ? atMs : Date.now()))
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff
    ms = Math.floor(ms / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Fresh UUIDv7s at send-time, stamped with Arena server clock. */
function refreshArenaEvaluationIds(bodyStr, atMs) {
  if (!bodyStr) return bodyStr
  try {
    const j = JSON.parse(bodyStr)
    if (!j || typeof j !== 'object') return bodyStr
    const t0 = atMs != null ? atMs : Date.now()
    j.id = mintUuidV7(t0)
    j.userMessageId = mintUuidV7(t0 + 1)
    j.modelAMessageId = mintUuidV7(t0 + 2)
    if (j.modelBMessageId) j.modelBMessageId = mintUuidV7(t0 + 3)
    return JSON.stringify(j)
  } catch {
    return bodyStr
  }
}

async function toolBrowserFetch(args) {
  const url = String(args.url || '')
  if (!url) throw new Error('url required')
  const method = String(args.method || 'GET').toUpperCase()
  const headers = args.headers && typeof args.headers === 'object' ? args.headers : {}
  let body = args.body != null ? String(args.body) : undefined
  if (body && method !== 'GET' && method !== 'HEAD' && isArenaCreateEvaluationUrl(url)) {
    const arenaTs = await arenaNowMs()
    body = refreshArenaEvaluationIds(body, arenaTs)
  }
  // Qwen SSE can be large; allow up to 5MB (other sites keep 1MB cap).
  const hardCap = isQwenChatUrl(url) ? 5_000_000 : 1_000_000
  const maxBody = Math.min(Number(args.maxBody) || (isQwenChatUrl(url) ? 2_000_000 : 500_000), hardCap)

  let tabId = null
  try {
    const origin = new URL(url).origin + '/*'
    const tabs = await chrome.tabs.query({ url: origin })
    if (tabs[0]?.id) tabId = tabs[0].id
  } catch {
    // ignore
  }

  // Claude (and other CF sites) need a real tab so credentials/CF clearance match.
  if (!tabId) {
    try {
      const origin = new URL(url).origin
      const opened = await createTabSafe(origin + '/', false)
      tabId = opened?.id || null
      if (tabId) {
        await waitTabComplete(tabId, 8_000)
      }
    } catch {
      // fall through to SW fetch
    }
  }

  if (tabId) {
    // Prefer live tab cookies (CF clearance). Drop Cookie header from caller.
    const pageHeaders = { ...(headers || {}) }
    delete pageHeaders.Cookie
    delete pageHeaders.cookie
    // Qwen BaXia injects bx-* only on the page's patched fetch â€” MAIN world.
    // Stale bx-* from Mirage would fight the live SDK; strip them.
    if (isQwenChatUrl(url)) {
      for (const k of Object.keys(pageHeaders)) {
        if (/^bx-/i.test(k) || /^user-agent$/i.test(k)) delete pageHeaders[k]
      }
    }
    const useMainWorld = isQwenChatUrl(url)
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      ...(useMainWorld ? { world: 'MAIN' } : {}),
      func: async (u, m, h, b, max) => {
        const r = await fetch(u, {
          method: m,
          headers: h || {},
          body: m === 'GET' || m === 'HEAD' ? undefined : b,
          credentials: 'include',
        })
        const text = await r.text()
        return {
          status: r.status,
          ok: r.ok,
          body: text.slice(0, max),
          contentType: r.headers.get('content-type'),
        }
      },
      args: [url, method, pageHeaders, body, maxBody],
    })
    return results?.[0]?.result
  }

  const r = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
  const text = await r.text()
  return {
    status: r.status,
    ok: r.ok,
    body: text.slice(0, maxBody),
    contentType: r.headers.get('content-type'),
  }
}

async function toolReadTab(args) {
  const maxChars = Math.min(Number(args.maxChars) || 50_000, 200_000)
  let tab = null
  if (args.url) {
    const pattern = String(args.url).replace(/\/$/, '') + '*'
    const tabs = await chrome.tabs.query({ url: pattern })
    tab = tabs[0] || null
  }
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = active || null
  }
  if (!tab?.id) throw new Error('No matching tab')

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (limit) => {
      const text = (document.body && document.body.innerText) || ''
      return {
        title: document.title,
        url: location.href,
        text: text.slice(0, limit),
      }
    },
    args: [maxChars],
  })
  return results?.[0]?.result
}

async function toolListTabs(args) {
  const providers = await getProviders()
  const keys = args.providerKey
    ? [String(args.providerKey)]
    : providers.map((p) => p.key)
  const out = []
  for (const key of keys) {
    const url = PROVIDER_DOMAINS[key]
    if (!url) continue
    try {
      const tabs = await chrome.tabs.query({ url: url.replace(/\/$/, '') + '/*' })
      for (const t of tabs) {
        out.push({
          providerKey: key,
          id: t.id,
          title: t.title,
          url: t.url,
          active: t.active,
        })
      }
    } catch {
      // ignore
    }
  }
  return { tabs: out }
}

/**
 * Solve Aliyun traceless captcha inside a real chat.z.ai tab (MAIN world).
 * Returns { captcha_verify_param } for the Mirage Z.AI adapter.
 */
async function toolZaiCaptcha(_args) {
  const url = PROVIDER_DOMAINS.zai || 'https://chat.z.ai'
  const pattern = url.replace(/\/$/, '') + '/*'
  let tabs = await chrome.tabs.query({ url: pattern })
  let tab = tabs[0] || null
  if (!tab?.id) {
    tab = await createTabSafe(url + '/', false)
    if (!tab?.id) throw new Error('Could not open chat.z.ai tab (no browser window)')
    await waitTabComplete(tab.id, 20_000)
    // SPA boot
    await new Promise((r) => setTimeout(r, 2000))
  }

  // Prefer a captcha the page just produced (user chat / site SDK).
  const recent = await getObservedCaptcha('zai')
  if (recent?.captcha_verify_param && Date.now() - (recent.ts || 0) < 25_000) {
    return {
      captcha_verify_param: recent.captcha_verify_param,
      source: 'observed',
      ts: recent.ts,
    }
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      const DEFAULTS = {
        region: 'sgp',
        prefix: 'no8xfe',
        sceneId: 'didk33e0',
      }
      const pageCfg =
        window.AliyunCaptchaConfig && typeof window.AliyunCaptchaConfig === 'object'
          ? window.AliyunCaptchaConfig
          : {}
      const cfg = {
        region: pageCfg.region || DEFAULTS.region,
        prefix: pageCfg.prefix || DEFAULTS.prefix,
        sceneId:
          window.__MIRAGE_ZAI_SCENE_ID__ ||
          pageCfg.sceneId ||
          DEFAULTS.sceneId,
      }
      window.AliyunCaptchaConfig = {
        region: cfg.region,
        prefix: cfg.prefix,
      }

      if (typeof window.initAliyunCaptcha !== 'function') {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector(
            'script[src*="AliyunCaptcha.js"]',
          )
          if (existing && typeof window.initAliyunCaptcha === 'function') {
            resolve()
            return
          }
          const s = document.createElement('script')
          s.src =
            'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
          s.async = true
          s.onload = () => resolve()
          s.onerror = () =>
            reject(new Error('Failed to load AliyunCaptcha.js from CDN'))
          document.documentElement.appendChild(s)
        })
        // SDK may expose init slightly after onload
        const deadline = Date.now() + 15_000
        while (typeof window.initAliyunCaptcha !== 'function') {
          if (Date.now() > deadline) {
            throw new Error('AliyunCaptcha SDK loaded but initAliyunCaptcha missing')
          }
          await new Promise((r) => setTimeout(r, 100))
        }
      }

      const uid = 'mirage-captcha-' + Math.random().toString(36).slice(2, 8)
      const el = document.createElement('div')
      el.id = uid + '-element'
      el.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;'
      const btn = document.createElement('button')
      btn.id = uid + '-button'
      btn.type = 'button'
      btn.style.cssText = 'position:fixed;left:-9999px;top:-9999px;'
      document.body.appendChild(el)
      document.body.appendChild(btn)

      try {
        const param = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Captcha solve timeout (40s)')),
            40_000,
          )
          try {
            window.initAliyunCaptcha({
              SceneId: cfg.sceneId,
              mode: 'popup',
              region: cfg.region,
              prefix: cfg.prefix,
              language: 'en',
              element: '#' + el.id,
              button: '#' + btn.id,
              captchaLogoImg: '',
              showErrorTip: false,
              success: (p) => {
                clearTimeout(timeout)
                resolve(p)
              },
              fail: (err) => {
                clearTimeout(timeout)
                reject(
                  new Error(
                    'Aliyun captcha fail: ' +
                      (typeof err === 'string' ? err : JSON.stringify(err)),
                  ),
                )
              },
              getInstance: (inst) => {
                const trigger = () => {
                  try {
                    btn.click()
                  } catch (e) {
                    clearTimeout(timeout)
                    reject(e)
                  }
                }
                try {
                  if (!inst) {
                    trigger()
                    return
                  }
                  // Aliyun SDK variants differ; never call a missing method.
                  if (typeof inst.startTracelessVerification === 'function') {
                    try {
                      inst.startTracelessVerification()
                      return
                    } catch {
                      // fall through
                    }
                  }
                  if (typeof inst.show === 'function') {
                    try {
                      inst.show()
                      return
                    } catch {
                      // fall through
                    }
                  }
                  if (typeof inst.verify === 'function') {
                    try {
                      inst.verify()
                      return
                    } catch {
                      // fall through
                    }
                  }
                  trigger()
                } catch (e) {
                  clearTimeout(timeout)
                  reject(e instanceof Error ? e : new Error(String(e)))
                }
              },
            })
          } catch (e) {
            clearTimeout(timeout)
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
        const token =
          typeof param === 'string'
            ? param
            : param && typeof param === 'object' && typeof param.captchaVerifyParam === 'string'
              ? param.captchaVerifyParam
              : param && typeof param === 'object' && typeof param.captcha_verify_param === 'string'
                ? param.captcha_verify_param
                : ''
        if (!token) {
          throw new Error('Captcha returned empty token')
        }
        return { captcha_verify_param: token, sceneId: cfg.sceneId }
      } finally {
        try {
          el.remove()
          btn.remove()
        } catch {
          // ignore
        }
      }
    },
  })

  const payload = results?.[0]?.result
  if (results?.[0]?.error) {
    const err = results[0].error
    throw new Error(
      String(
        (err && typeof err === 'object' && err.message) ||
          err ||
          'Captcha script failed',
      ),
    )
  }
  const param = payload?.captcha_verify_param
  if (!param) {
    throw new Error(
      'Captcha solve produced no token. Stay logged in on chat.z.ai and retry.',
    )
  }
  await rememberObservedCaptcha('zai', param)
  return {
    captcha_verify_param: param,
    source: 'solved',
    ts: Date.now(),
    sceneId: payload?.sceneId,
  }
}

function mirageBxCookieEntries(bx) {
  if (!bx?.bx_ua || !bx?.bx_umidtoken) return []
  const domain = '.qwen.ai'
  const mk = (name, value) =>
    value
      ? {
          name,
          value: String(value),
          domain,
          path: '/',
          secure: true,
          sameSite: 'Lax',
        }
      : null
  return [
    mk('__mirage_bx_ua', bx.bx_ua),
    mk('__mirage_bx_umidtoken', bx.bx_umidtoken),
    mk('__mirage_bx_v', bx.bx_v || '2.5.36'),
    mk('__mirage_version', bx.version),
    mk('__mirage_user_agent', bx.user_agent),
    mk('__mirage_x_ap', bx.x_ap),
  ].filter(Boolean)
}

async function loadStoredQwenBx() {
  if (latestQwenBx?.bx_ua) return latestQwenBx
  try {
    const v = await chrome.storage.local.get(QWEN_BX_KEY)
    if (v[QWEN_BX_KEY]?.bx_ua) {
      latestQwenBx = v[QWEN_BX_KEY]
      return latestQwenBx
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Warm chat.qwen.ai so Alibaba baxia mints ssxmod_* cookies + bx-* headers.
 * Empty completion streams happen when bx-ua / bx-umidtoken are missing.
 */
async function toolQwenWarmup(_args) {
  const url = PROVIDER_DOMAINS.qwen || 'https://chat.qwen.ai'
  const pattern = url.replace(/\/$/, '') + '/*'
  let tabs = await chrome.tabs.query({ url: pattern })
  let tab = tabs[0] || null
  if (!tab?.id) {
    tab = await createTabSafe(url + '/', false)
    if (!tab?.id) throw new Error('Could not open chat.qwen.ai tab (no browser window)')
    await waitTabComplete(tab.id, 20_000)
    await new Promise((r) => setTimeout(r, 2500))
  }

  const beforeTs = latestQwenBx?.ts || 0

  // Hit live endpoints from MAIN world so BaXia patches fetch and injects bx-*.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      // Wait for BaXia SDK (window.baxiaCommon) â€” same gate as qwen2API auto_bx.
      for (let i = 0; i < 40; i++) {
        if (typeof window.baxiaCommon === 'function') break
        await new Promise((r) => setTimeout(r, 250))
      }
      await new Promise((r) => setTimeout(r, 800))

      const token =
        localStorage.getItem('token') ||
        sessionStorage.getItem('token') ||
        ''
      let bearer = ''
      try {
        const j = token.startsWith('{') ? JSON.parse(token) : null
        bearer = (j && j.value) || token
      } catch {
        bearer = token
      }
      bearer = String(bearer || '').replace(/^Bearer\s+/i, '')
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      }
      try {
        await fetch('/api/models', { credentials: 'include', headers })
      } catch {
        // ignore
      }
      try {
        await fetch('/api/v2/chats/new', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            title: 'Mirage warmup',
            models: ['qwen3.8-max'],
            chat_mode: 'normal',
            chat_type: 't2t',
            timestamp: Date.now(),
          }),
        })
      } catch {
        // ignore â€” still harvest whatever cookies/headers were set
      }
      return {
        ok: true,
        hasBearer: !!bearer,
        baxiaReady: typeof window.baxiaCommon === 'function',
      }
    },
  })

  // webRequest listener captures bx-* after BaXia injects them.
  for (let i = 0; i < 20; i++) {
    if (latestQwenBx?.ts && latestQwenBx.ts > beforeTs) break
    await new Promise((r) => setTimeout(r, 250))
  }

  const bx = (await loadStoredQwenBx()) || latestQwenBx
  let cookies = await harvestDomain('qwen', url)
  const bxEntries = mirageBxCookieEntries(bx)
  if (bxEntries.length) {
    const map = new Map(cookies.map((c) => [`${c.name}|${c.domain}`, c]))
    for (const e of bxEntries) map.set(`${e.name}|${e.domain}`, e)
    cookies = Array.from(map.values())
  }

  const names = cookies.map((c) => c.name)
  const hasSsx = names.some((n) => /^ssxmod_/i.test(n) || /^bx-umidtoken$/i.test(n))
  const hasBx = Boolean(bx?.bx_ua && bx?.bx_umidtoken)
  return {
    cookies,
    cookieNames: names,
    hasAntiBot: hasSsx,
    hasBxHeaders: hasBx,
    bxHeaders: hasBx
      ? {
          bx_ua: bx.bx_ua,
          bx_umidtoken: bx.bx_umidtoken,
          bx_v: bx.bx_v,
          version: bx.version,
          user_agent: bx.user_agent,
          x_ap: bx.x_ap,
        }
      : null,
    ts: Date.now(),
  }
}

async function applyProvidersSyncJob(args = {}) {
  const incoming = Array.isArray(args.providers) ? args.providers : null
  if (incoming) {
    // Merge server snapshot immediately (don't wait for GET).
    const byKey = new Map()
    for (const p of await getProviders()) {
      if (p?.key) byKey.set(p.key, p)
    }
    for (const p of incoming) {
      if (!p?.key) continue
      byKey.set(p.key, { ...byKey.get(p.key), ...p, enabled: p.enabled !== false })
    }
    if (args.providerKey && args.websiteUrl && !byKey.has(args.providerKey)) {
      byKey.set(args.providerKey, {
        key: args.providerKey,
        websiteUrl: args.websiteUrl,
        enabled: true,
      })
    }
    await setProviders(Array.from(byKey.values()), { skipCapture: true })
  }
  try {
    await syncProvidersNow()
  } catch (e) {
    console.warn('[mirage] syncProvidersNow after job failed', e)
  }
  const list = await getProviders()
  console.log(
    `[mirage] providers synced (${args.reason || 'job'}): ${list.length} provider(s)`,
  )
  return {
    ok: true,
    reason: args.reason || 'providers_changed',
    count: list.length,
    keys: list.map((p) => p.key),
  }
}

async function runToolJob(job) {
  const name = job.toolName
  const args = job.arguments || {}
  try {
    let result
    if (name === 'mirage_browser_fetch') result = await toolBrowserFetch(args)
    else if (name === 'mirage_read_tab') result = await toolReadTab(args)
    else if (name === 'mirage_list_tabs') result = await toolListTabs(args)
    else if (name === 'mirage_zai_captcha') result = await toolZaiCaptcha(args)
    else if (name === 'mirage_qwen_warmup') result = await toolQwenWarmup(args)
    else if (name === 'mirage_test_provider') {
      const providerKey = String(args.providerKey || '')
      result = await testProvider(providerKey)
    } else if (name === 'mirage_sync_providers') {
      result = await applyProvidersSyncJob(args)
    } else if (name === 'mirage_capture_provider') {
      await syncProvidersNow()
      const providerKey = String(args.providerKey || '')
      if (args.websiteUrl) {
        // Ensure domain map knows this platform before harvest
        const list = await getProviders()
        const found = list.find((p) => p.key === providerKey)
        if (!found) {
          list.push({
            key: providerKey,
            websiteUrl: args.websiteUrl,
            enabled: true,
          })
          await setProviders(list, { skipCapture: true })
        } else {
          mergeProviderDomains(list)
        }
      }
      const waitForLogin = args.waitForLogin !== false
      result = await oauthConnectCapture(providerKey, {
        trigger: 'capture_job',
        websiteUrl: args.websiteUrl,
        waitForLogin,
        waitMs: waitForLogin ? OAUTH_WAIT_MS : 0,
      })
    } else {
      throw new Error('Unknown tool: ' + name)
    }
    const deviceId = await getDeviceId()
    await postJSON('/api/extension/tools/result', {
      deviceId,
      jobId: job.id,
      ok: true,
      result,
    })
  } catch (e) {
    const deviceId = await getDeviceId()
    await postJSON('/api/extension/tools/result', {
      deviceId,
      jobId: job.id,
      ok: false,
      error: String(e?.message || e),
    }).catch(() => {})
  }
}

async function handlePendingTools(pendingTools) {
  if (!Array.isArray(pendingTools) || pendingTools.length === 0) return
  const urgent = []
  const slow = []
  for (const job of pendingTools) {
    const name = String(job?.toolName || '')
    // OAuth/warmup can take minutes — never block chat browser_fetch behind them.
    if (
      name === 'mirage_capture_provider' ||
      name === 'mirage_qwen_warmup' ||
      name === 'mirage_sync_providers'
    ) {
      slow.push(job)
    } else {
      urgent.push(job)
    }
  }
  for (const job of urgent) {
    await runToolJob(job)
  }
  // Detach slow jobs so the tools poll lock is released immediately.
  for (const job of slow) {
    runToolJob(job).catch((e) =>
      console.warn('[mirage] slow tool failed', job?.toolName, e),
    )
  }
}

// â”€â”€â”€ Triggers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

chrome.cookies.onChanged.addListener((changeInfo) => {
  const { cookie, removed } = changeInfo
  if (!cookie) return
  const providerKey = providerKeyFromDomain(cookie.domain)
  if (!providerKey) return

  const SKIP_NAMES = [
    '_ga',
    '_gid',
    '_gat',
    'AMP_TOKEN',
    '__gads',
    'NID',
    'IDE',
    '__cf_bm',
    'arena_visit_id',
    'user_country_code',
  ]
  if (SKIP_NAMES.includes(cookie.name)) return
  if (/^ph_/i.test(cookie.name) || /^_hj/i.test(cookie.name)) return
  // Analytics / visit noise must not schedule connect-style captures.
  if (
    !/auth|session|token|ticket|sid|psid|userToken|arena-auth|sessionKey|hf-chat|tongyi/i.test(
      cookie.name,
    )
  ) {
    return
  }

  if (/refresh/i.test(cookie.name) && cookie.value && !removed) {
    rememberObservedToken(providerKey, 'refresh', cookie.value)
  } else if (/token|auth|session|ticket|sid/i.test(cookie.name) && cookie.value && !removed) {
    rememberObservedToken(providerKey, 'access', cookie.value)
  }

  // During an in-flight OAuth connect, auth cookie arrival is enough â€”
  // the wait loop will pick it up on the next poll. Do not auto-capture
  // otherwise (web app Connect owns initial harvest).
  if (oauthConnectLocks.has(providerKey) && !removed && cookie.value) {
    console.log(`[mirage] auth cookie during oauth wait: ${providerKey}/${cookie.name}`)
  }
})

// Capture BaXia bx-* headers from live chat.qwen.ai traffic (empty streams without them).
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        if (!isQwenChatUrl(details.url)) return
        const headers = details.requestHeaders || []
        const map = {}
        for (const h of headers) {
          if (h?.name) map[String(h.name).toLowerCase()] = h.value || ''
        }
        if (!map['bx-ua'] || !map['bx-umidtoken']) return
        latestQwenBx = {
          bx_ua: map['bx-ua'],
          bx_umidtoken: map['bx-umidtoken'],
          bx_v: map['bx-v'] || '2.5.36',
          version: map['version'] || '',
          user_agent: map['user-agent'] || '',
          x_ap: map['x-ap'] || '',
          ts: Date.now(),
        }
        chrome.storage.local.set({ [QWEN_BX_KEY]: latestQwenBx }).catch(() => {})
      } catch {
        // ignore
      }
    },
    { urls: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] },
    ['requestHeaders', 'extraHeaders'],
  )
} catch (e) {
  console.warn('[mirage] webRequest bx listener unavailable', e)
}

// Capture Kimi Authorization: Bearer â€¦ from live www.kimi.com traffic.
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const u = new URL(details.url)
        if (!/(^|\.)kimi\.com$/i.test(u.hostname)) return
        const headers = details.requestHeaders || []
        let auth = ''
        for (const h of headers) {
          if (h?.name && String(h.name).toLowerCase() === 'authorization') {
            auth = h.value || ''
            break
          }
        }
        if (!auth || !/^Bearer\s+/i.test(auth)) return
        const token = auth.replace(/^Bearer\s+/i, '').trim()
        if (token.length < 8) return
        // Refresh endpoint uses Bearer <refresh_token> â€” do not store as access.
        const isRefresh = /\/api\/auth\/(token\/)?refresh/i.test(u.pathname)
        rememberObservedToken('kimi', isRefresh ? 'refresh' : 'access', token)
        scheduleCapture(
          'kimi',
          isRefresh ? 'webRequest:refresh' : 'webRequest:authorization',
        )
      } catch {
        // ignore
      }
    },
    {
      urls: [
        'https://www.kimi.com/*',
        'https://kimi.com/*',
        'https://*.kimi.com/*',
        'https://auth.kimi.com/*',
      ],
    },
    ['requestHeaders', 'extraHeaders'],
  )
} catch (e) {
  console.warn('[mirage] webRequest kimi auth listener unavailable', e)
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url) return
  try {
    const u = new URL(tab.url)
    const providerKey = providerKeyFromDomain(u.host)
    if (!providerKey) return
    scheduleCapture(providerKey, `tab:loaded:${u.pathname}`)
  } catch {
    // invalid URL
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg?.type === 'OBSERVED_TOKEN') {
        const tabUrl = sender?.tab?.url || msg.url
        if (tabUrl) {
          try {
            const u = new URL(tabUrl)
            const providerKey = providerKeyFromDomain(u.host)
            if (providerKey) {
              await rememberObservedToken(
                providerKey,
                msg.tokenKind || 'access',
                msg.value,
              )
              if (String(msg.source || '').toLowerCase().includes('refresh')) {
                await rememberObservedToken(providerKey, 'refresh', msg.value)
              }
              scheduleCapture(providerKey, `observed_token:${msg.source}`)
            }
          } catch {
            // ignore
          }
        }
        sendResponse({ ok: true, acked: true })
        return
      }

      if (msg?.type === 'OBSERVED_CAPTCHA') {
        try {
          const key = msg.providerKey || 'zai'
          if (msg.captcha_verify_param) {
            await rememberObservedCaptcha(key, msg.captcha_verify_param)
          }
        } catch {
          // ignore
        }
        sendResponse({ ok: true, acked: true })
        return
      }

      if (msg?.type === 'OBSERVED_QWEN_BX') {
        try {
          if (msg.bx_ua && msg.bx_umidtoken) {
            latestQwenBx = {
              bx_ua: String(msg.bx_ua),
              bx_umidtoken: String(msg.bx_umidtoken),
              bx_v: String(msg.bx_v || '2.5.36'),
              version: String(msg.version || ''),
              user_agent: String(msg.user_agent || ''),
              x_ap: String(msg.x_ap || ''),
              ts: Date.now(),
            }
            await chrome.storage.local.set({ [QWEN_BX_KEY]: latestQwenBx })
          }
        } catch {
          // ignore
        }
        sendResponse({ ok: true, acked: true })
        return
      }

      if (msg?.type === 'POLL_TOOLS_NOW') {
        try {
          const deviceId = await getDeviceId()
          const hb = await postJSON('/api/extension/heartbeat', {
            deviceId,
            version: chrome.runtime.getManifest().version,
            sessions: [],
            capabilities: [
              'tools',
              'capture',
              'test',
              'zai_captcha',
              'qwen_warmup',
            ],
          })
          if (Array.isArray(hb.providers)) {
            await setProviders(hb.providers, { skipCapture: true })
          }
          await handlePendingTools(hb.pendingTools)
          sendResponse({
            ok: true,
            pending: Array.isArray(hb.pendingTools) ? hb.pendingTools.length : 0,
          })
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) })
        }
        return
      }

      if (msg?.type === 'GET_STATUS') {
        const deviceId = await getDeviceId()
        const backend = await getBackendUrl()
        const providers = await getProviders()
        mergeProviderDomains(providers)
        const captureLog = await getCaptureLog()
        sendResponse({
          ok: true,
          deviceId,
          backend,
          providers,
          captureLog,
          browser: detectBrowser(),
          capabilities: ['tools', 'capture', 'test', 'zai_captcha', 'qwen_warmup'],
        })
      } else if (msg?.type === 'SET_BACKEND') {
        await setBackendUrl(msg.url)
        await registerDevice()
        sendResponse({ ok: true })
      } else if (msg?.type === 'CAPTURE') {
        const r = await captureSession(msg.providerKey, {
          label: msg.label,
          trigger: 'manual',
          openIfMissing: true,
        })
        sendResponse({ ok: true, session: r.session, validation: r.validation })
      } else if (msg?.type === 'TEST_PROVIDER') {
        const r = await testProvider(msg.providerKey)
        sendResponse({ ok: true, ...r })
      } else if (msg?.type === 'CAPTURE_ALL') {
        const providers = await getProviders()
        const results = []
        for (const p of providers) {
          try {
            const r = await captureSession(p.key, {
              trigger: 'manual-all',
              openIfMissing: false,
            })
            results.push({
              provider: p.key,
              ok: true,
              session: r.session,
              reason: r.reason,
            })
          } catch (e) {
            results.push({ provider: p.key, ok: false, error: String(e) })
          }
        }
        sendResponse({ ok: true, results })
      } else if (msg?.type === 'REFRESH_NOW') {
        await tickAll()
        sendResponse({ ok: true })
      } else if (msg?.type === 'SYNC_PROVIDERS') {
        await syncProvidersNow()
        sendResponse({ ok: true })
      } else if (msg?.type === 'GET_CAPTURE_LOG') {
        const log = await getCaptureLog()
        sendResponse({ ok: true, log })
      } else {
        sendResponse({ ok: false, error: 'unknown message: ' + msg?.type })
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) })
    }
  })()
  return true
})

async function syncProvidersNow() {
  try {
    const data = await getJSON('/api/extension/providers')
    await setProviders(data.providers || [], { skipCapture: true })
  } catch (e) {
    console.warn('[mirage] provider sync failed', e)
  }
}

/**
 * Refresh window (<15 min cycle): soft re-read tokens only.
 * OAuth waits are NEVER done here â€” capture jobs own that path.
 */
async function refreshTokensWindow() {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    try {
      await syncProvidersNow()
    } catch {
      // ignore
    }

    const providers = await getProviders()
    const deviceId = await getDeviceId()
    const sessionReports = []
    const enabled = providers.filter((p) => p && p.enabled !== false)

    for (const p of enabled) {
      try {
        // Skip providers waiting on OAuth â€” don't block the refresh burst.
        if (p.captureRequestedAt) continue

        const r = await captureSession(p.key, {
          trigger: 'refresh_window',
          openIfMissing: false,
        })
        if (r.session?.id) {
          sessionReports.push({
            sessionId: r.session.id,
            status: r.session.status,
            cookies: [],
          })
        }
      } catch (e) {
        console.warn('[mirage] refresh failed for', p.key, e)
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    try {
      const hb = await postJSON('/api/extension/heartbeat', {
        deviceId,
        version: chrome.runtime.getManifest().version,
        sessions: sessionReports,
        capabilities: [
          'tools',
          'capture',
          'test',
          'zai_captcha',
          'qwen_warmup',
          'refresh',
        ],
      })
      if (Array.isArray(hb.providers)) {
        await setProviders(hb.providers, { skipCapture: true })
      }
      await handlePendingTools(hb.pendingTools)
    } catch (e) {
      console.error('[mirage] refresh heartbeat failed', e)
    }
  } finally {
    refreshInFlight = false
  }
}

let refreshInFlight = false
let toolsPollInFlight = false
let lastToolsPollAt = 0

async function tickAll() {
  // Legacy name â€” now a short sequential token refresh window, not full reconnect.
  await refreshTokensWindow()
}

const ALARM_NAME = 'mirage-tick'
const SYNC_ALARM = 'mirage-sync'
/** Under 15 minutes: refresh every 12 minutes in a short sequential burst. */
const REFRESH_PERIOD_MIN = 12

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await registerDevice()
  } catch (e) {
    console.error('[mirage] register failed:', e)
  }
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MIN })
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 })
  refreshTokensWindow()
})

chrome.runtime.onStartup.addListener(async () => {
  try {
    await registerDevice()
  } catch (e) {
    console.warn('[mirage] re-register failed:', e)
  }
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MIN })
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 })
  refreshTokensWindow()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshTokensWindow()
    return
  }
  if (alarm.name === SYNC_ALARM) {
    void pollExtensionTools({ allowProviderSync: true })
  }
})

getProviders()
  .then((list) => mergeProviderDomains(list))
  .catch(() => {})

/**
 * Fast tool poll for chat (Claude/Arena viaBrowser, captcha, …).
 * NEVER skip because an OAuth connect is waiting — that froze working providers.
 */
const TOOLS_POLL_MS = 3_000

async function pollExtensionTools(opts = {}) {
  if (toolsPollInFlight) return
  toolsPollInFlight = true
  lastToolsPollAt = Date.now()
  try {
    const deviceId = await getDeviceId()
    const hb = await postJSON('/api/extension/heartbeat', {
      deviceId,
      version: chrome.runtime.getManifest().version,
      sessions: [],
      capabilities: ['tools', 'capture', 'test', 'zai_captcha', 'qwen_warmup'],
    })
    // Avoid thrashing content-scripts during an in-flight OAuth wait.
    if (
      Array.isArray(hb.providers) &&
      (opts.allowProviderSync || oauthConnectLocks.size === 0)
    ) {
      await setProviders(hb.providers, { skipCapture: true })
    }
    await handlePendingTools(hb.pendingTools)
  } catch {
    // backend may be down
  } finally {
    toolsPollInFlight = false
  }
}

setInterval(() => {
  void pollExtensionTools({ allowProviderSync: false })
}, TOOLS_POLL_MS)

console.log('[mirage] background service worker v1.6.8 active')
console.log('[mirage] browser:', detectBrowser())
console.log('[mirage] monitoring domains:', Object.keys(PROVIDER_DOMAINS))
