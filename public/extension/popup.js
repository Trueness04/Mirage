const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  setTimeout(() => (el.textContent = ''), 3200)
}

async function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      resolve(
        resp || {
          ok: false,
          error: chrome.runtime.lastError?.message || 'unknown',
        },
      )
    })
  })
}

function fmtTimeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h'
}

const refreshIcon = `
  <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
`

async function refreshStatus() {
  const r = await send('GET_STATUS')
  if (!r.ok) {
    toast('Error: ' + r.error)
    return
  }
  $('#device-id').textContent =
    (r.browser ? r.browser + ' · ' : '') + r.deviceId.slice(0, 12) + '…'
  $('#backend-url').value = r.backend

  const list = $('#provider-list')
  if (!r.providers || r.providers.length === 0) {
    list.innerHTML =
      '<div class="status-line">No providers. Save backend URL, then connect OAuth from the web app.</div>'
  } else {
    list.innerHTML = r.providers
      .map(
        (p) => `
      <div class="provider">
        <div class="meta">
          <div class="name">${escapeHtml(p.displayName || p.key)}</div>
          <div class="url">${escapeHtml(p.websiteUrl || '')}</div>
        </div>
        <button class="icon-btn" data-cap="${escapeAttr(p.key)}" title="Refresh tokens">
          ${refreshIcon}
        </button>
      </div>
    `,
      )
      .join('')
    $$('button[data-cap]').forEach((b) =>
      b.addEventListener('click', async () => {
        const k = b.getAttribute('data-cap')
        toast('Refreshing ' + k + '…')
        const resp = await send('CAPTURE', { providerKey: k })
        if (resp.ok) {
          toast(
            'Updated ' + k + ': ' + (resp.session?.status || resp.reason || 'ok'),
          )
          refreshStatus()
        } else {
          toast('Failed: ' + resp.error)
        }
      }),
    )
  }

  const logEl = $('#capture-log')
  if (!r.captureLog || r.captureLog.length === 0) {
    logEl.innerHTML =
      '<div class="log-empty">No activity yet. Connect from the web app, then tokens refresh here.</div>'
  } else {
    logEl.innerHTML =
      '<div class="log-list">' +
      r.captureLog
        .map(
          (e) => `
        <div class="log-item">
          <span class="log-ts">${fmtTimeAgo(e.ts)}</span>
          <span class="log-provider">${escapeHtml(e.provider)}</span>
          <span class="log-trigger" title="${escapeAttr(e.trigger || '')}">${escapeHtml(e.trigger || '')}</span>
          <span class="log-status ${escapeAttr(e.status || '')}">${escapeHtml(e.status || '—')}</span>
        </div>
      `,
        )
        .join('') +
      '</div>'
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;')
}

$('#btn-save-backend').addEventListener('click', async () => {
  const url = $('#backend-url').value.trim().replace(/\/$/, '')
  const r = await send('SET_BACKEND', { url })
  toast(r.ok ? 'Backend saved' : 'Failed: ' + r.error)
  refreshStatus()
})

$('#btn-capture-all').addEventListener('click', async () => {
  toast('Refreshing all tokens…')
  const r = await send('CAPTURE_ALL')
  if (r.ok) {
    const succ = r.results.filter((x) => x.ok && x.session).length
    const noCookie = r.results.filter((x) => x.ok && x.reason === 'no_cookies').length
    const fail = r.results.filter((x) => !x.ok).length
    toast(`Updated ${succ} · missing ${noCookie} · failed ${fail}`)
    refreshStatus()
  } else {
    toast('Failed: ' + r.error)
  }
})

$('#btn-refresh').addEventListener('click', async () => {
  const r = await send('REFRESH_NOW')
  toast(r.ok ? 'Heartbeat triggered' : 'Failed: ' + r.error)
})

refreshStatus()
