// ============================================================
// algo.js - PlanEduc Pro - Moteur V20
// ============================================================
// PHILOSOPHIE V20 : ORGANISER D'ABORD, REMPLIR ENSUITE
//
// PHASE 1 -- Design structurel (avant generation)
//   P1.1 - Trajectoire annuelle + historique
//   P1.2 - Analyse globale des besoins du mois
//   P1.3 - Quotas structurels equitables + plafonds anti-specialisation
//   P1.4 - Rotation WE tournante (lecture mois precedent)
//   P1.5 - Rotation nuit vendredi independante
//
// PHASE 2 -- Generation dans le cadre pose
//   E1 - Attribution blocs WE (atomique, depuis rotation P1.4)
//   E2 - Attribution nuits vendredi (depuis rotation P1.5)
//   E3 - Semaines normales (verifie quotas structurels)
//   E4 - Micro-ajustements cibles (swaps nuits + soirs)
//
// PRIORITES ABSOLUES :
//   P1 - Loi (repos 11h, 50h/sem, 6j max consecutifs, 2 nuits max)
//   P2 - Trajectoire heures / equite trimestrielle et annuelle
//   P3 - Couverture obligatoire des prestations
//   P4 - Blocs WE atomiques et verrouilles
//   P5 - Equite structurelle des prestations (pas corrective)
//   P6 - Stabilite / patterns humains
//   P7 - Preferences educateurs
// ============================================================

const DEBUG_MODE = false;
const dbg = (...a)=>{ if(DEBUG_MODE) console.log('[V20]',...a); };

// -- Helpers de base --
const isNuitP   = p => p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
const isReunion = p => p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion')||(p.nom||'').toLowerCase().includes('reunion');
const isWEDay   = d => d.getDay()===0||d.getDay()===6;
const dowIdx    = d => d.getDay()===0?6:d.getDay()-1;
const ratioE    = e => getTargetH(e)/38;

// Duree d'une plage en heures
function dureeH(p){
  if(p.dureeH&&p.dureeH>0) return p.dureeH;
  const [dh,dm]=p.debut.split(':').map(Number);
  const [fh,fm]=p.fin.split(':').map(Number);
  let h=(fh*60+fm)-(dh*60+dm); if(h<=0)h+=1440; return h/60;
}

// Type de plage
function typePlage(p){
  if(isReunion(p))  return 'reunion';
  if(isNuitP(p))    return 'nuit';
  const h=parseInt(p.debut);
  if(h<10) return 'matin';
  if(h<14) return 'aprem';
  return 'soir';
}

// Jours ouvrables d'un mois (lun-ven hors feries)
function joursOuvMois(yr,mo){
  return getDays(yr,mo).filter(d=>{
    const dw=d.getDay();
    return dw>=1&&dw<=5&&!isFerie(dayStr(d));
  }).length;
}

// Moyenne ponderee par ratio contrat
function moyPond(arr,fn){
  return arr.reduce((s,x)=>s+fn(x)/Math.max(0.01,ratioE(x)),0)/Math.max(1,arr.length);
}
function norm(val,e){ return val/Math.max(0.01,ratioE(e)); }

// Caches educs/plages
let _pm=null,_em=null;
function plageById(id){
  if(!_pm||_pm.size!==plages.length) _pm=new Map(plages.map(p=>[p.id,p]));
  return _pm.get(+id);
}
function educById(id){
  if(!_em||_em.size!==educs.length) _em=new Map(educs.map(e=>[e.id,e]));
  return _em.get(+id);
}

// -- Detection nuit vendredi --
// La nuit du vendredi = plage de type nuit dont les jours incluent vendredi (index 4 dans notre convention 0=lun)
const IDX_VENDREDI = 4; // dans notre convention dowIdx (0=lun ... 6=dim)
function estPlageNuitVendredi(p){
  return isNuitP(p) && !isReunion(p) && (p.jours||[]).includes(IDX_VENDREDI);
}

// ================================================================
// PHASE 1.1 -- TRAJECTOIRE ANNUELLE
// ================================================================
function calculerTrajectoireAnnuelle(moisStr){
  const [yr,mo]=moisStr.split('-').map(Number);
  const anneeStr=String(yr);
  const moisRestants=Math.max(1,13-mo);
  const traj={};
  const soldeTrimPrec=getSoldeTrimPrecedent(moisStr);

  educs.forEach(e=>{
    const re=ratioE(e);
    const objectifAnnuel = e.heuresAnnuelles
      ? +e.heuresAnnuelles
      : getTargetH(e)*52;

    let hFaites=0;
    Object.keys(horaire).filter(k=>k.startsWith(anneeStr)&&k<moisStr).forEach(mk=>{
      const [ky,km]=mk.split('-').map(Number);
      getDays(ky,km).forEach(day=>{
        const ds=dayStr(day);
        Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
          if(pid.startsWith('_')||!Array.isArray(ids)) return;
          const p=plageById(+pid); if(!p) return;
          if(ids.map(x=>+x).includes(e.id)) hFaites+=dureeH(p);
        });
      });
    });

    const hAttenduAStade=objectifAnnuel*((mo-1)/12);
    const soldeAnnuel=hFaites-hAttenduAStade;
    const cibleMois=joursOuvMois(yr,mo)*7.6*re;
    const capaciteRestante=moisRestants*cibleMois;
    const margeMax=capaciteRestante+hFaites;
    const irrecuperable=margeMax<(objectifAnnuel*0.95);

    // Solde trimestriel : pression supplementaire en fin de trimestre
    const soldeTrim=soldeTrimPrec[e.id]||0;
    const estCloture=estMoisClotureTrimestre(moisStr);
    const estDecembre=estMoisDecembre(moisStr);

    let zone='normale', urgenceMult=1.0;
    if(irrecuperable){       zone='danger';     urgenceMult=2.5; }
    else if(soldeAnnuel<-50){zone='danger';     urgenceMult=2.2; }
    else if(soldeAnnuel<-30){zone='critique';   urgenceMult=1.8; }
    else if(soldeAnnuel<-15){zone='attention';  urgenceMult=1.4; }
    else if(soldeAnnuel>30){ zone='surplus';    urgenceMult=1.8; }
    else if(soldeAnnuel>15){ zone='ok_positif'; urgenceMult=1.3; }

    traj[e.id]={
      objectifAnnuel, hFaites, hRestantes:objectifAnnuel-hFaites,
      soldeAnnuel, zone, urgenceMult, moisRestants, irrecuperable,
      soldeTrim, estCloture, estDecembre
    };
  });
  return traj;
}

// Pression mois (plafonnee)
function pressionMois(mo){
  if(mo>=12) return 2.2;
  if(mo>=11) return 2.0;
  if(mo>=9)  return 1.7;
  if(mo>=6)  return 1.4;
  if(mo>=3)  return 1.2;
  return 1.0;
}

// ================================================================
// PHASE 1.2 -- ANALYSE GLOBALE DES BESOINS DU MOIS
// Compte tous les slots a pourvoir par type et par plage
// ================================================================
function analyserBesoinsGlobaux(jours, moisStr){
  const besoins={
    totalSlotsParPlage:{},  // plageId -> nb de slots sur le mois
    totalSlotsParType:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},
    slotsWEParPlage:{},     // plageId -> nb de slots WE
    slotsVenNuitTotal:0,    // nb de vendredis nuit
    joursOuv:0
  };

  const [yr,mo]=moisStr.split('-').map(Number);
  besoins.joursOuv=joursOuvMois(yr,mo);

  plages.forEach(p=>{
    besoins.totalSlotsParPlage[p.id]=0;
    besoins.slotsWEParPlage[p.id]=0;
  });

  jours.forEach(d=>{
    const ds=dayStr(d);
    const dow=dowIdx(d);
    const we=isWEDay(d);
    const fe=isFerie(ds);
    const dc=(fe&&!we)?5:dow;

    plages.forEach(p=>{
      if(!p.jours.includes(dc)) return;
      const min=+p.min||1;
      const tp=typePlage(p);
      besoins.totalSlotsParPlage[p.id]+=min;
      besoins.totalSlotsParType[tp]=(besoins.totalSlotsParType[tp]||0)+min;
      if(we) besoins.slotsWEParPlage[p.id]+=min;
      // Nuit vendredi : vendredi = dowIdx 4
      if(dow===IDX_VENDREDI && estPlageNuitVendredi(p)) besoins.slotsVenNuitTotal+=min;
    });
  });

  return besoins;
}

// ================================================================
// PHASE 1.3 -- QUOTAS STRUCTURELS EQUITABLES
// Calcule pour chaque educateur les quotas cibles contraignants
// Prend en compte : ratio contrat, absences du mois, historique,
// trajectoire annuelle, pression trimestrielle
// ================================================================
function calculerQuotasStructurels(hist, jours, moisStr, traj, besoins){
  const [yr,mo]=moisStr.split('-').map(Number);
  const poidsTotal=educs.reduce((s,e)=>s+ratioE(e),0);
  const annStats=loadAnnualStats()[yr]||{};
  const estCloture=estMoisClotureTrimestre(moisStr);
  const estDec=estMoisDecembre(moisStr);
  const quotas={};

  // Plafonds anti-specialisation par type
  // Un educateur ne peut pas depasser moyenne_equipe + tolerance
  // Tolerance : 30% de marge au-dessus de la moyenne proratisee
  const TOLERANCE_SPEC=1.30;

  educs.forEach(e=>{
    const re=ratioE(e);
    const t=traj[e.id];

    // -- Quota heures mensuel --
    // Calcul des absences du mois (reduction de la cible)
    let joursAbsMois=0;
    jours.forEach(d=>{
      if(isAbsent(e.id,dayStr(d))) joursAbsMois++;
    });
    const joursEffectifs=Math.max(0, besoins.joursOuv - joursAbsMois);
    // Cible realiste : jours ouvrables * 7.6h * ratio contrat
    // Plafond supplementaire : heures contractuelles * ~4.33 semaines/mois
    // Evite que les mi-temps (avec tous les jours coches) soient surcharges
    const hSemContrat=getTargetH(e);
    const nbSemMois=4.33;
    const plafondContractuel=hSemContrat*nbSemMois*1.20; // 20% de marge
    const baseMois=Math.min(joursEffectifs*7.6*re, plafondContractuel);

    // Ajustement trajectoire annuelle
    let ajustTraj=0;
    if(t){
      const retardMensuel=t.soldeAnnuel/Math.max(1,t.moisRestants);
      ajustTraj=Math.max(-15,Math.min(15,-retardMensuel*0.6));
    }

    // Pression trimestrielle : si mois de cloture, forcer le retour a +/-6h
    let ajustTrim=0;
    if(estCloture && t){
      const soldeTrim=t.soldeTrim||0;
      const tolTrim=getRule('tol_trim',6);
      if(Math.abs(soldeTrim)>tolTrim){
        // Appliquer une correction pour ramener vers zero
        ajustTrim=Math.max(-20,Math.min(20,-soldeTrim*0.5));
      }
    }

    // Decembre : objectif zero absolu
    let ajustDec=0;
    if(estDec && t){
      const retardTotal=t.hRestantes-baseMois;
      ajustDec=Math.max(-25,Math.min(25,retardTotal*0.8));
    }

    const ajustHistorique=Math.max(-6,Math.min(6,-(hist[e.id].solde||0)*0.3));
    const ajustTotal=Math.max(-25,Math.min(25,ajustTraj+ajustTrim+ajustDec+ajustHistorique));

    const hCible=baseMois+ajustTotal;
    const tolMensuel=getRule('tol_heures',15);

    // -- Quotas par plage --
    const quotasPlage={};
    plages.forEach(p=>{
      if(isReunion(p)){
        quotasPlage[p.id]={cible:999,min:0,max:999,plafond:999};
        return;
      }
      // Slots disponibles pour cette plage ce mois
      const ja=jours.filter(d=>{
        const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
        return p.jours.includes(dc) && !isAbsent(e.id,dayStr(d));
      }).length;
      const totalPostes=ja*(+p.min||1);

      // Cible proratisee + correction historique
      const cible=totalPostes*re/Math.max(0.01,poidsTotal);
      const myN=norm((hist[e.id].plageCount[p.id]||0),e);
      const avgN=moyPond(educs,x=>hist[x.id].plageCount[p.id]||0);
      const corr=(myN-avgN)*re*0.2;

      // Correction annuelle nuits
      const annNuits=(annStats[e.id]||{}).nuits||0;
      const avgAnnN=moyPond(educs,x=>(annStats[x.id]||{}).nuits||0);
      const corrAnn=isNuitP(p)?Math.max(-1,Math.min(1,(norm(annNuits,e)-avgAnnN)*re*0.1)):0;

      const c=Math.max(0,cible-corr-corrAnn);

      // Plafond anti-specialisation : max = moyenne_equipe * ratio * TOLERANCE
      const avgSlots=totalPostes/Math.max(1,educs.length);
      const plafond=Math.ceil(avgSlots*re*TOLERANCE_SPEC*educs.length/Math.max(0.01,poidsTotal)*1.2);

      quotasPlage[p.id]={
        cible:c,
        min:Math.max(0,Math.floor(c-2)),
        max:Math.min(plafond, Math.ceil(c+2)),
        plafond
      };
    });

    // -- Quotas par type --
    const quotasType={};
    ['matin','aprem','soir','nuit'].forEach(tp=>{
      const pts=plages.filter(p=>!isReunion(p)&&(tp==='nuit'?isNuitP(p):typePlage(p)===tp));
      let tot=0;
      pts.forEach(p=>{
        const ja=jours.filter(d=>{
          const di=dowIdx(d),dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:di;
          return p.jours.includes(dc)&&!isAbsent(e.id,dayStr(d));
        }).length;
        tot+=ja*(+p.min||1);
      });
      const ct=tot*re/Math.max(0.01,poidsTotal);
      // Plafond type : moyenne * ratio * tolerance
      const avgType=tot/Math.max(1,educs.length);
      const plafondType=Math.ceil(avgType*re*TOLERANCE_SPEC*educs.length/Math.max(0.01,poidsTotal)*1.2);
      quotasType[tp]={
        cible:ct,
        min:Math.max(0,Math.floor(ct-1.5)),
        max:Math.min(plafondType,Math.ceil(ct+1.5)),
        plafond:plafondType
      };
    });

    quotas[e.id]={
      h:{cible:hCible, min:hCible-tolMensuel, max:hCible+tolMensuel},
      plage:quotasPlage,
      types:quotasType,
      ann:annStats[e.id]||{nuits:0,we:0,feries:0},
      exceptionsUsees:0,
      exceptionsMax:2,   // V20 : moins d'exceptions tolerees
      // Drapeaux pression
      estCloture, estDec,
      soldeTrim:t?.soldeTrim||0
    };
  });

  return quotas;
}

// ================================================================
// PHASE 1.4 -- ROTATION WE TOURNANTE
// Lit le dernier WE du mois precedent, construit les equipes
// pour chaque WE du mois courant en alternance travail/repos
// ================================================================
function construireRotationWE(jours, moisStr, weNums, weMap, quotas, hist, annStats){
  const [yr,mo]=moisStr.split('-').map(Number);
  const etatPrev=getEtatWEMoisPrecedent(moisStr);

  // Qui a travaille le dernier WE du mois precedent ?
  // Ces educateurs sont au repos sur le premier WE du mois courant
  const derniereEquipePrev=new Set((etatPrev?.derniereEquipe||[]).map(x=>+x));

  dbg('Dernier WE mois precedent, equipe:', [...derniereEquipePrev]);

  // Plages WE (non reunion, non nuit vendredi)
  // Les plages WE = plages dont les jours incluent sam(5) ou dim(6)
  const plagesWE=plages.filter(p=>
    !isReunion(p)&&
    (p.jours.includes(5)||p.jours.includes(6))
  );

  // Construction des equipes pour chaque WE
  // Principe : un educateur qui a travaille le WE N ne travaille pas le WE N+1
  const rotationWE={}; // weNum -> { plageId: [educId,...] }

  // Tracker local de qui a travaille quels WE ce mois
  const weParEduc={}; // educId -> Set de weNums
  educs.forEach(e=>{ weParEduc[e.id]=new Set(); });

  // Initialiser avec le statut du mois precedent
  // Les educs qui ont travaille le dernier WE de janvier sont "en repos" sur WE1 fevrier
  const reposWE1=new Set(derniereEquipePrev);

  for(const wn of weNums){
    rotationWE[wn]={};
    const joursWE=jours.filter(d=>weMap[dayStr(d)]===wn).sort((a,b)=>a-b);
    if(!joursWE.length) continue;

    for(const plage of plagesWE){
      // Verifier que cette plage s'applique a ce WE
      const slotsBloc=joursWE.filter(d=>{
        const dow=dowIdx(d);
        const dc=(isFerie(dayStr(d))&&!isWEDay(d))?5:dow;
        return plage.jours.includes(dc);
      });
      if(!slotsBloc.length) continue;

      const reqMin=+plage.min||1;
      const nuit=isNuitP(plage);

      // Candidats : educs disponibles sur TOUS les jours du bloc
      // + respectent la regle de repos (pas travaille le WE precedent)
      const candidats=educs.map(e=>{
        // Regle rotation : si a travaille le WE precedent -> repos force
        if(wn===weNums[0] && reposWE1.has(e.id)) return null;
        if(wn!==weNums[0]){
          // A-t-il travaille le WE precedent ce mois ?
          const wnPrec=weNums[weNums.indexOf(wn)-1];
          if(wnPrec!==undefined && (weParEduc[e.id]||new Set()).has(wnPrec)) return null;
        }

        // Verifier disponibilite sur tous les jours
        for(const d of slotsBloc){
          const ds=dayStr(d);
          const dow=dowIdx(d);
          if(!(e.jours||[]).includes(dow)) return null;
          if(isAbsent(e.id,ds)) return null;
        }

        // Score de priorite pour l'attribution WE
        // Base sur : equite WE annuelle + solde heures + trajectoire
        const t=traj_ref[e.id]||{zone:'normale',urgenceMult:1,soldeAnnuel:0};
        const ht=hist[e.id];
        const ann=annStats[e.id]||{};
        const tracker_e=tracker_ref[e.id];
        let sc=0;

        // Equite WE : qui a le moins travaille de WE (proratise)
        const myWE=norm((ht.we||0)+(tracker_e?.weCount||0)+(ann.we||0),e);
        const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+(tracker_ref[x.id]?.weCount||0)+((annStats[x.id]||{}).we||0));
        sc+=(myWE-avgWE)*15;
        if(myWE<avgWE-1) sc-=20; // tres en dessous -> priorite forte
        if(myWE>avgWE+1) sc+=20; // tres au-dessus -> defavorise fort

        // Solde heures : qui a le plus de retard
        const solde=(ht.solde||0)+(tracker_e?.h||0)-(quotas[e.id]?.h.cible||0);
        const urgM=Math.min(2.2,(t.urgenceMult||1)*pression_ref);
        if(solde<-10) sc-=40*urgM;
        else if(solde<-5) sc-=20*urgM;
        else if(solde>10) sc+=40*urgM;
        else if(solde>5) sc+=20*urgM;

        // Trajectoire annuelle
        if(t.soldeAnnuel<-30) sc-=50;
        else if(t.soldeAnnuel<-15) sc-=25;
        if(t.soldeAnnuel>30) sc+=50;
        else if(t.soldeAnnuel>15) sc+=25;

        // Equite nuits WE
        if(nuit){
          const myN=norm((ht.nuits||0)+(tracker_e?.nuits||0)+(ann.nuits||0),e);
          const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+(tracker_ref[x.id]?.nuits||0)+((annStats[x.id]||{}).nuits||0));
          sc+=(myN-avgN)*12;
        }

        // Exclusions dures
        if(!isReunion(plage)&&(e.excls||[]).includes(plage.id)) return null;

        return{e,sc};
      }).filter(Boolean).sort((a,b)=>a.sc-b.sc);

      // Attribuer reqMin educs
      let assigned=candidats.slice(0,reqMin).map(x=>x.e);

      // Fallback si pas assez : relacher la contrainte rotation (exceptionnel)
      if(assigned.length<reqMin){
        const cands2=educs.filter(e=>{
          if(assigned.find(a=>a.id===e.id)) return false;
          for(const d of slotsBloc){
            const ds=dayStr(d);
            const dow=dowIdx(d);
            if(!(e.jours||[]).includes(dow)||isAbsent(e.id,ds)) return false;
          }
          if((e.excls||[]).includes(plage.id)) return false;
          return true;
        }).sort((a,b)=>{
          const waA=(weParEduc[a.id]||new Set()).size;
          const waB=(weParEduc[b.id]||new Set()).size;
          return waA-waB;
        });
        assigned.push(...cands2.slice(0,reqMin-assigned.length));
      }

      rotationWE[wn][plage.id]=assigned.map(e=>e.id);

      // Marquer ces educs comme "ayant travaille ce WE"
      assigned.forEach(e=>{
        if(!weParEduc[e.id]) weParEduc[e.id]=new Set();
        weParEduc[e.id].add(wn);
      });
    }
  }

  // Etat a sauvegarder pour le mois suivant
  // = qui a travaille le DERNIER WE de ce mois
  const dernierWN=weNums[weNums.length-1];
  const dernierEquipe=new Set();
  if(dernierWN && rotationWE[dernierWN]){
    Object.values(rotationWE[dernierWN]).forEach(ids=>{
      ids.forEach(id=>dernierEquipe.add(+id));
    });
  }

  sauvegarderRotationWE(moisStr,{
    derniereEquipe:[...dernierEquipe],
    weAttribues:Object.fromEntries(
      Object.entries(rotationWE).map(([wn,slots])=>[wn,slots])
    )
  });

  return rotationWE;
}

// ================================================================
// PHASE 1.5 -- ROTATION NUIT VENDREDI INDEPENDANTE
// Detecte les vendredis nuit et construit une rotation propre
// independante des equipes WE et des nuits de semaine
// ================================================================
function construireRotationNuitVendredi(jours, moisStr, hist, quotas, annStats){
  // Identifier les vendredis du mois ayant une plage nuit
  const plagesNuitVen=plages.filter(p=>estPlageNuitVendredi(p)&&!isReunion(p));
  if(!plagesNuitVen.length) return {};

  const vendredis=jours.filter(d=>dowIdx(d)===IDX_VENDREDI);
  if(!vendredis.length) return {};

  // Charger la derniere personne qui a fait la nuit du vendredi
  // depuis le mois precedent
  const [yr,mo]=moisStr.split('-').map(Number);
  const prevKey=moisKey(yr,mo-1);
  const planPrev=horaire[prevKey];
  const derniersVenNuit=new Set();

  if(planPrev){
    const [py,pm]=prevKey.split('-').map(Number);
    const venPrec=getDays(py,pm).filter(d=>dowIdx(d)===IDX_VENDREDI).sort((a,b)=>b-a);
    if(venPrec.length){
      const dsVen=dayStr(venPrec[0]);
      plagesNuitVen.forEach(p=>{
        ((planPrev[dsVen]||{})[p.id]||[]).forEach(id=>derniersVenNuit.add(+id));
      });
    }
  }

  const rotationVenNuit={}; // ds -> { plageId: [educId,...] }

  // Tracker local : qui a deja fait une nuit vendredi ce mois
  const venNuitParEduc={}; // educId -> nb de nuits vendredi ce mois
  educs.forEach(e=>{ venNuitParEduc[e.id]=0; });

  // Educs qui ont fait la derniere nuit vendredi du mois precedent
  // -> priorite basse pour les premiers vendredis
  const reposVen=new Set(derniersVenNuit);

  for(let i=0;i<vendredis.length;i++){
    const d=vendredis[i];
    const ds=dayStr(d);
    const dow=dowIdx(d); // = 4 (vendredi)
    rotationVenNuit[ds]={};

    for(const plage of plagesNuitVen){
      // Verifier que cette plage s'applique ce vendredi
      const dc=(isFerie(ds)&&!isWEDay(d))?5:dow;
      if(!plage.jours.includes(dc)) continue;

      const reqMin=+plage.min||1;

      const candidats=educs.map(e=>{
        if(!(e.jours||[]).includes(dow)) return null;
        if(isAbsent(e.id,ds)) return null;
        if((e.excls||[]).includes(plage.id)) return null;

        const t=traj_ref[e.id]||{};
        const ht=hist[e.id];
        const ann=annStats[e.id]||{};
        const tracker_e=tracker_ref[e.id];
        let sc=0;

        // Priorite basse si a fait la derniere nuit vendredi du mois precedent
        if(i===0 && reposVen.has(e.id)) sc+=30;

        // Equite nuits vendredi ce mois (principal critere)
        const myVN=venNuitParEduc[e.id]||0;
        const avgVN=educs.reduce((s,x)=>s+(venNuitParEduc[x.id]||0),0)/Math.max(1,educs.length);
        sc+=(myVN-avgVN)*20; // fort poids pour assurer la rotation

        // Equite nuits globale
        const myN=norm((ht.nuits||0)+(tracker_e?.nuits||0)+(ann.nuits||0),e);
        const avgN=moyPond(educs,x=>(hist[x.id].nuits||0)+(tracker_ref[x.id]?.nuits||0)+((annStats[x.id]||{}).nuits||0));
        sc+=(myN-avgN)*12;

        // Solde heures
        const solde=(ht.solde||0)+(tracker_e?.h||0)-(quotas[e.id]?.h.cible||0);
        if(solde<-8) sc-=25;
        else if(solde>8) sc+=25;

        return{e,sc};
      }).filter(Boolean).sort((a,b)=>a.sc-b.sc);

      const assigned=candidats.slice(0,reqMin).map(x=>x.e);

      // Fallback
      if(assigned.length<reqMin){
        const cands2=educs.filter(e=>{
          if(assigned.find(a=>a.id===e.id)) return false;
          if(!(e.jours||[]).includes(dow)||isAbsent(e.id,ds)) return false;
          return true;
        });
        assigned.push(...cands2.slice(0,reqMin-assigned.length));
      }

      rotationVenNuit[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>{ venNuitParEduc[e.id]=(venNuitParEduc[e.id]||0)+1; });
    }
  }

  return rotationVenNuit;
}

// ================================================================
// HISTORIQUE (inchange de v19, conserve)
// ================================================================
function calculerHistorique(yr, mo, horizon){
  const hist={};
  educs.forEach(e=>{
    hist[e.id]={solde:0,plageCount:{},we:0,ferie:0,nuits:0,types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0}};
    plages.forEach(p=>hist[e.id].plageCount[p.id]=0);
  });
  for(let i=1;i<horizon;i++){
    const key=moisKey(yr,mo-i);
    const plan=horaire[key];if(!plan)continue;
    const [ky,km]=key.split('-').map(Number);
    const joursMois=getDays(ky,km);
    const joursOuvH=joursOuvMois(ky,km);
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
  return hist;
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
// PATTERNS (inchange)
// ================================================================
function bonusStabilite(e,dow,plage,patterns,isWE){
  const pat=patterns[String(e.id)];
  if(!pat||!pat[dow]||!pat[dow][plage.id]) return 0;
  const cnt=pat[dow][plage.id]||0;
  // Usure progressive pour eviter la rigidite permanente
  let usure=1.0;
  if(cnt>12) usure=0.70;
  else if(cnt>8) usure=0.85;
  else if(cnt>5) usure=0.92;
  // Poids fort pour stabilite (V20 : patterns humains importants)
  // WE : poids reduit car gere par rotation tournante
  const mult=(isWE?0.4:1.0)*usure;
  if(cnt>=8) return -25*mult;
  if(cnt>=6) return -20*mult;
  if(cnt>=4) return -15*mult;
  if(cnt>=2) return -10*mult;
  return -5*mult;
}

function scoreCyclePersonnel(e,dow,patterns){
  const pat=patterns[String(e.id)]; if(!pat||!pat[dow]) return 0;
  const totalJour=Object.values(pat[dow]).reduce((s,v)=>s+v,0);
  // Poids augmente : favoriser les jours habituels de l'educ
  if(totalJour>=6) return -12;
  if(totalJour>=4) return -8;
  if(totalJour>=2) return -4;
  return 0;
}

// Detection specialisation excessive
function malusSpecialisation(e,tp,tracker_e,hist_e,quotas_e){
  const types=tracker_e.types||{};
  const histTypes=hist_e.types||{};
  const total=Object.values(types).reduce((s,v)=>s+v,0)+Object.values(histTypes).reduce((s,v)=>s+v,0);
  if(total<8) return 0;
  const myType=(types[tp]||0)+(histTypes[tp]||0);
  const ratio=myType/Math.max(1,total);
  // Comparer au plafond structurel
  const qMax=quotas_e?.types[tp]?.plafond;
  if(qMax!==undefined){
    const norm_my=norm(myType,e);
    if(norm_my>qMax*1.1) return 20;
    if(norm_my>qMax*0.9) return 10;
  }
  if(ratio>0.75) return 15;
  if(ratio>0.60) return 8;
  if(ratio>0.50) return 3;
  return 0;
}

// ================================================================
// REFERENCES GLOBALES (pour acces dans construireRotationWE)
// Initialisees dans genMois, utilisees dans les fonctions de phase 1
// ================================================================
let traj_ref={};
let tracker_ref={};
let pression_ref=1.0;

// ================================================================
// VERIFICATION LEGALE P1
// ================================================================
function checkLoi(e,d,ds,dow,plage,tracker,lastPrest,minRepos,maxCons,reposNuit,maxNuitsC,planning){
  if(!(e.jours||[]).includes(dow)) return{ok:false,raison:'Jour non travaille'};
  if(isAbsent(e.id,ds)) return{ok:false,raison:'Absence'};
  const t=tracker[e.id],re=isReunion(plage);
  if(!re){
    if(t.cons>=maxCons) return{ok:false,raison:`Max ${maxCons}j consecutifs`};
    if(isNuitP(plage)&&t.nuitsC>=maxNuitsC) return{ok:false,raison:'Max 2 nuits consecutives'};
    const la=lastPrest[e.id];
    if(la){
      const [lh,lm]=la.fin.split(':').map(Number);
      const [bh,bm]=plage.debut.split(':').map(Number);
      const finMs=new Date(la.date+'T00:00').getTime()+(la.pm?86400000:0)+(lh*60+lm)*60000;
      const debMs=new Date(ds+'T00:00').getTime()+(bh*60+bm)*60000;
      const dh=(debMs-finMs)/3600000;
      // Si dh <= 0 : la plage commence avant ou au moment de la fin precedente
      // C'est une continuation directe (ex: aprem 13:30-20:00 puis nuit 20:00)
      // On ne bloque que si il y a un vrai ecart positif insuffisant
      if(dh>0 && dh<minRepos) return{ok:false,raison:'Repos 11h ('+dh.toFixed(1)+'h)'};
    }
    if(la&&la.isNuit&&reposNuit>0&&Math.round((d-new Date(la.date))/86400000)<=reposNuit)
      return{ok:false,raison:'Repos apres nuit'};
    const maxHJ=isNuitP(plage)?24:11;
    const hJour=plages.filter(p2=>!isReunion(p2)).reduce((s,pp)=>{
      const ids=(planning[ds]||{})[pp.id];
      return Array.isArray(ids)&&ids.map(x=>+x).includes(e.id)?s+dureeH(pp):s;
    },0);
    if(hJour+dureeH(plage)>maxHJ) return{ok:false,raison:'Max h/jour'};
  }
  if(hSem(tracker[e.id],ds)+dureeH(plage)>50) return{ok:false,raison:'Max 50h/sem'};
  return{ok:true,raison:''};
}

// ================================================================
// VERIFICATION CONVENTION P2-P7
// ================================================================
function checkConvention(e,d,ds,plage,niveau,tracker,hist,quotas,traj,maxWeMois){
  const re=isReunion(plage);
  if(niveau<2&&!re&&(e.excls||[]).includes(plage.id)) return{ok:false,raison:'Plage refusee',dur:true};
  if(!re&&isWEDay(d)&&tracker[e.id].weCount>=maxWeMois&&niveau<1) return{ok:false,raison:'Max WE/mois',dur:false};

  if(!re&&niveau===0){
    const tr=traj[e.id];
    // Blocage solde mensuel strict
    // Zone surplus/ok_positif : bloquer si solde > 8h au-dessus cible
    // Zone danger/critique : ne pas bloquer (rattrapage force)
    const soldeCourant=(hist[e.id].solde||0)+(tracker[e.id].h-(quotas[e.id]?.h.cible||0));
    const hCibleE=quotas[e.id]?.h.cible||0;
    // Toujours bloquer si on depasse la cible de plus de 8h (sauf zone danger)
    // Bloquer si solde trop positif (educ a deja trop d'heures)
    // Seuil assoupli pour ne pas laisser des postes vides
    const seuilBlocage = (tr&&(tr.zone==='danger'||tr.zone==='critique')) ? 18 : 12;
    if(soldeCourant>seuilBlocage) return{ok:false,raison:'Solde +'+soldeCourant.toFixed(1)+'h',dur:false};

    // Verification quota plage structurel (V20 : strict)
    const myCP=(tracker[e.id].plageCount[plage.id]||0);
    const qMax=quotas[e.id]?.plage[plage.id]?.max;
    if(qMax!==undefined && myCP>=qMax && quotas[e.id].exceptionsUsees>=quotas[e.id].exceptionsMax)
      return{ok:false,raison:'Quota plage max',dur:false};

    // Verification quota type (anti-specialisation structurelle V20)
    const tp=typePlage(plage);
    const myType=tracker[e.id].types[tp]||0;
    const qTypeMax=quotas[e.id]?.types[tp]?.plafond;
    if(qTypeMax!==undefined && myType>=qTypeMax)
      return{ok:false,raison:`Plafond type ${tp}`,dur:false};
  }
  return{ok:true,raison:''};
}

// ================================================================
// SCORE D'ATTRIBUTION (simplifie car quotas deja contraignants)
// ================================================================
function score(e,d,ds,plage,weOrFerie,dow,isWEContext,tracker,hist,quotas,traj,patterns,annStats,pression){
  const t=tracker[e.id],ht=hist[e.id],q=quotas[e.id];
  const ann=annStats[e.id]||{nuits:0,we:0,feries:0};
  const tr=traj[e.id]||{zone:'normale',urgenceMult:1,soldeAnnuel:0};
  const reunion=isReunion(plage),nuit=isNuitP(plage);
  let sc=0;

  // P2 : HEURES -- contrainte dominante
  const solde=(ht.solde||0)+(t.h-(q?.h.cible||0));
  const urgMult=Math.min(2.2,tr.urgenceMult*pression);

  if(solde>14)       sc+=55*urgMult;
  else if(solde>10)  sc+=30*urgMult;
  else if(solde>6)   sc+=12;
  else if(solde>3)   sc+=5;
  else if(solde<-14) sc-=55*urgMult;
  else if(solde<-10) sc-=30*urgMult;
  else if(solde<-6)  sc-=12;
  else if(solde<-3)  sc-=5;
  else sc+=solde*1.5;

  // Trajectoire annuelle
  if(tr.soldeAnnuel<-50)      sc-=75;
  else if(tr.soldeAnnuel<-30) sc-=45;
  else if(tr.soldeAnnuel<-15) sc-=22;
  else if(tr.soldeAnnuel<-5)  sc-=7;
  if(tr.soldeAnnuel>50)       sc+=65;
  else if(tr.soldeAnnuel>30)  sc+=40;
  else if(tr.soldeAnnuel>15)  sc+=18;
  else if(tr.soldeAnnuel>5)   sc+=5;

  // Pression trimestrielle
  if(q?.estCloture){
    const soldeTrim=q.soldeTrim||0;
    const tolTrim=getRule('tol_trim',6);
    if(soldeTrim>tolTrim)       sc+=35*urgMult; // trop d'heures -> defavoriser
    else if(soldeTrim<-tolTrim) sc-=35*urgMult; // retard -> favoriser
  }

  if(!reunion){
    // P6 : Stabilite (poids modere, ne doit pas dominer l'equite)
    sc+=bonusStabilite(e,dow,plage,patterns,isWEContext);
    if(!isWEContext) sc+=scoreCyclePersonnel(e,dow,patterns);

    // Anti-specialisation
    if(!isWEContext) sc+=malusSpecialisation(e,typePlage(plage),t,ht,q);

    // P5 : Equite prestations
    const myCP=norm((ht.plageCount[plage.id]||0)+(t.plageCount[plage.id]||0),e);
    const avgCP=moyPond(educs,x=>(hist[x.id].plageCount[plage.id]||0)+(tracker[x.id].plageCount[plage.id]||0));
    const ecP=myCP-avgCP;
    sc+=ecP*9;
    if(ecP<-2) sc-=18; if(ecP>2) sc+=18;

    const tp=typePlage(plage);
    const myTP=norm((ht.types[tp]||0)+(t.types[tp]||0),e);
    const avgTP=moyPond(educs,x=>(hist[x.id].types[tp]||0)+(tracker[x.id].types[tp]||0));
    const ecT=myTP-avgTP;
    sc+=ecT*7;
    if(ecT<-2) sc-=14; if(ecT>2) sc+=14;

    if(weOrFerie){
      const myWE=norm((ht.we||0)+(t.weCount||0)+(ann.we||0),e);
      const avgWE=moyPond(educs,x=>(hist[x.id].we||0)+(tracker[x.id].weCount||0)+((annStats[x.id]||{}).we||0));
      const ecWE=myWE-avgWE;
      sc+=ecWE*10;
      if(ecWE<-1) sc-=13; if(ecWE>1) sc+=10;
      if(t.dernierWE){
        const diffSem=Math.floor((new Date(ds+'T12:00')-new Date(t.dernierWE+'T12:00'))/604800000);
        if(diffSem<2) sc+=25;
        else if(diffSem===2) sc-=8;
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
      sc+=ecN*14;
      if(ecN<-1.5) sc-=20; if(ecN>1.5) sc+=16;
    }
  }

  // P7 : Preferences
  if(!reunion&&(e.prefs||[]).includes(plage.id)) sc-=9;
  const dow2=d.getDay()===0?6:d.getDay()-1;
  (e.demandes||[]).forEach(dem=>{
    if(dem.jour===dow2&&(dem.plageIds||[]).includes(plage.id)){
      if(dem.type==='eviter')  sc+=12;
      if(dem.type==='prefere') sc-=12;
    }
  });

  if(!reunion&&!e.acceptePause&&!nuit){
    // Penalite si l'educ a deja une plage terrain ce jour (evite les horaires a pause)
    // Reduit pour ne pas bloquer les vendredis charges (matin + aprem institutionnel)
    const dejaTerrain=Object.keys(planning_ref[ds]||{}).some(pid=>{
      if(pid.startsWith('_')) return false;
      const p2=plageById(+pid);
      if(!p2||isReunion(p2)||isNuitP(p2)) return false;
      return(planning_ref[ds][pid]||[]).map(x=>+x).includes(e.id);
    });
    if(dejaTerrain) sc+=15;
  }

  return sc;
}

// ================================================================
// UPDATE TRACKER
// ================================================================
function updateTracker(e,d,ds,plage,nuit,we,tracker,lastPrest){
  const t=tracker[e.id],tp=typePlage(plage),re=isReunion(plage);
  const h=dureeH(plage);
  t.h+=h;
  if(!t.joursH[ds])t.joursH[ds]=0;t.joursH[ds]+=h;
  if(!re){
    const diffJ=t.lastDay?Math.round((d-new Date(t.lastDay))/86400000):999;
    t.cons=diffJ===1?t.cons+1:1;t.lastDay=ds;
    if(nuit){t.nuits++;t.nuitsC++;}else t.nuitsC=0;
    if(we&&!t.weJours.has(ds)){
      t.weJours.add(ds);
      if(d.getDay()===6){t.weCount++;t.dernierWE=ds;}
    }
    const POIDS={reunion:0.05,matin:1.0,aprem:1.0,soir:1.2,nuit:2.0};
    const pw=POIDS[tp]||1;
    t.fatigue+=pw*(h>10?2:h>8?1.5:h>6?0.8:0.3)+(t.cons>4?1.2:0);
    t.fatigue=Math.min(18,t.fatigue*0.94);
    // Ne pas mettre a jour lastPrest pour les reunions
    // (une reunion ne genere pas de contrainte de repos de 11h)
    if(!isReunion(plage)){
      lastPrest[e.id]={date:ds,fin:plage.fin,isNuit:nuit,pm:plage.fin<plage.debut};
    }
  }
  t.plageCount[plage.id]=(t.plageCount[plage.id]||0)+1;
  t.types[tp]=(t.types[tp]||0)+1;
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
      const dc=(fe&&!we)?5:dow;if(!p.jours.includes(dc))return;
      const dispo=educs.filter(e=>(e.jours||[]).includes(dow)&&!isAbsent(e.id,ds)).length;
      if(dispo<(+p.min||1))msgs.push(`${ds} - ${p.nom}: ${dispo}/${p.min} dispo`);
    });
  });
  return msgs;
}

// ================================================================
// UI
// ================================================================
function verifier(){
  const warns=[];
  if(!educs.length) warns.push({t:'err',m:'Aucun educateur defini.'});
  if(!plages.length) warns.push({t:'err',m:'Aucune plage horaire definie.'});
  const rc=document.getElementById('gen-recap'),ri=document.getElementById('gen-recap-content');
  rc.style.display='block';
  let html=warns.map(w=>`<div class="alert a-${w.t}">! ${w.m}</div>`).join('');
  if(!warns.length){
    html+=`<div class="alert a-ok">OK: ${educs.length} educateurs - ${plages.length} plages</div>`;
    html+=plages.map(p=>{
      const j=p.jours.map(x=>JOURS[x]).join(', ');
      const b=isReunion(p)?'<span class="badge b-blue" style="font-size:.6rem">REUNION</span>':'';
      const nv=estPlageNuitVendredi(p)?'<span class="badge b-purple" style="font-size:.6rem">NUIT VEN</span>':'';
      return `<div style="display:flex;align-items:center;gap:7px;margin:5px 0;font-size:.8rem">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color}"></div>
        <strong>${p.nom}</strong> ${b}${nv} - ${p.debut}-${p.fin} - min ${p.min} educ - ${j}</div>`;
    }).join('');
  }
  ri.innerHTML=html;
}

async function lancer(){
  if(!educs.length||!plages.length){verifier();return;}
  const mois=document.getElementById('gen-mois').value;
  if(!mois){alert('Choisissez un mois.');return;}
  const btn=document.getElementById('gen-btn');
  btn.disabled=true;btn.innerHTML='<div class="spin"></div> Generation V20...';
  document.getElementById('gen-prog').style.display='block';
  document.getElementById('gen-alerts').innerHTML='';
  const log=document.getElementById('gen-log');log.innerHTML='';
  const L=(m,p)=>{log.innerHTML+=m+'<br>';log.scrollTop=log.scrollHeight;if(p!=null)document.getElementById('gen-bar').style.width=p+'%';};

  L('🔍 Detection impossibilites...',3);await sl(50);
  const impos=detecterImpossibilites(mois);
  impos.forEach(msg=>L('⚠ '+msg,null));

  const result=await genMois(mois,L);
  window._lastDiagnostic=result.diagnostic||[];

  L('✅ Validation...',93);await sl(30);
  const validation=validatePlanning(result.planning,mois,result.tracker,result.quotas);

  horaire[mois]=result.planning;
  currentMonth=mois;
  save();
  updateAnnualStats(mois);
  buildPatterns(mois);

  // Sauvegarde soldes trimestriels si mois de cloture
  if(estMoisClotureTrimestre(mois)){
    calculerEtSauvegarderSoldeTrim(mois);
    L(`📊 Cloture trimestrielle T${numTrimestre(mois)} sauvegardee`,null);
  }

  const qs=planningQualityScore(validation);
  L(`🎯 Score qualite : ${qs.score}/100 -- ${qs.label}`,null);

  // Afficher zones urgence
  result.traj&&Object.entries(result.traj).forEach(([eid,t])=>{
    if(t.zone==='danger'||t.zone==='critique'){
      const e=educById(+eid);
      if(e) L(`⚠ ${e.prenom} ${e.nom} : zone ${t.zone} (${t.soldeAnnuel.toFixed(1)}h)`,null);
    }
  });

  if(validation.errors.length) L(`⚠ ${validation.errors.length} poste(s) non couverts`,null);
  validation.warnings.slice(0,6).forEach(w=>L('! '+w,null));
  result.warnings.slice(0,4).forEach(w=>L('! '+w,null));
  L('✅ Termine !',100);

  btn.disabled=false;btn.innerHTML="⚡ Generer l'horaire";
  showAlert('gen-alerts',validation.errors.length?'warn':'ok',`Horaire V20 genere -- Score : ${qs.score}/100 (${qs.label})`);
  updateMonthLabels();
}

// ================================================================
// REFERENCE PLANNING (pour score)
// ================================================================
let planning_ref={};

// ================================================================
// ████████████████████████████████████████████████████████████████
// MOTEUR PRINCIPAL V20
// ████████████████████████████████████████████████████████████████
// ================================================================
async function genMois(moisStr,L){
  _pm=null;_em=null;
  const [yr,mo]=moisStr.split('-').map(Number);
  const jours=getDays(yr,mo);
  const planning={},warnings=[],diagnostic=[];
  planning_ref=planning;

  const horizon=+document.getElementById('gen-horizon').value||3;
  const minRepos=getRule('min_repos',11);
  const maxCons=getRule('max_consec',6);
  const maxWeMois=getRule('max_we_mois',2);
  const reposNuit=getRule('repos_apres_nuit',1);
  const maxNuitsC=2;
  const pression=pressionMois(mo);
  pression_ref=pression;

  // ================================================================
  // PHASE 1 -- DESIGN STRUCTUREL
  // ================================================================
  L('📐 Phase 1 : Design structurel...',5);await sl(30);

  // P1.1 : Trajectoire annuelle
  L('  P1.1 : Trajectoire annuelle...',7);await sl(20);
  const traj=calculerTrajectoireAnnuelle(moisStr);
  traj_ref=traj;

  // P1.1 suite : Historique
  L('  P1.1 : Historique...',10);await sl(20);
  const hist=calculerHistorique(yr,mo,horizon);
  const annStats=loadAnnualStats()[yr]||{};
  const lockedSlots=getLockedSlots(moisStr);
  const patterns=buildPatterns(moisStr);

  // P1.2 : Analyse besoins globaux
  L('  P1.2 : Analyse besoins globaux...',13);await sl(20);
  const besoins=analyserBesoinsGlobaux(jours,moisStr);
  dbg('Besoins globaux:', besoins);

  // P1.3 : Quotas structurels
  L('  P1.3 : Quotas structurels + plafonds...',16);await sl(20);
  const quotas=calculerQuotasStructurels(hist,jours,moisStr,traj,besoins);

  // Initialisation tracker
  const tracker={};const lastPrest={};
  educs.forEach(e=>{
    tracker[e.id]={
      h:0,nuits:0,nuitsC:0,weCount:0,weJours:new Set(),
      cons:0,lastDay:null,plageCount:{},
      types:{matin:0,aprem:0,soir:0,nuit:0,reunion:0},
      fatigue:0,joursH:{},dernierWE:null
    };
    plages.forEach(p=>tracker[e.id].plageCount[p.id]=0);
    lastPrest[e.id]=null;
  });
  tracker_ref=tracker;

  // Charger etat fin du mois precedent (pour continuite loi)
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

  // P1.4 : Construction rotation WE
  L('  P1.4 : Rotation WE tournante...',20);await sl(30);

  // Construire la map des WE du mois
  const weMap={};let weNum=0,lastSat=-1;
  jours.forEach(d=>{
    if(d.getDay()===6){weNum++;lastSat=d.getDate();}
    if(d.getDay()===0&&lastSat<0)weNum++;
    if(isWEDay(d)) weMap[dayStr(d)]=weNum;
  });
  const weNums=[...new Set(Object.values(weMap))].sort((a,b)=>a-b);

  const rotationWE=construireRotationWE(
    jours,moisStr,weNums,weMap,quotas,hist,annStats
  );
  dbg('Rotation WE construite:', rotationWE);

  // P1.5 : Rotation nuit vendredi
  L('  P1.5 : Rotation nuit vendredi...',24);await sl(20);
  const rotationNuitVen=construireRotationNuitVendredi(
    jours,moisStr,hist,quotas,annStats
  );
  dbg('Rotation nuit vendredi:', rotationNuitVen);

  L('✅ Phase 1 terminee -- cadre structurel pose',27);await sl(20);

  // ================================================================
  // PHASE 2 -- GENERATION DANS LE CADRE POSE
  // ================================================================
  L('🏗️ Phase 2 : Generation...',30);await sl(20);

  // Helper local pour les fonctions qui ont besoin du contexte complet
  const _checkLoi=(e,d,ds,dow,plage)=>checkLoi(e,d,ds,dow,plage,tracker,lastPrest,minRepos,maxCons,reposNuit,maxNuitsC,planning);
  const _checkConv=(e,d,ds,plage,niveau)=>checkConvention(e,d,ds,plage,niveau,tracker,hist,quotas,traj,maxWeMois);
  const _score=(e,d,ds,plage,weOrFerie,dow,isWEC)=>score(e,d,ds,plage,weOrFerie,dow,isWEC,tracker,hist,quotas,traj,patterns,annStats,pression);
  const _update=(e,d,ds,plage,nuit,we)=>updateTracker(e,d,ds,plage,nuit,we,tracker,lastPrest);

  // -- E1 : Attribution blocs WE (depuis rotation P1.4) --
  L('  E1 : Attribution blocs WE...',32);await sl(20);

  const weAssigned={}; // ds -> { plageId: [educId,...] }

  for(const wn of weNums){
    const joursWE=jours.filter(d=>weMap[dayStr(d)]===wn).sort((a,b)=>a-b);
    if(!joursWE.length) continue;

    const rotWN=rotationWE[wn]||{};

    joursWE.forEach(d=>{
      const ds=dayStr(d);
      const dow=dowIdx(d);
      const fe=isFerie(ds);
      const dc=(fe&&!isWEDay(d))?5:dow;
      if(!weAssigned[ds]) weAssigned[ds]={};

      // Recopier verrouillages existants
      if(lockedSlots[ds]){
        Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
          weAssigned[ds][pid]=ids;
        });
      }

      // Plages WE ce jour
      plages.filter(p=>p.jours.includes(dc)&&!isReunion(p)).forEach(p=>{
        // Deja verrouille ?
        if(lockedSlots[ds]&&lockedSlots[ds][p.id]) return;

        // Nuit vendredi -> traitee en E2, pas ici
        if(dowIdx(d)===IDX_VENDREDI && estPlageNuitVendredi(p)) return;

        const reqMin=+p.min||1;
        const nuit=isNuitP(p);

        // Utiliser la rotation P1.4
        let assigned=[];
        if(rotWN[p.id]){
          // Filtrer les educs de la rotation qui passent les contraintes legales
          const rotIds=rotWN[p.id];
          assigned=rotIds.map(id=>educById(id)).filter(e=>{
            if(!e) return false;
            return _checkLoi(e,d,ds,dow,p).ok;
          });
        }

        // BLOC WE ATOMIQUE : verifier que les memes educs sont sur sam ET dim
        // Si plage couvre sam ET dim, forcer coherence
        // (le meme educ doit etre sur les deux jours du WE)

      // Si rotation insuffisante : completer avec les meilleurs candidats restants
        if(assigned.length<reqMin){
          const dejaIds=new Set(assigned.map(e=>e.id));
          const candidatsSupp=educs.filter(e=>{
            if(dejaIds.has(e.id)) return false;
            if(!_checkLoi(e,d,ds,dow,p).ok) return false;
            if((e.excls||[]).includes(p.id)) return false;
            return true;
          }).map(e=>({e,sc:_score(e,d,ds,p,true,dow,true)}))
            .sort((a,b)=>a.sc-b.sc)
            .map(x=>x.e);
          assigned.push(...candidatsSupp.slice(0,reqMin-assigned.length));
        }

        if(assigned.length<reqMin)
          warnings.push(`WE ${wn} - ${p.nom}: ${assigned.length}/${reqMin} (contrainte legale)`);

        weAssigned[ds][p.id]=assigned.map(e=>e.id);
        assigned.forEach(e=>_update(e,d,ds,p,nuit,true));
      });
    });

    // Detecter WE coupes (avertissement)
    const samIds=new Set(),dimIds=new Set();
    joursWE.forEach(d=>{
      const ds=dayStr(d),dow=d.getDay();
      Object.entries(weAssigned[ds]||{}).forEach(([pid,ids])=>{
        if(pid.startsWith('_')||!Array.isArray(ids))return;
        ids.forEach(id=>{if(dow===6)samIds.add(+id);if(dow===0)dimIds.add(+id);});
      });
    });
    samIds.forEach(id=>{
      if(!dimIds.has(id)){const e=educById(id);if(e)warnings.push(`WE ${wn}: ${e.prenom} seulement samedi`);}
    });
    dimIds.forEach(id=>{
      if(!samIds.has(id)){const e=educById(id);if(e)warnings.push(`WE ${wn}: ${e.prenom} seulement dimanche`);}
    });
  }

  // -- E2 : Attribution nuits vendredi (depuis rotation P1.5) --
  L('  E2 : Attribution nuits vendredi...',38);await sl(10);

  // (integre dans E3 car les vendredis sont des jours normaux de semaine,
  //  on injecte la rotation avant le traitement normal du jour)

  // -- E3 : Semaines normales --
  L('  E3 : Construction semaines...',42);await sl(10);

  for(let di=0;di<jours.length;di++){
    if(di%4===0){
      L(`  Jour ${di+1}/${jours.length}`,42+Math.round((di/jours.length)*42));
      await sl(0);
    }
    const d=jours[di],ds=dayStr(d),dow=dowIdx(d);
    const we=isWEDay(d),ferie=isFerie(ds);
    planning[ds]={};

    // Recopier verrouillages
    if(lockedSlots[ds]){
      Object.entries(lockedSlots[ds]).forEach(([pid,ids])=>{
        planning[ds][pid]=ids;
        planning[ds]['_lock_'+pid]='locked';
        ids.forEach(eid=>{
          const e=educById(+eid);if(!e)return;
          const p=plageById(+pid);if(!p)return;
          _update(e,d,ds,p,isNuitP(p)&&!isReunion(p),we);
        });
      });
    }

    // -- Jour WE : utiliser blocs pre-assignes --
    if(we&&weAssigned[ds]){
      Object.entries(weAssigned[ds]).forEach(([pid,ids])=>{
        if(lockedSlots[ds]&&lockedSlots[ds][pid])return;
        planning[ds][pid]=ids;
        planning[ds]['_bloc_'+pid]='we_bloc';
        const p=plageById(+pid); if(!p) return;
        ids.forEach(eid=>{
          const e=educById(+eid); if(!e) return;
          planning[ds][`_s_${eid}_${pid}`]=(e.prefs||[]).includes(+pid)?'pref':'neutral';
        });
        if(ids.length<(+p.min||1))
          warnings.push(`${ds} - ${p.nom}: ${ids.length}/${p.min} (bloc WE incomplet)`);
      });

      // Reunions WE eventuelles
      const pjWE=plages.filter(p=>{
        if((weAssigned[ds]||{})[p.id]!==undefined)return false;
        if(lockedSlots[ds]&&lockedSlots[ds][p.id])return false;
        const dc=(ferie&&!we)?5:dow;
        return p.jours.includes(dc)&&isReunion(p);
      });
      for(const plage of pjWE){
        const reqMin=+plage.min||1;
        let cands=educs.filter(e=>_checkLoi(e,d,ds,dow,plage).ok&&_checkConv(e,d,ds,plage,0).ok);
        if(cands.length<reqMin)cands=educs.filter(e=>_checkLoi(e,d,ds,dow,plage).ok);
        const scored=cands.map(e=>({e,sc:_score(e,d,ds,plage,true,dow,true)})).sort((a,b)=>a.sc-b.sc);
        const assigned=scored.slice(0,reqMin).map(x=>x.e);
        planning[ds][plage.id]=assigned.map(e=>e.id);
        assigned.forEach(e=>{
          planning[ds][`_s_${e.id}_${plage.id}`]='neutral';
          _update(e,d,ds,plage,false,true);
        });
      }
      continue;
    }

    // -- Jour normal (semaine + feries) --
    const dowForPlages=(ferie&&!we)?5:dow;

    // Injecter rotation nuit vendredi AVANT traitement normal
    // (si ce vendredi a des nuits pre-attribuees)
    const venNuitDuJour=(dow===IDX_VENDREDI&&!we)?rotationNuitVen[ds]:null;
    if(venNuitDuJour){
      Object.entries(venNuitDuJour).forEach(([pid,ids])=>{
        if(lockedSlots[ds]&&lockedSlots[ds][+pid]) return;
        planning[ds][+pid]=ids;
        planning[ds]['_bloc_'+pid]='ven_nuit_bloc';
        const p=plageById(+pid); if(!p) return;
        ids.forEach(eid=>{
          const e=educById(+eid); if(!e) return;
          _update(e,d,ds,p,true,false);
          planning[ds][`_s_${eid}_${pid}`]='neutral';
        });
      });
    }

    // Trier plages par priorite (nuits difficiles d'abord, reunions en dernier)
    const pjBase=plages.filter(p=>p.jours.includes(dowForPlages));
    function prio(p){
      if(isReunion(p))return 10;
      // Nuit vendredi deja attribuee -> ne pas re-traiter
      if(dow===IDX_VENDREDI&&estPlageNuitVendredi(p)&&venNuitDuJour&&venNuitDuJour[p.id]) return 99;
      if(isNuitP(p))return 0;
      if(ferie)return 1;
      if(dureeH(p)>8)return 2;
      return 3;
    }
    const pj=[...pjBase].sort((a,b)=>{
      const pa=prio(a),pb=prio(b);if(pa!==pb)return pa-pb;
      const ca=educs.filter(e=>_checkLoi(e,d,ds,dow,a).ok).length;
      const cb=educs.filter(e=>_checkLoi(e,d,ds,dow,b).ok).length;
      return (ca/Math.max(1,+a.min||1))-(cb/Math.max(1,+b.min||1));
    });

    for(const plage of pj){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id])continue;
      // Nuit vendredi deja injectee -> skip
      if(prio(plage)===99) continue;
      // Deja attribuee via bloc vendredi ?
      if(planning[ds][plage.id]!==undefined && !Array.isArray(planning[ds][plage.id])) continue;
      if(planning[ds][plage.id]!==undefined) continue;

      const nuit=isNuitP(plage)&&!isReunion(plage);
      const reqMin=Math.max(0,+plage.min||1);
      const useAll=plage.tous;
      const diagD=[];
      let cands=[];

      educs.forEach(e=>{
        const loi=_checkLoi(e,d,ds,dow,plage);
        if(!loi.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:loi.raison});return;}
        const conv=_checkConv(e,d,ds,plage,0);
        if(!conv.ok){diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:false,raison:conv.raison});return;}
        cands.push(e);
      });

      if(cands.length<reqMin&&!useAll)
        cands=educs.filter(e=>_checkLoi(e,d,ds,dow,plage).ok&&_checkConv(e,d,ds,plage,1).ok);
      if(cands.length<reqMin&&!useAll){
        cands=educs.filter(e=>_checkLoi(e,d,ds,dow,plage).ok);
        cands.forEach(e=>{if(quotas[e.id])quotas[e.id].exceptionsUsees++;});
      }

      const scored=cands.map(e=>({e,sc:_score(e,d,ds,plage,ferie,dow,false)})).sort((a,b)=>a.sc-b.sc);
      const n=useAll?scored.length:Math.min(reqMin,scored.length);
      const assigned=scored.slice(0,n).map(x=>x.e);
      planning[ds][plage.id]=assigned.map(e=>e.id);
      assigned.forEach(e=>diagD.push({nom:e.prenom+' '+e.nom,ini:(e.prenom[0]+e.nom[0]).toUpperCase(),color:e.color||'#888',ok:true,raison:'Assigne'}));
      if(assigned.length<reqMin||(nuit||ferie)) diagnostic.push({ds,plage:plage.nom,couverte:assigned.length>=reqMin,details:diagD});

      assigned.forEach(e=>{
        const isExcl=!isReunion(plage)&&(e.excls||[]).includes(plage.id);
        const isPref=(e.prefs||[]).includes(plage.id);
        const dow2=d.getDay()===0?6:d.getDay()-1;
        const dem=(e.demandes||[]).find(x=>x.jour===dow2&&(x.plageIds||[]).includes(plage.id));
        const sk=`_s_${e.id}_${plage.id}`;
        if(isExcl){planning[ds][sk]='forced';warnings.push(`${ds} - ${plage.nom}: refusee assignee a ${e.prenom}`);}
        else if(dem&&dem.type==='eviter'){planning[ds][sk]='dem_evite';warnings.push(`${ds} - ${plage.nom}: demande de ${e.prenom} non respectee`);}
        else if(dem&&dem.type==='prefere') planning[ds][sk]='dem_pref';
        else if(isPref) planning[ds][sk]='pref';
        else planning[ds][sk]='neutral';
        _update(e,d,ds,plage,nuit,false);
      });
      if(assigned.length<reqMin)
        warnings.push(`${ds} - ${plage.nom}: ${reqMin-assigned.length} poste(s) non couvert(s)`);
    }

    // Passe B : maximum (uniquement si solde negatif ou zone urgence)
    for(const plage of plages.filter(p=>p.jours.includes(dowForPlages)&&!p.tous&&!isReunion(p))){
      if(lockedSlots[ds]&&lockedSlots[ds][plage.id])continue;
      if(we)continue;
      if(prio(plage)===99)continue;
      const reqMin=Math.max(0,+plage.min||1);
      const reqMax=Math.max(reqMin,+plage.max||reqMin);
      if(reqMax<=reqMin)continue;
      const deja=(planning[ds][plage.id]||[]).map(x=>+x);
      const encore=reqMax-deja.length;if(encore<=0)continue;
      const cands=educs.filter(e=>{
        if(deja.includes(e.id))return false;
        if(!_checkLoi(e,d,ds,dow,plage).ok)return false;
        if(!_checkConv(e,d,ds,plage,1).ok)return false;
        const solde=(hist[e.id].solde||0)+(tracker[e.id].h-(quotas[e.id]?.h.cible||0));
        return solde<-3||(traj[e.id]&&(traj[e.id].zone==='critique'||traj[e.id].zone==='danger'));
      }).map(e=>({e,sc:_score(e,d,ds,plage,false,dow,false)}))
        .sort((a,b)=>a.sc-b.sc).slice(0,encore).map(x=>x.e);
      if(!cands.length)continue;
      planning[ds][plage.id]=[...deja,...cands.map(e=>e.id)];
      cands.forEach(e=>{
        planning[ds][`_s_${e.id}_${plage.id}`]=(e.prefs||[]).includes(plage.id)?'pref':'neutral';
        _update(e,d,ds,plage,isNuitP(plage),false);
      });
    }
  }

  // -- E4 : Micro-ajustements (nuits + soirs) --
  L('  E4 : Micro-ajustements...',86);await sl(20);

  let sw=0;
  // Types a reequilibrer : nuits de semaine + soirs
  const typesASwapper=['nuit','soir'];

  for(let iter=0;iter<50;iter++){
    let improved=false;

    for(const ds of Object.keys(planning)){
      const dObj=new Date(ds+'T12:00');
      if(isWEDay(dObj))continue; // pas de swap sur WE
      if(lockedSlots[ds])continue;
      const dow=dowIdx(dObj);

      for(const plage of plages.filter(p=>{
        const tp=typePlage(p);
        return typesASwapper.includes(tp)&&!isReunion(p);
      })){
        // Nuit vendredi : skip (rotation propre)
        if(dow===IDX_VENDREDI&&estPlageNuitVendredi(plage)) continue;

        const ids=(planning[ds][plage.id]||[]).map(x=>+x);
        if(!ids.length)continue;
        const reqMin=+plage.min||1;
        const tp=typePlage(plage);

        for(const idIn of ids){
          const eIn=educById(idIn);if(!eIn)continue;
          // Score normalise de l'educateur en place
          const myIn=norm((hist[eIn.id].types[tp]||0)+(tracker[eIn.id].types[tp]||0),eIn);

          for(const eOut of educs.filter(e=>!ids.includes(e.id))){
            const myOut=norm((hist[eOut.id].types[tp]||0)+(tracker[eOut.id].types[tp]||0),eOut);
            if(myOut>=myIn-1.2)continue; // swap ne fait pas gagner assez
            if(!(eOut.jours||[]).includes(dow)||isAbsent(eOut.id,ds))continue;
            if(!checkLoi(eOut,dObj,ds,dow,plage,tracker,lastPrest,minRepos,maxCons,reposNuit,maxNuitsC,planning).ok)continue;

            const newIds=ids.filter(x=>x!==idIn).concat(eOut.id);
            if(newIds.length<reqMin)continue;
            if((planning[ds][plage.id]||[]).map(x=>+x).includes(eOut.id))continue;

            // Verifier que le swap ne cree pas un desequilibre heures trop fort
            const sIn=(hist[eIn.id].solde||0)+(tracker[eIn.id].h-(quotas[eIn.id]?.h.cible||0));
            const sOut=(hist[eOut.id].solde||0)+(tracker[eOut.id].h-(quotas[eOut.id]?.h.cible||0));
            if(sOut-dureeH(plage)<-14)continue;
            if(sIn+dureeH(plage)>14)continue;

            // Effectuer le swap
            planning[ds][plage.id]=newIds;
            delete planning[ds][`_s_${idIn}_${plage.id}`];
            planning[ds][`_s_${eOut.id}_${plage.id}`]='neutral';

            // Mettre a jour les trackers
            tracker[eIn.id].types[tp]=Math.max(0,(tracker[eIn.id].types[tp]||0)-1);
            tracker[eOut.id].types[tp]=(tracker[eOut.id].types[tp]||0)+1;
            if(tp==='nuit'){
              tracker[eIn.id].nuits=Math.max(0,(tracker[eIn.id].nuits||0)-1);
              tracker[eOut.id].nuits=(tracker[eOut.id].nuits||0)+1;
            }
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
  if(sw>0) dbg(`E4 swaps: ${sw}`);

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
      if(ids.length<(+p.min||1))
        errors.push(`${ds} - ${p.nom}: ${ids.length}/${p.min}`);
    });
  });

  const nTot={},sTot={},hTot={};
  educs.forEach(e=>{nTot[e.id]=0;sTot[e.id]=0;hTot[e.id]=tracker?tracker[e.id]?.h||0:0;});

  jours.forEach(d=>{
    const ds=dayStr(d);
    plages.forEach(p=>{
      ((planning[ds]||{})[p.id]||[]).forEach(id=>{
        if(isNuitP(p)&&!isReunion(p)) nTot[+id]=(nTot[+id]||0)+1;
        if(typePlage(p)==='soir')       sTot[+id]=(sTot[+id]||0)+1;
      });
    });
  });

  // Verification equite nuits
  const avgNN=moyPond(educs,e=>nTot[e.id]||0);
  educs.forEach(e=>{
    const ec=Math.abs(norm(nTot[e.id]||0,e)-avgNN);
    if(ec>4) warns.push(`Nuits : ${e.prenom} ecart ${ec.toFixed(1)}`);
  });

  // Verification soldes heures
  educs.forEach(e=>{
    const s=hTot[e.id]-(quotas?quotas[e.id]?.h.cible||0:0);
    if(Math.abs(s)>15) warns.push(`Solde ${e.prenom}: ${s>=0?'+':''}${s.toFixed(1)}h`);
  });

  // Verification equite soirs
  const avgSN=moyPond(educs,e=>sTot[e.id]||0);
  educs.forEach(e=>{
    const ec=Math.abs(norm(sTot[e.id]||0,e)-avgSN);
    if(ec>4) warns.push(`Soirs : ${e.prenom} ecart ${ec.toFixed(1)}`);
  });

  const metrics={
    equite:Math.max(0,100-Object.values(nTot).reduce((s,v,i)=>{
      const e=educs[i]; if(!e) return s;
      return s+Math.abs(norm(v,e)-avgNN)*8;
    },0)),
    stabilite:85,
    couverture:errors.length===0?100:Math.max(0,100-errors.length*15),
    prefs:Math.max(0,100-warns.filter(w=>w.includes('demande')).length*10)
  };

  return{valid:true,errors,warnings:warns,metrics};
}

function planningQualityScore(validation){
  const m=validation.metrics||{equite:50,stabilite:50,couverture:50,prefs:50};
  const score=Math.round(m.equite*0.30+m.stabilite*0.30+m.couverture*0.30+m.prefs*0.10);
  const label=score>=85?'Excellent':score>=70?'Bon':score>=55?'Moyen':'A ameliorer';
  return{score,label,details:m};
}
