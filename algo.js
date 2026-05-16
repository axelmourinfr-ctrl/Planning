// ============================================================
// algo.js - PlanEduc Pro - Moteur v22
// ============================================================
// PHILOSOPHIE : Simple, stable, humain, prévisible.
//
// PRINCIPES CLES :
//  1. Récurrence hebdomadaire forte (même semaine chaque semaine)
//  2. Heures corrigées progressivement (±12h au lieu de ±6h)
//  3. WE cohérents sans architecture complexe
//  4. Réunions non bloquantes pour le repos terrain
//  5. Horaires à pause respectés (educ.acceptePause)
//
// HIERARCHIE :
//  P1 - LOIS       : repos 11h terrain, 50h/sem, max consec
//  P2 - HEURES     : solde mensuel fort
//  P3 - COUVERTURE : minimum obligatoire
//  P4 - WE         : cohérence bloc + alternance douce
//  P5 - STABILITE  : récurrence hebdo (fort pour semaine, modéré WE)
//  P6 - EQUITE     : nuits/WE/types progressif et doux
//  P7 - PREFS      : demandes éducs
// ============================================================

const isNuitP   = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion = p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('réunion');
const isWEDay   = d => d.getDay()===0||d.getDay()===6;
const dowIdx    = d => d.getDay()===0?6:d.getDay()-1;
const ratioE    = e => getTargetH(e)/38;

function dureeH(p){
  if(p.dureeH&&p.dureeH>0) return p.dureeH;
  const [dh,dm]=p.debut.split(':').map(Number);
  const [fh,fm]=p.fin.split(':').map(Number);
  let h=(fh*60+fm)-(dh*60+dm); if(h<=0)h+=1440; return h/60;
}
function typePlage(p){
  if(isReunion(p))return 'reunion'; if(isNuitP(p))return 'nuit';
  const h=parseInt(p.debut); if(h<10)return 'matin'; if(h<14)return 'aprem'; return 'soir';
}
function joursOuvMois(yr,mo){
  return getDays(yr,mo).filter(d=>{const dw=d.getDay();return dw>=1&&dw<=5&&!isFerie(dayStr(d));}).length;
}
function moyPond(arr,fn){ return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length); }
function norm(val,e){ return val/Math.max(0.01,ratioE(e)); }

let _pm=null,_em=null;
function plageById(id){if(!_pm||_pm.size!==plages.length)_pm=new Map(plages.map(p=>[p.id,p]));return _pm.get(+id);}
function educById(id){if(!_em||_em.size!==educs.length)_em=new Map(educs.map(e=>[e.id,e]));return _em.get(+id);}

// ================================================================
// PATTERNS — Récurrence hebdomadaire (coeur de la v21)
// Stocke les habitudes par educ × jour × plage
// ================================================================
function loadPatterns(){ try{return JSON.parse(localStorage.getItem('planeduc_v3_patterns')||'{}');}catch(e){return {};} }
function savePatterns(p){ try{localStorage.setItem('planeduc_v3_patterns',JSON.stringify(p));}catch(e){} }

function buildPatterns(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const patterns=loadPatterns();
  // Analyser les 3 derniers mois pour détecter les habitudes
  for(let i=1;i<=3;i++){
    const key=moisKey(yr,mo-i); const plan=horaire[key]; if(!plan) continue;
    const [ky,km]=key.split('-').map(Number);
    getDays(ky,km).forEach(day=>{
      const ds=dayStr(day),dow=dowIdx(day);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        ids.forEach(eid=>{
          const id=String(eid);
          if(!patterns[id])patterns[id]={};
          if(!patterns[id][dow])patterns[id][dow]={};
          patterns[id][dow][pid]=(patterns[id][dow][pid]||0)+1;
        });
      });
    });
  }
  savePatterns(patterns); return patterns;
}

// Bonus récurrence — FORT pour semaine normale
// Un éduc qui fait toujours "mardi matin" est très prioritaire pour mardi matin
// Logique : reproduire l'horaire de la semaine précédente autant que possible
function bonusRecurrence(e,dow,plage,patterns,isWE){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]||!pat[dow][plage.id]) return 0;
  const cnt=pat[dow][plage.id]||0;
  if(cnt===0) return 0;
  // WE : récurrence modérée (rotation importante)
  // Semaine : récurrence forte (habitude humaine = stabilité)
  const mult=isWE?0.6:1.4;
  if(cnt>=8) return -30*mult;  // habitude très ancrée
  if(cnt>=5) return -22*mult;
  if(cnt>=3) return -15*mult;
  if(cnt>=1) return -8*mult;
  return 0;
}

// Bonus "même jour travaillé" : si l'educ travaille habituellement ce jour
// (toutes plages confondues) → bonus pour reproduire le rythme hebdo
function bonusJourHabituel(e,dow,patterns){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]) return 0;
  const total=Object.values(pat[dow]).reduce((s,v)=>s+v,0);
  if(total>=6) return -8;
  if(total>=3) return -4;
  return 0;
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
    educs.forEach(e=>{tot[e.id]={h:0,nuits:0,we:0,feries:0};});
    Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day),weD=isWEDay(day),feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          ids.forEach(eid=>{
            const id=+eid; if(!tot[id]) return;
            tot[id].h+=dureeH(p);
            if(isNuitP(p)&&!isReunion(p))tot[id].nuits++;
            if(weD)tot[id].we++;
            if(feD)tot[id].feries++;
          });
        });
      });
    });
    educs.forEach(e=>{stats[yr][e.id]=tot[e.id];});
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){}
}

// ================================================================
// VERROUILLAGES
// ================================================================
function getLockedSlots(moisStr){
  const plan=horaire[moisStr]||{},locked={};
  Object.entries(plan).forEach(([ds,slots])=>{
    Object.entries(slots).forEach(([pid,val])=>{
      if(pid.startsWith('_')||!Array.isArray(val)) return;
      if(slots['_lock_'+pid]==='locked'){if(!locked[ds])locked[ds]={};locked[ds][pid]=val;}
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
// DETECTION IMPOSSIBILITES
// ================================================================
function detecterImpossibilites(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo),msgs=[];
  plages.forEach(p=>{
    jours.forEach(d=>{
      const ds=dayStr(d),dow=dowIdx(d),we=isWEDay(d),fe=isFerie(ds);
      const dc=(fe&&!we)?5:dow; if(!p.jours.includes(dc)) return;
      const dispo=educs.filter(e=>(e.jours||[]).includes(dow)&&!isAbsent(e.id,ds)).length;
      if(dispo<(+p.min||1)) msgs.push(`${ds} - ${p.nom}: ${dispo}/${p.min} dispo`);
    });
  });
  return msgs;
}

// ================================================================
// QUOTAS (correction plus forte que v13 : ±12h)
// ================================================================
function calculerQuotas(hist,jours,moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const joursOuv=joursOuvMois(yr,mo);
  const poidsTotal=educs.reduce((s,e)=>s+ratioE(e),0);
  const quotas={};
  educs.forEach(e=>{
    const re=ratioE(e);
    const base=joursOuv*7.6*re;
    // Correction ±12h : vrais rattrapages possibles
    const ajust=Math.max(-12,Math.min(12,-(hist[e.id].solde||0)*0.4));
    quotas[e.id]={
      h:{cible:base+ajust, min:base-15, max:base+15},
      plage:{},
      exceptionsUsees:0, exceptionsMax:3
    };
    plages.forEach(p=>{
      if(isReunion(p)){quotas[e.id].plage[p.id]={cible:999,min:0,max:999};return;}
      const ja=jours.filter(d=>{const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;return p.jours.includes(dc);}).length;
      const totalPostes=ja*(+p.min||1);
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      const myN=(hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgN=moyPond(educs,x=>hist[x.id].plageCount[p.id]||0);
      const c=Math.max(0,cible-(myN-avgN)*re*0.15);
      quotas[e.id].plage[p.id]={cible:c,min:Math.max(0,Math.floor(c-2)),max:Math.ceil(c+2)};
    });
  });
  return quotas;
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
  if(!educs.length)warns.push({t:'err',m:'Aucun educateur defini.'});
  if(!plages.length)warns.push({t:'err',m:'Aucune plage horaire definie.'});
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
        <strong>${p.nom}</strong> ${b} - ${p.debut}-${p.fin} - min ${p.min} - ${j}</div>`;
    }).join('');
  }
  ri.innerHTML=html;
}

async function lancer(){
  if(!educs.length||!plages.length){verifier();return;}
  const mois=document.getElementById('gen-mois').value;
  if(!mois){alert('Choisissez un mois.');return;}
  const btn=document.getElementById('gen-btn');
  btn.disabled=true;btn.innerHTML='<div class="spin"></div> Generation...';
  document.getElementById('gen-prog').style.display='block';
  document.getElementById('gen-alerts').innerHTML='';
  const log=document.getElementById('gen-log');log.innerHTML='';
  const L=(m,p)=>{log.innerHTML+=m+'<br>';log.scrollTop=log.scrollHeight;if(p!=null)document.getElementById('gen-bar').style.width=p+'%';};

  L('Detection...',3);await sl(50);
  detecterImpossibilites(mois).forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);
  window._lastDiagnostic=result.diagnostic||[];

  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);
  horaire[mois]=result.planning;
  currentMonth=mois; save();
  updateAnnualStats(mois);
  buildPatterns(mois);

  const qs=planningQualityScore(validation);
  L(`Score : ${qs.score}/100 — ${qs.label}`,null);
  if(validation.errors.length)L(`⚠ ${validation.errors.length} poste(s) non couvert(s)`,null);
  validation.warnings.slice(0,5).forEach(w=>L('! '+w,null));
  result.warnings.slice(0,4).forEach(w=>L('! '+w,null));
  L('Termine !',100);

  btn.disabled=false;btn.innerHTML="Generer l'horaire";
  showAlert('gen-alerts',validation.errors.length?'warn':'ok',`Horaire genere — Score : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr,L){
  _pm=null;_em=null;
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const planning={},warnings=[],diagnostic=[];
  const horizon=+document.getElementById('gen-horizon').value||3;
  const minRepos=getRule('min_repos',11);
  const maxCons=getRule('max_consec',6);
  const maxWeMois=getRule('max_we_mois',2);
  const reposNuit=getRule('repos_apres_nuit',1);
  const maxNuitsC=2;

  L('Historique...',6);await sl(30);
  const lockedSlots=getLockedSlots(moisStr);

  // ── HISTORIQUE ──
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={solde:0,plageCount:{},we:0,ferie:0,nuits:0,types:{matin:0,aprem:0,soir:0,nuit:0}};
    plages.forEach(p=>hist[e.id].plageCount[p.id]=0);
  });
  for(let i=1;i<horizon;i++){
    const key=moisKey(yr,mo-i);const plan=horaire[key];if(!plan)continue;
    const [ky,km]=key.split('-').map(Number);
    const joursMois=getDays(ky,km);const joursOuvH=joursOuvMois(ky,km);
    const hTrav={};educs.forEach(e=>hTrav[e.id]=0);
    joursMois.forEach(day=>{
      const ds=dayStr(day),weD=isWEDay(day),feD=isFerie(ds);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids))return;
        const p=plageById(+pid);if(!p)return;
        const tp=typePlage(p);
        ids.forEach(eid=>{
          const id=+eid;if(!hist[id])return;
          hTrav[id]+=dureeH(p);
          hist[id].plageCount[p.id]=(hist[id].plageCount[p.id]||0)+1;
          if(weD)hist[id].we++;if(feD)hist[id].ferie++;
          if(isNuitP(p)&&!isReunion(p))hist[id].nuits++;
          if(tp!=='reunion')hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e);});
  }

  L('Quotas et patterns...',13);await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr);
  const patterns=buildPatterns(moisStr);
  const annStats=loadAnnualStats()[yr]||{};

  // Carte WE du mois (numéro de weekend par date)
  const weMap={};let weNum=0,lastSat=-1;
  jours.forEach(d=>{
    if(d.getDay()===6){weNum++;lastSat=d.getDate();}
    if(d.getDay()===0&&lastSat<0)weNum++;
    if(isWEDay(d))weMap[dayStr(d)]=weNum;
  });

  // ── TRACKER ──
  const tracker={};
  const lastTerrain={}; // dernière prestation terrain (hors réunion) par educ
  educs.forEach(e=>{
    tracker[e.id]={
      h:0,nuits:0,nuitsC:0,weCount:0,weJours:new Set(),
      cons:0,lastDay:null,plageCount:{},
      types:{matin:0,aprem:0,soir:0,nuit:0},
      fatigue:0,joursH:{},dernierWE:null
    };
    plages.forEach(p=>tracker[e.id].plageCount[p.id]=0);
    lastTerrain[e.id]=null;
  });

  // Continuite depuis le mois precedent
  const prevPlan=horaire[moisKey(yr,mo-1)]||{};
  Object.keys(prevPlan).sort().forEach(ds=>{
    Object.entries(prevPlan[ds]||{}).forEach(([pid,ids])=>{
      if(pid.startsWith('_')||!Array.isArray(ids))return;
      const p=plageById(+pid);if(!p||isReunion(p))return;
      ids.forEach(eid=>{
        const id=+eid;
        if(!lastTerrain[id]||ds>lastTerrain[id].date)
          lastTerrain[id]={date:ds,fin:p.fin,isNuit:isNuitP(p),pm:p.fin<p.debut};
      });
    });
  });

  // ================================================================
  // P1 : VERIFICATION LOI
  // IMPORTANT : réunions non bloquantes pour le repos terrain
  // IMPORTANT : horaire à pause respecté (educ.acceptePause)
  // ================================================================
  function checkLoi(e,d,ds,dow,plage){
    if(!(e.jours||[]).includes(dow))return{ok:false,raison:'Jour non travaillé'};
    if(isAbsent(e.id,ds))return{ok:false,raison:'Absence'};
    const t=tracker[e.id];
    const reunion=isReunion(plage);

    if(!reunion){
      // Jours consécutifs
      if(t.cons>=maxCons)return{ok:false,raison:`Max ${maxCons}j consécutifs`};
      // Nuits consécutives
      if(isNuitP(plage)&&t.nuitsC>=maxNuitsC)return{ok:false,raison:'Max 2 nuits consécutives'};

      // Repos 11h : calculé UNIQUEMENT par rapport à la dernière prestation TERRAIN
      // Les réunions ne bloquent pas le repos terrain
      const la=lastTerrain[e.id];
      if(la){
        const [lh,lm]=la.fin.split(':').map(Number);
        const [bh,bm]=plage.debut.split(':').map(Number);
        const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
        const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
        const dh=(debMs-finMs)/3600000;
        if(dh>=0&&dh<minRepos)return{ok:false,raison:`Repos 11h (${dh.toFixed(1)}h libre)`};
      }
      // Repos après nuit
      if(la&&la.isNuit&&reposNuit>0&&Math.round((d-new Date(la.date))/86400000)<=reposNuit)
        return{ok:false,raison:'Repos après nuit'};

      // Max heures terrain dans la journée
      const maxHJ=isNuitP(plage)?14:11;
      const hJourTerrain=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
        const ids=(planning[ds]||{})[pp.id];
        return Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)?s+dureeH(pp):s;
      },0);
      if(hJourTerrain+dureeH(plage)>maxHJ)return{ok:false,raison:'Max h/jour terrain'};

      // Horaire à pause : si l'educ ne l'accepte pas, pas de 2e prestation terrain
      if(!e.acceptePause){
        const dejaTerrain=plages.filter(p2=>!isReunion(p2)).some(pp=>{
          const ids=(planning[ds]||{})[pp.id];
          return Array.isArray(ids)&&ids.map(x=>+x).includes(e.id);
        });
        if(dejaTerrain)return{ok:false,raison:'Pas de double (sans pause)'};
      }
    }

    // 50h/sem : tout inclus (terrain + réunions)
    if(hSem(t,ds)+dureeH(plage)>50)return{ok:false,raison:'Max 50h/sem'};
    return{ok:true,raison:''};
  }

  function checkConvention(e,d,ds,plage,niveau){
    const reunion=isReunion(plage);
    if(niveau<2&&!reunion&&(e.excls||[]).includes(plage.id))return{ok:false};
    if(!reunion&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1)return{ok:false};
    if(!reunion&&niveau===0){
      const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
      // Zone interdite : bloquer si >12h surplus (quasi-contrainte légale)
      if(solde>12)return{ok:false};
      // Zone tension positive : permettre mais score va pénaliser fortement
    }
    return{ok:true};
  }

  // ================================================================
  // SCORE — simple, lisible, sans contradictions
  // ================================================================
  function score(e,d,ds,plage,weOrFerie,dow,isWECtx){
    const t=tracker[e.id],ht=hist[e.id],re=ratioE(e),q=quotas[e.id];
    const ann=annStats[e.id]||{nuits:0,we:0,feries:0};
    const nuit=isNuitP(plage),reunion=isReunion(plage);
    let sc=0;

    // ── P2 : SOLDE HEURES — courbe continue progressive ──
    // Zone normale (-10/+10) : pression légère
    // Zone tension (-15/-10 et +10/+15) : pression forte
    // Zone interdite (>±15) : quasi-blocage
    const solde=ht.solde+(t.h-q.h.cible);
    if(solde>=0){
      // Trop d'heures : pénalité progressive
      if(solde<5)        sc+=solde*2;            // 0→10 pts
      else if(solde<10)  sc+=10+( solde-5)*5;    // 10→35 pts
      else if(solde<15)  sc+=35+( solde-10)*8;   // 35→75 pts
      else               sc+=75+(solde-15)*5;    // >75 pts (quasi-bloqué)
    } else {
      // Pas assez d'heures : priorité progressive
      if(solde>-5)       sc+=solde*2;            // 0→-10 pts
      else if(solde>-10) sc-=10+(Math.abs(solde)-5)*5;  // -10→-35 pts
      else if(solde>-15) sc-=35+(Math.abs(solde)-10)*8; // -35→-75 pts
      else               sc-=75+(Math.abs(solde)-15)*5; // <-75 pts (priorité absolue)
    }

    if(!reunion){
      // ── P4 : WE cohérence + alternance ──
      if(weOrFerie){
        const wn=weMap[ds];
        if(wn!=null){
          // Bonus fort si travaille déjà l'autre jour de ce WE → bloc cohérent
          const autreJourWE=jours.find(x=>weMap[dayStr(x)]===wn&&dayStr(x)!==ds&&isWEDay(x));
          if(autreJourWE){
            const autreDs=dayStr(autreJourWE);
            const dejaAutreJour=Object.values(planning[autreDs]||{})
              .some(ids=>Array.isArray(ids)&&ids.map(x=>+x).includes(e.id));
            if(dejaAutreJour)sc-=25; // bloc cohérent → très prioritaire
            else sc+=8;              // risque WE coupé → légère pénalité
          }
        }
        // Alternance WE travail/repos
        if(t.dernierWE){
          const diffSem=Math.round((new Date(ds+'T12:00')-new Date(t.dernierWE+'T12:00'))/604800000);
          if(diffSem<=1) sc+=28;  // WE consécutifs → pénalité
          else if(diffSem===2) sc-=8; // bonne alternance → bonus
        }
        // Équité WE
        const myWE=norm((ht.we||0)+(t.weCount||0)+(ann.we||0),e);
        const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+(tracker[x.id].weCount||0)+((annStats[x.id]||{}).we||0));
        sc+=(myWE-avgWE)*10;
      }

      // ── P5 : STABILITE / RECURRENCE HEBDO ──
      // C'est le coeur de la v21 : reproduire le même horaire chaque semaine
      sc+=bonusRecurrence(e,dow,plage,patterns,isWECtx);
      // Bonus si c'est un jour habituellement travaillé par cet educ
      if(!isWECtx) sc+=bonusJourHabituel(e,dow,patterns);

      // ── P6 : EQUITE DOUCE ──
      // Équité plage (normalisée)
      const myCP=norm((ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0),e);
      const avgCP=moyPond(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
      sc+=(myCP-avgCP)*(nuit?12:7);

      // ── Équité types — diversification progressive ──
      // On équilibre les TYPES (matin/soir/nuit), pas les jours
      // Un éduc peut garder ses jours habituels mais doit varier les types
      const tp=typePlage(plage);
      if(tp!=='reunion'){
        const myTP=norm((ht.types[tp]||0)+(t.types[tp]||0),e);
        const avgTP=moyPond(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
        // Poids plus fort sur les types (était 3, maintenant 6 pour semaine)
        sc+=(myTP-avgTP)*(nuit?10:6);
        // Diversification douce et progressive selon le taux de spécialisation
        const total=Object.values(t.types).reduce((s,v)=>s+v,0)+Object.values(ht.types).reduce((s,v)=>s+v,0);
        if(total>8){
          const myT=(ht.types[tp]||0)+(t.types[tp]||0);
          const ratio=myT/Math.max(1,total);
          // Courbe progressive : plus le ratio est élevé, plus la pression est forte
          if(ratio>0.75)      sc+=18; // très spécialisé → pression notable
          else if(ratio>0.65) sc+=10;
          else if(ratio>0.55) sc+=4;
          // Bonus inverse : si l'éduc est sous-représenté sur ce type → favoriser
          if(ratio<0.15&&total>12) sc-=8;
        }
      }

      // Équité nuits
      if(nuit){
        const myN=norm((ht.nuits||0)+(t.nuits||0)+(ann.nuits||0),e);
        const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+(tracker[x.id].nuits||0)+((annStats[x.id]||{}).nuits||0));
        sc+=(myN-avgN)*12;
      }

      // Équité fériés
      if(isFerie(ds)){
        const myF=norm((ht.ferie||0)+(ann.feries||0),e);
        const avgF=moyPond(educs,x=>(hist[x.id].ferie||0)+((annStats[x.id]||{}).feries||0));
        sc+=(myF-avgF)*10;
      }

      sc+=t.fatigue*0.4;
    }

    // ── P7 : PREFERENCES ──
    if(!reunion&&(e.prefs||[]).includes(plage.id))sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')sc+=12;
        if(dem.type==='prefere')sc-=12;
      }
    });

    return sc;
  }

  function updateTracker(e,d,ds,plage,nuit,we){
    const t=tracker[e.id],tp=typePlage(plage),reunion=isReunion(plage);
    const h=dureeH(plage);
    t.h+=h;
    if(!t.joursH[ds])t.joursH[ds]=0;t.joursH[ds]+=h;
    if(!reunion){
      const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
      t.cons=diffJ===1?t.cons+1:1;t.lastDay=ds;
      if(nuit){t.nuits++;t.nuitsC++;}else t.nuitsC=0;
      if(we&&!t.weJours.has(ds)){
        t.weJours.add(ds);
        if(d.getDay()===6){t.weCount++;t.dernierWE=ds;}
      }
      t.fatigue+=(nuit?1.8:1.0)*(h>10?1.5:1.0)+(t.cons>4?1.0:0);
      t.fatigue=Math.min(15,t.fatigue*0.92);
      // Mettre à jour la dernière prestation terrain (pour calcul repos)
      lastTerrain[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    if(tp!=='reunion')t.types[tp]=(t.types[tp]||0)+1;
  }

  // ================================================================
  // GENERATION JOUR PAR JOUR
  // Ordre : nuits → longs → normaux → réunions
  // ================================================================
  L('Generation...',22);

  for(let di=0;di<jours.length;di++){
    if(di%3===0){L(`Jour ${di+1}/${jours.length}`,22+Math.round((di/jours.length)*63));await sl(0);}
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    // Recopier verrouillages
    if(lockedSlots[ds]){
      Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
        planning[ds][pid]=ids;planning[ds]['_lock_'+pid]='locked';
        ids.forEach(eid=>{
          const e=educById(+eid);if(!e)return;
          const p=plageById(+pid);if(!p)return;
          updateTracker(e,d,ds,p,isNuitP(p)&&!isReunion(p),we);
        });
      });
    }

    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));

    // Ordre de traitement : nuits d'abord (plus contraignantes)
    function prio(p){
      if(isReunion(p))return 10;
      if(isNuitP(p))return 0;
      if(we||ferie)return 1;
      if(dureeH(p)>8)return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=prio(a),pb=prio(b);if(pa!==pb)return pa-pb;
      const ca=educs.filter(e=>checkLoi(e,d,ds,dow,a).ok).length;
      const cb=educs.filter(e=>checkLoi(e,d,ds,dow,b).ok).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    // ── PASSE A : minimum obligatoire ──
    for(const plage of pj){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id])continue;
      const nuit=isNuitP(plage)&&!isReunion(plage);
      const reqMin=Math.max(0,+plage.min||1),useAll=plage.tous;
      const diagD=[];

      let cands=[];
      educs.forEach(e=>{
        const loi=checkLoi(e,d,ds,dow,plage);
        if(!loi.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:loi.raison});return;}
        const conv=checkConvention(e,d,ds,plage,0);
        if(!conv.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:'Convention'});return;}
        cands.push(e);
      });

      // Relâchements progressifs
      if(cands.length<reqMin&&!useAll)
        cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,1).ok);
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok);
        cands.forEach(e=>{if(quotas[e.id])quotas[e.id].exceptionsUsees++;});
      }

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie,dow,we)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);

      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:true,raison:'Assigné'}));

      if(assigned.length<reqMin||nuit||ferie||we)
        diagnostic.push({ds,plage:plage.nom,couverte:assigned.length>=reqMin,details:diagD});

      assigned.forEach(e=>{
        const isExcl=!isReunion(plage)&&(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom}: refusée → ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectée`);}
        else if(dem&&dem.type==='prefere')planning[ds][sk]='dem_pref';
        else if(isPref)planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        updateTracker(e,d,ds,plage,nuit,we);
      });

      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couvert(s)`);
    }

    // ── PASSE B : maximum (remplir si solde négatif) ──
    for(const plage of pj){
      if(plage.tous||isReunion(plage))continue;
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id])continue;
      const reqMin=Math.max(0,+plage.min||1),reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin)continue;
      const deja=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-deja.length;if(encore<=0)continue;

      const cands=educs.filter(e=>{
        if(deja.includes(e.id))return false;
        if(!checkLoi(e,d,ds,dow,plage).ok)return false;
        if(!checkConvention(e,d,ds,plage,1).ok)return false;
        // Passe B : uniquement si solde négatif
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        return solde<0;
      }).map(e=>({e,sc:score(e,d,ds,plage,we||ferie,dow,we)}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);

      if(!cands.length)continue;
      planning[ds][plage.id]=[...deja,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        planning[ds][`_s_${e.id}_${plage.id}`]=(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        updateTracker(e,d,ds,plage,isNuitP(plage)&&!isReunion(plage),we);
      });
    }
  }

  // ================================================================
  // MICRO-AJUSTEMENTS : swaps nuits semaine uniquement
  // Ne touche pas les WE (déjà optimisés par le score WE)
  // ================================================================
  L('Micro-ajustements...',87);await sl(30);
  for(let iter=0;iter<35;iter++){
    let improved=false;
    for(const ds of Object.keys(planning)){
      if(isWEDay(new Date(ds+'T12:00')))continue;
      if(lockedSlots[ds])continue;
      const d=new Date(ds+'T12:00'),dow=dowIdx(d);
      for(const plage of plages.filter(p=>isNuitP(p)&&!isReunion(p))){
        const ids=(planning[ds][plage.id]||[]).map(x=>+x);if(!ids.length)continue;
        const reqMin=+plage.min||1;
        for(const idIn of ids){
          const eIn=educById(idIn);if(!eIn)continue;
          const nIn=norm((hist[eIn.id].nuits||0)+(tracker[eIn.id].nuits||0),eIn);
          for(const eOut of educs){
            if(ids.includes(eOut.id))continue;
            const nOut=norm((hist[eOut.id].nuits||0)+(tracker[eOut.id].nuits||0),eOut);
            if(nOut>=nIn-1.5)continue;
            if(!(eOut.jours||[]).includes(dow)||isAbsent(eOut.id,ds))continue;
            if(!checkLoi(eOut,d,ds,dow,plage).ok)continue;
            const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
            if(newIds.length<reqMin)continue;
            const sIn=hist[eIn.id].solde+(tracker[eIn.id].h-quotas[eIn.id].h.cible);
            const sOut=hist[eOut.id].solde+(tracker[eOut.id].h-quotas[eOut.id].h.cible);
            if(sOut-dureeH(plage)<-14||sIn+dureeH(plage)>14)continue;
            planning[ds][plage.id]=newIds;
            delete planning[ds][`_s_${idIn}_${plage.id}`];
            planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
            tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);
            tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;
            tracker[eIn.id].h=Math.max(0,tracker[eIn.id].h-dureeH(plage));
            tracker[eOut.id].h+=dureeH(plage);
            improved=true;break;
          }
          if(improved)break;
        }
        if(improved)break;
      }
      if(improved)break;
    }
    if(!improved)break;
  }

  return{planning,warnings,diagnostic,tracker,quotas};
}

// ================================================================
// VALIDATION
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
      if(ids.length<(+p.min||1))errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min}`);
    });
  });
  const nTot={},hTot={};
  educs.forEach(e=>{nTot[e.id]=0;hTot[e.id]=tracker?tracker[e.id]?.h||0:0;});
  jours.forEach(d=>{
    const ds=dayStr(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)&&!isReunion(p))nTot[+id]=(nTot[+id]||0)+1;
      });
    });
  });
  const avgNN=moyPond(educs,e=>nTot[e.id]||0);
  educs.forEach(e=>{
    const ec=Math.abs(norm(nTot[e.id]||0,e)-avgNN);
    if(ec>4)warns.push(`Nuits : ${e.prenom} écart ${ec.toFixed(1)}`);
    const s=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(s)>15)warns.push(`Solde ${e.prenom}: ${s>=0?'+':''}${s.toFixed(1)}h`);
  });
  const ecNMax=educs.reduce((mx,e)=>Math.max(mx,Math.abs(norm(nTot[e.id]||0,e)-avgNN)),0);
  const metrics={
    equite:Math.max(0,100-ecNMax*12),stabilite:85,
    couverture:errors.length===0?100:Math.max(0,100-errors.length*15),
    prefs:100
  };
  return{valid:true,errors,warnings:warns,metrics};
}

function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.30+m.stabilite*0.30+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'À améliorer';
  return{score,label,details:m};
}
