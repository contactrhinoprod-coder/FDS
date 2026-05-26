# FDS — Feuille de Service (PWA tournage)

Application web installable (PWA) en JavaScript vanilla. Aucune dépendance, aucun build.
Même philosophie de déploiement que DVDthèque / ALPHABRAVO : 5 fichiers + service worker,
poussés sur GitHub Pages.

Crée et gère tes feuilles de service de tournage, organisées par projet. Carnet d'équipe
et de lieux réutilisable, export PDF (fidèle à la maquette H2M/Rhino) et DOC (Word éditable),
envoi par mail nominatif et partage WhatsApp/Messages.

## Fichiers

```
fds/
├── index.html      # shell + toutes les vues + modales
├── style.css       # thème cinéma (dark/light) + rendu de la feuille + règles @media print A4
├── app.js          # logique : store IndexedDB, cloud Firebase, export, mail, rendu, routing
├── sw.js           # service worker (offline-first, no-cache auto-update)
└── manifest.json   # métadonnées PWA + icônes (SVG inline)
```

## Lancer en local

Un serveur HTTP est requis (service workers et login ne marchent pas en `file://`).

```bash
cd fds
python3 -m http.server 8000
# ouvrir http://localhost:8000
```

## Déploiement GitHub Pages

1. Créer un repo (ex. `FDS`), pousser ces fichiers à la racine.
2. Settings → Pages → Branch `main` / `/root`.
3. URL : `https://<user>.github.io/FDS/`.

## Fonctionnel dès maintenant

- **Projets → Feuilles.** Chaque projet contient ses feuilles de service (Jour 1, Jour 2…).
- **Éditeur complet** : en-tête (n°, sujet, date, jour X/Y), horaires (PAT1, repas, PAT2, fin),
  éphémérides (lever/coucher soleil), météo, note à l'équipe, lieux (tournage/parking/hôpital/
  police/prod + liens Maps), convocations (poste, nom, téléphone, email, heure de convoc,
  contact clé), détails des scènes (INT/EXT, décor, perso, plans, minutage), épisode.
- **Carnet réutilisable** : équipe + lieux récurrents, injectables en un clic dans une feuille.
  Une nouvelle feuille reprend aussi automatiquement les lieux/équipe de la précédente du projet.
- **Aperçu fidèle** à la maquette H2M/Rhino.
- **Export PDF** via impression navigateur (« Enregistrer en PDF » natif iOS/Android), fidèle,
  offline, zéro dépendance.
- **Export DOC** (.doc HTML-Word) éditable dans Word / Pages / Google Docs.
- **Mail nominatif** : pour chaque membre avec email, ouvre l'app mail pré-remplie (objet +
  message adaptés au poste, à l'heure de convoc et au lieu). Voie A : l'utilisateur joint le
  PDF exporté puis envoie.
- **Partage** WhatsApp / Messages via le partage natif du téléphone (Web Share API).
- **Stockage offline** via IndexedDB.
- **Logos** : emplacements gauche/droite remplissables dans Profil (stockés en local).
- Import / export JSON. Thème sombre / clair.

## Auth & Sync cloud (Firebase) — pattern ALPHABRAVO / DVDthèque

Le SDK Firebase (compat) est chargé via `<script>` dans `index.html`. La config est **en dur**
dans `app.js`, constante `FIREBASE_CONFIG` (encadrée par des flèches). Remplacer les `TON_…`
par les valeurs du projet Firebase. Tant que ce n'est pas fait, l'app reste 100 % locale
(bouton « Continuer sans compte »).

- **Auth Google + Apple** câblés (`signInGoogle`, `signInApple`).
  Apple nécessite un compte développeur Apple (déjà disponible).
  ⚠️ Apple ne renvoie nom/email qu'à la **première** connexion.
- **Sync Firestore** : `users/{uid}/{projects|sheets|crew|locations}`. À la connexion,
  l'app tire le cloud (`pullAll`) ; chaque enregistrement local pousse vers le cloud.

### Activer l'auth (console Firebase)

Authentication → Sign-in method → activer **Google** et **Apple**.
Pour Apple : renseigner Service ID, Team ID, Key ID et la clé privée (depuis le compte dev Apple).

### Règles Firestore (console → Firestore → Règles)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{collection}/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

## Limites connues (Voie A — phase 1)

1. **Envoi mail.** Une PWA ne peut pas envoyer un mail avec pièce jointe en silence (sécurité
   navigateur). Le bouton « mail » ouvre donc l'app mail **pré-remplie** (destinataire, objet,
   message nominatif) ; on joint le PDF exporté manuellement puis on envoie. Quasi-automatique,
   zéro coût. **Phase 2** : envoi 100 % automatique via Cloud Function (SendGrid/Resend) ou,
   en natif, via l'API mail système — `Mailer.mailToMember` est le seul point à remplacer.

2. **Partage de fichier.** Le partage natif envoie un texte récap. Le partage du **fichier PDF**
   joint dépend du support de `navigator.share({files})` du device (OK iOS récents). Sinon,
   exporter le PDF puis le partager depuis l'app Fichiers.

3. **DOC.** Le `.doc` généré est du HTML-Word : fidèle et éditable, mais le rendu fin peut
   varier légèrement selon Word/Pages. Le PDF reste la sortie de référence.

## Vers le natif (Mac / PC / iOS / Android)

Le schéma de données est plat et identique côté cloud, donc le test PWA n'est pas jetable :
les feuilles saisies se retrouveront côté natif en pointant le **même projet Firebase**.
Pistes de portage : Flutter (mobile + desktop), ou wrapper (Capacitor/Tauri) autour de cette
base web. Le point « envoi mail auto » devient natif à ce moment-là (plus de limite navigateur).

## Prochaines passes possibles

- Envoi mail automatique avec PJ (Cloud Function ou natif).
- Export `.docx` (vrai format Word via librairie) en plus du `.doc`.
- Génération PDF côté client en téléchargement direct (jsPDF/html2pdf) si besoin sans dialogue d'impression.
- Météo/éphémérides auto-remplies par géoloc + date.
- Duplication de projet entier (pour une nouvelle prod récurrente).
