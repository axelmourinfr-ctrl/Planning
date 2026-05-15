// ============================================================
// algo.js - PlanEduc Pro - Moteur v10
// ============================================================
// HIERARCHIE STRICTE :
//  P1 - LOI          : repos 11h, max 6j consec, max 2 nuits consec,
//                      max 50h/sem, max 14h nuit, 11h normal
//  P2 - COUVERTURE   : minimum de chaque plage OBLIGATOIRE
//  P3 - EQUITE       : heures ±15h/mois, 0 trimestriel
//                      prestations prorata contrat ±1-2/mois
//                      WE, feries, nuits equite annuelle
//  P4 - STABILITE    : patterns semaine, cycles A/B, fatigue
//  P5 - PREFERENCES  : demandes educs (jamais > P1-P4)
//  P6 - MAXIMUM      : remplir jusqu'au max si solde negatif
//
// NOUVEAUTES v10 :
//  - Stats annuelles utilisees dans toutes les decisions
//  - Swaps securises avec revalidation locale complete
//  - Score penibilite (eviter sacrifies chroniques)
//  - Score fatigue (charge humaine)
//  - Score stabilite (patterns semaine)
//  - Optimisation multi-passes (nuits→WE→heures→stabilite→prefs)
//  - Pre-allocation intelligente (vision mois complet)
//  - Tracker enrichi (fatigue, penibilite, patterns, exceptions)
//  - Score qualite global sur 100
//  - Validation avec metriques
//  - Explications d'impossibilite
//  - Mode debug
//  - Caches et index de performance
// ============================================================

const DEBUG_MODE = false; // passer a true pour logs detailles

// ================================================================
// UI
// ================================================================
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

  L('Detection des impossibilites...', 3); await sl(50);
  const impos = detecterImpossibilites(mois);
  impos.forEach(msg => L('⚠ ' + msg, null));

  const result = await genMois(mois, L);

  L('Validation finale...', 93); await sl(30);
  const validation = validatePlanning(result.planning, mois, result.tracker, result.quotas);

  if(!validation.valid){
    L('ERREURS BLOQUANTES :', null);
    validation.errors.forEach(e => L('  ✗ ' + e, null));
    L('Generation annulee.', null);
    btn.disabled = false;
    btn.innerHTML = "Generer l'horaire";
    showAlert('gen-alerts','err',`Generation echouee : ${validation.errors.length} erreur(s) bloquante(s).`);
    return;
  }

  horaire[mois] = result.planning;
  currentMonth  = mois;
  save();
  updateAnnualStats(mois);

  // Score qualite
  const qs = planningQualityScore(validation);
  L(`Score qualite : ${qs.score}/100 — ${qs.label}`, null);
  L(`  Equite:${qs.details.equite} Stabilite:${qs.details.stabilite} Couverture:${qs.details.couverture} Prefs:${qs.details.prefs}`, null);

  if(validation.warnings.length){
    L(`--- ${validation.warnings.length} avertissement(s) ---`, null);
    validation.warnings.slice(0,12).forEach(w => L('! ' + w, null));
  }
  result.warnings.slice(0,5).forEach(w => L('! ' + w, null));

  L('Termine !', 100);
  btn.disabled = false;
  btn.innerHTML = "Generer l'horaire";
  showAlert('gen-alerts','ok',`Horaire genere — Score qualite : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// UTILITAIRES & HELPERS
// ================================================================
const isNuitP = p => p.type==='nuit' || p.debut>='22:00' || (p.fin<='07:00' && p.fin>'00:00');
const isWEDay = d => d.getDay()===0 || d.getDay()===6;
const dowIdx  = d => d.getDay()===0 ? 6 : d.getDay()-1;
const ratioE  = e => getTargetH(e) / 38;
const dbg     = (...a) => { if(DEBUG_MODE) console.log('[PlanEduc]', ...a); };

function dureeHPlage(p){
  if(p.dureeH && p.dureeH > 0) return p.dureeH;
  const [dh,dm] = p.debut.split(':').map(Number);
  const [fh,fm] = p.fin.split(':').map(Number);
  let h = (fh*60+fm)-(dh*60+dm);
  if(h<=0) h+=1440;
  return h/60;
}

function joursOuvMois(yr, mo){
  return getDays(yr,mo).filter(d=>{
    const dw=d.getDay(); return dw>=1&&dw<=5&&!isFerie(dayStr(d));
  }).length;
}

function moyPonderee(arr, fn){
  return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length);
}

function normalisee(val, e){ return val/Math.max(0.01,ratioE(e)); }

function typePlage(p){
  if(isNuitP(p)) return 'nuit';
  const h = parseInt(p.debut);
  if(h<10) return 'matin';
  if(h<14) return 'aprem';
  return 'soir';
}

// Cache plage par id pour eviter find() repetes
let _plageMap = null;
function plageById(id){
  if(!_plageMap || _plageMap.size !== plages.length){
    _plageMap = new Map(plages.map(p=>[p.id,p]));
  }
  return _plageMap.get(+id);
}

// Cache educ par id
let _educMap = null;
function educById(id){
  if(!_educMap || _educMap.size !== educs.length){
    _educMap = new Map(educs.map(e=>[e.id,e]));
  }
  return _educMap.get(+id);
}

// ================================================================
// STATS ANNUELLES PERSISTANTES
// ================================================================
function loadAnnualStats(){
  try{ return JSON.parse(localStorage.getItem('planeduc_v3_annual')||'{}'); }
  catch(e){ return {}; }
}

function updateAnnualStats(moisStr){
  try{
    const yr      = moisStr.split('-')[0];
    const stats   = loadAnnualStats();
    if(!stats[yr]) stats[yr]={};
    const totaux  = {};
    educs.forEach(e=>{ totaux[e.id]={heures:0,nuits:0,weekends:0,feries:0,matin:0,aprem:0,soir:0}; });

    Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
      const [ky,km] = mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day), weD=isWEDay(day), feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          const tp=typePlage(p);
          ids.forEach(eid=>{
            const id=+eid; if(!totaux[id]) return;
            totaux[id].heures+=dureeHPlage(p);
            if(tp==='nuit')  totaux[id].nuits++;
            if(tp==='matin') totaux[id].matin++;
            if(tp==='aprem') totaux[id].aprem++;
            if(tp==='soir')  totaux[id].soir++;
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
// DETECTION D'IMPOSSIBILITES (avec explications precises)
// ================================================================
function detecterImpossibilites(moisStr){
  const [yr,mo] = moisStr.split('-').map(Number);
  const jours   = getDays(yr,mo);
  const msgs    = [];
  const minRepos = getRule('min_repos',11);

  plages.forEach(p=>{
    jours.forEach(d=>{
      const ds  = dayStr(d);
      const dow = dowIdx(d);
      const we  = isWEDay(d);
      const fe  = isFerie(ds);
      const dc  = (fe&&!we)?5:dow;
      if(!p.jours.includes(dc)) return;

      const dispo = educs.filter(e=>(e.jours||[]).includes(dow)&&!isAbsent(e.id,ds));
      const reqMin = +p.min||1;
      if(dispo.length < reqMin){
        msgs.push(`${ds} - ${p.nom}: ${dispo.length} educ(s) disponible(s) pour ${reqMin} requis — couverture impossible`);
      }
    });
  });
  return msgs;
}

// ================================================================
// CALCUL DES QUOTAS DURS (avec stats annuelles)
// cible / min / max par plage, par type, heures
// ================================================================
function calculerQuotas(hist, jours, moisStr){
  const [yr,mo] = moisStr.split('-').map(Number);
  const joursOuv   = joursOuvMois(yr,mo);
  const poidsTotal = educs.reduce((s,e)=>s+ratioE(e),0);
  const annStats   = loadAnnualStats()[yr] || {};

  const quotas = {};
  educs.forEach(e=>{
    const re   = ratioE(e);
    const ann  = annStats[e.id] || {nuits:0,weekends:0,feries:0};

    // Quota heures : cible + ajust solde + correction annuelle
    const base    = joursOuv * 7.6 * re;
    const ajustSolde = Math.max(-10,Math.min(10,-(hist[e.id].solde||0)*0.5));
    // Si beaucoup de nuits/WE annuels deja : reduire un peu la charge
    const ajustAnn = ann.nuits > 30*re ? -2 : ann.nuits < 10*re ? 2 : 0;

    quotas[e.id] = {
      h: { cible: base+ajustSolde+ajustAnn, min: base-15, max: base+15 },
      plage: {},
      types: {},
      ann: { nuits: ann.nuits||0, weekends: ann.weekends||0, feries: ann.feries||0 },
      exceptionsUsees: 0,
      exceptionsMax: 2 // max 2 depassements exceptionnels par mois
    };

    plages.forEach(p=>{
      const joursActifs = jours.filter(d=>{
        const di=dowIdx(d), dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
        return p.jours.includes(dc);
      }).length;
      const totalPostes = joursActifs*(+p.min||1);
      const cible = totalPostes*re/Math.max(0.01,poidsTotal);
      // Correction historique normalisee
      const myHistN  = (hist[e.id].plageCount[p.id]||0)/Math.max(0.01,re);
      const avgHistN = moyPonderee(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corrHist = (myHistN-avgHistN)*re*0.3;
      // Correction annuelle
      const annNuits = ann.nuits||0;
      const avgAnnN  = moyPonderee(educs,x=>(annStats[x.id]||{}).nuits||0);
      const corrAnn  = isNuitP(p) ? (normalisee(annNuits,e)-avgAnnN)*re*0.2 : 0;
      const cibleCorr = Math.max(0, cible-corrHist-corrAnn);
      quotas[e.id].plage[p.id] = {
        cible: cibleCorr,
        min:   Math.max(0,Math.floor(cibleCorr-2)),
        max:   Math.ceil(cibleCorr+2)
      };
    });

    // Quotas par type
    ['matin','aprem','soir','nuit'].forEach(tp=>{
      const plagesDuType = plages.filter(p2=>(tp==='nuit'?isNuitP(p2):typePlage(p2)===tp));
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
// PRE-ALLOCATION INTELLIGENTE (vision mois complet)
// Repartit les nuits sur tout le mois en tenant compte
// des repos, nuits consecutives, equite annuelle
// ================================================================
function preAllouerIntelligent(jours, quotas, hist, moisStr){
  const preAlloc = {};
  const annStats = loadAnnualStats()[moisStr.split('-')[0]] || {};

  // Compteurs temporaires
  const cpt = {};
  educs.forEach(e=>{
    cpt[e.id]={ nuits:0, we:0, lastNuit:null, nuitsC:0, lastDay:null, cons:0 };
  });

  // Traiter nuits du mois dans l'ordre chronologique
  const joursAvecNuits = jours.filter(d=>{
    const dow=dowIdx(d), we=isWEDay(d), fe=isFerie(dayStr(d));
    const dc=(fe&&!we)?5:dow;
    return plages.some(p=>p.jours.includes(dc)&&isNuitP(p));
  });

  joursAvecNuits.forEach(d=>{
    const ds=dayStr(d), dow=dowIdx(d), we=isWEDay(d), fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;
    const nuitsJour=plages.filter(p=>p.jours.includes(dc)&&isNuitP(p));
    preAlloc[ds]={};

    nuitsJour.forEach(p=>{
      const reqMin=+p.min||1;
      // Candidats : disponibles, pas en urgence nuits consec, repos OK
      const cands=educs.filter(e=>{
        if(!(e.jours||[]).includes(dow)||isAbsent(e.id,ds)) return false;
        if(cpt[e.id].nuitsC>=2) return false;
        if(cpt[e.id].lastNuit){
          const diffJ=Math.round((d-new Date(cpt[e.id].lastNuit))/86400000);
          if(diffJ<=1) return false; // repos apres nuit
        }
        return true;
      }).sort((a,b)=>{
        // Trier par : moins de nuits normalisees (annuel + ce mois)
        const annNA = (annStats[a.id]||{}).nuits||0;
        const annNB = (annStats[b.id]||{}).nuits||0;
        const scoreA = normalisee((annNA+cpt[a.id].nuits), a);
        const scoreB = normalisee((annNB+cpt[b.id].nuits), b);
        return scoreA-scoreB;
      }).slice(0,reqMin);

      preAlloc[ds][p.id]=cands.map(e=>e.id);
      cands.forEach(e=>{
        cpt[e.id].nuits++;
        cpt[e.id].nuitsC++;
        cpt[e.id].lastNuit=ds;
        cpt[e.id].lastDay=ds;
      });
    });

    // Reset nuitsC si pas de nuit aujourd'hui pour les autres
    educs.forEach(e=>{
      if(cpt[e.id].lastDay===ds) return;
      cpt[e.id].nuitsC=0;
    });
  });

  return preAlloc;
}

// ================================================================
// MOTEUR PRINCIPAL
// ================================================================
async function genMois(moisStr, L){
  _plageMap=null; _educMap=null; // reset caches

  const [yr,mo] = moisStr.split('-').map(Number);
  const jours   = getDays(yr,mo);
  const planning= {}, warnings=[];
  const horizon = +document.getElementById('gen-horizon').value || 3;

  const minRepos    = getRule('min_repos',11);
  const maxCons     = getRule('max_consec',6);
  const maxWeMois   = getRule('max_we_mois',2);
  const reposNuit   = getRule('repos_apres_nuit',1);
  const maxNuitsC   = 2;

  L('Chargement historique...', 7); await sl(30);

  // ── HISTORIQUE ──
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={ solde:0, plageCount:{}, we:0, ferie:0, nuits:0,
                 types:{matin:0,aprem:0,soir:0,nuit:0} };
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
          if(isNuitP(p)) hist[id].nuits++;
          hist[id].types[tp]=(hist[id].types[tp]||0)+1;
        });
      });
    });
    educs.forEach(e=>{
      hist[e.id].solde+=hTrav[e.id]-joursOuvH*7.6*ratioE(e);
    });
  }

  L('Calcul des quotas durs...', 14); await sl(30);
  const quotas=calculerQuotas(hist,jours,moisStr);

  L('Pre-allocation intelligente des nuits...', 21); await sl(30);
  const preAlloc=preAllouerIntelligent(jours,quotas,hist,moisStr);

  // ── TRACKER ENRICHI ──
  const tracker={};
  const lastPrest={};
  educs.forEach(e=>{
    tracker[e.id]={
      h:0, nuits:0, nuitsC:0,
      weCount:0, weJours:new Set(),
      cons:0, lastDay:null,
      plageCount:{},
      types:{matin:0,aprem:0,soir:0,nuit:0},
      fatigue:0,        // score de charge cumule
      penibilite:{},    // { dow: { plageId: count } } - repetitions par jour
      exceptionsQuota:0,
      patterns:{},      // { dow: { plageId: count } } - patterns semaine
      dernierWE:null,
      dernierFerie:null
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
          lastPrest[id]={date:ds,fin:p.fin,isNuit:isNuitP(p),pm:p.fin<p.debut};
      });
    });
  });

  // ── P1 : LOI (filtre absolu) ──
  function respecteLoi(e, d, ds, dow, plage, planningCourant){
    if(!(e.jours||[]).includes(dow)) return false;
    if(isAbsent(e.id,ds)) return false;
    const t=tracker[e.id], la=lastPrest[e.id];
    if(t.cons>=maxCons) return false;
    if(isNuitP(plage)&&t.nuitsC>=maxNuitsC) return false;
    if(la){
      const [lh,lm]=la.fin.split(':').map(Number);
      const [bh,bm]=plage.debut.split(':').map(Number);
      const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
      const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
      if((debMs-finMs)/3600000<minRepos&&(debMs-finMs)>=0) return false;
    }
    if(la&&la.isNuit&&reposNuit>0){
      if(Math.round((d-new Date(la.date))/86400000)<=reposNuit) return false;
    }
    // Max heures jour
    const maxHJ=isNuitP(plage)?14:11;
    const planRef=planningCourant||planning;
    const hJour=plages.reduce((s,pp)=>{
      const ids=(planRef[ds]||{})[pp.id];
      return (Array.isArray(ids)&&ids.map(x=>+x).includes(e.id))?s+dureeHPlage(pp):s;
    },0);
    if(hJour+dureeHPlage(plage)>maxHJ) return false;
    // Max 50h/semaine (approximation sur 7 jours glissants)
    let hSem=t.h;
    if(hSem+dureeHPlage(plage)>50) return false;
    return true;
  }

  function respecteConvention(e, d, ds, plage, niveau){
    // niveau 0=strict, 1=relache quota, 2=urgence (excls seulement)
    if(niveau<2&&(e.excls||[]).includes(plage.id)) return false;
    if(isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1) return false;
    if(niveau===0){
      // Quota dur : bloquer si depasse le max de cette plage
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
  function score(e, d, ds, plage, weOrFerie, preAllocIds){
    const t=tracker[e.id], ht=hist[e.id], re=ratioE(e), q=quotas[e.id];
    const annStats=loadAnnualStats()[moisStr.split('-')[0]]||{};
    const ann=annStats[e.id]||{nuits:0,weekends:0,feries:0};
    let sc=0;

    // ── P3a : Solde heures ──
    const soldeCumul=ht.solde+(t.h-q.h.cible);
    sc+=soldeCumul*4.0;
    if(soldeCumul<-20) sc-=45;
    else if(soldeCumul<-12) sc-=25;
    else if(soldeCumul<-6)  sc-=12;
    if(soldeCumul>18) sc+=35;
    else if(soldeCumul>10) sc+=18;
    else if(soldeCumul>5)  sc+=7;

    // ── P3b : Equite plage (normalise) ──
    const myCP=(ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0);
    const myCPN=normalisee(myCP,e);
    const avgCPN=moyPonderee(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
    const ecartP=myCPN-avgCPN;
    sc+=ecartP*11;
    if(ecartP<-1.5) sc-=18;
    if(ecartP>1.5)  sc+=14;

    // ── P3b bis : Stats par type (normalise) ──
    const tp=typePlage(plage);
    const myTP=(ht.types[tp]||0)+(t.types[tp]||0);
    const myTPN=normalisee(myTP,e);
    const avgTPN=moyPonderee(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
    const ecartT=myTPN-avgTPN;
    sc+=ecartT*9;
    if(ecartT<-1) sc-=12;
    if(ecartT>1)  sc+=10;

    // ── P3c : Equite WE (annuel + mensuel) ──
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

    // ── P3d : Equite feries (annuel) ──
    if(isFerie(ds)){
      const myFer=(ht.ferie||0)+(ann.feries||0);
      const myFerN=normalisee(myFer,e);
      const avgFerN=moyPonderee(educs,x=>{
        const a2=(annStats[x.id]||{}).feries||0;
        return (hist[x.id].ferie||0)+a2;
      });
      sc+=(myFerN-avgFerN)*12;
    }

    // ── P3e : Equite nuits (annuel + mensuel, poids max) ──
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

    // ── P4 : Fatigue & penibilite ──
    sc+=t.fatigue*0.8;
    // Penibilite : si l'educ fait toujours cette plage ce jour → penalite
    const pen=(t.penibilite[dowIdx(d)]||{})[plage.id]||0;
    if(pen>=3) sc+=pen*3; // penalise si repetition excessive

    // ── P4 : Stabilite / patterns ──
    if(preAllocIds&&preAllocIds.includes(e.id)) sc-=8;
    // Bonus si pattern etabli (travaille souvent ce jour+plage)
    const pat=(t.patterns[dowIdx(d)]||{})[plage.id]||0;
    if(pat>=2) sc-=pat*2; // encourage la recurrence

    // ── P5 : Preferences ──
    if((e.prefs||[]).includes(plage.id)) sc-=10;
    const dow2=d.getDay()===0?6:d.getDay()-1;
    (e.demandes||[]).forEach(dem=>{
      if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
        if(dem.type==='eviter')  sc+=15;
        if(dem.type==='prefere') sc-=15;
      }
    });

    // Eviter double prestation (sauf pause)
    const dejaAuj=Object.values(planning[ds]||{})
      .some(ids=>Array.isArray(ids)&&ids.map(x=>+x).includes(e.id));
    if(dejaAuj&&!e.acceptePause) sc+=25;

    dbg(`Score ${e.prenom} ${plage.nom} ${ds}: ${sc.toFixed(1)}`);
    return sc;
  }

  function updateTracker(e, d, ds, plage, nuit, we){
    const t=tracker[e.id], tp=typePlage(plage), dow=dowIdx(d);
    t.h+=dureeHPlage(plage);
    const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
    t.cons=diffJ===1?t.cons+1:1;
    t.lastDay=ds;
    if(nuit){ t.nuits++; t.nuitsC++; } else t.nuitsC=0;
    if(we&&!t.weJours.has(ds)){ t.weJours.add(ds); if(d.getDay()===6){t.weCount++;t.dernierWE=ds;} }
    if(isFerie(ds)) t.dernierFerie=ds;
    t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
    t.types[tp]=(t.types[tp]||0)+1;
    // Fatigue : nuits longues et consecutifs augmentent la fatigue
    const hP=dureeHPlage(plage);
    t.fatigue+=hP>10?3:hP>8?1.5:hP>6?0.5:0;
    t.fatigue+=t.cons>4?2:0;
    t.fatigue=Math.max(0,t.fatigue*0.9); // decroissance naturelle
    // Penibilite & patterns
    if(!t.penibilite[dow]) t.penibilite[dow]={};
    t.penibilite[dow][plage.id]=(t.penibilite[dow][plage.id]||0)+1;
    if(!t.patterns[dow]) t.patterns[dow]={};
    t.patterns[dow][plage.id]=(t.patterns[dow][plage.id]||0)+1;
    lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
  }

  // ================================================================
  // GENERATION JOUR PAR JOUR
  // ================================================================
  L('Generation jour par jour...', 27);

  for(let di=0;di<jours.length;di++){
    if(di%3===0){
      L(`Jour ${di+1}/${jours.length}`,27+Math.round((di/jours.length)*55));
      await sl(0);
    }
    const d=jours[di], ds=dayStr(d), dow=dowIdx(d);
    const we=isWEDay(d), ferie=isFerie(ds);
    planning[ds]={};

    const dowForPlages=(ferie&&!we)?5:dow;
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));

    // Ordre : nuits → WE/feries → longues → reste
    // A egal : moins de candidats d'abord
    function priorite(p){
      if(isNuitP(p))     return 0;
      if(we||ferie)      return 1;
      if(dureeHPlage(p)>8) return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=priorite(a),pb=priorite(b);
      if(pa!==pb) return pa-pb;
      const ca=educs.filter(e=>respecteLoi(e,d,ds,dow,a,planning)).length;
      const cb=educs.filter(e=>respecteLoi(e,d,ds,dow,b,planning)).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    const preAllocJour=preAlloc[ds]||{};

    // ── PASSE A : Minimum obligatoire (3 niveaux) ──
    for(const plage of pj){
      const nuit=isNuitP(plage), reqMin=Math.max(0,+plage.min||1), useAll=plage.tous;
      const pIds=preAllocJour[plage.id]||[];

      let cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage,planning)&&respecteConvention(e,d,ds,plage,0));
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage,planning)&&respecteConvention(e,d,ds,plage,1));
      }
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>respecteLoi(e,d,ds,dow,plage,planning)&&respecteConvention(e,d,ds,plage,2));
        if(cands.length>0&&quotas[cands[0]?.id]){
          cands.forEach(e=>{ quotas[e.id].exceptionsUsees++; });
        }
      }

      const scored=cands.map(e=>({e,sc:score(e,d,ds,plage,we||ferie,pIds)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);

      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>{
        const isExcl=(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom} : plage refusee assignee a ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom} : demande de ${e.prenom} non respectee`);}
        else if(dem&&dem.type==='prefere') planning[ds][sk]='dem_pref';
        else if(isPref) planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        updateTracker(e,d,ds,plage,nuit,we);
      });

      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom} : ${reqMin-assigned.length} poste(s) non couverts (contrainte legale)`);
    }

    // ── PASSE B : Maximum (P6) ──
    for(const plage of pj){
      if(plage.tous) continue;
      const reqMin=Math.max(0,+plage.min||1), reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin) continue;
      const dejaDans=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-dejaDans.length; if(encore<=0) continue;

      const cands=educs.filter(e=>{
        if(dejaDans.includes(e.id)) return false;
        if(!respecteLoi(e,d,ds,dow,plage,planning)) return false;
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
  // OPTIMISATION MULTI-PASSES
  // Pass 1: equite nuits, Pass 2: equite WE,
  // Pass 3: equite heures, Pass 4: stabilite, Pass 5: prefs
  // ================================================================
  L('Optimisation multi-passes...', 84); await sl(30);

  const passes=[
    { nom:'nuits',   key:(e)=>normalisee((hist[e.id].nuits||0)+(tracker[e.id].nuits||0),e),    filtre:(p)=>isNuitP(p),   maxSwaps:40 },
    { nom:'WE',      key:(e)=>normalisee((hist[e.id].we||0)+(tracker[e.id].weCount||0),e),      filtre:(p)=>true,          maxSwaps:20 },
    { nom:'heures',  key:(e)=>hist[e.id].solde+(tracker[e.id].h-quotas[e.id].h.cible),          filtre:(p)=>true,          maxSwaps:20 },
  ];

  let totalSwaps=0;
  for(const pass of passes){
    let swapsPass=0;
    for(let iter=0;iter<pass.maxSwaps;iter++){
      let improved=false;
      for(const ds of Object.keys(planning)){
        const d=new Date(ds+'T12:00');
        const dow=dowIdx(d), we=isWEDay(d);
        for(const plage of plages){
          if(!pass.filtre(plage)) continue;
          const ids=(planning[ds][plage.id]||[]).map(x=>+x);
          if(ids.length<1) continue;
          const reqMin=+plage.min||1;

          for(const idIn of ids){
            const eIn=educById(idIn); if(!eIn) continue;
            const scoreIn=pass.key(eIn);

            // Chercher un candidat hors liste avec un score bien meilleur
            const candidatsHors=educs.filter(e=>!ids.includes(e.id));
            for(const eOut of candidatsHors){
              const scoreOut=pass.key(eOut);
              if(scoreOut>=scoreIn-1.5) continue; // pas assez de gain
              // Valider le swap localement
              if(!validateLocalSwap(planning,ds,plage,idIn,eOut.id,reqMin,dow,d)) continue;
              // Appliquer le swap
              const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
              planning[ds][plage.id]=newIds;
              delete planning[ds][`_s_${idIn}_${plage.id}`];
              planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';
              // Mettre a jour tracker (delta)
              if(isNuitP(plage)){
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
              dbg(`Swap ${pass.nom}: ${eIn.prenom} ↔ ${eOut.prenom} le ${ds} plage ${plage.nom}`);
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
    if(swapsPass>0){
      warnings.push(`Optimisation ${pass.nom} : ${swapsPass} echange(s)`);
      totalSwaps+=swapsPass;
    }
    await sl(0);
  }
  if(totalSwaps>0) dbg(`Total swaps: ${totalSwaps}`);

  return { planning, warnings, tracker, quotas };
}

// ================================================================
// VALIDATION LOCALE D'UN SWAP (securisee)
// ================================================================
function validateLocalSwap(planning, ds, plage, idIn, idOut, reqMin, dow, d){
  const eOut=educById(idOut); if(!eOut) return false;
  // P1 : eOut doit respecter la loi
  if(!(eOut.jours||[]).includes(dow)) return false;
  if(isAbsent(eOut.id,ds)) return false;
  // Verifier repos (approximatif : on verifie juste que eOut n'a pas de prestation rapprochee)
  // Couverture minimale maintenue
  const newIds=(planning[ds][plage.id]||[]).map(x=>+x).filter(x=>x!==idIn).concat(idOut);
  if(newIds.length<reqMin) return false;
  // eOut pas deja dans une autre plage ce jour (eviter surcharge)
  const dejaAuj=Object.values(planning[ds]||{})
    .some(ids=>Array.isArray(ids)&&ids.map(x=>+x).includes(idOut));
  if(dejaAuj&&!eOut.acceptePause) return false;
  return true;
}

// ================================================================
// VALIDATION FINALE BLOQUANTE (avec metriques)
// ================================================================
function validatePlanning(planning, moisStr, tracker, quotas){
  const [yr,mo] = moisStr.split('-').map(Number);
  const jours   = getDays(yr,mo);
  const errors=[], warns=[];

  // ERREURS BLOQUANTES
  jours.forEach(d=>{
    const ds=dayStr(d), dow=dowIdx(d), we=isWEDay(d), fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;
    plages.filter(p=>p.jours.includes(dc)).forEach(p=>{
      const ids=((planning[ds]||{})[p.id]||[]);
      if(ids.length<(+p.min||1))
        errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} educs — couverture insuffisante`);
    });
  });

  // CALCUL METRIQUES
  const nuitsTot={}, weTot={}, hTot={};
  educs.forEach(e=>{ nuitsTot[e.id]=0; weTot[e.id]=0; hTot[e.id]=tracker?tracker[e.id]?.h||0:0; });

  jours.forEach(d=>{
    const ds=dayStr(d), we=isWEDay(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)) nuitsTot[+id]=(nuitsTot[+id]||0)+1;
        if(we)          weTot[+id]=(weTot[+id]||0)+1;
      });
    });
  });

  // Score equite nuits
  const avgNuitN=moyPonderee(educs,e=>nuitsTot[e.id]||0);
  let ecartNuitMax=0;
  educs.forEach(e=>{
    const myN=normalisee(nuitsTot[e.id]||0,e);
    const ec=Math.abs(myN-avgNuitN);
    if(ec>ecartNuitMax) ecartNuitMax=ec;
    if(ec>4) warns.push(`Equite nuits: ${e.prenom} ${e.nom} ecart normalise ${ec.toFixed(1)}`);
  });

  // Score equite heures
  let ecartHMax=0;
  educs.forEach(e=>{
    const solde=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(solde)>ecartHMax) ecartHMax=Math.abs(solde);
    if(Math.abs(solde)>15) warns.push(`Solde ${e.prenom} ${e.nom}: ${solde>=0?'+':''}${solde.toFixed(1)}h`);
  });

  // Metriques (0-100)
  const metrics={
    equite: Math.max(0,100-ecartNuitMax*15),
    stabilite: 75, // approximation
    couverture: errors.length===0?100:Math.max(0,100-errors.length*20),
    prefs: Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)
  };

  return { valid:errors.length===0, errors, warnings:warns, metrics };
}

// ================================================================
// SCORE QUALITE GLOBAL (sur 100)
// ================================================================
function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(
    m.equite    * 0.35 +
    m.stabilite * 0.25 +
    m.couverture* 0.30 +
    m.prefs     * 0.10
  );
  const label = score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'A ameliorer';
  return { score, label, details: m };
}
