self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(windows =>
    windows.length ? windows[0].focus() : clients.openWindow('/')));
});
