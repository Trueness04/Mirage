/**
 * Mirage Content Script (v1.5)
 * --------------------------------------------------------------------
 * Runs on monitored AI websites (kimi, zai, deepseek, claude).
 *
 * Watches auth sources and forwards FULL token values to the background
 * so captures can store refresh_token / access_token even when they only
 * appear in Authorization headers (not localStorage).
 *
 * On chat.z.ai also:
 *  - intercepts captcha_verify_param from outgoing chat requests
 *  - polls the background so captcha tool jobs are picked up quickly
 */

(function () {
  const seenTokens = new Set()
  const isZai = /(^|\.)chat\.z\.ai$/i.test(location.host)
  const isKimi = /(^|\.)kimi\.com$/i.test(location.host)
  const isQwen =
    /(^|\.)qwen\.ai$/i.test(location.host) ||
    /(^|\.)tongyi\.aliyun\.com$/i.test(location.host) ||
    /(^|\.)aliyun\.com$/i.test(location.host)

  function stripBearer(value) {
    if (!value) return value
    return String(value).replace(/^Bearer\s+/i, '').trim()
  }

  function notifyToken(source, value, opts) {
    if (!value) return
    const raw = stripBearer(value)
    if (!raw || raw.length < 8) return
    const dedupeKey = source + ':' + raw.slice(0, 48)
    if (seenTokens.has(dedupeKey)) return
    seenTokens.add(dedupeKey)
    try {
      chrome.runtime.sendMessage({
        type: 'OBSERVED_TOKEN',
        source,
        // Full value — background needs it for providers that never
        // persist refresh_token into a readable cookie/localStorage key.
        value: raw,
        tokenKind: opts?.tokenKind || guessTokenKind(source, raw),
        url: location.href,
        ts: Date.now(),
      })
    } catch {
      // ignore — background may not be ready
    }
  }

  function notifyCaptcha(param, source) {
    if (!param || String(param).length < 8) return
    try {
      chrome.runtime.sendMessage({
        type: 'OBSERVED_CAPTCHA',
        providerKey: 'zai',
        captcha_verify_param: String(param),
        source: source || 'fetch',
        url: location.href,
        ts: Date.now(),
      })
    } catch {
      // ignore
    }
  }

  function guessTokenKind(source, value) {
    const s = String(source).toLowerCase()
    if (s.includes('refresh')) return 'refresh'
    if (s.includes('access') || s.includes('authorization') || s === 'fetch' || s === 'xhr') {
      return 'access'
    }
    // Heuristic: longer JWT-looking refresh tokens often appear alongside access
    if (value.split('.').length === 3) return 'access'
    return 'unknown'
  }

  function maybeExtractCaptcha(body) {
    if (!isZai || body == null) return
    try {
      let text = null
      if (typeof body === 'string') text = body
      else if (body instanceof URLSearchParams) text = body.toString()
      if (!text || text.indexOf('captcha_verify_param') < 0) return
      const j = JSON.parse(text)
      if (j && typeof j.captcha_verify_param === 'string') {
        notifyCaptcha(j.captcha_verify_param, 'request-body')
      }
    } catch {
      // ignore non-JSON bodies
    }
  }

  // ─── Patch fetch / XHR in THIS isolated world (auth headers) ───
  const origFetch = window.fetch
  window.fetch = function (input, init) {
    try {
      const headers = init?.headers
      if (headers) {
        let auth
        if (headers instanceof Headers) auth = headers.get('Authorization')
        else if (Array.isArray(headers))
          auth = (headers.find((h) => h[0].toLowerCase() === 'authorization') || [])[1]
        else if (typeof headers === 'object')
          auth = headers['Authorization'] || headers['authorization']
        if (auth) notifyToken('fetch', auth, { tokenKind: 'access' })
      }
      if (init?.body) maybeExtractCaptcha(init.body)
    } catch {
      // ignore
    }
    return origFetch.call(this, input, init)
  }

  const origOpen = XMLHttpRequest.prototype.open
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === 'authorization') {
      notifyToken('xhr', value, { tokenKind: 'access' })
    }
    return origSetHeader.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    try {
      maybeExtractCaptcha(body)
    } catch {
      // ignore
    }
    return origSend.apply(this, arguments)
  }

  // Qwen BaXia bx-* headers only appear on MAIN-world requests; bridge them
  // to the background so warmup/capture can persist __mirage_bx_* entries.
  if (isQwen) {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.source !== window) return
        const data = ev.data
        if (!data || data.source !== 'mirage-qwen-bx-hook') return
        if (!data.bx_ua || !data.bx_umidtoken) return
        chrome.runtime.sendMessage({
          type: 'OBSERVED_QWEN_BX',
          bx_ua: String(data.bx_ua),
          bx_umidtoken: String(data.bx_umidtoken),
          bx_v: data.bx_v ? String(data.bx_v) : '',
          version: data.version ? String(data.version) : '',
          user_agent: data.user_agent ? String(data.user_agent) : '',
          x_ap: data.x_ap ? String(data.x_ap) : '',
          ts: Date.now(),
        })
      } catch {
        // ignore
      }
    })

    const injectQwenBx = () => {
      const s = document.createElement('script')
      s.textContent = `(() => {
        if (window.__mirageQwenBxHooked) return;
        window.__mirageQwenBxHooked = true;
        const post = (h) => {
          try {
            if (!h || !h['bx-ua'] || !h['bx-umidtoken']) return;
            window.postMessage({
              source: 'mirage-qwen-bx-hook',
              bx_ua: h['bx-ua'],
              bx_umidtoken: h['bx-umidtoken'],
              bx_v: h['bx-v'] || '',
              version: h['version'] || '',
              user_agent: h['user-agent'] || navigator.userAgent || '',
              x_ap: h['x-ap'] || '',
            }, '*');
          } catch (_) {}
        };
        const readHeaders = (init, input) => {
          const out = {};
          const take = (name, value) => {
            if (name && value != null) out[String(name).toLowerCase()] = String(value);
          };
          try {
            if (input && typeof Request !== 'undefined' && input instanceof Request) {
              input.headers.forEach((v, k) => take(k, v));
            }
          } catch (_) {}
          try {
            const h = init && init.headers;
            if (!h) return out;
            if (h instanceof Headers) h.forEach((v, k) => take(k, v));
            else if (Array.isArray(h)) for (const [k, v] of h) take(k, v);
            else if (typeof h === 'object') for (const [k, v] of Object.entries(h)) take(k, v);
          } catch (_) {}
          return out;
        };
        const ofetch = window.fetch;
        window.fetch = function (input, init) {
          try { post(readHeaders(init, input)); } catch (_) {}
          return ofetch.apply(this, arguments);
        };
        const oset = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          try {
            this.__mirageHdrs = this.__mirageHdrs || {};
            if (name) this.__mirageHdrs[String(name).toLowerCase()] = String(value || '');
            post(this.__mirageHdrs);
          } catch (_) {}
          return oset.apply(this, arguments);
        };
      })();`
      ;(document.documentElement || document.head || document.body).appendChild(s)
      s.remove()
    }
    try {
      injectQwenBx()
    } catch {
      // ignore
    }
  }

  // Page-world fetch (chat.z.ai SPA) is invisible to isolated content scripts.
  // Inject a MAIN-world hook and bridge captcha tokens back via CustomEvent.
  if (isZai) {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.source !== window) return
        const data = ev.data
        if (!data || data.source !== 'mirage-zai-captcha-hook') return
        if (data.captcha_verify_param) {
          notifyCaptcha(data.captcha_verify_param, 'page-fetch')
        }
      } catch {
        // ignore
      }
    })

    const inject = () => {
      const s = document.createElement('script')
      s.textContent = `(() => {
        if (window.__mirageZaiCaptchaHooked) return;
        window.__mirageZaiCaptchaHooked = true;
        const post = (param) => {
          try {
            window.postMessage({
              source: 'mirage-zai-captcha-hook',
              captcha_verify_param: param,
            }, '*');
          } catch (_) {}
        };
        const scan = (body) => {
          try {
            if (typeof body !== 'string' || body.indexOf('captcha_verify_param') < 0) return;
            const j = JSON.parse(body);
            if (j && typeof j.captcha_verify_param === 'string' && j.captcha_verify_param.length > 8) {
              post(j.captcha_verify_param);
            }
          } catch (_) {}
        };
        const ofetch = window.fetch;
        window.fetch = function (input, init) {
          try { if (init && init.body) scan(init.body); } catch (_) {}
          return ofetch.apply(this, arguments);
        };
        const osend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
          try { scan(body); } catch (_) {}
          return osend.apply(this, arguments);
        };
      })();`
      ;(document.documentElement || document.head || document.body).appendChild(s)
      s.remove()
    }
    try {
      inject()
    } catch {
      // ignore
    }
  }

  // Page-world fetch (Kimi SPA) — Authorization + refresh response bodies.
  if (isKimi) {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.source !== window) return
        const data = ev.data
        if (!data || data.source !== 'mirage-kimi-auth-hook') return
        if (data.authorization) {
          const kind =
            data.tokenKind === 'refresh'
              ? 'refresh'
              : data.tokenKind === 'access'
                ? 'access'
                : guessTokenKind(String(data.url || ''), String(data.authorization))
          notifyToken(
            kind === 'refresh' ? 'page-refresh-auth' : 'page-authorization',
            data.authorization,
            { tokenKind: kind },
          )
        }
        if (data.access_token) {
          notifyToken('page-access-body', data.access_token, {
            tokenKind: 'access',
          })
        }
        if (data.refresh_token) {
          notifyToken('page-refresh-body', data.refresh_token, {
            tokenKind: 'refresh',
          })
        }
      } catch {
        // ignore
      }
    })

    const injectKimiAuth = () => {
      const s = document.createElement('script')
      s.textContent = `(() => {
        if (window.__mirageKimiAuthHooked) return;
        window.__mirageKimiAuthHooked = true;
        const isRefreshUrl = (url) => /\\/api\\/auth\\/(token\\/)?refresh/i.test(String(url || ''));
        const readHeaders = (init, input) => {
          const out = {};
          const take = (name, value) => {
            if (name && value != null) out[String(name).toLowerCase()] = String(value);
          };
          try {
            if (input && typeof Request !== 'undefined' && input instanceof Request) {
              input.headers.forEach((v, k) => take(k, v));
            }
          } catch (_) {}
          try {
            const h = init && init.headers;
            if (!h) return out;
            if (h instanceof Headers) h.forEach((v, k) => take(k, v));
            else if (Array.isArray(h)) for (const [k, v] of h) take(k, v);
            else if (typeof h === 'object') for (const [k, v] of Object.entries(h)) take(k, v);
          } catch (_) {}
          return out;
        };
        const postAuth = (url, headers) => {
          try {
            const auth = headers['authorization'];
            if (!auth) return;
            window.postMessage({
              source: 'mirage-kimi-auth-hook',
              authorization: auth,
              tokenKind: isRefreshUrl(url) ? 'refresh' : 'access',
              url: String(url || ''),
            }, '*');
          } catch (_) {}
        };
        const postBodyTokens = (j) => {
          if (!j || typeof j !== 'object') return;
          try {
            window.postMessage({
              source: 'mirage-kimi-auth-hook',
              access_token: j.access_token || j.accessToken || j.token || null,
              refresh_token: j.refresh_token || j.refreshToken || null,
            }, '*');
          } catch (_) {}
        };
        const ofetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          try { postAuth(url, readHeaders(init, input)); } catch (_) {}
          const p = ofetch.apply(this, arguments);
          if (isRefreshUrl(url)) {
            return Promise.resolve(p).then((resp) => {
              try {
                resp.clone().json().then(postBodyTokens).catch(() => {});
              } catch (_) {}
              return resp;
            });
          }
          return p;
        };
        const oset = XMLHttpRequest.prototype.setRequestHeader;
        const oopen = XMLHttpRequest.prototype.open;
        const osend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__mirageUrl = url;
          return oopen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          try {
            this.__mirageHdrs = this.__mirageHdrs || {};
            if (name) this.__mirageHdrs[String(name).toLowerCase()] = String(value || '');
            postAuth(this.__mirageUrl, this.__mirageHdrs);
          } catch (_) {}
          return oset.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          try {
            if (isRefreshUrl(this.__mirageUrl)) {
              this.addEventListener('load', function () {
                try { postBodyTokens(JSON.parse(this.responseText || '{}')); } catch (_) {}
              });
            }
          } catch (_) {}
          return osend.apply(this, arguments);
        };
      })();`
      ;(document.documentElement || document.head || document.body).appendChild(s)
      s.remove()
    }
    try {
      injectKimiAuth()
    } catch {
      // ignore
    }
  }

  // ─── Poll localStorage + sessionStorage ─────────────────────────
  const TOKEN_KEYS = [
    'userToken',
    'access_token',
    'refresh_token',
    'token',
    'sessionKey',
    'authToken',
    'accessToken',
    'refreshToken',
  ]

  let lastSeenValues = {}

  function harvestStorage(storage, prefix) {
    if (!storage) return
    for (const k of TOKEN_KEYS) {
      try {
        const v = storage.getItem(k)
        if (v && v !== lastSeenValues[prefix + k]) {
          lastSeenValues[prefix + k] = v
          const kind = /refresh/i.test(k) ? 'refresh' : 'access'
          notifyToken(prefix + k, v, { tokenKind: kind })
        }
      } catch {
        // ignore
      }
    }
    // Nested JSON blobs (some sites store {access_token, refresh_token})
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key) continue
        const raw = storage.getItem(key)
        if (!raw || raw.length < 20 || raw[0] !== '{') continue
        if (raw === lastSeenValues[prefix + 'json:' + key]) continue
        try {
          const obj = JSON.parse(raw)
          if (!obj || typeof obj !== 'object') continue
          lastSeenValues[prefix + 'json:' + key] = raw
          for (const [tk, tv] of Object.entries(obj)) {
            if (
              typeof tv === 'string' &&
              tv.length > 16 &&
              /token|session|auth/i.test(tk)
            ) {
              const kind = /refresh/i.test(tk) ? 'refresh' : 'access'
              notifyToken(prefix + 'json:' + key + '.' + tk, tv, { tokenKind: kind })
            }
          }
        } catch {
          // not JSON
        }
      }
    } catch {
      // ignore
    }
  }

  setInterval(() => {
    try {
      harvestStorage(window.localStorage, 'localStorage:')
    } catch {
      // ignore
    }
    try {
      harvestStorage(window.sessionStorage, 'sessionStorage:')
    } catch {
      // ignore
    }
  }, 2000)

  function checkDocumentCookies() {
    try {
      const cookies = document.cookie
      if (!cookies) return
      const candidates = cookies.split(';').map((c) => c.trim().split('='))
      for (const [name, value] of candidates) {
        if (
          /token|session|auth/i.test(name) &&
          value &&
          value.length > 16 &&
          !seenTokens.has('cookie:' + name)
        ) {
          seenTokens.add('cookie:' + name)
          const kind = /refresh/i.test(name) ? 'refresh' : 'access'
          notifyToken('document.cookie:' + name, value, { tokenKind: kind })
        }
      }
    } catch {
      // ignore
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkDocumentCookies)
  } else {
    checkDocumentCookies()
  }

  // Keep the service worker awake and pick up captcha/WAF tool jobs fast
  // while a z.ai / qwen tab is open.
  if (isZai || isQwen) {
    setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: 'POLL_TOOLS_NOW' })
      } catch {
        // ignore
      }
    }, 2000)
  }

  console.log('[Mirage] content script v1.5 active on', location.host)
})()
