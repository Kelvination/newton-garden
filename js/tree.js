/* Living Family Tree — taxonomic node graph for Newton Garden.
 *
 * Renders all plants grouped family -> genus -> species -> plant on a
 * pannable / zoomable SVG canvas, highlights cross-compatibility tiers when a
 * plant is tapped, and grafts related taxa pulled live from the iNaturalist
 * API (read-only, no key) as dashed "suggestion" nodes.
 *
 * Exposed as window.NewtonTree.render(appEl, plants). Vanilla JS, no build. */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const API = 'https://api.inaturalist.org/v1';

  // Layout constants. COL_W is the gap between adjacent leaves; LEVEL_H the
  // vertical distance between depth levels. Both comfortably exceed node sizes.
  const COL_W = 168;
  const LEVEL_H = 124;
  const MIN_K = 0.12;
  const MAX_K = 3;
  const FETCH_TIMEOUT = 9000;
  const MAX_SUGGESTIONS = 6;

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

  function svgText(content, attrs, cls) {
    const t = svgEl('text', attrs);
    if (cls) t.setAttribute('class', cls);
    t.textContent = content;
    return t;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // Rough text width estimate (SVG has no cheap measure-before-paint).
  function estW(text, perChar, pad, min) {
    return Math.max(min, Math.round(String(text || '').length * perChar) + pad);
  }

  function wrapText(text, maxChars, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
      else {
        lines.push(cur);
        cur = w;
        if (lines.length === maxLines - 1) break;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (!lines.length) return [''];
    // If words ran past the line cap, mark truncation on the last line.
    const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
    if (used < words.length) lines[lines.length - 1] = truncate(lines[lines.length - 1] + ' …', maxChars);
    return lines;
  }

  /* ---------- taxonomy parsing ---------- */

  // Parse a scientificName into { genus, species }. species is the full
  // binomial ("Genus epithet") or '' when only a genus is recorded.
  // Strips cultivars ('...'), parentheticals, rank markers (spp., var.) and
  // hybrid marks (x / ×).
  function parseTaxon(name) {
    let s = String(name || '');
    s = s.replace(/['‘’"][^'‘’"]*['‘’"]/g, ' '); // cultivar in quotes
    s = s.replace(/\([^)]*\)/g, ' ');                                         // parentheticals
    let tokens = s.trim().split(/\s+/).filter(Boolean);
    const RANK = /^(spp?|cv|var|subsp|ssp|f|nothosp)\.?$/i;
    tokens = tokens.filter((t) => !RANK.test(t) && t !== '×' && t.toLowerCase() !== 'x');
    const genus = tokens[0] ? tokens[0][0].toUpperCase() + tokens[0].slice(1) : '';
    let species = '';
    if (tokens[1] && /^[a-zà-ÿ][a-zà-ÿ-]+$/i.test(tokens[1])) {
      species = genus + ' ' + tokens[1].toLowerCase();
    }
    return { genus, species };
  }

  /* ---------- module state ---------- */

  const state = {
    plants: [],
    genusToFamily: {},
    familyCommon: {},
    familyCache: {},        // iNaturalist-resolved families for unknown genera
    injected: [],           // session suggestion descriptors {parentKey, ...}
    fetchCache: new Map(),  // url -> promise (memoised iNat responses)
    root: null,
    nodesByKey: new Map(),
    elByKey: new Map(),
    selectedKey: null,
    tx: 0, ty: 0, k: 1,
    svg: null,
    gRoot: null,
    panel: null,
    anim: null,
    teardown: null,
  };

  function resolveFamilySync(genus) {
    return state.genusToFamily[genus] || state.familyCache[genus] || null;
  }

  /* ---------- model build ---------- */

  function makeNode(key, rank, label) {
    return { key, rank, label, children: [], parent: null, tax: {} };
  }

  function addChild(parent, child) {
    child.parent = parent;
    parent.children.push(child);
  }

  // Rebuild the whole node tree from plants + session suggestions. Pure
  // (re-runnable): produces a fresh structure each call so layout never drifts.
  function buildModel() {
    state.nodesByKey = new Map();
    const register = (n) => { state.nodesByKey.set(n.key, n); return n; };

    const root = register(makeNode('root', 'root', 'Newton Garden'));
    const families = new Map();
    const genera = new Map();
    const speciesNodes = new Map();
    const unknownGenera = new Set();

    for (const p of state.plants) {
      const t = parseTaxon(p.scientificName);
      let family = resolveFamilySync(t.genus);
      if (!family) { family = 'Unplaced'; if (t.genus) unknownGenera.add(t.genus); }

      let fNode = families.get(family);
      if (!fNode) {
        fNode = register(makeNode('family:' + family, 'family', family));
        fNode.commonName = state.familyCommon[family] || '';
        fNode.tax = { family };
        addChild(root, fNode);
        families.set(family, fNode);
      }

      const gKey = family + '|' + t.genus;
      let gNode = genera.get(gKey);
      if (!gNode) {
        gNode = register(makeNode('genus:' + family + '|' + t.genus, 'genus', t.genus));
        gNode.tax = { family, genus: t.genus };
        addChild(fNode, gNode);
        genera.set(gKey, gNode);
      }

      let parentForPlant = gNode;
      if (t.species) {
        const sKey = gKey + '|' + t.species;
        let sNode = speciesNodes.get(sKey);
        if (!sNode) {
          sNode = register(makeNode('species:' + sKey, 'species', t.species));
          sNode.sci = t.species;
          sNode.tax = { family, genus: t.genus, species: t.species };
          addChild(gNode, sNode);
          speciesNodes.set(sKey, sNode);
        }
        parentForPlant = sNode;
      }

      const pNode = register(makeNode('plant:' + p.id, 'plant', p.name));
      pNode.plant = p;
      pNode.sci = p.scientificName;
      pNode.category = p.category;
      pNode.tax = { family, genus: t.genus, species: t.species || '' };
      addChild(parentForPlant, pNode);
    }

    // Graft session suggestions under their recorded parent node.
    for (const sug of state.injected) {
      const parent = state.nodesByKey.get(sug.parentKey);
      if (!parent) continue;
      const sNode = register(makeNode('sug:' + sug.taxonId, 'suggestion', sug.common || sug.sci));
      sNode.suggestion = sug;
      sNode.sci = sug.sci;
      sNode.tax = suggestionTax(sug, parent);
      addChild(parent, sNode);
    }

    state.root = root;

    // Unknown genera land under "Unplaced"; resolve their family from
    // iNaturalist in the background and re-place them on success.
    if (unknownGenera.size) unknownGenera.forEach(resolveFamilyAsync);
    return root;
  }

  function suggestionTax(sug, parent) {
    const base = Object.assign({}, parent.tax);
    if (sug.suggestionRank === 'genus') { base.genus = sug.sci; base.species = ''; }
    else if (sug.suggestionRank === 'species') { base.species = sug.sci; }
    // subspecies keeps the parent species (treated as the same species)
    return base;
  }

  /* ---------- layout (tidy top-down tree) ---------- */

  // Leaves get sequential x; internal nodes centre over their children. Each
  // subtree owns a contiguous range of leaf slots, so subtrees never overlap.
  function layout(root) {
    let counter = 0;
    (function assign(n) {
      if (!n.children.length) { n.lx = counter++; }
      else { n.children.forEach(assign); n.lx = (n.children[0].lx + n.children[n.children.length - 1].lx) / 2; }
    })(root);
    (function place(n, depth) {
      n.depth = depth;
      n.x = n.lx * COL_W;
      n.y = depth * LEVEL_H;
      n.children.forEach((c) => place(c, depth + 1));
    })(root, 0);
    measureAll(root);
  }

  function measureAll(root) {
    (function walk(n) { measure(n); n.children.forEach(walk); })(root);
  }

  function measure(n) {
    switch (n.rank) {
      case 'root':
        n.w = estW(n.label, 8, 40, 100); n.h = 38; break;
      case 'family':
        n.w = Math.max(estW(n.label, 8, 32, 96), estW(n.commonName, 5.6, 24, 0)); n.h = 44; break;
      case 'genus':
        n.w = estW(n.label, 8, 30, 70); n.h = 34; break;
      case 'species':
        n.w = estW(n.label, 7, 30, 90); n.h = 32; break;
      case 'plant':
        n.w = 144;
        n.nameLines = wrapText(n.label, 18, 2);
        n.h = 14 + n.nameLines.length * 16 + (n.sci ? 16 : 6);
        break;
      case 'suggestion':
        n.w = 138; n.h = 150; break;
      default:
        n.w = 80; n.h = 30;
    }
  }

  /* ---------- bounding boxes / transform ---------- */

  function nodeBox(n) {
    return { minX: n.x - n.w / 2, maxX: n.x + n.w / 2, minY: n.y, maxY: n.y + n.h };
  }

  function unionBox(nodes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const b = nodeBox(n);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    return { minX, minY, maxX, maxY };
  }

  function allNodes() { return [...state.nodesByKey.values()]; }

  function subtreeNodes(node) {
    const out = [];
    (function walk(n) { out.push(n); n.children.forEach(walk); })(node);
    return out;
  }

  function viewport() {
    const w = state.svg.clientWidth || window.innerWidth;
    const h = state.svg.clientHeight || (window.innerHeight - 56);
    return { w, h };
  }

  function applyTransform() {
    state.gRoot.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.k})`);
  }

  // Centre + scale so a box fits the viewport (top-aligned: trees read downward).
  function fitTarget(box, pad) {
    pad = pad == null ? 48 : pad;
    const vp = viewport();
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const k = clamp(Math.min((vp.w - 2 * pad) / bw, (vp.h - 2 * pad) / bh), MIN_K, MAX_K);
    const tx = vp.w / 2 - ((box.minX + box.maxX) / 2) * k;
    const ty = pad - box.minY * k;
    return { tx, ty, k };
  }

  function centerTarget(node) {
    const vp = viewport();
    const k = state.k;
    return { tx: vp.w / 2 - node.x * k, ty: vp.h / 2 - (node.y + node.h / 2) * k, k };
  }

  function zoomAt(px, py, factor) {
    const nk = clamp(state.k * factor, MIN_K, MAX_K);
    const r = nk / state.k;
    state.tx = px - (px - state.tx) * r;
    state.ty = py - (py - state.ty) * r;
    state.k = nk;
  }

  function animateTo(target, dur) {
    dur = dur == null ? 440 : dur;
    if (state.anim) cancelAnimationFrame(state.anim);
    const from = { tx: state.tx, ty: state.ty, k: state.k };
    const start = performance.now();
    (function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const e = easeInOut(t);
      state.tx = from.tx + (target.tx - from.tx) * e;
      state.ty = from.ty + (target.ty - from.ty) * e;
      state.k = from.k + (target.k - from.k) * e;
      applyTransform();
      if (t < 1) state.anim = requestAnimationFrame(step);
      else state.anim = null;
    })(start);
  }

  function fitAll(animate) {
    const target = fitTarget(unionBox(allNodes()));
    if (animate) animateTo(target); else { Object.assign(state, target); applyTransform(); }
  }

  function fitSubtree(key, animate) {
    const node = state.nodesByKey.get(key);
    if (!node) return;
    const target = fitTarget(unionBox(subtreeNodes(node)));
    if (animate) animateTo(target); else { Object.assign(state, target); applyTransform(); }
  }

  /* ---------- drawing ---------- */

  function draw() {
    while (state.gRoot.firstChild) state.gRoot.removeChild(state.gRoot.firstChild);
    state.elByKey = new Map();

    const links = svgEl('g', { class: 'tree-links' });
    const nodes = svgEl('g', { class: 'tree-nodes' });
    state.gRoot.appendChild(links);
    state.gRoot.appendChild(nodes);

    // Orthogonal (elbow) connectors from each parent's bottom to each child's top.
    (function walk(n) {
      for (const c of n.children) {
        const px = n.x, py = n.y + n.h;
        const cx = c.x, cy = c.y;
        const midY = (py + cy) / 2;
        const cls = c.rank === 'suggestion' ? 'tlink suggestion' : 'tlink';
        links.appendChild(svgEl('path', { class: cls, d: `M${px},${py} V${midY} H${cx} V${cy}` }));
        walk(c);
      }
    })(state.root);

    for (const n of allNodes()) {
      const g = drawNode(n);
      nodes.appendChild(g);
      state.elByKey.set(n.key, g);
    }

    if (state.selectedKey && state.nodesByKey.has(state.selectedKey)) applyHighlight();
  }

  function drawNode(n) {
    const g = svgEl('g', { class: 'tnode rank-' + n.rank, transform: `translate(${n.x} ${n.y})`, 'data-key': n.key });
    const w = n.w, h = n.h, left = -w / 2;

    if (n.rank === 'suggestion') { drawSuggestion(g, n, w, h, left); }
    else if (n.rank === 'plant') { drawPlant(g, n, w, h, left); }
    else if (n.rank === 'family') { drawFamily(g, n, w, h, left); }
    else { drawPill(g, n, w, h, left); }

    g.addEventListener('click', (e) => {
      if (state.dragged) return;
      e.stopPropagation();
      handleNodeClick(n);
    });
    return g;
  }

  function drawPill(g, n, w, h, left) {
    const fs = n.rank === 'root' ? 14 : 13.5;
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: h / 2, ry: h / 2 }));
    g.appendChild(svgText(n.label, { x: 0, y: h / 2 + 5, 'text-anchor': 'middle', 'font-size': fs }));
  }

  function drawFamily(g, n, w, h, left) {
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: 9, ry: 9 }));
    g.appendChild(svgText(n.label, { x: 0, y: 19, 'text-anchor': 'middle', 'font-size': 13 }, 't-name'));
    if (n.commonName) g.appendChild(svgText(n.commonName, { x: 0, y: 34, 'text-anchor': 'middle', 'font-size': 10.5 }, 't-common'));
  }

  function drawPlant(g, n, w, h, left) {
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: 11, ry: 11 }));
    if (n.category) g.appendChild(svgEl('circle', { class: 'cat-dot cat-' + n.category, cx: left + 12, cy: 13, r: 4, fill: catColor(n.category) }));
    let y = 18;
    for (const line of n.nameLines) {
      g.appendChild(svgText(line, { x: 0, y, 'text-anchor': 'middle', 'font-size': 13.5 }, 't-name'));
      y += 16;
    }
    if (n.sci) g.appendChild(svgText(truncate(n.sci, 22), { x: 0, y: y + 1, 'text-anchor': 'middle', 'font-size': 11 }, 't-sci'));
  }

  function catColor(cat) {
    return cat === 'flowers' ? '#b85a8a' : cat === 'herbs' ? '#4a7c4e' : cat === 'edibles' ? '#c04020' : '#6b8e23';
  }

  function drawSuggestion(g, n, w, h, left) {
    const sug = n.suggestion;
    g.appendChild(svgEl('rect', { class: 'box', x: left, y: 0, width: w, height: h, rx: 11, ry: 11 }));

    // Photo (clipped, rounded). A placeholder sits behind so failures degrade.
    const pw = w - 12, px = left + 6, py = 6, ph = 74;
    g.appendChild(svgEl('rect', { class: 'sug-photo-ph', x: px, y: py, width: pw, height: ph, rx: 7, ry: 7 }));
    g.appendChild(svgText('iNaturalist photo', { x: 0, y: py + ph / 2 + 3, 'text-anchor': 'middle', 'font-size': 9 }, 'sug-photo-ph-text'));
    if (sug.photoUrl) {
      const img = svgEl('image', {
        x: px, y: py, width: pw, height: ph,
        preserveAspectRatio: 'xMidYMid slice',
        'clip-path': 'url(#sugPhotoClip)',
      });
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', sug.photoUrl);
      img.setAttribute('href', sug.photoUrl);
      img.addEventListener('error', () => { img.style.display = 'none'; });
      g.appendChild(img);
    }

    let y = py + ph + 16;
    g.appendChild(svgText(truncate(sug.common || sug.sci, 20), { x: 0, y, 'text-anchor': 'middle', 'font-size': 12.5 }, 't-common'));
    y += 15;
    g.appendChild(svgText(truncate(sug.sci, 22), { x: 0, y, 'text-anchor': 'middle', 'font-size': 11 }, 't-sci'));
    y += 15;
    // "iNaturalist" source tag
    const tagW = 64, tagH = 15;
    g.appendChild(svgEl('rect', { class: 'sug-tag', x: -tagW / 2, y: y - 11, width: tagW, height: tagH, rx: 7, ry: 7 }));
    g.appendChild(svgText('iNaturalist', { x: 0, y: y + 0.5, 'text-anchor': 'middle', 'font-size': 9.5 }, 'sug-tag-text'));
    y += 17;
    if (sug.attribution) g.appendChild(svgText(truncate(sug.attribution, 26), { x: 0, y, 'text-anchor': 'middle', 'font-size': 9 }, 't-attr'));

    const title = svgEl('title');
    title.textContent = (sug.common ? sug.common + ' — ' : '') + sug.sci +
      (sug.attribution ? '\nPhoto: ' + sug.attribution : '') + '\nOpens iNaturalist / Wikipedia';
    g.appendChild(title);
  }

  /* ---------- relationship tiers ---------- */

  // species (cross freely) > genus (maybe) > family (cousins). Compares the
  // selected plant against every plant + suggestion node carrying taxonomy.
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
    const tiers = new Map();
    const counts = { species: 0, genus: 0, family: 0 };
    for (const n of allNodes()) {
      if (n.rank !== 'plant' && n.rank !== 'suggestion') continue;
      const tier = tierOf(sel, n);
      if (!tier) continue;
      tiers.set(n.key, tier);
      if (tier !== 'self' && n.rank === 'plant') counts[tier]++;
    }
    return { tiers, counts };
  }

  function applyHighlight() {
    const sel = state.nodesByKey.get(state.selectedKey);
    state.elByKey.forEach((el) => {
      el.classList.remove('tier-self', 'tier-species', 'tier-genus', 'tier-family', 'dim');
    });
    if (!sel) return;
    const { tiers } = computeTiers(sel);
    state.elByKey.forEach((el, key) => {
      const node = state.nodesByKey.get(key);
      const tier = tiers.get(key);
      if (tier) el.classList.add('tier-' + tier);
      else if (node && (node.rank === 'plant' || node.rank === 'suggestion')) el.classList.add('dim');
    });
  }

  /* ---------- interaction ---------- */

  function handleNodeClick(n) {
    if (n.rank === 'plant') {
      selectPlant(n.key);
    } else if (n.rank === 'suggestion') {
      const url = n.suggestion.wikipedia || n.suggestion.inat;
      if (url) window.open(url, '_blank', 'noopener');
    } else {
      fitSubtree(n.key, true);
    }
  }

  function selectPlant(key) {
    state.selectedKey = key;
    applyHighlight();
    updatePanel();
    const n = state.nodesByKey.get(key);
    if (n) animateTo(centerTarget(n));
  }

  function deselect() {
    state.selectedKey = null;
    applyHighlight();
    state.panel.classList.remove('open');
  }

  /* ---------- selection panel ---------- */

  function updatePanel() {
    const sel = state.nodesByKey.get(state.selectedKey);
    if (!sel) { state.panel.classList.remove('open'); return; }
    const { counts } = computeTiers(sel);
    const tax = sel.tax;
    const lineage = [
      tax.family && `<span>${escapeHtml(tax.family)}</span>`,
      tax.genus && `<span><em>${escapeHtml(tax.genus)}</em></span>`,
      tax.species && `<span><em>${escapeHtml(tax.species)}</em></span>`,
    ].filter(Boolean).join('<span class="sep">›</span>');

    let verdict, vtier;
    if (counts.species > 0) {
      vtier = 'species';
      verdict = `Crosses freely with <strong>${counts.species}</strong> other <em>${escapeHtml(tax.species)}</em> in the garden — same species.`;
    } else if (counts.genus > 0) {
      vtier = 'genus';
      verdict = `Shares the genus <em>${escapeHtml(tax.genus)}</em> with <strong>${counts.genus}</strong> garden plant${counts.genus > 1 ? 's' : ''}. Crossing is hit or miss.`;
    } else if (counts.family > 0) {
      vtier = 'family';
      verdict = `<strong>${counts.family}</strong> ${escapeHtml(tax.family)} cousin${counts.family > 1 ? 's' : ''} in the garden. Related, but they will not cross.`;
    } else {
      vtier = 'alone';
      verdict = `Stands alone — no relatives in the garden share <em>${escapeHtml(tax.genus || tax.family)}</em> or the ${escapeHtml(tax.family)} family.`;
    }

    const speciesBtn = tax.species
      ? `<button type="button" data-tier="species">Similar species</button>` : '';

    state.panel.innerHTML = `
      <button type="button" class="tp-close" aria-label="Close">×</button>
      <div class="tp-name">${escapeHtml(sel.label)}</div>
      <div class="tp-sci">${escapeHtml(sel.sci || '')}</div>
      <div class="tp-lineage">${lineage}</div>
      <div class="tp-verdict tier-${vtier}">${verdict}</div>
      <div class="tp-legend">
        <span><i class="lg-species"></i>Same species — cross freely</span>
        <span><i class="lg-genus"></i>Same genus — maybe</span>
        <span><i class="lg-family"></i>Same family — cousins</span>
      </div>
      <div class="tp-actions">
        ${speciesBtn}
        <button type="button" data-tier="genus">Similar in genus</button>
        <button type="button" data-tier="family">Similar in family</button>
      </div>
      <div class="tp-status" id="tp-status"></div>
      <div class="tp-foot">Suggestions are fetched live from iNaturalist (read-only) and are not saved to your garden. Photos are user-contributed under their own licenses — attribution shown on each card.</div>
    `;
    state.panel.classList.add('open');

    state.panel.querySelector('.tp-close').addEventListener('click', deselect);
    state.panel.querySelectorAll('.tp-actions button').forEach((b) => {
      b.addEventListener('click', () => inject(b.dataset.tier, b));
    });
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('tp-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'tp-status' + (kind ? ' ' + kind : '');
  }

  /* ---------- iNaturalist API ---------- */

  function apiGet(url) {
    if (state.fetchCache.has(url)) return state.fetchCache.get(url);
    const p = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('iNaturalist returned ' + r.status);
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    })();
    state.fetchCache.set(url, p);
    p.catch(() => state.fetchCache.delete(url)); // allow retry after failure
    return p;
  }

  async function resolveTaxonId(name, rank) {
    const url = `${API}/taxa?q=${encodeURIComponent(name)}&rank=${rank}&per_page=1`;
    const data = await apiGet(url);
    const hit = (data.results || [])[0];
    return hit ? hit.id : null;
  }

  // Descendants of a clade at a rank. Defensive ancestor filter keeps the set
  // correct even if the server-side clade filter is loose.
  async function fetchDescendants(parentId, rank) {
    const url = `${API}/taxa?taxon_id=${parentId}&rank=${rank}&per_page=30&order_by=observations_count&order=desc`;
    const data = await apiGet(url);
    return (data.results || []).filter((t) =>
      t.id !== parentId &&
      ((Array.isArray(t.ancestor_ids) && t.ancestor_ids.includes(parentId)) || t.parent_id === parentId)
    );
  }

  // Background family lookup for genera missing from the local map.
  async function resolveFamilyAsync(genus) {
    if (state.familyCache[genus]) return;
    try {
      const url = `${API}/taxa?q=${encodeURIComponent(genus)}&rank=genus&per_page=1`;
      const data = await apiGet(url);
      const hit = (data.results || [])[0];
      const fam = hit && (hit.ancestors || []).find((a) => a.rank === 'family');
      const name = fam ? fam.name : null;
      if (name && name !== state.familyCache[genus]) {
        state.familyCache[genus] = name;
        rebuild();
        if (state.selectedKey) { applyHighlight(); }
      }
    } catch (_) { /* leave under "Unplaced" */ }
  }

  // Set of every scientific name already on the tree (lowercased) for de-dup.
  function existingSciNames() {
    const set = new Set();
    for (const p of state.plants) {
      const t = parseTaxon(p.scientificName);
      if (t.genus) set.add(lc(t.genus));
      if (t.species) set.add(lc(t.species));
      const fam = resolveFamilySync(t.genus);
      if (fam) set.add(lc(fam));
    }
    for (const sug of state.injected) set.add(lc(sug.sci));
    return set;
  }

  function ancestorOfRank(node, rank) {
    let n = node;
    while (n) { if (n.rank === rank) return n; n = n.parent; }
    return null;
  }

  function hasPhoto(t) { return t.default_photo ? 1 : 0; }

  async function inject(tier, btn) {
    const sel = state.nodesByKey.get(state.selectedKey);
    if (!sel || sel.rank !== 'plant') return;

    let queryName, queryRank, descRank, parent, label;
    if (tier === 'genus') {
      queryName = sel.tax.genus; queryRank = 'genus'; descRank = 'species';
      parent = ancestorOfRank(sel, 'genus'); label = 'genus ' + sel.tax.genus;
    } else if (tier === 'family') {
      queryName = sel.tax.family; queryRank = 'family'; descRank = 'genus';
      parent = ancestorOfRank(sel, 'family'); label = 'the ' + sel.tax.family + ' family';
    } else {
      queryName = sel.tax.species; queryRank = 'species'; descRank = 'subspecies';
      parent = ancestorOfRank(sel, 'species'); label = sel.tax.species;
    }

    if (!queryName || !parent) {
      setStatus('No ' + tier + '-level taxon recorded for this plant.', 'error');
      return;
    }

    if (btn) btn.setAttribute('aria-busy', 'true');
    setStatus('Searching iNaturalist for relatives in ' + label + '…', 'loading');

    try {
      const parentId = await resolveTaxonId(queryName, queryRank);
      if (!parentId) { setStatus('Could not find "' + queryName + '" on iNaturalist.', 'error'); return; }

      let results = await fetchDescendants(parentId, descRank);
      const exclude = existingSciNames();
      exclude.add(lc(queryName));
      results = results.filter((t) => t.name && !exclude.has(lc(t.name)));
      results.sort((a, b) => (hasPhoto(b) - hasPhoto(a)) || ((b.observations_count || 0) - (a.observations_count || 0)));
      results = results.slice(0, MAX_SUGGESTIONS);

      if (!results.length) { setStatus('No new relatives found in ' + label + '.', 'ok'); return; }

      for (const t of results) {
        state.injected.push({
          parentKey: parent.key,
          taxonId: t.id,
          sci: t.name,
          suggestionRank: descRank,
          common: t.preferred_common_name || '',
          photoUrl: t.default_photo ? (t.default_photo.square_url || t.default_photo.medium_url || '') : '',
          attribution: t.default_photo ? (t.default_photo.attribution || '') : '',
          obs: t.observations_count || 0,
          wikipedia: t.wikipedia_url || '',
          inat: 'https://www.inaturalist.org/taxa/' + t.id,
        });
      }

      rebuild();
      applyHighlight();
      fitSubtree(parent.key, true);
      setStatus('Grafted ' + results.length + ' relative' + (results.length > 1 ? 's' : '') + ' from iNaturalist.', 'ok');
    } catch (err) {
      const msg = err && err.name === 'AbortError'
        ? 'iNaturalist request timed out. Tap to try again.'
        : 'Could not reach iNaturalist: ' + (err && err.message ? err.message : 'network error') + '.';
      setStatus(msg, 'error');
    } finally {
      if (btn) btn.removeAttribute('aria-busy');
    }
  }

  // Rebuild model + layout + redraw, preserving the current pan/zoom transform.
  function rebuild() {
    buildModel();
    layout(state.root);
    draw();
  }

  /* ---------- pan / zoom wiring ---------- */

  function wirePointer(svg) {
    const pointers = new Map();
    let panStart = null;
    let pinchPrev = null;

    function pinchInfo() {
      const ps = [...pointers.values()];
      const a = ps[0], b = ps[1];
      const dx = a.x - b.x, dy = a.y - b.y;
      return { dist: Math.hypot(dx, dy) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }

    svg.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      state.dragged = false;
      if (pointers.size === 1) panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
      else if (pointers.size === 2) { pinchPrev = pinchInfo(); panStart = null; }
    });

    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = pointers.get(e.pointerId);
      p.x = e.clientX; p.y = e.clientY;
      const rect = svg.getBoundingClientRect();
      if (pointers.size >= 2) {
        const info = pinchInfo();
        if (pinchPrev) {
          zoomAt(info.mx - rect.left, info.my - rect.top, info.dist / pinchPrev.dist);
          state.tx += info.mx - pinchPrev.mx;
          state.ty += info.my - pinchPrev.my;
          applyTransform();
        }
        pinchPrev = info;
        state.dragged = true;
      } else if (panStart) {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) state.dragged = true;
        state.tx = panStart.tx + dx;
        state.ty = panStart.ty + dy;
        applyTransform();
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchPrev = null;
      if (pointers.size === 0) panStart = null;
      else if (pointers.size === 1) {
        const only = [...pointers.values()][0];
        panStart = { x: only.x, y: only.y, tx: state.tx, ty: state.ty };
      }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', endPointer);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      applyTransform();
    }, { passive: false });

    // Click on empty canvas clears the selection.
    svg.addEventListener('click', (e) => {
      if (!state.dragged && e.target === svg) deselect();
    });
  }

  /* ---------- entry point ---------- */

  let dataLoaded = false;
  async function loadTaxonomy() {
    if (dataLoaded) return;
    try {
      const r = await fetch('data/taxonomy.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        state.genusToFamily = j.genusToFamily || {};
        state.familyCommon = j.familyCommonNames || {};
      }
    } catch (_) { /* fall back to iNaturalist family lookups */ }
    dataLoaded = true;
  }

  async function render(appEl, plants) {
    state.plants = plants || [];
    // Reset per-visit view state but keep caches + session suggestions.
    state.selectedKey = null;
    state.tx = 0; state.ty = 0; state.k = 1;
    document.title = 'Family Tree · Newton Garden';

    appEl.innerHTML = `
      <div class="tree-view">
        <div class="tree-bar">
          <a class="tree-back" href="#/">← Garden</a>
          <h1 class="tree-title">Living Family Tree</h1>
          <span class="tree-hint">Tap a plant</span>
        </div>
        <div class="tree-canvas-wrap">
          <svg class="tree-svg" id="tree-svg">
            <defs>
              <clipPath id="sugPhotoClip" clipPathUnits="userSpaceOnUse">
                <rect x="-63" y="6" width="126" height="74" rx="7" ry="7"></rect>
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

    wirePointer(state.svg);
    document.getElementById('tree-zin').addEventListener('click', () => {
      const vp = viewport(); zoomAt(vp.w / 2, vp.h / 2, 1.25); applyTransform();
    });
    document.getElementById('tree-zout').addEventListener('click', () => {
      const vp = viewport(); zoomAt(vp.w / 2, vp.h / 2, 0.8); applyTransform();
    });
    document.getElementById('tree-fit').addEventListener('click', () => fitAll(true));

    // Fit once the SVG has real dimensions.
    requestAnimationFrame(() => fitAll(false));
    const onResize = () => { if (!state.selectedKey) fitAll(false); };
    window.addEventListener('resize', onResize);

    // Teardown when the route changes (the only window-level listener to drop).
    state.teardown = () => {
      window.removeEventListener('resize', onResize);
      if (state.anim) cancelAnimationFrame(state.anim);
      state.anim = null;
    };
    window.addEventListener('hashchange', function once() {
      window.removeEventListener('hashchange', once);
      if (state.teardown) { state.teardown(); state.teardown = null; }
    });
  }

  // Pure helpers exposed for headless tests (no DOM, no network for mapped genera).
  window.NewtonTree = {
    render,
    _test: { parseTaxon, buildModel, layout, tierOf, computeTiers, state },
  };
})();
