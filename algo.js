// ============================================================
// algo.js — Moteur de génération automatique des horaires
// ============================================================

// ── Vérification avant génération ──
function verifier(){
  const warns = [];
  if(!educs.length)  warns.push({t:'err', m:'Aucun éducateur défini.'});
  if(!plages.length) warns.push({t:'err', m:'Aucune plage horaire définie.'});

  const rc = document.getElementById('gen-recap');
  const ri = document.getElementById('gen-recap-content');
  rc.style.display = 'block';

  let html = warns.map(w=>`<div class="alert a-${w.t}">⚠️ ${w.m}</div>`).join('');
  if(!warns.length){
    html += `<div class="alert a-ok">✅ ${educs.length} éducateurs · ${plages.length} plages</div>`;
    html += plages.map(p=>{
      const j = p.jours.map(x=>JOURS[x]).join(', ');
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> · ${p.debut}→${p.fin} · min ${p.min} éduc · ${j}
      </div>`;
    }).join('');
  }
  ri.innerHTML = html;
}

// ── Lancement de la génération ──
async function lancer(){
  if(!educs.length || !plages.length){ verifier(); return; }
  const mois = document.getElementById('gen-mois').value;
  if(!mois){ alert('Choisissez un mois.'); return; }

  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div> Génération…';
  document.getElementById('gen-prog').style.display = 'block';
  document.getElementById('gen-alerts').innerHTML = '';

  const log = document.getElementById('gen-log');
  log.innerHTML = '';
  const L = (m,p) => {
    log.innerHTML += m+'<br>';
    log.scrollTop = log.scrollHeight;
    if(p!=null) document.getElementById('gen-bar').style.width = p+'%';
  };

  L('🔍 Analyse…', 5); await sl(200);
  L(`👥 ${educs.length} éducateurs · ${plages.length} plages`, 15); await sl(200);
  L('📐 Construction du calendrier…', 25); await sl(200);

  const result = await genMois(mois, L);

  // Sauvegarder ce mois sans écraser les autres
  horaire[mois] = result.planning;
  currentMonth = mois;
  save();

  L('✅ Terminé !', 100); await sl(200);
  if(result.warnings.length){
    result.warnings.slice(0,8).forEach(w => L('⚠️ '+w, null));
    if(result.warnings.length>8) L(`… et ${result.warnings.length-8} autre(s).`, null);
  }

  btn.disabled = false;
  btn.innerHTML = '⚡ Générer l\'horaire';
  showAlert('gen-alerts','ok',`Horaire de ${monthLabel(mois)} généré ! Consultez "Horaire mensuel".`);
  updateMonthLabels();
}

// ── Algorithme principal (asynchrone pour ne pas bloquer le navigateur) ──
async function genMois(moisStr, L){
  const [yr,mo] = moisStr.split('-').map(Number);
  const jours   = getDays(yr, mo);
  const planning = {}, warnings = [];

  // Règles actives
  const minRepos     = getRule('min_repos', 11);
  const maxCons      = getRule('max_consec', 7);
  const maxWe        = getRule('max_we_mois', 2);
  const reposNuit    = getRule('repos_apres_nuit', 1);
  const maxNuitsCons = getRule('max_nuits_consec', 5);
  const horizon      = +document.getElementById('gen-horizon').value || 3;

  const isNuit = p => p.type==='nuit' || p.debut>='22:00' || (p.fin<='07:00' && p.fin>'00:00');
  const isWE   = d => d.getDay()===0 || d.getDay()===6;

  // ── Quota mensuel réel : jours ouvrables - fériés actifs × 7.6h × ratio ──
  const H_PAR_JOUR = 7.6;
  const quotaMois = {};
  educs.forEach(e=>{
    const ratio = getTargetH(e) / 38;
    const joursOuvrables = jours.filter(d=>{
      const dow = d.getDay();
      if(dow < 1 || dow > 5) return false; // exclure sam/dim
      if(isFerie(dayStr(d))) return false;  // exclure jours fériés actifs
      return true;
    });
    quotaMois[e.id] = joursOuvrables.length * H_PAR_JOUR * ratio;
  });

  // ── Cumul heures + plages + WE + SOLDE RÉEL sur les mois précédents ──
  const cumH = {}, cumPlage = {}, cumWE = {}, soldeReel = {};
  educs.forEach(e => { cumH[e.id]=0; cumPlage[e.id]={}; cumWE[e.id]=0; soldeReel[e.id]=0; });

  for(let i=1; i<horizon; i++){
    const key  = moisKey(yr, mo-i);
    const plan = horaire[key];
    if(!plan) continue;
    const [ky,km] = key.split('-').map(Number);

    // Calculer la cible réelle de ce mois passé pour chaque éduc
    const joursMois = getDays(ky,km);

    getDays(ky,km).forEach(day=>{
      const ds = dayStr(day);
      const weDay = isWE(day);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')) return;
        if(!Array.isArray(ids)) return;
        const p = plages.find(x=>x.id===+pid); if(!p) return;
        ids.forEach(eid=>{
          const id = +eid;
          cumH[id]     = (cumH[id]||0) + p.dureeH;
          cumPlage[id] = cumPlage[id]||{};
          cumPlage[id][p.id] = (cumPlage[id][p.id]||0)+1;
          if(weDay) cumWE[id] = (cumWE[id]||0)+1;
        });
      });
    });

    // Calculer le solde de ce mois : heures travaillées - cible du mois
    educs.forEach(e=>{
      const ratio = getTargetH(e) / 38;
      const joursOuvr = joursMois.filter(d=>{
        const dow = d.getDay();
        return dow>=1 && dow<=5 && !isFerie(dayStr(d));
      });
      const cibleMois = joursOuvr.length * 7.6 * ratio;
      // Heures travaillées ce mois-là
      let hMois = 0;
      getDays(ky,km).forEach(day=>{
        const ds = dayStr(day);
        Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_') || !Array.isArray(ids)) return;
          const p = plages.find(x=>x.id===+pid); if(!p) return;
          if(ids.map(x=>+x).includes(e.id)) hMois += p.dureeH;
        });
      });
      soldeReel[e.id] = (soldeReel[e.id]||0) + (hMois - cibleMois);
    });
  }

  // ── Dernier WE travaillé du mois précédent (pour alternance inter-mois) ──
  const lastWEWorked = {};
  educs.forEach(e => { lastWEWorked[e.id] = null; });
  const prevKey  = moisKey(yr, mo-1);
  const prevPlan = horaire[prevKey] || {};
  Object.entries(prevPlan).sort().forEach(([date, slots])=>{
    // Utiliser T12:00 pour éviter le bug de fuseau horaire belge
    const d = new Date(date + 'T12:00');
    if(d.getDay()===0 || d.getDay()===6){
      Object.entries(slots).forEach(([pid,ids])=>{
        // Ignorer les clés de statut (_s_...) et autres métadonnées
        if(pid.startsWith('_')) return;
        if(!Array.isArray(ids)) return;
        ids.forEach(eid => { lastWEWorked[+eid] = date; });
      });
    }
  });

  // ── Tracker par éduc pour ce mois ──
  const tracker = {};
  educs.forEach(e => {
    tracker[e.id] = { h:0, nuits:0, nuitsC:0, weCount:0, weJours:new Set(), cons:0, lastDay:null, plageCount:{} };
    plages.forEach(p => tracker[e.id].plageCount[p.id]=0);
  });
  const lastA = {};
  educs.forEach(e => { lastA[e.id] = null; });

  // ── Numérotation des WE du mois ──
  const weGroups = {};
  let weNum = 0, lastWeNum = -1;
  jours.forEach(d => {
    if(isWE(d)){
      const wk = Math.ceil(d.getDate()/7);
      if(wk !== lastWeNum){ weNum++; lastWeNum=wk; }
      weGroups[dayStr(d)] = weNum;
    }
  });

  // ── Cycle fixe : bonus si c'est le "créneau habituel" d'un éduc ──
  function getCycleScore(e, dow, plage){
    const educIdx  = educs.findIndex(x=>x.id===e.id);
    const nbEducs  = educs.length;
    if(nbEducs===0) return 0;
    const plageIdx = plages.findIndex(x=>x.id===plage.id);
    const match    = ((dow + plageIdx*3) % nbEducs) === educIdx;
    return match ? -20 : 0;
  }

  // ── canWork : strict=true respecte convention, strict=false respecte loi seulement ──
  function canWork(e, d, ds, dow, plage, strict){
    if(!(e.jours||[]).includes(dow))          return false;
    if(isAbsent(e.id, ds))                    return false;
    if((e.excls||[]).includes(plage.id))      return false; // refus explicite — toujours respecté
    const t = tracker[e.id];
    // LOI — jamais enfreinte
    if(t.cons >= maxCons)                     return false;
    if(isNuit(plage) && t.nuitsC>=maxNuitsCons) return false;
    const la = lastA[e.id];
    if(la){
      const [lh,lm] = la.fin.split(':').map(Number);
      const [bh,bm] = plage.debut.split(':').map(Number);
      const finMs = new Date(la.date+'T00:00').getTime() + (la.pm?86400000:0) + (lh*60+lm)*60000;
      const debMs = new Date(ds+'T00:00').getTime() + (bh*60+bm)*60000;
      const dh    = (debMs - finMs) / 3600000;
      if(dh>=0 && dh<minRepos) return false;
    }
    if(la?.isNuit && reposNuit>0){
      const diff = Math.round((d - new Date(la.date)) / 86400000);
      if(diff <= reposNuit) return false;
    }
    // CONVENTION — seulement en mode strict
    if(strict){
      if(isWE(d) && t.weCount >= maxWe) return false;
      // Cap adaptatif : si l'éduc est en déficit, il peut dépasser un peu son quota ce mois
      // Si en excédent, il est bloqué plus tôt
      const solde = soldeReel[e.id] || 0;
      const facteur = solde < -10 ? 1.2 : solde > 10 ? 0.95 : 1.05;
      if(t.h >= quotaMois[e.id] * facteur) return false;
    }
    return true;
  }

  // ── Score (lower = meilleur candidat) ──
  function score(e, d, ds, plage, weOrFerie){
    const t = tracker[e.id];
    let sc = 0;

    // ── PRIORITÉ 1 : Rattraper le solde cumulé des mois précédents ──
    // Si l'éduc est en déficit → fort bonus (score bas = prioritaire)
    // Si l'éduc est en excédent → fort malus (score haut = moins prioritaire)
    const solde = soldeReel[e.id] || 0;
    sc += (-solde) * 1.5; // déficit de -15h → bonus de +22.5 pts de priorité

    // ── PRIORITÉ 2 : Équité heures ce mois vs quota ──
    sc += (t.h / Math.max(1, quotaMois[e.id])) * 40;

    // Cycle fixe par jour/plage
    sc += getCycleScore(e, d.getDay()===0?6:d.getDay()-1, plage);

    // Équité type de plage sur l'historique
    const myCount  = (cumPlage[e.id]?.[plage.id]||0) + (t.plageCount[plage.id]||0);
    const avgCount = educs.reduce((s,x)=>s+((cumPlage[x.id]?.[plage.id]||0)+(tracker[x.id]?.plageCount[plage.id]||0)),0) / Math.max(1,educs.length);
    sc += (myCount - avgCount) * 5;

    // WE / fériés
    if(weOrFerie){
      sc += t.weCount * 10;
      sc += (cumWE[e.id]||0) * 3;
      const weN = weGroups[ds];
      if(weN != null){
        // Malus si travaillé WE précédent (alternance)
        const workedPrevWE = weN>1
          ? jours.filter(x=>weGroups[dayStr(x)]===weN-1 && isWE(x))
              .some(x => Object.values(planning[dayStr(x)]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id)))
          : lastWEWorked[e.id] !== null;
        if(workedPrevWE) sc += 30;

        // Bonus groupage sam+dim (travailler les 2 jours du même WE)
        const autreJourWE = jours.find(x=>{
          const xs = dayStr(x);
          return xs!==ds && weGroups[xs]===weN && isWE(x);
        });
        if(autreJourWE){
          const autreDs = dayStr(autreJourWE);
          if(Object.values(planning[autreDs]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id))) sc -= 35;
        }
      }
    }

    // Nuits : équité
    if(isNuit(plage)) sc += t.nuits * 7;
    // Préférences
    if((e.prefs||[]).includes(plage.id)) sc -= 15;
    // Double prestation même jour
    if(Object.values(planning[ds]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id))) sc += 10;

    return sc;
  }

  // ── BOUCLE PRINCIPALE ──
  for(let di=0; di<jours.length; di++){
    if(di%4===0){
      L(`📅 Jour ${di+1}/${jours.length}…`, 25+Math.round((di/jours.length)*70));
      await sl(0); // rend la main au navigateur
    }

    const d   = jours[di];
    const ds  = dayStr(d);
    const dow = d.getDay()===0 ? 6 : d.getDay()-1;
    const we  = isWE(d);
    const ferie = isFerie(ds);

    planning[ds] = {};
    // Jours fériés → appliquer les plages WE
    const dowForPlages = (ferie && !we) ? 5 : dow;
    const pj = plages.filter(p => p.jours.includes(dowForPlages));

    for(const plage of pj){
      const nuit   = isNuit(plage);
      const reqMin = Math.max(0, +plage.min || 1);
      const useAll = plage.tous;

      // Passe 1 : toutes les règles
      let cands = educs.filter(e => canWork(e,d,ds,dow,plage,true));
      // Passe 2 : loi seulement si pas assez (convention assouplie, JAMAIS la loi)
      if(cands.length < reqMin && !useAll){
        cands = educs.filter(e => canWork(e,d,ds,dow,plage,false));
      }

      const scored   = cands.map(e=>({e, sc:score(e,d,ds,plage,we||ferie)})).sort((a,b)=>a.sc-b.sc);
      const n        = useAll ? cands.length : reqMin;
      const assigned = scored.slice(0,n).map(x=>x.e);
      planning[ds][plage.id] = assigned.map(e=>e.id);

      // ── Statut demandes éducs — stocké dans une clé séparée _s_ pour éviter conflit avec IDs ──
      assigned.forEach(e=>{
        const isPref   = (e.prefs||[]).includes(plage.id);
        const isExcl   = (e.excls||[]).includes(plage.id);
        const notAsked = !isPref && !isExcl; // ni préféré ni refusé = neutre
        const statusKey = `_s_${e.id}_${plage.id}`;
        if(isExcl){
          planning[ds][statusKey] = 'forced';
          warnings.push(`${ds} · ${plage.nom} : plage refusée assignée à ${e.prenom} ${e.nom}`);
        } else if(isPref){
          planning[ds][statusKey] = 'pref';
        } else {
          planning[ds][statusKey] = 'neutral';
        }
      });

      if(assigned.length < reqMin)
        warnings.push(`${ds} · ${plage.nom} : ${reqMin-assigned.length} poste(s) vide(s) — aucun éduc légalement disponible`);

      // Mettre à jour le tracker
      const pm = plage.fin < plage.debut;
      assigned.forEach(e=>{
        const t = tracker[e.id];
        t.h    += plage.dureeH;
        t.cons  = (t.lastDay && Math.round((d-new Date(t.lastDay))/86400000)===1) ? t.cons+1 : 1;
        t.lastDay = ds;
        if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC=0;
        if(we && !t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay()===6) t.weCount++; }
        t.plageCount[plage.id] = (t.plageCount[plage.id]||0)+1;
        lastA[e.id] = {date:ds, fin:plage.fin, isNuit:nuit, pm};
      });
    }
  }

  return {planning, warnings};
}
