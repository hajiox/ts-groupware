self.addEventListener('push', (event) => {
  if (!event.data) return

  try {
    const data = event.data.json()
    const options = {
      body: data.body || '',
      icon: data.icon || '/icon-192x192.png',
      badge: data.badge || '/icon-192x192.png',
      vibrate: [100, 50, 100],
      tag: data.tag || 'ts-groupware-notification',
      renotify: true,
      data: {
        url: data.url || '/',
      },
    }

    const badgePromise = ('setAppBadge' in navigator)
      ? navigator.setAppBadge().catch(err => console.error('[SW] Badge error', err))
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(err => console.error('[SW] clearBadge error', err));
  }

  const urlToOpen = event.notification.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(urlToOpen)
          return client.focus()
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(urlToOpen)
      }
    })
  )
})

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
