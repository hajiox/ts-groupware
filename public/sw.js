self.addEventListener('push', (event) => {
  if (!event.data) return

  try {
    const data = event.data.json()
    const options = {
      body: data.body || '',
      icon: data.icon || '/icon-192.png?v=20260618-tsg',
      badge: data.badge || '/icon-192.png?v=20260618-tsg',
      vibrate: [100, 50, 100],
      tag: data.tag || 'ts-groupware-notification',
      renotify: true,
      data: {
        url: data.url || '/',
      },
    }

    const badgeCount = Number(data.badgeCount || 0)
    const badgePromise = ('setAppBadge' in navigator)
      ? (badgeCount > 0
        ? navigator.setAppBadge(badgeCount).catch(err => console.error('[SW] Badge error', err))
        : Promise.resolve())
      : Promise.resolve()

    event.waitUntil(
      Promise.all([
        self.registration.showNotification(data.title || 'TS Groupware', options),
        badgePromise
      ])
    )
  } catch (err) {
    console.error('[SW] Push event error', err)
  }
})

function getNotificationTargetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '/', self.location.origin)
    if (url.origin !== self.location.origin) return `${self.location.origin}/groups`
    return url.href
  } catch {
    return `${self.location.origin}/groups`
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl = getNotificationTargetUrl(event.notification.data?.url)

  event.waitUntil((async () => {
    const target = new URL(targetUrl)
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const sameOriginClients = windowClients.filter((client) => {
      try {
        return new URL(client.url).origin === self.location.origin && 'focus' in client
      } catch {
        return false
      }
    })

    const exactClient = sameOriginClients.find((client) => {
      const url = new URL(client.url)
      return url.pathname === target.pathname && url.search === target.search
    })
    const reusableClient = exactClient || sameOriginClients.find((client) => {
      const url = new URL(client.url)
      return url.pathname !== '/login'
    })

    if (reusableClient) {
      try {
        await reusableClient.navigate(targetUrl)
      } catch (err) {
        console.error('[SW] Notification navigation error', err)
      }
      return reusableClient.focus()
    }

    if (clients.openWindow) {
      return clients.openWindow(targetUrl)
    }
  })())
})

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
