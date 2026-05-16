// ============================================================
// algo.js - PlanEduc Pro - Moteur v17
// ============================================================
// DEUX CORRECTIONS STRUCTURELLES :
//  1. WE comme blocs atomiques (généré AVANT le reste)
//  2. Trajectoire annuelle heures (zones urgence + pression progressive)
//
// HIERARCHIE :
//  P1 - LOI           : repos 11h, 50h/sem, max consec, nuits consec
//  P2 - TRAJECTOIRE H : zones urgence heures (critique = override tout)
//  P3 - BLOCS WE      : attribués ensemble avant le reste
//  P4 - STABILITE     : patterns, habitudes, cycles
//  P5 - EQUITE DOUCE  : nuits/feries/types prorata contrat
//  P6 - PREFERENCES   : demandes éducs
//  P7 - MAXIMUM       : remplir si solde négatif
//
// GENERATION EN 4 ETAPES :
//  E1 - Calcul trajectoire annuelle
//  E2 - Attribution blocs WE (atomique, sam+dim ensemble)
//  E3 - Construction semaines normales autour des WE fixés
//  E4 - Micro-ajustements (swaps nuits/WE uniquement)
// ============================================================

const DEBUG_MODE = false;

// ── Helpers ──
const isNuitP  = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion= p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('réunion');
const isWEDay  = d => d.getDay()===0||d.getDay()===6;
const dowIdx   = d => d.getDay()===0?6:d.getDay()-1;
const ratioE   = e => getTargetH(e)/38;
const dbg      = (...a)=>{if(DEBUG_MODE)console.log('[v15]',...a);};
const POIDS    = {reunion:0.05,matin:1.0,aprem:1.0,soir:1.2,nuit:2.0};

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
function moyPond(arr,fn){ return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length); }
function norm(val,e){ return val/Math.max(0.01,ratioE(e)); }

let _pm=null,_em=null;
function plageById(id){if(!_pm||_pm.size!==plages.length)_pm=new Map(plages.map(p=>[p.id,p]));return _pm.get(+id);}
function educById(id){if(!_em||_em.size!==educs.length)_em=new Map(educs.map(e=>[e.id,e]));return _em.get(+id);}

// ================================================================
// TRAJECTOIRE ANNUELLE — ZONES D'URGENCE
// ================================================================
// Calcule pour chaque educ :
// - heures déjà faites cette année
// - objectif annuel
// - heures restantes à produire
// - zone urgence (normale/attention/critique/danger)
function calculerTrajectoireAnnuelle(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const anneeStr=String(yr);
  const moisRestants=Math.max(1, 13-mo); // mois restants dans l'année
  const traj={};

  educs.forEach(e=>{
    const re=ratioE(e);
    // Objectif annuel : utilise heuresAnnuelles si défini, sinon calcul réaliste
    // heuresAnnuelles = volume annuel brut de l'éducateur (ex: 1976h pour TP belge)
    // Si non défini : 52 semaines × heures hebdo contrat × ratio
    const objectifAnnuel = e.heuresAnnuelles
      ? +e.heuresAnnuelles  // valeur réelle encodée dans le profil
      : getTargetH(e)*52;   // 52 semaines × heures hebdo (ex: 38×52=1976h TP)
    // Heures déjà faites cette année (tous mois générés)
    let hFaites=0;
    let moisGeneres=0;
    Object.keys(horaire).filter(k=>k.startsWith(anneeStr)&&k<moisStr).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      const joursMois=getDays(ky,km);
      joursMois.forEach(day=>{
        const ds=dayStr(day);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          if(ids.map(x=>+x).includes(e.id)) hFaites+=dureeH(p);
        });
      });
      moisGeneres++;
    });
    // Heures restantes à produire
    const hRestantes=objectifAnnuel-hFaites;
    // Capacité théorique restante (mois restants × cible mensuelle)
    const cibleMensuelle=joursOuvMois(yr,mo)*7.6*re; // cible mois actuel
    const capaciteRestante=moisRestants*cibleMensuelle;
    // Solde trajectoire : hRestantes - capaciteRestante
    const soldeAnnuel=hFaites-(objectifAnnuel*(mo-1)/12); // avance/retard sur la trajectoire
    // Zone urgence
    // Zones urgence plafonnées : max 2.2 pour éviter comportements extrêmes
    let zone='normale', urgenceMult=1.0;
    if(soldeAnnuel<-50){zone='danger';urgenceMult=2.2;}    // plafonné (était 4.0)
    else if(soldeAnnuel<-30){zone='critique';urgenceMult=1.8;} // plafonné (était 3.0)
    else if(soldeAnnuel<-15){zone='attention';urgenceMult=1.4;}
    else if(soldeAnnuel>30){zone='surplus';urgenceMult=1.8;}
    else if(soldeAnnuel>15){zone='ok_positif';urgenceMult=1.3;}
    traj[e.id]={objectifAnnuel,hFaites,hRestantes,soldeAnnuel,zone,urgenceMult,moisRestants};
  });
  return traj;
}

// Pression selon le mois — plafonnée pour éviter comportements extrêmes
const PRESSION_MAX_GLOBAL=2.2; // jamais > 2.2x même en décembre zone critique
function pressionMois(mo){
  if(mo>=12) return 2.2;
  if(mo>=11) return 2.0;
  if(mo>=9)  return 1.7;
  if(mo>=6)  return 1.4;
  if(mo>=3)  return 1.2;
  return 1.0;
}

// ================================================================
// PATTERNS PERSISTANTS
// ================================================================
function loadPatterns(){ try{return JSON.parse(localStorage.getItem('planeduc_v3_patterns')||'{}');}catch(e){return {};} }
function savePatterns(p){ try{localStorage.setItem('planeduc_v3_patterns',JSON.stringify(p));}catch(e){} }

function buildPatterns(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const patterns=loadPatterns();
  for(let i=1;i<=4;i++){
    const key=moisKey(yr,mo-i); const plan=horaire[key]; if(!plan) continue;
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
  savePatterns(patterns); return patterns;
}

function bonusStabilite(e,dow,plage,patterns,isWE){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]||!pat[dow][plage.id]) return 0;
  const cnt=pat[dow][plage.id]||0;

  // Usure progressive : au-delà de 8 occurrences, le bonus commence à s'éroder doucement
  // pour éviter la rigidité permanente tout en conservant l'habitude
  // L'usure est légère (max -20% du bonus) et non brutale
  let usure=1.0;
  if(cnt>12) usure=0.80;       // très ancré mais légère ouverture
  else if(cnt>8) usure=0.90;   // bien ancré, légère pression diversification

  const mult=(isWE?0.7:1.6)*usure;
  if(cnt>=8) return -38*mult;
  if(cnt>=6) return -30*mult;
  if(cnt>=4) return -22*mult;
  if(cnt>=2) return -13*mult;
  return -5*mult;
}

// Détection spécialisation excessive : si >75% des prestations d'un type
// on ajoute une légère pression de diversification
function malusSpecialisation(e,tp,tracker_e,hist_e){
  const types=tracker_e.types||{};
  const histTypes=hist_e.types||{};
  const total=Object.values(types).reduce((s,v)=>s+v,0)+Object.values(histTypes).reduce((s,v)=>s+v,0);
  if(total<10) return 0; // pas assez de données
  const myType=(types[tp]||0)+(histTypes[tp]||0);
  const ratio=myType/Math.max(1,total);
  if(ratio>0.75) return 8;  // très spécialisé → légère pression
  if(ratio>0.60) return 4;
  return 0;
}

// Score cycle personnel : bonus si l'educ suit son rythme hebdo habituel global
// Ex: si quelqu'un travaille "souvent le mardi" → bonus sur tous les mardis
function scoreCyclePersonnel(e,dow,patterns){
  const pat=patterns[String(e.id)]; if(!pat||!pat[dow]) return 0;
  // Compter le total de toutes les plages ce jour
  const totalJour=Object.values(pat[dow]).reduce((s,v)=>s+v,0);
  // Si l'educ travaille souvent ce jour → bonus
  if(totalJour>=6) return -10;
  if(totalJour>=4) return -6;
  if(totalJour>=2) return -3;
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
    educs.forEach(e=>{tot[e.id]={h:0,nuits:0,we:0,feries:0,matin:0,aprem:0,soir:0,reunion:0,samNuit:0,dimNuit:0,samJour:0,dimJour:0,weBlocs:0,weCoupes:0};});
    Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day),dow=day.getDay(),weD=isWEDay(day),feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          const tp=typePlage(p),nuit=isNuitP(p);
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
            if(dow===6&&nuit) tot[id].samNuit++;
            if(dow===0&&nuit) tot[id].dimNuit++;
            if(dow===6&&!nuit) tot[id].samJour++;
            if(dow===0&&!nuit) tot[id].dimJour++;
          });
        });
      });
    });
    educs.forEach(e=>{stats[yr][e.id]=tot[e.id];});
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){console.warn('updateAnnualStats:',err);}
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
// QUOTAS
// ================================================================
function calculerQuotas(hist,jours,moisStr,traj){
  const [yr,mo]=moisStr.split('-').map(Number);
  const joursOuv=joursOuvMois(yr,mo);
  const poidsTotal=educs.reduce((s,e)=>s+ratioE(e),0);
  const annStats=loadAnnualStats()[yr]||{};
  const quotas={};
  educs.forEach(e=>{
    const re=ratioE(e);
    const base=joursOuv*7.6*re;
    // Ajustement basé sur la trajectoire annuelle (pas juste solde historique)
    const t=traj[e.id];
    let ajustTraj=0;
    if(t){
      // Si en retard sur la trajectoire → augmenter le quota mensuel
      // Si en avance → réduire légèrement
      const retardMensuel=t.soldeAnnuel/Math.max(1,t.moisRestants);
      ajustTraj=Math.max(-12,Math.min(12,-retardMensuel*0.6));
    }
    const ajustSolde=Math.max(-6,Math.min(6,-(hist[e.id].solde||0)*0.3));
    const ajustTotal=Math.max(-15,Math.min(15,ajustTraj+ajustSolde));
    quotas[e.id]={
      h:{cible:base+ajustTotal,min:base-15,max:base+15},
      plage:{},types:{},
      ann:annStats[e.id]||{nuits:0,we:0,feries:0},
      exceptionsUsees:0,exceptionsMax:3
    };
    plages.forEach(p=>{
      if(isReunion(p)){quotas[e.id].plage[p.id]={cible:999,min:0,max:999};return;}
      const ja=jours.filter(d=>{const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;return p.jours.includes(dc);}).length;
      const totalPostes=ja*(+p.min||1);
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      const myN=(hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgN=moyPond(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corr=(myN-avgN)*re*0.2;
      const annNuits=(annStats[e.id]||{}).nuits||0;
      const avgAnnN=moyPond(educs,x=>(annStats[x.id]||{}).nuits||0);
      const corrAnn=isNuitP(p)?Math.max(-1,Math.min(1,(norm(annNuits,e)-avgAnnN)*re*0.1)):0;
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
  btn.disabled=true;btn.innerHTML='<div class="spin"></div> Generation...';
  document.getElementById('gen-prog').style.display='block';
  document.getElementById('gen-alerts').innerHTML='';
  const log=document.getElementById('gen-log');log.innerHTML='';
  const L=(m,p)=>{log.innerHTML+=m+'<br>';log.scrollTop=log.scrollHeight;if(p!=null)document.getElementById('gen-bar').style.width=p+'%';};

  L('Detection impossibilites...',3);await sl(50);
  const impos=detecterImpossibilites(mois);
  impos.forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);
  window._lastDiagnostic=result.diagnostic||[];

  L('Validation...',93);await sl(30);
  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);

  horaire[mois]=result.planning;
  currentMonth=mois;save();
  updateAnnualStats(mois);
  buildPatterns(mois);

  const qs=planningQualityScore(validation);
  L(`Score qualite : ${qs.score}/100 — ${qs.label}`,null);

  // Afficher les zones urgence
  result.traj&&Object.entries(result.traj).forEach(([eid,t])=>{
    if(t.zone==='danger'||t.zone==='critique'){
      const e=educById(+eid);
      if(e) L(`⚠ ${e.prenom} ${e.nom} : zone ${t.zone} (${t.soldeAnnuel.toFixed(1)}h sur trajectoire annuelle)`,null);
    }
  });

  if(validation.errors.length) L(`⚠ ${validation.errors.length} poste(s) non couverts`,null);
  validation.warnings.slice(0,6).forEach(w=>L('! '+w,null));
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
  const pression=pressionMois(mo);

  L('E1 : Trajectoire annuelle et historique...',5);await sl(30);
  const lockedSlots=getLockedSlots(moisStr);

  // Trajectoire annuelle
  const traj=calculerTrajectoireAnnuelle(moisStr);

  // Historique
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={solde:0,plageCount:{},we:0,ferie:0,nuits:0,types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0}};
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
          hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e);});
  }

  L('E1 : Quotas et patterns...',12);await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr,traj);
  const patterns=buildPatterns(moisStr);
  const annStats=loadAnnualStats()[yr]||{};

  // Grouper jours WE par numéro de weekend
  const weMap={};let weNum=0,lastSat=-1;
  jours.forEach(d=>{
    if(d.getDay()===6){weNum++;lastSat=d.getDate();}
    if(d.getDay()===0&&lastSat<0)weNum++;
    if(isWEDay(d)) weMap[dayStr(d)]=weNum;
  });
  const weNums=[...new Set(Object.values(weMap))].sort((a,b)=>a-b);

  // Tracker
  const tracker={};const lastPrest={};
  educs.forEach(e=>{
    tracker[e.id]={h:0,nuits:0,nuitsC:0,weCount:0,weJours:new Set(),cons:0,lastDay:null,plageCount:{},types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},fatigue:0,joursH:{},dernierWE:null};
    plages.forEach(p=>tracker[e.id].plageCount[p.id]=0);
    lastPrest[e.id]=null;
  });
  const prevPlan=horaire[moisKey(yr,mo-1)]||{};
  Object.keys(prevPlan).sort().forEach(ds=>{
    Object.entries(prevPlan[ds]||{}).forEach(([pid,ids])=>{
      if(pid.startsWith('_')||!Array.isArray(ids))return;
      const p=plageById(+pid);if(!p)return;
      ids.forEach(eid=>{
        const id=+eid;
        if(!lastPrest[id]||ds>lastPrest[id].date)
          lastPrest[id]={date:ds,fin:p.fin,isNuit:isNuitP(p)&&!isReunion(p),pm:p.fin<p.debut};
      });
    });
  });

  // ── P1 : Vérification loi ──
  function checkLoi(e,d,ds,dow,plage){
    if(!(e.jours||[]).includes(dow))return{ok:false,raison:'Jour non travaillé'};
    if(isAbsent(e.id,ds))return{ok:false,raison:'Absence'};
    const t=tracker[e.id],re=isReunion(plage);
    if(!re){
      if(t.cons>=maxCons)return{ok:false,raison:`Max ${maxCons}j consécutifs`};
      if(isNuitP(plage)&&t.nuitsC>=maxNuitsC)return{ok:false,raison:'Max 2 nuits consécutives'};
      const la=lastPrest[e.id];
      if(la){
        const [lh,lm]=la.fin.split(':').map(Number);
        const [bh,bm]=plage.debut.split(':').map(Number);
        const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
        const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
        const dh=(debMs-finMs)/3600000;
        if(dh>=0&&dh<minRepos)return{ok:false,raison:`Repos 11h (${dh.toFixed(1)}h)`};
      }
      if(la&&la.isNuit&&reposNuit>0&&Math.round((d-new Date(la.date))/86400000)<=reposNuit)
        return{ok:false,raison:'Repos après nuit'};
      const maxHJ=isNuitP(plage)?14:11;
      const hJour=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
        const ids=(planning[ds]||{})[pp.id];
        return Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)?s+dureeH(pp):s;
      },0);
      if(hJour+dureeH(plage)>maxHJ)return{ok:false,raison:`Max h/jour`};
    }
    if(hSem(tracker[e.id],ds)+dureeH(plage)>50)return{ok:false,raison:'Max 50h/sem'};
    return{ok:true,raison:''};
  }

  function checkConvention(e,d,ds,plage,niveau){
    const re=isReunion(plage);
    if(niveau<2&&!re&&(e.excls||[]).includes(plage.id))return{ok:false,raison:'Plage refusée',dur:true};
    if(!re&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1)return{ok:false,raison:'Max WE/mois',dur:false};
    if(!re&&niveau===0){
      const t=traj[e.id];
      // Zone critique/danger → ignorer quota heures (rattrapage forcé)
      if(t&&(t.zone==='danger'||t.zone==='critique')){
        // En zone urgence : pas de blocage quota, sauf excls
      } else {
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        if(solde>14)return{ok:false,raison:`Solde +${solde.toFixed(1)}h`,dur:false};
      }
      const myC=tracker[e.id].plageCount[plage.id]||0;
      const qMax=quotas[e.id]?.plage[plage.id]?.max;
      if(qMax!==undefined&&myC>=qMax&&quotas[e.id].exceptionsUsees>=quotas[e.id].exceptionsMax)
        return{ok:false,raison:'Quota max',dur:false};
    }
    return{ok:true,raison:''};
  }

  // ── Score ──
  function score(e,d,ds,plage,weOrFerie,dow,isWEContext){
    const t=tracker[e.id],ht=hist[e.id],re=ratioE(e),q=quotas[e.id];
    const ann=annStats[e.id]||{nuits:0,we:0,feries:0};
    const tr=traj[e.id]||{zone:'normale',urgenceMult:1,soldeAnnuel:0};
    const reunion=isReunion(plage),nuit=isNuitP(plage);
    let sc=0;

    // P2 : Trajectoire annuelle (quasi-contrainte)
    const solde=ht.solde+(t.h-q.h.cible);
    const urgMult=tr.urgenceMult*pression;
    if(solde>12)       sc+=40*urgMult;
    else if(solde>8)   sc+=20*urgMult;
    else if(solde>4)   sc+=8;
    else if(solde<-12) sc-=40*urgMult;
    else if(solde<-8)  sc-=20*urgMult;
    else if(solde<-4)  sc-=8;
    else sc+=solde*1.5;

    // Trajectoire annuelle directe
    if(tr.soldeAnnuel<-50) sc-=50;
    else if(tr.soldeAnnuel<-30) sc-=30;
    else if(tr.soldeAnnuel<-15) sc-=15;
    if(tr.soldeAnnuel>30) sc+=35;
    else if(tr.soldeAnnuel>15) sc+=15;

    if(!reunion){
      // P4 : Stabilité + Cycle personnel (fort pour semaine normale)
      sc+=bonusStabilite(e,dow,plage,patterns,isWEContext);
      if(!isWEContext) sc+=scoreCyclePersonnel(e,dow,patterns);
      // Anti-rigidité : légère pression si trop spécialisé sur un type
      if(!isWEContext) sc+=malusSpecialisation(e,typePlage(plage),t,ht);

      // P5 : Équité prestations
      const myCP=norm((ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0),e);
      const avgCP=moyPond(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
      const ecP=myCP-avgCP;
      if(nuit||weOrFerie){sc+=ecP*12;if(ecP<-1.5)sc-=18;if(ecP>1.5)sc+=15;}
      else{sc+=ecP*4;}

      const tp=typePlage(plage);
      const myTP=norm((ht.types[tp]||0)+(t.types[tp]||0),e);
      const avgTP=moyPond(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
      const ecT=myTP-avgTP;
      if(nuit||weOrFerie){sc+=ecT*10;if(ecT<-1)sc-=12;if(ecT>1)sc+=10;}
      else{sc+=ecT*3;}

      if(weOrFerie){
        const myWE=norm((ht.we||0)+(t.weCount||0)+(ann.we||0),e);
        const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+(tracker[x.id].weCount||0)+((annStats[x.id]||{}).we||0));
        const ecWE=myWE-avgWE;
        sc+=ecWE*11;if(ecWE<-1)sc-=14;if(ecWE>1)sc+=11;
        // Alternance WE : pénaliser si WE trop rapproché
        if(t.dernierWE){
          const diffSem=Math.floor((new Date(ds+'T12:00')-new Date(t.dernierWE+'T12:00'))/604800000);
          if(diffSem<2) sc+=25; // trop rapproché
          else if(diffSem===2) sc-=8; // bonne alternance
        }
      }

      if(isFerie(ds)){
        const myF=norm((ht.ferie||0)+(ann.feries||0),e);
        const avgF=moyPond(educs,x=>(hist[x.id].ferie||0)+((annStats[x.id]||{}).feries||0));
        sc+=(myF-avgF)*12;
      }

      if(nuit){
        const myN=norm((ht.nuits||0)+(t.nuits||0)+(ann.nuits||0),e);
        const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+(tracker[x.id].nuits||0)+((annStats[x.id]||{}).nuits||0));
        const ecN=myN-avgN;
        sc+=ecN*15;if(ecN<-1.5)sc-=22;if(ecN>1.5)sc+=18;
      }

      sc+=t.fatigue*0.5;
    }

    // P6 : Préférences
    if(!reunion&&(e.prefs||[]).includes(plage.id)) sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')sc+=13;
        if(dem.type==='prefere')sc-=13;
      }
    });

    if(!reunion&&!e.acceptePause){
      const dejaTerrain=Object.keys(planning[ds]||{}).some(pid=>{
        if(pid.startsWith('_'))return false;
        const p2=plageById(+pid);if(!p2||isReunion(p2))return false;
        return(planning[ds][pid]||[]).map(x=>+x).includes(e.id);
      });
      if(dejaTerrain)sc+=30;
    }
    return sc;
  }

  function updateTracker(e,d,ds,plage,nuit,we){
    const t=tracker[e.id],tp=typePlage(plage),re=isReunion(plage);
    const h=dureeH(plage);
    t.h+=h;
    if(!t.joursH[ds])t.joursH[ds]=0;t.joursH[ds]+=h;
    if(!re){
      const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
      t.cons=diffJ===1?t.cons+1:1;t.lastDay=ds;
      if(nuit){t.nuits++;t.nuitsC++;}else t.nuitsC=0;
      if(we&&!t.weJours.has(ds)){t.weJours.add(ds);if(d.getDay()===6){t.weCount++;t.dernierWE=ds;}}
      const pw=POIDS[tp]||1;
      t.fatigue+=pw*(h>10?2:h>8?1.5:h>6?0.8:0.3)+(t.cons>4?1.2:0);
      t.fatigue=Math.min(18,t.fatigue*0.94);
      lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    t.types[tp]=(t.types[tp]||0)+1;
  }

  // ================================================================
  // E2 : GENERATION BLOCS WEEK-END (atomique)
  // On attribue chaque WE en entier AVANT de générer les semaines
  // sam+dim ensemble, validés ensemble
  // ================================================================
  // ── Pré-répartition globale (vision mois complet) ──
  // Calculer la "capacité restante" par educ pour éviter de les épuiser trop tôt
  const capaciteMois={};
  educs.forEach(e=>{
    const re=ratioE(e);
    const solde=hist[e.id].solde;
    const base=joursOuvMois(yr,mo)*7.6*re;
    const ajust=Math.max(-6,Math.min(6,-solde*0.3));
    const hCible=base+ajust;
    // Nb de WE restants dans le mois
    const nbWEMois=weNums.length;
    // Quota WE indicatif : maxWeMois ou proportionnel
    const quotaWEIndicatif=Math.min(maxWeMois, Math.round(nbWEMois*re));
    capaciteMois[e.id]={
      hCible,
      quotaWE:quotaWEIndicatif,
      weUtilises:0 // compteur pendant la génération
    };
  });

  L('E2 : Attribution blocs week-end...',20);await sl(30);

  // Pour chaque WE du mois, calculer quel "bloc" attribuer à qui
  const weAssigned={}; // { ds: { plageId: [educId,...] } }

  // ── Attribution blocs WE atomiques ──
  // 1. Construire les blocs disponibles pour chaque WE
  // 2. Scorer le bloc ENTIER pour chaque educ
  // 3. Attribuer le bloc complet d'un coup
  // Les WE coupés ne sont autorisés qu'en cas d'impossibilité légale

  for(const wn of weNums){
    const joursWE=jours.filter(d=>weMap[dayStr(d)]===wn).sort((a,b)=>a-b);
    if(!joursWE.length) continue;

    // Construire la liste de toutes les plages de ce WE (tous jours)
    const allSlotsWE=[]; // [{d, ds, dow, plage}]
    joursWE.forEach(d=>{
      const ds=dayStr(d),dow=dowIdx(d),fe=isFerie(ds);
      const dc=(fe&&!isWEDay(d))?5:dow;
      plages.filter(p=>p.jours.includes(dc)&&!isReunion(p)).forEach(p=>{
        allSlotsWE.push({d,ds,dow,plage:p});
      });
    });

    // Slots déjà verrouillés → recopier directement
    allSlotsWE.forEach(({ds,plage})=>{
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]){
        if(!weAssigned[ds]) weAssigned[ds]={};
        weAssigned[ds][plage.id]=lockedSlots[ds][plage.id];
      }
    });

    // Scorer chaque educ sur le WE COMPLET
    // Le score intègre : équité WE annuelle, alternance, trajectoire, quota
    const scoreWE=educs.map(e=>{
      let sc=0;
      const ann=annStats[e.id]||{};
      const t=traj[e.id]||{zone:'normale',urgenceMult:1,soldeAnnuel:0};

      // Équité WE annuelle proratisée
      const myWE=norm((hist[e.id].we||0)+(ann.we||0),e);
      const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+((annStats[x.id]||{}).we||0));
      sc+=(myWE-avgWE)*13;

      // Alternance WE : pénaliser si WE précédent trop proche
      if(tracker[e.id].dernierWE){
        const dernD=new Date(tracker[e.id].dernierWE+'T12:00');
        const diffSem=Math.round((joursWE[0]-dernD)/604800000);
        if(diffSem<=1) sc+=35;      // WE consécutifs = très pénalisant
        else if(diffSem===2) sc-=8; // bonne alternance
        else if(diffSem>=4) sc+=5;  // trop longtemps sans WE → prioritaire
      }

      // Trajectoire annuelle
      if(t.soldeAnnuel<-30) sc-=22;
      else if(t.soldeAnnuel<-15) sc-=10;
      if(t.soldeAnnuel>30) sc+=18;
      else if(t.soldeAnnuel>15) sc+=8;

      // Solde mensuel
      const soldeMois=hist[e.id].solde+(tracker[e.id].h-(quotas[e.id]?.h.cible||0));
      if(soldeMois<-10) sc-=12;
      if(soldeMois>10)  sc+=12;

      // Max WE/mois déjà atteint ou quota indicatif atteint
      if(tracker[e.id].weCount>=maxWeMois) sc+=50;
      else if(capaciteMois[e.id]&&tracker[e.id].weCount>=(capaciteMois[e.id].quotaWE)) sc+=15;

      // Stabilité pattern WE (habitude de ce WE)
      joursWE.forEach(d=>{
        const dow=dowIdx(d);
        allSlotsWE.filter(s=>s.dow===dow).forEach(({plage})=>{
          sc+=bonusStabilite(e,dow,plage,patterns,true)*0.5;
        });
      });

      return{e,sc};
    }).sort((a,b)=>a.sc-b.sc);

    // ── attribuerBlocWE : attribution atomique du bloc complet ──
    // On choisit d'abord les éducs qui vont FAIRE ce WE,
    // puis on les distribue sur les plages — bloc inséparable.

    // Etape A : déterminer combien d'éducs distincts sont nécessaires ce WE
    const maxParPlage=Math.max(...allSlotsWE.filter(s=>!(lockedSlots[s.ds]&&lockedSlots[s.ds][s.plage.id])).map(s=>+s.plage.min||1),0);
    // Simplification : on cible maxParPlage éducs pour le bloc
    const nbEducsWE=Math.max(1,maxParPlage);

    // Etape B : choisir le groupe optimal (top nbEducsWE selon scoreWE)
    // Vérifier que le groupe peut légalement couvrir toutes les plages du bloc
    function groupePeutCouvrir(groupe){
      for(const {d,ds,dow,plage} of allSlotsWE){
        if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;
        const reqMin=+plage.min||1;
        const valides=groupe.filter(e=>checkLoi(e,d,ds,dow,plage).ok);
        if(valides.length<reqMin) return false;
      }
      return true;
    }

    // Chercher le meilleur groupe valide
    let groupeChoisi=[];
    const candidatsPossibles=scoreWE.filter(({e})=>{
      // Au moins légalement capable de travailler un jour de ce WE
      return allSlotsWE.some(({d,ds,dow,plage})=>checkLoi(e,d,ds,dow,plage).ok);
    });
    // Essayer avec les top nbEducsWE d'abord
    const topCands=candidatsPossibles.slice(0,Math.min(nbEducsWE*2,candidatsPossibles.length)).map(x=>x.e);
    if(groupePeutCouvrir(topCands.slice(0,nbEducsWE))){
      groupeChoisi=topCands.slice(0,nbEducsWE);
    } else {
      // Fallback : utiliser tous les candidats disponibles
      groupeChoisi=topCands;
    }

    // Etape C : distribuer le bloc sur les plages avec le groupe choisi
    const dejaDansWE=new Set(groupeChoisi.map(e=>e.id));
    const slotsTries=[...allSlotsWE].sort((a,b)=>{
      const na=isNuitP(a.plage)?0:1,nb=isNuitP(b.plage)?0:1; return na-nb;
    });

    for(const {d,ds,dow,plage} of slotsTries){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id]) continue;
      if(!weAssigned[ds]) weAssigned[ds]={};
      const reqMin=+plage.min||1, nuit=isNuitP(plage);

      // Prioriser les membres du groupe choisi, puis élargir si besoin
      let cands=groupeChoisi.filter(e=>checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,0).ok);
      if(cands.length<reqMin){
        // Elargir au-delà du groupe (cas exceptionnel)
        const extra=scoreWE.filter(({e})=>!dejaDansWE.has(e.id)&&checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,1).ok).map(x=>x.e);
        cands=[...cands,...extra];
        extra.forEach(e=>dejaDansWE.add(e.id)); // les ajouter au bloc
      }
      if(cands.length<reqMin){
        const urgence=scoreWE.filter(({e})=>checkLoi(e,d,ds,dow,plage).ok).map(x=>x.e);
        cands=[...new Set([...cands,...urgence])];
      }

      const assigned=cands.slice(0,reqMin);
      weAssigned[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>updateTracker(e,d,ds,plage,nuit,true));
      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couvert(s) (WE bloc)`);
    }

    // Vérification : si un educ est seulement sam ou seulement dim → WE coupé
    // Logger mais ne pas casser (cas exceptionnels légaux)
    const samEducs=new Set(),dimEducs=new Set();
    joursWE.forEach(d=>{
      const ds=dayStr(d),dow=d.getDay();
      Object.entries(weAssigned[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids)) return;
        ids.forEach(id=>{
          if(dow===6) samEducs.add(+id);
          if(dow===0) dimEducs.add(+id);
        });
      });
    });
    samEducs.forEach(id=>{if(!dimEducs.has(id)){const e=educById(id);if(e)warnings.push(`WE ${wn}: ${e.prenom} travaille seulement le samedi (WE coupé exceptionnel)`);}});
    dimEducs.forEach(id=>{if(!samEducs.has(id)){const e=educById(id);if(e)warnings.push(`WE ${wn}: ${e.prenom} travaille seulement le dimanche (WE coupé exceptionnel)`);}});
  }

  // ================================================================
  // E3 : GENERATION SEMAINES NORMALES (autour des WE déjà fixés)
  // ================================================================
  L('E3 : Construction semaines...',40);

  for(let di=0;di<jours.length;di++){
    if(di%3===0){L(`Jour ${di+1}/${jours.length}`,40+Math.round((di/jours.length)*45));await sl(0);}
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    // Recopier verrouillages
    if(lockedSlots[ds]){
      Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
        planning[ds][pid]=ids;planning[ds]['_lock_'+pid]='locked';
        ids.forEach(eid=>{const e=educById(+eid);if(!e)return;const p=plageById(+pid);if(!p)return;updateTracker(e,d,ds,p,isNuitP(p)&&!isReunion(p),we);});
      });
    }

    // Si c'est un WE : utiliser les blocs pré-assignés
    if(we&&weAssigned[ds]){
      Object.entries(weAssigned[ds]).forEach(([pid,ids])=>{
        if(lockedSlots[ds]&&lockedSlots[ds][pid])return; // déjà verrouillé
        planning[ds][pid]=ids;
        const p=plageById(+pid); if(!p) return;
        ids.forEach(eid=>{
          const e=educById(+eid); if(!e) return;
          const isPref=(e.prefs||[]).includes(+pid);
          planning[ds][`_s_${eid}_${pid}`]=isPref?'pref':'neutral';
        });
        // Vérif min
        if(ids.length<(+p.min||1))
          warnings.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} (bloc WE incomplet)`);
      });
      // Plages WE non couvertes par le bloc (réunions, etc.)
      const dowForPlages=dowIdx(d);
      const pjWE=plages.filter(p=>{
        if((weAssigned[ds]||{})[p.id]!==undefined)return false; // déjà traité
        if(lockedSlots[ds]&&lockedSlots[ds][p.id])return false;
        return p.jours.includes(dowForPlages)&&isReunion(p);
      });
      for(const plage of pjWE){
        const reqMin=+plage.min||1;
        let cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,0).ok);
        if(cands.length<reqMin)cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok);
        const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,true,dow,true)})).sort((a,b)=>a.sc-b.sc);
        const assigned=scored.slice(0,reqMin).map(x=>x.e);
        planning[ds][plage.id]=assigned.map(e=>e.id);
        assigned.forEach(e=>{
          planning[ds][`_s_${e.id}_${plage.id}`]='neutral';
          updateTracker(e,d,ds,plage,false,true);
        });
      }
      continue; // WE traité — passer au jour suivant
    }

    // Jours normaux (semaine + fériés)
    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));
    function prio(p){
      if(isReunion(p))return 10; if(isNuitP(p))return 0;
      if(ferie)return 1; if(dureeH(p)>8)return 2; return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=prio(a),pb=prio(b);if(pa!==pb)return pa-pb;
      const ca=educs.filter(e=>checkLoi(e,d,ds,dow,a).ok).length;
      const cb=educs.filter(e=>checkLoi(e,d,ds,dow,b).ok).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

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
        if(!conv.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:conv.raison});return;}
        cands.push(e);
      });
      if(cands.length<reqMin&&!useAll)cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok&&checkConvention(e,d,ds,plage,1).ok);
      if(cands.length<reqMin&&!useAll){cands=educs.filter(e=>checkLoi(e,d,ds,dow,plage).ok);cands.forEach(e=>{if(quotas[e.id])quotas[e.id].exceptionsUsees++;});}

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,ferie,dow,false)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);
      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:true,raison:'Assigné'}));
      if(assigned.length<reqMin||(nuit||ferie))diagnostic.push({ds,plage:plage.nom,couverte:assigned.length>=reqMin,details:diagD});

      assigned.forEach(e=>{
        const isExcl=!isReunion(plage)&&(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom}: refusée assignée à ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectée`);}
        else if(dem&&dem.type==='prefere')planning[ds][sk]='dem_pref';
        else if(isPref)planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        updateTracker(e,d,ds,plage,nuit,false);
      });
      if(assigned.length<reqMin)warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couvert(s)`);
    }

    // Passe B : maximum
    const dowForMax=dowForPlages;
    for(const plage of plages.filter(p=>p.jours.includes(dowForMax)&&!p.tous&&!isReunion(p))){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id])continue;
      if(we)continue; // WE déjà traité en bloc
      const reqMin=Math.max(0,+plage.min||1),reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin)continue;
      const deja=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-deja.length;if(encore<=0)continue;
      const cands=educs.filter(e=>{
        if(deja.includes(e.id))return false;
        if(!checkLoi(e,d,ds,dow,plage).ok)return false;
        if(!checkConvention(e,d,ds,plage,1).ok)return false;
        const solde=hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible);
        return solde<10;
      }).map(e=>({e,sc:score(e,d,ds,plage,false,dow,false)}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);
      if(!cands.length)continue;
      planning[ds][plage.id]=[...deja,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        planning[ds][`_s_${e.id}_${plage.id}`]=(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        updateTracker(e,d,ds,plage,isNuitP(plage),false);
      });
    }
  }

  // ================================================================
  // E4 : MICRO-AJUSTEMENTS (swaps nuits uniquement)
  // NE PAS toucher les blocs WE déjà attribués
  // ================================================================
  L('E4 : Micro-ajustements nuits...',87);await sl(30);

  let sw=0;
  for(let iter=0;iter<40;iter++){
    let improved=false;
    for(const ds of Object.keys(planning)){
      if(isWEDay(new Date(ds+'T12:00')))continue; // pas de swap sur WE
      if(lockedSlots[ds])continue;
      const d=new Date(ds+'T12:00'),dow=dowIdx(d);
      for(const plage of plages.filter(p=>isNuitP(p)&&!isReunion(p))){
        const ids=(planning[ds][plage.id]||[]).map(x=>+x);if(!ids.length)continue;
        const reqMin=+plage.min||1;
        for(const idIn of ids){
          const eIn=educById(idIn);if(!eIn)continue;
          const nIn=norm((hist[eIn.id].nuits||0)+(tracker[eIn.id].nuits||0),eIn);
          for(const eOut of educs.filter(e=>!ids.includes(e.id))){
            const nOut=norm((hist[eOut.id].nuits||0)+(tracker[eOut.id].nuits||0),eOut);
            if(nOut>=nIn-1.5)continue;
            if(!(eOut.jours||[]).includes(dow)||isAbsent(eOut.id,ds))continue;
            if(!checkLoi(eOut,d,ds,dow,plage).ok)continue;
            const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
            if(newIds.length<reqMin)continue;
            if((planning[ds][plage.id]||[]).map(x=>+x).includes(eOut.id))continue;
            const sIn=hist[eIn.id].solde+(tracker[eIn.id].h-quotas[eIn.id].h.cible);
            const sOut=hist[eOut.id].solde+(tracker[eOut.id].h-quotas[eOut.id].h.cible);
            if(sOut-dureeH(plage)<-14)continue;
            if(sIn+dureeH(plage)>14)continue;
            planning[ds][plage.id]=newIds;
            delete planning[ds][`_s_${idIn}_${plage.id}`];
            planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
            tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);
            tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;
            tracker[eIn.id].h=Math.max(0,tracker[eIn.id].h-dureeH(plage));
            tracker[eOut.id].h+=dureeH(plage);
            tracker[eIn.id].plageCount[plage.id]=Math.max(0,(tracker[eIn.id].plageCount[plage.id]||0)-1);
            tracker[eOut.id].plageCount[plage.id]=(tracker[eOut.id].plageCount[plage.id]||0)+1;
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
  if(sw>0)dbg(`Swaps nuits: ${sw}`);

  return{planning,warnings,diagnostic,tracker,quotas,traj};
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
  const avgNN=moyPond(educs,e=>nTot[e.id]||0);let ecNMax=0;
  educs.forEach(e=>{
    const ec=Math.abs(norm(nTot[e.id]||0,e)-avgNN);
    if(ec>ecNMax)ecNMax=ec;
    if(ec>4)warns.push(`Nuits : ${e.prenom} écart ${ec.toFixed(1)}`);
  });
  let ecHMax=0;
  educs.forEach(e=>{
    const s=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(s)>ecHMax)ecHMax=Math.abs(s);
    if(Math.abs(s)>15)warns.push(`Solde ${e.prenom}: ${s>=0?'+':''}${s.toFixed(1)}h`);
  });
  const metrics={equite:Math.max(0,100-ecNMax*12),stabilite:85,couverture:errors.length===0?100:Math.max(0,100-errors.length*15),prefs:Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)};
  return{valid:true,errors,warnings:warns,metrics};
}

function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.30+m.stabilite*0.30+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'À améliorer';
  return{score,label,details:m};
}
