/**
 * Safe shapes for API responses — never leak cookies / tokens to the dashboard.
 */

export function publicSession<T extends Record<string, unknown>>(s: T) {
  const {
    cookies: _c,
    accessToken: _a,
    refreshToken: _r,
    ...rest
  } = s as T & {
    cookies?: unknown
    accessToken?: unknown
    refreshToken?: unknown
  }
  return {
    ...rest,
    hasCookies: Array.isArray(_c)
      ? _c.length > 0
      : typeof _c === 'string'
        ? _c !== '[]' && _c.length > 2
        : false,
    hasAccessToken: Boolean(_a),
    hasRefreshToken: Boolean(_r),
  }
}
