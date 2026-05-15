// algo.js - Moteur de generation automatique des horaires

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
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem"><div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div><strong>${p.nom}</strong> - ${p.debut}-${p.fin} - min ${p.min} educ - ${j}</div>`;
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
  const L = (m,p) => {
    log.innerHTML += m+'<br>';
    log.scrollTop = log.scrollHeight;
    if(p!=null) document.getElementById('gen-bar').style.width = p+'%';
  };
  L('Analyse...', 5); await sl(200);
  L(`${educs.length} educateurs - ${plages.length} plages`, 15); await sl(200);
  L('Construction du calendrier...', 25); await sl(200);
  const result = await genMois(mois, L);
  horaire[mois] = result.planning;
  currentMonth = mois;
  save();
  L('Termine !', 100); await sl(200);
  if(result.warnings.length){
    result.warnings.slice(0,8).forEach(w => L('! '+w, null));
    if(result.warnings.length>8) L(`... et ${result.warnings.length-8} autre(s).`, null);
  }
  btn.disabled = false;
  btn.innerHTML = 'Generer l\'horaire';
  showAlert('gen-alerts','ok',`Horaire de ${monthLabel(mois)} genere !`);
  updateMonthLabels();
}

async function genMois(moisStr, L){
  const [yr,mo] = moisStr.split('-').map(Number);
  const jours   = getDays(yr, mo);
  const planning = {}, warnings = [];
  const minRepos     = getRule('min_repos', 11);
  const maxCons      = getRule('max_consec', 7);
  const maxWe        = getRule('max_we_mois', 2);
  const reposNuit    = getRule('repos_apres_nuit', 1);
  const maxNuitsCons = getRule('max_nuits_consec', 5);
  const horizon      = +document.getElementById('gen-horizon').value || 3;
  const isNuit = p => p.type==='nuit' || p.debut>='22:00' || (p.fin<='07:00' && p.fin>'00:00');
  const isWE   = d => d.getDay()===0 || d.getDay()===6;

  const H_PAR_JOUR = 7.6;
  const quotaMois = {};
  educs.forEach(e=>{
    const ratio = getTargetH(e) / 38;
    const joursOuv = jours.filter(d=>{ const dow=d.getDay(); return dow>=1&&dow<=5&&!isFerie(dayStr(d)); });
    quotaMois[e.id] = joursOuv.length * H_PAR_JOUR * ratio;
  });

  const cumH = {}, cumPlage = {}, cumWE = {}, soldeReel = {};
  educs.forEach(e => { cumH[e.id]=0; cumPlage[e.id]={}; cumWE[e.id]=0; soldeReel[e.id]=0; });

  for(let i=1; i<horizon; i++){
    const key  = moisKey(yr, mo-i);
    const plan = horaire[key];
    if(!plan) continue;
    const [ky,km] = key.split('-').map(Number);
    const joursMois = getDays(ky,km);
    getDays(ky,km).forEach(day=>{
      const ds = dayStr(day);
      const weDay = isWE(day);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        const p = plages.find(x=>x.id===+pid); if(!p) return;
        ids.forEach(eid=>{
          const id=+eid;
          cumH[id]=(cumH[id]||0)+p.dureeH;
          cumPlage[id]=cumPlage[id]||{};
          cumPlage[id][p.id]=(cumPlage[id][p.id]||0)+1;
          if(weDay) cumWE[id]=(cumWE[id]||0)+1;
        });
      });
    });
    educs.forEach(e=>{
      const ratio=getTargetH(e)/38;
      const joursOuv=joursMois.filter(d=>{const dow=d.getDay();return dow>=1&&dow<=5&&!isFerie(dayStr(d));});
      const cibleMois=joursOuv.length*7.6*ratio;
      let hMois=0;
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day);
        Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plages.find(x=>x.id===+pid); if(!p) return;
          if(ids.map(x=>+x).includes(e.id)) hMois+=p.dureeH;
        });
      });
      soldeReel[e.id]=(soldeReel[e.id]||0)+(hMois-cibleMois);
    });
  }

  const lastWEWorked = {};
  educs.forEach(e => { lastWEWorked[e.id] = null; });
  const prevKey  = moisKey(yr, mo-1);
  const prevPlan = horaire[prevKey] || {};
  Object.entries(prevPlan).sort().forEach(([date, slots])=>{
    const d = new Date(date + 'T12:00');
    if(d.getDay()===0||d.getDay()===6){
      Object.entries(slots).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        ids.forEach(eid => { lastWEWorked[+eid] = date; });
      });
    }
  });

  const tracker = {};
  educs.forEach(e => {
    tracker[e.id] = { h:0, nuits:0, nuitsC:0, weCount:0, weJours:new Set(), cons:0, lastDay:null, plageCount:{} };
    plages.forEach(p => tracker[e.id].plageCount[p.id]=0);
  });
  const lastA = {};
  educs.forEach(e => { lastA[e.id] = null; });

  const weGroups = {};
  let weNum = 0, lastWeNum = -1;
  jours.forEach(d => {
    if(isWE(d)){
      const wk = Math.ceil(d.getDate()/7);
      if(wk !== lastWeNum){ weNum++; lastWeNum=wk; }
      weGroups[dayStr(d)] = weNum;
    }
  });

  function getCycleScore(e, dow, plage){
    const educIdx  = educs.findIndex(x=>x.id===e.id);
    const nbEducs  = educs.length;
    if(nbEducs===0) return 0;
    const plageIdx = plages.findIndex(x=>x.id===plage.id);
    const match    = ((dow + plageIdx*3) % nbEducs) === educIdx;
    return match ? -20 : 0;
  }

  function canWork(e, d, ds, dow, plage, strict){
    if(!(e.jours||[]).includes(dow)) return false;
    if(isAbsent(e.id, ds)) return false;
    if((e.excls||[]).includes(plage.id)) return false;
    const t = tracker[e.id];
    if(t.cons >= maxCons) return false;
    if(isNuit(plage) && t.nuitsC>=maxNuitsCons) return false;
    const la = lastA[e.id];
    if(la){
      const [lh,lm] = la.fin.split(':').map(Number);
      const [bh,bm] = plage.debut.split(':').map(Number);
      const finMs = new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
      const debMs = new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
      const dh    = (debMs-finMs)/3600000;
      if(dh>=0 && dh<minRepos) return false;
    }
    if(la&&la.isNuit&&reposNuit>0){
      const diff=Math.round((d-new Date(la.date))/86400000);
      if(diff<=reposNuit) return false;
    }
    if(strict){
      if(isWE(d)&&t.weCount>=maxWe) return false;
      const solde=soldeReel[e.id]||0;
      const facteur=solde<-10?1.2:solde>10?0.95:1.05;
      if(t.h>=quotaMois[e.id]*facteur) return false;
    }
    return true;
  }

  function score(e, d, ds, plage, weOrFerie){
    const t = tracker[e.id];
    let sc = 0;
    const solde = soldeReel[e.id]||0;
    sc += (-solde)*1.5;
    sc += (t.h/Math.max(1,quotaMois[e.id]))*40;
    sc += getCycleScore(e, d.getDay()===0?6:d.getDay()-1, plage);
    const myCount=(cumPlage[e.id]&&cumPlage[e.id][plage.id]||0)+(t.plageCount[plage.id]||0);
    const avgCount=educs.reduce((s,x)=>s+((cumPlage[x.id]&&cumPlage[x.id][plage.id]||0)+(tracker[x.id]&&tracker[x.id].plageCount[plage.id]||0)),0)/Math.max(1,educs.length);
    sc += (myCount-avgCount)*5;
    if(weOrFerie){
      sc += t.weCount*10;
      sc += (cumWE[e.id]||0)*3;
      const weN = weGroups[ds];
      if(weN!=null){
        const workedPrevWE=weN>1
          ?jours.filter(x=>weGroups[dayStr(x)]===weN-1&&isWE(x)).some(x=>Object.values(planning[dayStr(x)]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id)))
          :lastWEWorked[e.id]!==null;
        if(workedPrevWE) sc+=30;
        const autreJourWE=jours.find(x=>{ const xs=dayStr(x); return xs!==ds&&weGroups[xs]===weN&&isWE(x); });
        if(autreJourWE){
          const autreDs=dayStr(autreJourWE);
          if(Object.values(planning[autreDs]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id))) sc-=35;
        }
      }
    }
    if(isNuit(plage)) sc+=t.nuits*7;
    if((e.prefs||[]).includes(plage.id)) sc-=15;

    // Demandes structurées : eviter ce jour+plage = malus, prefere = bonus
    const dowCheck = d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dowCheck && (dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')  sc+=20;
        if(dem.type==='prefere') sc-=20;
      }
    });

    if(Object.values(planning[ds]||{}).some(ids=>Array.isArray(ids)&&ids.includes(e.id))) sc+=10;
    return sc;
  }

  function updateTracker(e, d, ds, plage, nuit, we){
    const t = tracker[e.id];
    t.h += plage.dureeH;
    t.cons = (t.lastDay&&Math.round((d-new Date(t.lastDay))/86400000)===1)?t.cons+1:1;
    t.lastDay = ds;
    if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC=0;
    if(we&&!t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay()===6) t.weCount++; }
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    lastA[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
  }

  for(let di=0; di<jours.length; di++){
    if(di%4===0){ L(`Jour ${di+1}/${jours.length}...`, 25+Math.round((di/jours.length)*70)); await sl(0); }
    const d   = jours[di];
    const ds  = dayStr(d);
    const dow = d.getDay()===0?6:d.getDay()-1;
    const we  = isWE(d);
    const ferie = isFerie(ds);
    planning[ds] = {};
    const dowForPlages = (ferie&&!we)?5:dow;
    const pj = plages.filter(p=>p.jours.includes(dowForPlages));

    // PASSE A : minimum obligatoire pour chaque plage
    for(const plage of pj){
      const nuit   = isNuit(plage);
      const reqMin = Math.max(0,+plage.min||1);
      const useAll = plage.tous;
      let cands = educs.filter(e=>canWork(e,d,ds,dow,plage,true));
      if(cands.length<reqMin&&!useAll) cands=educs.filter(e=>canWork(e,d,ds,dow,plage,false));
      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?cands.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);
      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>{
        const isPref=(e.prefs||[]).includes(plage.id);
        const isExcl=(e.excls||[]).includes(plage.id);
        const dowCheck=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dowCheck&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){
          planning[ds][sk]='forced';
          warnings.push(`${ds} - ${plage.nom} : plage refusee assignee a ${e.prenom}`);
        } else if(dem&&dem.type==='eviter'){
          planning[ds][sk]='dem_evite'; // demande "eviter" non respectee
          warnings.push(`${ds} - ${plage.nom} : demande d'${e.prenom} non respectee (prefere eviter ce jour)`);
        } else if(dem&&dem.type==='prefere'){
          planning[ds][sk]='dem_pref'; // demande "prefere" respectee
        } else if(isPref){
          planning[ds][sk]='pref';
        } else {
          planning[ds][sk]='neutral';
        }
        updateTracker(e,d,ds,plage,nuit,we);
      });
      if(assigned.length<reqMin) warnings.push(`${ds} - ${plage.nom} : ${reqMin-assigned.length} poste(s) vide(s)`);
    }

    // PASSE B : remplir jusqu'au maximum
    for(const plage of pj){
      if(plage.tous) continue;
      const nuit   = isNuit(plage);
      const reqMin = Math.max(0,+plage.min||1);
      const reqMax = Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin) continue;
      const dejaDans=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-dejaDans.length;
      if(encore<=0) continue;
      const cands=educs.filter(e=>!dejaDans.includes(e.id)&&canWork(e,d,ds,dow,plage,true))
        .map(e=>({e,sc:score(e,d,ds,plage,we||ferie)})).sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);
      if(!cands.length) continue;
      planning[ds][plage.id]=[...dejaDans,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        const isPref=(e.prefs||[]).includes(plage.id);
        const isExcl=(e.excls||[]).includes(plage.id);
        planning[ds][`_s_${e.id}_${plage.id}`]=isExcl?'forced':isPref?'pref':'neutral';
        updateTracker(e,d,ds,plage,nuit,we);
      });
    }
  }

  return {planning, warnings};
}
