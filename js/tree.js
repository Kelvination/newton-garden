/* Living Family Tree — interactive taxonomic node graph for Newton Garden.
 *
 * Every node (family / genus / species / plant / fetched taxon) is a card with
 * a photo, selectable for an info panel, and expandable one rank at a time via
 * the read-only iNaturalist API (no key). Garden plants use local photos;
 * family / genus / species nodes lazily fetch a representative photo; pulled
 * relatives ("suggestions") carry their own photo + attribution.
 *
 * Exposed as window.NewtonTree.render(appEl, plants). Vanilla JS, no build. */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const API = 'https://api.inaturalist.org/v1';

  const COL_W = 172;          // horizontal gap between adjacent leaves
  const V_GAP = 46;           // vertical gap between depth rows
  const CARD_W = 150;
  const PHOTO_X = -69, PHOTO_Y = 6, PHOTO_W = 138, PHOTO_H = 70;
  const MIN_K = 0.05;
  const MAX_K = 3;
  const FETCH_TIMEOUT = 9000;
  const MAX_RESULTS = 6;
  const INFO_CONCURRENCY = 3;

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lc = (s) => String(s || '').trim().toLowerCase();
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // text node; maxw (optional) records a width budget the post-draw fit pass
  // uses to ellipsize so nothing escapes the card.
  function svgText(content, attrs, cls, maxw) {
    const t = svgEl('text', attrs);
    if (cls) t.setAttribute('class', cls);
    if (maxw) t.setAttribute('data-maxw', maxw);
    t.textContent = content == null ? '' : content;
    return t;
  }

  function wrapText(text, maxChars, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
      else { lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /* ---------- taxonomy parsing ---------- */

  function parseTaxon(name) {
    let s = String(name || '');
    s = s.replace(/['‘’"][^'‘’"]*['‘’"]/g, ' '); // cultivar in quotes
    s = s.replace(/\([^)]*\)/g, ' ');             // parentheticals
    let tokens = s.trim().split(/\s+/).filter(Boolean);
    const RANK = /^(spp?|cv|var|subsp|ssp|f|nothosp)\.?$/i;
    tokens = tokens.filter((t) => !RANK.test(t) && t !== '×' && t.toLowerCase() !== 'x');
    const genus = tokens[0] ? tokens[0][0].toUpperCase() + tokens[0].slice(1) : '';
    let species = '';
    if (tokens[1] && /^[a-zà-ÿ][a-zà-ÿ-]+$/i.test(tokens[1])) species = genus + ' ' + tokens[1].toLowerCase();
    return { genus, species };
  }

  /* ---------- module state ---------- */

  const state = {
    plants: [],
    genusToFamily: {},
    familyCommon: {},
    familyCache: {},
    nodeInfo: {},           // key -> {taxonId, common, photoUrl, attribution, wikipedia, inat, obs, resolved}
    injected: [],           // session expansions (flat, parent-before-child order)
    fetchCache: new Map(),
    root: null,
    nodesByKey: new Map(),
    elByKey: new Map(),
    selectedKey: null,
    tx: 0, ty: 0, k: 1,
    svg: null, gRoot: null, panel: null,
    anim: null, rebuildTimer: null, teardown: null,
  };

  function resolveFamilySync(genus) {
    return state.genusToFamily[genus] || state.familyCache[genus] || null;
  }

  /* ---------- model ---------- */

  function makeNode(key, rank, label) {
    return { key, rank, label, children: [], parent: null, tax: {} };
  }
  function addChild(parent, child) { child.parent = parent; parent.children.push(child); }

  function childRankOf(node) {
    return { family: 'genus', genus: 'species', species: 'subspecies' }[node.rank] || null;
  }

  function taxFromParent(parentTax, rank, sci) {
    const t = Object.assign({}, parentTax);
    if (rank === 'genus') { t.genus = sci; t.species = ''; }
    else if (rank === 'species') { t.species = sci; }
    // subspecies inherits the parent species (same species for crossing)
    return t;
  }

  function buildModel() {
    state.nodesByKey = new Map();
    const reg = (n) => { state.nodesByKey.set(n.key, n); return n; };

    const root = reg(makeNode('root', 'root', 'Newton Garden'));
    const families = new Map(), genera = new Map(), speciesNodes = new Map();
    const unknown = new Set();

    for (const p of state.plants) {
      const t = parseTaxon(p.scientificName);
      let family = resolveFamilySync(t.genus);
      if (!family) { family = 'Unplaced'; if (t.genus) unknown.add(t.genus); }

      let fNode = families.get(family);
      if (!fNode) {
        fNode = reg(makeNode('family:' + family, 'family', family));
        fNode.commonName = state.familyCommon[family] || '';
        fNode.tax = { family };
        addChild(root, fNode); families.set(family, fNode);
      }
      const gKey = family + '|' + t.genus;
      let gNode = genera.get(gKey);
      if (!gNode) {
        gNode = reg(makeNode('genus:' + gKey, 'genus', t.genus));
        gNode.tax = { family, genus: t.genus };
        addChild(fNode, gNode); genera.set(gKey, gNode);
      }
      let parentForPlant = gNode;
      if (t.species) {
        const sKey = gKey + '|' + t.species;
        let sNode = speciesNodes.get(sKey);
        if (!sNode) {
          sNode = reg(makeNode('species:' + sKey, 'species', t.species));
          sNode.sci = t.species;
          sNode.tax = { family, genus: t.genus, species: t.species };
          addChild(gNode, sNode); speciesNodes.set(sKey, sNode);
        }
        parentForPlant = sNode;
      }
      const pNode = reg(makeNode('plant:' + p.id, 'plant', p.name));
      pNode.plant = p; pNode.sci = p.scientificName; pNode.category = p.category;
      pNode.photo = p.photo || ''; pNode.photoCredit = p.photoCredit || '';
      pNode.tax = { family, genus: t.genus, species: t.species || '' };
      addChild(parentForPlant, pNode);
    }

    // Graft session expansions (parent always precedes child in the array).
    for (const s of state.injected) {
      const parent = state.nodesByKey.get(s.parentKey);
      if (!parent) continue;
      const n = reg(makeNode('sug:' + s.taxonId, s.taxonRank === 'genus' ? 'genus' : s.taxonRank === 'species' ? 'species' : 'subspecies', s.common || s.sci));
      n.fetched = true;
      n.taxonId = s.taxonId; n.taxonRank = s.taxonRank;
      n.sci = s.sci; n.common = s.common; n.photoUrl = s.photoUrl;
      n.attribution = s.attribution; n.obs = s.obs; n.wikipedia = s.wikipedia; n.inat = s.inat;
      n.tax = taxFromParent(parent.tax, s.taxonRank, s.sci);
      addChild(parent, n);
    }

    state.root = root;
    if (unknown.size) unknown.forEach(resolveFamilyAsync);
    return root;
  }

  /* ---------- layout (tidy tree, variable row heights) ---------- */

  function layout(root) {
    let counter = 0;
    (function assign(n) {
      if (!n.children.length) n.lx = counter++;
      else { n.children.forEach(assign); n.lx = (n.children[0].lx + n.children[n.children.length - 1].lx) / 2; }
    })(root);
    (function depth(n, d) { n.depth = d; n.children.forEach((c) => depth(c, d + 1)); })(root, 0);

    measureAll(root);

    const maxH = {};
    for (const n of allNodes()) maxH[n.depth] = Math.max(maxH[n.depth] || 0, n.h);
    const rowY = {}; let acc = 0;
    Object.keys(maxH).map(Number).sort((a, b) => a - b).forEach((d) => { rowY[d] = acc; acc += maxH[d] + V_GAP; });

    for (const n of allNodes()) { n.x = n.lx * COL_W; n.y = rowY[n.depth]; }
  }

  function measureAll(root) { (function w(n) { measure(n); n.children.forEach(w); })(root); }

  function isCard(n) { return n.rank !== 'root'; } // every node but root is a media card

  function measure(n) {
    if (n.rank === 'root') {
      n.w = Math.max(110, n.label.length * 8 + 40); n.h = 38; return;
    }
    n.w = CARD_W;
    n.primaryLines = wrapText(primaryFor(n), 18, 2);
    let y = PHOTO_Y + PHOTO_H + 16 + (n.primaryLines.length - 1) * 15; // last primary baseline
    n._secY = y + 14; y = n._secY;
    n._hasAttr = n.fetched || isDefaultTaxon(n) || (n.plant && !!n.photoCredit);
    if (n._hasAttr) { n._attrY = y + 12; y = n._attrY; }
    n.h = y + 6;
  }

  function isDefaultTaxon(n) { return !n.fetched && (n.rank === 'family' || n.rank === 'genus' || n.rank === 'species'); }

  /* ---------- field accessors (primary = scientific, secondary = common) ---------- */

  function primaryFor(n) {
    if (n.plant) return n.label;
    if (n.fetched) return n.sci;
    if (n.rank === 'family') return n.label;
    if (n.rank === 'genus') return n.tax.genus;
    if (n.rank === 'species') return n.tax.species;
    return n.label;
  }
  function secondaryFor(n) {
    if (n.plant) return n.sci || '';
    if (n.fetched) return n.common || '';
    if (n.rank === 'family') return n.commonName || (info(n).common || '');
    return info(n).common || '';
  }
  function photoFor(n) {
    if (n.plant) return n.photo || '';
    if (n.fetched) return n.photoUrl || '';
    return info(n).photoUrl || '';
  }
  function attrFor(n) {
    if (n.plant) return n.photoCredit || '';
    if (n.fetched) return n.attribution || '';
    return info(n).attribution || '';
  }
  function info(n) { return state.nodeInfo[n.key] || {}; }

  /* ---------- geometry / transform ---------- */

  function nodeBox(n) { return { minX: n.x - n.w / 2, maxX: n.x + n.w / 2, minY: n.y, maxY: n.y + n.h }; }
  function unionBox(nodes) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const n of nodes) { const x = nodeBox(n); if (x.minX < a) a = x.minX; if (x.minY < b) b = x.minY; if (x.maxX > c) c = x.maxX; if (x.maxY > d) d = x.maxY; }
    return { minX: a, minY: b, maxX: c, maxY: d };
  }
  function allNodes() { return [...state.nodesByKey.values()]; }
  function subtreeNodes(node) { const out = []; (function w(n) { out.push(n); n.children.forEach(w); })(node); return out; }
  function viewport() { return { w: state.svg.clientWidth || window.innerWidth, h: state.svg.clientHeight || (window.innerHeight - 56) }; }
  function applyTransform() { state.gRoot.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.k})`); }

  function fitTarget(box, pad) {
    pad = pad == null ? 48 : pad;
    const vp = viewport();
    const bw = Math.max(1, box.maxX - box.minX), bh = Math.max(1, box.maxY - box.minY);
    const k = clamp(Math.min((vp.w - 2 * pad) / bw, (vp.h - 2 * pad) / bh), MIN_K, MAX_K);
    return { k, tx: vp.w / 2 - ((box.minX + box.maxX) / 2) * k, ty: pad - box.minY * k };
  }
  function centerTarget(node) {
    const vp = viewport(), k = state.k;
    return { k, tx: vp.w / 2 - node.x * k, ty: vp.h / 2 - (node.y + node.h / 2) * k };
  }
  function zoomAt(px, py, factor) {
    const nk = clamp(state.k * factor, MIN_K, MAX_K), r = nk / state.k;
    state.tx = px - (px - state.tx) * r; state.ty = py - (py - state.ty) * r; state.k = nk;
  }
  function animateTo(target, dur) {
    dur = dur == null ? 440 : dur;
    if (state.anim) cancelAnimationFrame(state.anim);
    const from = { tx: state.tx, ty: state.ty, k: state.k }, start = performance.now();
    (function step(now) {
      const e = easeInOut(Math.min(1, (now - start) / dur));
      state.tx = from.tx + (target.tx - from.tx) * e;
      state.ty = from.ty + (target.ty - from.ty) * e;
      state.k = from.k + (target.k - from.k) * e;
      applyTransform();
      if (e < 1) state.anim = requestAnimationFrame(step); else state.anim = null;
    })(start);
  }
  function fitAll(animate) { const t = fitTarget(unionBox(allNodes())); animate ? animateTo(t) : (Object.assign(state, t), applyTransform()); }
  function fitSubtree(key, animate) {
    const n = state.nodesByKey.get(key); if (!n) return;
    const t = fitTarget(unionBox(subtreeNodes(n))); animate ? animateTo(t) : (Object.assign(state, t), applyTransform());
  }

  /* ---------- drawing ---------- */

  function draw() {
    while (state.gRoot.firstChild) state.gRoot.removeChild(state.gRoot.firstChild);
    state.elByKey = new Map();
    const links = svgEl('g', { class: 'tree-links' });
    const nodes = svgEl('g', { class: 'tree-nodes' });
    state.gRoot.appendChild(links); state.gRoot.appendChild(nodes);

    (function walk(n) {
      for (const c of n.children) {
        const py = n.y + n.h, midY = (py + c.y) / 2;
        links.appendChild(svgEl('path', { class: c.fetched ? 'tlink suggestion' : 'tlink', d: `M${n.x},${py} V${midY} H${c.x} V${c.y}` }));
        walk(c);
      }
    })(state.root);

    for (const n of allNodes()) { const g = drawNode(n); nodes.appendChild(g); state.elByKey.set(n.key, g); }

    fitLabels(nodes);
    if (state.selectedKey && state.nodesByKey.has(state.selectedKey)) applyHighlight();
  }

  // Ellipsize any text that exceeds its width budget so nothing leaves the card.
  function fitLabels(container) {
    container.querySelectorAll('text[data-maxw]').forEach((el) => {
      const max = +el.getAttribute('data-maxw'); if (!max) return;
      let len; try { len = el.getComputedTextLength(); } catch (_) { return; }
      if (len <= max) return;
      let txt = el.textContent;
      while (txt.length > 1) {
        txt = txt.slice(0, -1); el.textContent = txt + '…';
        try { if (el.getComputedTextLength() <= max) break; } catch (_) { break; }
      }
    });
  }

  function drawNode(n) {
    const g = svgEl('g', { class: 'tnode rank-' + n.rank + (n.fetched ? ' is-fetched' : ''), transform: `translate(${n.x} ${n.y})`, 'data-key': n.key });
    if (n.rank === 'root') drawPill(g, n); else drawCard(g, n);
    g.addEventListener('click', (e) => { if (state.dragged) return; e.stopPropagation(); handleNodeClick(n); });
    return g;
  }

  function drawPill(g, n) {
    const w = n.w, h = n.h, left = -w / 2;
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: h / 2, ry: h / 2 }));
    g.appendChild(svgText(n.label, { x: 0, y: h / 2 + 5, 'text-anchor': 'middle', 'font-size': 14 }, null, w - 20));
  }

  function drawCard(g, n) {
    const w = n.w, h = n.h, left = -w / 2, maxw = w - 16;
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: 12, ry: 12 }));

    // photo (placeholder behind; image clipped on top; badge for fetched)
    g.appendChild(svgEl('rect', { class: 'card-photo-ph', x: PHOTO_X, y: PHOTO_Y, width: PHOTO_W, height: PHOTO_H, rx: 8, ry: 8 }));
    const url = photoFor(n);
    if (url) {
      const img = svgEl('image', { x: PHOTO_X, y: PHOTO_Y, width: PHOTO_W, height: PHOTO_H, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#cardPhotoClip)' });
      img.setAttributeNS(XLINK, 'href', url); img.setAttribute('href', url);
      img.addEventListener('error', () => { img.style.display = 'none'; });
      g.appendChild(img);
    } else {
      g.appendChild(svgText(n.fetched || isDefaultTaxon(n) ? 'loading photo' : 'no photo', { x: 0, y: PHOTO_Y + PHOTO_H / 2 + 3, 'text-anchor': 'middle', 'font-size': 9 }, 'card-photo-ph-text'));
    }
    if (n.fetched) {
      g.appendChild(svgEl('rect', { class: 'sug-badge', x: PHOTO_X + PHOTO_W - 42, y: PHOTO_Y + 5, width: 38, height: 14, rx: 7, ry: 7 }));
      g.appendChild(svgText('iNat', { x: PHOTO_X + PHOTO_W - 23, y: PHOTO_Y + 15, 'text-anchor': 'middle', 'font-size': 9 }, 'sug-badge-text'));
    }
    if (n.plant && n.category) g.appendChild(svgEl('circle', { class: 'cat-dot', cx: PHOTO_X + 9, cy: PHOTO_Y + 9, r: 5, fill: catColor(n.category) }));

    // primary (scientific / name), secondary (common), attribution
    let y = PHOTO_Y + PHOTO_H + 16;
    for (const line of n.primaryLines) { g.appendChild(svgText(line, { x: 0, y, 'text-anchor': 'middle', 'font-size': 13 }, 't-name', maxw)); y += 15; }
    g.appendChild(svgText(secondaryFor(n), { x: 0, y: n._secY, 'text-anchor': 'middle', 'font-size': 11 }, 't-sci', maxw));
    if (n._hasAttr) g.appendChild(svgText(attrFor(n), { x: 0, y: n._attrY, 'text-anchor': 'middle', 'font-size': 9 }, 't-attr', maxw));

    const title = svgEl('title');
    title.textContent = primaryFor(n) + (secondaryFor(n) ? ' — ' + secondaryFor(n) : '') + (attrFor(n) ? '\nPhoto: ' + attrFor(n) : '');
    g.appendChild(title);
  }

  function catColor(cat) { return cat === 'flowers' ? '#b85a8a' : cat === 'herbs' ? '#4a7c4e' : cat === 'edibles' ? '#c04020' : '#6b8e23'; }
  function rankLabel(r) { return { root: 'Garden', family: 'Family', genus: 'Genus', species: 'Species', subspecies: 'Variety / subspecies', plant: 'In your garden' }[r] || r; }

  /* ---------- relationship tiers (plant selection) ---------- */

  function tierOf(sel, n) {
    if (n.key === sel.key) return 'self';
    const a = sel.tax, b = n.tax;
    if (!b || !b.family) return null;
    if (a.species && b.species && lc(a.species) === lc(b.species)) return 'species';
    if (a.genus && b.genus && lc(a.genus) === lc(b.genus)) return 'genus';
    if (a.family && b.family && lc(a.family) === lc(b.family)) return 'family';
    return null;
  }
  function computeTiers(sel) {
    const tiers = new Map(), counts = { species: 0, genus: 0, family: 0 };
    for (const n of allNodes()) {
      if (n.rank !== 'plant' && !n.fetched && n.rank !== 'subspecies') continue;
      const t = tierOf(sel, n); if (!t) continue;
      tiers.set(n.key, t);
      if (t !== 'self' && n.rank === 'plant') counts[t]++;
    }
    return { tiers, counts };
  }
  function applyHighlight() {
    state.elByKey.forEach((el) => el.classList.remove('tier-self', 'tier-species', 'tier-genus', 'tier-family', 'dim'));
    const sel = state.nodesByKey.get(state.selectedKey); if (!sel) return;
    const selEl = state.elByKey.get(sel.key); if (selEl) selEl.classList.add('tier-self');
    if (sel.rank !== 'plant') return;
    const { tiers } = computeTiers(sel);
    state.elByKey.forEach((el, key) => {
      const node = state.nodesByKey.get(key), t = tiers.get(key);
      if (t && t !== 'self') el.classList.add('tier-' + t);
      else if (!t && node && (node.rank === 'plant' || node.fetched)) el.classList.add('dim');
    });
  }

  /* ---------- interaction ---------- */

  function handleNodeClick(n) {
    if (n.rank === 'root') { deselect(); fitAll(true); return; }
    selectNode(n.key);
  }
  function selectNode(key) {
    state.selectedKey = key;
    const n = state.nodesByKey.get(key); if (!n) return;
    applyHighlight();
    updatePanel(n);
    if (isDefaultTaxon(n) && !info(n).resolved) ensureNodeInfo(n).then(() => { if (state.selectedKey === key) { patchNodeMedia(n); updatePanel(n); } });
    animateTo(centerTarget(n));
  }
  function refreshSelection() {
    const n = state.nodesByKey.get(state.selectedKey);
    applyHighlight();
    if (n) updatePanel(n); else state.panel.classList.remove('open');
  }
  function deselect() { state.selectedKey = null; applyHighlight(); state.panel.classList.remove('open'); }

  // Re-ellipsize a single text element to its width budget after its text changed.
  function fitOne(el) {
    const max = +el.getAttribute('data-maxw'); if (!max) return;
    let len; try { len = el.getComputedTextLength(); } catch (_) { return; }
    if (len <= max) return;
    let txt = el.textContent;
    while (txt.length > 1) { txt = txt.slice(0, -1); el.textContent = txt + '…'; try { if (el.getComputedTextLength() <= max) break; } catch (_) { break; } }
  }

  // Patch one node's photo + common name + attribution in place after a lazy
  // fetch — heights are pre-reserved, so no relayout is needed.
  function patchNodeMedia(n) {
    const g = state.elByKey.get(n.key); if (!g) return;
    const url = photoFor(n);
    if (url && !g.querySelector('image')) {
      const img = svgEl('image', { x: PHOTO_X, y: PHOTO_Y, width: PHOTO_W, height: PHOTO_H, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#cardPhotoClip)' });
      img.setAttributeNS(XLINK, 'href', url); img.setAttribute('href', url);
      img.addEventListener('error', () => { img.style.display = 'none'; });
      g.appendChild(img); // on top of the placeholder
      const pht = g.querySelector('.card-photo-ph-text'); if (pht) pht.style.display = 'none';
    }
    const sec = g.querySelector('.t-sci'); if (sec) { sec.textContent = secondaryFor(n); fitOne(sec); }
    const at = g.querySelector('.t-attr'); if (at) { at.textContent = attrFor(n); fitOne(at); }
  }

  /* ---------- panel ---------- */

  function updatePanel(n) {
    if (!n) { state.panel.classList.remove('open'); return; }
    const ni = info(n);
    const photo = photoFor(n), attribution = attrFor(n);
    const common = secondaryFor(n);
    const sciName = primaryFor(n);
    const lineage = [
      n.tax.family && `<span>${escapeHtml(n.tax.family)}</span>`,
      n.tax.genus && `<span><em>${escapeHtml(n.tax.genus)}</em></span>`,
      n.tax.species && `<span><em>${escapeHtml(n.tax.species)}</em></span>`,
    ].filter(Boolean).join('<span class="sep">›</span>');

    let body = '';
    if (n.rank === 'plant') body += verdictHtml(n) + `<a class="tp-btn solid" href="#/${escapeHtml(n.plant.id)}">Open care guide</a>`;

    const wiki = n.wikipedia || ni.wikipedia, inat = n.inat || ni.inat, obs = n.obs != null ? n.obs : ni.obs;
    const links = [
      Number.isFinite(obs) && obs > 0 ? `<span class="tp-obs">${obs.toLocaleString()} observations on iNaturalist</span>` : '',
      wiki ? `<a href="${escapeHtml(wiki)}" target="_blank" rel="noopener">Wikipedia</a>` : '',
      inat ? `<a href="${escapeHtml(inat)}" target="_blank" rel="noopener">iNaturalist</a>` : '',
    ].filter(Boolean).join('<span class="sep">·</span>');

    state.panel.innerHTML = `
      <button type="button" class="tp-close" aria-label="Close">×</button>
      <div class="tp-top">
        ${photo ? `<img class="tp-photo" src="${escapeHtml(photo)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="tp-headtext">
          <span class="tp-rank">${escapeHtml(rankLabel(n.rank))}</span>
          <div class="tp-name">${escapeHtml(n.plant ? n.label : (common || sciName))}</div>
          <div class="tp-sci">${escapeHtml(n.plant ? n.sci : sciName)}${!n.plant && common ? ' — ' + escapeHtml(common) : ''}</div>
        </div>
      </div>
      ${lineage ? `<div class="tp-lineage">${lineage}</div>` : ''}
      ${body}
      ${links ? `<div class="tp-links">${links}</div>` : ''}
      <div class="tp-actions">${actionsHtml(n)}</div>
      <div class="tp-status" id="tp-status"></div>
      ${attribution ? `<div class="tp-attr">Photo: ${escapeHtml(attribution)}</div>` : ''}
      <div class="tp-foot">Relatives are pulled live from iNaturalist (read-only) and exist for this session only — they are not saved to your garden. Photos are user-contributed under their own licenses.</div>
    `;
    state.panel.classList.add('open');
    state.panel.querySelector('.tp-close').addEventListener('click', deselect);
    state.panel.querySelectorAll('button[data-target]').forEach((b) => b.addEventListener('click', () => expandChildren(state.nodesByKey.get(b.dataset.target), b)));
    const cb = state.panel.querySelector('button[data-collapse]');
    if (cb) cb.addEventListener('click', () => collapse(state.nodesByKey.get(cb.dataset.collapse)));
  }

  function verdictHtml(n) {
    const { counts } = computeTiers(n), tax = n.tax;
    let vt, txt;
    if (counts.species > 0) { vt = 'species'; txt = `Crosses freely with <strong>${counts.species}</strong> other <em>${escapeHtml(tax.species)}</em> in the garden.`; }
    else if (counts.genus > 0) { vt = 'genus'; txt = `Shares genus <em>${escapeHtml(tax.genus)}</em> with <strong>${counts.genus}</strong> garden plant${counts.genus > 1 ? 's' : ''}. Crossing is hit or miss.`; }
    else if (counts.family > 0) { vt = 'family'; txt = `<strong>${counts.family}</strong> ${escapeHtml(tax.family)} cousin${counts.family > 1 ? 's' : ''} in the garden. Related, but they will not cross.`; }
    else { vt = 'alone'; txt = `Stands alone — no garden relatives in <em>${escapeHtml(tax.genus || tax.family)}</em> or the ${escapeHtml(tax.family)} family.`; }
    return `<div class="tp-verdict tier-${vt}">${txt}</div>
      <div class="tp-legend"><span><i class="lg-species"></i>species</span><span><i class="lg-genus"></i>genus</span><span><i class="lg-family"></i>family</span></div>`;
  }

  function actionsHtml(n) {
    const acts = [];
    const cr = childRankOf(n);
    const childWord = { genus: 'genera', species: 'species', subspecies: 'varieties' }[cr];
    if (cr) acts.push(btnHtml('Show ' + childWord, n.key));
    if (n.rank === 'genus') { const f = ancestorOfRank(n, 'family'); if (f) acts.push(btnHtml('More genera in family', f.key)); }
    if (n.rank === 'species') { const g = ancestorOfRank(n, 'genus'); if (g) acts.push(btnHtml('More species in genus', g.key)); }
    if (n.rank === 'subspecies') { const s = ancestorOfRank(n, 'species'); if (s) acts.push(btnHtml('More varieties', s.key)); }
    if (n.rank === 'plant') {
      const g = ancestorOfRank(n, 'genus'), s = ancestorOfRank(n, 'species'), f = ancestorOfRank(n, 'family');
      if (g) acts.push(btnHtml('Similar in genus', g.key));
      if (s) acts.push(btnHtml('Similar species', s.key));
      if (f) acts.push(btnHtml('Similar in family', f.key));
    }
    if (hasFetchedDescendants(n)) acts.push(`<button type="button" class="tp-btn ghost" data-collapse="${escapeHtml(n.key)}">Collapse added</button>`);
    return acts.join('');
  }
  function btnHtml(label, targetKey) { return `<button type="button" class="tp-btn" data-target="${escapeHtml(targetKey)}">${escapeHtml(label)}</button>`; }

  function setStatus(msg, kind) {
    const el = document.getElementById('tp-status'); if (!el) return;
    el.textContent = msg || ''; el.className = 'tp-status' + (kind ? ' ' + kind : '');
  }

  /* ---------- iNaturalist API ---------- */

  function apiGet(url) {
    if (state.fetchCache.has(url)) return state.fetchCache.get(url);
    const p = (async () => {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('iNaturalist returned ' + r.status);
        return await r.json();
      } finally { clearTimeout(timer); }
    })();
    state.fetchCache.set(url, p);
    p.catch(() => state.fetchCache.delete(url));
    return p;
  }
  async function resolveTaxon(name, rank) {
    const data = await apiGet(`${API}/taxa?q=${encodeURIComponent(name)}&rank=${rank}&per_page=1`);
    return (data.results || [])[0] || null;
  }
  async function fetchDescendants(parentId, rank) {
    const data = await apiGet(`${API}/taxa?taxon_id=${parentId}&rank=${rank}&per_page=30&order_by=observations_count&order=desc`);
    return (data.results || []).filter((t) => t.id !== parentId && ((Array.isArray(t.ancestor_ids) && t.ancestor_ids.includes(parentId)) || t.parent_id === parentId));
  }
  function fromTaxon(t) {
    return {
      taxonId: t.id, common: t.preferred_common_name || '',
      photoUrl: t.default_photo ? (t.default_photo.medium_url || t.default_photo.square_url || '') : '',
      attribution: t.default_photo ? (t.default_photo.attribution || '') : '',
      wikipedia: t.wikipedia_url || '', inat: 'https://www.inaturalist.org/taxa/' + t.id,
      obs: t.observations_count || 0, resolved: true,
    };
  }
  async function ensureNodeInfo(n) {
    const cur = info(n); if (cur.resolved) return cur;
    let name, rank;
    if (n.rank === 'family') { name = n.tax.family; rank = 'family'; }
    else if (n.rank === 'genus') { name = n.tax.genus; rank = 'genus'; }
    else if (n.rank === 'species') { name = n.tax.species; rank = 'species'; }
    else return cur;
    let t = null; try { t = await resolveTaxon(name, rank); } catch (_) { /* offline */ }
    const ni = t ? fromTaxon(t) : { resolved: true };
    state.nodeInfo[n.key] = ni; return ni;
  }
  async function ensureTaxonId(n) {
    if (n.taxonId) return n.taxonId;
    const ni = await ensureNodeInfo(n); return ni ? ni.taxonId : null;
  }
  async function resolveFamilyAsync(genus) {
    if (state.familyCache[genus]) return;
    try {
      const t = await resolveTaxon(genus, 'genus');
      const fam = t && (t.ancestors || []).find((a) => a.rank === 'family');
      if (fam && fam.name) { state.familyCache[genus] = fam.name; scheduleRebuild(); }
    } catch (_) { /* leave Unplaced */ }
  }

  function existingSciNames() {
    const set = new Set();
    for (const p of state.plants) {
      const t = parseTaxon(p.scientificName);
      if (t.genus) set.add(lc(t.genus));
      if (t.species) set.add(lc(t.species));
      const f = resolveFamilySync(t.genus); if (f) set.add(lc(f));
    }
    for (const s of state.injected) set.add(lc(s.sci));
    return set;
  }
  function ancestorOfRank(node, rank) { let n = node; while (n) { if (n.rank === rank) return n; n = n.parent; } return null; }
  function hasPhoto(t) { return t.default_photo ? 1 : 0; }

  /* ---------- expansion / collapse ---------- */

  async function expandChildren(node, btn) {
    if (!node) return;
    const childRank = childRankOf(node);
    if (!childRank) { setStatus('Nothing more to expand here.', 'error'); return; }
    if (btn) btn.setAttribute('aria-busy', 'true');
    const word = { genus: 'genera', species: 'species', subspecies: 'varieties' }[childRank];
    setStatus('Searching iNaturalist for ' + word + ' in ' + primaryFor(node) + '…', 'loading');
    try {
      const pid = await ensureTaxonId(node);
      if (!pid) { setStatus('Could not find "' + primaryFor(node) + '" on iNaturalist.', 'error'); return; }
      let results = await fetchDescendants(pid, childRank);
      const exclude = existingSciNames(); exclude.add(lc(primaryFor(node)));
      results = results.filter((t) => t.name && !exclude.has(lc(t.name)));
      results.sort((a, b) => (hasPhoto(b) - hasPhoto(a)) || ((b.observations_count || 0) - (a.observations_count || 0)));
      results = results.slice(0, MAX_RESULTS);
      if (!results.length) { setStatus('No new ' + word + ' found.', 'ok'); return; }
      for (const t of results) {
        state.injected.push({
          parentKey: node.key, taxonId: t.id, taxonRank: childRank, sci: t.name,
          common: t.preferred_common_name || '',
          photoUrl: t.default_photo ? (t.default_photo.medium_url || t.default_photo.square_url || '') : '',
          attribution: t.default_photo ? (t.default_photo.attribution || '') : '',
          obs: t.observations_count || 0, wikipedia: t.wikipedia_url || '', inat: 'https://www.inaturalist.org/taxa/' + t.id,
        });
      }
      rebuild(); refreshSelection(); fitSubtree(node.key, true);
      setStatus('Added ' + results.length + ' ' + word + ' from iNaturalist.', 'ok');
    } catch (err) {
      setStatus(err && err.name === 'AbortError' ? 'iNaturalist request timed out. Tap to try again.' : 'Could not reach iNaturalist: ' + ((err && err.message) || 'network error') + '.', 'error');
    } finally { if (btn) btn.removeAttribute('aria-busy'); }
  }

  function hasFetchedDescendants(node) { return subtreeNodes(node).some((d) => d !== node && d.fetched); }
  function collapse(node) {
    if (!node) return;
    const ids = new Set(subtreeNodes(node).filter((d) => d !== node && d.fetched).map((d) => d.taxonId));
    if (!ids.size) return;
    state.injected = state.injected.filter((s) => !ids.has(s.taxonId));
    rebuild(); refreshSelection(); fitSubtree(node.key, true);
  }
  function resetTree() {
    state.injected = []; deselect(); rebuild(); fitAll(true);
  }

  function rebuild() { buildModel(); layout(state.root); draw(); }

  // Coalesced rebuild for async info/photo arrivals (heights are reserved, so no shift).
  function scheduleRebuild() {
    clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => { rebuild(); refreshSelection(); }, 450);
  }

  async function runQueue(items, conc, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (_) { } } };
    await Promise.all(Array.from({ length: conc }, worker));
  }
  function queuePhotoFetches() {
    const targets = allNodes().filter((n) => isDefaultTaxon(n) && !info(n).resolved);
    if (!targets.length) return;
    // Fill photos/attribution in place as each resolves (incremental, no relayout).
    runQueue(targets, INFO_CONCURRENCY, async (n) => { await ensureNodeInfo(n); patchNodeMedia(n); });
  }

  /* ---------- pan / zoom ---------- */

  function wirePointer(svg) {
    const pointers = new Map(); let panStart = null, pinchPrev = null;
    const info2 = () => { const ps = [...pointers.values()], a = ps[0], b = ps[1]; return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    svg.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); state.dragged = false;
      if (pointers.size === 1) panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
      else if (pointers.size === 2) { pinchPrev = info2(); panStart = null; }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = pointers.get(e.pointerId); p.x = e.clientX; p.y = e.clientY;
      const rect = svg.getBoundingClientRect();
      if (pointers.size >= 2) {
        const cur = info2();
        if (pinchPrev) { zoomAt(cur.mx - rect.left, cur.my - rect.top, cur.dist / pinchPrev.dist); state.tx += cur.mx - pinchPrev.mx; state.ty += cur.my - pinchPrev.my; applyTransform(); }
        pinchPrev = cur; state.dragged = true;
      } else if (panStart) {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) state.dragged = true;
        state.tx = panStart.tx + dx; state.ty = panStart.ty + dy; applyTransform();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchPrev = null;
      if (pointers.size === 0) panStart = null;
      else if (pointers.size === 1) { const o = [...pointers.values()][0]; panStart = { x: o.x, y: o.y, tx: state.tx, ty: state.ty }; }
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end); svg.addEventListener('pointerleave', end);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const rect = svg.getBoundingClientRect(); zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015)); applyTransform(); }, { passive: false });
    svg.addEventListener('click', (e) => { if (!state.dragged && e.target === svg) deselect(); });
  }

  /* ---------- entry point ---------- */

  let dataLoaded = false;
  async function loadTaxonomy() {
    if (dataLoaded) return;
    try {
      const r = await fetch('data/taxonomy.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); state.genusToFamily = j.genusToFamily || {}; state.familyCommon = j.familyCommonNames || {}; }
    } catch (_) { /* fall back to iNaturalist family lookups */ }
    dataLoaded = true;
  }

  async function render(appEl, plants) {
    state.plants = plants || [];
    state.selectedKey = null; state.tx = 0; state.ty = 0; state.k = 1;
    document.title = 'Family Tree · Newton Garden';

    appEl.innerHTML = `
      <div class="tree-view">
        <div class="tree-bar">
          <a class="tree-back" href="#/">← Garden</a>
          <h1 class="tree-title">Living Family Tree</h1>
          <button type="button" class="tree-reset" id="tree-reset">Reset</button>
        </div>
        <div class="tree-canvas-wrap">
          <svg class="tree-svg" id="tree-svg">
            <defs>
              <clipPath id="cardPhotoClip" clipPathUnits="userSpaceOnUse">
                <rect x="-69" y="6" width="138" height="70" rx="8" ry="8"></rect>
              </clipPath>
            </defs>
            <g id="tree-root"></g>
          </svg>
          <div class="tree-controls">
            <button type="button" id="tree-zin" aria-label="Zoom in">+</button>
            <button type="button" id="tree-zout" aria-label="Zoom out">−</button>
            <button type="button" class="tc-fit" id="tree-fit" aria-label="Fit whole tree">Fit</button>
          </div>
          <div class="tree-panel" id="tree-panel" aria-live="polite"></div>
        </div>
      </div>
    `;

    state.svg = document.getElementById('tree-svg');
    state.gRoot = document.getElementById('tree-root');
    state.panel = document.getElementById('tree-panel');

    await loadTaxonomy();
    rebuild();
    queuePhotoFetches();

    wirePointer(state.svg);
    document.getElementById('tree-zin').addEventListener('click', () => { const v = viewport(); zoomAt(v.w / 2, v.h / 2, 1.25); applyTransform(); });
    document.getElementById('tree-zout').addEventListener('click', () => { const v = viewport(); zoomAt(v.w / 2, v.h / 2, 0.8); applyTransform(); });
    document.getElementById('tree-fit').addEventListener('click', () => fitAll(true));
    document.getElementById('tree-reset').addEventListener('click', resetTree);

    requestAnimationFrame(() => fitAll(false));
    const onResize = () => { if (!state.selectedKey) fitAll(false); };
    window.addEventListener('resize', onResize);
    state.teardown = () => { window.removeEventListener('resize', onResize); if (state.anim) cancelAnimationFrame(state.anim); clearTimeout(state.rebuildTimer); state.anim = null; };
    window.addEventListener('hashchange', function once() { window.removeEventListener('hashchange', once); if (state.teardown) { state.teardown(); state.teardown = null; } });
  }

  window.NewtonTree = {
    render,
    _test: { parseTaxon, buildModel, layout, tierOf, computeTiers, childRankOf, existingSciNames, state },
  };
})();
