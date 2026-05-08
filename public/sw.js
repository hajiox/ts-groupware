self.addEventListener('push', (event) => {
  if (!event.data) return

  try {
    const data = event.data.json()
    const options = {
      body: data.body,
      icon: data.icon || '/icon-192x192.png',
      badge: '/icon-192x192.png',
      vibrate: [100, 50, 100],
      data: {
        url: data.url || '/',
      },
      tag: data.tag,
    }

    event.waitUntil(
      self.registration.showNotification(data.title, options)
    )
  } catch (err) {
    console.error('[SW] Push event error', err)
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const urlToOpen = event.notification.data.url
  if (!urlToOpen) return

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((windowClients) => {
      // 既に開いているウィンドウがあればフォーカス
      for (const client of windowClients) {
        if (client.url.includes(urlToOpen) && 'focus' in client) {
          return client.focus()
        }
      }
      // なければ新しく開く
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen)
      }
    })
  )
})
