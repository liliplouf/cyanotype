// app.js — Orchestration de l'interface « Désatyves » : formulaire, appel du moteur, résumé,
// alertes, profil, tableau et courbes. Aucune donnée n'est insérée via innerHTML.
// Le moteur réel (planificateur.js) est chargé par défaut ; ?factice=1 charge moteur-factice.js.

import {
  PRESETS_GF, etatDefaut, fusionnerEtat, construireParams, presetPourGF, profondeurMOD, lireNombre,
} from './formulaire.js';
import { formatNombre, formatDuree, formatPaliers, nomGaz, presentationAvion } from './format.js';
import { rendreCourbes, rendreProfil, cssCouleursCompartiments, UNITES } from './graphiques.js';
import { rendreTableau, rendreLegende, genererCSV, nomFichierCSV } from './tableau.js';
import { altitudeIci } from './geo.js';
import * as stockage from './stockage.js';

const $ = (id) => document.getElementById(id);
// Tolérance du moteur pour la bascule (O2 pur à 6 m en eau de mer = 1,616 bar), cf. SPEC.md.
const TOLERANCE_BASCULE = 0.02;
const AFFICHAGE_DEFAUT = { onglet: 'tableau', unite: 'pN2', echelle: 'plongee', mode: 'superpose', visibles: [...Array(16).keys()] };
const AIDE_UNITES = {
  pN2: 'Pression partielle d’azote dans chaque compartiment (bar). La ligne d’équilibre correspond à la surface, à l’altitude choisie.',
  pctMSurf: 'Charge rapportée à la M-value (tolérance maximale de Bühlmann) à la pression de surface : au-delà de 100 %, le compartiment ne pourrait pas sortir directement.',
  pctMAmb: 'Charge rapportée à la M-value à la pression ambiante du moment.',
  pctGF: 'Position entre la pression ambiante (0 %) et la M-value (100 %) : c’est la grandeur que limitent les facteurs de gradient. Négatif = le compartiment se charge encore.',
};

const etatApp = {
  moteur: null,
  factice: false,
  formulaire: etatDefaut(),
  affichage: { ...AFFICHAGE_DEFAUT },
  resultat: null,
  params: null,
};

// ---------------------------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------------------------

async function demarrer() {
  const style = document.createElement('style');
  style.textContent = cssCouleursCompartiments();
  document.head.appendChild(style);

  etatApp.formulaire = fusionnerEtat(stockage.lire('formulaire'));
  const aff = stockage.lire('affichage');
  if (aff && typeof aff === 'object') {
    for (const k of Object.keys(AFFICHAGE_DEFAUT)) if (aff[k] !== undefined) etatApp.affichage[k] = aff[k];
    if (!Array.isArray(etatApp.affichage.visibles)) etatApp.affichage.visibles = AFFICHAGE_DEFAUT.visibles.slice();
    etatApp.affichage.visibles = etatApp.affichage.visibles.filter((i) => Number.isInteger(i) && i >= 0 && i < 16);
    if (!UNITES[etatApp.affichage.unite]) etatApp.affichage.unite = 'pN2';
  }
  if (!stockage.estPersistant()) $('stockage-note').textContent = 'Stockage local indisponible : vos réglages ne seront pas mémorisés.';

  preparerFormulaire();
  remplirFormulaire();
  preparerSorties();

  let factice = false;
  try { factice = new URLSearchParams(location.search).get('factice') === '1'; } catch { /* ignore */ }
  etatApp.factice = factice;
  $('moteur-factice').hidden = !factice;
  try {
    etatApp.moteur = await import(factice ? './moteur-factice.js' : './planificateur.js');
  } catch (e) {
    console.error(e);
    afficherErreursGlobales(['Le moteur de calcul n’a pas pu être chargé. Rechargez la page ; si le problème persiste, essayez ?factice=1 pour une démonstration.']);
    return;
  }
  calculer({ defiler: false });
}

// ---------------------------------------------------------------------------------------------
// Formulaire
// ---------------------------------------------------------------------------------------------

function preparerFormulaire() {
  const sel = $('f-gfPreset');
  for (const p of PRESETS_GF) sel.append(new Option(p.libelle, p.id));
  sel.append(new Option('Personnalisé', 'perso'));

  const form = $('formulaire');
  form.addEventListener('input', surSaisie);
  form.addEventListener('change', surSaisie);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    calculer({ defiler: true });
  });
  $('ajouter-niveau').addEventListener('click', () => {
    const n = etatApp.formulaire.niveaux;
    const der = n[n.length - 1] || { profondeur: '20', duree: '10' };
    const prof = lireNombre(der.profondeur);
    n.push({ profondeur: Number.isFinite(prof) && prof > 6 ? String(Math.max(3, Math.round(prof * 0.6))) : '', duree: '10' });
    rendreNiveaux();
    sauverFormulaire();
    $(`f-niveaux-${n.length - 1}-profondeur`).focus();
  });
  $('ajouter-gaz').addEventListener('click', () => {
    const g = etatApp.formulaire.gazDeco;
    if (g.length >= 3) return;
    const o2 = g.length ? '100' : '50';
    const mod = profondeurMOD(Number(o2) / 100, (lireNombre(etatApp.formulaire.ppo2MaxDeco) || 1.6) + TOLERANCE_BASCULE);
    g.push({ o2, profondeur: String(mod) });
    rendreGazDeco();
    sauverFormulaire();
    $(`f-gazDeco-${g.length - 1}-o2`).focus();
  });
  $('reinitialiser').addEventListener('click', () => {
    if (!window.confirm('Revenir aux réglages par défaut ? Vos saisies seront effacées.')) return;
    stockage.effacer();
    etatApp.formulaire = etatDefaut();
    etatApp.affichage = { ...AFFICHAGE_DEFAUT, visibles: AFFICHAGE_DEFAUT.visibles.slice() };
    remplirFormulaire();
    synchroniserSorties();
    effacerErreurs();
    $('geo-etat').textContent = '';
    calculer({ defiler: false });
  });
  $('ma-position').addEventListener('click', localiser);
}

/** Écrit l'état dans les champs. */
function remplirFormulaire() {
  const e = etatApp.formulaire;
  for (const champ of document.querySelectorAll('#formulaire [data-cle]')) {
    const v = valeurEtat(e, champ.dataset.cle);
    if (champ.type === 'checkbox') champ.checked = !!v;
    else if (champ.type === 'radio') champ.checked = champ.value === String(v);
    else champ.value = v ?? '';
  }
  rendreNiveaux();
  rendreGazDeco();
  majDependances();
}

function valeurEtat(e, cle) {
  return cle.split('.').reduce((o, k) => (o ? o[k] : undefined), e);
}

function ecrireEtat(e, cle, v) {
  const ks = cle.split('.');
  const der = ks.pop();
  const o = ks.reduce((x, k) => x[k], e);
  o[der] = v;
}

function surSaisie(ev) {
  const cible = ev.target;
  if (!(cible instanceof HTMLElement)) return;
  const e = etatApp.formulaire;
  if (cible.dataset.cle) {
    const cle = cible.dataset.cle;
    if (cible.type === 'checkbox') ecrireEtat(e, cle, cible.checked);
    else if (cible.type === 'radio') { if (cible.checked) ecrireEtat(e, cle, cible.value); }
    else ecrireEtat(e, cle, cible.value);
    if (cle === 'gfPreset' && cible.value !== 'perso') {
      const p = PRESETS_GF.find((x) => x.id === cible.value);
      if (p) {
        e.gfBas = String(p.bas);
        e.gfHaut = String(p.haut);
        $('f-gfBas').value = e.gfBas;
        $('f-gfHaut').value = e.gfHaut;
      }
    } else if (cle === 'gfBas' || cle === 'gfHaut') {
      e.gfPreset = presetPourGF(lireNombre(e.gfBas), lireNombre(e.gfHaut));
      $('f-gfPreset').value = e.gfPreset;
    }
  } else if (cible.dataset.liste) {
    const liste = e[cible.dataset.liste];
    const ligne = liste[Number(cible.dataset.index)];
    if (ligne) ligne[cible.dataset.champ] = cible.value;
    if (cible.dataset.liste === 'gazDeco') majAideGaz();
  }
  if (cible.getAttribute('aria-invalid') === 'true') effacerErreurChamp(cible);
  majDependances();
  sauverFormulaire();
}

function sauverFormulaire() {
  stockage.ecrire('formulaire', etatApp.formulaire);
}

/** Affiche / masque les sous-blocs selon les cases cochées. */
function majDependances() {
  const e = etatApp.formulaire;
  const nitrox = e.gazType === 'nitrox';
  $('bloc-o2').hidden = !nitrox;
  const pct = lireNombre(e.o2);
  const ppo2 = lireNombre(e.ppo2Max) || 1.4;
  $('aide-o2').textContent = nitrox && pct >= 22 && pct <= 100
    ? `Profondeur max. d’utilisation à ${formatNombre(ppo2, 1)} bar : ${formatNombre(profondeurMOD(pct / 100, ppo2, { pas: 0 }), 0)} m (niveau de la mer).`
    : '';
  for (const [caseId, blocId] of [['f-securiteActif', 'bloc-securite'], ['f-successive', 'bloc-successive'], ['f-acclim', 'bloc-acclim']]) {
    const actif = $(caseId).checked;
    $(blocId).hidden = !actif;
    $(caseId).setAttribute('aria-expanded', String(actif));
  }
  majAideGaz();
}

function champTexte({ id, libelle, unite, valeur, liste, index, champ, mode = 'decimal' }) {
  const div = document.createElement('div');
  div.className = 'champ';
  const lab = document.createElement('label');
  lab.htmlFor = id;
  lab.textContent = `${libelle} `;
  const u = document.createElement('span');
  u.className = 'unite';
  u.textContent = unite;
  lab.append(u);
  const inp = document.createElement('input');
  inp.id = id;
  inp.type = 'text';
  inp.inputMode = mode;
  inp.autocomplete = 'off';
  inp.value = valeur;
  inp.dataset.liste = liste;
  inp.dataset.index = String(index);
  inp.dataset.champ = champ;
  div.append(lab, inp);
  return div;
}

function boutonSupprimer(libelle, desactive, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bouton icone-seule supprimer';
  b.setAttribute('aria-label', libelle);
  b.title = libelle;
  b.disabled = desactive;
  b.textContent = '×';
  b.addEventListener('click', action);
  return b;
}

function rendreNiveaux() {
  const conteneur = $('niveaux');
  conteneur.replaceChildren();
  const n = etatApp.formulaire.niveaux;
  n.forEach((l, i) => {
    const ligne = document.createElement('div');
    ligne.className = 'ligne-niveau';
    const num = document.createElement('span');
    num.className = 'num-niveau';
    num.textContent = String(i + 1);
    num.setAttribute('aria-hidden', 'true');
    ligne.append(
      num,
      champTexte({ id: `f-niveaux-${i}-profondeur`, libelle: n.length > 1 ? `Profondeur ${i + 1}` : 'Profondeur', unite: 'm', valeur: l.profondeur, liste: 'niveaux', index: i, champ: 'profondeur' }),
      champTexte({ id: `f-niveaux-${i}-duree`, libelle: n.length > 1 ? `Durée ${i + 1}` : 'Durée', unite: 'min', valeur: l.duree, liste: 'niveaux', index: i, champ: 'duree', mode: 'numeric' }),
      boutonSupprimer(`Supprimer le niveau ${i + 1}`, n.length <= 1, () => {
        n.splice(i, 1);
        rendreNiveaux();
        sauverFormulaire();
        const suiv = $(`f-niveaux-${Math.min(i, n.length - 1)}-profondeur`);
        if (suiv) suiv.focus();
      }),
    );
    conteneur.append(ligne);
  });
  $('ajouter-niveau').disabled = n.length >= 8;
}

function rendreGazDeco() {
  const conteneur = $('gaz-deco');
  conteneur.replaceChildren();
  const g = etatApp.formulaire.gazDeco;
  g.forEach((l, i) => {
    const ligne = document.createElement('div');
    ligne.className = 'ligne-niveau ligne-gaz';
    const titre = document.createElement('span');
    titre.className = 'num-niveau';
    titre.textContent = `G${i + 1}`;
    titre.setAttribute('aria-hidden', 'true');
    const aide = document.createElement('p');
    aide.className = 'aide aide-gaz';
    aide.id = `aide-gaz-${i}`;
    ligne.append(
      titre,
      champTexte({ id: `f-gazDeco-${i}-o2`, libelle: `O₂ gaz ${i + 1}`, unite: '%', valeur: l.o2, liste: 'gazDeco', index: i, champ: 'o2', mode: 'numeric' }),
      champTexte({ id: `f-gazDeco-${i}-profondeur`, libelle: 'Bascule à', unite: 'm', valeur: l.profondeur, liste: 'gazDeco', index: i, champ: 'profondeur' }),
      boutonSupprimer(`Supprimer le gaz de déco ${i + 1}`, false, () => {
        g.splice(i, 1);
        rendreGazDeco();
        sauverFormulaire();
        $('ajouter-gaz').focus();
      }),
      aide,
    );
    conteneur.append(ligne);
  });
  $('ajouter-gaz').disabled = g.length >= 3;
  majAideGaz();
}

function majAideGaz() {
  const e = etatApp.formulaire;
  const ppo2 = lireNombre(e.ppo2MaxDeco) || 1.6;
  e.gazDeco.forEach((g, i) => {
    const p = $(`aide-gaz-${i}`);
    if (!p) return;
    const pct = lireNombre(g.o2);
    p.textContent = pct >= 22 && pct <= 100
      ? `${nomGaz(pct / 100)} : bascule possible jusqu’à ${profondeurMOD(pct / 100, ppo2 + TOLERANCE_BASCULE)} m (PpO₂ ${formatNombre(ppo2, 1)} bar).`
      : '';
  });
}

// ---------------------------------------------------------------------------------------------
// Erreurs de saisie
// ---------------------------------------------------------------------------------------------

const idChamp = (champ) => `f-${champ.replace(/\./g, '-')}`;

function effacerErreurChamp(input) {
  input.removeAttribute('aria-invalid');
  const msg = $(`err-${input.id}`);
  if (msg) msg.remove();
  const desc = (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== `err-${input.id}`);
  if (desc.length) input.setAttribute('aria-describedby', desc.join(' '));
  else input.removeAttribute('aria-describedby');
}

function effacerErreurs() {
  for (const i of document.querySelectorAll('#formulaire [aria-invalid="true"]')) effacerErreurChamp(i);
  const box = $('erreurs');
  box.hidden = true;
  box.replaceChildren();
}

function afficherErreurs(erreurs) {
  effacerErreurs();
  const box = $('erreurs');
  const titre = document.createElement('p');
  titre.className = 'erreurs-titre';
  titre.textContent = erreurs.length > 1 ? `${erreurs.length} saisies à corriger :` : 'Une saisie à corriger :';
  const ul = document.createElement('ul');
  let avances = false;
  for (const er of erreurs) {
    const input = $(idChamp(er.champ));
    const li = document.createElement('li');
    if (input) {
      const a = document.createElement('a');
      a.href = `#${input.id}`;
      a.textContent = er.message;
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        if ($('avances').contains(input)) $('avances').open = true;
        input.focus();
      });
      li.append(a);
      input.setAttribute('aria-invalid', 'true');
      if (!$(`err-${input.id}`)) {
        const p = document.createElement('p');
        p.className = 'msg-erreur';
        p.id = `err-${input.id}`;
        p.textContent = er.message;
        input.insertAdjacentElement('afterend', p);
        input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${p.id}`.trim());
      }
      if ($('avances').contains(input)) avances = true;
    } else {
      li.textContent = er.message;
    }
    ul.append(li);
  }
  if (avances) $('avances').open = true;
  box.append(titre, ul);
  box.hidden = false;
}

function afficherErreursGlobales(messages) {
  afficherErreurs(messages.map((message) => ({ champ: '', message })));
}

// ---------------------------------------------------------------------------------------------
// Calcul et résultats
// ---------------------------------------------------------------------------------------------

function calculer({ defiler }) {
  if (!etatApp.moteur) return;
  const { params, erreurs } = construireParams(etatApp.formulaire);
  if (erreurs.length) {
    afficherErreurs(erreurs);
    if (defiler) $('erreurs').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  let res;
  try {
    res = etatApp.moteur.planifier({ ...etatApp.moteur.PARAMETRES_DEFAUT, ...params });
  } catch (e) {
    console.error(e);
    afficherErreursGlobales([`Erreur du moteur de calcul : ${e.message || e}`]);
    return;
  }
  if (!res || !res.ok) {
    afficherErreursGlobales((res && res.erreurs && res.erreurs.length) ? res.erreurs : ['Calcul impossible avec ces paramètres.']);
    return;
  }
  effacerErreurs();
  etatApp.resultat = res;
  etatApp.params = params;
  $('resultat-vide').hidden = true;
  $('resultat-contenu').hidden = false;
  rendreResume(res, params);
  rendreAlertes(res.alertes || []);
  synchroniserSorties();
  rendreTout();
  if (defiler) {
    const r = $('resultats');
    const haut = r.getBoundingClientRect().top;
    if (haut > window.innerHeight * 0.6 || haut < 0) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
    r.focus({ preventScroll: true });
  }
}

function stat(dl, terme, valeur, detail, classe) {
  const div = document.createElement('div');
  div.className = `stat${classe ? ` ${classe}` : ''}`;
  const dt = document.createElement('dt');
  dt.textContent = terme;
  const dd = document.createElement('dd');
  dd.textContent = valeur;
  div.append(dt, dd);
  if (detail) {
    const p = document.createElement('dd');
    p.className = 'detail';
    p.textContent = detail;
    div.append(p);
  }
  dl.append(div);
}

function rendreResume(res, params) {
  const r = res.resume;
  const box = $('resume');
  box.replaceChildren();
  const gazFond = res.paliers.length ? (res.phases.find((p) => p.type === 'fond') || {}).gaz : undefined;
  const obligatoires = res.paliers.filter((p) => !p.securite);
  const securite = res.paliers.filter((p) => p.securite);

  const tete = document.createElement('div');
  tete.className = `resume-tete ${obligatoires.length ? 'avec-paliers' : 'sans-palier'}`;
  const sur = document.createElement('p');
  sur.className = 'resume-sur';
  sur.textContent = obligatoires.length ? 'Paliers obligatoires' : 'Aucun palier obligatoire';
  const grand = document.createElement('p');
  grand.className = 'resume-paliers';
  if (obligatoires.length) grand.textContent = formatPaliers(obligatoires, { gazFond });
  else if (securite.length) grand.textContent = `Palier de sécurité : ${formatPaliers(securite.map((p) => ({ ...p, securite: false })))}`;
  else grand.textContent = 'Remontée directe à vitesse contrôlée';
  tete.append(sur, grand);
  const profils = params.niveaux.map((n) => `${formatNombre(n.profondeur)} m · ${formatNombre(n.duree)} min`).join(' → ');
  const ctx = document.createElement('p');
  ctx.className = 'resume-contexte';
  ctx.textContent = `${profils} · ${nomGaz(params.gaz.o2)} · ${params.eau === 'douce' ? 'eau douce' : 'eau de mer'} · altitude ${formatNombre(params.altitude)} m · GF ${params.gfBas}/${params.gfHaut}`;
  tete.append(ctx);
  box.append(tete);

  const dl = document.createElement('dl');
  dl.className = 'stats';
  stat(dl, 'DTR', formatDuree(r.dtr, { arrondi: 'haut' }), 'durée totale de remontée');
  stat(dl, 'Durée totale', formatDuree(r.dureeTotale, { arrondi: 'haut' }), 'de l’immersion à la sortie');
  stat(dl, 'Prof. max', `${formatNombre(r.profondeurMax, r.profondeurMax % 1 ? 1 : 0)} m`, `MOD du gaz : ${formatNombre(r.mod, 0)} m`);
  const ndlInconnue = r.ndl === null || r.ndl === undefined;
  const ndlIllimitee = r.ndlIllimite || (!ndlInconnue && r.ndl >= 999);
  stat(dl, 'Sans palier (NDL)', ndlInconnue ? 'dépassée' : ndlIllimitee ? 'illimitée' : formatDuree(r.ndl),
    ndlInconnue ? 'déjà en décompression au début du dernier niveau' : 'disponible au début du dernier niveau');
  const desat = formatDuree(r.desaturation, { arrondi: 'haut' });
  stat(dl, 'Désaturation', r.desaturationPlafonnee ? `> ${desat}` : desat, 'après la sortie');
  const avion = presentationAvion(r, { successive: Boolean(params.plongeePrecedente) });
  stat(dl, 'Avion / col', `≥ ${avion.valeur}`, avion.detail);
  stat(dl, 'CNS', `${formatNombre(r.cns, r.cns < 10 ? 1 : 0)}\u202f%`,
    `OTU : ${formatNombre(r.otu)}${r.cnsResiduel ? ` · dont ${formatNombre(r.cnsResiduel, 1)}\u202f% résiduel` : ''}`);
  if (r.consommation) {
    const c = r.consommation;
    const deco = (c.parGaz || []).slice(1).filter((g) => g && g.litres > 0) // parGaz[0] = gaz fond (trié par le moteur)
      .map((g) => `${g.gaz} ${formatNombre(g.litres)}\u202fL${Number.isFinite(g.pressionRestante) ? ` (reste ${formatNombre(g.pressionRestante)}\u202fbar)` : ''}`);
    stat(dl, 'Gaz restant', `${formatNombre(c.pressionRestante)}\u202fbar`,
      `${formatNombre(c.litresFond ?? c.litres)}\u202fL consommés${c.reserveEntamee ? ' · réserve entamée' : ''}${deco.length ? ` · déco : ${deco.join(', ')}` : ''}`, c.reserveEntamee ? 'stat-alerte' : '');
  }
  if (res.psurf < 1) stat(dl, 'Pression en surface', `${formatNombre(res.psurf, 3)} bar`, 'à l’altitude de la plongée');
  box.append(dl);
}

const LIBELLES_NIVEAU = { info: 'Info', attention: 'Attention', danger: 'Danger' };

function rendreAlertes(alertes) {
  const ul = $('alertes');
  ul.replaceChildren();
  const ordre = { danger: 0, attention: 1, info: 2 };
  for (const a of alertes.slice().sort((x, y) => (ordre[x.niveau] ?? 3) - (ordre[y.niveau] ?? 3))) {
    const li = document.createElement('li');
    const niveau = LIBELLES_NIVEAU[a.niveau] ? a.niveau : 'info';
    li.className = `alerte alerte-${niveau}`;
    const b = document.createElement('strong');
    b.textContent = `${LIBELLES_NIVEAU[niveau]} : `;
    li.append(b, a.message);
    ul.append(li);
  }
  ul.hidden = !alertes.length;
}

// ---------------------------------------------------------------------------------------------
// Sorties : onglets, tableau, courbes
// ---------------------------------------------------------------------------------------------

const theme = () => (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair');

function preparerSorties() {
  const onglets = [$('onglet-tableau'), $('onglet-courbes')];
  onglets.forEach((o, i) => {
    o.addEventListener('click', () => choisirOnglet(i === 0 ? 'tableau' : 'courbes', false));
    o.addEventListener('keydown', (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault();
      const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? 1 : 1 - i;
      choisirOnglet(j === 0 ? 'tableau' : 'courbes', true);
    });
  });
  $('unite').addEventListener('change', (ev) => { majAffichage({ unite: ev.target.value }); });
  for (const r of document.querySelectorAll('input[name="mode"], input[name="echelle"]')) {
    r.addEventListener('change', (ev) => { if (ev.target.checked) majAffichage({ [ev.target.name]: ev.target.value }); });
  }
  // Puces des compartiments
  const puces = $('puces');
  for (let i = 0; i < 16; i++) {
    const lab = document.createElement('label');
    lab.className = 'puce';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(i);
    cb.id = `comp-${i}`;
    const pastille = document.createElement('span');
    pastille.className = 'pastille';
    pastille.style.background = `var(--c${i + 1})`;
    const t = document.createElement('span');
    t.textContent = `C${i + 1}`;
    lab.append(cb, pastille, t);
    lab.title = `Compartiment ${i + 1}`;
    puces.append(lab);
    cb.addEventListener('change', () => {
      const v = new Set(etatApp.affichage.visibles);
      if (cb.checked) v.add(i); else v.delete(i);
      majAffichage({ visibles: [...v].sort((a, b) => a - b) });
    });
  }
  for (const b of document.querySelectorAll('[data-selection]')) {
    b.addEventListener('click', () => {
      const tous = [...Array(16).keys()];
      const sel = { tous, aucun: [], rapides: tous.slice(0, 8), lents: tous.slice(8) }[b.dataset.selection];
      majAffichage({ visibles: sel });
    });
  }
  $('export-csv').addEventListener('click', exporterCSV);

  // Re-rendu au redimensionnement (graphiques à la largeur réelle) et au changement de thème.
  let largeurPrec = 0;
  let minuteur = null;
  const ro = new ResizeObserver((entrees) => {
    const l = Math.round(entrees[0].contentRect.width);
    if (Math.abs(l - largeurPrec) < 8) return;
    largeurPrec = l;
    clearTimeout(minuteur);
    minuteur = setTimeout(() => { if (etatApp.resultat) { rendreProfil($('profil'), etatApp.resultat); rendreGraphiqueSiVisible(); } }, 120);
  });
  ro.observe($('resultats'));
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const f = () => { if (etatApp.resultat) rendreTableauEtLegende(); };
    if (mq.addEventListener) mq.addEventListener('change', f);
  }
  synchroniserSorties();
}

function synchroniserSorties() {
  const a = etatApp.affichage;
  $('unite').value = a.unite;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === a.mode;
  for (const r of document.querySelectorAll('input[name="echelle"]')) r.checked = r.value === a.echelle;
  for (let i = 0; i < 16; i++) $(`comp-${i}`).checked = a.visibles.includes(i);
  // Option « avec la plongée précédente » : seulement pour une plongée successive.
  const avecPrecedente = Boolean(etatApp.resultat && etatApp.resultat.plongeePrecedente);
  $('echelle-successive').hidden = !avecPrecedente;
  if (!avecPrecedente && a.echelle === 'successive') {
    for (const r of document.querySelectorAll('input[name="echelle"]')) r.checked = r.value === 'desat';
  }
  $('choix-compartiments').hidden = a.mode === 'multiples';
  $('aide-unite').textContent = AIDE_UNITES[a.unite];
  choisirOnglet(a.onglet, false, true);
}

function choisirOnglet(nom, focus, sansRendu) {
  const tab = nom === 'courbes' ? 'courbes' : 'tableau';
  etatApp.affichage.onglet = tab;
  for (const n of ['tableau', 'courbes']) {
    const o = $(`onglet-${n}`);
    const actif = n === tab;
    o.setAttribute('aria-selected', String(actif));
    o.tabIndex = actif ? 0 : -1;
    $(`panneau-${n}`).hidden = !actif;
    if (actif && focus) o.focus();
  }
  stockage.ecrire('affichage', etatApp.affichage);
  if (!sansRendu) rendreGraphiqueSiVisible();
}

function majAffichage(changement) {
  Object.assign(etatApp.affichage, changement);
  stockage.ecrire('affichage', etatApp.affichage);
  synchroniserSorties();
  if (etatApp.resultat) rendreTout();
}

function rendreTableauEtLegende() {
  const res = etatApp.resultat;
  const opts = { unite: etatApp.affichage.unite, theme: theme() };
  rendreLegende($('legende-chaleur'), res, opts);
  rendreTableau($('tableau'), res, opts);
}

function rendreGraphiqueSiVisible() {
  if (!etatApp.resultat || $('panneau-courbes').hidden) return;
  const a = etatApp.affichage;
  rendreCourbes($('courbes'), etatApp.resultat, { unite: a.unite, echelle: a.echelle, mode: a.mode, visibles: a.visibles, gfHaut: etatApp.params.gfHaut });
}

function rendreTout() {
  rendreProfil($('profil'), etatApp.resultat);
  rendreTableauEtLegende();
  rendreGraphiqueSiVisible();
}

function exporterCSV() {
  if (!etatApp.resultat) return;
  const csv = genererCSV(etatApp.resultat, etatApp.affichage.unite, { bom: true });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomFichierCSV(etatApp.params, etatApp.affichage.unite);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------------------
// Géolocalisation
// ---------------------------------------------------------------------------------------------

async function localiser() {
  const bouton = $('ma-position');
  const etat = $('geo-etat');
  bouton.disabled = true;
  bouton.setAttribute('aria-busy', 'true');
  etat.className = 'etat-geo';
  etat.textContent = 'Recherche de votre position…';
  try {
    const r = await altitudeIci();
    etatApp.formulaire.altitude = String(r.altitude);
    const champ = $('f-altitude');
    champ.value = etatApp.formulaire.altitude;
    effacerErreurChamp(champ);
    sauverFormulaire();
    etat.className = 'etat-geo succes';
    etat.textContent = `${formatNombre(r.altitude)} m — ${r.note} Vous pouvez corriger la valeur.`;
  } catch (e) {
    etat.className = 'etat-geo echec';
    etat.textContent = e && e.message ? e.message : 'Impossible de déterminer l’altitude. Saisissez-la à la main.';
  } finally {
    bouton.disabled = false;
    bouton.removeAttribute('aria-busy');
  }
}

demarrer();
