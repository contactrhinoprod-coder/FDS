/* ============================================================
   FDS — app.js
   PWA vanilla. Pas de build, pas de dépendance externe.
   Même philosophie que DVDthèque / ALPHABRAVO.
   Organisation :
     1. Utils & état global
     2. Store (IndexedDB) — couche données offline-first
     3. Cloud (Firebase) — auth Google/Apple + Firestore (optionnel)
     4. Export — PDF (print) + DOC (HTML-Word)
     5. Mail & Partage — Voie A (mailto nominatif) + Web Share
     6. Rendu de la feuille (.fds-doc) — fidèle à la référence
     7. UI / Router / Rendu des vues
     8. Bootstrap
   ============================================================ */

'use strict';

/* ============================================================
   1. UTILS & ÉTAT GLOBAL
   ============================================================ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const State = {
  projects: [],         // [{id, name, producers, created}]
  sheets: [],           // [{id, projectId, ...feuille}]
  crew: [],             // carnet équipe [{id, name, role, phone, email}]
  locations: [],        // carnet lieux  [{id, label, name, address, mapUrl, kind}]
  view: 'projects',
  currentProjectId: null,
  currentSheetId: null,
  search: '',
  settings: {
    theme: 'dark',
    prodName: 'H2M et RhinoProd',
    logoLeft: '',        // dataURL
    logoRight: '',       // dataURL
  },
};

// Postes standard d'un plateau (ordre = ordre d'affichage convocations)
const ROLES = [
  'Prod/Réal', 'Prod/Réal', 'Prod/Chef op son', 'Directrice de production',
  'DOP', 'Chef élec', 'Élec', 'Élec', '1er ass. cam', '2nd ass. cam',
  'Machiniste', 'Making of vidéo', 'Making of photo', 'MUA', 'Cadreur',
  'Ingé son', 'Scripte', 'Régie', 'HMC', 'Comédien·ne', 'Figurant·e', 'Autre',
];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "2026-04-01" -> "MERCREDI 01/04/2026"
function fmtDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  const jours = ['DIMANCHE','LUNDI','MARDI','MERCREDI','JEUDI','VENDREDI','SAMEDI'];
  const p = n => String(n).padStart(2, '0');
  return `${jours[d.getDay()]} ${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}
function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

/* ============================================================
   2. STORE — IndexedDB (offline-first)
   Stores : projects, sheets, crew, locations, kv (réglages).
   ============================================================ */
const Store = (() => {
  const DB = 'fds', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        for (const s of ['projects', 'sheets', 'crew', 'locations'])
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { db = req.result; res(db); };
      req.onerror = () => rej(req.error);
    });
  }
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const wrap = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  const api = (store) => ({
    all:  ()    => wrap(tx(store, 'readonly').getAll()),
    put:  (o)   => wrap(tx(store, 'readwrite').put(o)),
    del:  (id)  => wrap(tx(store, 'readwrite').delete(id)),
    clear:()    => wrap(tx(store, 'readwrite').clear()),
  });

  return {
    init: open,
    projects:  api('projects'),
    sheets:    api('sheets'),
    crew:      api('crew'),
    locations: api('locations'),
    getKV: (k)    => wrap(tx('kv', 'readonly').get(k)).then(r => r && r.v),
    setKV: (k, v) => wrap(tx('kv', 'readwrite').put({ k, v })),
    wipeAll: async () => {
      for (const s of ['projects', 'sheets', 'crew', 'locations']) await api(s).clear();
    },
  };
})();

/* ============================================================
   3. CLOUD — Firebase (auth Google/Apple + Firestore)
   - Config en dur ci-dessous (FIREBASE_CONFIG) : remplacer les
     "TON_…" par les valeurs du projet Firebase.
   - Tant que FIREBASE_CONFIG n'est pas rempli, l'app reste 100% locale.
   - Auth : Google + Apple. Sync : users/{uid}/{projects|sheets|crew|locations}
   ============================================================ */
/* ↓↓↓ REMPLACER PAR TES VALEURS FIREBASE ↓↓↓ */
const FIREBASE_CONFIG = {
  apiKey:            "TON_API_KEY",
  authDomain:        "TON_PROJET.firebaseapp.com",
  projectId:         "TON_PROJET",
  storageBucket:     "TON_PROJET.firebasestorage.app",
  messagingSenderId: "TON_SENDER_ID",
  appId:             "TON_APP_ID",
};
/* ↑↑↑ REMPLACER PAR TES VALEURS FIREBASE ↑↑↑ */

const Cloud = (() => {
  let auth = null, db = null, user = null, ready = false;

  function configured() {
    return typeof firebase !== 'undefined'
      && FIREBASE_CONFIG.projectId
      && FIREBASE_CONFIG.projectId !== 'TON_PROJET';
  }

  function init(onUser) {
    if (!configured()) { ready = false; onUser(null); return; }
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    ready = true;
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    auth.onAuthStateChanged((u) => { user = u; onUser(u); });
  }

  async function signInGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  }
  async function signInApple() {
    const provider = new firebase.auth.OAuthProvider('apple.com');
    provider.addScope('email'); provider.addScope('name');
    await auth.signInWithPopup(provider);
  }
  async function signOut() { if (auth) await auth.signOut(); }

  function col(name) {
    return db.collection('users').doc(user.uid).collection(name);
  }

  // Pousse toute la base locale vers Firestore
  async function pushAll() {
    if (!ready || !user) return;
    const batches = [
      ['projects', State.projects], ['sheets', State.sheets],
      ['crew', State.crew], ['locations', State.locations],
    ];
    for (const [name, arr] of batches)
      for (const o of arr) await col(name).doc(o.id).set(o);
  }
  // Tire Firestore -> local (fusion simple : le cloud fait foi)
  async function pullAll() {
    if (!ready || !user) return;
    for (const name of ['projects', 'sheets', 'crew', 'locations']) {
      const snap = await col(name).get();
      const arr = snap.docs.map(d => d.data());
      State[name] = arr;
      for (const o of arr) await Store[name].put(o);
    }
  }
  async function saveDoc(name, obj) {
    if (!ready || !user) return;
    await col(name).doc(obj.id).set(obj);
  }
  async function delDoc(name, id) {
    if (!ready || !user) return;
    await col(name).doc(id).delete();
  }

  return {
    init, configured, signInGoogle, signInApple, signOut,
    pushAll, pullAll, saveDoc, delDoc,
    get user() { return user; }, get ready() { return ready; },
  };
})();

/* ============================================================
   4. EXPORT — PDF (impression navigateur) + DOC (HTML-Word)
   ============================================================ */
const Export = (() => {

  // PDF : on remplit #print-area avec le rendu, puis window.print().
  // Les règles @media print (style.css) isolent #print-area en A4.
  function toPDF(sheet, project) {
    const area = $('#print-area');
    area.innerHTML = FdsRender.html(sheet, project);
    // Laisse le DOM se peindre avant d'imprimer
    setTimeout(() => {
      window.print();
      // nettoyage différé (après la boîte d'impression)
      setTimeout(() => { area.innerHTML = ''; }, 1000);
    }, 60);
  }

  // DOC : HTML-Word. Un fichier .doc qui s'ouvre dans Word / Pages /
  // Google Docs et reste éditable. Pas de dépendance.
  function toDOC(sheet, project) {
    const inner = FdsRender.html(sheet, project, { forDoc: true });
    const css = `
      body{font-family:Arial,sans-serif;font-size:10pt;}
      table{border-collapse:collapse;width:100%;}
      td,th{border:1px solid #000;padding:3px 5px;vertical-align:middle;}
      .fds-sectionbar{background:#d9d9d9;text-align:center;font-weight:bold;text-transform:uppercase;padding:3px;}
      .t1{font-weight:bold;font-size:13pt;} .t2{font-weight:bold;font-size:12pt;} .t4{background:#404040;color:#fff;font-weight:bold;padding:2px;}
      .lbl{font-weight:bold;background:#f0f0f0;} .big{font-weight:bold;color:#c00;text-align:center;}
      .lh{background:#f0f0f0;font-weight:bold;text-align:center;} a{color:#1155cc;}
      th{background:#f0f0f0;font-size:8pt;text-transform:uppercase;text-align:center;font-weight:bold;}
      .nm{font-weight:bold;} .cv{font-weight:bold;color:#c00;} .syn{font-style:italic;text-align:center;}
      .note-title{font-weight:bold;text-transform:uppercase;}
    `;
    const html =
      '\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><style>' + css +
      '@page{size:A4 portrait;margin:1cm;}</style></head><body>' + inner + '</body></html>';

    const blob = new Blob([html], { type: 'application/msword' });
    const fname = `FDS_${(project?.name || 'feuille').replace(/\s+/g, '_')}_${sheet.date || ''}.doc`;
    triggerDownload(blob, fname);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Export JSON complet (sauvegarde / transfert)
  function toJSON() {
    const data = {
      projects: State.projects, sheets: State.sheets,
      crew: State.crew, locations: State.locations,
      settings: State.settings, exportedAt: new Date().toISOString(),
    };
    triggerDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `fds-sauvegarde-${Date.now()}.json`);
  }

  return { toPDF, toDOC, toJSON, triggerDownload };
})();

/* ============================================================
   5. MAIL & PARTAGE
   Voie A : mailto nominatif (pré-rempli, l'utilisateur joint le
   PDF et envoie). Structuré pour passer en envoi auto natif plus
   tard (remplacer Mailer.send par un appel Cloud Function/MAPI).
   ============================================================ */
const Mailer = (() => {

  // Construit le message nominatif pour un membre donné
  function buildMessage(member, sheet, project) {
    const loc = sheet.locTournage || {};
    const lignes = [
      `Bonjour ${member.name || ''},`,
      ``,
      `Voici ta feuille de service pour le tournage "${project?.name || sheet.subject || ''}".`,
      ``,
      `📅 ${fmtDateLong(sheet.date)}${sheet.dayNum ? ` — Jour ${sheet.dayNum}/${sheet.dayTotal || ''}` : ''}`,
      `🎬 Poste : ${member.role || '—'}`,
      `⏰ Convocation : ${member.call || sheet.dayStart || 'à confirmer'}`,
      loc.name ? `📍 Lieu : ${loc.name}${loc.address ? ` (${loc.address})` : ''}` : '',
      loc.mapUrl ? `🗺️ Plan : ${loc.mapUrl}` : '',
      sheet.sunRise || sheet.sunSet ? `☀️ Soleil : lever ${sheet.sunRise || '—'} / coucher ${sheet.sunSet || '—'}` : '',
      sheet.weather ? `🌤️ Météo : ${sheet.weather}` : '',
      ``,
      sheet.note ? `ℹ️ Note : ${sheet.note}` : '',
      ``,
      `La feuille de service complète est en pièce jointe (PDF).`,
      ``,
      `À très vite sur le plateau !`,
      `${State.settings.prodName || ''}`,
    ];
    return lignes.filter(l => l !== undefined).join('\n');
  }

  function subject(member, sheet, project) {
    return `Feuille de service — ${project?.name || sheet.subject || 'Tournage'} — ${fmtDateShort(sheet.date)}`;
  }

  // Ouvre l'app mail pré-remplie pour UN membre
  function mailToMember(member, sheet, project) {
    if (!member.email) { toast('Pas d\'email renseigné pour ce membre'); return; }
    const url = `mailto:${encodeURIComponent(member.email)}`
      + `?subject=${encodeURIComponent(subject(member, sheet, project))}`
      + `&body=${encodeURIComponent(buildMessage(member, sheet, project))}`;
    window.location.href = url;
  }

  return { mailToMember, buildMessage, subject };
})();

const Share = (() => {
  // Partage natif (WhatsApp/Messages/etc.) via Web Share API.
  // Tente de partager le PDF en fichier si supporté, sinon un texte récap.
  async function shareSheet(sheet, project) {
    const text = recap(sheet, project);
    try {
      if (navigator.share) {
        await navigator.share({ title: `FDS — ${project?.name || ''}`, text });
      } else {
        // Fallback : lien WhatsApp web
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      }
    } catch (e) { /* annulé par l'utilisateur */ }
  }
  function recap(sheet, project) {
    const loc = sheet.locTournage || {};
    return [
      `🎬 FEUILLE DE SERVICE`,
      `${project?.name || sheet.subject || ''}`,
      `${fmtDateLong(sheet.date)}${sheet.dayNum ? ` — Jour ${sheet.dayNum}/${sheet.dayTotal || ''}` : ''}`,
      sheet.dayStart || sheet.dayEnd ? `⏰ ${sheet.dayStart || ''} → ${sheet.dayEnd || ''}` : '',
      loc.name ? `📍 ${loc.name}` : '',
      loc.mapUrl ? loc.mapUrl : '',
      sheet.weather ? `🌤️ ${sheet.weather}` : '',
    ].filter(Boolean).join('\n');
  }
  return { shareSheet, recap };
})();

/* ============================================================
   6. RENDU DE LA FEUILLE (.fds-doc)
   Reproduit fidèlement la référence H2M/Rhino.
   html(sheet, project, opts) -> chaîne HTML.
   Utilisé à l'écran (aperçu), pour le PDF (#print-area) et le DOC.
   ============================================================ */
const FdsRender = (() => {

  function logoCell(src, side) {
    if (src) return `<td class="fds-logo-cell"><img src="${src}" alt="logo"></td>`;
    return `<td class="fds-logo-cell"><div class="fds-logo-ph">LOGO ${side}</div></td>`;
  }

  function header(s, p) {
    return `
    <table class="fds-header"><tr>
      ${logoCell(State.settings.logoLeft, 'GAUCHE')}
      <td class="fds-title-cell">
        <div class="t1">FEUILLE DE SERVICE${s.sheetNum ? ' N°' + esc(s.sheetNum) : ''}</div>
        <div class="t2">${esc(s.subject || (p && p.name) || '')}</div>
        <div class="t3">Produit par ${esc(p && p.producers || State.settings.prodName || '')}</div>
        <div class="t4">${esc(fmtDateLong(s.date))}${s.dayNum ? ' - JOUR ' + esc(s.dayNum) + '/' + esc(s.dayTotal || '') : ''}</div>
      </td>
      ${logoCell(State.settings.logoRight, 'DROITE')}
    </tr></table>`;
  }

  function band(s) {
    // Horaires prévisionnels (PAT1, repas, PAT2, fin) + éphémérides
    const r = (lbl, val, time) => `
      <tr>
        <td class="lbl">${esc(lbl)}</td>
        <td>${esc(val)}</td>
        <td style="text-align:center">${esc(time)}</td>
      </tr>`;
    return `
    <div class="fds-sectionbar">Horaires prévisionnels &nbsp;•&nbsp; ${esc(s.dayStart || '')} - ${esc(s.dayEnd || '')}</div>
    <table class="fds-band">
      <tr>
        <td class="lbl">Contacts clés</td>
        <td class="big" colspan="2">${esc(s.dayStart || '')} - ${esc(s.dayEnd || '')}</td>
        <td class="lbl" style="text-align:center">Éphémérides</td>
        <td class="lbl" style="text-align:center">Météo</td>
      </tr>
      <tr>
        <td rowspan="4" style="font-size:9px">${keyContacts(s)}</td>
        <td>PAT 1</td><td style="text-align:center">${esc(s.pat1 || '')}</td>
        <td class="eph">Lever soleil<br><span class="accent">${esc(s.sunRise || '')}</span></td>
        <td class="eph" rowspan="2"><span class="accent" style="font-size:13px">${esc(s.weather || '')}</span></td>
      </tr>
      <tr>
        <td>Repas</td><td style="text-align:center">${esc(s.meal || '')}</td>
        <td class="eph">Coucher soleil<br><span class="accent">${esc(s.sunSet || '')}</span></td>
      </tr>
      <tr>
        <td>PAT 2</td><td style="text-align:center">${esc(s.pat2 || '')}</td>
        <td class="eph" colspan="2" rowspan="2"></td>
      </tr>
      <tr>
        <td>Fin de journée</td><td style="text-align:center">${esc(s.dayEnd || '')}</td>
      </tr>
    </table>`;
  }

  function keyContacts(s) {
    const kc = (s.crew || []).filter(m => m.key).slice(0, 4);
    if (!kc.length) return '<i>—</i>';
    return kc.map(m => `<b>${esc(m.name)}</b> ${esc(m.phone || '')}`).join('<br>');
  }

  function note(s) {
    if (!s.note) return '';
    return `
    <div class="fds-sectionbar">Note à l'équipe</div>
    <table><tr><td class="fds-note">${esc(s.note).replace(/\n/g, '<br>')}</td></tr></table>`;
  }

  function locRow(label, l) {
    if (!l || (!l.name && !l.address)) return '';
    return `
      <td class="lh">${esc(label)}</td>
      <td>${esc(l.name || '')}${l.address ? '<br>' + esc(l.address) : ''}${l.mapUrl ? '<br><a href="' + esc(l.mapUrl) + '">' + esc(l.mapUrl) + '</a>' : ''}</td>`;
  }

  function locations(s) {
    const T = s.locTournage, P = s.locParking, H = s.locHopital, Po = s.locPolice, Pr = s.locProd;
    let rows = '';
    if (T || P) rows += `<tr>${locRow('Lieu de tournage', T)}${locRow('Parking', P)}</tr>`;
    if (H || Po) rows += `<tr>${locRow('Hôpital le + proche', H)}${locRow('Police la + proche', Po)}</tr>`;
    if (Pr) rows += `<tr>${locRow('Production', Pr)}<td class="lh"></td><td></td></tr>`;
    if (!rows) return '';
    return `
    <div class="fds-sectionbar">Lieux</div>
    <table class="fds-loc">${rows}</table>`;
  }

  function convocations(s) {
    const crew = s.crew || [];
    if (!crew.length) return '';
    // Tableau : une colonne par membre, 3 lignes (poste/nom, tél, convoc).
    // Découpe en blocs de 6 colonnes pour rester lisible.
    const chunk = 6;
    let blocks = '';
    for (let i = 0; i < crew.length; i += chunk) {
      const part = crew.slice(i, i + chunk);
      blocks += `<table class="fds-conv">
        <tr>${part.map(m => `<th>${esc(m.role || '')}</th>`).join('')}</tr>
        <tr>${part.map(m => `<td class="nm">${esc(m.name || '')}</td>`).join('')}</tr>
        <tr>${part.map(m => `<td class="tel">${esc(m.phone || '')}</td>`).join('')}</tr>
        <tr>${part.map(m => `<td class="cv">${esc(m.call || s.dayStart || '')}</td>`).join('')}</tr>
      </table>`;
    }
    return `<div class="fds-sectionbar">Convocations</div>${blocks}`;
  }

  function scenes(s) {
    const sc = s.scenes || [];
    if (!sc.length && !s.scenesSynopsis) return '';
    let rows = sc.map(x => `
      <tr>
        <td class="tag">${esc(x.num || '')}</td>
        <td>${esc(x.desc || '')}</td>
        <td class="tag">${esc(x.intext || '')}</td>
        <td class="tag">${esc(x.decor || '')}</td>
        <td>${esc(x.perso || '')}</td>
        <td class="tag">${esc(x.plans || '')}</td>
        <td class="tag">${esc(x.duration || '')}</td>
      </tr>`).join('');
    const synopsis = s.scenesSynopsis
      ? `<tr><td class="syn" colspan="7">${esc(s.scenesSynopsis)}</td></tr>` : '';
    const head = `<tr>
      <th>Scène</th><th>Description</th><th>INT/EXT</th><th>Décor</th>
      <th>Personnages</th><th>Plans</th><th>Minutage</th></tr>`;
    return `
    <div class="fds-sectionbar">Détails des scènes</div>
    <table class="fds-scenes">${synopsis}${head}${rows}</table>`;
  }

  function footer(s, p) {
    return `
    <table class="fds-foot"><tr>
      <td>${esc(s.subject || (p && p.name) || '')}</td>
      <td class="mid">${esc(s.episode || '')}</td>
      <td>${esc(p && p.producers || State.settings.prodName || '')}</td>
    </tr></table>`;
  }

  function html(s, p, opts = {}) {
    return `<div class="fds-doc">
      ${header(s, p)}
      ${band(s)}
      ${note(s)}
      ${locations(s)}
      ${convocations(s)}
      ${scenes(s)}
      ${footer(s, p)}
    </div>`;
  }

  return { html };
})();

/* ============================================================
   7. UI / ROUTER / RENDU DES VUES
   ============================================================ */

// --- Helpers data ---
const byId = (arr, id) => arr.find(x => x.id === id);
function sheetsOfProject(pid) {
  return State.sheets.filter(s => s.projectId === pid)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
async function persist(name, obj) {
  await Store[name].put(obj);
  Cloud.saveDoc(name, obj).catch(() => {});
}
async function remove(name, id) {
  await Store[name].del(id);
  Cloud.delDoc(name, id).catch(() => {});
}

// --- Router ---
function go(view, opts = {}) {
  State.view = view;
  $$('#views .view').forEach(v => v.hidden = (v.dataset.view !== view));
  $$('#tabbar .tab[data-go]').forEach(t => t.classList.toggle('active', t.dataset.go === view));

  const titles = {
    projects: 'Mes projets', sheets: State._projName || 'Feuilles',
    carnet: 'Carnet', preview: 'Aperçu', profile: 'Profil',
  };
  $('#topbar-title').textContent = titles[view] || 'FDS';
  const back = $('#back-btn');
  back.hidden = !(view === 'sheets' || view === 'preview');

  if (view === 'projects') renderProjects();
  if (view === 'sheets') renderSheets();
  if (view === 'carnet') renderCarnet();
  if (view === 'preview') renderPreview();
  if (view === 'profile') renderProfile();
  window.scrollTo(0, 0);
}

// --- Vue Projets ---
function renderProjects() {
  const box = $('#sheets-list'); // réutilise le conteneur de la 1ère vue
  const list = State.projects.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
  $('#sheets-empty').hidden = list.length > 0;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map(p => {
    const n = sheetsOfProject(p.id).length;
    return `<div class="card" data-pid="${p.id}">
      <div class="card-main">
        <div class="card-title">${esc(p.name)}</div>
        <div class="card-sub">${esc(p.producers || '')}</div>
      </div>
      <span class="card-badge ${n ? '' : 'muted'}">${n} feuille${n > 1 ? 's' : ''}</span>
      <div class="card-actions"><button data-del-proj="${p.id}">🗑</button></div>
    </div>`;
  }).join('');
  $$('.card[data-pid]', box).forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('[data-del-proj]')) return;
      openProject(c.dataset.pid);
    });
  });
  $$('[data-del-proj]', box).forEach(b => b.addEventListener('click', async () => {
    const p = byId(State.projects, b.dataset.delProj);
    if (!confirm(`Supprimer le projet "${p.name}" et ses feuilles ?`)) return;
    for (const s of sheetsOfProject(p.id)) { await remove('sheets', s.id); }
    State.sheets = State.sheets.filter(s => s.projectId !== p.id);
    await remove('projects', p.id);
    State.projects = State.projects.filter(x => x.id !== p.id);
    renderProjects();
    toast('Projet supprimé');
  }));
}

function openProject(pid) {
  State.currentProjectId = pid;
  const p = byId(State.projects, pid);
  State._projName = p ? p.name : 'Feuilles';
  go('sheets');
}

// --- Vue Feuilles d'un projet ---
function renderSheets() {
  const box = $('#sheets-list');
  const list = sheetsOfProject(State.currentProjectId);
  const sort = $('#sort-select').value;
  if (sort === 'date') list.reverse();
  $('#sheets-empty').hidden = list.length > 0;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map(s => `
    <div class="card" data-sid="${s.id}">
      <div class="card-main">
        <div class="card-title">${esc(s.subject || 'Sans titre')}${s.sheetNum ? ' · N°' + esc(s.sheetNum) : ''}</div>
        <div class="card-sub">${esc(fmtDateLong(s.date))}${s.dayNum ? ' — Jour ' + esc(s.dayNum) + '/' + esc(s.dayTotal || '') : ''}</div>
      </div>
      <span class="card-badge ${(s.crew||[]).length ? '' : 'muted'}">${(s.crew||[]).length} pers.</span>
      <div class="card-actions"><button data-del-sheet="${s.id}">🗑</button></div>
    </div>`).join('');
  $$('.card[data-sid]', box).forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('[data-del-sheet]')) return;
      openSheet(c.dataset.sid);
    });
  });
  $$('[data-del-sheet]', box).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Supprimer cette feuille ?')) return;
    await remove('sheets', b.dataset.delSheet);
    State.sheets = State.sheets.filter(x => x.id !== b.dataset.delSheet);
    renderSheets();
    toast('Feuille supprimée');
  }));
}

function openSheet(sid) {
  State.currentSheetId = sid;
  go('preview');
}

// --- Vue Aperçu ---
function renderPreview() {
  const s = byId(State.sheets, State.currentSheetId);
  if (!s) { go('sheets'); return; }
  const p = byId(State.projects, s.projectId);
  $('#preview-content').innerHTML = FdsRender.html(s, p);
}

/* --- ÉDITEUR DE FEUILLE (modale complète) --- */
let editDraft = null;

function field(label, key, val, type = 'text', ph = '') {
  if (type === 'textarea')
    return `<div class="field"><label>${label}</label><textarea data-k="${key}" placeholder="${esc(ph)}">${esc(val||'')}</textarea></div>`;
  return `<div class="field"><label>${label}</label><input data-k="${key}" type="${type}" value="${esc(val||'')}" placeholder="${esc(ph)}"></div>`;
}
function locFields(label, key, l) {
  l = l || {};
  return `<div class="repeat-item">
    <div class="form-section-title" style="margin-top:0">${label}</div>
    <div class="field"><label>Nom du lieu</label><input data-loc="${key}.name" value="${esc(l.name)}"></div>
    <div class="field"><label>Adresse</label><input data-loc="${key}.address" value="${esc(l.address)}"></div>
    <div class="field"><label>Lien Google Maps</label><input data-loc="${key}.mapUrl" value="${esc(l.mapUrl)}" placeholder="https://maps.app.goo.gl/…"></div>
  </div>`;
}

function openEditor(sheet) {
  editDraft = JSON.parse(JSON.stringify(sheet));
  editDraft.crew = editDraft.crew || [];
  editDraft.scenes = editDraft.scenes || [];
  $('#edit-title-h').textContent = sheet._isNew ? 'Nouvelle feuille' : 'Modifier la feuille';
  renderEditorForm();
  $('#edit-backdrop').hidden = false;
  $('#edit-modal').hidden = false;
}

function renderEditorForm() {
  const s = editDraft;
  const f = $('#edit-form');
  f.innerHTML = `
    <div class="form-section-title">En-tête</div>
    ${field('Numéro de feuille', 'sheetNum', s.sheetNum, 'text', 'ex. 2')}
    ${field('Sujet / titre', 'subject', s.subject, 'text', 'PUB - SANTÉ MENTALE…')}
    ${field('Date', 'date', s.date, 'date')}
    <div class="field-row">
      ${field('Jour n°', 'dayNum', s.dayNum, 'number')}
      ${field('sur', 'dayTotal', s.dayTotal, 'number')}
    </div>
    ${field('Épisode (pied de page)', 'episode', s.episode, 'text', 'EP 1')}

    <div class="form-section-title">Horaires</div>
    <div class="field-row">
      ${field('Début journée', 'dayStart', s.dayStart, 'text', '8h')}
      ${field('Fin journée', 'dayEnd', s.dayEnd, 'text', '19h')}
    </div>
    ${field('PAT 1', 'pat1', s.pat1, 'text', '9h - 12h30')}
    ${field('Repas', 'meal', s.meal, 'text', '13h00 - 13h45')}
    ${field('PAT 2', 'pat2', s.pat2, 'text', '13h45')}

    <div class="form-section-title">Éphémérides & météo</div>
    <div class="field-row">
      ${field('Lever soleil', 'sunRise', s.sunRise, 'text', '7h28')}
      ${field('Coucher soleil', 'sunSet', s.sunSet, 'text', '20h21')}
    </div>
    ${field('Météo / °C', 'weather', s.weather, 'text', '11° - 5° 🌤')}

    <div class="form-section-title">Note à l'équipe</div>
    ${field('Note', 'note', s.note, 'textarea', 'Consignes, repas, météo…')}

    <div class="form-section-title">Lieux</div>
    ${locFields('Lieu de tournage', 'locTournage', s.locTournage)}
    ${locFields('Parking', 'locParking', s.locParking)}
    ${locFields('Hôpital le plus proche', 'locHopital', s.locHopital)}
    ${locFields('Police la plus proche', 'locPolice', s.locPolice)}
    ${locFields('Production', 'locProd', s.locProd)}
    <button class="inline-add" id="pick-loc">＋ Importer un lieu depuis le carnet</button>

    <div class="form-section-title">Convocations (équipe)</div>
    <div id="crew-rows"></div>
    <button class="inline-add" id="add-crew-row">＋ Ajouter un membre</button>
    <button class="inline-add" id="pick-crew">＋ Importer depuis le carnet</button>

    <div class="form-section-title">Détails des scènes</div>
    ${field('Synopsis du jour', 'scenesSynopsis', s.scenesSynopsis, 'textarea')}
    <div id="scene-rows"></div>
    <button class="inline-add" id="add-scene-row">＋ Ajouter une scène</button>
  `;
  renderCrewRows();
  renderSceneRows();

  // Bind champs simples
  $$('[data-k]', f).forEach(el => el.addEventListener('input', () => {
    let v = el.value;
    if (el.type === 'number') v = v === '' ? '' : Number(v);
    editDraft[el.dataset.k] = v;
  }));
  // Bind champs lieux
  $$('[data-loc]', f).forEach(el => el.addEventListener('input', () => {
    const [key, sub] = el.dataset.loc.split('.');
    editDraft[key] = editDraft[key] || {};
    editDraft[key][sub] = el.value;
  }));
  $('#add-crew-row').addEventListener('click', () => {
    editDraft.crew.push({ id: uid(), role: '', name: '', phone: '', email: '', call: '', key: false });
    renderCrewRows();
  });
  $('#add-scene-row').addEventListener('click', () => {
    editDraft.scenes.push({ num: '', desc: '', intext: '', decor: '', perso: '', plans: '', duration: '' });
    renderSceneRows();
  });
  $('#pick-crew').addEventListener('click', () => openCrewPicker());
  $('#pick-loc').addEventListener('click', () => openLocPicker());
}

function roleOptions(sel) {
  const uniq = [...new Set(ROLES)];
  return uniq.map(r => `<option ${r === sel ? 'selected' : ''}>${esc(r)}</option>`).join('');
}
function renderCrewRows() {
  const box = $('#crew-rows');
  box.innerHTML = editDraft.crew.map((m, i) => `
    <div class="repeat-item" data-i="${i}">
      <button class="del-row" data-del-crew="${i}">✕</button>
      <div class="field"><label>Poste</label>
        <select data-cm="${i}.role"><option value=""></option>${roleOptions(m.role)}</select></div>
      <div class="field"><label>Nom</label><input data-cm="${i}.name" value="${esc(m.name)}"></div>
      <div class="field-row">
        <div class="field"><label>Téléphone</label><input data-cm="${i}.phone" value="${esc(m.phone)}"></div>
        <div class="field"><label>Convoc.</label><input data-cm="${i}.call" value="${esc(m.call)}" placeholder="8h"></div>
      </div>
      <div class="field"><label>Email (pour l'envoi)</label><input data-cm="${i}.email" type="email" value="${esc(m.email)}"></div>
      <label style="font-size:.82rem;color:var(--text-dim)"><input type="checkbox" data-cm="${i}.key" ${m.key?'checked':''}> Contact clé (en-tête)</label>
    </div>`).join('');
  $$('[data-cm]', box).forEach(el => {
    const [i, sub] = el.dataset.cm.split('.');
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      editDraft.crew[i][sub] = el.type === 'checkbox' ? el.checked : el.value;
    });
  });
  $$('[data-del-crew]', box).forEach(b => b.addEventListener('click', () => {
    editDraft.crew.splice(Number(b.dataset.delCrew), 1); renderCrewRows();
  }));
}
function renderSceneRows() {
  const box = $('#scene-rows');
  box.innerHTML = editDraft.scenes.map((x, i) => `
    <div class="repeat-item" data-i="${i}">
      <button class="del-row" data-del-scene="${i}">✕</button>
      <div class="field-row">
        ${field('Scène n°', '', x.num).replace('data-k=""', `data-sc="${i}.num"`)}
        ${field('INT/EXT', '', x.intext).replace('data-k=""', `data-sc="${i}.intext"`)}
      </div>
      <div class="field"><label>Description</label><textarea data-sc="${i}.desc">${esc(x.desc)}</textarea></div>
      <div class="field-row">
        ${field('Décor', '', x.decor).replace('data-k=""', `data-sc="${i}.decor"`)}
        ${field('Personnages', '', x.perso).replace('data-k=""', `data-sc="${i}.perso"`)}
      </div>
      <div class="field-row">
        ${field('Plans', '', x.plans).replace('data-k=""', `data-sc="${i}.plans"`)}
        ${field('Minutage', '', x.duration).replace('data-k=""', `data-sc="${i}.duration"`)}
      </div>
    </div>`).join('');
  $$('[data-sc]', box).forEach(el => {
    const [i, sub] = el.dataset.sc.split('.');
    el.addEventListener('input', () => { editDraft.scenes[i][sub] = el.value; });
  });
  $$('[data-del-scene]', box).forEach(b => b.addEventListener('click', () => {
    editDraft.scenes.splice(Number(b.dataset.delScene), 1); renderSceneRows();
  }));
}

function closeEditor() {
  $('#edit-backdrop').hidden = true; $('#edit-modal').hidden = true; editDraft = null;
}
async function saveEditor() {
  const s = editDraft; delete s._isNew;
  s.projectId = s.projectId || State.currentProjectId;
  await persist('sheets', s);
  const idx = State.sheets.findIndex(x => x.id === s.id);
  if (idx >= 0) State.sheets[idx] = s; else State.sheets.push(s);
  State.currentSheetId = s.id;
  closeEditor();
  go('preview');
  toast('Feuille enregistrée');
}

/* --- Pickers carnet --- */
let pickerMode = null;
function openCrewPicker() {
  pickerMode = 'crew';
  $('#picker-title-h').textContent = 'Importer depuis le carnet (équipe)';
  $('#picker-list').innerHTML = State.crew.length
    ? State.crew.map(m => `<label class="pick-row">
        <input type="checkbox" value="${m.id}">
        <span class="pick-main"><b>${esc(m.name)}</b><span class="muted small">${esc(m.role||'')} · ${esc(m.phone||'')}</span></span>
      </label>`).join('')
    : '<p class="muted">Carnet vide. Ajoutez des membres dans l\'onglet Carnet.</p>';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
}
function openLocPicker() {
  pickerMode = 'loc';
  $('#picker-title-h').textContent = 'Importer un lieu depuis le carnet';
  $('#picker-list').innerHTML = State.locations.length
    ? State.locations.map(l => `<label class="pick-row">
        <input type="radio" name="locpick" value="${l.id}">
        <span class="pick-main"><b>${esc(l.name)}</b><span class="muted small">${esc(l.kind||'')} · ${esc(l.address||'')}</span></span>
      </label>`).join('')
    : '<p class="muted">Aucun lieu enregistré.</p>';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
}
function closePicker() { $('#picker-backdrop').hidden = true; $('#picker-modal').hidden = true; pickerMode = null; }
function applyPicker() {
  if (pickerMode === 'crew') {
    const ids = $$('#picker-list input:checked').map(i => i.value);
    for (const id of ids) {
      const m = byId(State.crew, id);
      if (m) editDraft.crew.push({ id: uid(), role: m.role, name: m.name, phone: m.phone, email: m.email, call: editDraft.dayStart || '', key: false });
    }
    renderCrewRows();
  } else if (pickerMode === 'loc') {
    const sel = $('#picker-list input:checked');
    if (sel) {
      const l = byId(State.locations, sel.value);
      // mappe le "kind" du lieu vers le bon champ
      const map = { tournage: 'locTournage', parking: 'locParking', hopital: 'locHopital', police: 'locPolice', prod: 'locProd' };
      const key = map[l.kind] || 'locTournage';
      editDraft[key] = { name: l.name, address: l.address, mapUrl: l.mapUrl };
      renderEditorForm();
    }
  }
  closePicker();
}

/* --- Vue Carnet --- */
let carnetTab = 'crew';
function renderCarnet() {
  $$('#carnet-seg button').forEach(b => b.classList.toggle('active', b.dataset.tab === carnetTab));
  $('#carnet-crew').hidden = carnetTab !== 'crew';
  $('#carnet-locations').hidden = carnetTab !== 'locations';
  // équipe
  $('#crew-empty').hidden = State.crew.length > 0;
  $('#crew-list').innerHTML = State.crew.map(m => `
    <div class="card" data-cid="${m.id}">
      <div class="card-main"><div class="card-title">${esc(m.name)}</div>
        <div class="card-sub">${esc(m.role||'')} · ${esc(m.phone||'')}${m.email?' · '+esc(m.email):''}</div></div>
      <div class="card-actions"><button data-edit-crew="${m.id}">✎</button><button data-del-crew="${m.id}">🗑</button></div>
    </div>`).join('');
  // lieux
  $('#loc-empty').hidden = State.locations.length > 0;
  $('#loc-list').innerHTML = State.locations.map(l => `
    <div class="card" data-lid="${l.id}">
      <div class="card-main"><div class="card-title">${esc(l.name)}</div>
        <div class="card-sub">${esc(l.kind||'')} · ${esc(l.address||'')}</div></div>
      <div class="card-actions"><button data-edit-loc="${l.id}">✎</button><button data-del-loc="${l.id}">🗑</button></div>
    </div>`).join('');
  $$('[data-edit-crew]').forEach(b => b.addEventListener('click', () => editCrew(byId(State.crew, b.dataset.editCrew))));
  $$('[data-del-crew]').forEach(b => b.addEventListener('click', async () => {
    await remove('crew', b.dataset.delCrew); State.crew = State.crew.filter(x => x.id !== b.dataset.delCrew); renderCarnet();
  }));
  $$('[data-edit-loc]').forEach(b => b.addEventListener('click', () => editLoc(byId(State.locations, b.dataset.editLoc))));
  $$('[data-del-loc]').forEach(b => b.addEventListener('click', async () => {
    await remove('locations', b.dataset.delLoc); State.locations = State.locations.filter(x => x.id !== b.dataset.delLoc); renderCarnet();
  }));
}

/* --- Mini-modale (membre / lieu) --- */
let miniSave = null;
function openMini(title, bodyHtml, onSave) {
  $('#mini-title-h').textContent = title;
  $('#mini-form').innerHTML = bodyHtml;
  miniSave = onSave;
  $('#mini-backdrop').hidden = false; $('#mini-modal').hidden = false;
}
function closeMini() { $('#mini-backdrop').hidden = true; $('#mini-modal').hidden = true; miniSave = null; }

function editCrew(m) {
  const isNew = !m;
  m = m || { id: uid(), role: '', name: '', phone: '', email: '' };
  openMini(isNew ? 'Nouveau membre' : 'Modifier', `
    <div class="field"><label>Poste</label><select data-m="role"><option value=""></option>${roleOptions(m.role)}</select></div>
    ${field('Nom', 'name', m.name)}
    ${field('Téléphone', 'phone', m.phone)}
    ${field('Email', 'email', m.email, 'email')}
  `.replace(/data-k=/g, 'data-m='), async (form) => {
    const get = k => { const el = $(`[data-m="${k}"]`, form); return el ? el.value : ''; };
    const obj = { ...m, role: get('role'), name: get('name'), phone: get('phone'), email: get('email') };
    if (!obj.name) { toast('Nom requis'); return false; }
    await persist('crew', obj);
    const i = State.crew.findIndex(x => x.id === obj.id);
    if (i >= 0) State.crew[i] = obj; else State.crew.push(obj);
    renderCarnet(); return true;
  });
}
function editLoc(l) {
  const isNew = !l;
  l = l || { id: uid(), name: '', address: '', mapUrl: '', kind: 'tournage' };
  const kinds = ['tournage','parking','hopital','police','prod'];
  openMini(isNew ? 'Nouveau lieu' : 'Modifier', `
    <div class="field"><label>Type</label><select data-m="kind">
      ${kinds.map(k => `<option value="${k}" ${k===l.kind?'selected':''}>${k}</option>`).join('')}</select></div>
    ${field('Nom du lieu', 'name', l.name)}
    ${field('Adresse', 'address', l.address)}
    ${field('Lien Google Maps', 'mapUrl', l.mapUrl)}
  `.replace(/data-k=/g, 'data-m='), async (form) => {
    const get = k => { const el = $(`[data-m="${k}"]`, form); return el ? el.value : ''; };
    const obj = { ...l, kind: get('kind'), name: get('name'), address: get('address'), mapUrl: get('mapUrl') };
    if (!obj.name) { toast('Nom requis'); return false; }
    await persist('locations', obj);
    const i = State.locations.findIndex(x => x.id === obj.id);
    if (i >= 0) State.locations[i] = obj; else State.locations.push(obj);
    renderCarnet(); return true;
  });
}

/* --- Vue Profil --- */
function renderProfile() {
  const u = Cloud.user;
  const av = $('#profile-avatar');
  if (u && u.photoURL) { av.style.backgroundImage = `url(${u.photoURL})`; av.textContent = ''; }
  else { av.style.backgroundImage = ''; av.textContent = (u && u.displayName ? u.displayName[0] : '?').toUpperCase(); }
  $('#profile-name').textContent = u ? (u.displayName || u.email || 'Connecté') : 'Invité (local)';
  $('#profile-meta').textContent = `${State.projects.length} projet(s) · ${State.sheets.length} feuille(s)`;
  $('#profile-stats').innerHTML = `
    <div class="stat-box"><div class="stat-num">${State.projects.length}</div><div class="stat-lbl">Projets</div></div>
    <div class="stat-box"><div class="stat-num">${State.sheets.length}</div><div class="stat-lbl">Feuilles</div></div>
    <div class="stat-box"><div class="stat-num">${State.crew.length}</div><div class="stat-lbl">Carnet</div></div>`;
  $('#set-cloud').textContent = Cloud.configured()
    ? (u ? `Connecté · ${u.email || u.displayName || ''} (déconnexion)` : 'Se connecter (Google/Apple)')
    : 'Sync cloud non configurée';
  $('#set-theme').textContent = 'Thème : ' + (State.settings.theme === 'dark' ? 'Sombre' : 'Clair');
}

/* ============================================================
   8. BOOTSTRAP — câblage événements + démarrage
   ============================================================ */

// Ajout d'un projet (prompt simple)
async function newProject() {
  const name = prompt('Nom du projet (ex. PUB Santé Mentale H2M) :');
  if (!name) return;
  const producers = prompt('Produit par (ex. H2M et RhinoProd) :', State.settings.prodName) || '';
  const p = { id: uid(), name: name.trim(), producers: producers.trim(), created: Date.now() };
  await persist('projects', p); State.projects.push(p);
  openProject(p.id);
  toast('Projet créé');
}

// Nouvelle feuille dans le projet courant
function newSheet() {
  if (!State.currentProjectId) {
    if (!State.projects.length) { toast('Créez d\'abord un projet'); newProject(); return; }
    State.currentProjectId = State.projects[0].id;
  }
  const p = byId(State.projects, State.currentProjectId);
  const last = sheetsOfProject(State.currentProjectId)[0];
  const s = {
    id: uid(), projectId: State.currentProjectId, _isNew: true,
    subject: p ? p.name : '', producers: p ? p.producers : State.settings.prodName,
    sheetNum: '', date: new Date().toISOString().slice(0, 10),
    dayNum: '', dayTotal: '', dayStart: '8h', dayEnd: '19h',
    pat1: '', meal: '', pat2: '', sunRise: '', sunSet: '', weather: '',
    note: '', episode: '',
    // réutilise les lieux/équipe de la dernière feuille du projet (gain de temps)
    locTournage: last?.locTournage, locParking: last?.locParking,
    locHopital: last?.locHopital, locPolice: last?.locPolice, locProd: last?.locProd,
    crew: last ? JSON.parse(JSON.stringify(last.crew || [])).map(m => ({ ...m, id: uid() })) : [],
    scenes: [],
  };
  openEditor(s);
}

// Menu mail nominatif : choisir le destinataire dans l'équipe
function openMailMenu() {
  const s = byId(State.sheets, State.currentSheetId);
  if (!s) return;
  const p = byId(State.projects, s.projectId);
  const withMail = (s.crew || []).filter(m => m.email);
  if (!withMail.length) { toast('Aucun email renseigné dans l\'équipe'); return; }
  $('#picker-title-h').textContent = 'Envoyer la FDS par mail (nominatif)';
  $('#picker-list').innerHTML = withMail.map(m => `
    <button class="pick-row" data-mail="${m.id}" style="width:100%;text-align:left;border:1px solid var(--border)">
      <span class="pick-main"><b>${esc(m.name)}</b><span class="muted small">${esc(m.role||'')} · ${esc(m.email)}</span></span>
      <span>✉️</span>
    </button>`).join('')
    + '<p class="muted small" style="margin-top:10px">Le mail s\'ouvre pré-rempli (objet + message adaptés au poste). Pensez à joindre le PDF exporté avant d\'envoyer.</p>';
  pickerMode = 'mail';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
  $$('[data-mail]').forEach(b => b.addEventListener('click', () => {
    const m = byId(s.crew, b.dataset.mail);
    Mailer.mailToMember(m, s, p);
    closePicker();
  }));
}

function bind() {
  // Tabbar
  $$('#tabbar .tab[data-go]').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.go === 'sheets') { go('projects'); return; } // l'onglet "Feuilles" montre les projets
    go(t.dataset.go);
  }));
  $('#add-tab').addEventListener('click', () => { $('#sheet-backdrop').hidden = false; $('#add-sheet').hidden = false; });

  // Back
  $('#back-btn').addEventListener('click', () => {
    if (State.view === 'preview') go('sheets');
    else if (State.view === 'sheets') go('projects');
  });

  // Bottom sheet d'ajout
  const closeAdd = () => { $('#sheet-backdrop').hidden = true; $('#add-sheet').hidden = true; };
  $('#sheet-backdrop').addEventListener('click', closeAdd);
  $('#act-cancel').addEventListener('click', closeAdd);
  $('#act-new-sheet').addEventListener('click', () => { closeAdd(); newSheet(); });
  $('#act-new-crew').addEventListener('click', () => { closeAdd(); carnetTab = 'crew'; go('carnet'); editCrew(null); });
  $('#act-new-loc').addEventListener('click', () => { closeAdd(); carnetTab = 'locations'; go('carnet'); editLoc(null); });

  // Empty state projets
  document.addEventListener('click', e => {
    if (e.target.dataset.action === 'add') newSheet();
  });

  // Tri
  $('#sort-select').addEventListener('change', () => {
    State.view === 'projects' ? renderProjects() : renderSheets();
  });

  // Carnet onglets
  $$('#carnet-seg button').forEach(b => b.addEventListener('click', () => { carnetTab = b.dataset.tab; renderCarnet(); }));
  $('#add-crew-btn').addEventListener('click', () => editCrew(null));
  $('#add-loc-btn').addEventListener('click', () => editLoc(null));

  // Éditeur
  $('#edit-cancel').addEventListener('click', closeEditor);
  $('#edit-backdrop').addEventListener('click', closeEditor);
  $('#edit-save').addEventListener('click', saveEditor);

  // Mini-modale
  $('#mini-cancel').addEventListener('click', closeMini);
  $('#mini-backdrop').addEventListener('click', closeMini);
  $('#mini-save').addEventListener('click', async () => {
    if (miniSave) { const ok = await miniSave($('#mini-form')); if (ok !== false) closeMini(); }
  });

  // Picker
  $('#picker-cancel').addEventListener('click', closePicker);
  $('#picker-backdrop').addEventListener('click', closePicker);
  $('#picker-done').addEventListener('click', applyPicker);

  // Aperçu : actions
  $('#preview-edit').addEventListener('click', () => {
    const s = byId(State.sheets, State.currentSheetId); if (s) openEditor(s);
  });
  $('#preview-pdf').addEventListener('click', () => {
    const s = byId(State.sheets, State.currentSheetId);
    const p = byId(State.projects, s.projectId);
    // mini-menu PDF / DOC / mail / partage
    showExportMenu(s, p);
  });
  $('#preview-dup').addEventListener('click', async () => {
    const s = byId(State.sheets, State.currentSheetId);
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = uid(); copy.sheetNum = ''; copy.crew = (copy.crew||[]).map(m => ({ ...m, id: uid() }));
    await persist('sheets', copy); State.sheets.push(copy);
    State.currentSheetId = copy.id; renderPreview(); toast('Feuille dupliquée');
  });

  // Profil
  $('#set-theme').addEventListener('click', async () => {
    State.settings.theme = State.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); await Store.setKV('settings', State.settings); renderProfile();
  });
  $('#set-prod').addEventListener('click', async () => {
    const v = prompt('Maison(s) de production par défaut :', State.settings.prodName);
    if (v != null) { State.settings.prodName = v; await Store.setKV('settings', State.settings); toast('Enregistré'); }
  });
  $('#set-logo-left').addEventListener('click', () => pickLogo('logoLeft'));
  $('#set-logo-right').addEventListener('click', () => pickLogo('logoRight'));
  $('#set-export').addEventListener('click', () => Export.toJSON());
  $('#set-import').addEventListener('click', importJSON);
  $('#set-cloud').addEventListener('click', cloudToggle);
  $('#set-wipe').addEventListener('click', async () => {
    if (!confirm('Tout effacer sur cet appareil ? (le cloud n\'est pas touché)')) return;
    await Store.wipeAll(); State.projects = []; State.sheets = []; State.crew = []; State.locations = [];
    go('projects'); toast('Données effacées');
  });

  // Login screen
  $('#login-google-btn').addEventListener('click', () => Cloud.signInGoogle().catch(showLoginErr));
  $('#login-skip-btn').addEventListener('click', () => { $('#login-screen').hidden = true; });
}

function showExportMenu(s, p) {
  $('#picker-title-h').textContent = 'Exporter / Envoyer';
  $('#picker-list').innerHTML = `
    <button class="big-action" id="ex-pdf"><span>📄</span> Exporter en PDF (imprimer)</button>
    <button class="big-action" id="ex-doc"><span>📝</span> Exporter en DOC (Word)</button>
    <button class="big-action" id="ex-mail"><span>✉️</span> Envoyer par mail (nominatif)</button>
    <button class="big-action" id="ex-share"><span>📱</span> Partager (WhatsApp / Messages)</button>`;
  $('#picker-done').style.display = 'none';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
  $('#ex-pdf').addEventListener('click', () => { closePicker2(); Export.toPDF(s, p); });
  $('#ex-doc').addEventListener('click', () => { closePicker2(); Export.toDOC(s, p); });
  $('#ex-mail').addEventListener('click', () => { closePicker2(); openMailMenu(); });
  $('#ex-share').addEventListener('click', () => { closePicker2(); Share.shareSheet(s, p); });
}
function closePicker2() { $('#picker-done').style.display = ''; closePicker(); }

function pickLogo(which) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      State.settings[which] = reader.result;
      await Store.setKV('settings', State.settings);
      toast('Logo enregistré');
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function importJSON() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const d = JSON.parse(r.result);
        for (const name of ['projects','sheets','crew','locations']) {
          if (Array.isArray(d[name])) for (const o of d[name]) { await Store[name].put(o); }
        }
        if (d.settings) { State.settings = { ...State.settings, ...d.settings }; await Store.setKV('settings', State.settings); }
        await loadAll(); applyTheme(); go('projects'); toast('Import réussi');
      } catch (e) { toast('Fichier invalide'); }
    };
    r.readAsText(file);
  };
  inp.click();
}

async function cloudToggle() {
  if (!Cloud.configured()) { alert('Sync cloud non configurée (FIREBASE_CONFIG manquant dans app.js).'); return; }
  if (Cloud.user) {
    if (confirm('Se déconnecter ?')) await Cloud.signOut();
  } else {
    const choix = prompt('Connexion : tape "g" pour Google, "a" pour Apple', 'g');
    try {
      if (choix === 'a') await Cloud.signInApple();
      else await Cloud.signInGoogle();
    } catch (e) { showLoginErr(e); }
  }
}
function showLoginErr(e) {
  const el = $('#login-error'); if (el) { el.textContent = (e && e.message) || 'Erreur de connexion'; el.hidden = false; }
  toast('Échec connexion : ' + ((e && e.code) || ''));
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', State.settings.theme === 'light' ? 'light' : 'dark');
}

async function loadAll() {
  State.projects  = await Store.projects.all();
  State.sheets    = await Store.sheets.all();
  State.crew      = await Store.crew.all();
  State.locations = await Store.locations.all();
  const st = await Store.getKV('settings'); if (st) State.settings = { ...State.settings, ...st };
}

async function start() {
  await Store.init();
  await loadAll();
  applyTheme();
  bind();
  go('projects');

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }

  // Cloud : si configuré, on tente l'auth et on affiche l'écran de login
  if (Cloud.configured()) {
    Cloud.init(async (u) => {
      if (u) {
        $('#login-screen').hidden = true;
        try { await Cloud.pullAll(); await loadAll(); go('projects'); } catch (e) {}
      } else {
        $('#login-screen').hidden = false; // propose Google/Apple
      }
      renderProfile();
    });
  }
}

document.addEventListener('DOMContentLoaded', start);
