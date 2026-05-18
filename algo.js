// ============================================================
// algo.js — PlanEduc Pro v24
// ============================================================
//
// ARCHITECTURE : logique réelle d'un chef éducateur expérimenté
//
// GROUPES D'ÉQUITÉ :
//   G1 — Lever       : tous les levers lun→ven (même pool)
//   G2 — Fin journée : soir lun/mar/mer/jeu + aprem vendredi (même pool)
//   G3 — Nuit ven    : tournante stricte semaine par semaine
//   G4 — Nuit sem    : nuits lun/mar/mer/jeu (même pool)
//   G5 — Journée WE  : sam+dim journée (même pool)
//   G6 — Nuit WE     : sam+dim nuit (même pool)
//   G7 — Réunion     : comptée séparément
//
// ORDRE DE CONSTRUCTION (gravé, jamais écrasé) :
//   C1 — Tournante WE    : blocs sam+dim (J+J ou N+N), cycle auto
//   C2 — Nuit vendredi   : tournante stricte 1 éduc/semaine
//   C3 — Nuits semaine   : lun→jeu, cycle fixe
//   C4 — Levers          : cycle fixe
//   C5 — Fins de journée : cycle fixe
//   C6 — Réunions        : fixes
//
// FILTRES (ne cassent jamais les cycles) :
//   P1 — LOI      : repos 11h terrain, 50h/sem lun→dim, max 6j consécutifs,
//                   max 2 nuits consécutives, repos 1j après nuit
//   P2 — SOLDES   : convergence trimestrielle, zéro en décembre
//   P3 — ÉQUITÉ   : groupes, fériés annuels
// ============================================================

// ── Détection type de plage ──
const isNuitP    = p => p.type === 'nuit' || p.debut >= '22:00' || (p.fin <= '07:00' && p.fin > '00:00');
const isReunion  = p => p.type === 'reunion' || (p.nom||'').toLowerCase().includes('reunion') || (p.nom||'').toLowerCase().includes('réunion');
const isWEPlage  = p => p.jours && p.jours.length > 0 && p.jours.every(j => j === 5 || j === 6);
const isVenNuit  = p => isNuitP(p) && !isReunion(p) && !isWEPlage(p) && (p.jours||[]).includes(4);
const isNuitSem  = p => isNuitP(p) && !isReunion(p) && !isWEPlage(p) && !isVenNuit(p);
const isLever    = p => !isNuitP(p) && !isReunion(p) && !isWEPlage(p) && parseInt(p.debut) < 10;
const isFinJour  = p => !isNuitP(p) && !isReunion(p) && !isWEPlage(p) && !isLever(p);
const isWEDay    = d => d.getDay() === 0 || d.getDay() === 6;
const dowIdx     = d => d.getDay() === 0 ? 6 : d.getDay() - 1;
const ratioE     = e => getTargetH(e) / 38;

function groupeEquite(p) {
  if (isReunion(p))  return 'G7';
  if (isWEPlage(p))  return isNuitP(p) ? 'G6' : 'G5';
  if (isVenNuit(p))  return 'G3';
  if (isNuitSem(p))  return 'G4';
  if (isLever(p))    return 'G1';
  return 'G2';
}

function dureeH(p) {
  if (p.dureeH && p.dureeH > 0) return p.dureeH;
  const [dh, dm] = p.debut.split(':').map(Number);
  const [fh, fm] = p.fin.split(':').map(Number);
  let h = (fh * 60 + fm) - (dh * 60 + dm);
  if (h <= 0) h += 1440;
  if (isReunion(p)) return Math.min(h / 60, 8);
  return h / 60;
}

function joursOuvMois(yr, mo) {
  return getDays(yr, mo).filter(d => {
    const dw = d.getDay();
    return dw >= 1 && dw <= 5 && !isFerie(dayStr(d));
  }).length;
}

function norm(val, e) { return val / Math.max(0.01, ratioE(e)); }

let _pm = null, _em = null;
function plageById(id) {
  if (!_pm || _pm.size !== plages.length) _pm = new Map(plages.map(p => [p.id, p]));
  return _pm.get(+id);
}
function educById(id) {
  if (!_em || _em.size !== educs.length) _em = new Map(educs.map(e => [e.id, e]));
  return _em.get(+id);
}

function hSemFixe(joursH, ds) {
  const d = new Date(ds + 'T12:00');
  const lundi = new Date(d);
  lundi.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const dd = new Date(lundi);
    dd.setDate(lundi.getDate() + i);
    total += (joursH || {})[dayStr(dd)] || 0;
  }
  return total;
}

// ================================================================
// PERSISTANCE CYCLE
// ================================================================
function loadCycleState() {
  try { return JSON.parse(localStorage.getItem('planeduc_v3_cycle') || '{}'); }
  catch(e) { return {}; }
}
function saveCycleState(s) {
  try { localStorage.setItem('planeduc_v3_cycle', JSON.stringify(s)); } catch(e) {}
}

// ================================================================
// HISTORIQUE
// ================================================================
function calculerHistorique(moisStr, horizon) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const hist = {};
  educs.forEach(e => {
    hist[e.id] = {
      solde: 0,
      groupes: { G1:0, G2:0, G3:0, G4:0, G5:0, G6:0, G7:0 },
      ferie: 0, we: 0
    };
  });
  for (let i = 1; i < horizon; i++) {
    const key  = moisKey(yr, mo - i);
    const plan = horaire[key];
    if (!plan) continue;
    const [ky, km] = key.split('-').map(Number);
    const joursM   = getDays(ky, km);
    const joursOuv = joursOuvMois(ky, km);
    const hTrav    = {};
    educs.forEach(e => hTrav[e.id] = 0);
    joursM.forEach(day => {
      const ds = dayStr(day), weD = isWEDay(day), feD = isFerie(ds);
      Object.entries(plan[ds] || {}).forEach(([pid, ids]) => {
        if (pid.startsWith('_') || !Array.isArray(ids)) return;
        const p = plageById(+pid); if (!p) return;
        const g = groupeEquite(p);
        ids.forEach(eid => {
          const id = +eid; if (!hist[id]) return;
          hTrav[id] += dureeH(p);
          hist[id].groupes[g] = (hist[id].groupes[g] || 0) + 1;
          if (weD) hist[id].we++;
          if (feD) hist[id].ferie++;
        });
      });
    });
    educs.forEach(e => {
      hist[e.id].solde += hTrav[e.id] - joursOuv * 7.6 * ratioE(e);
    });
  }
  return hist;
}

// ================================================================
// CIBLE HEURES
// ================================================================
function calculerCibleH(e, moisStr, hist) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const base  = joursOuvMois(yr, mo) * 7.6 * ratioE(e);
  const solde = hist[e.id].solde || 0;
  const finTrimestre = mo % 3 === 0;
  const finAnnee     = mo === 12;
  let coef = 0.30;
  if (finTrimestre) coef = 0.50;
  if (finAnnee)     coef = 0.80;
  const corrMax = finAnnee ? 20 : (finTrimestre ? 15 : 10);
  return base + Math.max(-corrMax, Math.min(corrMax, -solde * coef));
}

// ================================================================
// VERROUILLAGES
// ================================================================
function getLockedSlots(moisStr) {
  const plan = horaire[moisStr] || {}, locked = {};
  Object.entries(plan).forEach(([ds, slots]) => {
    Object.entries(slots || {}).forEach(([pid, val]) => {
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
// DÉTECTION IMPOSSIBILITÉS
// ================================================================
function detecterImpossibilites(moisStr) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const msgs = [];
  getDays(yr, mo).forEach(d => {
    const ds = dayStr(d), dow = dowIdx(d), we = isWEDay(d), fe = isFerie(ds);
    const dc = (fe && !we) ? 5 : dow;
    plages.forEach(p => {
      if (!p.jours.includes(dc)) return;
      const dispo = educs.filter(e => (e.jours||[]).includes(dow) && !isAbsent(e.id, ds)).length;
      if (dispo < (+p.min || 1)) msgs.push(`${ds} — ${p.nom} : ${dispo}/${p.min} dispo`);
    });
  });
  return msgs;
}

// ================================================================
// UI
// ================================================================
function verifier() {
  const warns = [];
  if (!educs.length)  warns.push({ t: 'err', m: 'Aucun éducateur défini.' });
  if (!plages.length) warns.push({ t: 'err', m: 'Aucune plage horaire définie.' });
  const rc = document.getElementById('gen-recap');
  const ri = document.getElementById('gen-recap-content');
  rc.style.display = 'block';
  let html = warns.map(w => `<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if (!warns.length) {
    html += `<div class="alert a-ok">OK : ${educs.length} éducateurs — ${plages.length} plages</div>`;
    const groupNames = { G1:'Lever', G2:'Fin journée', G3:'Nuit ven.', G4:'Nuit sem.', G5:'Journée WE', G6:'Nuit WE', G7:'Réunion' };
    html += plages.map(p => {
      const j = p.jours.map(x => JOURS[x]).join(', ');
      const g = groupeEquite(p);
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong>
        <span class="badge b-blue" style="font-size:.6rem">${groupNames[g]||g}</span>
        ${p.debut}–${p.fin} · min ${p.min} · ${j}</div>`;
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
  horaire[mois] = result.planning;
  currentMonth  = mois;
  save();
  saveCycleState(result.cycleState);
  const validation = validatePlanning(result.planning, mois, result.trackerFinal);
  const qs = planningQualityScore(validation);
  L(`Score qualité : ${qs.score}/100 — ${qs.label}`, null);
  validation.errors.slice(0,5).forEach(e => L('✗ ' + e, null));
  validation.warnings.slice(0,5).forEach(w => L('⚠ ' + w, null));
  result.warnings.slice(0,5).forEach(w => L('ℹ ' + w, null));
  L('✓ Terminé !', 100);
  btn.disabled = false;
  btn.innerHTML = "Générer l'horaire";
  showAlert('gen-alerts', validation.errors.length ? 'warn' : 'ok',
    `Horaire généré — Score : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// MOTEUR PRINCIPAL v24
// ================================================================
async function genMois(moisStr, L) {
  _pm = null; _em = null;
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours    = getDays(yr, mo);
  const planning = {};
  const warnings = [];
  const horizon   = +document.getElementById('gen-horizon').value || 3;
  const minRepos  = getRule('min_repos', 11);
  const maxCons   = getRule('max_consec', 6);
  const maxWeMois = getRule('max_we_mois', 2);
  const reposNuit = getRule('repos_apres_nuit', 1);
  jours.forEach(d => { planning[dayStr(d)] = {}; });

  L('Chargement historique...', 5);
  await sl(20);
  const hist        = calculerHistorique(moisStr, horizon);
  const lockedSlots = getLockedSlots(moisStr);
  const cycleState  = loadCycleState();

  // ── Classer les plages ──
  const plagesWE      = plages.filter(p => isWEPlage(p)  && !isReunion(p));
  const plagesVenNuit = plages.filter(p => isVenNuit(p));
  const plagesNuitSem = plages.filter(p => isNuitSem(p));
  const plagesLever   = plages.filter(p => isLever(p));
  const plagesFinJour = plages.filter(p => isFinJour(p) && !isWEPlage(p));
  const plagesReunion = plages.filter(p => isReunion(p));

  L(`WE:${plagesWE.length} · NuitVen:${plagesVenNuit.length} · NuitSem:${plagesNuitSem.length} · Lever:${plagesLever.length} · FinJ:${plagesFinJour.length} · Réunion:${plagesReunion.length}`, 8);
  await sl(10);

  // ── WE du mois ──
  const weList = [];
  jours.forEach(d => {
    if (d.getDay() === 6) {
      const dDim = jours.find(x => x.getDay() === 0 && x > d);
      weList.push({ num: weList.length+1, dSam:d, dsSam:dayStr(d), dDim:dDim||null, dsDim:dDim?dayStr(dDim):null });
    } else if (d.getDay() === 0 && !weList.some(w => w.dsDim === dayStr(d))) {
      weList.push({ num: weList.length+1, dSam:null, dsSam:null, dDim:d, dsDim:dayStr(d) });
    }
  });

  // ── Vendredis ──
  const vendredis = jours.filter(d => d.getDay() === 5);

  // ── Semaines (lun→dim) ──
  const semaines = [];
  {
    const seen = new Set();
    jours.forEach(d => {
      const lundi = new Date(d);
      lundi.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const lDs = dayStr(lundi);
      if (!seen.has(lDs)) { seen.add(lDs); semaines.push({ lunDs:lDs, jours:[] }); }
      semaines.find(s => s.lunDs === lDs).jours.push(d);
    });
  }

  // ================================================================
  // TRACKER
  // ================================================================
  const tracker     = {};
  const lastTerrain = {};
  educs.forEach(e => {
    tracker[e.id] = {
      h:0, joursH:{},
      cibleH: calculerCibleH(e, moisStr, hist),
      nuits:0, nuitsC:0, cons:0, lastDay:null,
      weCount:0, weTravailles:new Set(),
      groupes:{ G1:0, G2:0, G3:0, G4:0, G5:0, G6:0, G7:0 }
    };
    lastTerrain[e.id] = null;
  });

  // Continuité mois précédent
  {
    const prevPlan  = horaire[moisKey(yr, mo-1)] || {};
    const prevJours = getDays(yr, mo-1);
    [...prevJours].reverse().forEach(d => {
      const ds = dayStr(d);
      Object.entries(prevPlan[ds]||{}).forEach(([pid, ids]) => {
        if (pid.startsWith('_') || !Array.isArray(ids)) return;
        const p = plageById(+pid); if (!p || isReunion(p)) return;
        ids.forEach(eid => {
          const id = +eid;
          if (lastTerrain[id] === null)
            lastTerrain[id] = { date:ds, fin:p.fin, isNuit:isNuitP(p), pm:p.fin < p.debut };
        });
      });
    });
  }

  // ================================================================
  // CONTRAINTES LÉGALES
  // ================================================================
  function checkLoi(e, d, ds, dow, plage) {
    if (!(e.jours||[]).includes(dow)) return { ok:false, r:'Jour non travaillé' };
    if (isAbsent(e.id, ds))           return { ok:false, r:'Absent' };
    const t = tracker[e.id], reunion = isReunion(plage), nuit = isNuitP(plage) && !reunion;
    if (!reunion) {
      if (t.cons >= maxCons)       return { ok:false, r:`Max ${maxCons}j consécutifs` };
      if (nuit && t.nuitsC >= 2)   return { ok:false, r:'Max 2 nuits consécutives' };
      const la = lastTerrain[e.id];
      if (la) {
        const [lh,lm] = la.fin.split(':').map(Number);
        const [bh,bm] = plage.debut.split(':').map(Number);
        const finMs = new Date(la.date+'T00:00').getTime() + (la.pm?86400000:0) + (lh*60+lm)*60000;
        const debMs = new Date(ds+'T00:00').getTime() + (bh*60+bm)*60000;
        const repos = (debMs - finMs) / 3600000;
        if (repos >= 0 && repos < minRepos) return { ok:false, r:`Repos ${repos.toFixed(1)}h` };
      }
      if (la && la.isNuit && reposNuit > 0) {
        const diffJ = Math.round((new Date(ds+'T12:00') - new Date(la.date+'T12:00')) / 86400000);
        if (diffJ <= reposNuit) return { ok:false, r:'Repos après nuit' };
      }
    }
    if (hSemFixe(t.joursH, ds) + dureeH(plage) > 50) return { ok:false, r:'Max 50h/sem' };
    return { ok:true, r:'' };
  }

  function checkLoiWEBloc(e, plage, dSam, dsSam, dDim, dsDim) {
    if (dSam) {
      const r = checkLoi(e, dSam, dsSam, dowIdx(dSam), plage);
      if (!r.ok) return r;
    }
    if (dDim) {
      if (!(e.jours||[]).includes(dowIdx(dDim))) return { ok:false, r:'Dim non travaillé' };
      if (isAbsent(e.id, dsDim))                 return { ok:false, r:'Absent dimanche' };
    }
    return { ok:true, r:'' };
  }

  function soldeActuel(e) {
    return (hist[e.id].solde||0) + (tracker[e.id].h - tracker[e.id].cibleH);
  }

  // Bloqué si solde > seuil proportionnel au contrat
  function soldeBloque(e) {
    return soldeActuel(e) > (10 * ratioE(e));
  }

  // ================================================================
  // ASSIGNATION
  // ================================================================
  function assigner(e, ds, plage, d) {
    if (!planning[ds]) planning[ds] = {};
    if (!Array.isArray(planning[ds][plage.id])) planning[ds][plage.id] = [];
    if (planning[ds][plage.id].map(x=>+x).includes(e.id)) return;
    planning[ds][plage.id].push(e.id);

    // Statut légende
    const dow2 = d.getDay()===0?6:d.getDay()-1;
    const excl = !isReunion(plage) && (e.excls||[]).includes(plage.id);
    const dem  = (e.demandes||[]).find(x => x.jour===dow2 && (x.plageIds||[]).includes(plage.id));
    const pref = (e.prefs||[]).includes(plage.id);
    const sk   = `_s_${e.id}_${plage.id}`;
    if (excl)                          { planning[ds][sk]='forced';    warnings.push(`${ds} ${plage.nom}: refusée → ${e.prenom}`); }
    else if (dem?.type==='eviter')     { planning[ds][sk]='dem_evite'; warnings.push(`${ds} ${plage.nom}: éviter ignoré → ${e.prenom}`); }
    else if (dem?.type==='prefere')      planning[ds][sk]='dem_pref';
    else if (pref)                       planning[ds][sk]='pref';
    else                                 planning[ds][sk]='neutral';

    // Tracker
    const t = tracker[e.id], h = dureeH(plage);
    const nuit = isNuitP(plage) && !isReunion(plage), reunion = isReunion(plage);
    const g = groupeEquite(plage);
    t.h += h;
    if (!t.joursH[ds]) t.joursH[ds] = 0;
    t.joursH[ds] += h;
    t.groupes[g] = (t.groupes[g]||0) + 1;
    if (!reunion) {
      const diffJ = t.lastDay
        ? Math.round((new Date(ds+'T12:00') - new Date(t.lastDay+'T12:00')) / 86400000)
        : 999;
      t.cons    = (diffJ===1) ? t.cons+1 : 1;
      t.lastDay = ds;
      if (nuit) { t.nuits++; t.nuitsC++; } else t.nuitsC = 0;
      if (isWEDay(d) && !t.weTravailles.has(ds)) {
        t.weTravailles.add(ds);
        if (d.getDay()===6) t.weCount++;
      }
      lastTerrain[e.id] = { date:ds, fin:plage.fin, isNuit:nuit, pm:plage.fin < plage.debut };
    }
  }

  // Trier candidats : solde négatif prioritaire + équité du groupe
  function trierCandidats(cands, plage) {
    const g = groupeEquite(plage);
    return [...cands].sort((a, b) => {
      const sA = soldeActuel(a), sB = soldeActuel(b);
      const gA = ((hist[a.id].groupes[g]||0) + (tracker[a.id].groupes[g]||0)) / Math.max(0.01, ratioE(a));
      const gB = ((hist[b.id].groupes[g]||0) + (tracker[b.id].groupes[g]||0)) / Math.max(0.01, ratioE(b));
      return (sA - sB) * 0.6 + (gA - gB) * 0.4;
    });
  }

  // Recopier verrouillages
  Object.entries(lockedSlots).forEach(([ds, slots]) => {
    const d = new Date(ds+'T12:00');
    Object.entries(slots).forEach(([pid, ids]) => {
      if (!Array.isArray(ids)) return;
      const p = plageById(+pid); if (!p) return;
      planning[ds][pid] = [...ids];
      planning[ds]['_lock_'+pid] = 'locked';
      ids.forEach(eid => { const e = educById(+eid); if(e) assigner(e, ds, p, d); });
    });
  });

  // ================================================================
  // C1 — TOURNANTE WE
  // Cycle = ceil(nbEligibles / postesParWE), persisté inter-mois
  // Blocs sam+dim identiques garantis
  // ================================================================
  L('C1 — Tournante week-ends en blocs...', 15);
  await sl(20);

  for (const plage of plagesWE) {
    const g        = groupeEquite(plage);
    const reqMin   = +plage.min || 1;
    const cycleKey = `we_${plage.id}`;

    // Éducs éligibles : non exclus ET disponibles sam ET dim
    const eligibles = educs.filter(e =>
      !(e.excls||[]).includes(plage.id) &&
      (e.jours||[]).includes(5) &&
      (e.jours||[]).includes(6)
    ).sort((a, b) => {
      // Tri initial par équité historique du groupe
      const gA = (hist[a.id].groupes[g]||0) / Math.max(0.01, ratioE(a));
      const gB = (hist[b.id].groupes[g]||0) / Math.max(0.01, ratioE(b));
      return gA - gB;
    });

    if (!eligibles.length) {
      warnings.push(`${plage.nom} WE : aucun éduc éligible (jours sam+dim requis)`);
      continue;
    }

    const cycleLen = Math.max(1, Math.ceil(eligibles.length / reqMin));
    let cyclePos   = cycleState[cycleKey] || 0;

    for (const we of weList) {
      if (lockedSlots[we.dsSam]?.[plage.id] || lockedSlots[we.dsDim]?.[plage.id]) {
        cyclePos = (cyclePos + 1) % cycleLen;
        continue;
      }

      // Groupe théorique dans le cycle
      const groupeTheo = [];
      for (let i = 0; i < reqMin; i++) {
        const idx = (cyclePos * reqMin + i) % eligibles.length;
        groupeTheo.push(eligibles[idx]);
      }

      // Vérifier légalité + solde
      let groupeFinal = groupeTheo.filter(e =>
        !soldeBloque(e) && checkLoiWEBloc(e, plage, we.dSam, we.dsSam, we.dDim, we.dsDim).ok
      );

      // Compléter si manque avec les suivants dans le cycle
      if (groupeFinal.length < reqMin) {
        const candidatsSupp = eligibles.filter(e =>
          !groupeTheo.includes(e) && !groupeFinal.includes(e) &&
          !soldeBloque(e) &&
          checkLoiWEBloc(e, plage, we.dSam, we.dsSam, we.dDim, we.dsDim).ok
        );
        groupeFinal = groupeFinal.concat(candidatsSupp.slice(0, reqMin - groupeFinal.length));
      }

      // En dernier recours : ignorer blocage solde
      if (groupeFinal.length < reqMin) {
        const candidatsUrgence = eligibles.filter(e =>
          !groupeFinal.includes(e) &&
          checkLoiWEBloc(e, plage, we.dSam, we.dsSam, we.dDim, we.dsDim).ok
        );
        groupeFinal = groupeFinal.concat(candidatsUrgence.slice(0, reqMin - groupeFinal.length));
      }

      // Assigner SAM puis DIM (ordre important pour le tracker)
      if (we.dSam && plage.jours.includes(5) && !lockedSlots[we.dsSam]?.[plage.id]) {
        groupeFinal.forEach(e => {
          if (checkLoi(e, we.dSam, we.dsSam, dowIdx(we.dSam), plage).ok)
            assigner(e, we.dsSam, plage, we.dSam);
        });
      }
      if (we.dDim && plage.jours.includes(6) && !lockedSlots[we.dsDim]?.[plage.id]) {
        groupeFinal.forEach(e => {
          if (checkLoi(e, we.dDim, we.dsDim, dowIdx(we.dDim), plage).ok)
            assigner(e, we.dsDim, plage, we.dDim);
        });
      }

      const nbSam = we.dsSam ? (planning[we.dsSam][plage.id]||[]).length : reqMin;
      const nbDim = we.dsDim ? (planning[we.dsDim][plage.id]||[]).length : reqMin;
      if (nbSam < reqMin || nbDim < reqMin)
        warnings.push(`WE${we.num} ${plage.nom} : ${Math.min(nbSam,nbDim)}/${reqMin} couvert`);

      cyclePos = (cyclePos + 1) % cycleLen;
    }
    cycleState[cycleKey] = cyclePos;
  }

  // ================================================================
  // C2 — NUIT VENDREDI (tournante stricte)
  // ================================================================
  L('C2 — Nuit vendredi (tournante)...', 30);
  await sl(10);

  for (const plage of plagesVenNuit) {
    const reqMin   = +plage.min || 1;
    const cycleKey = `venNuit_${plage.id}`;
    const eligibles = educs.filter(e =>
      !(e.excls||[]).includes(plage.id) && (e.jours||[]).includes(4)
    ).sort((a, b) => {
      const gA = (hist[a.id].groupes['G3']||0) / Math.max(0.01, ratioE(a));
      const gB = (hist[b.id].groupes['G3']||0) / Math.max(0.01, ratioE(b));
      return gA - gB;
    });
    let cyclePos = cycleState[cycleKey] || 0;

    for (const d of vendredis) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) { cyclePos=(cyclePos+1)%Math.max(1,eligibles.length); continue; }
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      if (deja.length >= reqMin) continue;

      const tries = [];
      for (let i = 0; i < eligibles.length && tries.length < reqMin; i++) {
        const e = eligibles[(cyclePos + i) % eligibles.length];
        if (deja.includes(e.id) || soldeBloque(e)) continue;
        if (checkLoi(e, d, ds, dow, plage).ok) tries.push(e);
      }
      // Urgence : ignorer solde
      if (tries.length < reqMin) {
        for (let i = 0; i < eligibles.length && tries.length < reqMin; i++) {
          const e = eligibles[(cyclePos + i) % eligibles.length];
          if (deja.includes(e.id) || tries.includes(e)) continue;
          if (checkLoi(e, d, ds, dow, plage).ok) tries.push(e);
        }
      }
      tries.forEach(e => assigner(e, ds, plage, d));
      if (tries.length > 0) cyclePos = (eligibles.indexOf(tries[tries.length-1]) + 1) % eligibles.length;
      else warnings.push(`${ds} ${plage.nom} nuit ven : impossible`);
    }
    cycleState[cycleKey] = cyclePos;
  }

  // ================================================================
  // C3 — NUITS SEMAINE lun→jeu
  // Éducs en WE cette semaine évitent la nuit semaine (sauf urgence)
  // ================================================================
  L('C3 — Nuits semaine...', 43);
  await sl(10);

  for (const plage of plagesNuitSem) {
    const reqMin   = +plage.min || 1;
    const cycleKey = `nuitSem_${plage.id}`;
    const eligibles = educs.filter(e =>
      !(e.excls||[]).includes(plage.id)
    ).sort((a, b) => {
      const gA = (hist[a.id].groupes['G4']||0) / Math.max(0.01, ratioE(a));
      const gB = (hist[b.id].groupes['G4']||0) / Math.max(0.01, ratioE(b));
      return gA - gB;
    });
    let cyclePos = cycleState[cycleKey] || 0;

    const joursNuit = jours.filter(d => {
      const dow = dowIdx(d);
      return plage.jours.includes(dow) && !isWEDay(d);
    });

    for (const d of joursNuit) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) continue;
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      if (deja.length >= reqMin) continue;

      // Éducs en WE cette semaine
      const sem = semaines.find(s => s.jours.some(x => dayStr(x)===ds));
      const educEnWE = sem ? new Set(
        sem.jours.filter(x => isWEDay(x)).flatMap(x =>
          Object.values(planning[dayStr(x)]||{}).flatMap(ids => Array.isArray(ids)?ids.map(id=>+id):[])
        )
      ) : new Set();

      // Passe 1 : hors WE cette semaine
      const tries = [];
      for (let i = 0; i < eligibles.length && tries.length < reqMin; i++) {
        const e = eligibles[(cyclePos+i) % eligibles.length];
        if (deja.includes(e.id) || educEnWE.has(e.id) || soldeBloque(e)) continue;
        if (checkLoi(e, d, ds, dow, plage).ok) tries.push(e);
      }
      // Passe 2 : accepter éducs WE si besoin
      if (tries.length < reqMin) {
        for (let i = 0; i < eligibles.length && tries.length < reqMin; i++) {
          const e = eligibles[(cyclePos+i) % eligibles.length];
          if (deja.includes(e.id) || tries.includes(e)) continue;
          if (checkLoi(e, d, ds, dow, plage).ok) tries.push(e);
        }
      }
      tries.forEach(e => assigner(e, ds, plage, d));
      if (tries.length > 0) cyclePos = (eligibles.indexOf(tries[tries.length-1])+1) % eligibles.length;
      else warnings.push(`${ds} ${plage.nom} nuit sem : impossible`);
    }
    cycleState[cycleKey] = cyclePos;
  }

  // ================================================================
  // C4 — LEVERS
  // ================================================================
  L('C4 — Levers...', 57);
  await sl(10);

  for (const plage of plagesLever) {
    const reqMin = +plage.min || 1;
    const joursP = jours.filter(d => {
      const dow = dowIdx(d), dc = (isFerie(dayStr(d))&&!isWEDay(d))?5:dow;
      return plage.jours.includes(dc) && !isWEDay(d);
    });
    for (const d of joursP) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) continue;
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      if (deja.length >= reqMin) continue;
      const sorted = trierCandidats(
        educs.filter(e => !deja.includes(e.id) && !(e.excls||[]).includes(plage.id)
          && !soldeBloque(e) && checkLoi(e,d,ds,dow,plage).ok), plage
      );
      sorted.slice(0, reqMin-deja.length).forEach(e => assigner(e,ds,plage,d));
      // Urgence
      const manque = reqMin - (planning[ds][plage.id]||[]).length;
      if (manque > 0) {
        const deja2 = (planning[ds][plage.id]||[]).map(x=>+x);
        trierCandidats(
          educs.filter(e => !deja2.includes(e.id) && !(e.excls||[]).includes(plage.id)
            && checkLoi(e,d,ds,dow,plage).ok), plage
        ).slice(0, manque).forEach(e => assigner(e,ds,plage,d));
      }
      if ((planning[ds][plage.id]||[]).length < reqMin)
        warnings.push(`${ds} ${plage.nom} lever : ${(planning[ds][plage.id]||[]).length}/${reqMin}`);
    }
  }

  // ================================================================
  // C5 — FINS DE JOURNÉE
  // ================================================================
  L('C5 — Fins de journée...', 70);
  await sl(10);

  for (const plage of plagesFinJour) {
    const reqMin = +plage.min || 1;
    const joursP = jours.filter(d => {
      const dow = dowIdx(d), dc = (isFerie(dayStr(d))&&!isWEDay(d))?5:dow;
      return plage.jours.includes(dc) && !isWEDay(d);
    });
    for (const d of joursP) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) continue;
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      if (deja.length >= reqMin) continue;
      const sorted = trierCandidats(
        educs.filter(e => !deja.includes(e.id) && !(e.excls||[]).includes(plage.id)
          && !soldeBloque(e) && checkLoi(e,d,ds,dow,plage).ok), plage
      );
      sorted.slice(0, reqMin-deja.length).forEach(e => assigner(e,ds,plage,d));
      const manque = reqMin - (planning[ds][plage.id]||[]).length;
      if (manque > 0) {
        const deja2 = (planning[ds][plage.id]||[]).map(x=>+x);
        trierCandidats(
          educs.filter(e => !deja2.includes(e.id) && !(e.excls||[]).includes(plage.id)
            && checkLoi(e,d,ds,dow,plage).ok), plage
        ).slice(0, manque).forEach(e => assigner(e,ds,plage,d));
      }
      if ((planning[ds][plage.id]||[]).length < reqMin)
        warnings.push(`${ds} ${plage.nom} fin journée : ${(planning[ds][plage.id]||[]).length}/${reqMin}`);
    }
  }

  // ================================================================
  // C6 — RÉUNIONS
  // ================================================================
  L('C6 — Réunions...', 83);
  await sl(10);

  for (const plage of plagesReunion) {
    const joursP = jours.filter(d => {
      const dow = dowIdx(d), dc = (isFerie(dayStr(d))&&!isWEDay(d))?5:dow;
      return plage.jours.includes(dc);
    });
    for (const d of joursP) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) continue;
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      const cands = educs.filter(e =>
        !deja.includes(e.id) && (e.jours||[]).includes(dow) && !isAbsent(e.id,ds) &&
        hSemFixe(tracker[e.id].joursH, ds) + dureeH(plage) <= 50
      );
      if (plage.tous) cands.forEach(e => assigner(e,ds,plage,d));
      else trierCandidats(cands, plage).slice(0, (+plage.min||1)-deja.length).forEach(e => assigner(e,ds,plage,d));
    }
  }

  // ================================================================
  // C7 — PLAGES NON CLASSIFIÉES (sécurité)
  // ================================================================
  L('C7 — Plages restantes...', 92);
  await sl(5);

  const classifiees = new Set([
    ...plagesWE, ...plagesVenNuit, ...plagesNuitSem,
    ...plagesLever, ...plagesFinJour, ...plagesReunion
  ].map(p => p.id));

  for (const plage of plages.filter(p => !classifiees.has(p.id))) {
    const reqMin = +plage.min || 1;
    const joursP = jours.filter(d => {
      const dow = dowIdx(d), dc = (isFerie(dayStr(d))&&!isWEDay(d))?5:dow;
      return plage.jours.includes(dc);
    });
    for (const d of joursP) {
      const ds = dayStr(d), dow = dowIdx(d);
      if (lockedSlots[ds]?.[plage.id]) continue;
      const deja = (planning[ds][plage.id]||[]).map(x=>+x);
      if (deja.length >= reqMin) continue;
      trierCandidats(
        educs.filter(e => !deja.includes(e.id) && !(e.excls||[]).includes(plage.id)
          && checkLoi(e,d,ds,dow,plage).ok), plage
      ).slice(0, reqMin-deja.length).forEach(e => assigner(e,ds,plage,d));
    }
  }

  return { planning, warnings, cycleState, trackerFinal: tracker };
}

// ================================================================
// VALIDATION
// ================================================================
function validatePlanning(planning, moisStr, trackerFinal) {
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours = getDays(yr, mo);
  const errors = [], warns = [];

  jours.forEach(d => {
    const ds = dayStr(d), dow = dowIdx(d), we = isWEDay(d), fe = isFerie(ds);
    const dc = (fe&&!we)?5:dow;
    plages.filter(p => p.jours.includes(dc)).forEach(p => {
      const ids = (planning[ds]||{})[p.id] || [];
      if (ids.length < (+p.min||1)) errors.push(`${ds} — ${p.nom} : ${ids.length}/${p.min}`);
    });
  });

  // WE coupés
  let weCoupes = 0;
  jours.filter(d => d.getDay()===6).forEach(sam => {
    const dDim = jours.find(x => x.getDay()===0 && x>sam);
    if (!dDim) return;
    const dsSam = dayStr(sam), dsDim = dayStr(dDim);
    educs.forEach(e => {
      const tS = plages.some(p => ((planning[dsSam]||{})[p.id]||[]).map(x=>+x).includes(e.id));
      const tD = plages.some(p => ((planning[dsDim]||{})[p.id]||[]).map(x=>+x).includes(e.id));
      if (tS !== tD) weCoupes++;
    });
  });
  if (weCoupes > 0) warns.push(`${weCoupes} WE coupé(s)`);

  if (trackerFinal) {
    educs.forEach(e => {
      const t = trackerFinal[e.id]; if (!t) return;
      const s = t.h - t.cibleH;
      if (Math.abs(s) > 15) warns.push(`Solde ${e.prenom} : ${s>=0?'+':''}${s.toFixed(1)}h`);
    });
  }

  const metrics = {
    couverture: errors.length===0 ? 100 : Math.max(0, 100-errors.length*12),
    weBlocs:    Math.max(0, 100-weCoupes*15),
    soldes:     Math.max(0, 100-warns.filter(w=>w.includes('Solde')).length*10)
  };
  return { valid:true, errors, warnings:warns, metrics };
}

function planningQualityScore(validation) {
  const m = validation.metrics || { couverture:50, weBlocs:50, soldes:50 };
  const score = Math.round(m.couverture*0.5 + m.weBlocs*0.3 + m.soldes*0.2);
  const label = score>=90?'Excellent':score>=75?'Bon':score>=60?'Moyen':'À améliorer';
  return { score, label };
}
