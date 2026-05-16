// ============================================================
// algo.js - PlanEduc Pro - Moteur v13
// ============================================================
// PHILOSOPHIE : Horaire humain, stable, institutionnel
//
// Le moteur fonctionne comme un chef educateur experimente :
// - il conserve les habitudes existantes
// - il ne change que ce qui doit changer
// - il fait tourner uniquement le penible (nuits, WE, feries)
// - il compense progressivement, jamais brutalement
//
// HIERARCHIE ABSOLUE :
//  P1 - LOI           : repos 11h, 50h/sem, max consec, nuits consec
//  P2 - EQUITE HEURES : +/-15h/mois dur, 0 trimestriel
//  P3 - STABILITE     : patterns, habitudes, semaines repetitives
//  P4 - ROTATION DOUCE: nuits/WE/feries tournent progressivement
//  P5 - PREFERENCES   : demandes educs
//  P6 - MAXIMUM       : remplir si solde negatif
//
// 3 ETAPES :
//  1. Construction stable (patterns + habitudes)
//  2. Analyse equite
//  3. Micro-ajustements cibles (swaps nuits/WE seulement)
// ============================================================

const DEBUG_MODE = false;

// -- Helpers de base --
const isNuitP  = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion= p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('reunion');
const isWEDay  = d => d.getDay()===0||d.getDay()===6;
const dowIdx   = d => d.getDay()===0?6:d.getDay()-1;
const ratioE   = e => getTargetH(e)/38;
const dbg      = (...a)=>{if(DEBUG_MODE)console.log('[v13]',...a);};

const POIDS = {reunion:0.05, matin:1.0, aprem:1.0, soir:1.2, nuit:2.0, journee:1.0};

function dureeH(p){
  if(p.dureeH&&p.dureeH>0) return p.dureeH;
  const [dh,dm]=p.debut.split(':').map(Number);
  const [fh,fm]=p.fin.split(':').map(Number);
  let h=(fh*60+fm)-(dh*60+dm); if(h<=0)h+=1440; return h/60;
}
function typePlage(p){
  if(isReunion(p)) return 'reunion'; if(isNuitP(p)) return 'nuit';
  const h=parseInt(p.debut); if(h<10)return 'matin'; if(h<14)return 'aprem'; return 'soir';
}
function joursOuvMois(yr,mo){
  return getDays(yr,mo).filter(d=>{const dw=d.getDay();return dw>=1&&dw<=5&&!isFerie(dayStr(d));}).length;
}
function moy(arr,fn){ return arr.reduce((s,x)=>s+fn(x),0)/Math.max(1,arr.length); }
function moyPond(arr,fn){ return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length); }
function norm(val,e){ return val/Math.max(0.01,ratioE(e)); }

let _pm=null,_em=null;
function plageById(id){if(!_pm||_pm.size!==plages.length)_pm=new Map(plages.map(p=>[p.id,p]));return _pm.get(+id);}
function educById(id){if(!_em||_em.size!==educs.length)_em=new Map(educs.map(e=>[e.id,e]));return _em.get(+id);}

// ================================================================
// PATTERNS PERSISTANTS (habitudes hebdomadaires)
// { educId: { dow: { plageId: count } } }
// ================================================================
function loadPatterns(){ try{return JSON.parse(localStorage.getItem('planeduc_v3_patterns')||'{}');}catch(e){return {};} }
function savePatterns(p){ try{localStorage.setItem('planeduc_v3_patterns',JSON.stringify(p));}catch(e){} }

function buildPatterns(moisStr){
  // Analyser les 4 derniers mois pour extraire les habitudes reelles
  const [yr,mo]=moisStr.split('-').map(Number);
  const patterns=loadPatterns();
  for(let i=1;i<=4;i++){
    const key=moisKey(yr,mo-i);
    const plan=horaire[key]; if(!plan) continue;
    const [ky,km]=key.split('-').map(Number);
    getDays(ky,km).forEach(day=>{
      const ds=dayStr(day),dow=dowIdx(day);
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

// Bonus de stabilite -- FORT pour les habitudes ancrees
// Un educateur qui a "toujours" fait cette plage ce jour est tres prioritaire
function bonusStabilite(e,dow,plage,patterns){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]||!pat[dow][plage.id]) return 0;
  const cnt=pat[dow][plage.id]||0;
  // Progression forte : l'habitude s'ancre exponentiellement
  if(cnt>=8)  return -35; // tres forte habitude -> tres prioritaire
  if(cnt>=6)  return -28;
  if(cnt>=4)  return -20;
  if(cnt>=2)  return -12;
  return -5;
}

// ================================================================
// STATS ANNUELLES
// ================================================================
function loadAnnualStats(){ try{return JSON.parse(localStorage.getItem('planeduc_v3_annual')||'{}');}catch(e){return {};} }

function updateAnnualStats(moisStr){
  try{
    const yr=moisStr.split('-')[0];
    const stats=loadAnnualStats(); if(!stats[yr])stats[yr]={};
    const tot={};
    educs.forEach(e=>{tot[e.id]={h:0,nuits:0,we:0,feries:0,matin:0,aprem:0,soir:0,reunion:0};});
    Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day),weD=isWEDay(day),feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          const tp=typePlage(p);
          ids.forEach(eid=>{
            const id=+eid; if(!tot[id]) return;
            tot[id].h+=dureeH(p);
            if(tp==='nuit')    tot[id].nuits++;
            if(tp==='matin')   tot[id].matin++;
            if(tp==='aprem')   tot[id].aprem++;
            if(tp==='soir')    tot[id].soir++;
            if(tp==='reunion') tot[id].reunion++;
            if(weD) tot[id].we++;
            if(feD) tot[id].feries++;
          });
        });
      });
    });
    educs.forEach(e=>{stats[yr][e.id]=tot[e.id];});
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){console.warn('updateAnnualStats:',err);}
}

// ================================================================
// VERROUILLAGES MANUELS
// ================================================================
function getLockedSlots(moisStr){
  const plan=horaire[moisStr]||{}, locked={};
  Object.entries(plan).forEach(([ds,slots])=>{
    Object.entries(slots).forEach(([pid,val])=>{
      if(pid.startsWith('_')) return;
      if(!Array.isArray(val)) return;
      if(slots['_lock_'+pid]==='locked'){
        if(!locked[ds])locked[ds]={};
        locked[ds][pid]=val;
      }
    });
  });
  return locked;
}

function toggleLock(ds,plageId){
  const mo=ds.slice(0,7);
  if(!horaire[mo]||!horaire[mo][ds]) return;
  const lk='_lock_'+plageId;
  horaire[mo][ds][lk]=horaire[mo][ds][lk]==='locked'?null:'locked';
  save(); renderHoraire();
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
      if(dispo<(+p.min||1)) msgs.push(`${ds} - ${p.nom}: ${dispo}/${p.min} educ(s) disponible(s)`);
    });
  });
  return msgs;
}

// ================================================================
// CALCUL QUOTAS (avec equite progressive douce)
// ================================================================
function calculerQuotas(hist,jours,moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const joursOuv=joursOuvMois(yr,mo);
  const poidsTotal=educs.reduce((s,e)=>s+ratioE(e),0);
  const annStats=loadAnnualStats()[yr]||{};
  const quotas={};

  educs.forEach(e=>{
    const re=ratioE(e);
    const base=joursOuv*7.6*re;
    // Correction douce du solde : max +/-6h (progressive, pas brutale)
    const ajust=Math.max(-6,Math.min(6,-(hist[e.id].solde||0)*0.35));
    quotas[e.id]={
      h:{cible:base+ajust, min:base-15, max:base+15},
      plage:{}, types:{},
      ann:(annStats[e.id]||{nuits:0,we:0,feries:0}),
      exceptionsUsees:0, exceptionsMax:3
    };

    plages.forEach(p=>{
      if(isReunion(p)){quotas[e.id].plage[p.id]={cible:999,min:0,max:999};return;}
      const ja=jours.filter(d=>{
        const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
        return p.jours.includes(dc);
      }).length;
      const totalPostes=ja*(+p.min||1);
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      // Correction historique tres douce (0.2) pour ne pas casser la stabilite
      const myN=(hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgN=moyPond(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corr=(myN-avgN)*re*0.2;
      // Correction annuelle nuits (tres legere)
      const corrAnn=isNuitP(p)?Math.max(-1,Math.min(1,(norm((annStats[e.id]||{}).nuits||0,e)-moyPond(educs,x=>(annStats[x.id]||{}).nuits||0))*re*0.1)):0;
      const c=Math.max(0,cible-corr-corrAnn);
      quotas[e.id].plage[p.id]={cible:c,min:Math.max(0,Math.floor(c-2)),max:Math.ceil(c+2)};
    });

    ['matin','aprem','soir','nuit'].forEach(tp=>{
      const pts=plages.filter(p=>!isReunion(p)&&(tp==='nuit'?isNuitP(p):typePlage(p)===tp));
      let tot=0;
      pts.forEach(p=>{
        const ja=jours.filter(d=>{const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;return p.jours.includes(dc);}).length;
        tot+=ja*(+p.min||1);
      });
      const ct=tot*re/Math.max(0.01,poidsTotal);
      quotas[e.id].types[tp]={cible:ct,min:Math.max(0,Math.floor(ct-1.5)),max:Math.ceil(ct+1.5)};
    });
  });
  return quotas;
}

// ================================================================
// PRE-ALLOCATION NUITS (vision mois complet)
// ================================================================
function preAllouerNuits(jours,hist,moisStr){
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
        // Trier par nuits normalisees (annuel inclus) : moins de nuits = prioritaire
        const nA=norm((hist[a.id].nuits||0)+((annStats[a.id]||{}).nuits||0)+cpt[a.id].nuits,a);
        const nB=norm((hist[b.id].nuits||0)+((annStats[b.id]||{}).nuits||0)+cpt[b.id].nuits,b);
        return nA-nB;
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
function hSem(trackerE,ds){
  const d=new Date(ds+'T12:00');
  const lundi=new Date(d); lundi.setDate(d.getDate()-((d.getDay()+6)%7));
  const dim=new Date(lundi); dim.setDate(lundi.getDate()+6);
  let h=0;
  for(let dd=new Date(lundi);dd<=dim;dd.setDate(dd.getDate()+1)) h+=(trackerE.joursH||{})[dayStr(dd)]||0;
  return h;
}

// ================================================================
// UI
// ================================================================
function verifier(){
  const warns=[];
  if(!educs.length)  warns.push({t:'err',m:'Aucun educateur defini.'});
  if(!plages.length) warns.push({t:'err',m:'Aucune plage horaire definie.'});
  const rc=document.getElementById('gen-recap'),ri=document.getElementById('gen-recap-content');
  rc.style.display='block';
  let html=warns.map(w=>`<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if(!warns.length){
    html+=`<div class="alert a-ok">OK: ${educs.length} educateurs - ${plages.length} plages</div>`;
    html+=plages.map(p=>{
      const j=p.jours.map(x=>JOURS[x]).join(', ');
      const b=isReunion(p)?'<span class="badge b-blue" style="font-size:.6rem">REUNION</span>':'';
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> ${b} - ${p.debut}-${p.fin} - min ${p.min} educ - ${j}</div>`;
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
  const L=(m,p)=>{log.innerHTML+=m+'<br>';log.scrollTop=log.scrollHeight;if(p!=null)document.getElementById('gen-bar').style.width=p+'%';};

  L('Detection impossibilites...',3); await sl(50);
  const impos=detecterImpossibilites(mois);
  impos.forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);
  window._lastDiagnostic=result.diagnostic||[];

  L('Validation...',93); await sl(30);
  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);

  horaire[mois]=result.planning;
  currentMonth=mois; save();
  updateAnnualStats(mois);
  buildPatterns(mois);

  const qs=planningQualityScore(validation);
  L(`Score qualite : ${qs.score}/100 -- ${qs.label}`,null);
  if(validation.errors.length) L(`⚠ ${validation.errors.length} poste(s) non couverts`,null);
  validation.warnings.slice(0,6).forEach(w=>L('! '+w,null));
  result.warnings.slice(0,4).forEach(w=>L('! '+w,null));
  L('Termine !',100);

  btn.disabled=false; btn.innerHTML="Generer l'horaire";
  const at=validation.errors.length?'warn':'ok';
  showAlert('gen-alerts',at,`Horaire genere -- Score : ${qs.score}/100 (${qs.label})${validation.errors.length?' -- '+validation.errors.length+' poste(s) non couvert(s)':''}`);
  updateMonthLabels();
}

// ================================================================
// MOTEUR PRINCIPAL -- 3 ETAPES
// ================================================================
async function genMois(moisStr,L){
  _pm=null; _em=null;
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const planning={}, warnings=[], diagnostic=[];
  const horizon=+document.getElementById('gen-horizon').value||3;
  const minRepos=getRule('min_repos',11);
  const maxCons=getRule('max_consec',6);
  const maxWeMois=getRule('max_we_mois',2);
  const reposNuit=getRule('repos_apres_nuit',1);
  const maxNuitsC=2;

  L('Etape 1 : Historique et patterns...',6); await sl(30);
  const lockedSlots=getLockedSlots(moisStr);

  // -- HISTORIQUE --
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
          hTrav[id]+=dureeH(p);
          hist[id].plageCount[p.id]=(hist[id].plageCount[p.id]||0)+1;
          if(weD)hist[id].we++; if(feD)hist[id].ferie++;
          if(isNuitP(p)&&!isReunion(p)) hist[id].nuits++;
          hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e);});
  }

  L('Etape 1 : Quotas et pre-allocation nuits...',14); await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr);
  const patterns=buildPatterns(moisStr);
  const preAlloc=preAllouerNuits(jours,hist,moisStr);

  // -- TRACKER --
  const tracker={};
  const lastPrest={};
  educs.forEach(e=>{
    tracker[e.id]={h:0,nuits:0,nuitsC:0,weCount:0,weJours:new Set(),cons:0,lastDay:null,plageCount:{},types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},fatigue:0,joursH:{}};
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

  // -- P1 : LOI --
  function checkLoi(e,d,ds,dow,plage){
    if(!(e.jours||[]).includes(dow)) return {ok:false,raison:'Jour non travaille'};
    if(isAbsent(e.id,ds)) return {ok:false,raison:'Absence encodee'};
    const t=tracker[e.id], re=isReunion(plage);
    if(!re){
      if(t.cons>=maxCons) return {ok:false,raison:`Max ${maxCons}j consecutifs`};
      if(isNuitP(plage)&&t.nuitsC>=maxNuitsC) return {ok:false,raison:'Max 2 nuits consecutives'};
      const la=lastPrest[e.id];
      if(la){
        const [lh,lm]=la.fin.split(':').map(Number);
        const [bh,bm]=plage.debut.split(':').map(Number);
        const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
        const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
        const dh=(debMs-finMs)/3600000;
        if(dh>=0&&dh<minRepos) return {ok:false,raison:`Repos 11h (${dh.toFixed(1)}h dispo)`};
      }
      if(la&&la.isNuit&&reposNuit>0&&Math.round((d-new Date(la.date))/86400000)<=reposNuit)
        return {ok:false,raison:'Repos apres nuit'};
      const maxHJ=isNuitP(plage)?14:11;
      const hJour=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
        const ids=(planning[ds]||{})[pp.id];
        return Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)?s+dureeH(pp):s;
      },0);
      if(hJour+dureeH(plage)>maxHJ) return {ok:false,raison:`Max h/jour (${(hJour+dureeH(plage)).toFixed(1)}h)`};
    }
    if(hSem(tracker[e.id],ds)+dureeH(plage)>50) return {ok:false,raison:`Max 50h/sem`};
    return {ok:true,raison:''};
  }

  function checkConvention(e,d,ds,plage,niveau){
    const re=isReunion(plage);
    if(niveau<2&&!re&&(e.excls||[]).includes(plage.id)) return {ok:false,raison:'Plage refusee',bloquant:true};
    if(!re&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1) return {ok:false,raison:'Max WE/mois',bloquant:false};
    if(!re&&niveau===0){
      // Solde heures : contrainte quasi-dure
      const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
      if(solde>14) return {ok:false,raison:`Solde +${solde.toFixed(1)}h`,bloquant:false};
      // Quota max plage
      const myC=tracker[e.id].plageCount[plage.id]||0;
      const qMax=quotas[e.id]?.plage[plage.id]?.max;
      if(qMax!==undefined&&myC>=qMax&&quotas[e.id].exceptionsUsees>=quotas[e.id].exceptionsMax)
        return {ok:false,raison:'Quota plage max',bloquant:false};
    }
    return {ok:true,raison:''};
  }

  // -- SCORE --
  // La STABILITE a le poids le plus fort pour les prestations normales
  // La ROTATION ne s'applique fort qu'aux nuits/WE/feries
  function score(e,d,ds,plage,weOrFerie,preAllocIds,dow){
    const t=tracker[e.id],ht=hist[e.id],re=ratioE(e),q=quotas[e.id];
    const annS=loadAnnualStats()[moisStr.split('-')[0]]||{};
    const ann=annS[e.id]||{nuits:0,we:0,feries:0};
    const reunion=isReunion(plage), nuit=isNuitP(plage);
    let sc=0;

    // -- P2 : Solde heures (quasi-contrainte dure) --
    const solde=ht.solde+(t.h-q.h.cible);
    // Progressif : fort seulement quand on approche +/-15h
    if(solde>12)       sc+=40;  // fort blocage
    else if(solde>8)   sc+=20;
    else if(solde>4)   sc+=8;
    else if(solde<-12) sc-=40;  // fort bonus
    else if(solde<-8)  sc-=20;
    else if(solde<-4)  sc-=8;
    else sc+=solde*1.5; // zone normale : influence douce

    if(!reunion){
      // -- P3 : STABILITE (poids FORT pour prestations normales) --
      if(!nuit&&!weOrFerie){
        // Pour matins/apres-midis/soirs normaux : bonus de stabilite tres fort
        sc+=bonusStabilite(e,dow,plage,patterns)*1.5;
      } else {
        // Pour nuits/WE/feries : bonus de stabilite normal
        sc+=bonusStabilite(e,dow,plage,patterns);
      }

      // Bonus si c'est dans la pre-allocation (nuits)
      if(preAllocIds&&preAllocIds.includes(e.id)) sc-=12;

      // -- P4 : ROTATION pour le penible (nuits/WE/feries) --
      // Pour les matins/soirs normaux : equite tres douce
      const tp=typePlage(plage);

      // Equite plage (normalisee par contrat)
      const myCP=norm((ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0),e);
      const avgCP=moyPond(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
      const ecP=myCP-avgCP;
      if(nuit||weOrFerie){
        // Rotation forte pour le penible
        sc+=ecP*12;
        if(ecP<-1.5) sc-=18; if(ecP>1.5) sc+=15;
      } else {
        // Rotation tres douce pour le normal
        sc+=ecP*4;
      }

      // Equite type (nuit/soir/matin)
      const myTP=norm((ht.types[tp]||0)+(t.types[tp]||0),e);
      const avgTP=moyPond(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
      const ecT=myTP-avgTP;
      if(nuit||weOrFerie){
        sc+=ecT*10; if(ecT<-1)sc-=12; if(ecT>1)sc+=10;
      } else {
        sc+=ecT*3; // tres doux pour le normal
      }

      // WE (annuel+mensuel)
      if(weOrFerie){
        const myWE=norm((ht.we||0)+(t.weCount||0)+(ann.we||0),e);
        const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+(tracker[x.id].weCount||0)+((annS[x.id]||{}).we||0));
        const ecWE=myWE-avgWE;
        sc+=ecWE*11; if(ecWE<-1)sc-=14; if(ecWE>1)sc+=11;
      }

      // Feries
      if(isFerie(ds)){
        const myF=norm((ht.ferie||0)+(ann.feries||0),e);
        const avgF=moyPond(educs,x=>(hist[x.id].ferie||0)+((annS[x.id]||{}).feries||0));
        sc+=(myF-avgF)*12;
      }

      // Nuits (annuel, poids max)
      if(nuit){
        const myN=norm((ht.nuits||0)+(t.nuits||0)+(ann.nuits||0),e);
        const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+(tracker[x.id].nuits||0)+((annS[x.id]||{}).nuits||0));
        const ecN=myN-avgN;
        sc+=ecN*15; if(ecN<-1.5)sc-=22; if(ecN>1.5)sc+=18;
      }

      // Fatigue (legere penalite)
      sc+=t.fatigue*0.5;
    }

    // -- P5 : Preferences --
    if(!reunion&&(e.prefs||[]).includes(plage.id)) sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')  sc+=13;
        if(dem.type==='prefere') sc-=13;
      }
    });

    // Eviter double terrain (sauf pause acceptee)
    if(!reunion&&!e.acceptePause){
      const dejaTerrain=Object.keys(planning[ds]||{}).some(pid=>{
        if(pid.startsWith('_')) return false;
        const p2=plageById(+pid); if(!p2||isReunion(p2)) return false;
        return ((planning[ds][pid]||[]).map(x=>+x)).includes(e.id);
      });
      if(dejaTerrain) sc+=30;
    }

    return sc;
  }

  function updateTracker(e,d,ds,plage,nuit,we){
    const t=tracker[e.id],tp=typePlage(plage),re=isReunion(plage);
    const h=dureeH(plage);
    t.h+=h;
    if(!t.joursH[ds])t.joursH[ds]=0; t.joursH[ds]+=h;
    if(!re){
      const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
      t.cons=diffJ===1?t.cons+1:1; t.lastDay=ds;
      if(nuit){t.nuits++;t.nuitsC++;}else t.nuitsC=0;
      if(we&&!t.weJours.has(ds)){t.weJours.add(ds);if(d.getDay()===6)t.weCount++;}
      const pw=POIDS[tp]||1.0;
      t.fatigue+=pw*(h>10?2:h>8?1.5:h>6?0.8:0.3)+(t.cons>4?1.2:0);
      t.fatigue=Math.min(18,t.fatigue*0.94);
      lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    t.types[tp]=(t.types[tp]||0)+1;
  }

  // ================================================================
  // ETAPE 2 : GENERATION JOUR PAR JOUR
  // ================================================================
  L('Etape 2 : Generation...',25);

  // ================================================================
  // PRE-ATTRIBUTION WE ATOMIQUE (sam+dim ensemble)
  // Principe : pour chaque WE du mois, attribuer toutes les plages
  // en garantissant que le MEME educ couvre sam ET dim.
  // Un educ qui travaille le WE N est au repos le WE N+1.
  // ================================================================

  // Grouper les jours par numero de WE
  const weMap={};let weNum=0,lastSatSeen=-1;
  jours.forEach(d=>{
    if(d.getDay()===6){weNum++;lastSatSeen=d.getDate();}
    if(d.getDay()===0&&lastSatSeen<0)weNum++;
    if(isWEDay(d)) weMap[dayStr(d)]=weNum;
  });
  const weNums=[...new Set(Object.values(weMap))].sort((a,b)=>a-b);

  // Lire le dernier WE du mois precedent pour la rotation
  const prevKey2=moisKey(yr,mo-1);
  const planPrevWE=horaire[prevKey2]||{};
  const dernierWEPrevIds=new Set();
  const joursPrevMois=getDays(yr,mo-1);
  const derniersDim=joursPrevMois.filter(d=>d.getDay()===0).sort((a,b)=>b-a);
  if(derniersDim.length){
    const dsLastDim=dayStr(derniersDim[0]);
    const dsLastSam=dayStr(new Date(derniersDim[0].getTime()-86400000));
    [dsLastSam,dsLastDim].forEach(ds=>{
      Object.entries(planPrevWE[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids))return;
        ids.forEach(id=>dernierWEPrevIds.add(+id));
      });
    });
  }

  // preWE[ds][plageId] = [educId,...] -- attributions WE atomiques
  const preWE={};
  // weParEduc : qui a travaille quels WE ce mois (pour la rotation)
  const weParEduc={};
  educs.forEach(e=>{weParEduc[e.id]=new Set();});

  // Plages actives le WE (sam=5 ou dim=6 dans notre convention dowIdx)
  const plagesWE=plages.filter(p=>
    !isReunion(p)&&(p.jours.includes(5)||p.jours.includes(6))
  );

  for(const wn of weNums){
    const joursWE=jours.filter(d=>weMap[dayStr(d)]===wn).sort((a,b)=>a-b);
    if(!joursWE.length)continue;
    const samJ=joursWE.find(d=>d.getDay()===6);
    const dimJ=joursWE.find(d=>d.getDay()===0);

    // Qui est en repos ce WE (a travaille le WE precedent) ?
    const enRepos=new Set();
    if(wn===weNums[0]){
      dernierWEPrevIds.forEach(id=>enRepos.add(id));
    } else {
      const wnPrec=weNums[weNums.indexOf(wn)-1];
      educs.forEach(e=>{if((weParEduc[e.id]||new Set()).has(wnPrec))enRepos.add(e.id);});
    }

    for(const plage of plagesWE){
      // Jours de cette plage dans ce WE
      const slotsP=joursWE.filter(d=>plage.jours.includes(dowIdx(d)));
      if(!slotsP.length)continue;
      const reqMin=+plage.min||1;

      // Candidats : dispo sur TOUS les jours de la plage dans ce WE
      // + pas en repos rotation (sauf fallback)
      const cands=educs.filter(e=>{
        if((e.excls||[]).includes(plage.id))return false;
        for(const d of slotsP){
          if(!(e.jours||[]).includes(dowIdx(d)))return false;
          if(isAbsent(e.id,dayStr(d)))return false;
        }
        return true;
      });

      // Candidats respectant la rotation
      let candsRot=cands.filter(e=>!enRepos.has(e.id));
      // Fallback si pas assez
      if(candsRot.length<reqMin)candsRot=cands;

      // Scorer : equite WE (annuel+historique) + solde heures
      const annS2=loadAnnualStats()[String(yr)]||{};
      const scored=candsRot.map(e=>{
        const ht=hist[e.id];
        const ann2=annS2[e.id]||{};
        const myWE=norm((ht.we||0)+(ann2.we||0),e);
        const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+((annS2[x.id]||{}).we||0));
        let sc=(myWE-avgWE)*15;
        if(myWE<avgWE-1)sc-=20;
        if(myWE>avgWE+1)sc+=20;
        const solde=ht.solde+(tracker[e.id].h-(quotas[e.id]?.h.cible||0));
        if(solde<-10)sc-=30;else if(solde<-5)sc-=15;
        else if(solde>10)sc+=30;else if(solde>5)sc+=15;
        if(isNuitP(plage)){
          const myN=norm((ht.nuits||0)+(ann2.nuits||0),e);
          const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+((annS2[x.id]||{}).nuits||0));
          sc+=(myN-avgN)*12;
        }
        return{e,sc};
      }).sort((a,b)=>a.sc-b.sc);

      const assigned=scored.slice(0,reqMin).map(x=>x.e);

      // Enregistrer dans preWE pour chaque jour du slot
      slotsP.forEach(d=>{
        const ds=dayStr(d);
        if(!preWE[ds])preWE[ds]={};
        preWE[ds][plage.id]=assigned.map(e=>e.id);
      });

      // Marquer comme ayant travaille ce WE
      assigned.forEach(e=>{
        if(!weParEduc[e.id])weParEduc[e.id]=new Set();
        weParEduc[e.id].add(wn);
      });
    }
  }

  for(let di=0;di<jours.length;di++){
    if(di%3===0){L(`Jour ${di+1}/${jours.length}`,25+Math.round((di/jours.length)*55));await sl(0);}
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    // Recopier les verrouillages
    if(lockedSlots[ds]){
      Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
        planning[ds][pid]=ids; planning[ds]['_lock_'+pid]='locked';
        ids.forEach(eid=>{
          const e=educById(+eid); if(!e) return;
          const p=plageById(+pid); if(!p) return;
          updateTracker(e,d,ds,p,isNuitP(p)&&!isReunion(p),we);
        });
      });
    }

    // Injecter les attributions WE atomiques pre-calculees
    // Ces attributions sont verrouillees : la passe A ne les ecrase pas
    if(we && preWE[ds]){
      Object.entries(preWE[ds]).forEach(([pid,ids])=>{
        if(lockedSlots[ds]&&lockedSlots[ds][pid])return; // deja verrouille manuellement
        planning[ds][+pid]=ids;
        planning[ds]['_bloc_we_'+pid]='we_bloc'; // marqueur bloc WE
        const p=plageById(+pid);if(!p)return;
        ids.forEach(eid=>{
          const e=educById(+eid);if(!e)return;
          planning[ds][`_s_${eid}_${pid}`]='neutral';
          updateTracker(e,d,ds,p,isNuitP(p)&&!isReunion(p),true);
        });
        if(ids.length<(+p.min||1))
          warnings.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} (WE incomplet)`);
      });
    }

    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));

    // Ordre : nuits->WE/feries->longues->reste->reunions
    function prio(p){
      if(isReunion(p)) return 10;
      if(isNuitP(p))   return 0;
      if(we||ferie)    return 1;
      if(dureeH(p)>8)  return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=prio(a),pb=prio(b); if(pa!==pb) return pa-pb;
      const ca=educs.filter(e=>checkLoi(e,d,ds,dow,a).ok).length;
      const cb=educs.filter(e=>checkLoi(e,d,ds,dow,b).ok).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    const preAllocJour=preAlloc[ds]||{};

    // -- PASSE A : Minimum obligatoire --
    for(const plage of pj){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;
      // Sauter les plages WE deja attribuees en pre-attribution atomique
      if(we && preWE[ds] && preWE[ds][plage.id]!==undefined) continue;
      const nuit=isNuitP(plage)&&!isReunion(plage);
      const reqMin=Math.max(0,+plage.min||1), useAll=plage.tous;
      const pIds=preAllocJour[plage.id]||[];
      const reunion=isReunion(plage);
      const diagD=[];

      // Tester tous les educs (diagnostic)
      let cands=[];
      educs.forEach(e=>{
        const loi=checkLoi(e,d,ds,dow,plage);
        if(!loi.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:loi.raison});return;}
        const conv=checkConvention(e,d,ds,plage,0);
        if(!conv.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:conv.raison+(conv.bloquant?'':' ⚠')});return;}
        cands.push(e);
      });

      // Niveaux de relachement
      if(cands.length<reqMin&&!useAll)
        cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,1).ok);
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok);
        cands.forEach(e=>{if(quotas[e.id])quotas[e.id].exceptionsUsees++;});
      }

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie,pIds,dow)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);

      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:true,raison:'Assigne'}));

      if(assigned.length<reqMin||(nuit||we||ferie))
        diagnostic.push({ds,plage:plage.nom,couverte:assigned.length>=reqMin,details:diagD});

      assigned.forEach(e=>{
        const isExcl=!reunion&&(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom}: refusee assignee a ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectee`);}
        else if(dem&&dem.type==='prefere') planning[ds][sk]='dem_pref';
        else if(isPref) planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        updateTracker(e,d,ds,plage,nuit,we);
      });

      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couvert(s)`);
    }

    // -- PASSE B : Maximum --
    for(const plage of pj){
      if(plage.tous||isReunion(plage)) continue;
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;
      if(we && preWE[ds] && preWE[ds][plage.id]!==undefined) continue;
      const reqMin=Math.max(0,+plage.min||1),reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin) continue;
      const deja=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-deja.length; if(encore<=0) continue;
      const cands=educs.filter(e=>{
        if(deja.includes(e.id)) return false;
        if(!checkLoi(e,d,ds,dow,plage).ok) return false;
        if(!checkConvention(e,d,ds,plage,1).ok) return false;
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        return solde<10;
      }).map(e=>({e,sc:score(e,d,ds,plage,we||ferie,[],dow)}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);
      if(!cands.length) continue;
      planning[ds][plage.id]=[...deja,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        planning[ds][`_s_${e.id}_${plage.id}`]=(e.excls||[]).includes(plage.id)?'forced':(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        updateTracker(e,d,ds,plage,isNuitP(plage),we);
      });
    }
  }

  // ================================================================
  // ETAPE 3 : MICRO-AJUSTEMENTS (swaps cibles nuits/WE seulement)
  // Ne pas toucher les matins/soirs stables !
  // ================================================================
  L('Etape 3 : Micro-ajustements...',83); await sl(30);

  // Swaps uniquement pour nuits et WE -- pas pour les prestations normales
  const passesSwap=[
    {nom:'nuits',keyFn:e=>norm((hist[e.id].nuits||0)+(tracker[e.id].nuits||0),e),filtre:p=>isNuitP(p)&&!isReunion(p),maxSwaps:50},
    {nom:'WE',   keyFn:e=>norm((hist[e.id].we||0)+(tracker[e.id].weCount||0),e),filtre:p=>!isReunion(p),maxSwaps:25},
  ];

  for(const pass of passesSwap){
    let sw=0;
    for(let iter=0;iter<pass.maxSwaps;iter++){
      let improved=false;
      for(const ds of Object.keys(planning)){
        if(lockedSlots[ds]) continue;
        const d=new Date(ds+'T12:00'),dow=dowIdx(d),we=isWEDay(d);
        // Pour les swaps WE : seulement les jours WE
        if(pass.nom==='WE'&&!we) continue;
        for(const plage of plages){
          if(!pass.filtre(plage)) continue;
          const ids=(planning[ds][plage.id]||[]).map(x=>+x); if(!ids.length) continue;
          const reqMin=+plage.min||1;
          for(const idIn of ids){
            const eIn=educById(idIn); if(!eIn) continue;
            const sIn=pass.keyFn(eIn);
            for(const eOut of educs.filter(e=>!ids.includes(e.id))){
              if(pass.keyFn(eOut)>=sIn-1.5) continue;
              if(!swapValide(planning,ds,plage,idIn,eOut.id,reqMin,dow)) continue;
              // Verifier que ca n'empire pas le solde heures
              const soldIn=hist[eIn.id].solde+(tracker[eIn.id].h-quotas[eIn.id].h.cible);
              const soldOut=hist[eOut.id].solde+(tracker[eOut.id].h-quotas[eOut.id].h.cible);
              if(soldOut-dureeH(plage)<-14) continue; // ne pas mettre eOut sous -15h
              if(soldIn+dureeH(plage)>14)  continue;  // ne pas mettre eIn au-dessus de +15h
              // Appliquer
              const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
              planning[ds][plage.id]=newIds;
              delete planning[ds][`_s_${idIn}_${plage.id}`];
              planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
              const h=dureeH(plage);
              tracker[eIn.id].h=Math.max(0,tracker[eIn.id].h-h); tracker[eOut.id].h+=h;
              tracker[eIn.id].plageCount[plage.id]=Math.max(0,(tracker[eIn.id].plageCount[plage.id]||0)-1);
              tracker[eOut.id].plageCount[plage.id]=(tracker[eOut.id].plageCount[plage.id]||0)+1;
              if(isNuitP(plage)){
                tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);
                tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;
              }
              if(we){
                tracker[eIn.id].weCount=Math.max(0,(tracker[eIn.id].weCount||0)-1);
                tracker[eOut.id].weCount=(tracker[eOut.id].weCount||0)+1;
              }
              improved=true;sw++;break;
            }
            if(improved)break;
          }
          if(improved)break;
        }
        if(improved)break;
      }
      if(!improved)break;
    }
    if(sw>0) dbg(`Swap ${pass.nom}: ${sw}`);
    await sl(0);
  }

  return {planning,warnings,diagnostic,tracker,quotas};
}

function swapValide(planning,ds,plage,idIn,idOut,reqMin,dow){
  const eOut=educById(idOut); if(!eOut) return false;
  if(!(eOut.jours||[]).includes(dow)||isAbsent(eOut.id,ds)) return false;
  const newIds=(planning[ds][plage.id]||[]).map(x=>+x).filter(x=>x!==idIn).concat(idOut);
  if(newIds.length<reqMin) return false;
  if((planning[ds][plage.id]||[]).map(x=>+x).includes(idOut)) return false;
  if(!isReunion(plage)&&!eOut.acceptePause){
    const autreTerrain=Object.keys(planning[ds]||{}).some(pid=>{
      if(pid.startsWith('_')) return false;
      const p=plageById(+pid); if(!p||isReunion(p)) return false;
      return (planning[ds][pid]||[]).map(x=>+x).includes(idOut);
    });
    if(autreTerrain) return false;
  }
  return true;
}

// ================================================================
// VALIDATION (toujours sauvegarder -- planning partiel accepte)
// ================================================================
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

  const nTot={},wTot={},hTot={};
  educs.forEach(e=>{nTot[e.id]=0;wTot[e.id]=0;hTot[e.id]=tracker?tracker[e.id]?.h||0:0;});
  jours.forEach(d=>{
    const ds=dayStr(d),we=isWEDay(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)&&!isReunion(p)) nTot[+id]=(nTot[+id]||0)+1;
        if(we) wTot[+id]=(wTot[+id]||0)+1;
      });
    });
  });

  const avgNN=moyPond(educs,e=>nTot[e.id]||0); let ecNMax=0;
  educs.forEach(e=>{
    const myN=norm(nTot[e.id]||0,e), ec=Math.abs(myN-avgNN);
    if(ec>ecNMax) ecNMax=ec;
    if(ec>4) warns.push(`Nuits : ${e.prenom} ecart ${ec.toFixed(1)}`);
  });
  let ecHMax=0;
  educs.forEach(e=>{
    const s=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(s)>ecHMax) ecHMax=Math.abs(s);
    if(Math.abs(s)>15) warns.push(`Solde ${e.prenom}: ${s>=0?'+':''}${s.toFixed(1)}h`);
  });

  const metrics={
    equite:Math.max(0,100-ecNMax*12),
    stabilite:85,
    couverture:errors.length===0?100:Math.max(0,100-errors.length*15),
    prefs:Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)
  };
  return {valid:true,errors,warnings:warns,metrics};
}

function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.30+m.stabilite*0.30+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'A ameliorer';
  return {score,label,details:m};
}
