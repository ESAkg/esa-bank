'use strict';
// ESA Bank — минималдык service worker: тиркемени "орнотулуучу" кылат жана
// оффлайн үчүн статикалык файлдарды кэштейт.
//
// МААНИЛҮҮ: мурда бул жерде "cache-first" стратегиясы болчу (адегенде
// кэштен берет, тармактан жаңыртуу фондо гана кийинки жолу үчүн болот).
// Бул ар бир деплойдон кийин колдонуучулардын телефонунда ЭСКИ app.js
// код иштеп кала беришине алып келген — жаңы функциялар (мисалы, акча
// алууну ырастоо билдирмеси) код жүктөлбөй тургандыктан такыр иштебей
// турган. Эми "network-first": интернет болсо — дайыма эң акыркы код,
// оффлайн болсо гана кэштен.
const CACHE = 'esa-bank-v3-network-first';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/app.js', '/js/i18n.js', '/js/charts.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // API всегда свежий, из сети
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
