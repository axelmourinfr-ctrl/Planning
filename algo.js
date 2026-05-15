// ============================================================
// algo.js - Moteur de generation automatique des horaires v3
// ============================================================
// HIERARCHIE STRICTE DES PRIORITES (ordre inviolable) :
//
//  P1. LOI & CONVENTION  : repos inter-prestation, max consecutifs,
//                          max nuits consecutives, repos apres nuit
//  P2. COUVERTURE MINIMUM: chaque plage doit avoir son minimum d'educs
//  P3. EQUITE & SOLDES   : solde ±15h/mois, cible 0 a 3 mois,
//                          equite prestations par type (prorata contrat),
//                          equite feries et WE sur l'annee,
//                          recurrence / pattern de semaine fixe
//  P4. DEMANDES EDUCS    : preferences, evitements, jours demandes
//  P5. COUVERTURE MAXIMUM: remplir jusqu'au max si besoin d'heures
//
// P1 et P2 ne sont JAMAIS violes.
// P3 et P4 influencent le score pour departager les candidats valides.
// P5 ajoute des educs supplementaires seulement s'ils respectent P1.
// ============================================================

// ── Verification avant generation ──
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

// ── Lancement ──
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
  L('Analyse...', 5); await sl(80);
  L(`${educs.length} educateurs - ${plages.length} plages`, 10); await sl(80);
  L('Calcul historique et soldes...', 18); await sl(80);
  const result = await genMois(mois, L);
  horaire[mois] = result.planning;
  currentMonth  = mois;
  save();
  L('Sauvegarde OK', 98); await sl(80);
  L('Termine !', 100);
  if(result.warnings.length){
    L(`--- ${result.warnings.length} avertissement(s) ---`, null);
    result.warnings.slice(0, 12).forEach(w => L('! ' + w, null));
    if(result.warnings.length > 12) L(`... et ${result.warnings.length - 12} autre(s).`, null);
  }
  btn.disabled = false;
  btn.innerHTML = "Generer l'horaire";
  showAlert('gen-alerts', 'ok', `Horaire de ${monthLabel(mois)} genere !`);
  updateMonthLabels();
}

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr, L){
  const [yr, mo] = moisStr.split('-').map(Number);
  const jours    = getDays(yr, mo);
  const planning = {}, warnings = [];

  // ── Regles (P1) ──
  const minRepos     = getRule('min_repos', 11);
  const maxCons      = getRule('max_consec', 7);
  const maxWeMois    = getRule('max_we_mois', 2);
  const reposNuit    = getRule('repos_apres_nuit', 1);
  const maxNuitsCons = getRule('max_nuits_consec', 5);
  const horizon      = +document.getElementById('gen-horizon').value || 3;

  const isNuit = p => p.type === 'nuit' || p.debut >= '22:00' || (p.fin <= '07:00' && p.fin > '00:00');
  const isWE   = d => d.getDay() === 0 || d.getDay() === 6;
  const ratioE = e => getTargetH(e) / 38;

  // ================================================================
  // HISTORIQUE (P3 - base de calcul)
  // Pour chaque educ : solde heures cumule, nb prestations par plage,
  // nb WE travailles, nb feries travailles
  // ================================================================
  const hist = {};
  educs.forEach(e => {
    hist[e.id] = { solde: 0, plageCount: {}, we: 0, ferie: 0 };
    plages.forEach(p => hist[e.id].plageCount[p.id] = 0);
  });

  for(let i = 1; i < horizon; i++){
    const key  = moisKey(yr, mo - i);
    const plan = horaire[key];
    if(!plan) continue;
    const [ky, km] = key.split('-').map(Number);
    const joursMois = getDays(ky, km);
    // Jours ouvrables reels de ce mois (lun-ven hors feries)
    const joursOuvMois = joursMois.filter(d => {
      const dw = d.getDay(); return dw >= 1 && dw <= 5 && !isFerie(dayStr(d));
    });

    // Heures travaillees ce mois-la par educ
    const hParEduc = {};
    educs.forEach(e => hParEduc[e.id] = 0);

    joursMois.forEach(day => {
      const ds  = dayStr(day);
      const weD = isWE(day);
      const feD = isFerie(ds);
      Object.entries(plan[ds] || {}).forEach(([pid, ids]) => {
        if(pid.startsWith('_') || !Array.isArray(ids)) return;
        const p = plages.find(x => x.id === +pid); if(!p) return;
        ids.forEach(eid => {
          const id = +eid;
          if(hist[id] === undefined) return;
          hParEduc[id] += p.dureeH;
          hist[id].plageCount[p.id] = (hist[id].plageCount[p.id] || 0) + 1;
          if(weD) hist[id].we++;
          if(feD) hist[id].ferie++;
        });
      });
    });

    // Solde = h travaillees - cible du mois (7.6h x jours ouvrables reels x ratio)
    educs.forEach(e => {
      const cible = joursOuvMois.length * 7.6 * ratioE(e);
      hist[e.id].solde += (hParEduc[e.id] - cible);
    });
  }

  // ================================================================
  // QUOTA DU MOIS (P3)
  // ================================================================
  // Jours ouvrables reels du mois (lun-ven hors feries actifs)
  const joursOuv = jours.filter(d => {
    const dw = d.getDay(); return dw >= 1 && dw <= 5 && !isFerie(dayStr(d));
  });
  const poidsTotal = educs.reduce((s, e) => s + ratioE(e), 0);

  // Quota heures : 7.6h x jours ouvrables reels x ratio + ajustement solde (borne ±8h)
  const quotaH = {};
  educs.forEach(e => {
    const base  = joursOuv.length * 7.6 * ratioE(e); // formule correcte
    const ajust = Math.max(-8, Math.min(8, -hist[e.id].solde * 0.35));
    quotaH[e.id] = base + ajust;
  });

  // Quota prestations par plage (equite proportionnelle)
  const quotaPlage = {};
  educs.forEach(e => { quotaPlage[e.id] = {}; });
  plages.forEach(p => {
    const joursActifs = jours.filter(d => {
      const di = d.getDay() === 0 ? 6 : d.getDay() - 1;
      const dc = (isFerie(dayStr(d)) && !isWE(d)) ? 5 : di;
      return p.jours.includes(dc);
    }).length;
    const totalPostes = joursActifs * p.min;
    educs.forEach(e => {
      const partBase = totalPostes * ratioE(e) / Math.max(0.01, poidsTotal);
      // Correction historique : si trop de cette plage -> moins prioritaire
      const avgHistPlage = educs.reduce((s, x) =>
        s + (hist[x.id].plageCount[p.id] || 0) * ratioE(e) / Math.max(0.01, ratioE(x))
      , 0) / Math.max(1, educs.length);
      const ecart = (hist[e.id].plageCount[p.id] || 0) - avgHistPlage;
      quotaPlage[e.id][p.id] = Math.max(0, partBase - ecart * 0.4);
    });
  });

  // ================================================================
  // PATTERN DE SEMAINE TYPE (P3 - recurrence)
  // On preassigne une "equipe fixe" par jour+plage.
  // Ce pattern sera favor dans le score mais JAMAIS impose
  // si cela viole P1 ou empeche la couverture P2.
  // ================================================================
  // Nb de WE dans le mois et leur numero
  const weNumMap = {};
  let weIdx = -1;
  jours.forEach(d => {
    if(d.getDay() === 6) weIdx++;
    if(d.getDay() === 0 && weIdx < 0) weIdx = 0;
    if(isWE(d)) weNumMap[dayStr(d)] = Math.max(0, weIdx);
  });
  const nbWE = weIdx + 1;

  // Pattern semaine (lun-ven)
  const patternSem = {}; // [dow][plageId] = [educId,...]
  for(let dow = 0; dow <= 4; dow++){
    patternSem[dow] = {};
    plages.filter(p => p.jours.includes(dow)).forEach(p => {
      const cands = educs
        .filter(e => (e.jours || []).includes(dow) && !(e.excls || []).includes(p.id))
        .sort((a, b) => {
          // Priorite : quota plage desc, preference
          const pa = (a.prefs || []).includes(p.id) ? 3 : 0;
          const pb = (b.prefs || []).includes(p.id) ? 3 : 0;
          return (quotaPlage[b.id][p.id] + pb) - (quotaPlage[a.id][p.id] + pa);
        });
      patternSem[dow][p.id] = cands.slice(0, p.min).map(e => e.id);
    });
  }

  // Pattern WE : rotation entre les WE du mois
  const patternWE = {}; // [weNum][plageId] = [educId,...]
  for(let wn = 0; wn < Math.max(1, nbWE); wn++){
    patternWE[wn] = {};
    [5, 6].forEach(dow => {
      plages.filter(p => p.jours.includes(dow)).forEach(p => {
        const cands = educs
          .filter(e => (e.jours || []).includes(dow) && !(e.excls || []).includes(p.id))
          .sort((a, b) => (hist[a.id].we || 0) - (hist[b.id].we || 0));
        // Rotation circulaire selon le numero de WE
        const offset  = wn % Math.max(1, cands.length);
        const rotated = [...cands.slice(offset), ...cands.slice(0, offset)];
        patternWE[wn][p.id] = rotated.slice(0, p.min).map(e => e.id);
      });
    });
  }

  // ================================================================
  // TRACKER EN-COURS-DE-MOIS
  // ================================================================
  const tracker = {};
  const lastA   = {};
  educs.forEach(e => {
    tracker[e.id] = {
      h: 0, nuits: 0, nuitsC: 0,
      weCount: 0, weJours: new Set(),
      cons: 0, lastDay: null,
      plageCount: {}
    };
    plages.forEach(p => tracker[e.id].plageCount[p.id] = 0);
    lastA[e.id] = null;
  });

  // Continuite depuis le mois precedent
  const prevPlan = horaire[moisKey(yr, mo - 1)] || {};
  const prevDays = Object.keys(prevPlan).sort();
  prevDays.forEach(ds => {
    Object.entries(prevPlan[ds] || {}).forEach(([pid, ids]) => {
      if(pid.startsWith('_') || !Array.isArray(ids)) return;
      const p = plages.find(x => x.id === +pid); if(!p) return;
      ids.forEach(eid => {
        const id = +eid;
        if(!lastA[id]) lastA[id] = { date: ds, fin: p.fin, isNuit: isNuit(p), pm: p.fin < p.debut };
        else if(ds > lastA[id].date) lastA[id] = { date: ds, fin: p.fin, isNuit: isNuit(p), pm: p.fin < p.debut };
      });
    });
  });

  // ================================================================
  // P1 : VERIFICATION CONTRAINTES LEGALES (retourne true si OK)
  // C'est le filtre absolu - un educ qui ne passe pas ce filtre
  // ne peut PAS etre assigne, point final.
  // ================================================================
  function respecteLoi(e, d, ds, dow, plage){
    // Jours de travail declares
    if(!(e.jours || []).includes(dow)) return false;
    // Absence encodee
    if(isAbsent(e.id, ds)) return false;
    const t  = tracker[e.id];
    const la = lastA[e.id];
    // Max jours consecutifs
    if(t.cons >= maxCons) return false;
    // Max nuits consecutives
    if(isNuit(plage) && t.nuitsC >= maxNuitsCons) return false;
    // Repos minimum entre deux prestations
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
    return true;
  }

  // ================================================================
  // CONVENTION INTERNE (filtre souple - relachable si besoin P2)
  // ================================================================
  function respecteConvention(e, d, ds, plage, strict){
    const t = tracker[e.id];
    // Plage refusee par l'educ (excls)
    if((e.excls || []).includes(plage.id)) return false;
    // Max WE par mois
    if(isWE(d) && t.weCount >= maxWeMois) return false;
    // En mode strict : bloquer si tres largement au-dessus du quota (+20h)
    if(strict){
      const solde = hist[e.id].solde + (t.h - quotaH[e.id]);
      if(solde > 20) return false;
    }
    return true;
  }

  // ================================================================
  // P3+P4 : SCORE (arbitrage entre candidats valides)
  // Score BAS = plus prioritaire
  // ================================================================
  function score(e, d, ds, plage, weOrFerie, patternIds){
    const t  = tracker[e.id];
    const ht = hist[e.id];
    let sc   = 0;

    // --- P3a : SOLDE HEURES ---
    // Solde cumule + ce mois jusqu'ici vs quota
    const soldeTotal = ht.solde + (t.h - quotaH[e.id]);
    sc += soldeTotal * 3.0;
    // Bonus fort si l'educ a besoin d'heures (solde tres negatif)
    if(soldeTotal < -20) sc -= 30; // tres prioritaire
    else if(soldeTotal < -10) sc -= 15;
    else if(soldeTotal < -5)  sc -= 5;
    // Malus si deja bien au-dessus du quota
    if(soldeTotal > 15) sc += 20;
    else if(soldeTotal > 8)  sc += 8;

    // --- P3b : EQUITE PRESTATIONS PAR PLAGE (poids renforce) ---
    const myCount    = (ht.plageCount[plage.id] || 0) + (t.plageCount[plage.id] || 0);
    const cibleCount = quotaPlage[e.id][plage.id] || 0;
    const ecartCount = myCount - cibleCount;
    sc += ecartCount * 8; // poids fort pour l'equite par plage
    // Bonus supplementaire si vraiment en deficit sur cette plage
    if(ecartCount < -2) sc -= 10;

    // --- P3c : RECURRENCE / PATTERN ---
    // Bonus fort si l'educ est dans le pattern prevu pour ce jour
    if(patternIds && patternIds.includes(e.id)) sc -= 10; // reduit pour ne pas ecraser l'equite

    // --- P3d : EQUITE WE ---
    if(weOrFerie){
      const myWE  = (ht.we || 0) + t.weCount;
      const avgWE = educs.reduce((s, x) =>
        s + ((hist[x.id].we || 0) + tracker[x.id].weCount) * ratioE(e) / Math.max(0.01, ratioE(x))
      , 0) / Math.max(1, educs.length);
      sc += (myWE - avgWE) * 7;
    }

    // --- P3e : EQUITE FERIES ---
    if(isFerie(ds)){
      const myFer  = ht.ferie || 0;
      const avgFer = educs.reduce((s, x) =>
        s + (hist[x.id].ferie || 0) * ratioE(e) / Math.max(0.01, ratioE(x))
      , 0) / Math.max(1, educs.length);
      sc += (myFer - avgFer) * 9;
    }

    // --- P3f : EQUITE NUITS (poids eleve car difficile a equilibrer) ---
    if(isNuit(plage)){
      const myNuits  = (hist[e.id].plageCount[plage.id] || 0) + t.nuits;
      // Moyenne ponderee par contrat
      const avgNuits = educs.reduce((s, x) => {
        return s + ((hist[x.id].plageCount[plage.id] || 0) + tracker[x.id].nuits)
               * ratioE(e) / Math.max(0.01, ratioE(x));
      }, 0) / Math.max(1, educs.length);
      sc += (myNuits - avgNuits) * 12; // poids fort pour les nuits
    }

    // --- P4 : DEMANDES EDUCS ---
    // Preferences de plage (declares dans le profil)
    if((e.prefs || []).includes(plage.id)) sc -= 14;
    // Demandes structurees (jour + plage specifique)
    const dowCheck = d.getDay() === 0 ? 6 : d.getDay() - 1;
    (e.demandes || []).forEach(dem => {
      if(dem.jour === dowCheck && (dem.plageIds || []).includes(plage.id)){
        if(dem.type === 'eviter')  sc += 20;
        if(dem.type === 'prefere') sc -= 20;
      }
    });

    // Eviter double prestation le meme jour
    if(Object.values(planning[ds] || {}).some(ids => Array.isArray(ids) && ids.map(x=>+x).includes(e.id))) sc += 18;

    return sc;
  }

  function updateTracker(e, d, ds, plage, nuit, we){
    const t = tracker[e.id];
    t.h += plage.dureeH;
    t.cons = (t.lastDay && Math.round((d - new Date(t.lastDay)) / 86400000) === 1) ? t.cons + 1 : 1;
    t.lastDay = ds;
    if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC = 0;
    if(we && !t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay() === 6) t.weCount++; }
    t.plageCount[plage.id] = (t.plageCount[plage.id] || 0) + 1;
    lastA[e.id] = { date: ds, fin: plage.fin, isNuit: nuit, pm: plage.fin < plage.debut };
  }

  // ================================================================
  // BOUCLE PRINCIPALE
  // ================================================================
  L('Generation jour par jour...', 38);

  for(let di = 0; di < jours.length; di++){
    if(di % 3 === 0){
      L(`Jour ${di + 1} / ${jours.length}...`, 38 + Math.round((di / jours.length) * 57));
      await sl(0);
    }

    const d      = jours[di];
    const ds     = dayStr(d);
    const dow    = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const we     = isWE(d);
    const ferie  = isFerie(ds);
    planning[ds] = {};

    const dowForPlages = (ferie && !we) ? 5 : dow;
    const pjBase = plages.filter(p => p.jours.includes(dowForPlages));

    // Pattern du jour
    const weN = weNumMap[ds] !== undefined ? weNumMap[ds] : 0;
    const patternJour = we
      ? (patternWE[weN] || patternWE[0] || {})
      : (patternSem[dow] || {});

    // TRIER les plages par difficulte de couverture DECROISSANTE :
    // Les plages les plus difficiles a couvrir (peu de candidats valides)
    // sont traitees EN PREMIER pour garantir leur couverture.
    // Au sein d'un meme niveau de difficulte : nuits avant tout.
    const pj = [...pjBase].sort((a, b) => {
      // Compter candidats valides (loi uniquement, pas convention)
      const candsA = educs.filter(e => respecteLoi(e, d, ds, dow, a)).length;
      const candsB = educs.filter(e => respecteLoi(e, d, ds, dow, b)).length;
      // Ratio candidats/minimum : plus c'est bas, plus c'est difficile
      const ratioA = candsA / Math.max(1, +a.min || 1);
      const ratioB = candsB / Math.max(1, +b.min || 1);
      if(Math.abs(ratioA - ratioB) > 0.5) return ratioA - ratioB; // difficulte diff
      // Si difficulte similaire : nuits en premier
      const nuitA = isNuit(a) ? -1 : 0;
      const nuitB = isNuit(b) ? -1 : 0;
      return nuitA - nuitB;
    });

    // ============================================================
    // PASSE A - P1+P2 : Couverture MINIMUM de TOUTES les plages d'abord
    // On couvre le minimum de chaque plage avant de passer aux maximums.
    // P1 (loi) = absolu. P2 (convention) = relachable si besoin.
    // ============================================================
    for(const plage of pj){
      const nuit   = isNuit(plage);
      const reqMin = Math.max(0, +plage.min || 1);
      const useAll = plage.tous;
      const pIds   = patternJour[plage.id] || [];

      // Etape A1 : candidats respectant P1 ET P2 (convention)
      let cands = educs.filter(e =>
        respecteLoi(e, d, ds, dow, plage) &&
        respecteConvention(e, d, ds, plage, true)
      );

      // Etape A2 : si pas assez, on relache P2 (convention) mais PAS P1 (loi)
      // Exception : plage refusee (excls) reste bloquee meme en relachement
      // sauf si vraiment aucun autre choix
      if(cands.length < reqMin && !useAll){
        const candsLaxP2 = educs.filter(e =>
          respecteLoi(e, d, ds, dow, plage) &&
          !(e.excls || []).includes(plage.id)  // excls reste bloque (quota relache)
        );
        if(candsLaxP2.length >= reqMin){
          cands = candsLaxP2;
          // On note que la convention WE est violee
        } else {
          // Dernier recours : on permet meme les excls si aucun autre choix
          const candsUrgence = educs.filter(e => respecteLoi(e, d, ds, dow, plage));
          cands = candsUrgence;
        }
      }

      // Trier par score P3+P4
      const scored = cands
        .map(e => ({ e, sc: score(e, d, ds, plage, we || ferie, pIds) }))
        .sort((a, b) => a.sc - b.sc);

      const n        = useAll ? scored.length : Math.min(reqMin, scored.length);
      const assigned = scored.slice(0, n).map(x => x.e);

      planning[ds][plage.id] = assigned.map(e => e.id);

      // Statuts pour l'affichage
      assigned.forEach(e => {
        const isPref   = (e.prefs || []).includes(plage.id);
        const isExcl   = (e.excls || []).includes(plage.id);
        const dowCheck = d.getDay() === 0 ? 6 : d.getDay() - 1;
        const dem      = (e.demandes || []).find(x =>
          x.jour === dowCheck && (x.plageIds || []).includes(plage.id)
        );
        const sk       = `_s_${e.id}_${plage.id}`;
        const inPat    = pIds.includes(e.id);

        if(isExcl){
          planning[ds][sk] = 'forced';
          warnings.push(`${ds} - ${plage.nom} : plage refusee assignee a ${e.prenom} (manque de personnel)`);
        } else if(dem && dem.type === 'eviter'){
          planning[ds][sk] = 'dem_evite';
          warnings.push(`${ds} - ${plage.nom} : demande de ${e.prenom} non respectee (besoin de couverture)`);
        } else if(dem && dem.type === 'prefere'){
          planning[ds][sk] = 'dem_pref';
        } else if(isPref || inPat){
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
    // PASSE B - P5 : Couverture MAXIMUM
    // On ajoute des educs supplementaires UNIQUEMENT si :
    // - ils respectent P1 (loi) et P2 (convention)
    // - ils ont besoin d'heures (solde negatif ou quota non atteint)
    // ============================================================
    for(const plage of pj){
      if(plage.tous) continue;
      const nuit   = isNuit(plage);
      const reqMin = Math.max(0, +plage.min || 1);
      const reqMax = Math.max(reqMin, +plage.max || reqMin);
      if(reqMax <= reqMin) continue;

      const dejaDans = (planning[ds][plage.id] || []).map(x => +x);
      const encore   = reqMax - dejaDans.length;
      if(encore <= 0) continue;

      const pIds = patternJour[plage.id] || [];

      // P5 : candidats qui respectent P1+P2 ET qui ont besoin d'heures
      const cands = educs
        .filter(e => {
          if(dejaDans.includes(e.id)) return false;
          if(!respecteLoi(e, d, ds, dow, plage)) return false;       // P1 absolu
          if(!respecteConvention(e, d, ds, plage, false)) return false; // P2 sans blocage quota
          // Besoin d'heures : on ajoute si pas encore au-dessus du quota + marge
          const soldeTotal = hist[e.id].solde + (tracker[e.id].h - quotaH[e.id]);
          return soldeTotal < 15; // marge genereusse pour couvrir les nuits/WE
        })
        .map(e => ({ e, sc: score(e, d, ds, plage, we || ferie, pIds) }))
        .sort((a, b) => a.sc - b.sc)
        .slice(0, encore)
        .map(x => x.e);

      if(!cands.length) continue;

      planning[ds][plage.id] = [...dejaDans, ...cands.map(e => e.id)];
      cands.forEach(e => {
        const isPref = (e.prefs || []).includes(plage.id);
        const isExcl = (e.excls || []).includes(plage.id);
        const inPat  = pIds.includes(e.id);
        planning[ds][`_s_${e.id}_${plage.id}`] =
          isExcl ? 'forced' : (isPref || inPat) ? 'pref' : 'neutral';
        updateTracker(e, d, ds, plage, isNuit(plage), we);
      });
    }
  }

  // ================================================================
  // VERIFICATION FINALE DES SOLDES
  // ================================================================
  L('Verification soldes finaux...', 97);
  educs.forEach(e => {
    const soldeTotal = hist[e.id].solde + tracker[e.id].h - quotaH[e.id];
    if(Math.abs(soldeTotal) > 15){
      warnings.push(`Solde ${e.prenom} ${e.nom} : ${soldeTotal >= 0 ? '+' : ''}${soldeTotal.toFixed(1)}h (depasse ±15h)`);
    }
  });

  return { planning, warnings };
}
