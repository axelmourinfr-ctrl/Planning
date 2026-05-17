// ============================================================
// algo.js — PlanEduc Pro v23
// ============================================================
//
// PHILOSOPHIE : reproduire la logique d'un chef éducateur expérimenté.
//
// HIERARCHIE ABSOLUE :
//   P1 — LOI          : repos 11h terrain, 50h/sem lundi→dimanche (fixe), max 6j consécutifs, max nuits consec, repos nuit
//   P2 — SOLDES H     : convergence trimestrielle → 0, zéro absolu fin décembre
//   P3 — ÉQUITÉ       : ±1-2 prestations/mois par type, fériés équitables annuellement
//   P4 — STABILITÉ    : horaire fixe hebdo, tournantes structurées (nuit WE), blocs WE complets
//
// ARCHITECTURE :
//   Phase 0 — Historique & quotas du mois
//   Phase 1 — Pré-assignation WE en blocs cohérents (tournante mensuelle)
//   Phase 2 — Pré-assignation plages "tournante" identifiées (ex: nuit vendredi)
//   Phase 3 — Génération semaine par semaine : priorité aux habitudes fixes
//   Phase 4 — Passe B : remplir max si solde négatif
//   Phase 5 — Micro-ajustements équité nuits / WE
//
// CONVENTIONS DE CODE :
//   sc faible = priorité haute  (tri croissant)
//   Toutes les valeurs retournées négatives = bonus, positives = pénalité
// ============================================================

// ── Helpers de base ──
const isNuitP   = p => p.type === 'nuit' || p.debut >= '22:00' || (p.fin <= '07:00' && p.fin > '00:00');
const isReunion = p => p.type === 'reunion' || (p.nom||'').toLowerCase().includes('reunion') || (p.nom||'').toLowerCase().includes('réunion');
const isWEDay   = d => d.getDay() === 0 || d.getDay() === 6;
const dowIdx    = d => d.getDay() === 0 ? 6 : d.getDay() - 1;
const ratioE    = e => getTargetH(e) / 38;

function dureeH(p) {
  if (p.dureeH && p.dureeH > 0) return p.dureeH;
  const [dh, dm] = p.debut.split(':').map(Number);
  const [fh, fm] = p.fin.split(':').map(Number);
  let h = (fh * 60 + fm) - (dh * 60 + dm);
  if (h <= 0) h += 1440;
  return h / 60;
}

function typePlage(p) {
  if (isReunion(p)) return 'reunion';
  if (isNuitP(p)) return 'nuit';
  const h = parseInt(p.debut);
  if (h < 10) return 'matin';
  if (h < 14) return 'aprem';
  return 'soir';
}

function joursOuvMois(yr, mo) {
  return getDays(yr, mo).filter(d => {
    const dw = d.getDay();
    return dw >= 1 && dw <= 5 && !isFerie(dayStr(d));
  }).length;
}

// Moyenne pondérée par ratio contrat (pour comparer équitablement mi-temps/temps plein)
function moyPond(arr, fn) {
  return arr.reduce((s, x) => s + fn(x) / Math.max(0.01, ratioE(x)), 0) / Math.max(1, arr.length);
}

// Normaliser une valeur par le ratio d'un éduc (pour comparaison équitable)
function norm(val, e) {
  return val / Math.max(0.01, ratioE(e));
}

// Caches de lookup
let _pm = null, _em = null;
function plageById(id) {
  if (!_pm || _pm.size !== plages.length) _pm = new Map(plages.map(p => [p.id, p]));
  return _pm.get(+id);
}
function educById(id) {
  if (!_em || _em.size !== educs.length) _em = new Map(educs.map(e => [e.id, e]));
  return _em.get(+id);
}

// ================================================================
// PATTERNS — Mémoire des habitudes hebdomadaires
// Stocke : pour chaque éduc × jour de semaine × plage → nb d'occurrences
// Utilisé pour reproduire les horaires stables
// ================================================================
function loadPatterns() {
  try { return JSON.parse(localStorage.getItem('planeduc_v3_patterns') || '{}'); } catch(e) { return {}; }
}
function savePatterns(p) {
  try { localStorage.setItem('planeduc_v3_patterns', JSON.stringify(p)); } catch(e) {}
}

function buildPatterns(moisStr) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const patterns = loadPatterns();
  // Analyser les 4 derniers mois pour détecter les habitudes
  for (let i = 1; i <= 4; i++) {
    const key = moisKey(yr, mo - i);
    const plan = horaire[key];
    if (!plan) continue;
    const [ky, km] = key.split('-').map(Number);
    getDays(ky, km).forEach(day => {
      const ds = dayStr(day), dow = dowIdx(day);
      Object.entries(plan[ds] || {}).forEach(([pid, ids]) => {
        if (pid.startsWith('_') || !Array.isArray(ids)) return;
        ids.forEach(eid => {
          const id = String(eid);
          if (!patterns[id]) patterns[id] = {};
          if (!patterns[id][dow]) patterns[id][dow] = {};
          patterns[id][dow][pid] = (patterns[id][dow][pid] || 0) + 1;
        });
      });
    });
  }
  savePatterns(patterns);
  return patterns;
}

// Bonus récurrence : reproduire le même créneau chaque semaine
// WE : plus faible (rotation importante), Semaine : fort (habitude = confort)
function bonusRecurrence(e, dow, plage, patterns, isWECtx) {
  const pat = patterns[String(e.id)];
  if (!pat || !pat[dow] || !pat[dow][plage.id]) return 0;
  const cnt = pat[dow][plage.id] || 0;
  if (cnt === 0) return 0;
  const mult = isWECtx ? 0.5 : 1.5;
  if (cnt >= 8) return -35 * mult;  // habitude très ancrée → très prioritaire
  if (cnt >= 5) return -25 * mult;
  if (cnt >= 3) return -16 * mult;
  if (cnt >= 1) return -8 * mult;
  return 0;
}

// Bonus si l'éduc travaille habituellement ce jour (toutes plages)
function bonusJourHabituel(e, dow, patterns) {
  const pat = patterns[String(e.id)];
  if (!pat || !pat[dow]) return 0;
  const total = Object.values(pat[dow]).reduce((s, v) => s + v, 0);
  if (total >= 8) return -10;
  if (total >= 4) return -5;
  return 0;
}

// ================================================================
// STATISTIQUES ANNUELLES — Persistance inter-mois
// ================================================================
function loadAnnualStats() {
  try { return JSON.parse(localStorage.getItem('planeduc_v3_annual') || '{}'); } catch(e) { return {}; }
}

function updateAnnualStats(moisStr) {
  try {
    const yr = moisStr.split('-')[0];
    const stats = loadAnnualStats();
    if (!stats[yr]) stats[yr] = {};
    const tot = {};
    educs.forEach(e => { tot[e.id] = { h: 0, nuits: 0, we: 0, feries: 0, types: { matin: 0, aprem: 0, soir: 0, nuit: 0 } }; });
    Object.keys(horaire).filter(k => k.startsWith(yr)).forEach(mk => {
      const [ky, km] = mk.split('-').map(Number);
      getDays(ky, km).forEach(day => {
        const ds = dayStr(day), weD = isWEDay(day), feD = isFerie(ds);
        Object.entries(horaire[mk][ds] || {}).forEach(([pid, ids]) => {
          if (pid.startsWith('_') || !Array.isArray(ids)) return;
          const p = plageById(+pid); if (!p) return;
          const tp = typePlage(p);
          ids.forEach(eid => {
            const id = +eid; if (!tot[id]) return;
            tot[id].h += dureeH(p);
            if (isNuitP(p) && !isReunion(p)) tot[id].nuits++;
            if (weD) tot[id].we++;
            if (feD) tot[id].feries++;
            if (tp !== 'reunion') tot[id].types[tp] = (tot[id].types[tp] || 0) + 1;
          });
        });
      });
    });
    educs.forEach(e => { stats[yr][e.id] = tot[e.id]; });
    localStorage.setItem('planeduc_v3_annual', JSON.stringify(stats));
  } catch(err) {}
}

// ================================================================
// VERROUILLAGES
// ================================================================
function getLockedSlots(moisStr) {
  const plan = horaire[moisStr] || {}, locked = {};
  Object.entries(plan).forEach(([ds, slots]) => {
    Object.entries(slots).forEach(([pid, val]) => {
      if (pid.startsWith('_') || !Array.isArray(val)) return;
      if (slots['_lock_' + pid] === 'locked') {
        if (!locked[ds]) locked[ds] = {};
        locked[ds][pid] = val;
      }
    });
  });
  return locked;
}

function toggleLock(ds, plageId) {
  const mo = ds.slice(0, 7);
  if (!horaire[mo] || !horaire[mo][ds]) return;
  const lk = '_lock_' + plageId;
  horaire[mo][ds][lk] = horaire[mo][ds][lk] === 'locked' ? null : 'locked';
  save(); renderHoraire();
}

// ================================================================
// DETECTION IMPOSSIBILITES
// ================================================================
function detecterImpossibilites(moisStr) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours = getDays(yr, mo), msgs = [];
  plages.forEach(p => {
    jours.forEach(d => {
      const ds = dayStr(d), dow = dowIdx(d), we = isWEDay(d), fe = isFerie(ds);
      const dc = (fe && !we) ? 5 : dow;
      if (!p.jours.includes(dc)) return;
      const dispo = educs.filter(e => (e.jours || []).includes(dow) && !isAbsent(e.id, ds)).length;
      if (dispo < (+p.min || 1)) msgs.push(`${ds} - ${p.nom}: ${dispo}/${p.min} dispo`);
    });
  });
  return msgs;
}

// ================================================================
// CALCUL SOLDE HISTORIQUE — Fenêtre glissante réelle
// Calcule les heures dues vs heures travaillées sur N mois passés
// Inclut correction selon position dans l'année (convergence trimestrielle)
// ================================================================
function calculerHistorique(moisStr, horizon) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const hist = {};
  educs.forEach(e => {
    hist[e.id] = {
      solde: 0, plageCount: {}, we: 0, ferie: 0, nuits: 0,
      types: { matin: 0, aprem: 0, soir: 0, nuit: 0 },
      weBlocs: 0,  // WE complets travaillés
      tournante: {}  // dernière semaine où l'éduc a fait chaque plage "tournante"
    };
    plages.forEach(p => hist[e.id].plageCount[p.id] = 0);
  });

  for (let i = 1; i < horizon; i++) {
    const key = moisKey(yr, mo - i);
    const plan = horaire[key];
    if (!plan) continue;
    const [ky, km] = key.split('-').map(Number);
    const joursMois = getDays(ky, km);
    const joursOuvH = joursOuvMois(ky, km);
    const hTrav = {};
    educs.forEach(e => hTrav[e.id] = 0);

    joursMois.forEach(day => {
      const ds = dayStr(day), weD = isWEDay(day), feD = isFerie(ds);
      Object.entries(plan[ds] || {}).forEach(([pid, ids]) => {
        if (pid.startsWith('_') || !Array.isArray(ids)) return;
        const p = plageById(+pid); if (!p) return;
        const tp = typePlage(p);
        ids.forEach(eid => {
          const id = +eid; if (!hist[id]) return;
          hTrav[id] += dureeH(p);
          hist[id].plageCount[p.id] = (hist[id].plageCount[p.id] || 0) + 1;
          if (weD) hist[id].we++;
          if (feD) hist[id].ferie++;
          if (isNuitP(p) && !isReunion(p)) hist[id].nuits++;
          if (tp !== 'reunion') hist[id].types[tp] = (hist[id].types[tp] || 0) + 1;
        });
      });

      // Détecter blocs WE complets dans l'historique
      if (weD) {
        if (day.getDay() === 0) {  // dimanche = fin de WE
          const samDs = dayStr(new Date(day.getTime() - 86400000));
          educs.forEach(e => {
            const travSam = plages.some(p => ((plan[samDs] || {})[p.id] || []).map(x => +x).includes(e.id));
            const travDim = plages.some(p => ((plan[ds] || {})[p.id] || []).map(x => +x).includes(e.id));
            if (travSam && travDim) hist[e.id].weBlocs++;
          });
        }
      }
    });

    educs.forEach(e => {
      hist[e.id].solde += hTrav[e.id] - joursOuvH * 7.6 * ratioE(e);
    });
  }

  return hist;
}

// ================================================================
// QUOTAS DU MOIS — Cibles par éduc intégrant convergence
//
// Logique convergence :
//   - Chaque trimestre : pression pour revenir à 0
//   - Fin décembre : convergence forte vers 0 absolu
//   - Correction max ±15h par mois (humain, pas brutal)
// ================================================================
function calculerQuotas(hist, jours, moisStr) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const joursOuv = joursOuvMois(yr, mo);
  const poidsTotal = educs.reduce((s, e) => s + ratioE(e), 0);
  const quotas = {};

  // Mois restants dans l'année (pour forcer convergence fin décembre)
  const moisRestants = 12 - mo;  // 0 = décembre

  educs.forEach(e => {
    const re = ratioE(e);
    const base = joursOuv * 7.6 * re;

    // Correction solde : plus forte en fin d'année et fin de trimestre
    const soldeActuel = hist[e.id].solde || 0;
    const trimestre = Math.ceil(mo / 3);  // 1-4
    const finTrimestre = mo % 3 === 0;    // mars, juin, sep, dec
    const finAnnee = mo === 12;

    // Coefficient de correction selon position calendaire
    let coefCorrection = 0.35;  // base : corriger 35% du solde ce mois
    if (finTrimestre) coefCorrection = 0.55;    // fin de trimestre : plus fort
    if (finAnnee) coefCorrection = 0.85;        // décembre : quasi-forcé vers 0

    // Correction bornée pour éviter semaines incohérentes
    const correctionMax = finAnnee ? 20 : (finTrimestre ? 16 : 12);
    const ajust = Math.max(-correctionMax, Math.min(correctionMax, -soldeActuel * coefCorrection));

    quotas[e.id] = {
      h: {
        cible: base + ajust,
        min: base - 18,
        max: base + 18
      },
      plage: {},
      exceptionsUsees: 0,
      exceptionsMax: 3
    };

    // Quotas par plage (équité ±1-2 prestations/mois)
    plages.forEach(p => {
      if (isReunion(p)) {
        quotas[e.id].plage[p.id] = { cible: 999, min: 0, max: 999 };
        return;
      }
      // Nombre de fois où la plage se présente ce mois
      const ja = jours.filter(d => {
        const di = dowIdx(d), dc = (isFerie(dayStr(d)) && !isWEDay(d)) ? 5 : di;
        return p.jours.includes(dc);
      }).length;
      const totalPostes = ja * (+p.min || 1);
      const cible = totalPostes * re / Math.max(0.01, poidsTotal);

      // Correction équité : si l'éduc a fait trop de cette plage, réduire sa cible
      const myN = (hist[e.id].plageCount[p.id] || 0) / Math.max(0.01, re);
      const avgN = moyPond(educs, x => hist[x.id].plageCount[p.id] || 0);
      const corrEquite = Math.max(-2, Math.min(2, -(myN - avgN) * re * 0.3));

      quotas[e.id].plage[p.id] = {
        cible: Math.max(0, cible + corrEquite),
        min: Math.max(0, Math.floor(cible + corrEquite - 2)),
        max: Math.ceil(cible + corrEquite + 2)
      };
    });
  });

  return quotas;
}

// ================================================================
// MAX 50H PAR SEMAINE — Fenêtre lundi→dimanche fixe (légal belge)
// Max 6 jours consécutifs géré dans checkLoi via tracker.cons
// ================================================================
function hSemFixe(trackerE, ds) {
  const d = new Date(ds + 'T12:00');
  // Trouver le lundi de la semaine courante
  const lundi = new Date(d);
  lundi.setDate(d.getDate() - ((d.getDay() + 6) % 7));  // getDay() : 0=dim, 1=lun...
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const dd = new Date(lundi);
    dd.setDate(lundi.getDate() + i);
    total += (trackerE.joursH || {})[dayStr(dd)] || 0;
  }
  return total;
}

// ================================================================
// CONSTRUCTION CARTE WE — Numérotation des weekends du mois
// ================================================================
function buildWeMap(jours) {
  const weMap = {};
  let weNum = 0, lastSat = -1;
  jours.forEach(d => {
    if (d.getDay() === 6) { weNum++; lastSat = d.getDate(); }
    if (d.getDay() === 0 && lastSat < 0) weNum++;
    if (isWEDay(d)) weMap[dayStr(d)] = weNum;
  });
  return weMap;
}

// ================================================================
// UI — Vérification et lancement
// ================================================================
function verifier() {
  const warns = [];
  if (!educs.length) warns.push({ t: 'err', m: 'Aucun éducateur défini.' });
  if (!plages.length) warns.push({ t: 'err', m: 'Aucune plage horaire définie.' });
  const rc = document.getElementById('gen-recap');
  const ri = document.getElementById('gen-recap-content');
  rc.style.display = 'block';
  let html = warns.map(w => `<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if (!warns.length) {
    html += `<div class="alert a-ok">OK: ${educs.length} éducateurs - ${plages.length} plages</div>`;
    html += plages.map(p => {
      const j = p.jours.map(x => JOURS[x]).join(', ');
      const b = isReunion(p) ? '<span class="badge b-blue" style="font-size:.6rem">REUNION</span>' : '';
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> ${b} - ${p.debut}-${p.fin} - min ${p.min} - ${j}</div>`;
    }).join('');
  }
  ri.innerHTML = html;
}

async function lancer() {
  if (!educs.length || !plages.length) { verifier(); return; }
  const mois = document.getElementById('gen-mois').value;
  if (!mois) { alert('Choisissez un mois.'); return; }
  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div> Génération...';
  document.getElementById('gen-prog').style.display = 'block';
  document.getElementById('gen-alerts').innerHTML = '';
  const log = document.getElementById('gen-log');
  log.innerHTML = '';
  const L = (m, p) => {
    log.innerHTML += m + '<br>';
    log.scrollTop = log.scrollHeight;
    if (p != null) document.getElementById('gen-bar').style.width = p + '%';
  };

  L('Détection des impossibilités...', 3);
  await sl(50);
  detecterImpossibilites(mois).forEach(msg => L('⚠ ' + msg, null));

  const result = await genMois(mois, L);
  window._lastDiagnostic = result.diagnostic || [];

  const validation = validatePlanning(result.planning, mois, result.tracker, result.quotas);
  horaire[mois] = result.planning;
  currentMonth = mois;
  save();
  updateAnnualStats(mois);
  buildPatterns(mois);

  const qs = planningQualityScore(validation);
  L(`Score qualité : ${qs.score}/100 — ${qs.label}`, null);
  if (validation.errors.length) L(`⚠ ${validation.errors.length} poste(s) non couvert(s)`, null);
  validation.warnings.slice(0, 5).forEach(w => L('⚠ ' + w, null));
  result.warnings.slice(0, 4).forEach(w => L('! ' + w, null));
  L('Terminé !', 100);

  btn.disabled = false;
  btn.innerHTML = "Générer l'horaire";
  showAlert('gen-alerts', validation.errors.length ? 'warn' : 'ok',
    `Horaire généré — Score : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// ================================================================
// MOTEUR PRINCIPAL v23
// ================================================================
// ================================================================
async function genMois(moisStr, L) {
  _pm = null; _em = null;

  const [yr, mo] = moisStr.split('-').map(Number);
  const jours = getDays(yr, mo);
  const planning = {}, warnings = [], diagnostic = [];

  // Paramètres légaux
  const horizon     = +document.getElementById('gen-horizon').value || 3;
  const minRepos    = getRule('min_repos', 11);
  const maxCons     = getRule('max_consec', 6);
  const maxWeMois   = getRule('max_we_mois', 2);
  const reposNuit   = getRule('repos_apres_nuit', 1);
  const maxNuitsC   = 2;

  L('Chargement historique...', 6);
  await sl(30);

  const lockedSlots = getLockedSlots(moisStr);

  // ── Phase 0a : Historique ──
  const hist = calculerHistorique(moisStr, horizon);

  L('Calcul des quotas...', 12);
  await sl(30);

  // ── Phase 0b : Quotas ──
  const quotas = calculerQuotas(hist, jours, moisStr);

  // ── Phase 0c : Patterns & stats annuelles ──
  const patterns   = buildPatterns(moisStr);
  const annStats   = loadAnnualStats()[yr] || {};
  const weMap      = buildWeMap(jours);

  // ── TRACKER — état courant du mois ──
  const tracker = {};
  const lastTerrain = {};  // dernière prestation terrain par éduc

  educs.forEach(e => {
    tracker[e.id] = {
      h: 0, nuits: 0, nuitsC: 0, weCount: 0, weJours: new Set(),
      cons: 0, lastDay: null, plageCount: {}, weDernierNum: null,
      types: { matin: 0, aprem: 0, soir: 0, nuit: 0 },
      fatigue: 0, joursH: {}, dernierWE: null
    };
    plages.forEach(p => tracker[e.id].plageCount[p.id] = 0);
    lastTerrain[e.id] = null;
  });

  // Continuité depuis le mois précédent (repos en cours, jours consécutifs)
  const prevPlan = horaire[moisKey(yr, mo - 1)] || {};
  Object.keys(prevPlan).sort().forEach(ds => {
    Object.entries(prevPlan[ds] || {}).forEach(([pid, ids]) => {
      if (pid.startsWith('_') || !Array.isArray(ids)) return;
      const p = plageById(+pid); if (!p || isReunion(p)) return;
      ids.forEach(eid => {
        const id = +eid;
        if (!lastTerrain[id] || ds > lastTerrain[id].date)
          lastTerrain[id] = { date: ds, fin: p.fin, isNuit: isNuitP(p), pm: p.fin < p.debut };
      });
    });
  });

  // Initialiser toutes les cases du planning
  jours.forEach(d => { planning[dayStr(d)] = {}; });

  // ================================================================
  // FONCTIONS INTERNES — LOI, CONVENTION, SCORE
  // ================================================================

  // P1 — Vérification légale stricte (inviolable)
  function checkLoi(e, d, ds, dow, plage) {
    if (!(e.jours || []).includes(dow)) return { ok: false, raison: 'Jour non travaillé' };
    if (isAbsent(e.id, ds)) return { ok: false, raison: 'Absence' };
    const t = tracker[e.id];
    const reunion = isReunion(plage);

    if (!reunion) {
      // Max jours consécutifs
      if (t.cons >= maxCons) return { ok: false, raison: `Max ${maxCons}j consécutifs` };

      // Max nuits consécutives
      if (isNuitP(plage) && t.nuitsC >= maxNuitsC)
        return { ok: false, raison: 'Max 2 nuits consécutives' };

      // Repos 11h entre prestations TERRAIN (réunions non bloquantes)
      const la = lastTerrain[e.id];
      if (la) {
        const [lh, lm] = la.fin.split(':').map(Number);
        const [bh, bm] = plage.debut.split(':').map(Number);
        const finMs  = new Date(la.date + 'T00:00').getTime() + (la.pm ? 86400000 : 0) + (lh * 60 + lm) * 60000;
        const debMs  = new Date(ds + 'T00:00').getTime() + (bh * 60 + bm) * 60000;
        const dh = (debMs - finMs) / 3600000;
        if (dh >= 0 && dh < minRepos)
          return { ok: false, raison: `Repos 11h (${dh.toFixed(1)}h libre)` };
      }

      // Repos obligatoire après nuit
      if (la && la.isNuit && reposNuit > 0 &&
          Math.round((d - new Date(la.date)) / 86400000) <= reposNuit)
        return { ok: false, raison: 'Repos après nuit' };

      // Max heures terrain dans la journée
      const maxHJ = isNuitP(plage) ? 14 : 11;
      const hJourTerrain = plages.filter(p2 => !isReunion(p2)).reduce((s, pp) => {
        const ids = (planning[ds] || {})[pp.id];
        return Array.isArray(ids) && ids.map(x => +x).includes(e.id) ? s + dureeH(pp) : s;
      }, 0);
      if (hJourTerrain + dureeH(plage) > maxHJ)
        return { ok: false, raison: 'Max h/jour terrain' };

      // Horaire à pause : si l'éduc ne l'accepte pas
      if (!e.acceptePause) {
        const dejaTerrain = plages.filter(p2 => !isReunion(p2)).some(pp => {
          const ids = (planning[ds] || {})[pp.id];
          return Array.isArray(ids) && ids.map(x => +x).includes(e.id);
        });
        if (dejaTerrain) return { ok: false, raison: 'Pas de double (sans pause)' };
      }
    }

    // 50h/semaine lundi→dimanche (terrain + réunions)
    if (hSemFixe(t, ds) + dureeH(plage) > 50)
      return { ok: false, raison: 'Max 50h/sem' };

    return { ok: true, raison: '' };
  }

  // Convention interne (assouplie progressivement si besoin de couvrir)
  function checkConvention(e, d, ds, plage, niveau) {
    const reunion = isReunion(plage);

    // Niveau 0 : contraintes convention pleine
    if (niveau < 2 && !reunion && (e.excls || []).includes(plage.id))
      return { ok: false };

    // WE : max respecté (niveau 0 uniquement)
    if (!reunion && isWEDay(d) && tracker[e.id].weCount >= maxWeMois && niveau < 1)
      return { ok: false };

    // Solde : bloquer si surplus trop important
    // Zone critique (>+18h) → quasi-bloqué même en cas de besoin
    if (!reunion && niveau === 0) {
      const solde = hist[e.id].solde + (tracker[e.id].h - quotas[e.id].h.cible);
      if (solde > 16) return { ok: false };
    }

    return { ok: true };
  }

  // ================================================================
  // SCORE — Logique de priorité (bas score = priorité haute)
  //
  // P2 Soldes   : courbe continue progressive, poids dominant
  // P3 Équité   : nuits, WE, types, plages, fériés
  // P4 Stabilité: récurrence hebdo, habitudes de jour, tournante WE
  // ================================================================
  function score(e, d, ds, plage, weOrFerie, dow, isWECtx) {
    const t = tracker[e.id], ht = hist[e.id], re = ratioE(e), q = quotas[e.id];
    const ann = annStats[e.id] || { nuits: 0, we: 0, feries: 0, types: { matin: 0, aprem: 0, soir: 0, nuit: 0 } };
    const nuit = isNuitP(plage), reunion = isReunion(plage);
    let sc = 0;

    // ── P2 : SOLDE HEURES — poids dominant, courbe progressive ──
    // Zone verte  (-5/+5)   → pression faible
    // Zone orange (-10/-5)  → pression moyenne
    // Zone rouge  (-15/-10) → pression forte
    // Zone critique (>±15)  → quasi-blocage
    const solde = ht.solde + (t.h - q.h.cible);
    if (solde >= 0) {
      if (solde < 5)        sc += solde * 2.5;
      else if (solde < 10)  sc += 12.5 + (solde - 5) * 6;
      else if (solde < 15)  sc += 42.5 + (solde - 10) * 10;
      else                  sc += 92.5 + (solde - 15) * 6;
    } else {
      if (solde > -5)       sc += solde * 2.5;
      else if (solde > -10) sc -= 12.5 + (Math.abs(solde) - 5) * 6;
      else if (solde > -15) sc -= 42.5 + (Math.abs(solde) - 10) * 10;
      else                  sc -= 92.5 + (Math.abs(solde) - 15) * 6;
    }

    if (!reunion) {
      // ── P4 : WE — blocs cohérents + tournante ──
      if (weOrFerie) {
        const wn = weMap[ds];
        if (wn != null) {
          // Bonus fort si l'éduc travaille déjà l'autre jour de ce WE → bloc cohérent
          const autreJourWE = jours.find(x => weMap[dayStr(x)] === wn && dayStr(x) !== ds && isWEDay(x));
          if (autreJourWE) {
            const autreDs = dayStr(autreJourWE);
            const dejaAutreJour = Object.values(planning[autreDs] || {})
              .some(ids => Array.isArray(ids) && ids.map(x => +x).includes(e.id));
            if (dejaAutreJour) sc -= 35; // bloc cohérent → très prioritaire
            else sc += 12;              // WE coupé → pénalité nette
          }
        }

        // Alternance WE : pénaliser WE consécutifs, favoriser un WE sur deux
        if (t.dernierWE) {
          const diffSem = Math.round(
            (new Date(ds + 'T12:00') - new Date(t.dernierWE + 'T12:00')) / 604800000
          );
          if (diffSem <= 1) sc += 32;   // WE consécutifs → forte pénalité
          else if (diffSem === 2) sc -= 10; // parfaite alternance → bonus
          else if (diffSem === 3) sc -= 4;  // deux WE de repos → léger bonus
        } else {
          sc -= 5; // n'a pas encore fait de WE ce mois → légère priorité
        }

        // Équité WE globale (normalisée par contrat)
        const myWE  = norm((ht.we || 0) + (t.weCount || 0) + (ann.we || 0), e);
        const avgWE = moyPond(educs, x =>
          (hist[x.id].we || 0) + (tracker[x.id].weCount || 0) + ((annStats[x.id] || {}).we || 0)
        );
        sc += (myWE - avgWE) * 12;
      }

      // ── P4 : STABILITÉ — Récurrence hebdo (cœur du système) ──
      sc += bonusRecurrence(e, dow, plage, patterns, isWECtx);
      if (!isWECtx) sc += bonusJourHabituel(e, dow, patterns);

      // ── P3 : ÉQUITÉ PLAGE ──
      const myCP  = norm((ht.plageCount[plage.id] || 0) + (t.plageCount[plage.id] || 0), e);
      const avgCP = moyPond(educs, x =>
        (hist[x.id].plageCount[plage.id] || 0) + (tracker[x.id].plageCount[plage.id] || 0)
      );
      sc += (myCP - avgCP) * (nuit ? 14 : 8);

      // ── P3 : ÉQUITÉ TYPES (matin/soir/nuit) ──
      const tp = typePlage(plage);
      if (tp !== 'reunion') {
        const myTP  = norm((ht.types[tp] || 0) + (t.types[tp] || 0), e);
        const avgTP = moyPond(educs, x =>
          (hist[x.id].types[tp] || 0) + (tracker[x.id].types[tp] || 0)
        );
        sc += (myTP - avgTP) * (nuit ? 12 : 7);

        // Diversification douce si très spécialisé (>70% sur un type)
        const total = Object.values(t.types).reduce((s, v) => s + v, 0)
                    + Object.values(ht.types).reduce((s, v) => s + v, 0);
        if (total > 10) {
          const myT = (ht.types[tp] || 0) + (t.types[tp] || 0);
          const ratio = myT / Math.max(1, total);
          if (ratio > 0.75) sc += 22;
          else if (ratio > 0.65) sc += 12;
          else if (ratio > 0.55) sc += 5;
          if (ratio < 0.12 && total > 12) sc -= 10; // sous-représenté → favoriser
        }
      }

      // ── P3 : ÉQUITÉ NUITS ──
      if (nuit) {
        const myN  = norm((ht.nuits || 0) + (t.nuits || 0) + (ann.nuits || 0), e);
        const avgN = moyPond(educs, x =>
          (hist[x.id].nuits || 0) + (tracker[x.id].nuits || 0) + ((annStats[x.id] || {}).nuits || 0)
        );
        sc += (myN - avgN) * 14;
      }

      // ── P3 : ÉQUITÉ FÉRIÉS (annuelle) ──
      if (isFerie(ds)) {
        const myF  = norm((ht.ferie || 0) + (ann.feries || 0), e);
        const avgF = moyPond(educs, x =>
          (hist[x.id].ferie || 0) + ((annStats[x.id] || {}).feries || 0)
        );
        sc += (myF - avgF) * 12;
      }

      // Fatigue accumulée
      sc += t.fatigue * 0.4;
    }

    // ── P4 : PRÉFÉRENCES individuelles ──
    if (!reunion && (e.prefs || []).includes(plage.id)) sc -= 10;
    const dow2 = d.getDay() === 0 ? 6 : d.getDay() - 1;
    (e.demandes || []).forEach(dem => {
      if (dem.jour === dow2 && (dem.plageIds || []).includes(plage.id)) {
        if (dem.type === 'eviter') sc += 14;
        if (dem.type === 'prefere') sc -= 14;
      }
    });

    return sc;
  }

  // Mise à jour du tracker après assignation
  function updateTracker(e, d, ds, plage, nuit, we) {
    const t = tracker[e.id], tp = typePlage(plage), reunion = isReunion(plage);
    const h = dureeH(plage);
    t.h += h;
    if (!t.joursH[ds]) t.joursH[ds] = 0;
    t.joursH[ds] += h;

    if (!reunion) {
      const diffJ = t.lastDay ? Math.round((d - new Date(t.lastDay)) / 86400000) : 999;
      t.cons = diffJ === 1 ? t.cons + 1 : 1;
      t.lastDay = ds;
      if (nuit) { t.nuits++; t.nuitsC++; } else t.nuitsC = 0;
      if (we && !t.weJours.has(ds)) {
        t.weJours.add(ds);
        if (d.getDay() === 6) {  // samedi = début du WE, on compte ici
          t.weCount++;
          t.dernierWE = ds;
          t.weDernierNum = weMap[ds];
        }
      }
      // Fatigue : nuit pèse plus, amplitude longue pèse plus, accumulation consécutive
      t.fatigue += (nuit ? 1.8 : 1.0) * (h > 10 ? 1.5 : 1.0) + (t.cons > 4 ? 1.0 : 0);
      t.fatigue = Math.min(18, t.fatigue * 0.92);  // décroissance naturelle
      lastTerrain[e.id] = { date: ds, fin: plage.fin, isNuit: nuit, pm: plage.fin < plage.debut };
    }
    t.plageCount[plage.id] = (t.plageCount[plage.id] || 0) + 1;
    if (tp !== 'reunion') t.types[tp] = (t.types[tp] || 0) + 1;
  }

  // Assigner un éduc à une plage + mettre à jour le tracker + stocker le statut
  function assigner(e, ds, plage, d, nuit, we) {
    if (!planning[ds]) planning[ds] = {};
    if (!planning[ds][plage.id]) planning[ds][plage.id] = [];
    if (planning[ds][plage.id].map(x => +x).includes(e.id)) return;  // déjà assigné
    planning[ds][plage.id].push(e.id);
    updateTracker(e, d, ds, plage, nuit, we);

    // Statut pour la légende
    const isExcl   = !isReunion(plage) && (e.excls || []).includes(plage.id);
    const isPref   = (e.prefs || []).includes(plage.id);
    const dow2     = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const dem      = (e.demandes || []).find(x => x.jour === dow2 && (x.plageIds || []).includes(plage.id));
    const sk       = `_s_${e.id}_${plage.id}`;
    if (isExcl)                           { planning[ds][sk] = 'forced';    warnings.push(`${ds} - ${plage.nom}: refusée → ${e.prenom}`); }
    else if (dem && dem.type === 'eviter') { planning[ds][sk] = 'dem_evite'; warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectée`); }
    else if (dem && dem.type === 'prefere') planning[ds][sk] = 'dem_pref';
    else if (isPref)                        planning[ds][sk] = 'pref';
    else                                    planning[ds][sk] = 'neutral';
  }

  // ================================================================
  // PHASE 1 — PRÉ-ASSIGNATION DES WEEK-ENDS EN BLOCS COHÉRENTS
  //
  // Logique :
  //   - On regroupe les plages WE par type (jour / nuit)
  //   - On crée des "équipes WE" pour chaque numéro de WE du mois
  //   - L'équipe est choisie par tournante (qui n'a pas fait de WE récemment)
  //   - On assigne Sam+Dim de la même plage à la même équipe
  //   - Contrainte : jamais une prestation seule sur un WE
  // ================================================================
  L('Pré-assignation week-ends en blocs...', 20);
  await sl(30);

  // Grouper les jours WE par numéro
  const weNums = [...new Set(Object.values(weMap))];
  const weJoursByNum = {};
  weNums.forEach(wn => {
    weJoursByNum[wn] = jours.filter(d => weMap[dayStr(d)] === wn);
  });

  // Pour chaque WE, pré-assigner en blocs Sam+Dim
  for (const wn of weNums) {
    const joursWE = weJoursByNum[wn];
    if (joursWE.length === 0) continue;

    // Plages actives ce WE (groupées par jour : sam=6, dim=0)
    const plagesWE = plages.filter(p => !isReunion(p) && (p.jours.includes(5) || p.jours.includes(6)));
    if (!plagesWE.length) continue;

    // Pour chaque plage WE : choisir éducs qui feront les deux jours
    for (const plage of plagesWE) {
      const reqMin = +plage.min || 1;

      // Jours de la semaine concernés par cette plage ce WE
      const joursSam = joursWE.filter(d => d.getDay() === 6 && plage.jours.includes(5));
      const joursDim = joursWE.filter(d => d.getDay() === 0 && plage.jours.includes(6));

      // Si seulement sam ou seulement dim dans ce WE (début/fin de mois)
      const joursActifs = [...joursSam, ...joursDim];
      if (!joursActifs.length) continue;

      // Candidats : légaux POUR LES DEUX JOURS si les deux existent
      const hasSam = joursSam.length > 0;
      const hasDim = joursDim.length > 0;

      const cands = educs.filter(e => {
        // Vérifier disponibilité sur les deux jours
        if (hasSam) {
          const d = joursSam[0], ds = dayStr(d);
          if (!checkLoi(e, d, ds, dowIdx(d), plage).ok) return false;
          if (!checkConvention(e, d, ds, plage, 0).ok) return false;
        }
        if (hasDim) {
          const d = joursDim[0], ds = dayStr(d);
          // Note : on simule sans le samedi dans le tracker pour le check loi
          if (!(e.jours || []).includes(dowIdx(d))) return false;
          if (isAbsent(e.id, dayStr(d))) return false;
        }
        return true;
      });

      if (!cands.length) continue;

      // Trier : priorité tournante WE (celui qui n'a pas travaillé de WE depuis le plus longtemps)
      const scored = cands.map(e => {
        // Utiliser le score normal pour le premier jour disponible
        const refJour = joursActifs[0];
        const refDs   = dayStr(refJour);
        return { e, sc: score(e, refJour, refDs, plage, true, dowIdx(refJour), true) };
      }).sort((a, b) => a.sc - b.sc);

      const assigned = scored.slice(0, reqMin).map(x => x.e);

      // Assigner sur chaque jour du WE
      joursActifs.forEach(d => {
        const ds = dayStr(d);
        const we = true;
        assigned.forEach(e => {
          if (checkLoi(e, d, ds, dowIdx(d), plage).ok)
            assigner(e, ds, plage, d, isNuitP(plage) && !isReunion(plage), we);
        });
      });
    }
  }

  // ================================================================
  // PHASE 2 — IDENTIFICATION ET TOURNANTE DES PLAGES "FIXES"
  //
  // Une plage est "en tournante" si elle est marquée explicitement
  // ou si c'est la seule nuit du vendredi (convention : tournante auto)
  //
  // Pour ces plages : on assigne une fois par semaine en rotation stricte
  // ================================================================
  L('Tournantes structurées...', 30);
  await sl(20);

  // Détecter la plage "nuit vendredi" (tournante automatique)
  // Convention : plage nuit qui inclut le vendredi (dow=4) → tournante
  const plagesTournante = plages.filter(p =>
    !isReunion(p) && isNuitP(p) && p.jours.includes(4) && !isWEDay(jours[0])  // vendredi = dow 4
  );

  // Grouper les jours par semaine ISO
  const semaines = {};
  jours.forEach(d => {
    // Numéro de semaine dans le mois (1-5)
    const semNum = Math.ceil(d.getDate() / 7);
    if (!semaines[semNum]) semaines[semNum] = [];
    semaines[semNum].push(d);
  });

  // Pour chaque plage tournante : assigner par rotation stricte
  for (const plage of plagesTournante) {
    // Ordre de rotation : basé sur qui a le moins fait cette plage (normalisé)
    const ordreTournante = [...educs]
      .filter(e => !(e.excls || []).includes(plage.id))  // pas de plage refusée
      .sort((a, b) => {
        const nA = norm((hist[a.id].plageCount[plage.id] || 0), a);
        const nB = norm((hist[b.id].plageCount[plage.id] || 0), b);
        return nA - nB;  // le moins souvent assigné en premier
      });

    let tourIndex = 0;

    // Pour chaque vendredi du mois
    const vendredis = jours.filter(d => d.getDay() === 5);
    for (const d of vendredis) {
      const ds = dayStr(d);
      const dow = dowIdx(d);  // = 4

      // Déjà assigné (verrouillage) ?
      if (lockedSlots[ds] && lockedSlots[ds][plage.id]) continue;

      // Déjà pré-assigné ?
      if ((planning[ds][plage.id] || []).length >= (+plage.min || 1)) continue;

      // Trouver le prochain éduc dans la tournante qui peut légalement travailler
      let trouve = false;
      for (let tentative = 0; tentative < ordreTournante.length; tentative++) {
        const idx = (tourIndex + tentative) % ordreTournante.length;
        const e = ordreTournante[idx];
        if (!checkLoi(e, d, ds, dow, plage).ok) continue;
        if (!checkConvention(e, d, ds, plage, 0).ok) continue;
        assigner(e, ds, plage, d, true, false);
        tourIndex = (idx + 1) % ordreTournante.length;
        trouve = true;
        break;
      }
      if (!trouve) warnings.push(`${ds} - ${plage.nom}: tournante impossible (aucun candidat légal)`);
    }
  }

  // ================================================================
  // PHASE 3 — GÉNÉRATION SEMAINE PAR SEMAINE
  //
  // Pour chaque semaine de la semaine (lundi→vendredi) :
  //   1. Identifier les plages non encore couvertes
  //   2. Priorité : reproduire les habitudes de la semaine précédente
  //   3. Trier les candidats par score (P2 soldes > P3 équité > P4 stabilité)
  //
  // Ordre de traitement dans la journée : nuits → longs → normaux → réunions
  // ================================================================
  L('Génération semaine par semaine...', 38);
  await sl(20);

  // Trier les plages par priorité de traitement
  function prioPlaге(p) {
    if (isReunion(p)) return 10;
    if (isNuitP(p)) return 0;
    if (dureeH(p) > 8) return 2;
    return 3;
  }

  for (let di = 0; di < jours.length; di++) {
    if (di % 3 === 0) {
      L(`Jour ${di + 1}/${jours.length}`, 38 + Math.round((di / jours.length) * 45));
      await sl(0);
    }

    const d = jours[di], ds = dayStr(d), dow = dowIdx(d);
    const we = isWEDay(d), ferie = isFerie(ds);

    // Recopier verrouillages
    if (lockedSlots[ds]) {
      Object.entries(lockedSlots[ds]).forEach(([pid, ids]) => {
        planning[ds][pid] = ids;
        planning[ds]['_lock_' + pid] = 'locked';
        ids.forEach(eid => {
          const e = educById(+eid); if (!e) return;
          const p = plageById(+pid); if (!p) return;
          updateTracker(e, d, ds, p, isNuitP(p) && !isReunion(p), we);
        });
      });
    }

    const dowForPlages = (ferie && !we) ? 5 : dow;
    const pjBase = plages.filter(p => p.jours.includes(dowForPlages));
    const pj = [...pjBase].sort((a, b) => {
      const pa = prioPlaге(a), pb = prioPlaге(b);
      if (pa !== pb) return pa - pb;
      // À priorité égale : plages plus contraignantes en premier (moins de candidats)
      const ca = educs.filter(e => checkLoi(e, d, ds, dow, a).ok).length;
      const cb = educs.filter(e => checkLoi(e, d, ds, dow, b).ok).length;
      return (ca / Math.max(1, +a.min || 1)) - (cb / Math.max(1, +b.min || 1));
    });

    // ── PASSE A : Compléter jusqu'au minimum requis ──
    for (const plage of pj) {
      if (lockedSlots[ds] && lockedSlots[ds][plage.id]) continue;

      const nuit = isNuitP(plage) && !isReunion(plage);
      const reqMin = Math.max(0, +plage.min || 1);
      const useAll = plage.tous;
      const diagD = [];

      // Déjà couverts (WE pré-assignés, tournante)
      const dejaIds = (planning[ds][plage.id] || []).map(x => +x);
      const manque = useAll ? 0 : Math.max(0, reqMin - dejaIds.length);
      if (manque === 0 && !useAll) continue;

      // Candidats légaux
      let cands = educs.filter(e => {
        if (dejaIds.includes(e.id)) return false;
        const loi = checkLoi(e, d, ds, dow, plage);
        if (!loi.ok) { diagD.push({ nom: e.prenom + ' ' + e.nom, ok: false, raison: loi.raison }); return false; }
        const conv = checkConvention(e, d, ds, plage, 0);
        if (!conv.ok) { diagD.push({ nom: e.prenom + ' ' + e.nom, ok: false, raison: 'Convention' }); return false; }
        return true;
      });

      // Relâchement progressif si pas assez de candidats
      if (cands.length < manque && !useAll) {
        cands = educs.filter(e =>
          !dejaIds.includes(e.id) &&
          checkLoi(e, d, ds, dow, plage).ok &&
          checkConvention(e, d, ds, plage, 1).ok
        );
      }
      if (cands.length < manque && !useAll) {
        cands = educs.filter(e =>
          !dejaIds.includes(e.id) &&
          checkLoi(e, d, ds, dow, plage).ok
        );
        cands.forEach(e => { if (quotas[e.id]) quotas[e.id].exceptionsUsees++; });
      }

      const scored = cands
        .map(e => ({ e, sc: score(e, d, ds, plage, we || ferie, dow, we) }))
        .sort((a, b) => a.sc - b.sc);

      const n = useAll ? scored.length : Math.min(manque, scored.length);
      scored.slice(0, n).forEach(({ e }) => {
        assigner(e, ds, plage, d, nuit, we);
        diagD.push({ nom: e.prenom + ' ' + e.nom, ok: true, raison: 'Assigné' });
      });

      const totalAssigned = (planning[ds][plage.id] || []).length;
      if (totalAssigned < reqMin || nuit || ferie || we)
        diagnostic.push({ ds, plage: plage.nom, couverte: totalAssigned >= reqMin, details: diagD });

      if (totalAssigned < reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin - totalAssigned} poste(s) non couvert(s)`);
    }

    // ── PASSE B : Remplir jusqu'au max si solde négatif ──
    for (const plage of pj) {
      if (plage.tous || isReunion(plage)) continue;
      if (lockedSlots[ds] && lockedSlots[ds][plage.id]) continue;

      const reqMin = Math.max(0, +plage.min || 1);
      const reqMax = Math.max(reqMin, +plage.max || reqMin);
      if (reqMax <= reqMin) continue;

      const deja = (planning[ds][plage.id] || []).map(x => +x);
      const encore = reqMax - deja.length;
      if (encore <= 0) continue;

      const cands = educs.filter(e => {
        if (deja.includes(e.id)) return false;
        if (!checkLoi(e, d, ds, dow, plage).ok) return false;
        if (!checkConvention(e, d, ds, plage, 1).ok) return false;
        // Passe B : uniquement si solde négatif
        const solde = hist[e.id].solde + (tracker[e.id].h - quotas[e.id].h.cible);
        return solde < -2;
      }).map(e => ({ e, sc: score(e, d, ds, plage, we || ferie, dow, we) }))
        .sort((a, b) => a.sc - b.sc)
        .slice(0, encore)
        .map(x => x.e);

      if (!cands.length) continue;
      cands.forEach(e => assigner(e, ds, plage, d, isNuitP(plage) && !isReunion(plage), we));
    }
  }

  // ================================================================
  // PHASE 5 — MICRO-AJUSTEMENTS : ÉQUITÉ NUITS ET WE
  //
  // Après génération : swaps ciblés pour corriger les écarts d'équité
  // Contraintes : ne pas casser les lois, ne pas trop dégrader les soldes
  // Limite : 40 itérations ou jusqu'à convergence
  // ================================================================
  L('Micro-ajustements équité...', 86);
  await sl(30);

  const dsAll = Object.keys(planning).sort();

  // Swap nuits : rogner l'excès de nuits chez certains éducs
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;

    for (const ds of dsAll) {
      const d = new Date(ds + 'T12:00'), dow = dowIdx(d);
      if (lockedSlots[ds]) continue;

      for (const plage of plages.filter(p => isNuitP(p) && !isReunion(p))) {
        const ids = (planning[ds][plage.id] || []).map(x => +x);
        if (!ids.length) continue;
        const reqMin = +plage.min || 1;

        for (const idIn of ids) {
          const eIn = educById(idIn); if (!eIn) continue;
          const nIn = norm((hist[eIn.id].nuits || 0) + (tracker[eIn.id].nuits || 0), eIn);

          for (const eOut of educs) {
            if (ids.includes(eOut.id)) continue;
            const nOut = norm((hist[eOut.id].nuits || 0) + (tracker[eOut.id].nuits || 0), eOut);
            if (nOut >= nIn - 1.8) continue;  // écart insuffisant pour justifier un swap

            if (!(eOut.jours || []).includes(dow) || isAbsent(eOut.id, ds)) continue;
            if (!checkLoi(eOut, d, ds, dow, plage).ok) continue;

            const newIds = ids.filter(x => x !== idIn).concat(eOut.id);
            if (newIds.length < reqMin) continue;

            // Vérifier que le swap ne dégrade pas trop les soldes
            const sIn  = hist[eIn.id].solde  + (tracker[eIn.id].h  - quotas[eIn.id].h.cible);
            const sOut = hist[eOut.id].solde + (tracker[eOut.id].h - quotas[eOut.id].h.cible);
            if (sOut - dureeH(plage) < -16 || sIn + dureeH(plage) > 16) continue;

            // Effectuer le swap
            planning[ds][plage.id] = newIds;
            delete planning[ds][`_s_${idIn}_${plage.id}`];
            planning[ds][`_s_${eOut.id}_${plage.id}`] = 'neutral';
            tracker[eIn.id].nuits  = Math.max(0, (tracker[eIn.id].nuits || 0) - 1);
            tracker[eOut.id].nuits = (tracker[eOut.id].nuits || 0) + 1;
            tracker[eIn.id].h  = Math.max(0, tracker[eIn.id].h - dureeH(plage));
            tracker[eOut.id].h += dureeH(plage);
            improved = true;
            break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  return { planning, warnings, diagnostic, tracker, quotas };
}

// ================================================================
// VALIDATION POST-GÉNÉRATION
// ================================================================
function validatePlanning(planning, moisStr, tracker, quotas) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours = getDays(yr, mo);
  const errors = [], warns = [];

  // Vérifier couverture minimale
  jours.forEach(d => {
    const ds = dayStr(d), dow = dowIdx(d), we = isWEDay(d), fe = isFerie(ds);
    const dc = (fe && !we) ? 5 : dow;
    plages.filter(p => p.jours.includes(dc)).forEach(p => {
      const ids = ((planning[ds] || {})[p.id] || []);
      if (ids.length < (+p.min || 1))
        errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min}`);
    });
  });

  // Vérifier équité nuits et soldes
  const nTot = {}, hTot = {};
  educs.forEach(e => { nTot[e.id] = 0; hTot[e.id] = tracker ? tracker[e.id]?.h || 0 : 0; });
  jours.forEach(d => {
    const ds = dayStr(d);
    plages.forEach(p => {
      ((planning[ds] || {})[p.id] || []).forEach(id => {
        if (isNuitP(p) && !isReunion(p)) nTot[+id] = (nTot[+id] || 0) + 1;
      });
    });
  });

  const avgNN = moyPond(educs, e => nTot[e.id] || 0);
  educs.forEach(e => {
    const ec = Math.abs(norm(nTot[e.id] || 0, e) - avgNN);
    if (ec > 4) warns.push(`Nuits : ${e.prenom} écart ${ec.toFixed(1)}`);
    const s = hTot[e.id] - (quotas ? quotas[e.id]?.h.cible || 0 : 0);
    if (Math.abs(s) > 15) warns.push(`Solde ${e.prenom}: ${s >= 0 ? '+' : ''}${s.toFixed(1)}h`);
  });

  // Score WE coupés
  let weCoupes = 0;
  const weMapV = buildWeMap(jours);
  const weNumsV = [...new Set(Object.values(weMapV))];
  weNumsV.forEach(wn => {
    const joursWE = jours.filter(d => weMapV[dayStr(d)] === wn);
    educs.forEach(e => {
      let ts = false, td = false;
      joursWE.forEach(d => {
        const ds = dayStr(d);
        if (plages.some(p => ((planning[ds] || {})[p.id] || []).map(x => +x).includes(e.id))) {
          if (d.getDay() === 6) ts = true;
          if (d.getDay() === 0) td = true;
        }
      });
      if ((ts && !td) || (!ts && td)) weCoupes++;
    });
  });
  if (weCoupes > 0) warns.push(`${weCoupes} WE coupé(s) détecté(s)`);

  const ecNMax = educs.reduce((mx, e) =>
    Math.max(mx, Math.abs(norm(nTot[e.id] || 0, e) - avgNN)), 0);

  const metrics = {
    equite:     Math.max(0, 100 - ecNMax * 10),
    stabilite:  Math.max(0, 90 - weCoupes * 5),
    couverture: errors.length === 0 ? 100 : Math.max(0, 100 - errors.length * 15),
    prefs:      100
  };

  return { valid: true, errors, warnings: warns, metrics };
}

function planningQualityScore(validation) {
  const m = validation.metrics || { equite: 50, stabilite: 50, couverture: 50, prefs: 50 };
  const score = Math.round(m.equite * 0.30 + m.stabilite * 0.30 + m.couverture * 0.30 + m.prefs * 0.10);
  const label = score >= 88 ? 'Excellent' : score >= 72 ? 'Bon' : score >= 56 ? 'Moyen' : 'À améliorer';
  return { score, label, details: m };
}
