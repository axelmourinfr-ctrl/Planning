// PlanEduc Pro - data.js - V20
// Etat global, constantes, sauvegarde/chargement
// Ajouts V20 :
//   - stockage rotation WE tournante
//   - stockage soldes trimestriels
//   - detection automatique mois de cloture trimestriel

// Etat global
let educs       = [];
let plages      = [];
let reglesL     = defaultLegal();
let reglesI     = defaultInternal();
let reglesC     = [];
let horaire     = {};
let absences    = [];
let joursFeries = [];
let currentMonth = new Date().toISOString().slice(0,7);
let cellCtx     = {};

// Constantes
const JOURS       = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
const CONTRAT_H   = {'temps-plein':38,'4/5':30.4,'3/4':28.5,'mi-temps':19,'perso':null};
const COLORS      = ['#2a5fc8','#1a7a4a','#c8622a','#7a3fc8','#c02a2a','#d4800a','#1a7a8a','#6a8a1a','#8a2a6a','#3a6a8a'];

// Regles legales par defaut
function defaultLegal(){return[
  {id:'l1',nom:'Repos minimum entre 2 prestations',desc:'Repos obligatoire entre la fin et le debut',type:'min_repos',value:11,unit:'heures',active:true},
  {id:'l2',nom:'Max jours consecutifs',desc:'Nombre maximum de jours de travail affilee',type:'max_consec',value:6,unit:'jours',active:true},
  {id:'l3',nom:'Max heures par semaine',desc:'Plafond heures sur 7 jours glissants',type:'max_h_semaine',value:50,unit:'heures',active:true},
  {id:'l4',nom:'Max nuits consecutives',desc:'Nuits de travail affilee maximum',type:'max_nuits_consec',value:2,unit:'nuits',active:true},
  {id:'l5',nom:'Repos hebdo minimum',desc:'Jours de repos minimum par semaine',type:'min_repos_semaine',value:2,unit:'jours',active:true},
];}

function defaultInternal(){return[
  {id:'i1',nom:'Max week-ends par mois',desc:'Pour equite entre educateurs',type:'max_we_mois',value:2,unit:'WE',active:true},
  {id:'i2',nom:'Repos apres nuit (jours)',desc:'Jours obligatoires de repos apres une nuit',type:'repos_apres_nuit',value:1,unit:'jours',active:true},
  {id:'i3',nom:'Tolerance solde heures mensuel',desc:'Ecart max acceptable sur le mois (h)',type:'tol_heures',value:15,unit:'heures',active:true},
  {id:'i4',nom:'Tolerance solde trimestriel',desc:'Ecart max acceptable en fin de trimestre (h)',type:'tol_trim',value:6,unit:'heures',active:true},
];}

// Helpers dates
function dayStr(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function moisKey(yr,mo){
  var d=new Date(yr,mo-1,1);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function moisKeyDelta(moisStr,delta){
  var parts=moisStr.split('-').map(Number);
  return moisKey(parts[0],parts[1]+delta);
}
function getDays(y,m){
  var d=new Date(y,m-1,1),r=[];
  while(d.getMonth()===m-1){r.push(new Date(d));d.setDate(d.getDate()+1);}
  return r;
}
function monthLabel(s){
  var parts=s.split('-').map(Number);
  var l=new Date(parts[0],parts[1]-1,1).toLocaleDateString('fr-BE',{month:'long',year:'numeric'});
  return l.charAt(0).toUpperCase()+l.slice(1);
}
function getTargetH(e){
  return e.contrat==='perso'?(e.heuresPerso||38):(CONTRAT_H[e.contrat]||38);
}
function getRule(type,def){
  var all=[].concat(reglesL,reglesI,reglesC).filter(function(r){return r.active;});
  var r=all.find(function(x){return x.type===type;});
  return r?+r.value:def;
}
function sl(ms){return new Promise(function(r){setTimeout(r,ms);});}

// Absences
function isAbsent(educId,ds){
  return absences.some(function(a){return a.educId===educId&&ds>=a.debut&&ds<=a.fin;});
}

// Jours feries
function isFerie(ds){
  return joursFeries.some(function(f){return f.date===ds&&f.active;});
}

// V20 - Detection mois de cloture trimestrielle
// Trimestres : jan-mar / avr-jun / jul-sep / oct-dec
function estMoisClotureTrimestre(moisStr){
  var mo=+moisStr.split('-')[1];
  return mo===3||mo===6||mo===9||mo===12;
}
function estMoisDecembre(moisStr){
  return +moisStr.split('-')[1]===12;
}
function numTrimestre(moisStr){
  var mo=+moisStr.split('-')[1];
  return Math.ceil(mo/3);
}
function debutTrimestre(moisStr){
  var parts=moisStr.split('-').map(Number);
  var debutMo=(Math.ceil(parts[1]/3)-1)*3+1;
  return moisKey(parts[0],debutMo);
}

// V20 - Stockage rotation WE tournante
function loadRotationWE(){
  try{return JSON.parse(localStorage.getItem('planeduc_v20_rotationWE')||'{}');}
  catch(e){return {};}
}
function saveRotationWE(data){
  try{localStorage.setItem('planeduc_v20_rotationWE',JSON.stringify(data));}
  catch(e){console.warn('saveRotationWE:',e);}
}

function getEtatWEMoisPrecedent(moisStr){
  var parts=moisStr.split('-').map(Number);
  var prevKey=moisKey(parts[0],parts[1]-1);
  var rot=loadRotationWE();
  if(rot[prevKey]) return rot[prevKey];

  var planPrev=horaire[prevKey];
  if(!planPrev) return null;

  var py=+prevKey.split('-')[0];
  var pm=+prevKey.split('-')[1];
  var joursPrev=getDays(py,pm);

  var derniersDimanches=joursPrev.filter(function(d){return d.getDay()===0;}).sort(function(a,b){return b-a;});
  if(!derniersDimanches.length) return null;

  var dernierDim=derniersDimanches[0];
  var dsLastDim=dayStr(dernierDim);
  var dsLastSam=dayStr(new Date(dernierDim.getTime()-86400000));

  var idsLastWE=new Set();
  [dsLastSam,dsLastDim].forEach(function(ds){
    Object.entries(planPrev[ds]||{}).forEach(function(entry){
      var pid=entry[0],ids=entry[1];
      if(pid.startsWith('_')||!Array.isArray(ids)) return;
      ids.forEach(function(id){idsLastWE.add(+id);});
    });
  });
  return {derniereEquipe:[...idsLastWE],prevMoisKey:prevKey};
}

function sauvegarderRotationWE(moisStr,etatWE){
  var rot=loadRotationWE();
  rot[moisStr]=etatWE;
  saveRotationWE(rot);
}

// V20 - Stockage soldes trimestriels
function loadSoldesTrim(){
  try{return JSON.parse(localStorage.getItem('planeduc_v20_soldesTrim')||'{}');}
  catch(e){return {};}
}
function saveSoldesTrim(data){
  try{localStorage.setItem('planeduc_v20_soldesTrim',JSON.stringify(data));}
  catch(e){console.warn('saveSoldesTrim:',e);}
}
function cleTrimestre(moisStr){
  return moisStr.split('-')[0]+'-T'+numTrimestre(moisStr);
}

function calculerEtSauvegarderSoldeTrim(moisStr){
  if(!estMoisClotureTrimestre(moisStr)) return;
  var parts=moisStr.split('-').map(Number);
  var yr=parts[0],mo=parts[1];
  var debutMo=(Math.ceil(mo/3)-1)*3+1;
  var soldes={};
  educs.forEach(function(e){
    var hTrav=0,hCible=0;
    for(var m=debutMo;m<=mo;m++){
      var key=moisKey(yr,m);
      var plan=horaire[key];if(!plan)continue;
      var ky=+key.split('-')[0],km=+key.split('-')[1];
      var jours=getDays(ky,km);
      var joursOuv=jours.filter(function(d){var dw=d.getDay();return dw>=1&&dw<=5&&!isFerie(dayStr(d));});
      hCible+=joursOuv.length*7.6*(getTargetH(e)/38);
      jours.forEach(function(day){
        var ds=dayStr(day);
        if(isAbsent(e.id,ds))return;
        plages.forEach(function(p){
          var ids=((plan[ds]||{})[p.id]||[]);
          if(ids.map(function(x){return +x;}).includes(e.id)){
            var dh=+p.debut.split(':')[0],dm2=+p.debut.split(':')[1];
            var fh=+p.fin.split(':')[0],fm=+p.fin.split(':')[1];
            var h=(fh*60+fm)-(dh*60+dm2);if(h<=0)h+=1440;
            hTrav+=h/60;
          }
        });
      });
    }
    soldes[e.id]=hTrav-hCible;
  });
  var soldesTrim=loadSoldesTrim();
  soldesTrim[cleTrimestre(moisStr)]=soldes;
  saveSoldesTrim(soldesTrim);
}

function getSoldeTrimPrecedent(moisStr){
  var parts=moisStr.split('-');
  var yr=parts[0];
  var trim=numTrimestre(moisStr);
  if(trim===1) return {};
  var clePrec=yr+'-T'+(trim-1);
  return (loadSoldesTrim()[clePrec]||{});
}

// Stats annuelles
function loadAnnualStats(){
  try{return JSON.parse(localStorage.getItem('planeduc_v3_annual')||'{}');}catch(e){return {};}
}
function updateAnnualStats(moisStr){
  try{
    var yr=moisStr.split('-')[0];
    var stats=loadAnnualStats();if(!stats[yr])stats[yr]={};
    var tot={};
    educs.forEach(function(e){tot[e.id]={h:0,nuits:0,we:0,feries:0,matin:0,aprem:0,soir:0,reunion:0,samNuit:0,dimNuit:0,samJour:0,dimJour:0};});
    Object.keys(horaire).filter(function(k){return k.startsWith(yr);}).forEach(function(mk){
      var ky=+mk.split('-')[0],km=+mk.split('-')[1];
      getDays(ky,km).forEach(function(day){
        var ds=dayStr(day),dow=day.getDay(),weD=(dow===0||dow===6),feD=isFerie(ds);
        Object.entries(horaire[mk][ds]||{}).forEach(function(entry){
          var pid=entry[0],ids=entry[1];
          if(pid.startsWith('_')||!Array.isArray(ids))return;
          var p=plages.find(function(x){return x.id===+pid;});if(!p)return;
          var nuit=p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00');
          ids.forEach(function(eid){
            var id=+eid;if(!tot[id])return;
            var dh=+p.debut.split(':')[0],dm2=+p.debut.split(':')[1];
            var fh=+p.fin.split(':')[0],fm=+p.fin.split(':')[1];
            var h=(fh*60+fm)-(dh*60+dm2);if(h<=0)h+=1440;
            tot[id].h+=h/60;
            if(nuit)tot[id].nuits++;
            if(weD)tot[id].we++;
            if(feD)tot[id].feries++;
            if(dow===6&&nuit)tot[id].samNuit++;
            if(dow===0&&nuit)tot[id].dimNuit++;
            if(dow===6&&!nuit)tot[id].samJour++;
            if(dow===0&&!nuit)tot[id].dimJour++;
          });
        });
      });
    });
    educs.forEach(function(e){stats[yr][e.id]=tot[e.id];});
    localStorage.setItem('planeduc_v3_annual',JSON.stringify(stats));
  }catch(err){console.warn('updateAnnualStats:',err);}
}

// Patterns persistants
function loadPatterns(){
  try{return JSON.parse(localStorage.getItem('planeduc_v3_patterns')||'{}');}catch(e){return {};}
}
function savePatterns(p){
  try{localStorage.setItem('planeduc_v3_patterns',JSON.stringify(p));}catch(e){}
}
function buildPatterns(moisStr){
  var parts=moisStr.split('-').map(Number);
  var yr=parts[0],mo=parts[1];
  var patterns=loadPatterns();
  for(var i=1;i<=4;i++){
    var key=moisKey(yr,mo-i);var plan=horaire[key];if(!plan)continue;
    var ky=+key.split('-')[0],km=+key.split('-')[1];
    getDays(ky,km).forEach(function(day){
      var ds=dayStr(day);
      var dow=day.getDay()===0?6:day.getDay()-1;
      Object.entries(plan[ds]||{}).forEach(function(entry){
        var pid=entry[0],ids=entry[1];
        if(pid.startsWith('_')||!Array.isArray(ids))return;
        ids.forEach(function(eid){
          var id=String(eid);
          if(!patterns[id])patterns[id]={};
          if(!patterns[id][dow])patterns[id][dow]={};
          patterns[id][dow][pid]=(patterns[id][dow][pid]||0)+1;
        });
      });
    });
  }
  savePatterns(patterns);return patterns;
}

// Verrouillages
function getLockedSlots(moisStr){
  var plan=horaire[moisStr]||{},locked={};
  Object.entries(plan).forEach(function(entry){
    var ds=entry[0],slots=entry[1];
    Object.entries(slots).forEach(function(se){
      var pid=se[0],val=se[1];
      if(pid.startsWith('_')||!Array.isArray(val))return;
      if(slots['_lock_'+pid]==='locked'){if(!locked[ds])locked[ds]={};locked[ds][pid]=val;}
    });
  });
  return locked;
}
function toggleLock(ds,plageId){
  var mo=ds.slice(0,7);
  if(!horaire[mo]||!horaire[mo][ds])return;
  var lk='_lock_'+plageId;
  horaire[mo][ds][lk]=horaire[mo][ds][lk]==='locked'?null:'locked';
  save();renderHoraire();
}

// Sauvegarde / Chargement
function save(){
  try{
    localStorage.setItem('planeduc_v3_config',JSON.stringify({educs:educs,plages:plages,reglesL:reglesL,reglesI:reglesI,reglesC:reglesC,absences:absences,joursFeries:joursFeries}));
    var moisList=Object.keys(horaire);
    localStorage.setItem('planeduc_v3_mois',JSON.stringify(moisList));
    moisList.forEach(function(mois){
      try{localStorage.setItem('planeduc_v3_h_'+mois,JSON.stringify(horaire[mois]));}
      catch(e){console.warn('Impossible de sauvegarder',mois,e);}
    });
  }catch(e){console.error('Erreur sauvegarde:',e);}
}
function load(){
  try{
    var cfg=JSON.parse(localStorage.getItem('planeduc_v3_config')||'{}');
    if(cfg.educs)       educs       =cfg.educs;
    if(cfg.plages)      plages      =cfg.plages;
    if(cfg.reglesL)     reglesL     =cfg.reglesL;
    if(cfg.reglesI)     reglesI     =cfg.reglesI;
    if(cfg.reglesC)     reglesC     =cfg.reglesC;
    if(cfg.absences)    absences    =cfg.absences;
    if(cfg.joursFeries) joursFeries =cfg.joursFeries;
    horaire={};
    var moisList=JSON.parse(localStorage.getItem('planeduc_v3_mois')||'[]');
    moisList.forEach(function(mois){
      try{
        var data=localStorage.getItem('planeduc_v3_h_'+mois);
        if(data)horaire[mois]=JSON.parse(data);
      }catch(e){console.warn('Impossible de charger',mois,e);}
    });
    var old=JSON.parse(localStorage.getItem('planeduc_v3')||'{}');
    if(old.horaire&&Object.keys(horaire).length===0){horaire=old.horaire;save();}
    console.log('Charge:',Object.keys(horaire).length,'mois');
  }catch(e){console.error('Erreur chargement:',e);}
}
function resetAll(){
  if(!confirm('Supprimer TOUTES les donnees ? Cette action est irreversible.'))return;
  ['planeduc_v3_config','planeduc_v3_mois','planeduc_v20_rotationWE','planeduc_v20_soldesTrim'].forEach(function(k){localStorage.removeItem(k);});
  Object.keys(localStorage).filter(function(k){return k.startsWith('planeduc_v3_h_');}).forEach(function(k){localStorage.removeItem(k);});
  localStorage.removeItem('planeduc_v3');
  location.reload();
}
function resetHoraires(){
  if(!confirm('Supprimer TOUS les horaires generes ?'))return;
  Object.keys(localStorage).filter(function(k){return k.startsWith('planeduc_v3_h_');}).forEach(function(k){localStorage.removeItem(k);});
  localStorage.removeItem('planeduc_v3_mois');
  localStorage.removeItem('planeduc_v20_rotationWE');
  localStorage.removeItem('planeduc_v20_soldesTrim');
  horaire={};save();location.reload();
}
function exportData(){
  var blob=new Blob([JSON.stringify({educs:educs,plages:plages,reglesL:reglesL,reglesI:reglesI,reglesC:reglesC,horaire:horaire,absences:absences,joursFeries:joursFeries},null,2)],{type:'application/json'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='planeduc_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
}
function importData(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();
  r.onload=function(ev){
    try{
      var d=JSON.parse(ev.target.result);
      if(d.educs)       educs       =d.educs;
      if(d.plages)      plages      =d.plages;
      if(d.reglesL)     reglesL     =d.reglesL;
      if(d.reglesI)     reglesI     =d.reglesI;
      if(d.reglesC)     reglesC     =d.reglesC;
      if(d.horaire)     horaire     =d.horaire;
      if(d.absences)    absences    =d.absences;
      if(d.joursFeries) joursFeries =d.joursFeries;
      save();renderAll();renderRules();renderFeries();
      alert('Importe avec succes !');
    }catch(err){alert('Fichier invalide.');}
  };
  r.readAsText(f);
  e.target.value='';
}
