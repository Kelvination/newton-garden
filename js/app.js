const app = document.getElementById('app');

const CATEGORIES = [
  { id: 'flowers', label: 'Flowers', emoji: '🌸' },
  { id: 'herbs',   label: 'Herbs',   emoji: '🌿' },
  { id: 'edibles', label: 'Edibles', emoji: '🍅' },
];

let DATA = null;
let ORDER = [];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

async function loadData() {
  const r = await fetch('data/plants.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Failed to load plants.json: ${r.status}`);
  DATA = await r.json();

  ORDER = [];
  for (const cat of CATEGORIES) {
    const inCat = DATA.plants
      .filter((p) => p.category === cat.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    ORDER.push(...inCat);
  }
}

function render() {
  const id = location.hash.replace(/^#\/?/, '');
  if (!id) return renderHome();
  if (id === 'tree') return renderTree();
  const plant = ORDER.find((p) => p.id === id);
  if (!plant) return renderNotFound();
  renderDetail(plant);
}

function renderTree() {
  if (window.NewtonTree && DATA) {
    window.NewtonTree.render(app, DATA.plants);
  } else {
    app.innerHTML = `<div class="notfound"><h2>Tree unavailable</h2><p><a href="#/">← Back to garden</a></p></div>`;
  }
}

function renderHome() {
  document.title = 'Newton Garden';
  const sections = CATEGORIES.map((cat) => {
    const plants = ORDER.filter((p) => p.category === cat.id);
    if (!plants.length) return '';
    return `
      <h2 class="section-label"><span class="emoji">${cat.emoji}</span>${escapeHtml(cat.label)}</h2>
      <ul class="plant-list">
        ${plants.map((p) => `
          <li class="plant-row" data-id="${escapeHtml(p.id)}">
            <div class="plant-thumb cat-${escapeHtml(p.category)}"${p.photo ? ` style="background-image: url('${escapeHtml(p.photo)}')"` : ''}></div>
            <div class="plant-meta">
              <div class="plant-name">${escapeHtml(p.name)}</div>
              ${p.scientificName ? `<div class="plant-sub">${escapeHtml(p.scientificName)}</div>` : ''}
            </div>
            <div class="plant-chev">›</div>
          </li>
        `).join('')}
      </ul>
    `;
  }).join('');

  app.innerHTML = `
    <header class="home-header">
      <h1 class="home-title">Newton Garden</h1>
      <p class="home-subtitle">${DATA.plants.length} plants</p>
      <a class="tree-link" href="#/tree">View the family tree</a>
    </header>
    ${sections}
    <footer class="home-footer">Tap a plant for care info.</footer>
  `;

  app.querySelectorAll('.plant-row').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = '#/' + el.dataset.id;
    });
  });

  window.scrollTo(0, 0);
}

function renderNotFound() {
  document.title = 'Newton Garden';
  app.innerHTML = `
    <div class="notfound">
      <h2>Plant not found</h2>
      <p><a href="#/">← Back to garden</a></p>
    </div>
  `;
}

function renderDetail(plant) {
  document.title = `${plant.name} · Newton Garden`;

  const idx = ORDER.findIndex((p) => p.id === plant.id);
  const prev = ORDER[(idx - 1 + ORDER.length) % ORDER.length];
  const next = ORDER[(idx + 1) % ORDER.length];

  const isEdible = plant.category === 'edibles';
  const chips = plant.chips || {};
  const stats = plant.stats || {};

  const seasonIcon = isEdible ? '🌾' : '🌸';

  const chipHTML = [
    chips.sun     && `<span class="chip"><span class="ic">☀️</span>${escapeHtml(chips.sun)}</span>`,
    chips.water   && `<span class="chip"><span class="ic">💧</span>${escapeHtml(chips.water)}</span>`,
    chips.season  && `<span class="chip"><span class="ic">${seasonIcon}</span>${escapeHtml(chips.season)}</span>`,
    chips.zones   && `<button type="button" class="chip chip-zone" id="zone-chip"><span class="ic">📍</span>Zone ${escapeHtml(chips.zones)}<span class="zone-help">?</span></button>`,
  ].filter(Boolean).join('');

  const statHTML = [
    stats.height   && statBox('Height', stats.height),
    stats.spacing  && statBox('Spacing', stats.spacing),
    stats.season   && statBox(isEdible ? 'Harvest' : 'Bloom', stats.season),
    stats.lifespan && statBox('Lifespan', stats.lifespan),
    isEdible && plant.daysToMaturity && statBox('Days to Harvest', plant.daysToMaturity),
    isEdible && plant.yield          && statBox('Yield', plant.yield),
  ].filter(Boolean).join('');

  const heroStyle = plant.photo ? `background-image: url('${escapeHtml(plant.photo)}')` : '';

  app.innerHTML = `
    <article class="plant-detail">
      <nav class="detail-nav">
        <a class="nav-link nav-prev" href="#/${escapeHtml(prev.id)}">← ${escapeHtml(prev.name)}</a>
        <a class="nav-home" href="#/" aria-label="Home">⌂</a>
        <a class="nav-link nav-next" href="#/${escapeHtml(next.id)}">${escapeHtml(next.name)} →</a>
      </nav>
      <div class="hero" data-cat="${escapeHtml(plant.category)}" style="${heroStyle}">
        <div class="hero-overlay">
          <h1 class="hero-name">${escapeHtml(plant.name)}</h1>
          ${plant.scientificName ? `<p class="hero-sci">${escapeHtml(plant.scientificName)}</p>` : ''}
        </div>
      </div>
      <section class="detail-body">
        ${chipHTML ? `<div class="chips">${chipHTML}</div>` : ''}
        <div class="zone-tooltip" id="zone-tooltip" hidden>
          <p><strong>USDA Plant Hardiness Zones</strong> — bands based on average lowest winter temperature, 10°F apart. Zone 4 lows: −30 to −20°F. Zone 9: 20 to 30°F. This plant survives winters within its listed range.</p>
        </div>
        ${statHTML ? `<div class="stat-grid">${statHTML}</div>` : ''}
        ${section('Watering', plant.watering)}
        ${section('Light & Soil', plant.lightSoil)}
        ${section('What to expect', plant.whatToExpect)}
        ${section('Care tips', plant.careTips)}
        ${isEdible && plant.harvestTips ? section('Harvest tips', plant.harvestTips) : ''}
        ${section('Notes', plant.notes)}
        ${plant.facts && plant.facts.length ? `
          <div class="section facts">
            <h3>Interesting facts</h3>
            <ul>${plant.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
          </div>` : ''}
      </section>
      ${plant.photoCredit ? `<div class="photo-credit">Photo: ${plant.photoCredit}</div>` : ''}
    </article>
  `;

  const zoneChip = document.getElementById('zone-chip');
  const zoneTip  = document.getElementById('zone-tooltip');
  if (zoneChip && zoneTip) {
    zoneChip.addEventListener('click', () => { zoneTip.hidden = !zoneTip.hidden; });
  }

  attachSwipe(
    document.querySelector('.plant-detail'),
    () => { location.hash = '#/' + next.id; },
    () => { location.hash = '#/' + prev.id; }
  );

  window.scrollTo(0, 0);
}

function statBox(label, val) {
  return `<div class="stat-box"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-val">${escapeHtml(val)}</div></div>`;
}

function section(title, body) {
  if (!body) return '';
  return `<div class="section"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`;
}

function attachSwipe(el, onSwipeLeft, onSwipeRight) {
  if (!el) return;
  let startX = 0, startY = 0, active = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    active = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onSwipeLeft();
      else onSwipeRight();
    }
  });
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadData();
    render();
  } catch (err) {
    app.innerHTML = `<div class="notfound"><h2>Couldn't load garden</h2><p>${escapeHtml(err.message)}</p></div>`;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
