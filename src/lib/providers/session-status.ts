/**
 * Keep captured sessions stable: soft validation warnings must not flip
 * status to `error` (that hides them from Import / "active" counts).
 */

export function isHardSessionFailure(reason?: string | null): boolean {
  if (!reason) return false
  return /INVALID_TOKEN|Authorization Failed|Session expired|\b401\b|User not found|No userToken|No access_token|no refresh_token|No Qwen token\/cookies|No .*cookies captured|missing userToken|needs arena-auth|missing auth|Chat needs arena-auth|missing tongyi|No usable Kimi/i.test(
    reason,
  )
}

export function sessionStatusAfterValidate(opts: {
  valid: boolean
  reason?: string | null
  cookieCount: number
  hasAccessToken: boolean
}): { status: 'active' | 'error'; errorMessage: string | null } {
  if (opts.valid) {
    // Keep soft warning text if validate returned a reason with valid=true.
    return {
      status: 'active',
      errorMessage: opts.reason ? opts.reason.slice(0, 500) : null,
    }
  }
  const reason = (opts.reason || 'invalid').slice(0, 500)
  const hasMaterial = opts.cookieCount > 0 || opts.hasAccessToken
  // Soft fail: keep active so Import/chat routing still see the jar; surface reason.
  if (hasMaterial && !isHardSessionFailure(reason)) {
    return { status: 'active', errorMessage: reason }
  }
  return { status: 'error', errorMessage: reason }
}
