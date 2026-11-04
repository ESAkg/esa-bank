// ESA Bank — public marketing site logic
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- mobile nav ----
  const burger = $('#burger-btn');
  const mobileNav = $('#mobile-nav');
  if (burger) {
    burger.addEventListener('click', () => mobileNav.classList.toggle('show'));
    $all('#mobile-nav a').forEach(a => a.addEventListener('click', () => mobileNav.classList.remove('show')));
  }

  // ---- header shadow on scroll ----
  const header = $('#site-header');
  window.addEventListener('scroll', () => {
    header.style.boxShadow = window.scrollY > 10 ? '0 8px 24px -16px rgba(0,0,0,0.5)' : 'none';
  });

  // ---- locations: map + list ----
  async function loadLocations() {
    const listBox = $('#about-locator-list');
    try {
      const res = await fetch('/api/locations');
      const data = await res.json();
      const items = [
        ...data.offices.map(o => ({ ...o, kind: 'office', label: o.name })),
        ...data.devices.filter(d => d.location && d.location.lat).map(d => ({ ...d, kind: 'device', label: d.label, address: d.location.address, lat: d.location.lat, lng: d.location.lng }))
      ];
      if (!items.length) {
        listBox.innerHTML = '<div class="map-fallback-note">Азырынча жайгашкан жерлер кошулган жок.</div>';
      } else {
        listBox.innerHTML = items.map(it => `
          <div class="about-loc-item">
            <b>${it.kind === 'office' ? '🏢 ' : (it.kind === 'device' ? '🏧 ' : '')}${escapeHtml(it.label)}</b>
            <span>${escapeHtml(it.address || '')}</span>
          </div>
        `).join('');
      }
      renderMap(items);
    } catch (e) {
      listBox.innerHTML = '<div class="map-fallback-note">Жайгашкан жерлерди жүктөй алган жокпуз.</div>';
      renderMap([]);
    }
  }

  function renderMap(items) {
    const mapBox = $('#about-locator-map');
    try {
      if (!window.L) throw new Error('no-leaflet');
      const center = items.length ? [items[0].lat, items[0].lng] : [42.8746, 74.5698];
      const map = L.map(mapBox, { scrollWheelZoom: false }).setView(center, 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19
      }).addTo(map);
      items.forEach(it => {
        if (!it.lat || !it.lng) return;
        L.marker([it.lat, it.lng]).addTo(map).bindPopup(`<b>${escapeHtml(it.label)}</b><br>${escapeHtml(it.address || '')}`);
      });
    } catch (e) {
      mapBox.innerHTML = '<div class="map-fallback-note">Карта жүктөлгөн жок (интернет талап кылынат). Тизмени төмөндө караңыз.</div>';
    }
  }

  loadLocations();

  // ---- smooth scroll for in-page anchors ----
  $all('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
})();
