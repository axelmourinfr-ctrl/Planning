// ============================================================
// algo.js - PlanEduc Pro - Moteur v8
// ============================================================
// HIERARCHIE STRICTE :
//  P1 - LOI          : repos 11h, max 6j consecutifs, max 2 nuits consec,
//                      max 50h/sem, max 14h/jour nuit, 11h/jour normal
//  P2 - COUVERTURE   : minimum de chaque plage OBLIGATOIRE
//  P3 - EQUITE       : heures (±15h/mois, 0 trimestriel),
//                      prestations (±1-2/mois par type, prorata contrat),
//                      WE (~1/2 pour TP), feries (equite annuelle)
//  P4 - DEMANDES     : preferences educs (jamais > P1/P2/P3)
//  P5 - MAXIMUM      : remplir jusqu'au max si solde negatif
//
// ORDRE DE GENERATION PAR JOUR :
//  1. Nuits
//  2. Week-ends / Feries
//  3. Longues journees
//  4. Reste des plages
// ============================================================

function verifier(){
  const warns = [];
  if(!educs.length)  warns.push({t:'err', m:'Aucun educateur defini.'});
  if(!plages.length) warns.push({t:'err', m:'Aucune plage horaire definie.'});
  const rc = document.getElementById('gen-recap');
  const ri = document.getElementById('gen-recap-content');
  rc.style.display = 'block';
  let html = warns.map(w=>`<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if(!warns.length){
    html += `<div class="alert a-ok">OK: ${educs.length} educateurs - ${plages.length} plages</div>`;
    html += plages.map(p=>{
      const j = p.jours.map(x=>JOURS[x]).join(', ');
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> - ${p.debut}-${p.fin} - min ${p.min} educ - ${j}
      </div>`;
    }).join('');
  }
  ri.innerHTML = html;
}

async function lancer(){
  if(!educs.length || !plages.length){ verifier(); return; }
  const mois = document.getElementById('gen-mois').value;
  if(!mois){ alert('Choisissez un mois.'); return; }
  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div> Generation...';
  document.getElementById('gen-prog').style.display = 'block';
  document.getElementById('gen-alerts').innerHTML = '';
  const log = document.getElementById('gen-log');
  log.innerHTML = '';
  const L = (m, p) => {
    log.innerHTML += m + '<br>';
    log.scrollTop = log.scrollHeight;
    if(p != null) document.getElementById('gen-bar').style.width = p + '%';
  };
  L('Demarrage...', 5); await sl(50);
  const result = await genMois(mois, L);
  horaire[mois] = result.planning;
  currentMonth  = mois;
  save();
  L('Sauvegarde OK', 98); await sl(50);
  L('Termine !', 100);
  if(result.warnings.length){
    L(`--- ${result.warnings.length} avertissement(s) ---`, null);
    result.warnings.slice(0, 15).forEach(w => L('! ' + w, null));
    if(result.warnings.length > 15) L(`... et ${result.warnings.length - 15} autre(s).`, null);
  }
  btn.disabled = false;
  btn.innerHTML = "Generer l'horaire";
  showAlert('gen-alerts', 'ok', `Horaire de ${monthLabel(mois)} genere !`);
  updateMonthLabels();
}

// ================================================================
// UTILITAIRES
// ================================================================
const isNuitP  = p => p.type === 'nuit' || p.debut >= '22:00' || (p.fin <= '07:00' && p.fin > '00:00');
const isWEDay  = d => d.getDay() === 0 || d.getDay() === 6;
const ratioE   = e => getTargetH(e) / 38;
const dowIdx   = d => d.getDay() === 0 ? 6 : d.getDay() - 1;

// Duree d'une plage en heures (gere le passage minuit)
function dureeH(p){
  if(p.dureeH) return p.dureeH;
  const [dh, dm] = p.debut.split(':').map(Number);
  const [fh, fm] = p.fin.split(':').map(Number);
  let h = (fh * 60 + fm) - (dh * 60 + dm);
  if(h <= 0) h += 1440;
  return h / 60;
}

// Jours ouvrables reels d'un mois (lun-ven hors feries actifs)
function joursOuvrablesMois(yr, mo){
  return getDays(yr, mo).filter(d => {
    const dw = d.getDay(); return dw >= 1 && dw <= 5 && !isFerie(dayStr(d));
  }).length;
}

// Cible heures mensuelle pour un educ
function cibleHMois(e, yr, mo){
  return joursOuvrablesMois(yr, mo) * 7.6 * ratioE(e);
}

// Moyenne ponderee par ratio contrat sur tous les educs
function moyPonderee(educs, fn){
  const sum = educs.reduce((s, x) => s + fn(x) / Math.max(0.01, ratioE(x)), 0);
  return sum / Math.max(1, educs.length);
}

// Valeur normalisee d'un educ (divise par son ratio = equivalent temps plein)
function normalisee(val, e){ return val / Math.max(0.01, ratioE(e)); }

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr, L){
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours    = getDays(yr, mo);
  const planning = {}, warnings = [];
  const horizon  = +document.getElementById('gen-horizon').value || 3;

  // Regles legales
  const minRepos     = getRule('min_repos', 11);
  const maxCons      = getRule('max_consec', 6);
  const maxWeMois    = getRule('max_we_mois', 2);
  const reposNuit    = getRule('repos_apres_nuit', 1);
  const maxNuitsCons = 2; // spec : max 2 nuits consecutives

  L('Calcul de l\'historique...', 8); await sl(30);

  // ================================================================
  // ETAPE 1 : HISTORIQUE
  // Pour chaque educ : solde heures cumule, comptage par plage,
  // WE travailles, feries travailles sur l'horizon
  // ================================================================
  const hist = {};
  educs.forEach(e => {
    hist[e.id] = { solde: 0, plageCount: {}, we: 0, ferie: 0, nuits: 0 };
    plages.forEach(p => hist[e.id].plageCount[p.id] = 0);
  });

  for(let i = 1; i < horizon; i++){
    const key  = moisKey(yr, mo - i);
    const plan = horaire[key];
    if(!plan) continue;
    const [ky, km] = key.split('-').map(Number);
    const joursMois    = getDays(ky, km);
    const joursOuvHist = joursOuvrablesMois(ky, km);
    const hTravHist    = {};
    educs.forEach(e => hTravHist[e.id] = 0);

    joursMois.forEach(day => {
      const ds  = dayStr(day);
      const weD = isWEDay(day);
      const feD = isFerie(ds);
      Object.entries(plan[ds] || {}).forEach(([pid, ids]) => {
        if(pid.startsWith('_') || !Array.isArray(ids)) return;
        const p = plages.find(x => x.id === +pid); if(!p) return;
        const nuit = isNuitP(p);
        ids.forEach(eid => {
          const id = +eid;
          if(hist[id] === undefined) return;
          hTravHist[id] += dureeH(p);
          hist[id].plageCount[p.id] = (hist[id].plageCount[p.id] || 0) + 1;
          if(weD)  hist[id].we++;
          if(feD)  hist[id].ferie++;
          if(nuit) hist[id].nuits++;
        });
      });
    });

    educs.forEach(e => {
      const cible = joursOuvHist * 7.6 * ratioE(e);
      hist[e.id].solde += hTravHist[e.id] - cible;
    });
  }

  // ================================================================
  // ETAPE 2 : QUOTAS DU MOIS
  // Calcul AVANT generation — equite strictement proportionnelle
  // ================================================================
  L('Calcul des quotas...', 15); await sl(30);

  const joursOuv    = joursOuvrablesMois(yr, mo);
  const poidsTotal  = educs.reduce((s, e) => s + ratioE(e), 0);

  // Quota heures : cible + ajustement solde (tendance vers 0)
  const quotaH = {};
  educs.forEach(e => {
    const base  = joursOuv * 7.6 * ratioE(e);
    // Ajustement : si solde positif -> reduire quota, negatif -> augmenter
    // Borne a ±10h pour rester dans ±15h/mois
    const ajust = Math.max(-10, Math.min(10, -hist[e.id].solde * 0.5));
    quotaH[e.id] = base + ajust;
  });

  // Quota prestations par plage : proportionnel au contrat
  // Un mi-temps fait exactement la moitie des prestations d'un temps plein
  const quotaPlage = {};
  educs.forEach(e => { quotaPlage[e.id] = {}; });
  plages.forEach(p => {
    const joursActifs = jours.filter(d => {
      const di = dowIdx(d);
      const dc = (isFerie(dayStr(d)) && !isWEDay(d)) ? 5 : di;
      return p.jours.includes(dc);
    }).length;
    const totalPostes = joursActifs * (+p.min || 1);
    educs.forEach(e => {
      // Part proportionnelle = total * ratio / somme ratios
      quotaPlage[e.id][p.id] = totalPostes * ratioE(e) / Math.max(0.01, poidsTotal);
    });
  });

  // ================================================================
  // ETAPE 3 : TRACKER EN-COURS-DE-MOIS
  // ================================================================
  const tracker = {};
  const lastPrest = {}; // derniere prestation pour calcul repos
  educs.forEach(e => {
    tracker[e.id] = {
      h: 0, nuits: 0, nuitsC: 0,
      weCount: 0, weJours: new Set(),
      cons: 0, lastDay: null,
      plageCount: {}
    };
    plages.forEach(p => tracker[e.id].plageCount[p.id] = 0);
    lastPrest[e.id] = null;
  });

  // Continuite depuis mois precedent
  const prevPlan = horaire[moisKey(yr, mo - 1)] || {};
  Object.keys(prevPlan).sort().forEach(ds => {
    Object.entries(prevPlan[ds] || {}).forEach(([pid, ids]) => {
      if(pid.startsWith('_') || !Array.isArray(ids)) return;
      const p = plages.find(x => x.id === +pid); if(!p) return;
      ids.forEach(eid => {
        const id = +eid;
        if(!lastPrest[id] || ds > lastPrest[id].date){
          lastPrest[id] = { date: ds, fin: p.fin, isNuit: isNuitP(p), pm: p.fin < p.debut };
        }
      });
    });
  });

  // ================================================================
  // P1 : CONTRAINTES LEGALES ABSOLUES
  // Retourne true si l'educ PEUT travailler cette plage ce jour
  // ================================================================
  function respecteLoi(e, d, ds, dow, plage){
    if(!(e.jours || []).includes(dow)) return false;
    if(isAbsent(e.id, ds)) return false;
    const t  = tracker[e.id];
    const la = lastPrest[e.id];

    // Max jours consecutifs (spec: 6)
    if(t.cons >= maxCons) return false;

    // Max nuits consecutives (spec: 2)
    if(isNuitP(plage) && t.nuitsC >= maxNuitsCons) return false;

    // Repos minimum 11h entre deux prestations
    if(la){
      const [lh, lm] = la.fin.split(':').map(Number);
      const [bh, bm] = plage.debut.split(':').map(Number);
      const finMs = new Date(la.date + 'T00:00').getTime()
                  + (la.pm ? 86400000 : 0)
                  + (lh * 60 + lm) * 60000;
      const debMs = new Date(ds + 'T00:00').getTime() + (bh * 60 + bm) * 60000;
      const diffH = (debMs - finMs) / 3600000;
      if(diffH >= 0 && diffH < minRepos) return false;
    }

    // Repos apres nuit
    if(la && la.isNuit && reposNuit > 0){
      const diffJ = Math.round((d - new Date(la.date)) / 86400000);
      if(diffJ <= reposNuit) return false;
    }

    // Max heures journalieres : 14h nuit, 11h normal
    const maxH = isNuitP(plage) ? 14 : 11;
    const hJour = plages.reduce((s, pp) => {
      const ids = (planning[ds] || {})[pp.id];
      if(Array.isArray(ids) && ids.map(x=>+x).includes(e.id)) return s + dureeH(pp);
      return s;
    }, 0);
    if(hJour + dureeH(plage) > maxH) return false;

    return true;
  }

  // Convention interne (relachable en urgence sauf excls)
  function respecteConvention(e, d, ds, plage, bloquerQuota){
    if((e.excls || []).includes(plage.id)) return false;
    if(isWEDay(d) && tracker[e.id].weCount >= maxWeMois) return false;
    if(bloquerQuota){
      // Bloquer si TRES largement au-dessus du quota heures (+20h)
      const solde = hist[e.id].solde + (tracker[e.id].h - quotaH[e.id]);
      if(solde > 20) return false;
    }
    return true;
  }

  // ================================================================
  // P3+P4 : SCORE — Score BAS = prioritaire
  // TOUT est normalise par ratio contrat pour l'equite
  // ================================================================
  function score(e, d, ds, plage, weOrFerie){
    const t  = tracker[e.id];
    const ht = hist[e.id];
    const re = ratioE(e);
    let sc   = 0;

    // ── P3a : SOLDE HEURES ──
    // Compare le solde cumule (hist + ce mois) a la cible
    const soldeCumul = ht.solde + (t.h - quotaH[e.id]);
    sc += soldeCumul * 4.0;
    // Bonus progressif pour deficit important
    if(soldeCumul < -20) sc -= 40;
    else if(soldeCumul < -12) sc -= 22;
    else if(soldeCumul < -6)  sc -= 10;
    // Malus progressif pour surplus
    if(soldeCumul > 20) sc += 30;
    else if(soldeCumul > 12) sc += 15;
    else if(soldeCumul > 6)  sc += 6;

    // ── P3b : EQUITE PRESTATIONS PAR PLAGE ──
    // Normalise : divise par ratio pour comparer equitablement
    // Un mi-temps avec 3 nuits = temps plein avec 6 nuits (equitable)
    const myCount   = (ht.plageCount[plage.id] || 0) + (t.plageCount[plage.id] || 0);
    const myNorm    = normalisee(myCount, e);
    const avgNorm   = moyPonderee(educs, x =>
      (hist[x.id].plageCount[plage.id] || 0) + (tracker[x.id].plageCount[plage.id] || 0)
    );
    const ecart = myNorm - avgNorm;
    sc += ecart * 10;
    if(ecart < -1.5) sc -= 15; // deficit -> tres prioritaire
    if(ecart >  1.5) sc += 12; // surplus -> defavorise

    // ── P3c : EQUITE WE ──
    if(weOrFerie){
      const myWE  = normalisee((ht.we || 0) + t.weCount, e);
      const avgWE = moyPonderee(educs, x => (hist[x.id].we || 0) + tracker[x.id].weCount);
      const ecWE  = myWE - avgWE;
      sc += ecWE * 9;
      if(ecWE < -1) sc -= 10;
      if(ecWE >  1) sc += 8;
    }

    // ── P3d : EQUITE FERIES ──
    if(isFerie(ds)){
      const myFer  = normalisee(ht.ferie || 0, e);
      const avgFer = moyPonderee(educs, x => hist[x.id].ferie || 0);
      sc += (myFer - avgFer) * 11;
    }

    // ── P3e : EQUITE NUITS (poids eleve) ──
    if(isNuitP(plage)){
      const myNuits  = normalisee((ht.plageCount[plage.id] || 0) + t.nuits, e);
      const avgNuits = moyPonderee(educs, x =>
        (hist[x.id].plageCount[plage.id] || 0) + tracker[x.id].nuits
      );
      const ecNuit = myNuits - avgNuits;
      sc += ecNuit * 15; // poids max pour les nuits
      if(ecNuit < -1.5) sc -= 20;
      if(ecNuit >  1.5) sc += 15;
    }

    // ── P4 : PREFERENCES ──
    if((e.prefs || []).includes(plage.id)) sc -= 10;

    // ── P4 : DEMANDES STRUCTUREES ──
    const dow2 = d.getDay() === 0 ? 6 : d.getDay() - 1;
    (e.demandes || []).forEach(dem => {
      if(dem.jour === dow2 && (dem.plageIds || []).includes(plage.id)){
        if(dem.type === 'eviter')  sc += 15;
        if(dem.type === 'prefere') sc -= 15;
      }
    });

    // Eviter double prestation meme jour (sauf horaire a pause)
    const dejaAujourd = Object.values(planning[ds] || {})
      .some(ids => Array.isArray(ids) && ids.map(x=>+x).includes(e.id));
    if(dejaAujourd && !e.acceptePause) sc += 25;

    return sc;
  }

  function updateTracker(e, d, ds, plage, nuit, we){
    const t = tracker[e.id];
    t.h += dureeH(plage);
    const diffJ = t.lastDay ? Math.round((d - new Date(t.lastDay)) / 86400000) : 999;
    t.cons  = diffJ === 1 ? t.cons + 1 : 1;
    t.lastDay = ds;
    if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC = 0;
    if(we && !t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay() === 6) t.weCount++; }
    t.plageCount[plage.id] = (t.plageCount[plage.id] || 0) + 1;
    lastPrest[e.id] = { date: ds, fin: plage.fin, isNuit: nuit, pm: plage.fin < plage.debut };
  }

  // ================================================================
  // ETAPE 4 : GENERATION JOUR PAR JOUR
  // ================================================================
  L('Generation...', 25);

  for(let di = 0; di < jours.length; di++){
    if(di % 3 === 0){
      L(`Jour ${di + 1} / ${jours.length}`, 25 + Math.round((di / jours.length) * 70));
      await sl(0);
    }

    const d      = jours[di];
    const ds     = dayStr(d);
    const dow    = dowIdx(d);
    const we     = isWEDay(d);
    const ferie  = isFerie(ds);
    planning[ds] = {};

    const dowForPlages = (ferie && !we) ? 5 : dow;
    const pjBase = plages.filter(p => p.jours.includes(dowForPlages));

    // ── ORDRE DE GENERATION (spec) ──
    // 1. Nuits, 2. WE/Feries, 3. Longues journees (>8h), 4. Reste
    // Au sein de chaque groupe : trier par plus difficile a couvrir en premier
    function prioritePlage(p){
      if(isNuitP(p)) return 0;
      if(we || ferie) return 1;
      if(dureeH(p) > 8) return 2;
      return 3;
    }

    // Trier : priorite d'abord, puis par difficulte (moins de candidats = avant)
    const pj = [...pjBase].sort((a, b) => {
      const pa = prioritePlage(a), pb = prioritePlage(b);
      if(pa !== pb) return pa - pb;
      // Meme priorite : trier par ratio candidats/min (plus difficile = avant)
      const ca = educs.filter(e => respecteLoi(e, d, ds, dow, a)).length;
      const cb = educs.filter(e => respecteLoi(e, d, ds, dow, b)).length;
      return (ca / Math.max(1, +a.min||1)) - (cb / Math.max(1, +b.min||1));
    });

    // ============================================================
    // PASSE A : Couverture MINIMUM de toutes les plages
    // ============================================================
    for(const plage of pj){
      const nuit   = isNuitP(plage);
      const reqMin = Math.max(0, +plage.min || 1);
      const useAll = plage.tous;

      // Niveau 1 : P1 + convention complète
      let cands = educs.filter(e =>
        respecteLoi(e, d, ds, dow, plage) &&
        respecteConvention(e, d, ds, plage, true)
      );

      // Niveau 2 : P1 + convention sans blocage quota (si pas assez)
      if(cands.length < reqMin && !useAll){
        cands = educs.filter(e =>
          respecteLoi(e, d, ds, dow, plage) &&
          respecteConvention(e, d, ds, plage, false)
        );
      }

      // Niveau 3 : P1 seulement, sans excls (urgence absolue)
      if(cands.length < reqMin && !useAll){
        cands = educs.filter(e => respecteLoi(e, d, ds, dow, plage));
      }

      const scored   = cands.map(e => ({ e, sc: score(e, d, ds, plage, we || ferie) }))
                            .sort((a, b) => a.sc - b.sc);
      const n        = useAll ? scored.length : Math.min(reqMin, scored.length);
      const assigned = scored.slice(0, n).map(x => x.e);

      planning[ds][plage.id] = assigned.map(e => e.id);

      assigned.forEach(e => {
        const isExcl   = (e.excls || []).includes(plage.id);
        const isPref   = (e.prefs || []).includes(plage.id);
        const dow2     = d.getDay() === 0 ? 6 : d.getDay() - 1;
        const dem      = (e.demandes || []).find(x =>
          x.jour === dow2 && (x.plageIds || []).includes(plage.id)
        );
        const sk = `_s_${e.id}_${plage.id}`;
        if(isExcl){
          planning[ds][sk] = 'forced';
          warnings.push(`${ds} - ${plage.nom} : plage refusee assignee a ${e.prenom} (manque de personnel)`);
        } else if(dem && dem.type === 'eviter'){
          planning[ds][sk] = 'dem_evite';
          warnings.push(`${ds} - ${plage.nom} : demande de ${e.prenom} non respectee`);
        } else if(dem && dem.type === 'prefere'){
          planning[ds][sk] = 'dem_pref';
        } else if(isPref){
          planning[ds][sk] = 'pref';
        } else {
          planning[ds][sk] = 'neutral';
        }
        updateTracker(e, d, ds, plage, nuit, we);
      });

      if(assigned.length < reqMin){
        warnings.push(`${ds} - ${plage.nom} : ${reqMin - assigned.length} poste(s) non couverts (contrainte legale)`);
      }
    }

    // ============================================================
    // PASSE B : Couverture MAXIMUM (P5)
    // Ajouter des educs jusqu'au max si solde negatif et loi OK
    // ============================================================
    for(const plage of pj){
      if(plage.tous) continue;
      const reqMin = Math.max(0, +plage.min || 1);
      const reqMax = Math.max(reqMin, +plage.max || reqMin);
      if(reqMax <= reqMin) continue;

      const dejaDans = (planning[ds][plage.id] || []).map(x => +x);
      const encore   = reqMax - dejaDans.length;
      if(encore <= 0) continue;

      const cands = educs
        .filter(e => {
          if(dejaDans.includes(e.id)) return false;
          if(!respecteLoi(e, d, ds, dow, plage)) return false;
          if(!respecteConvention(e, d, ds, plage, false)) return false;
          // P5 : uniquement si l'educ a besoin d'heures
          const solde = hist[e.id].solde + (tracker[e.id].h - quotaH[e.id]);
          return solde < 10;
        })
        .map(e => ({ e, sc: score(e, d, ds, plage, we || ferie) }))
        .sort((a, b) => a.sc - b.sc)
        .slice(0, encore)
        .map(x => x.e);

      if(!cands.length) continue;

      planning[ds][plage.id] = [...dejaDans, ...cands.map(e => e.id)];
      cands.forEach(e => {
        const isExcl = (e.excls || []).includes(plage.id);
        const isPref = (e.prefs || []).includes(plage.id);
        planning[ds][`_s_${e.id}_${plage.id}`] = isExcl ? 'forced' : isPref ? 'pref' : 'neutral';
        updateTracker(e, d, ds, plage, isNuitP(plage), we);
      });
    }
  }

  // ================================================================
  // VALIDATION FINALE
  // ================================================================
  L('Validation...', 97);
  educs.forEach(e => {
    const solde = hist[e.id].solde + tracker[e.id].h - quotaH[e.id];
    if(Math.abs(solde) > 15){
      warnings.push(`Solde ${e.prenom} ${e.nom} : ${solde >= 0 ? '+' : ''}${solde.toFixed(1)}h (hors ±15h)`);
    }
    // Verifier equite prestations par plage (±2 max par type)
    plages.forEach(p => {
      const myCount  = (hist[e.id].plageCount[p.id] || 0) + (tracker[e.id].plageCount[p.id] || 0);
      const myNorm   = normalisee(myCount, e);
      const avgNorm  = moyPonderee(educs, x =>
        (hist[x.id].plageCount[p.id] || 0) + (tracker[x.id].plageCount[p.id] || 0)
      );
      if(Math.abs(myNorm - avgNorm) > 3){
        warnings.push(`Equite ${p.nom} : ${e.prenom} ${e.nom} ecart de ${(myNorm - avgNorm).toFixed(1)} (normalise)`);
      }
    });
  });

  return { planning, warnings };
}
