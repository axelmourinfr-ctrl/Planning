// ============================================================
// algo.js - PlanEduc Pro - Moteur v11
// ============================================================
// HIERARCHIE STRICTE :
//  P1 - LOI          : repos 11h (hors reunion), max 6j consec,
//                      max 2 nuits consec, max 50h/sem (tout inclus)
//  P2 - COUVERTURE   : minimum de chaque plage OBLIGATOIRE
//  P3 - EQUITE       : heures ±15h/mois, 0 trimestriel,
//                      prestations prorata contrat, WE/nuits/feries annuel
//  P4 - STABILITE    : patterns semaine, fatigue humaine
//  P5 - PREFERENCES  : demandes educs (jamais > P1-P4)
//  P6 - MAXIMUM      : remplir jusqu'au max si solde negatif
//
// SPECIFICITE REUNIONS (type:"reunion") :
//  - cumulables avec toutes les autres plages
//  - ne bloquent PAS repos 11h
//  - ne comptent PAS dans max heures journalieres terrain
//  - ne comptent PAS dans fatigue, penibilite, quotas terrain
//  - comptent UNIQUEMENT dans calcul 50h/semaine (lun->dim)
// ============================================================

const DEBUG_MODE = false;

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
  btn.disabled=true;
  btn.innerHTML='<div class="spin"></div> Generation...';
  document.getElementById('gen-prog').style.display='block';
  document.getElementById('gen-alerts').innerHTML='';
  const log=document.getElementById('gen-log');
  log.innerHTML='';
  const L=(m,p)=>{
    log.innerHTML+=m+'<br>';
    log.scrollTop=log.scrollHeight;
    if(p!=null) document.getElementById('gen-bar').style.width=p+'%';
  };

  L('Detection des impossibilites...',3); await sl(50);
  const impos=detecterImpossibilites(mois);
  impos.forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);

  L('Validation finale...',93); await sl(30);
  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);

  if(!validation.valid){
    L('ERREURS BLOQUANTES :',null);
    validation.errors.forEach(e=>L('  ✗ '+e,null));
    L('Generation annulee.',null);
    btn.disabled=false;
    btn.innerHTML="Generer l'horaire";
    showAlert('gen-alerts','err',`Generation echouee : ${validation.errors.length} erreur(s).`);
    return;
  }

  horaire[mois]=result.planning;
  currentMonth=mois;
  save();
  updateAnnualStats(mois);

  const qs=planningQualityScore(validation);
  L(`Score qualite : ${qs.score}/100 — ${qs.label}`,null);
  L(`  Equite:${qs.details.equite} Couverture:${qs.details.couverture} Stabilite:${qs.details.stabilite} Prefs:${qs.details.prefs}`,null);

  validation.warnings.slice(0,10).forEach(w=>L('! '+w,null));
  result.warnings.slice(0,5).forEach(w=>L('! '+w,null));

  L('Termine !',100);
  btn.disabled=false;
  btn.innerHTML="Generer l'horaire";
  showAlert('gen-alerts','ok',`Horaire genere — Score : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// UTILITAIRES
// ================================================================
const isNuitP  = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion= p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('réunion');
const isWEDay  = d => d.getDay()===0||d.getDay()===6;
const dowIdx   = d => d.getDay()===0?6:d.getDay()-1;
const ratioE   = e => getTargetH(e)/38;
const dbg      = (...a)=>{if(DEBUG_MODE) console.log('[PlanEduc v11]',...a);};

// Poids de fatigue par type (reunions = quasi zero)
const POIDS_FATIGUE = { reunion:0.1, matin:1.0, aprem:1.0, soir:1.2, nuit:2.0 };

function dureeHPlage(p){
  if(p.dureeH&&p.dureeH>0) return p.dureeH;
  const [dh,dm]=p.debut.split(':').map(Number);
  const [fh,fm]=p.fin.split(':').map(Number);
  let h=(fh*60+fm)-(dh*60+dm);
  if(h<=0) h+=1440;
  return h/60;
}

function typePlage(p){
  if(isReunion(p)) return 'reunion';
  if(isNuitP(p))   return 'nuit';
  const h=parseInt(p.debut);
  if(h<10) return 'matin';
  if(h<14) return 'aprem';
  return 'soir';
}

function joursOuvMois(yr,mo){
  return getDays(yr,mo).filter(d=>{
    const dw=d.getDay(); return dw>=1&&dw<=5&&!isFerie(dayStr(d));
  }).length;
}

function moyPonderee(arr,fn){
  return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length);
}
function normalisee(val,e){ return val/Math.max(0.01,ratioE(e)); }

// Caches
let _plageMap=null,_educMap=null;
function plageById(id){
  if(!_plageMap||_plageMap.size!==plages.length) _plageMap=new Map(plages.map(p=>[p.id,p]));
  return _plageMap.get(+id);
}
function educById(id){
  if(!_educMap||_educMap.size!==educs.length) _educMap=new Map(educs.map(e=>[e.id,e]));
  return _educMap.get(+id);
}

// ================================================================
// CALCUL 50H/SEMAINE (lundi → dimanche, tout inclus)
// ================================================================
function hSemaineCourante(tracker_e, ds){
  // Semaine = lundi de la semaine courante
  const d=new Date(ds+'T12:00');
  const lundi=new Date(d);
  lundi.setDate(d.getDate()-((d.getDay()+6)%7));
  const dimanche=new Date(lundi); dimanche.setDate(lundi.getDate()+6);
  let h=0;
  const jourhist=tracker_e.joursH||{};
  for(let dd=new Date(lundi);dd<=dimanche;dd.setDate(dd.getDate()+1)){
    const k=`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
    h+=jourhist[k]||0;
  }
  return h;
}

// ================================================================
// STATS ANNUELLES
// ================================================================
function loadAnnualStats(){
  try{ return JSON.parse(localStorage.getItem('planeduc_v3_annual')||'{}'); }
  catch(e){ return {}; }
}

function updateAnnualStats(moisStr){
  try{
    const yr=moisStr.split('-')[0];
    const stats=loadAnnualStats();
    if(!stats[yr]) stats[yr]={};
    const totaux={};
    educs.forEach(e=>{ totaux[e.id]={heures:0,nuits:0,weekends:0,feries:0,matin:0,aprem:0,soir:0,reunion:0}; });

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
    educs.forEach(e=>{ stats[yr][e.id]=totaux[e.id]; });
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){ console.warn('updateAnnualStats:',err); }
}

// ================================================================
// DETECTION D'IMPOSSIBILITES
// ================================================================
function detecterImpossibilites(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const msgs=[];
  plages.forEach(p=>{
    jours.forEach(d=>{
      const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
      const dc=(fe&&!we)?5:dow;
      if(!p.jours.includes(dc)) return;
      const dispo=educs.filter(e=>(e.jours||[]).includes(dow)&&!isAbsent(e.id,ds)).length;
      const reqMin=+p.min||1;
      if(dispo<reqMin)
        msgs.push(`${ds} - ${p.nom}: ${dispo}/${reqMin} educ(s) disponible(s) — couverture impossible`);
    });
  });
  return msgs;
}

// ================================================================
// CALCUL DES QUOTAS DURS (avec stats annuelles)
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
    const ajustSolde=Math.max(-10,Math.min(10,-(hist[e.id].solde||0)*0.5));
    const ajustAnn=ann.nuits>30*re?-2:ann.nuits<10*re?2:0;

    quotas[e.id]={
      h:{ cible:base+ajustSolde+ajustAnn, min:base-15, max:base+15 },
      plage:{}, types:{},
      ann:{ nuits:ann.nuits||0, weekends:ann.weekends||0, feries:ann.feries||0 },
      exceptionsUsees:0, exceptionsMax:3
    };

    plages.forEach(p=>{
      if(isReunion(p)){ // reunions : pas de quota dur terrain
        quotas[e.id].plage[p.id]={ cible:999, min:0, max:999 };
        return;
      }
      const joursActifs=jours.filter(d=>{
        const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
        return p.jours.includes(dc);
      }).length;
      const totalPostes=joursActifs*(+p.min||1);
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      const myHistN=(hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgHistN=moyPonderee(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corrHist=(myHistN-avgHistN)*re*0.3;
      const annNuits=ann.nuits||0;
      const avgAnnN=moyPonderee(educs,x=>(annStats[x.id]||{}).nuits||0);
      const corrAnn=isNuitP(p)?(normalisee(annNuits,e)-avgAnnN)*re*0.2:0;
      const cibleCorr=Math.max(0,cible-corrHist-corrAnn);
      quotas[e.id].plage[p.id]={ cible:cibleCorr, min:Math.max(0,Math.floor(cibleCorr-2)), max:Math.ceil(cibleCorr+2) };
    });

    ['matin','aprem','soir','nuit'].forEach(tp=>{
      const plagesDuType=plages.filter(p2=>!isReunion(p2)&&(tp==='nuit'?isNuitP(p2):typePlage(p2)===tp));
      let totalType=0;
      plagesDuType.forEach(p2=>{
        const ja=jours.filter(d=>{
          const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
          return p2.jours.includes(dc);
        }).length;
        totalType+=ja*(+p2.min||1);
      });
      const cibleT=totalType*re/Math.max(0.01,poidsTotal);
      quotas[e.id].types[tp]={ cible:cibleT, min:Math.max(0,Math.floor(cibleT-1.5)), max:Math.ceil(cibleT+1.5) };
    });
  });
  return quotas;
}

// ================================================================
// PRE-ALLOCATION INTELLIGENTE (nuits sur tout le mois)
// ================================================================
function preAllouerIntelligent(jours,quotas,hist,moisStr){
  const preAlloc={};
  const annStats=loadAnnualStats()[moisStr.split('-')[0]]||{};
  const cpt={};
  educs.forEach(e=>{ cpt[e.id]={nuits:0,lastNuit:null,nuitsC:0}; });

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
        if(cpt[e.id].lastNuit){
          const diffJ=Math.round((d-new Date(cpt[e.id].lastNuit))/86400000);
          if(diffJ<=1) return false;
        }
        return true;
      }).sort((a,b)=>{
        const annNA=(annStats[a.id]||{}).nuits||0;
        const annNB=(annStats[b.id]||{}).nuits||0;
        const sA=normalisee((hist[a.id].nuits||0)+annNA+cpt[a.id].nuits,a);
        const sB=normalisee((hist[b.id].nuits||0)+annNB+cpt[b.id].nuits,b);
        return sA-sB;
      }).slice(0,reqMin);
      preAlloc[ds][p.id]=cands.map(e=>e.id);
      cands.forEach(e=>{ cpt[e.id].nuits++; cpt[e.id].nuitsC++; cpt[e.id].lastNuit=ds; });
    });
    educs.forEach(e=>{ if(cpt[e.id].lastNuit!==ds) cpt[e.id].nuitsC=0; });
  });
  return preAlloc;
}

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr,L){
  _plageMap=null; _educMap=null;
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const planning={},warnings=[];
  const horizon=+document.getElementById('gen-horizon').value||3;
  const minRepos=getRule('min_repos',11);
  const maxCons=getRule('max_consec',6);
  const maxWeMois=getRule('max_we_mois',2);
  const reposNuit=getRule('repos_apres_nuit',1);
  const maxNuitsC=2;

  L('Chargement historique...',7); await sl(30);

  // ── HISTORIQUE ──
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={ solde:0, plageCount:{}, we:0, ferie:0, nuits:0,
                 types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0} };
    plages.forEach(p=>hist[e.id].plageCount[p.id]=0);
  });

  for(let i=1;i<horizon;i++){
    const key=moisKey(yr,mo-i);
    const plan=horaire[key]; if(!plan) continue;
    const [ky,km]=key.split('-').map(Number);
    const joursMois=getDays(ky,km);
    const joursOuvH=joursOuvMois(ky,km);
    const hTrav={};
    educs.forEach(e=>hTrav[e.id]=0);

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
          if(weD) hist[id].we++;
          if(feD) hist[id].ferie++;
          if(isNuitP(p)&&!isReunion(p)) hist[id].nuits++;
          hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{ hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e); });
  }

  L('Calcul des quotas durs...',14); await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr);

  L('Pre-allocation intelligente des nuits...',21); await sl(30);
  const preAlloc=preAllouerIntelligent(jours,quotas,hist,moisStr);

  // ── TRACKER ENRICHI ──
  const tracker={};
  const lastPrest={}; // derniere prestation TERRAIN (hors reunion)
  const lastPrestAll={}; // derniere prestation toutes confondues (pour 50h)
  educs.forEach(e=>{
    tracker[e.id]={
      h:0, nuits:0, nuitsC:0,
      weCount:0, weJours:new Set(),
      cons:0, lastDay:null,
      plageCount:{},
      types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},
      fatigue:0, fatigueHistory:[],
      penibilite:{}, exceptionsQuota:0,
      patterns:{}, dernierWE:null,
      joursH:{} // hSemaine : { "2026-05-12": h }
    };
    plages.forEach(p=>tracker[e.id].plageCount[p.id]=0);
    lastPrest[e.id]=null;
    lastPrestAll[e.id]=null;
  });

  // Continuite mois precedent
  const prevPlan=horaire[moisKey(yr,mo-1)]||{};
  Object.keys(prevPlan).sort().forEach(ds=>{
    Object.entries(prevPlan[ds]||{}).forEach(([pid,ids])=>{
      if(pid.startsWith('_')||!Array.isArray(ids)) return;
      const p=plageById(+pid); if(!p) return;
      ids.forEach(eid=>{
        const id=+eid;
        const obj={date:ds,fin:p.fin,isNuit:isNuitP(p)&&!isReunion(p),pm:p.fin<p.debut};
        if(!lastPrestAll[id]||ds>lastPrestAll[id].date) lastPrestAll[id]={...obj};
        if(!isReunion(p)&&(!lastPrest[id]||ds>lastPrest[id].date)) lastPrest[id]={...obj};
      });
    });
  });

  // ── P1 : LOI ──
  // IMPORTANT : les reunions ne bloquent PAS repos, continuité, nuits consec
  function respecteLoi(e,d,ds,dow,plage){
    if(!(e.jours||[]).includes(dow)) return false;
    if(isAbsent(e.id,ds)) return false;
    const t=tracker[e.id];
    const reunion=isReunion(plage);

    if(!reunion){
      // Max jours consecutifs (seulement pour terrain)
      if(t.cons>=maxCons) return false;
      // Max nuits consecutives
      if(isNuitP(plage)&&t.nuitsC>=maxNuitsC) return false;
      // Repos minimum 11h (seulement entre prestations TERRAIN)
      const la=lastPrest[e.id];
      if(la){
        const [lh,lm]=la.fin.split(':').map(Number);
        const [bh,bm]=plage.debut.split(':').map(Number);
        const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
        const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
        if((debMs-finMs)/3600000<minRepos&&(debMs-finMs)>=0) return false;
      }
      // Repos apres nuit
      if(la&&la.isNuit&&reposNuit>0){
        if(Math.round((d-new Date(la.date))/86400000)<=reposNuit) return false;
      }
      // Max heures journalieres terrain (hors reunions)
      const maxHJ=isNuitP(plage)?14:11;
      const hJourTerrain=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
        const ids=(planning[ds]||{})[pp.id];
        return (Array.isArray(ids)&&ids.map(x=>+x).includes(e.id))?s+dureeHPlage(pp):s;
      },0);
      if(hJourTerrain+dureeHPlage(plage)>maxHJ) return false;
    }

    // Max 50h/semaine (TOUT inclus, reunions comprises)
    const hSem=hSemaineCourante(t,ds);
    if(hSem+dureeHPlage(plage)>50) return false;

    return true;
  }

  function respecteConvention(e,d,ds,plage,niveau){
    // niveau 0=strict, 1=relache quota, 2=urgence
    const reunion=isReunion(plage);
    if(niveau<2&&!reunion&&(e.excls||[]).includes(plage.id)) return false;
    if(!reunion&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1) return false;
    if(!reunion&&niveau===0){
      const myCount=tracker[e.id].plageCount[plage.id]||0;
      const qMax=quotas[e.id]?.plage[plage.id]?.max;
      if(qMax!==undefined&&myCount>=qMax){
        if(quotas[e.id].exceptionsUsees>=quotas[e.id].exceptionsMax) return false;
      }
      const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
      if(solde>18) return false;
    }
    return true;
  }

  // ── SCORE P3+P4+P5 ──
  function score(e,d,ds,plage,weOrFerie,preAllocIds){
    const t=tracker[e.id],ht=hist[e.id],re=ratioE(e),q=quotas[e.id];
    const annStats=loadAnnualStats()[moisStr.split('-')[0]]||{};
    const ann=annStats[e.id]||{nuits:0,weekends:0,feries:0};
    const reunion=isReunion(plage);
    let sc=0;

    // P3a : Solde heures
    const soldeCumul=ht.solde+(t.h-q.h.cible);
    sc+=soldeCumul*4.0;
    if(soldeCumul<-20) sc-=45;
    else if(soldeCumul<-12) sc-=25;
    else if(soldeCumul<-6)  sc-=12;
    if(soldeCumul>18) sc+=35;
    else if(soldeCumul>10) sc+=18;
    else if(soldeCumul>5)  sc+=7;

    if(!reunion){
      // P3b : Equite plage (normalise)
      const myCP=(ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0);
      const myCPN=normalisee(myCP,e);
      const avgCPN=moyPonderee(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
      const ecartP=myCPN-avgCPN;
      sc+=ecartP*11;
      if(ecartP<-1.5) sc-=18;
      if(ecartP>1.5)  sc+=14;

      // P3b bis : Stats par type
      const tp=typePlage(plage);
      const myTP=(ht.types[tp]||0)+(t.types[tp]||0);
      const myTPN=normalisee(myTP,e);
      const avgTPN=moyPonderee(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
      const ecartT=myTPN-avgTPN;
      sc+=ecartT*9;
      if(ecartT<-1) sc-=12;
      if(ecartT>1)  sc+=10;

      // P3c : Equite WE (annuel+mensuel)
      if(weOrFerie){
        const myWE=(ht.we||0)+(t.weCount||0)+(ann.weekends||0);
        const myWEN=normalisee(myWE,e);
        const avgWEN=moyPonderee(educs,x=>{
          const a2=(annStats[x.id]||{}).weekends||0;
          return (hist[x.id].we||0)+(tracker[x.id].weCount||0)+a2;
        });
        const ecWE=myWEN-avgWEN;
        sc+=ecWE*10;
        if(ecWE<-1) sc-=13;
        if(ecWE>1)  sc+=10;
      }

      // P3d : Equite feries (annuel)
      if(isFerie(ds)){
        const myFer=(ht.ferie||0)+(ann.feries||0);
        const myFerN=normalisee(myFer,e);
        const avgFerN=moyPonderee(educs,x=>{
          const a2=(annStats[x.id]||{}).feries||0;
          return (hist[x.id].ferie||0)+a2;
        });
        sc+=(myFerN-avgFerN)*12;
      }

      // P3e : Equite nuits (annuel+mensuel, poids max)
      if(isNuitP(plage)){
        const myN=(ht.nuits||0)+(t.nuits||0)+(ann.nuits||0);
        const myNN=normalisee(myN,e);
        const avgNN=moyPonderee(educs,x=>{
          const a2=(annStats[x.id]||{}).nuits||0;
          return (hist[x.id].nuits||0)+(tracker[x.id].nuits||0)+a2;
        });
        const ecN=myNN-avgNN;
        sc+=ecN*16;
        if(ecN<-1.5) sc-=22;
        if(ecN>1.5)  sc+=18;
      }

      // P4 : Fatigue terrain
      sc+=t.fatigue*0.8;
      // P4 : Penibilite (repetition meme jour+plage)
      const pen=(t.penibilite[dowIdx(d)]||{})[plage.id]||0;
      if(pen>=3) sc+=pen*3;
      // P4 : Stabilite (pattern etabli)
      if(preAllocIds&&preAllocIds.includes(e.id)) sc-=8;
      const pat=(t.patterns[dowIdx(d)]||{})[plage.id]||0;
      if(pat>=2) sc-=pat*2;
    }

    // P5 : Preferences
    if(!reunion&&(e.prefs||[]).includes(plage.id)) sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')  sc+=15;
        if(dem.type==='prefere') sc-=15;
      }
    });

    // Eviter double terrain meme jour (sauf pause ou reunion)
    if(!reunion&&!e.acceptePause){
      const dejaAuj=Object.values(planning[ds]||{})
        .some(ids=>Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)&&
          plages.some(pp=>pp.id===+Object.keys(planning[ds]||{}).find(k=>
            Array.isArray((planning[ds]||{})[k])&&(planning[ds]||{})[k].map(x=>+x).includes(e.id)
          )&&!isReunion(pp))
        );
      if(dejaAuj) sc+=25;
    }

    return sc;
  }

  function updateTracker(e,d,ds,plage,nuit,we){
    const t=tracker[e.id],tp=typePlage(plage),dow=dowIdx(d);
    const reunion=isReunion(plage);
    const h=dureeHPlage(plage);

    t.h+=h;
    // Semaine glissante
    if(!t.joursH[ds]) t.joursH[ds]=0;
    t.joursH[ds]+=h;

    if(!reunion){
      // Continuite terrain
      const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
      t.cons=diffJ===1?t.cons+1:1;
      t.lastDay=ds;
      // Nuits
      if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC=0;
      // WE
      if(we&&!t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay()===6){t.weCount++;t.dernierWE=ds;} }
      // Fatigue (seulement terrain)
      const poids=POIDS_FATIGUE[tp]||1;
      t.fatigue+=poids*(h>10?2:h>8?1.5:h>6?0.8:0.3);
      t.fatigue+=t.cons>4?1.5:0;
      t.fatigue=Math.min(20,t.fatigue);
      t.fatigueHistory.push({ds,h,tp,fatigue:t.fatigue});
      // Penibilite & patterns
      if(!t.penibilite[dow]) t.penibilite[dow]={};
      t.penibilite[dow][plage.id]=(t.penibilite[dow][plage.id]||0)+1;
      if(!t.patterns[dow]) t.patterns[dow]={};
      t.patterns[dow][plage.id]=(t.patterns[dow][plage.id]||0)+1;
      // Derniere prestation terrain
      lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }

    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    t.types[tp]=(t.types[tp]||0)+1;
    lastPrestAll[e.id]={date:ds,fin:plage.fin,isNuit:false,pm:plage.fin<plage.debut};
    // Decroissance fatigue naturelle (repos)
    if(!reunion) t.fatigue=Math.max(0,t.fatigue*0.92);
  }

  // ================================================================
  // GENERATION JOUR PAR JOUR
  // ================================================================
  L('Generation...',27);

  for(let di=0;di<jours.length;di++){
    if(di%3===0){ L(`Jour ${di+1}/${jours.length}`,27+Math.round((di/jours.length)*55)); await sl(0); }
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));

    // Ordre : nuits → WE/feries → longues → resto → reunions (en dernier, elles s'adaptent)
    function priorite(p){
      if(isReunion(p))       return 10; // reunions en dernier car elles sont flexibles
      if(isNuitP(p))         return 0;
      if(we||ferie)          return 1;
      if(dureeHPlage(p)>8)   return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=priorite(a),pb=priorite(b);
      if(pa!==pb) return pa-pb;
      const ca=educs.filter(e=>respecteLoi(e,d,ds,dow,a)).length;
      const cb=educs.filter(e=>respecteLoi(e,d,ds,dow,b)).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    const preAllocJour=preAlloc[ds]||{};

    // ── PASSE A : Minimum obligatoire ──
    for(const plage of pj){
      const nuit=isNuitP(plage)&&!isReunion(plage);
      const reqMin=Math.max(0,+plage.min||1);
      const useAll=plage.tous;
      const pIds=preAllocJour[plage.id]||[];
      const reunion=isReunion(plage);

      let cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage)&&respecteConvention(e,d,ds,plage,0));
      if(cands.length<reqMin&&!useAll)
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage)&&respecteConvention(e,d,ds,plage,1));
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage));
        cands.forEach(e=>{ if(quotas[e.id]) quotas[e.id].exceptionsUsees++; });
      }

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie,pIds)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);

      planning[ds][plage.id]=assigned.map(e=>e.id);
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
      const reqMin=Math.max(0,+plage.min||1),reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin) continue;
      const dejaDans=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-dejaDans.length; if(encore<=0) continue;

      const cands=educs.filter(e=>{
        if(dejaDans.includes(e.id)) return false;
        if(!respecteLoi(e,d,ds,dow,plage)) return false;
        if(!respecteConvention(e,d,ds,plage,1)) return false;
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        return solde<10;
      }).map(e=>({e,sc:score(e,d,ds,plage,we||ferie,[])}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);

      if(!cands.length) continue;
      planning[ds][plage.id]=[...dejaDans,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        const sk=`_s_${e.id}_${plage.id}`;
        planning[ds][sk]=(e.excls||[]).includes(plage.id)?'forced':(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        updateTracker(e,d,ds,plage,isNuitP(plage),we);
      });
    }
  }

  // ================================================================
  // OPTIMISATION MULTI-PASSES (swaps securises)
  // ================================================================
  L('Optimisation multi-passes...',84); await sl(30);

  const passes=[
    { nom:'nuits',  keyFn:(e)=>normalisee((hist[e.id].nuits||0)+(tracker[e.id].nuits||0),e), filtre:(p)=>isNuitP(p)&&!isReunion(p), maxSwaps:40 },
    { nom:'WE',     keyFn:(e)=>normalisee((hist[e.id].we||0)+(tracker[e.id].weCount||0),e),   filtre:(p)=>!isReunion(p), maxSwaps:20 },
    { nom:'heures', keyFn:(e)=>hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible),       filtre:(p)=>!isReunion(p), maxSwaps:20 },
  ];

  let totalSwaps=0;
  for(const pass of passes){
    let swapsPass=0;
    for(let iter=0;iter<pass.maxSwaps;iter++){
      let improved=false;
      for(const ds of Object.keys(planning)){
        const d=new Date(ds+'T12:00'),dow=dowIdx(d),we=isWEDay(d);
        for(const plage of plages){
          if(!pass.filtre(plage)) continue;
          const ids=(planning[ds][plage.id]||[]).map(x=>+x);
          if(ids.length<1) continue;
          const reqMin=+plage.min||1;

          for(const idIn of ids){
            const eIn=educById(idIn); if(!eIn) continue;
            const scoreIn=pass.keyFn(eIn);
            const cHors=educs.filter(e=>!ids.includes(e.id));

            for(const eOut of cHors){
              const scoreOut=pass.keyFn(eOut);
              if(scoreOut>=scoreIn-1.5) continue;
              if(!simulateSwap(planning,ds,plage,idIn,eOut.id,reqMin,dow,d)) continue;
              // Appliquer swap
              const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
              planning[ds][plage.id]=newIds;
              delete planning[ds][`_s_${idIn}_${plage.id}`];
              planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
              // Delta tracker
              if(isNuitP(plage)&&!isReunion(plage)){
                tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);
                tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;
              }
              tracker[eIn.id].plageCount[plage.id]=Math.max(0,(tracker[eIn.id].plageCount[plage.id]||0)-1);
              tracker[eOut.id].plageCount[plage.id]=(tracker[eOut.id].plageCount[plage.id]||0)+1;
              tracker[eIn.id].h=Math.max(0,tracker[eIn.id].h-dureeHPlage(plage));
              tracker[eOut.id].h+=dureeHPlage(plage);
              if(we){
                tracker[eIn.id].weCount=Math.max(0,(tracker[eIn.id].weCount||0)-1);
                tracker[eOut.id].weCount=(tracker[eOut.id].weCount||0)+1;
              }
              improved=true; swapsPass++;
              dbg(`Swap ${pass.nom}: ${eIn.prenom} ↔ ${eOut.prenom} le ${ds} [${plage.nom}]`);
              break;
            }
            if(improved) break;
          }
          if(improved) break;
        }
        if(improved) break;
      }
      if(!improved) break;
    }
    if(swapsPass>0) totalSwaps+=swapsPass;
    await sl(0);
  }
  if(totalSwaps>0) warnings.push(`Optimisation : ${totalSwaps} echange(s) effectue(s)`);

  return {planning,warnings,tracker,quotas};
}

// ================================================================
// SIMULATION DE SWAP SECURISEE
// ================================================================
function simulateSwap(planning,ds,plage,idIn,idOut,reqMin,dow,d){
  const eOut=educById(idOut); if(!eOut) return false;
  if(!(eOut.jours||[]).includes(dow)) return false;
  if(isAbsent(eOut.id,ds)) return false;
  // Couverture minimale
  const newIds=(planning[ds][plage.id]||[]).map(x=>+x).filter(x=>x!==idIn).concat(idOut);
  if(newIds.length<reqMin) return false;
  // Pas deja present
  if((planning[ds][plage.id]||[]).map(x=>+x).includes(idOut)) return false;
  // Double terrain (sauf pause)
  if(!isReunion(plage)&&!eOut.acceptePause){
    const autresPlagesTerrain=Object.keys(planning[ds]||{}).filter(pid=>{
      if(pid.startsWith('_')) return false;
      const p=plageById(+pid); if(!p||isReunion(p)) return false;
      return (planning[ds][pid]||[]).map(x=>+x).includes(idOut);
    });
    if(autresPlagesTerrain.length>0) return false;
  }
  return true;
}

// ================================================================
// VALIDATION FINALE BLOQUANTE
// ================================================================
function validatePlanning(planning,moisStr,tracker,quotas){
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const errors=[],warns=[];

  // Erreurs bloquantes : couverture minimale
  jours.forEach(d=>{
    const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;
    plages.filter(p=>p.jours.includes(dc)).forEach(p=>{
      const ids=((planning[ds]||{})[p.id]||[]);
      if(ids.length<(+p.min||1))
        errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} educs`);
    });
  });

  // Metriques
  const nuitsTot={},weTot={},hTot={};
  educs.forEach(e=>{ nuitsTot[e.id]=0; weTot[e.id]=0; hTot[e.id]=tracker?tracker[e.id]?.h||0:0; });
  jours.forEach(d=>{
    const ds=dayStr(d),we=isWEDay(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)&&!isReunion(p)) nuitsTot[+id]=(nuitsTot[+id]||0)+1;
        if(we) weTot[+id]=(weTot[+id]||0)+1;
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
    equite:Math.max(0,100-ecartNuitMax*15),
    stabilite:75,
    couverture:errors.length===0?100:Math.max(0,100-errors.length*20),
    prefs:Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)
  };

  return {valid:errors.length===0,errors,warnings:warns,metrics};
}

// ================================================================
// SCORE QUALITE GLOBAL
// ================================================================
function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.35+m.stabilite*0.25+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'A ameliorer';
  return {score,label,details:m};
}
