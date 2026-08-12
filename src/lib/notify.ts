/**
 * Desktop Notification Utility
 * --------------------------------------------------------------------
 * Sends Windows toast notifications for critical events (captcha, WAF,
 * session errors) so the user doesn't have to watch console logs.
 *
 * Uses PowerShell's BurntToast module (preferred) with fallback to
 * .NET [Windows.UI.Notifications] API. Failures are silently ignored.
 */

import { exec } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'

// Throttle: don't spam the same notification within 60s
const notificationHistory = new Map<string, number>()
const THROTTLE_MS = 60_000

/**
 * Send a Windows desktop toast notification.
 * No-op on non-Windows platforms. Never throws.
 */
export function sendDesktopNotification(
  title: string,
  message: string,
): void {
  if (!IS_WINDOWS) return

  // Throttle duplicate notifications
  const key = `${title}::${message}`
  const last = notificationHistory.get(key) ?? 0
  if (Date.now() - last < THROTTLE_MS) return
  notificationHistory.set(key, Date.now())

  // Cleanup old throttle entries every 50 notifications
  if (notificationHistory.size > 50) {
    const cutoff = Date.now() - THROTTLE_MS
    for (const [k, ts] of notificationHistory.entries()) {
      if (ts < cutoff) notificationHistory.delete(k)
    }
  }

  const safeTitle = escapePS(title)
  const safeMessage = escapePS(message.slice(0, 300))

  // Try BurntToast first (prettier), fallback to .NET toast API
  const burntToast = `
    if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
      New-BurntToastNotification -Text '${safeTitle}', '${safeMessage}' -AppLogo $null
    } else {
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
      $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
      $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${safeTitle}</text><text id="2">${safeMessage}</text></binding></visual></toast>')
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Mirage').Show($toast)
    }
  `.trim()

  exec(
    `powershell -NoProfile -NonInteractive -Command "${burntToast.replace(/"/g, '\\"')}"`,
    { timeout: 10_000 },
    (err) => {
      if (err) {
        // Fallback: simple PowerShell balloon notification via .NET
        const balloon = `
          Add-Type -AssemblyName System.Windows.Forms
          $n = New-Object System.Windows.Forms.NotifyIcon
          $n.Icon = [System.Drawing.SystemIcons]::Warning
          $n.BalloonTipTitle = '${safeTitle}'
          $n.BalloonTipText = '${safeMessage}'
          $n.Visible = $true
          $n.ShowBalloonTip(5000)
          Start-Sleep -Seconds 6
          $n.Dispose()
        `.trim()

        exec(
          `powershell -NoProfile -NonInteractive -Command "${balloon.replace(/"/g, '\\"')}"`,
          { timeout: 15_000 },
          () => {
            // Silently ignore all notification failures
          },
        )
      }
    },
  )
}

/** Escape single quotes for PowerShell string literals. */
function escapePS(s: string): string {
  return s.replace(/'/g, "''").replace(/[\r\n]+/g, ' ')
}

/**
 * Convenience wrapper for captcha/WAF events.
 */
export function notifyCaptchaRequired(provider: string, detail: string): void {
  sendDesktopNotification(
    `⚠️ Mirage — ${provider} Captcha/WAF`,
    detail,
  )
}

/**
 * Convenience wrapper for session error events.
 */
export function notifySessionError(provider: string, detail: string): void {
  sendDesktopNotification(
    `❌ Mirage — ${provider} Session Error`,
    detail,
  )
}
