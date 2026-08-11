'use client'

import { cn } from '@/lib/utils'

const ICONS = {
  home: '/icons/forge/home.svg',
  chat: '/icons/forge/chat.svg',
  plug: '/icons/forge/plug.svg',
  login: '/icons/forge/login.svg',
  trash: '/icons/forge/trash.svg',
  clear: '/icons/forge/clear.svg',
  user: '/icons/forge/user.svg',
  key: '/icons/forge/key.svg',
  puzzle: '/icons/forge/puzzle.svg',
  list: '/icons/forge/list.svg',
  refresh: '/icons/forge/refresh.svg',
  lock: '/icons/forge/lock.svg',
  check: '/icons/forge/check.svg',
  alert: '/icons/forge/alert.svg',
  external: '/icons/forge/external.svg',
} as const

export type ForgeIconName = keyof typeof ICONS

export function ForgeIcon({
  name,
  className,
  size = 20,
  neo = false,
  color = '#1902c5',
}: {
  name: ForgeIconName
  className?: string
  size?: number
  neo?: boolean
  /** Default icon stroke color from Forge screenshot */
  color?: string
}) {
  const icon = (
    <span
      role="img"
      aria-hidden
      className={cn('inline-block shrink-0', !neo && className)}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: `url(${ICONS[name]})`,
        maskImage: `url(${ICONS[name]})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
  if (!neo) return icon
  return (
    <span
      className={cn('forge-tile', className)}
      style={{ width: size + 20, height: size + 20 }}
    >
      {icon}
    </span>
  )
}
