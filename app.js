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
  crew: [],             // carnet équipe [{id, name, role, phone, email, diet, notes}]
  locations: [],        // carnet lieux  [{id, label, name, address, mapUrl, kind}]
  productions: [],      // carnet production [{id, name, address, mapUrl, phone, email}]
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

// Catégories de convocation (ordre d'affichage sur la FDS)
const CATEGORIES = ['Production / Réalisation', 'Comédiens', 'HMC', 'Techniciens', 'Autre'];
// À quelle catégorie appartient chaque poste
const ROLE_CATEGORY = {
  'Prod/Réal': 'Production / Réalisation',
  'Prod/Chef op son': 'Production / Réalisation',
  'Directrice de production': 'Production / Réalisation',
  'Régie': 'Production / Réalisation',
  'Comédien·ne': 'Comédiens',
  'Figurant·e': 'Comédiens',
  'MUA': 'HMC',
  'HMC': 'HMC',
  'DOP': 'Techniciens', 'Chef élec': 'Techniciens', 'Élec': 'Techniciens',
  '1er ass. cam': 'Techniciens', '2nd ass. cam': 'Techniciens', 'Cadreur': 'Techniciens',
  'Machiniste': 'Techniciens', 'Ingé son': 'Techniciens', 'Scripte': 'Techniciens',
  'Making of vidéo': 'Techniciens', 'Making of photo': 'Techniciens',
};
function categoryOf(role) {
  return ROLE_CATEGORY[role] || 'Autre';
}

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
  const DB = 'fds', VER = 2;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        for (const s of ['projects', 'sheets', 'crew', 'locations', 'productions'])
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
    projects:    api('projects'),
    sheets:      api('sheets'),
    crew:        api('crew'),
    locations:   api('locations'),
    productions: api('productions'),
    getKV: (k)    => wrap(tx('kv', 'readonly').get(k)).then(r => r && r.v),
    setKV: (k, v) => wrap(tx('kv', 'readwrite').put({ k, v })),
    wipeAll: async () => {
      for (const s of ['projects', 'sheets', 'crew', 'locations', 'productions']) await api(s).clear();
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
      ['productions', State.productions],
    ];
    for (const [name, arr] of batches)
      for (const o of arr) await col(name).doc(o.id).set(o);
  }
  // Tire Firestore -> local (fusion simple : le cloud fait foi)
  async function pullAll() {
    if (!ready || !user) return;
    for (const name of ['projects', 'sheets', 'crew', 'locations', 'productions']) {
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
      crew: State.crew, locations: State.locations, productions: State.productions,
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
    // Pas de logo : cellule vide (pas de texte "LOGO ...") sur la feuille générée
    return `<td class="fds-logo-cell"></td>`;
  }

  function header(s, p) {
    // Logos : priorité au projet, puis surcharge éventuelle de la feuille, puis réglages globaux.
    const logoL = (p && p.logoLeft) || s.logoLeft || State.settings.logoLeft || '';
    const logoR = (p && p.logoRight) || s.logoRight || State.settings.logoRight || '';
    return `
    <table class="fds-header"><tr>
      ${logoCell(logoL, 'GAUCHE')}
      <td class="fds-title-cell">
        <div class="t1">FEUILLE DE SERVICE${s.sheetNum ? ' N°' + esc(s.sheetNum) : ''}</div>
        <div class="t2">${esc(s.subject || (p && p.name) || '')}</div>
        <div class="t3">Produit par ${esc(p && p.producers || State.settings.prodName || '')}</div>
        <div class="t4">${esc(fmtDateLong(s.date))}${s.dayNum ? ' - JOUR ' + esc(s.dayNum) + '/' + esc(s.dayTotal || '') : ''}</div>
      </td>
      ${logoCell(logoR, 'DROITE')}
    </tr></table>`;
  }

  function band(s) {
    // Horaires : liste dynamique. Rétro-compat avec anciennes feuilles (pat1/meal/pat2).
    let sched = s.schedule;
    if (!Array.isArray(sched) || !sched.length) {
      sched = [];
      if (s.pat1) sched.push({ label: 'PAT 1', time: s.pat1 });
      if (s.meal) sched.push({ label: 'Repas', time: s.meal });
      if (s.pat2) sched.push({ label: 'PAT 2', time: s.pat2 });
    }
    sched = sched.filter(x => x && (x.label || x.time));
    // ligne de fin de journée toujours présente
    const rows = sched.concat([{ label: 'Fin de journée', time: s.dayEnd || '' }]);

    // colonne éphémérides/météo répartie sur les lignes
    const ephCells = [
      `<td class="eph">Lever soleil<br><span class="accent">${esc(s.sunRise || '')}</span></td>`,
      `<td class="eph">Coucher soleil<br><span class="accent">${esc(s.sunSet || '')}</span></td>`,
    ];
    const bodyRows = rows.map((row, i) => {
      let extra = '';
      if (i === 0) {
        extra = ephCells[0] + `<td class="eph" rowspan="${rows.length}"><span class="accent" style="font-size:13px">${esc(s.weather || '')}</span></td>`;
      } else if (i === 1) {
        extra = ephCells[1];
      } else if (i === 2) {
        extra = `<td class="eph" colspan="1" rowspan="${Math.max(1, rows.length - 2)}"></td>`;
      }
      const contactCell = i === 0 ? `<td rowspan="${rows.length}" style="font-size:9px">${keyContacts(s)}</td>` : '';
      const lbl = row.note ? `${esc(row.label)} <span style="font-weight:400;font-style:italic">— ${esc(row.note)}</span>` : esc(row.label);
      return `<tr>${contactCell}<td>${lbl}</td><td style="text-align:center">${esc(row.time)}</td>${extra}</tr>`;
    }).join('');

    return `
    <div class="fds-sectionbar">Horaires prévisionnels &nbsp;•&nbsp; ${esc(s.dayStart || '')} - ${esc(s.dayEnd || '')}</div>
    <table class="fds-band">
      <tr>
        <td class="lbl">Contacts clés</td>
        <td class="big" colspan="2">${esc(s.dayStart || '')} - ${esc(s.dayEnd || '')}</td>
        <td class="lbl" style="text-align:center">Éphémérides</td>
        <td class="lbl" style="text-align:center">Météo</td>
      </tr>
      ${bodyRows}
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

  // Récap alimentaire ANONYME pour la régie : agrège les restrictions
  // de l'équipe sans nommer les personnes (ex. "2 végétarien, 1 sans gluten").
  function dietSummary(s) {
    const diets = (s.crew || []).map(m => (m.diet || '').trim()).filter(Boolean);
    if (!diets.length) return '';
    const counts = {};
    for (const d of diets) {
      const key = d.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    }
    const parts = Object.entries(counts)
      .map(([d, n]) => `${n} ${d}`)
      .sort();
    return `
    <div class="fds-sectionbar">Régie — restrictions alimentaires (${diets.length})</div>
    <table><tr><td class="fds-note" style="font-style:normal">${esc(parts.join(' · '))}</td></tr></table>`;
  }

  // Normalise un champ lieu en tableau (rétro-compat : objet unique -> [objet])
  function asLocArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(x => x && (x.name || x.address));
    return (v.name || v.address) ? [v] : [];
  }
  function locCellContent(arr) {
    if (!arr.length) return '';
    return arr.map(l =>
      `${esc(l.name || '')}${l.address ? '<br>' + esc(l.address) : ''}${l.mapUrl ? '<br><a href="' + esc(l.mapUrl) + '">' + esc(l.mapUrl) + '</a>' : ''}`
    ).join('<hr style="border:none;border-top:1px dashed #999;margin:3px 0">');
  }
  function locRowPair(label1, arr1, label2, arr2) {
    if (!arr1.length && !arr2.length) return '';
    return `<tr>
      <td class="lh">${esc(label1)}</td><td>${locCellContent(arr1)}</td>
      ${label2 !== null ? `<td class="lh">${esc(label2)}</td><td>${locCellContent(arr2)}</td>` : '<td class="lh"></td><td></td>'}
    </tr>`;
  }

  function locations(s) {
    const T = asLocArray(s.locTournage), P = asLocArray(s.locParking),
          H = asLocArray(s.locHopital), Po = asLocArray(s.locPolice), Pr = asLocArray(s.locProd);
    let rows = '';
    rows += locRowPair('Lieu de tournage', T, 'Parking', P);
    rows += locRowPair('Hôpital le + proche', H, 'Police la + proche', Po);
    if (Pr.length) rows += locRowPair('Production', Pr, null, []);
    if (!rows) return '';
    return `
    <div class="fds-sectionbar">Lieux</div>
    <table class="fds-loc">${rows}</table>`;
  }

  function convocations(s) {
    const crew = s.crew || [];
    if (!crew.length) return '';
    // Regroupe par catégorie, dans l'ordre défini.
    const byCat = {};
    for (const m of crew) {
      const cat = categoryOf(m.role);
      (byCat[cat] = byCat[cat] || []).push(m);
    }
    const head = `<tr>
      <th style="width:22%">Poste</th>
      <th style="width:26%">Nom Prénom</th>
      <th style="width:18%">Téléphone</th>
      <th style="width:24%">Mail</th>
      <th style="width:10%">RDV</th>
    </tr>`;
    let body = '';
    for (const cat of CATEGORIES) {
      const list = byCat[cat];
      if (!list || !list.length) continue;
      body += `<tr><td colspan="5" class="conv-cat">${esc(cat)}</td></tr>`;
      body += list.map(m => `<tr>
        <td>${esc(m.role || '')}</td>
        <td class="nm">${esc(m.name || '')}</td>
        <td>${esc(m.phone || '')}</td>
        <td style="font-size:8.5px">${esc(m.email || '')}</td>
        <td class="cv">${esc(m.call || s.dayStart || '')}</td>
      </tr>`).join('');
    }
    return `<div class="fds-sectionbar">Convocations</div>
    <table class="fds-conv-rows">${head}${body}</table>`;
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
      <td class="mid">${esc(s.footer || s.episode || '')}</td>
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
      ${dietSummary(s)}
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
  // La vue "projects" et la vue "sheets" partagent le même conteneur HTML
  // (data-view="sheets"). On mappe donc 'projects' -> conteneur 'sheets'.
  const container = (view === 'projects') ? 'sheets' : view;
  $$('#views .view').forEach(v => v.hidden = (v.dataset.view !== container));
  $$('#tabbar .tab[data-go]').forEach(t => t.classList.toggle('active', t.dataset.go === view));

  // Dès qu'on navigue dans l'app, l'écran de login n'a plus lieu d'être affiché.
  const ls = $('#login-screen'); if (ls) ls.hidden = true;

  const titles = {
    projects: 'Mes projets', sheets: State._projName || 'Feuilles',
    carnet: 'Carnet', preview: 'Aperçu', profile: 'Profil',
  };
  $('#topbar-title').textContent = titles[view] || 'FDS';
  const back = $('#back-btn');
  if (back) back.hidden = !(view === 'sheets' || view === 'preview');

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
  // Libellés contextuels (vue projets)
  const topBtn = $('#top-add-btn'); if (topBtn) topBtn.textContent = '＋ Nouveau projet';
  const et = $('#empty-text'); if (et) et.textContent = 'Aucun projet. Crée ton premier projet pour commencer.';
  const eb = $('#sheets-empty button[data-action="add"]'); if (eb) eb.textContent = 'Créer un projet';

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
      <div class="card-actions">
        <button data-edit-proj="${p.id}">✎</button>
        <button data-del-proj="${p.id}">🗑</button>
      </div>
    </div>`;
  }).join('');
  $$('.card[data-pid]', box).forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('[data-del-proj]') || e.target.closest('[data-edit-proj]')) return;
      openProject(c.dataset.pid);
    });
  });
  $$('[data-edit-proj]', box).forEach(b => b.addEventListener('click', () => {
    editProject(byId(State.projects, b.dataset.editProj));
  }));
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
  // Libellés contextuels (vue feuilles d'un projet)
  const topBtn = $('#top-add-btn'); if (topBtn) topBtn.textContent = '＋ Nouvelle feuille de service';
  const et = $('#empty-text'); if (et) et.textContent = 'Aucune feuille dans ce projet.';
  const eb = $('#sheets-empty button[data-action="add"]'); if (eb) eb.textContent = 'Créer une feuille';

  const list = sheetsOfProject(State.currentProjectId);
  const sort = $('#sort-select').value;
  if (sort === 'date') list.reverse();
  $('#sheets-empty').hidden = list.length > 0;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map(s => `
    <div class="card ${s.draft ? 'is-draft' : ''}" data-sid="${s.id}">
      <div class="card-main">
        <div class="card-title">${esc(s.subject || 'Sans titre')}${s.sheetNum ? ' · N°' + esc(s.sheetNum) : ''}</div>
        <div class="card-sub">${esc(fmtDateLong(s.date))}${s.dayNum ? ' — Jour ' + esc(s.dayNum) + '/' + esc(s.dayTotal || '') : ''}</div>
      </div>
      ${s.draft ? '<span class="card-badge draft">brouillon</span>' : `<span class="card-badge ${(s.crew||[]).length ? '' : 'muted'}">${(s.crew||[]).length} pers.</span>`}
      <div class="card-actions"><button data-del-sheet="${s.id}">🗑</button></div>
    </div>`).join('');
  $$('.card[data-sid]', box).forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('[data-del-sheet]')) return;
      const s = byId(State.sheets, c.dataset.sid);
      // un brouillon s'ouvre directement en édition pour le finir
      if (s && s.draft) { State.currentSheetId = s.id; openEditor(s); }
      else openSheet(c.dataset.sid);
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
// État de repli des sections lieux (hôpital/police repliés par défaut)
let locCollapsed = { locHopital: true, locPolice: true };

function field(label, key, val, type = 'text', ph = '') {
  if (type === 'textarea')
    return `<div class="field"><label>${label}</label><textarea data-k="${key}" placeholder="${esc(ph)}">${esc(val||'')}</textarea></div>`;
  return `<div class="field"><label>${label}</label><input data-k="${key}" type="${type}" value="${esc(val||'')}" placeholder="${esc(ph)}"></div>`;
}
// Chaque lieu : nom + adresse (génère le lien Maps auto) + bouton "depuis le carnet"
// filtré par type. `kind` = type pour filtrer le carnet.
// Titres affichés par type de lieu
const LOC_LABELS = {
  locTournage: 'Lieu de tournage', locParking: 'Parking',
  locHopital: 'Hôpital le plus proche', locPolice: 'Police la plus proche',
  locProd: 'Production',
};
// Normalise un champ lieu en tableau dans editDraft (migration objet -> liste)
function ensureLocArray(key) {
  let v = editDraft[key];
  if (!Array.isArray(v)) v = (v && (v.name || v.address)) ? [v] : [];
  editDraft[key] = v;
  return v;
}
function renderAllLocTypes() {
  for (const key of ['locTournage','locParking','locHopital','locPolice','locProd']) {
    renderLocType(key);
  }
}
function renderLocType(key) {
  const wrap = $(`[data-loctype="${key}"]`);
  if (!wrap) return;
  const kind = wrap.dataset.kind;
  const arr = ensureLocArray(key);
  const carnetLabel = kind === 'prod' ? 'Choisir une production du carnet' : 'Choisir dans le carnet';
  const multi = (key !== 'locProd'); // la production reste unique
  // Hôpital et police : sections repliables (repliées par défaut) pour aérer la page.
  const collapsible = (key === 'locHopital' || key === 'locPolice');
  const collapsed = collapsible ? (locCollapsed[key] !== false) : false; // replié par défaut

  // En-tête : titre + (si repliable) bouton déplier/replier + résumé court
  let summary = '';
  if (collapsible && collapsed) {
    const names = arr.map(l => l.name).filter(Boolean);
    summary = names.length ? ` <span class="muted small">— ${esc(names.join(', '))}</span>` : ' <span class="muted small">— non renseigné</span>';
  }
  let html = `<div class="loc-head">
      <div class="form-section-title" style="margin:8px 0;flex:1">${LOC_LABELS[key]}${summary}</div>
      ${collapsible ? `<button class="loc-toggle" data-loc-toggle="${key}">${collapsed ? '▼ Déplier' : '▲ Replier'}</button>` : ''}
    </div>`;

  if (!collapsed) {
    if (!arr.length) {
      html += `<p class="muted small">Aucun ${LOC_LABELS[key].toLowerCase()} pour l'instant.</p>`;
    }
    arr.forEach((l, idx) => {
      html += `<div class="repeat-item">
        ${arr.length > 1 || multi ? `<button class="del-row" data-loc-del="${key}.${idx}">✕</button>` : ''}
        <button class="inline-add" data-loc-pick="${key}.${idx}" data-kind="${kind}" style="margin-bottom:6px">📇 ${carnetLabel}</button>
        <button class="inline-add" data-loc-save="${key}.${idx}" data-kind="${kind}" style="margin-bottom:8px">➕ Enregistrer au carnet</button>
        <div class="field"><label>Nom du lieu</label><input data-locf="${key}.${idx}.name" value="${esc(l.name)}"></div>
        <div class="field"><label>Adresse (lien Maps auto)</label><input data-locf="${key}.${idx}.address" value="${esc(l.address)}"></div>
        <div class="field"><label>Lien Maps (facultatif)</label><input data-locf="${key}.${idx}.mapUrl" value="${esc(l.mapUrl)}" placeholder="vide = généré depuis adresse"></div>
      </div>`;
    });
    if (multi) html += `<button class="inline-add" data-loc-add="${key}" data-kind="${kind}">＋ Ajouter un ${LOC_LABELS[key].toLowerCase()}</button>`;
    else if (!arr.length) html += `<button class="inline-add" data-loc-add="${key}" data-kind="${kind}">＋ Ajouter</button>`;
  }
  wrap.innerHTML = html;

  // bouton déplier/replier
  $$('[data-loc-toggle]', wrap).forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.locToggle;
    locCollapsed[k] = (locCollapsed[k] === false); // bascule
    renderLocType(k);
  }));
  // binds
  $$('[data-locf]', wrap).forEach(el => el.addEventListener('input', () => {
    const [k, idx, sub] = el.dataset.locf.split('.');
    editDraft[k][idx][sub] = el.value;
  }));
  $$('[data-loc-del]', wrap).forEach(b => b.addEventListener('click', () => {
    const [k, idx] = b.dataset.locDel.split('.');
    editDraft[k].splice(Number(idx), 1); renderLocType(k); scheduleAutoSave();
  }));
  $$('[data-loc-add]', wrap).forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.locAdd;
    ensureLocArray(k).push({ name: '', address: '', mapUrl: '' });
    renderLocType(k); scheduleAutoSave();
  }));
  $$('[data-loc-pick]', wrap).forEach(b => b.addEventListener('click', () => {
    const [k, idx] = b.dataset.locPick.split('.');
    openLocPicker(k, b.dataset.kind, Number(idx));
  }));
  $$('[data-loc-save]', wrap).forEach(b => b.addEventListener('click', () => {
    const [k, idx] = b.dataset.locSave.split('.');
    saveLocToCarnet(k, b.dataset.kind, Number(idx));
  }));
}

function openEditor(sheet) {
  editDraft = JSON.parse(JSON.stringify(sheet));
  editDraft.crew = editDraft.crew || [];
  editDraft.scenes = editDraft.scenes || [];
  // Statut brouillon tant que non validé. Pour une feuille déjà existante
  // qu'on ré-édite, on garde son statut actuel (draft éventuellement false).
  if (editDraft._isNew) editDraft.draft = true;
  editDraft.projectId = editDraft.projectId || State.currentProjectId;
  $('#edit-title-h').textContent = sheet._isNew ? 'Nouvelle feuille' : 'Modifier la feuille';
  renderEditorForm();
  $('#edit-backdrop').hidden = false;
  $('#edit-modal').hidden = false;
  // Persiste tout de suite (la feuille apparaît dans la liste en brouillon)
  autoSaveDraft(true);
}

// Sauvegarde automatique du brouillon en cours dans IndexedDB.
// silent=true => pas d'indicateur (ex. à l'ouverture).
let autoSaveTimer = null;
async function autoSaveDraft(silent) {
  if (!editDraft) return;
  const s = JSON.parse(JSON.stringify(editDraft));
  delete s._isNew;
  s.projectId = s.projectId || State.currentProjectId;
  s.updatedAt = Date.now();
  await Store.sheets.put(s);
  const idx = State.sheets.findIndex(x => x.id === s.id);
  if (idx >= 0) State.sheets[idx] = s; else State.sheets.push(s);
  // mémorise l'id du brouillon en cours pour la reprise après coupure
  await Store.setKV('activeDraftId', s.draft ? s.id : '');
  if (!silent) showDraftSaved();
}
// déclenche une sauvegarde différée (anti-spam à chaque frappe)
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => autoSaveDraft(false), 600);
}
function showDraftSaved() {
  let el = $('#draft-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'draft-indicator';
    el.className = 'draft-indicator';
    document.body.appendChild(el);
  }
  el.textContent = '✓ brouillon enregistré';
  el.classList.add('show');
  clearTimeout(showDraftSaved._t);
  showDraftSaved._t = setTimeout(() => el.classList.remove('show'), 1500);
}

function renderEditorForm() {
  const s = editDraft;
  const f = $('#edit-form');
  f.innerHTML = `
    <div class="form-section-title">En-tête</div>
    ${field('Numéro de feuille', 'sheetNum', s.sheetNum, 'text', 'ex. 1')}
    ${field('Sujet / titre', 'subject', s.subject, 'text', '')}
    ${field('Date', 'date', s.date, 'date')}
    <div class="field-row">
      ${field('Jour n°', 'dayNum', s.dayNum, 'number')}
      ${field('sur', 'dayTotal', s.dayTotal, 'number')}
    </div>
    ${field('Pied de page', 'footer', s.footer, 'text', 'ex. Épisode 1')}

    <div class="form-section-title">Horaires</div>
    <div class="field-row">
      ${field('Début journée', 'dayStart', s.dayStart, 'text', '8h')}
      ${field('Fin journée', 'dayEnd', s.dayEnd, 'text', '19h')}
    </div>
    <div id="schedule-rows"></div>
    <button class="inline-add" id="add-sched-row">＋ Ajouter un PAT / repas</button>

    <div class="form-section-title">Lieux</div>
    <div id="loc-tournage" data-loctype="locTournage" data-kind="tournage"></div>
    <div id="loc-parking" data-loctype="locParking" data-kind="parking"></div>
    <div id="loc-hopital" data-loctype="locHopital" data-kind="hopital"></div>
    <div id="loc-police" data-loctype="locPolice" data-kind="police"></div>
    <div id="loc-prod" data-loctype="locProd" data-kind="prod"></div>

    <div class="form-section-title">Éphémérides & météo</div>
    <p class="muted small">Renseigne d'abord l'adresse du lieu de tournage ci-dessus, puis clique pour remplir automatiquement.</p>
    <button class="inline-add" id="autofill-weather" style="margin-bottom:8px">🌤️ Remplir auto (soleil + météo selon le lieu de tournage et la date)</button>
    <div class="field-row">
      ${field('Lever soleil', 'sunRise', s.sunRise, 'text', '7h28')}
      ${field('Coucher soleil', 'sunSet', s.sunSet, 'text', '20h21')}
    </div>
    ${field('Météo / °C', 'weather', s.weather, 'text', '11° - 5°')}

    <div class="form-section-title">Note à l'équipe</div>
    ${field('Note', 'note', s.note, 'textarea', '')}

    <div class="form-section-title">Convocations (équipe)</div>
    <div id="crew-rows"></div>
    <button class="inline-add" id="add-crew-row">＋ Ajouter un membre (saisie directe)</button>
    <button class="inline-add" id="pick-crew">📇 Importer depuis le carnet</button>
    <button class="inline-add" id="new-crew-carnet">➕ Créer un membre au carnet (et l'ajouter ici)</button>

    <div class="form-section-title">Détails des scènes</div>
    ${field('Synopsis du jour', 'scenesSynopsis', s.scenesSynopsis, 'textarea')}
    <div id="scene-rows"></div>
    <button class="inline-add" id="add-scene-row">＋ Ajouter une scène</button>
  `;
  renderScheduleRows();
  renderAllLocTypes();
  renderCrewRows();
  renderSceneRows();

  // Sauvegarde auto : tout input/change dans l'éditeur déclenche une sauvegarde différée.
  f.addEventListener('input', scheduleAutoSave);
  f.addEventListener('change', scheduleAutoSave);

  // Bind champs simples
  $$('[data-k]', f).forEach(el => el.addEventListener('input', () => {
    let v = el.value;
    if (el.type === 'number') v = v === '' ? '' : Number(v);
    editDraft[el.dataset.k] = v;
  }));
  // Bouton "Remplir auto" éphémérides + météo
  $('#autofill-weather').addEventListener('click', autofillWeather);
  $('#add-sched-row').addEventListener('click', () => {
    editDraft.schedule = editDraft.schedule || [];
    editDraft.schedule.push({ label: '', time: '' });
    renderScheduleRows();
  });
  $('#add-crew-row').addEventListener('click', () => {
    editDraft.crew.push({ id: uid(), role: '', name: '', phone: '', email: '', call: '', key: false });
    renderCrewRows();
  });
  $('#add-scene-row').addEventListener('click', () => {
    editDraft.scenes.push({ num: '', desc: '', intext: '', decor: '', perso: '', plans: '', duration: '' });
    renderSceneRows();
  });
  $('#pick-crew').addEventListener('click', () => openCrewPicker());
  // Créer un membre au carnet ET l'ajouter à la feuille en cours
  $('#new-crew-carnet').addEventListener('click', () => {
    editCrew(null, (saved) => {
      editDraft.crew.push({ id: uid(), role: saved.role, name: saved.name, phone: saved.phone,
        email: saved.email, diet: saved.diet || '', notes: saved.notes || '',
        call: editDraft.dayStart || '', key: false });
      renderCrewRows();
    });
  });
}

// Enregistre le lieu saisi dans la feuille vers le carnet Lieux (ou Production).
async function saveLocToCarnet(key, kind, idx) {
  const arr = ensureLocArray(key);
  const l = arr[idx || 0];
  if (!l || !l.name) { toast('Renseigne au moins le nom du lieu'); return; }
  const mapUrl = (l.mapUrl || '').trim() || mapUrlFromAddress(l.address || '');
  if (kind === 'prod') {
    const obj = { id: uid(), name: l.name, address: l.address || '', mapUrl, phone: '', email: '' };
    await persist('productions', obj); State.productions.push(obj);
    toast('Production ajoutée au carnet');
  } else {
    const obj = { id: uid(), name: l.name, address: l.address || '', mapUrl, kind: kind || 'tournage' };
    await persist('locations', obj); State.locations.push(obj);
    toast('Lieu ajouté au carnet');
  }
}

// Lignes d'horaires dynamiques (PAT, repas, etc.)
function renderScheduleRows() {
  const box = $('#schedule-rows');
  if (!box) return;
  editDraft.schedule = editDraft.schedule || [];
  box.innerHTML = editDraft.schedule.map((row, i) => `
    <div class="repeat-item" data-i="${i}">
      <button class="del-row" data-del-sched="${i}">✕</button>
      <div class="field-row">
        <div class="field"><label>Intitulé</label><input data-sch="${i}.label" value="${esc(row.label)}" placeholder="PAT 1 / Repas / PAT 2…"></div>
        <div class="field"><label>Horaire</label><input data-sch="${i}.time" value="${esc(row.time)}" placeholder="9h - 12h30"></div>
      </div>
      <div class="field"><label>Commentaire (n° / nom de scène…)</label><input data-sch="${i}.note" value="${esc(row.note)}" placeholder="ex. Scène 4 - intérieur voiture"></div>
    </div>`).join('');
  $$('[data-sch]', box).forEach(el => {
    const [i, sub] = el.dataset.sch.split('.');
    el.addEventListener('input', () => { editDraft.schedule[i][sub] = el.value; });
  });
  $$('[data-del-sched]', box).forEach(b => b.addEventListener('click', () => {
    editDraft.schedule.splice(Number(b.dataset.delSched), 1); renderScheduleRows();
  }));
}

function roleOptions(sel) {
  const uniq = [...new Set(ROLES)];
  // si le poste enregistré n'est pas dans la liste standard, c'est un poste "Autre"
  const isCustom = sel && !uniq.includes(sel);
  return uniq.map(r => `<option ${r === sel ? 'selected' : ''}>${esc(r)}</option>`).join('')
    + `<option value="__autre__" ${isCustom ? 'selected' : ''}>Autre…</option>`;
}
// True si le poste est un poste personnalisé (hors liste standard)
function isCustomRole(role) {
  return role && ![...new Set(ROLES)].includes(role);
}

function renderCrewRows() {
  const box = $('#crew-rows');
  box.innerHTML = editDraft.crew.map((m, i) => {
    const custom = isCustomRole(m.role);
    return `
    <div class="repeat-item" data-i="${i}">
      <button class="del-row" data-del-crew="${i}">✕</button>
      <div class="field"><label>Poste</label>
        <select data-role-sel="${i}"><option value=""></option>${roleOptions(m.role)}</select></div>
      <div class="field" data-role-custom="${i}" ${custom ? '' : 'hidden'}>
        <label>Poste personnalisé</label>
        <input data-role-input="${i}" value="${custom ? esc(m.role) : ''}" placeholder="Saisir le poste">
      </div>
      <div class="field"><label>Nom Prénom</label><input data-cm="${i}.name" value="${esc(m.name)}"></div>
      <div class="field-row">
        <div class="field"><label>Téléphone</label><input data-cm="${i}.phone" value="${esc(m.phone)}"></div>
        <div class="field"><label>Convoc.</label><input data-cm="${i}.call" value="${esc(m.call)}" placeholder="8h"></div>
      </div>
      <div class="field"><label>Email (pour l'envoi)</label><input data-cm="${i}.email" type="email" value="${esc(m.email)}"></div>
      <label style="font-size:.82rem;color:var(--text-dim)"><input type="checkbox" data-cm="${i}.key" ${m.key?'checked':''}> Contact clé (en-tête)</label>
    </div>`;
  }).join('');
  // champs simples
  $$('[data-cm]', box).forEach(el => {
    const [i, sub] = el.dataset.cm.split('.');
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      editDraft.crew[i][sub] = el.type === 'checkbox' ? el.checked : el.value;
    });
  });
  // select de poste : gère "Autre…"
  $$('[data-role-sel]', box).forEach(sel => {
    const i = sel.dataset.roleSel;
    sel.addEventListener('change', () => {
      if (sel.value === '__autre__') {
        $(`[data-role-custom="${i}"]`, box).hidden = false;
        editDraft.crew[i].role = $(`[data-role-input="${i}"]`, box).value || '';
        $(`[data-role-input="${i}"]`, box).focus();
      } else {
        $(`[data-role-custom="${i}"]`, box).hidden = true;
        editDraft.crew[i].role = sel.value;
      }
    });
  });
  $$('[data-role-input]', box).forEach(inp => {
    const i = inp.dataset.roleInput;
    inp.addEventListener('input', () => { editDraft.crew[i].role = inp.value; });
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
        ${field('Plans', '', x.plans).replace('data-k=""', `data-sc="${i}.plans"`)}
      </div>
      <div class="field"><label>Description</label><textarea data-sc="${i}.desc">${esc(x.desc)}</textarea></div>
      <div class="field-row">
        ${field('INT/EXT', '', x.intext).replace('data-k=""', `data-sc="${i}.intext"`)}
        ${field('Décor', '', x.decor).replace('data-k=""', `data-sc="${i}.decor"`)}
      </div>
      <div class="field-row">
        ${field('Personnages', '', x.perso).replace('data-k=""', `data-sc="${i}.perso"`)}
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
  clearTimeout(autoSaveTimer);
  // On NE supprime PAS le brouillon : il reste dans la liste (statut brouillon)
  // et pourra être repris. On ferme juste la fenêtre.
  $('#edit-backdrop').hidden = true; $('#edit-modal').hidden = true; editDraft = null;
  if (State.view === 'sheets') renderSheets();
}
async function saveEditor() {
  clearTimeout(autoSaveTimer);
  const s = editDraft; delete s._isNew;
  s.projectId = s.projectId || State.currentProjectId;
  s.draft = false; // validée -> ce n'est plus un brouillon
  // Pour chaque lieu (liste) : si pas de lien Maps mais une adresse, générer le lien.
  for (const key of ['locTournage','locParking','locHopital','locPolice','locProd']) {
    let arr = s[key];
    if (!Array.isArray(arr)) arr = (arr && (arr.name || arr.address)) ? [arr] : [];
    arr.forEach(l => {
      if (l && l.address && !((l.mapUrl || '').trim())) l.mapUrl = mapUrlFromAddress(l.address);
    });
    s[key] = arr;
  }
  await persist('sheets', s);
  const idx = State.sheets.findIndex(x => x.id === s.id);
  if (idx >= 0) State.sheets[idx] = s; else State.sheets.push(s);
  State.currentSheetId = s.id;
  await Store.setKV('activeDraftId', ''); // plus de brouillon actif
  editDraft = null;
  $('#edit-backdrop').hidden = true; $('#edit-modal').hidden = true;
  go('preview');
  toast('Feuille enregistrée');
}

/* --- Pickers carnet --- */
let pickerMode = null;
let pickerLocTarget = null; // champ lieu visé (ex. 'locHopital')

function updatePickCount() {
  const n = $$('#picker-list input:checked').length;
  const el = $('#pick-count');
  if (el) el.textContent = n ? `${n} sélectionné${n > 1 ? 's' : ''}` : 'Aucun sélectionné';
  const all = $('#pick-all');
  if (all) {
    const total = $$('#picker-list input[type="checkbox"]').length;
    all.textContent = (n >= total && total > 0) ? 'Tout désélectionner' : 'Tout sélectionner';
  }
}

function openCrewPicker() {
  pickerMode = 'crew';
  $('#picker-title-h').textContent = 'Importer depuis le carnet';
  if (!State.crew.length) {
    $('#picker-list').innerHTML = '<p class="muted">Carnet vide. Ajoutez des membres dans l\'onglet Carnet.</p>';
  } else {
    $('#picker-list').innerHTML = `
      <div class="pick-toolbar">
        <button class="btn-ghost" id="pick-all">Tout sélectionner</button>
        <span class="muted small" id="pick-count">Aucun sélectionné</span>
      </div>` +
      State.crew.map(m => `<label class="pick-row">
        <input type="checkbox" value="${m.id}">
        <span class="pick-main"><b>${esc(m.name)}</b><span class="muted small">${esc(m.role||'')}${m.phone?' · '+esc(m.phone):''}</span></span>
      </label>`).join('');
    // ligne cliquable -> coche, et maj compteur
    $$('#picker-list input[type="checkbox"]').forEach(c =>
      c.addEventListener('change', updatePickCount));
    const all = $('#pick-all');
    all.addEventListener('click', () => {
      const boxes = $$('#picker-list input[type="checkbox"]');
      const check = boxes.some(b => !b.checked);
      boxes.forEach(b => b.checked = check);
      updatePickCount();
    });
    updatePickCount();
  }
  $('#picker-done').style.display = '';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
}

// Picker lieu : target = champ (ex. 'locHopital'), kind = type, idx = index dans la liste.
let pickerLocIdx = 0;
function openLocPicker(target, kind, idx) {
  pickerLocTarget = target || 'locTournage';
  pickerLocIdx = idx || 0;
  // Cas spécial : la Production se choisit dans le carnet "productions"
  if (kind === 'prod') {
    pickerMode = 'prod';
    $('#picker-title-h').textContent = 'Choisir une production';
    const row = pr => `<label class="pick-row">
        <input type="radio" name="locpick" value="${pr.id}">
        <span class="pick-main"><b>${esc(pr.name)}</b><span class="muted small">${esc(pr.address||'')}</span></span>
      </label>`;
    $('#picker-list').innerHTML = State.productions.length
      ? State.productions.map(row).join('')
      : '<p class="muted">Aucune production dans le carnet. Ajoutez-en dans Carnet → Production.</p>';
    $('#picker-done').style.display = '';
    $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
    return;
  }
  pickerMode = 'loc';
  const labels = { tournage:'lieu de tournage', parking:'parking', hopital:'hôpital', police:'police' };
  $('#picker-title-h').textContent = `Choisir un ${labels[kind] || 'lieu'}`;
  const matching = State.locations.filter(l => l.kind === kind);
  const others = State.locations.filter(l => l.kind !== kind);
  const row = l => `<label class="pick-row">
      <input type="radio" name="locpick" value="${l.id}">
      <span class="pick-main"><b>${esc(l.name)}</b><span class="muted small">${esc(l.kind||'')}${l.address?' · '+esc(l.address):''}</span></span>
    </label>`;
  let html = '';
  if (matching.length) html += matching.map(row).join('');
  else html += '<p class="muted small">Aucun lieu de ce type dans le carnet.</p>';
  if (others.length) html += `<p class="muted small" style="margin-top:10px">Autres lieux :</p>` + others.map(row).join('');
  if (!State.locations.length) html = '<p class="muted">Aucun lieu enregistré. Ajoutez-en dans le Carnet → Lieux.</p>';
  $('#picker-list').innerHTML = html;
  $('#picker-done').style.display = '';
  $('#picker-backdrop').hidden = false; $('#picker-modal').hidden = false;
}

function closePicker() {
  $('#picker-backdrop').hidden = true; $('#picker-modal').hidden = true;
  pickerMode = null; pickerLocTarget = null;
}
function applyPicker() {
  if (pickerMode === 'crew') {
    const ids = $$('#picker-list input:checked').map(i => i.value);
    for (const id of ids) {
      const m = byId(State.crew, id);
      if (m) editDraft.crew.push({ id: uid(), role: m.role, name: m.name, phone: m.phone, email: m.email, diet: m.diet || '', notes: m.notes || '', call: editDraft.dayStart || '', key: false });
    }
    renderCrewRows();
  } else if (pickerMode === 'loc' || pickerMode === 'prod') {
    const sel = $('#picker-list input:checked');
    if (sel) {
      const src = pickerMode === 'prod'
        ? byId(State.productions, sel.value) : byId(State.locations, sel.value);
      const arr = ensureLocArray(pickerLocTarget);
      arr[pickerLocIdx] = { name: src.name, address: src.address, mapUrl: src.mapUrl };
      renderLocType(pickerLocTarget);
      scheduleAutoSave();
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
  $('#carnet-prod').hidden = carnetTab !== 'prod';
  // équipe
  $('#crew-empty').hidden = State.crew.length > 0;
  $('#crew-list').innerHTML = State.crew.map(m => `
    <div class="card" data-cid="${m.id}">
      <div class="card-main"><div class="card-title">${esc(m.name)}</div>
        <div class="card-sub">${esc(m.role||'')}${m.phone?' · '+esc(m.phone):''}${m.email?' · '+esc(m.email):''}</div>
        ${m.diet ? `<div class="card-sub">🍽️ ${esc(m.diet)}</div>` : ''}
        ${m.notes ? `<div class="card-sub">📝 ${esc(m.notes)}</div>` : ''}
      </div>
      <div class="card-actions"><button data-edit-crew="${m.id}">✎</button><button data-del-crew="${m.id}">🗑</button></div>
    </div>`).join('');
  // lieux
  $('#loc-empty').hidden = State.locations.length > 0;
  $('#loc-list').innerHTML = State.locations.map(l => `
    <div class="card" data-lid="${l.id}">
      <div class="card-main"><div class="card-title">${esc(l.name)}</div>
        <div class="card-sub">${esc(l.kind||'')}${l.address?' · '+esc(l.address):''}</div>
        ${l.mapUrl ? `<div class="card-sub"><a href="${esc(l.mapUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">📍 Ouvrir dans Maps</a></div>` : ''}
      </div>
      <div class="card-actions"><button data-edit-loc="${l.id}">✎</button><button data-del-loc="${l.id}">🗑</button></div>
    </div>`).join('');
  // production
  $('#prod-empty').hidden = State.productions.length > 0;
  $('#prod-list').innerHTML = State.productions.map(pr => `
    <div class="card" data-prid="${pr.id}">
      <div class="card-main"><div class="card-title">${esc(pr.name)}</div>
        ${pr.address?`<div class="card-sub">${esc(pr.address)}</div>`:''}
        <div class="card-sub">${pr.phone?'📞 '+esc(pr.phone):''}${pr.email?(pr.phone?' · ':'')+'✉️ '+esc(pr.email):''}</div>
        ${pr.mapUrl ? `<div class="card-sub"><a href="${esc(pr.mapUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">📍 Ouvrir dans Maps</a></div>` : ''}
      </div>
      <div class="card-actions"><button data-edit-prod="${pr.id}">✎</button><button data-del-prod="${pr.id}">🗑</button></div>
    </div>`).join('');
  $$('[data-edit-crew]').forEach(b => b.addEventListener('click', () => editCrew(byId(State.crew, b.dataset.editCrew))));
  $$('[data-del-crew]').forEach(b => b.addEventListener('click', async () => {
    await remove('crew', b.dataset.delCrew); State.crew = State.crew.filter(x => x.id !== b.dataset.delCrew); renderCarnet();
  }));
  $$('[data-edit-loc]').forEach(b => b.addEventListener('click', () => editLoc(byId(State.locations, b.dataset.editLoc))));
  $$('[data-del-loc]').forEach(b => b.addEventListener('click', async () => {
    await remove('locations', b.dataset.delLoc); State.locations = State.locations.filter(x => x.id !== b.dataset.delLoc); renderCarnet();
  }));
  $$('[data-edit-prod]').forEach(b => b.addEventListener('click', () => editProd(byId(State.productions, b.dataset.editProd))));
  $$('[data-del-prod]').forEach(b => b.addEventListener('click', async () => {
    await remove('productions', b.dataset.delProd); State.productions = State.productions.filter(x => x.id !== b.dataset.delProd); renderCarnet();
  }));
}

function editProd(pr) {
  const isNew = !pr;
  pr = pr || { id: uid(), name: '', address: '', mapUrl: '', phone: '', email: '' };
  openMini(isNew ? 'Nouvelle production' : 'Modifier', `
    ${field('Nom de la production', 'name', pr.name)}
    ${field('Adresse', 'address', pr.address, 'text', '')}
    ${field('Téléphone', 'phone', pr.phone)}
    ${field('Email', 'email', pr.email, 'email')}
    <p class="muted small">Le lien Google Maps est généré automatiquement depuis l'adresse.</p>
  `.replace(/data-k=/g, 'data-m='), async (form) => {
    const get = k => { const el = $(`[data-m="${k}"]`, form); return el ? el.value : ''; };
    const address = get('address');
    const obj = { ...pr, name: get('name'), address, phone: get('phone'), email: get('email'),
      mapUrl: address ? mapUrlFromAddress(address) : '' };
    if (!obj.name) { toast('Nom requis'); return false; }
    await persist('productions', obj);
    const i = State.productions.findIndex(x => x.id === obj.id);
    if (i >= 0) State.productions[i] = obj; else State.productions.push(obj);
    renderCarnet(); return true;
  });
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

function editCrew(m, onSaved) {
  const isNew = !m;
  m = m || { id: uid(), role: '', name: '', phone: '', email: '', diet: '', notes: '' };
  const custom = isCustomRole(m.role);
  openMini(isNew ? 'Nouveau membre' : 'Modifier', `
    <button class="inline-add" id="mini-from-contacts">📱 Importer depuis mes contacts</button>
    <div class="field"><label>Poste</label><select data-m="role"><option value=""></option>${roleOptions(m.role)}</select></div>
    <div class="field" id="mini-role-custom" ${custom ? '' : 'hidden'}>
      <label>Poste personnalisé</label>
      <input data-m="roleCustom" value="${custom ? esc(m.role) : ''}" placeholder="Saisir le poste">
    </div>
    ${field('Nom Prénom', 'name', m.name, 'text', 'ex. GANTIÉ Julien')}
    ${field('Téléphone', 'phone', m.phone)}
    ${field('Email', 'email', m.email, 'email')}
    ${field('Restrictions alimentaires', 'diet', m.diet, 'text', 'ex. végétarien, sans gluten, allergie arachides')}
    ${field('Commentaire', 'notes', m.notes, 'textarea', 'Note libre sur ce membre')}
  `.replace(/data-k=/g, 'data-m='), async (form) => {
    const get = k => { const el = $(`[data-m="${k}"]`, form); return el ? el.value : ''; };
    let role = get('role');
    if (role === '__autre__') role = get('roleCustom');
    const obj = { ...m, role, name: get('name'), phone: get('phone'), email: get('email'), diet: get('diet'), notes: get('notes') };
    if (!obj.name) { toast('Nom requis'); return false; }
    await persist('crew', obj);
    const i = State.crew.findIndex(x => x.id === obj.id);
    if (i >= 0) State.crew[i] = obj; else State.crew.push(obj);
    renderCarnet();
    if (typeof onSaved === 'function') onSaved(obj);
    return true;
  });
  // gestion "Autre…" dans la mini-modale
  const sel = $('[data-m="role"]', $('#mini-form'));
  if (sel) sel.addEventListener('change', () => {
    $('#mini-role-custom').hidden = (sel.value !== '__autre__');
  });
  // bouton contacts
  const cbtn = $('#mini-from-contacts');
  if (cbtn) cbtn.addEventListener('click', importFromContacts);
}

// Import depuis le carnet de contacts du téléphone.
// API Contact Picker : Android/Chrome uniquement. iOS Safari ne la supporte pas.
async function importFromContacts() {
  if (!('contacts' in navigator) || !navigator.contacts || !navigator.contacts.select) {
    toast('Non disponible sur cet appareil (iPhone en web). Sera possible dans l\'app native.');
    return;
  }
  try {
    const props = ['name', 'tel', 'email'];
    const contacts = await navigator.contacts.select(props, { multiple: false });
    if (!contacts || !contacts.length) return;
    const c = contacts[0];
    const nameEl = $('[data-m="name"]', $('#mini-form'));
    const telEl = $('[data-m="phone"]', $('#mini-form'));
    const mailEl = $('[data-m="email"]', $('#mini-form'));
    if (nameEl && c.name && c.name.length) nameEl.value = c.name[0];
    if (telEl && c.tel && c.tel.length) telEl.value = c.tel[0];
    if (mailEl && c.email && c.email.length) mailEl.value = c.email[0];
    toast('Contact importé');
  } catch (e) {
    toast('Import annulé');
  }
}

// Génère un lien Google Maps de recherche à partir d'une adresse (gratuit, sans clé API).
function mapUrlFromAddress(addr) {
  if (!addr || !addr.trim()) return '';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr.trim());
}

// Remplissage auto éphémérides + météo via API gratuites (sans clé) :
// 1) géocodage de l'adresse du 1er lieu de tournage (Nominatim / OpenStreetMap)
// 2) lever/coucher du soleil (Open-Meteo daily)
// 3) météo prévue à la date (Open-Meteo)
async function autofillWeather() {
  const btn = $('#autofill-weather');
  const arr = ensureLocArray('locTournage');
  const addr = (arr[0] && arr[0].address || '').trim();
  if (!addr) { toast('Renseigne d\'abord l\'adresse du lieu de tournage'); return; }
  const date = editDraft.date;
  if (!date) { toast('Renseigne d\'abord la date'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Récupération en cours…'; }
  try {
    // 1) géocodage
    const geoUrl = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(addr);
    const geoRes = await fetch(geoUrl, { headers: { 'Accept': 'application/json' } });
    const geo = await geoRes.json();
    if (!geo || !geo.length) { toast('Adresse introuvable. Vérifie l\'adresse du lieu de tournage.'); return; }
    const lat = parseFloat(geo[0].lat), lon = parseFloat(geo[0].lon);

    // 2+3) Open-Meteo : soleil + météo du jour, fuseau auto
    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weathercode`
      + `&timezone=auto&start_date=${date}&end_date=${date}`;
    const wRes = await fetch(wUrl);
    const w = await wRes.json();
    if (!w || !w.daily || !w.daily.time || !w.daily.time.length) {
      toast('Météo indisponible pour cette date (trop loin ?). Soleil seul récupéré si possible.');
    }
    const d = w.daily;
    const hhmm = iso => { const t = iso.split('T')[1] || ''; return t.slice(0,5).replace(':','h'); };
    if (d && d.sunrise) editDraft.sunRise = hhmm(d.sunrise[0]);
    if (d && d.sunset)  editDraft.sunSet  = hhmm(d.sunset[0]);
    if (d && d.temperature_2m_max != null) {
      const tmax = Math.round(d.temperature_2m_max[0]);
      const tmin = Math.round(d.temperature_2m_min[0]);
      const desc = weatherCodeToText(d.weathercode ? d.weathercode[0] : null);
      editDraft.weather = `${tmax}° / ${tmin}°${desc ? ' ' + desc : ''}`;
    }
    // rafraîchit les champs concernés
    const sr = $('[data-k="sunRise"]'); if (sr) sr.value = editDraft.sunRise || '';
    const ss = $('[data-k="sunSet"]'); if (ss) ss.value = editDraft.sunSet || '';
    const we = $('[data-k="weather"]'); if (we) we.value = editDraft.weather || '';
    scheduleAutoSave();
    toast('Éphémérides et météo remplies');
  } catch (e) {
    toast('Échec de la récupération (réseau ?). Tu peux remplir à la main.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌤️ Remplir auto (soleil + météo selon le lieu de tournage et la date)'; }
  }
}
// Traduit le code météo Open-Meteo (WMO) en court texte + emoji
function weatherCodeToText(code) {
  if (code == null) return '';
  const m = {
    0:'☀️ ciel clair', 1:'🌤️ peu nuageux', 2:'⛅ nuageux', 3:'☁️ couvert',
    45:'🌫️ brouillard', 48:'🌫️ brouillard givrant',
    51:'🌦️ bruine', 53:'🌦️ bruine', 55:'🌦️ bruine',
    61:'🌧️ pluie', 63:'🌧️ pluie', 65:'🌧️ forte pluie',
    71:'🌨️ neige', 73:'🌨️ neige', 75:'❄️ forte neige',
    80:'🌦️ averses', 81:'🌧️ averses', 82:'⛈️ fortes averses',
    95:'⛈️ orage', 96:'⛈️ orage grêle', 99:'⛈️ orage grêle',
  };
  return m[code] || '';
}

function editLoc(l) {
  const isNew = !l;
  l = l || { id: uid(), name: '', address: '', mapUrl: '', kind: 'tournage' };
  const kinds = ['tournage','parking','hopital','police','prod'];
  openMini(isNew ? 'Nouveau lieu' : 'Modifier', `
    <div class="field"><label>Type</label><select data-m="kind">
      ${kinds.map(k => `<option value="${k}" ${k===l.kind?'selected':''}>${k}</option>`).join('')}</select></div>
    ${field('Nom du lieu', 'name', l.name)}
    ${field('Adresse', 'address', l.address, 'text', 'ex. Rte de Caussols, 06460 Saint-Vallier-de-Thiey')}
    <p class="muted small">Le lien Google Maps est généré automatiquement depuis l'adresse. Tu peux aussi coller un lien précis ci-dessous (facultatif).</p>
    ${field('Lien Google Maps (facultatif)', 'mapUrl', l.mapUrl, 'text', 'vide = généré depuis adresse')}
  `.replace(/data-k=/g, 'data-m='), async (form) => {
    const get = k => { const el = $(`[data-m="${k}"]`, form); return el ? el.value : ''; };
    const address = get('address');
    let mapUrl = get('mapUrl').trim();
    // Si pas de lien fourni, on le génère depuis l'adresse
    if (!mapUrl) mapUrl = mapUrlFromAddress(address);
    const obj = { ...l, kind: get('kind'), name: get('name'), address, mapUrl };
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

// Création/édition d'un projet via une vraie fenêtre (champs séparés)
function newProject() { editProject(null); }

let projDraft = null; // logos temporaires pendant l'édition du projet
function editProject(p) {
  const isNew = !p;
  p = p || { id: uid(), name: '', producers: '', logoLeft: '', logoRight: '', created: Date.now() };
  projDraft = { logoLeft: p.logoLeft || '', logoRight: p.logoRight || '' };
  openMini(isNew ? 'Nouveau projet' : 'Modifier le projet', `
    <div class="field"><label>Nom du projet</label>
      <input data-p="name" value="${esc(p.name)}" placeholder=""></div>
    <div class="field"><label>Produit par (maison de production)</label>
      <input data-p="producers" value="${esc(p.producers)}" placeholder=""></div>
    <div class="form-section-title">Logos (facultatifs)</div>
    <p class="muted small">Affichés en en-tête de chaque feuille du projet. Gauche et/ou droite.</p>
    <div class="logo-pick" id="logo-left-wrap">${logoPickHtml('left', projDraft.logoLeft, 'Logo gauche')}</div>
    <div class="logo-pick" id="logo-right-wrap">${logoPickHtml('right', projDraft.logoRight, 'Logo droit')}</div>
  `, async (form) => {
    const get = k => { const el = $(`[data-p="${k}"]`, form); return el ? el.value.trim() : ''; };
    const obj = { ...p, name: get('name'), producers: get('producers'),
      logoLeft: projDraft.logoLeft || '', logoRight: projDraft.logoRight || '' };
    if (!obj.name) { toast('Le nom du projet est requis'); return false; }
    await persist('projects', obj);
    const i = State.projects.findIndex(x => x.id === obj.id);
    if (i >= 0) State.projects[i] = obj; else State.projects.push(obj);
    projDraft = null;
    if (isNew) { openProject(obj.id); toast('Projet créé'); }
    else { renderProjects(); toast('Projet modifié'); }
    return true;
  });
  // câblage des boutons logo
  bindLogoPick('left');
  bindLogoPick('right');
}

function logoPickHtml(side, dataUrl, label) {
  if (dataUrl) {
    return `<div class="logo-row">
        <img src="${dataUrl}" class="logo-thumb" alt="${label}">
        <div class="logo-actions">
          <button class="btn-ghost" data-logo-change="${side}">Changer</button>
          <button class="btn-ghost" data-logo-del="${side}">Retirer</button>
        </div>
      </div>`;
  }
  return `<button class="inline-add" data-logo-change="${side}">🖼️ Importer ${label.toLowerCase()}</button>`;
}
function bindLogoPick(side) {
  const wrap = $(`#logo-${side}-wrap`);
  if (!wrap) return;
  const change = wrap.querySelector(`[data-logo-change="${side}"]`);
  const del = wrap.querySelector(`[data-logo-del="${side}"]`);
  if (change) change.addEventListener('click', () => importLogo(side));
  if (del) del.addEventListener('click', () => {
    projDraft[side === 'left' ? 'logoLeft' : 'logoRight'] = '';
    refreshLogoWrap(side);
  });
}
function refreshLogoWrap(side) {
  const wrap = $(`#logo-${side}-wrap`);
  const url = projDraft[side === 'left' ? 'logoLeft' : 'logoRight'];
  wrap.innerHTML = logoPickHtml(side, url, side === 'left' ? 'Logo gauche' : 'Logo droit');
  bindLogoPick(side);
}
// Importe + redimensionne une image en dataURL compacte (max 320px, JPEG/PNG)
function importLogo(side) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 320;
        let w = img.width, h = img.height;
        if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        // PNG pour préserver la transparence des logos
        const out = cv.toDataURL('image/png');
        projDraft[side === 'left' ? 'logoLeft' : 'logoRight'] = out;
        refreshLogoWrap(side);
        toast('Logo importé');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  inp.click();
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
    // Horaires dynamiques : liste de {label, time}. Reprend ceux de la dernière feuille.
    schedule: last?.schedule ? JSON.parse(JSON.stringify(last.schedule)) : [
      { label: 'PAT 1', time: '' },
      { label: 'Repas', time: '' },
      { label: 'PAT 2', time: '' },
    ],
    sunRise: '', sunSet: '', weather: '',
    note: '', footer: '',
    // réutilise les lieux/équipe de la dernière feuille du projet (gain de temps).
    // Les lieux sont des listes (copie profonde, normalisée).
    locTournage: copyLocList(last?.locTournage), locParking: copyLocList(last?.locParking),
    locHopital: copyLocList(last?.locHopital), locPolice: copyLocList(last?.locPolice),
    locProd: copyLocList(last?.locProd),
    crew: last ? JSON.parse(JSON.stringify(last.crew || [])).map(m => ({ ...m, id: uid() })) : [],
    scenes: [],
  };
  openEditor(s);
}
// Normalise + copie une liste de lieux (objet unique ou tableau -> tableau)
function copyLocList(v) {
  let arr = v;
  if (!Array.isArray(arr)) arr = (arr && (arr.name || arr.address)) ? [arr] : [];
  return JSON.parse(JSON.stringify(arr));
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
  // Sécurité : sauvegarde immédiate du brouillon si l'app passe en arrière-plan
  // (verrouillage écran, changement d'app, fermeture onglet).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && editDraft) autoSaveDraft(true);
  });
  window.addEventListener('pagehide', () => { if (editDraft) autoSaveDraft(true); });

  // Tabbar : Projet / Carnet / Profil
  $$('#tabbar .tab[data-go]').forEach(t => t.addEventListener('click', () => {
    go(t.dataset.go);
  }));
  // Bouton d'action principal en haut : contextuel
  // - vue projets -> nouveau projet
  // - vue feuilles (dans un projet) -> nouvelle feuille
  $('#top-add-btn').addEventListener('click', () => {
    if (State.view === 'projects') newProject(); else newSheet();
  });

  // Back
  $('#back-btn').addEventListener('click', () => {
    if (State.view === 'preview') go('sheets');
    else if (State.view === 'sheets') go('projects');
  });

  // Tri
  $('#sort-select').addEventListener('change', () => {
    State.view === 'projects' ? renderProjects() : renderSheets();
  });

  // Carnet onglets
  $$('#carnet-seg button').forEach(b => b.addEventListener('click', () => { carnetTab = b.dataset.tab; renderCarnet(); }));
  $('#add-crew-btn').addEventListener('click', () => editCrew(null));
  $('#add-loc-btn').addEventListener('click', () => editLoc(null));
  $('#add-prod-btn').addEventListener('click', () => editProd(null));

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
  $('#set-export').addEventListener('click', () => Export.toJSON());
  $('#set-import').addEventListener('click', importJSON);
  $('#set-cloud').addEventListener('click', cloudToggle);
  $('#set-wipe').addEventListener('click', async () => {
    if (!confirm('Tout effacer sur cet appareil ? (le cloud n\'est pas touché)')) return;
    await Store.wipeAll(); State.projects = []; State.sheets = []; State.crew = []; State.locations = []; State.productions = [];
    go('projects'); toast('Données effacées');
  });

  // Login screen
  const gbtn = $('#login-google-btn');
  if (gbtn) gbtn.addEventListener('click', () => Cloud.signInGoogle().catch(showLoginErr));
  const skip = $('#login-skip-btn');
  if (skip) skip.addEventListener('click', () => {
    const ls = $('#login-screen'); if (ls) ls.hidden = true;
    go('projects');
  });
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
        for (const name of ['projects','sheets','crew','locations','productions']) {
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
  State.projects    = await Store.projects.all();
  State.sheets      = await Store.sheets.all();
  State.crew        = await Store.crew.all();
  State.locations   = await Store.locations.all();
  State.productions = await Store.productions.all();
  const st = await Store.getKV('settings'); if (st) State.settings = { ...State.settings, ...st };
}

async function start() {
  // L'écran de login reste masqué par défaut. On ne l'affiche QUE si
  // Firebase est configuré ET que l'utilisateur n'est pas connecté.
  const loginScreen = $('#login-screen');
  if (loginScreen) loginScreen.hidden = true;

  try {
    await Store.init();
    await loadAll();
  } catch (e) { console.error('Store init', e); }

  applyTheme();

  // bind() ne doit jamais empêcher l'app de démarrer
  try { bind(); } catch (e) { console.error('bind', e); }

  go('projects');

  // Reprise de brouillon après coupure : si un brouillon était en cours, proposer de le reprendre.
  try {
    const draftId = await Store.getKV('activeDraftId');
    if (draftId) {
      const s = byId(State.sheets, draftId);
      if (s && s.draft) {
        setTimeout(() => {
          if (confirm('Une feuille de service était en cours de création. Reprendre là où vous en étiez ?')) {
            State.currentProjectId = s.projectId;
            const pr = byId(State.projects, s.projectId);
            State._projName = pr ? pr.name : 'Feuilles';
            State.currentSheetId = s.id;
            openEditor(s);
          }
        }, 400);
      } else {
        await Store.setKV('activeDraftId', '');
      }
    }
  } catch (e) { /* pas bloquant */ }

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }

  // Cloud : si configuré, on tente l'auth et on affiche l'écran de login.
  // Sinon (cas actuel, FIREBASE_CONFIG non rempli) : l'app reste 100% locale,
  // l'écran de login ne s'affiche jamais.
  if (Cloud.configured()) {
    Cloud.init(async (u) => {
      if (u) {
        if (loginScreen) loginScreen.hidden = true;
        try { await Cloud.pullAll(); await loadAll(); go('projects'); } catch (e) {}
      } else {
        if (loginScreen) loginScreen.hidden = false; // propose Google/Apple
      }
      renderProfile();
    });
  }
}

document.addEventListener('DOMContentLoaded', start);
