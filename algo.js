// ============================================================
// algo.js - PlanEduc Pro - Moteur v12
// ============================================================
// HIERARCHIE :
//  P1 - LOI          : repos 11h terrain, max 6j consec, max 2 nuits consec, 50h/sem
//  P2 - COUVERTURE   : minimum obligatoire (planning partiel si impossible)
//  P3 - EQUITE       : heures ±15h/mois, 0 trimestriel, types prorata contrat
//  P4 - STABILITE    : patterns hebdo, cycles A/B, habitudes humaines
//  P5 - PREFERENCES  : demandes educs
//  P6 - MAXIMUM      : remplir max si solde negatif
//
// NOUVEAUTES v12 :
//  - Prestations verrouillées manuellement (locked:true)
//  - Patterns hebdomadaires A/B persistants
//  - Équité progressive et lente (compensation douce)
//  - Diagnostic détaillé par jour/plage/educ
//  - Génération partielle si couverture impossible
// ============================================================

const DEBUG_MODE = false;
const isNuitP  = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion= p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('réunion');
const isWEDay  = d => d.getDay()===0||d.getDay()===6;
const dowIdx   = d => d.getDay()===0?6:d.getDay()-1;
const ratioE   = e => getTargetH(e)/38;
const POIDS_FATIGUE = {reunion:0.1,matin:1.0,aprem:1.0,soir:1.2,nuit:2.0};

function dureeHPlage(p){
  if(p.dureeH&&p.dureeH>0) return p.dureeH;
  const [dh,dm]=p.debut.split(':').map(Number);
  const [fh,fm]=p.fin.split(':').map(Number);
  let h=(fh*60+fm)-(dh*60+dm); if(h<=0) h+=1440; return h/60;
}
function typePlage(p){
  if(isReunion(p)) return 'reunion'; if(isNuitP(p)) return 'nuit';
  const h=parseInt(p.debut); if(h<10) return 'matin'; if(h<14) return 'aprem'; return 'soir';
}
function joursOuvMois(yr,mo){
  return getDays(yr,mo).filter(d=>{const dw=d.getDay();return dw>=1&&dw<=5&&!isFerie(dayStr(d));}).length;
}
function moyPonderee(arr,fn){
  return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length);
}
function normalisee(val,e){return val/Math.max(0.01,ratioE(e));}

let _plageMap=null,_educMap=null;
function plageById(id){if(!_plageMap||_plageMap.size!==plages.length)_plageMap=new Map(plages.map(p=>[p.id,p]));return _plageMap.get(+id);}
function educById(id){if(!_educMap||_educMap.size!==educs.length)_educMap=new Map(educs.map(e=>[e.id,e]));return _educMap.get(+id);}

// ================================================================
// PATTERNS HEBDOMADAIRES PERSISTANTS
// Stockés dans localStorage pour survivre entre sessions
// ================================================================
function loadPatterns(){
  try{return JSON.parse(localStorage.getItem('planeduc_v3_patterns')||'{}');}catch(e){return {};}
}
function savePatterns(patterns){
  try{localStorage.setItem('planeduc_v3_patterns',JSON.stringify(patterns));}catch(e){}
}

// Construit/met à jour les patterns depuis l'historique réel
function buildPatterns(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const patterns=loadPatterns(); // { educId: { dow: { plageId: count } } }
  // Analyser les 3 derniers mois pour extraire les habitudes
  for(let i=1;i<=3;i++){
    const key=moisKey(yr,mo-i);
    const plan=horaire[key]; if(!plan) continue;
    const [ky,km]=key.split('-').map(Number);
    getDays(ky,km).forEach(day=>{
      const ds=dayStr(day), dow=dowIdx(day);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        ids.forEach(eid=>{
          const id=String(eid);
          if(!patterns[id]) patterns[id]={};
          if(!patterns[id][dow]) patterns[id][dow]={};
          patterns[id][dow][pid]=(patterns[id][dow][pid]||0)+1;
        });
      });
    });
  }
  savePatterns(patterns);
  return patterns;
}

// Score de stabilité : bonus si l'educ garde son habitude
function scoreStabilite(e,dow,plage,patterns){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]||!pat[dow][plage.id]) return 0;
  const cnt=pat[dow][plage.id]||0;
  // Bonus progressif : plus l'habitude est ancrée, plus le bonus est fort
  if(cnt>=6) return -20; // habitude très ancrée → très prioritaire
  if(cnt>=4) return -14;
  if(cnt>=2) return -8;
  return -4;
}

// ================================================================
// STATS ANNUELLES
// ================================================================
function loadAnnualStats(){
  try{return JSON.parse(localStorage.getItem('planeduc_v3_annual')||'{}');}catch(e){return {};}
}
function updateAnnualStats(moisStr){
  try{
    const yr=moisStr.split('-')[0];
    const stats=loadAnnualStats(); if(!stats[yr]) stats[yr]={};
    const totaux={};
    educs.forEach(e=>{totaux[e.id]={heures:0,nuits:0,weekends:0,feries:0,matin:0,aprem:0,soir:0,reunion:0};});
    Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day),weD=isWEDay(day),feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          const tp=typePlage(p);
          ids.forEach(eid=>{
            const id=+eid; if(!totaux[id]) return;
            totaux[id].heures+=dureeHPlage(p);
            if(tp==='nuit')    totaux[id].nuits++;
            if(tp==='matin')   totaux[id].matin++;
            if(tp==='aprem')   totaux[id].aprem++;
            if(tp==='soir')    totaux[id].soir++;
            if(tp==='reunion') totaux[id].reunion++;
            if(weD) totaux[id].weekends++;
            if(feD) totaux[id].feries++;
          });
        });
      });
    });
    educs.forEach(e=>{stats[yr][e.id]=totaux[e.id];});
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){console.warn('updateAnnualStats:',err);}
}

// ================================================================
// PRESTATIONS VERROUILLEES
// locked[ds][plageId] = [educId,...] — jamais modifiées par l'algo
// ================================================================
function getLockedSlots(moisStr){
  const plan=horaire[moisStr]||{};
  const locked={};
  Object.entries(plan).forEach(([ds,slots])=>{
    Object.entries(slots).forEach(([pid,val])=>{
      if(pid.startsWith('_')) return;
      if(!Array.isArray(val)) return;
      // Chercher le statut locked dans les meta
      const lockKey='_lock_'+pid;
      if(slots[lockKey]==='locked'){
        if(!locked[ds]) locked[ds]={};
        locked[ds][pid]=val;
      }
    });
  });
  return locked;
}

// Verrouiller/déverrouiller une cellule manuellement
function toggleLock(ds, plageId){
  const mo=ds.slice(0,7);
  if(!horaire[mo]) return;
  if(!horaire[mo][ds]) return;
  const lockKey='_lock_'+plageId;
  const current=horaire[mo][ds][lockKey];
  horaire[mo][ds][lockKey]=current==='locked'?null:'locked';
  save();
  renderHoraire();
}

// ================================================================
// DETECTION D'IMPOSSIBILITES
// ================================================================
function detecterImpossibilites(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo); const msgs=[];
  plages.forEach(p=>{
    jours.forEach(d=>{
      const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
      const dc=(fe&&!we)?5:dow; if(!p.jours.includes(dc)) return;
      const dispo=educs.filter(e=>(e.jours||[]).includes(dow)&&!isAbsent(e.id,ds)).length;
      const reqMin=+p.min||1;
      if(dispo<reqMin) msgs.push(`${ds} - ${p.nom}: ${dispo}/${reqMin} educ(s) disponible(s)`);
    });
  });
  return msgs;
}

// ================================================================
// QUOTAS DURS
// ================================================================
function calculerQuotas(hist,jours,moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const joursOuv=joursOuvMois(yr,mo);
  const poidsTotal=educs.reduce((s,e)=>s+ratioE(e),0);
  const annStats=loadAnnualStats()[yr]||{};
  const quotas={};
  educs.forEach(e=>{
    const re=ratioE(e);
    const ann=annStats[e.id]||{nuits:0,weekends:0,feries:0};
    const base=joursOuv*7.6*re;
    // ÉQUITÉ PROGRESSIVE : ajustement doux (max ±8h, pas ±10h)
    const ajustSolde=Math.max(-8,Math.min(8,-(hist[e.id].solde||0)*0.4));
    quotas[e.id]={
      h:{cible:base+ajustSolde,min:base-15,max:base+15},
      plage:{},types:{},
      ann:{nuits:ann.nuits||0,weekends:ann.weekends||0,feries:ann.feries||0},
      exceptionsUsees:0,exceptionsMax:3
    };
    plages.forEach(p=>{
      if(isReunion(p)){quotas[e.id].plage[p.id]={cible:999,min:0,max:999};return;}
      const ja=jours.filter(d=>{const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;return p.jours.includes(dc);}).length;
      const totalPostes=ja*(+p.min||1);
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      // Correction historique DOUCE (0.25 au lieu de 0.3 — équité progressive)
      const myHistN=(hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgHistN=moyPonderee(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corrHist=(myHistN-avgHistN)*re*0.25;
      const annNuits=ann.nuits||0;
      const avgAnnN=moyPonderee(educs,x=>(annStats[x.id]||{}).nuits||0);
      const corrAnn=isNuitP(p)?(normalisee(annNuits,e)-avgAnnN)*re*0.15:0;
      const cibleCorr=Math.max(0,cible-corrHist-corrAnn);
      quotas[e.id].plage[p.id]={cible:cibleCorr,min:Math.max(0,Math.floor(cibleCorr-2)),max:Math.ceil(cibleCorr+2)};
    });
    ['matin','aprem','soir','nuit'].forEach(tp=>{
      const ptypes=plages.filter(p2=>!isReunion(p2)&&(tp==='nuit'?isNuitP(p2):typePlage(p2)===tp));
      let tot=0;
      ptypes.forEach(p2=>{
        const ja=jours.filter(d=>{const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;return p2.jours.includes(dc);}).length;
        tot+=ja*(+p2.min||1);
      });
      const ct=tot*re/Math.max(0.01,poidsTotal);
      quotas[e.id].types[tp]={cible:ct,min:Math.max(0,Math.floor(ct-1.5)),max:Math.ceil(ct+1.5)};
    });
  });
  return quotas;
}

// ================================================================
// PRE-ALLOCATION NUITS
// ================================================================
function preAllouerNuits(jours,quotas,hist,moisStr){
  const preAlloc={};
  const annStats=loadAnnualStats()[moisStr.split('-')[0]]||{};
  const cpt={};
  educs.forEach(e=>{cpt[e.id]={nuits:0,lastNuit:null,nuitsC:0};});
  jours.filter(d=>{
    const dow=dowIdx(d),we=isWEDay(d),fe=isFerie(dayStr(d));
    const dc=(fe&&!we)?5:dow;
    return plages.some(p=>p.jours.includes(dc)&&isNuitP(p)&&!isReunion(p));
  }).forEach(d=>{
    const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;
    preAlloc[ds]={};
    plages.filter(p=>p.jours.includes(dc)&&isNuitP(p)&&!isReunion(p)).forEach(p=>{
      const reqMin=+p.min||1;
      const cands=educs.filter(e=>{
        if(!(e.jours||[]).includes(dow)||isAbsent(e.id,ds)) return false;
        if(cpt[e.id].nuitsC>=2) return false;
        if(cpt[e.id].lastNuit&&Math.round((d-new Date(cpt[e.id].lastNuit))/86400000)<=1) return false;
        return true;
      }).sort((a,b)=>{
        const annNA=(annStats[a.id]||{}).nuits||0, annNB=(annStats[b.id]||{}).nuits||0;
        return normalisee((hist[a.id].nuits||0)+annNA+cpt[a.id].nuits,a)-normalisee((hist[b.id].nuits||0)+annNB+cpt[b.id].nuits,b);
      }).slice(0,reqMin);
      preAlloc[ds][p.id]=cands.map(e=>e.id);
      cands.forEach(e=>{cpt[e.id].nuits++;cpt[e.id].nuitsC++;cpt[e.id].lastNuit=ds;});
    });
    educs.forEach(e=>{if(cpt[e.id].lastNuit!==ds)cpt[e.id].nuitsC=0;});
  });
  return preAlloc;
}

// ================================================================
// SEMAINE GLISSANTE 50H
// ================================================================
function hSemaineCourante(tracker_e,ds){
  const d=new Date(ds+'T12:00');
  const lundi=new Date(d);
  lundi.setDate(d.getDate()-((d.getDay()+6)%7));
  const dimanche=new Date(lundi); dimanche.setDate(lundi.getDate()+6);
  let h=0;
  const jh=tracker_e.joursH||{};
  for(let dd=new Date(lundi);dd<=dimanche;dd.setDate(dd.getDate()+1)){
    const k=dayStr(dd);
    h+=jh[k]||0;
  }
  return h;
}

// ================================================================
// UI
// ================================================================
function verifier(){
  const warns=[];
  if(!educs.length)  warns.push({t:'err',m:'Aucun educateur defini.'});
  if(!plages.length) warns.push({t:'err',m:'Aucune plage horaire definie.'});
  const rc=document.getElementById('gen-recap');
  const ri=document.getElementById('gen-recap-content');
  rc.style.display='block';
  let html=warns.map(w=>`<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if(!warns.length){
    html+=`<div class="alert a-ok">OK: ${educs.length} educateurs - ${plages.length} plages</div>`;
    html+=plages.map(p=>{
      const j=p.jours.map(x=>JOURS[x]).join(', ');
      const badge=isReunion(p)?'<span class="badge b-blue" style="font-size:.6rem">REUNION</span>':'';
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> ${badge} - ${p.debut}-${p.fin} - min ${p.min} educ - ${j}
      </div>`;
    }).join('');
  }
  ri.innerHTML=html;
}

async function lancer(){
  if(!educs.length||!plages.length){verifier();return;}
  const mois=document.getElementById('gen-mois').value;
  if(!mois){alert('Choisissez un mois.');return;}
  const btn=document.getElementById('gen-btn');
  btn.disabled=true; btn.innerHTML='<div class="spin"></div> Generation...';
  document.getElementById('gen-prog').style.display='block';
  document.getElementById('gen-alerts').innerHTML='';
  const log=document.getElementById('gen-log'); log.innerHTML='';
  const L=(m,p)=>{
    log.innerHTML+=m+'<br>'; log.scrollTop=log.scrollHeight;
    if(p!=null) document.getElementById('gen-bar').style.width=p+'%';
  };

  L('Detection impossibilites...',3); await sl(50);
  const impos=detecterImpossibilites(mois);
  impos.forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);

  // Stocker le diagnostic pour l'onglet
  window._lastDiagnostic=result.diagnostic||[];

  L('Validation...',93); await sl(30);
  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);

  // Toujours sauvegarder (planning partiel accepté)
  horaire[mois]=result.planning;
  currentMonth=mois; save();
  updateAnnualStats(mois);
  buildPatterns(mois); // mettre à jour les patterns

  const qs=planningQualityScore(validation);
  L(`Score qualite : ${qs.score}/100 — ${qs.label}`,null);

  if(validation.errors.length){
    L(`⚠ ${validation.errors.length} plage(s) non couverte(s) — planning partiel`,null);
    validation.errors.slice(0,5).forEach(e=>L('  ✗ '+e,null));
  }
  validation.warnings.slice(0,8).forEach(w=>L('! '+w,null));
  result.warnings.slice(0,5).forEach(w=>L('! '+w,null));

  L('Termine !',100);
  btn.disabled=false; btn.innerHTML="Generer l'horaire";
  const alertType=validation.errors.length?'warn':'ok';
  showAlert('gen-alerts',alertType,`Horaire genere — Score : ${qs.score}/100 (${qs.label})${validation.errors.length?' — '+validation.errors.length+' poste(s) non couverts':''}`);
  updateMonthLabels();
}

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr,L){
  _plageMap=null; _educMap=null;
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const planning={}, warnings=[], diagnostic=[];
  const horizon=+document.getElementById('gen-horizon').value||3;
  const minRepos=getRule('min_repos',11);
  const maxCons=getRule('max_consec',6);
  const maxWeMois=getRule('max_we_mois',2);
  const reposNuit=getRule('repos_apres_nuit',1);
  const maxNuitsC=2;

  L('Historique...',7); await sl(30);

  // Récupérer les verrouillages existants
  const lockedSlots=getLockedSlots(moisStr);

  // ── HISTORIQUE ──
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={solde:0,plageCount:{},we:0,ferie:0,nuits:0,types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0}};
    plages.forEach(p=>hist[e.id].plageCount[p.id]=0);
  });
  for(let i=1;i<horizon;i++){
    const key=moisKey(yr,mo-i); const plan=horaire[key]; if(!plan) continue;
    const [ky,km]=key.split('-').map(Number);
    const joursMois=getDays(ky,km); const joursOuvH=joursOuvMois(ky,km);
    const hTrav={}; educs.forEach(e=>hTrav[e.id]=0);
    joursMois.forEach(day=>{
      const ds=dayStr(day),weD=isWEDay(day),feD=isFerie(ds);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        const p=plageById(+pid); if(!p) return;
        const tp=typePlage(p);
        ids.forEach(eid=>{
          const id=+eid; if(!hist[id]) return;
          hTrav[id]+=dureeHPlage(p);
          hist[id].plageCount[p.id]=(hist[id].plageCount[p.id]||0)+1;
          if(weD) hist[id].we++; if(feD) hist[id].ferie++;
          if(isNuitP(p)&&!isReunion(p)) hist[id].nuits++;
          hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e);});
  }

  L('Quotas et patterns...',14); await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr);
  const patterns=buildPatterns(moisStr);

  L('Pre-allocation nuits...',21); await sl(30);
  const preAlloc=preAllouerNuits(jours,quotas,hist,moisStr);

  // ── TRACKER ──
  const tracker={};
  const lastPrest={};
  educs.forEach(e=>{
    tracker[e.id]={
      h:0,nuits:0,nuitsC:0,weCount:0,weJours:new Set(),
      cons:0,lastDay:null,plageCount:{},
      types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},
      fatigue:0,joursH:{}
    };
    plages.forEach(p=>tracker[e.id].plageCount[p.id]=0);
    lastPrest[e.id]=null;
  });

  // Continuite mois precedent
  const prevPlan=horaire[moisKey(yr,mo-1)]||{};
  Object.keys(prevPlan).sort().forEach(ds=>{
    Object.entries(prevPlan[ds]||{}).forEach(([pid,ids])=>{
      if(pid.startsWith('_')||!Array.isArray(ids)) return;
      const p=plageById(+pid); if(!p) return;
      ids.forEach(eid=>{
        const id=+eid;
        if(!lastPrest[id]||ds>lastPrest[id].date)
          lastPrest[id]={date:ds,fin:p.fin,isNuit:isNuitP(p)&&!isReunion(p),pm:p.fin<p.debut};
      });
    });
  });

  // ── P1 : LOI ──
  function respecteLoi(e,d,ds,dow,plage){
    if(!(e.jours||[]).includes(dow)) return {ok:false,raison:'Jours de travail'};
    if(isAbsent(e.id,ds)) return {ok:false,raison:'Absence'};
    const t=tracker[e.id]; const reunion=isReunion(plage);
    if(!reunion){
      if(t.cons>=maxCons) return {ok:false,raison:`Max ${maxCons} jours consecutifs`};
      if(isNuitP(plage)&&t.nuitsC>=maxNuitsC) return {ok:false,raison:'Max 2 nuits consecutives'};
      const la=lastPrest[e.id];
      if(la){
        const [lh,lm]=la.fin.split(':').map(Number);
        const [bh,bm]=plage.debut.split(':').map(Number);
        const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
        const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
        const dh=(debMs-finMs)/3600000;
        if(dh>=0&&dh<minRepos) return {ok:false,raison:`Repos 11h (${dh.toFixed(1)}h)`};
      }
      if(la&&la.isNuit&&reposNuit>0&&Math.round((d-new Date(la.date))/86400000)<=reposNuit)
        return {ok:false,raison:'Repos apres nuit'};
      const maxHJ=isNuitP(plage)?14:11;
      const hJour=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
        const ids=(planning[ds]||{})[pp.id];
        return (Array.isArray(ids)&&ids.map(x=>+x).includes(e.id))?s+dureeHPlage(pp):s;
      },0);
      if(hJour+dureeHPlage(plage)>maxHJ) return {ok:false,raison:`Max heures/jour (${hJour.toFixed(1)}h+${dureeHPlage(plage).toFixed(1)}h)`};
    }
    const hSem=hSemaineCourante(tracker[e.id],ds);
    if(hSem+dureeHPlage(plage)>50) return {ok:false,raison:`Max 50h/sem (${hSem.toFixed(1)}h)`};
    return {ok:true,raison:''};
  }

  function respecteConvention(e,d,ds,plage,niveau){
    const reunion=isReunion(plage);
    if(niveau<2&&!reunion&&(e.excls||[]).includes(plage.id)) return {ok:false,raison:'Plage refusee',souple:false};
    if(!reunion&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1) return {ok:false,raison:'Max WE/mois',souple:true};
    if(!reunion&&niveau===0){
      const myCount=tracker[e.id].plageCount[plage.id]||0;
      const qMax=quotas[e.id]?.plage[plage.id]?.max;
      if(qMax!==undefined&&myCount>=qMax&&quotas[e.id].exceptionsUsees>=quotas[e.id].exceptionsMax)
        return {ok:false,raison:'Quota max plage',souple:true};
      const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
      if(solde>18) return {ok:false,raison:'Solde heures trop positif',souple:true};
    }
    return {ok:true,raison:''};
  }

  // ── SCORE P3+P4+P5 ──
  function score(e,d,ds,plage,weOrFerie,preAllocIds,dow){
    const t=tracker[e.id],ht=hist[e.id],re=ratioE(e),q=quotas[e.id];
    const annStats=loadAnnualStats()[moisStr.split('-')[0]]||{};
    const ann=annStats[e.id]||{nuits:0,weekends:0,feries:0};
    const reunion=isReunion(plage);
    let sc=0;

    // P3a : Solde heures (équité PROGRESSIVE = poids modéré)
    const soldeCumul=ht.solde+(t.h-q.h.cible);
    sc+=soldeCumul*3.0; // réduit de 4 à 3 pour éviter compensation brutale
    if(soldeCumul<-15) sc-=30; else if(soldeCumul<-8) sc-=15; else if(soldeCumul<-4) sc-=7;
    if(soldeCumul>15)  sc+=25; else if(soldeCumul>8)  sc+=12; else if(soldeCumul>4)  sc+=5;

    if(!reunion){
      // P3b : Equite plage
      const myCP=(ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0);
      const myCPN=normalisee(myCP,e);
      const avgCPN=moyPonderee(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
      const ecartP=myCPN-avgCPN;
      sc+=ecartP*10;
      if(ecartP<-1.5) sc-=15; if(ecartP>1.5) sc+=12;

      // P3b bis : Type
      const tp=typePlage(plage);
      const myTP=(ht.types[tp]||0)+(t.types[tp]||0);
      const myTPN=normalisee(myTP,e);
      const avgTPN=moyPonderee(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
      const ecartT=myTPN-avgTPN;
      sc+=ecartT*8; if(ecartT<-1) sc-=10; if(ecartT>1) sc+=8;

      // P3c : WE
      if(weOrFerie){
        const myWE=(ht.we||0)+(t.weCount||0)+(ann.weekends||0);
        const myWEN=normalisee(myWE,e);
        const avgWEN=moyPonderee(educs,x=>(hist[x.id].we||0)+(tracker[x.id].weCount||0)+((annStats[x.id]||{}).weekends||0));
        const ecWE=myWEN-avgWEN;
        sc+=ecWE*9; if(ecWE<-1) sc-=11; if(ecWE>1) sc+=9;
      }

      // P3d : Feries
      if(isFerie(ds)){
        const myFer=normalisee((ht.ferie||0)+(ann.feries||0),e);
        const avgFer=moyPonderee(educs,x=>(hist[x.id].ferie||0)+((annStats[x.id]||{}).feries||0));
        sc+=(myFer-avgFer)*11;
      }

      // P3e : Nuits
      if(isNuitP(plage)){
        const myN=normalisee((ht.nuits||0)+(t.nuits||0)+(ann.nuits||0),e);
        const avgN=moyPonderee(educs,x=>(hist[x.id].nuits||0)+(tracker[x.id].nuits||0)+((annStats[x.id]||{}).nuits||0));
        const ecN=myN-avgN;
        sc+=ecN*14; if(ecN<-1.5) sc-=20; if(ecN>1.5) sc+=16;
      }

      // P4 : STABILITE (patterns — poids FORT pour l'humain)
      sc+=scoreStabilite(e,dow,plage,patterns);
      if(preAllocIds&&preAllocIds.includes(e.id)) sc-=8;

      // P4 : Fatigue
      sc+=t.fatigue*0.6;
    }

    // P5 : Preferences
    if(!reunion&&(e.prefs||[]).includes(plage.id)) sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')  sc+=14;
        if(dem.type==='prefere') sc-=14;
      }
    });

    // Eviter double terrain
    if(!reunion&&!e.acceptePause){
      const dejaAuj=Object.values(planning[ds]||{})
        .some(ids=>Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)&&
          plages.some(pp=>!isReunion(pp)&&((planning[ds]||{})[pp.id]||[]).map(x=>+x).includes(e.id)));
      if(dejaAuj) sc+=22;
    }
    return sc;
  }

  function updateTracker(e,d,ds,plage,nuit,we){
    const t=tracker[e.id],tp=typePlage(plage),reunion=isReunion(plage);
    const h=dureeHPlage(plage);
    t.h+=h;
    if(!t.joursH[ds]) t.joursH[ds]=0; t.joursH[ds]+=h;
    if(!reunion){
      const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
      t.cons=diffJ===1?t.cons+1:1; t.lastDay=ds;
      if(nuit){t.nuits++;t.nuitsC++;}else t.nuitsC=0;
      if(we&&!t.weJours.has(ds)){t.weJours.add(ds);if(d.getDay()===6) t.weCount++;}
      const poids=POIDS_FATIGUE[tp]||1;
      t.fatigue+=poids*(h>10?2:h>8?1.5:h>6?0.8:0.3)+(t.cons>4?1.5:0);
      t.fatigue=Math.min(20,t.fatigue*0.93);
      lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    t.types[tp]=(t.types[tp]||0)+1;
  }

  // ================================================================
  // GENERATION JOUR PAR JOUR
  // ================================================================
  L('Generation...',27);

  for(let di=0;di<jours.length;di++){
    if(di%3===0){L(`Jour ${di+1}/${jours.length}`,27+Math.round((di/jours.length)*55));await sl(0);}
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    // Appliquer les verrouillages : copier les slots locked dans le nouveau planning
    if(lockedSlots[ds]){
      Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
        planning[ds][pid]=ids;
        planning[ds]['_lock_'+pid]='locked';
        // Mettre à jour le tracker pour les locked
        ids.forEach(eid=>{
          const e=educById(+eid); if(!e) return;
          const p=plageById(+pid); if(!p) return;
          updateTracker(e,d,ds,p,isNuitP(p)&&!isReunion(p),we);
        });
      });
    }

    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));

    // Ordre : nuits→WE→longues→reste→reunions
    function priorite(p){
      if(isReunion(p)) return 10;
      if(isNuitP(p))   return 0;
      if(we||ferie)    return 1;
      if(dureeHPlage(p)>8) return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=priorite(a),pb=priorite(b); if(pa!==pb) return pa-pb;
      const ca=educs.filter(e=>respecteLoi(e,d,ds,dow,a).ok).length;
      const cb=educs.filter(e=>respecteLoi(e,d,ds,dow,b).ok).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    const preAllocJour=preAlloc[ds]||{};

    // ── PASSE A : Minimum obligatoire ──
    for(const plage of pj){
      // Sauter si déjà verrouillé
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;

      const nuit=isNuitP(plage)&&!isReunion(plage);
      const reqMin=Math.max(0,+plage.min||1);
      const useAll=plage.tous;
      const pIds=preAllocJour[plage.id]||[];
      const reunion=isReunion(plage);

      // Diagnostic : tester tous les educs
      const diagDetails=[];
      let cands=[];

      // Niveau 1 : P1 + convention stricte
      educs.forEach(e=>{
        const loi=respecteLoi(e,d,ds,dow,plage);
        if(!loi.ok){diagDetails.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:loi.raison});return;}
        const conv=respecteConvention(e,d,ds,plage,0);
        if(!conv.ok){diagDetails.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:conv.raison+(conv.souple?' ⚠souple':'')});return;}
        cands.push(e);
      });

      // Niveau 2 : relâcher quotas/WE
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage).ok&&respecteConvention(e,d,ds,plage,1).ok);
      }
      // Niveau 3 : urgence, P1 seulement
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage).ok);
        cands.forEach(e=>{if(quotas[e.id])quotas[e.id].exceptionsUsees++;});
      }

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie,pIds,dow)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);

      planning[ds][plage.id]=assigned.map(e=>e.id);

      // Ajouter les assignés au diagnostic
      assigned.forEach(e=>{
        diagDetails.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:true,raison:'Assigné'});
      });

      // Enregistrer diagnostic si pas full couverture ou si nuit/WE
      if(assigned.length<reqMin||(isNuitP(plage)||we||ferie)){
        diagnostic.push({ds,plage:plage.nom,couverte:assigned.length>=reqMin,details:diagDetails});
      }

      assigned.forEach(e=>{
        const isExcl=!reunion&&(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom}: plage refusee assignee a ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectee`);}
        else if(dem&&dem.type==='prefere') planning[ds][sk]='dem_pref';
        else if(isPref) planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        updateTracker(e,d,ds,plage,nuit,we);
      });

      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couverts`);
    }

    // ── PASSE B : Maximum (P6) ──
    for(const plage of pj){
      if(plage.tous||isReunion(plage)) continue;
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;
      const reqMin=Math.max(0,+plage.min||1),reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin) continue;
      const dejaDans=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-dejaDans.length; if(encore<=0) continue;
      const cands=educs.filter(e=>{
        if(dejaDans.includes(e.id)) return false;
        if(!respecteLoi(e,d,ds,dow,plage).ok) return false;
        if(!respecteConvention(e,d,ds,plage,1).ok) return false;
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        return solde<10;
      }).map(e=>({e,sc:score(e,d,ds,plage,we||ferie,[],dow)}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);
      if(!cands.length) continue;
      planning[ds][plage.id]=[...dejaDans,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        planning[ds][`_s_${e.id}_${plage.id}`]=(e.excls||[]).includes(plage.id)?'forced':(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        updateTracker(e,d,ds,plage,isNuitP(plage),we);
      });
    }
  }

  // ── OPTIMISATION SWAPS ──
  L('Optimisation...',85); await sl(30);
  const passes=[
    {nom:'nuits',keyFn:(e)=>normalisee((hist[e.id].nuits||0)+(tracker[e.id].nuits||0),e),filtre:(p)=>isNuitP(p)&&!isReunion(p),maxSwaps:40},
    {nom:'WE',   keyFn:(e)=>normalisee((hist[e.id].we||0)+(tracker[e.id].weCount||0),e), filtre:(p)=>!isReunion(p),maxSwaps:20},
    {nom:'h',    keyFn:(e)=>hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible),    filtre:(p)=>!isReunion(p),maxSwaps:20},
  ];
  for(const pass of passes){
    let swaps=0;
    for(let iter=0;iter<pass.maxSwaps;iter++){
      let improved=false;
      for(const ds of Object.keys(planning)){
        // Ne pas swapper les slots verrouillés
        if(lockedSlots[ds]) continue;
        const d=new Date(ds+'T12:00'),dow=dowIdx(d),we=isWEDay(d);
        for(const plage of plages){
          if(!pass.filtre(plage)) continue;
          const ids=(planning[ds][plage.id]||[]).map(x=>+x);
          if(ids.length<1) continue;
          const reqMin=+plage.min||1;
          for(const idIn of ids){
            const eIn=educById(idIn); if(!eIn) continue;
            const sIn=pass.keyFn(eIn);
            for(const eOut of educs.filter(e=>!ids.includes(e.id))){
              if(pass.keyFn(eOut)>=sIn-1.5) continue;
              if(!validateLocalSwap(planning,ds,plage,idIn,eOut.id,reqMin,dow)) continue;
              const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
              planning[ds][plage.id]=newIds;
              delete planning[ds][`_s_${idIn}_${plage.id}`];
              planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
              if(isNuitP(plage)){tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;}
              tracker[eIn.id].plageCount[plage.id]=Math.max(0,(tracker[eIn.id].plageCount[plage.id]||0)-1);
              tracker[eOut.id].plageCount[plage.id]=(tracker[eOut.id].plageCount[plage.id]||0)+1;
              tracker[eIn.id].h=Math.max(0,tracker[eIn.id].h-dureeHPlage(plage));
              tracker[eOut.id].h+=dureeHPlage(plage);
              if(we){tracker[eIn.id].weCount=Math.max(0,(tracker[eIn.id].weCount||0)-1);tracker[eOut.id].weCount=(tracker[eOut.id].weCount||0)+1;}
              improved=true;swaps++;break;
            }
            if(improved)break;
          }
          if(improved)break;
        }
        if(improved)break;
      }
      if(!improved)break;
    }
    await sl(0);
  }

  return {planning,warnings,diagnostic,tracker,quotas};
}

function validateLocalSwap(planning,ds,plage,idIn,idOut,reqMin,dow){
  const eOut=educById(idOut); if(!eOut) return false;
  if(!(eOut.jours||[]).includes(dow)||isAbsent(eOut.id,ds)) return false;
  const newIds=(planning[ds][plage.id]||[]).map(x=>+x).filter(x=>x!==idIn).concat(idOut);
  if(newIds.length<reqMin) return false;
  if((planning[ds][plage.id]||[]).map(x=>+x).includes(idOut)) return false;
  if(!isReunion(plage)&&!eOut.acceptePause){
    const autresTerrain=Object.keys(planning[ds]||{}).filter(pid=>{
      if(pid.startsWith('_')) return false;
      const p=plageById(+pid); if(!p||isReunion(p)) return false;
      return (planning[ds][pid]||[]).map(x=>+x).includes(idOut);
    });
    if(autresTerrain.length>0) return false;
  }
  return true;
}

function validatePlanning(planning,moisStr,tracker,quotas){
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const errors=[],warns=[];
  jours.forEach(d=>{
    const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;
    plages.filter(p=>p.jours.includes(dc)).forEach(p=>{
      const ids=((planning[ds]||{})[p.id]||[]);
      if(ids.length<(+p.min||1))
        errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} educs`);
    });
  });
  const nuitsTot={},hTot={};
  educs.forEach(e=>{nuitsTot[e.id]=0;hTot[e.id]=tracker?tracker[e.id]?.h||0:0;});
  jours.forEach(d=>{
    const ds=dayStr(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)&&!isReunion(p)) nuitsTot[+id]=(nuitsTot[+id]||0)+1;
      });
    });
  });
  const avgNuitN=moyPonderee(educs,e=>nuitsTot[e.id]||0);
  let ecartNuitMax=0;
  educs.forEach(e=>{
    const myN=normalisee(nuitsTot[e.id]||0,e);
    const ec=Math.abs(myN-avgNuitN);
    if(ec>ecartNuitMax) ecartNuitMax=ec;
    if(ec>4) warns.push(`Equite nuits : ${e.prenom} ${e.nom} ecart ${ec.toFixed(1)}`);
  });
  let ecartHMax=0;
  educs.forEach(e=>{
    const solde=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(solde)>ecartHMax) ecartHMax=Math.abs(solde);
    if(Math.abs(solde)>15) warns.push(`Solde ${e.prenom}: ${solde>=0?'+':''}${solde.toFixed(1)}h`);
  });
  const metrics={
    equite:Math.max(0,100-ecartNuitMax*12),
    stabilite:80,
    couverture:errors.length===0?100:Math.max(0,100-errors.length*15),
    prefs:Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)
  };
  return {valid:true,errors,warnings:warns,metrics}; // valid=true : toujours sauvegarder
}

function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.35+m.stabilite*0.25+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'A ameliorer';
  return {score,label,details:m};
}
