// ============================================================
// data.js - PlanEduc Pro - V20
// État global, constantes, sauvegarde/chargement
// Ajouts V20 :
//   - stockage rotation WE tournante (equipeWE)
//   - stockage soldes trimestriels
//   - détection automatique mois de clôture trimestriel
// ============================================================

// ── État global ──
let educs       = [];
let plages      = [];
let reglesL     = defaultLegal();
let reglesI     = defaultInternal();
let reglesC     = [];
let horaire     = {};   // { “2026-05”: { “2026-05-01”: { plageId: [educId,…] } } }
let absences    = [];
let joursFeries = [];
let currentMonth = new Date().toISOString().slice(0,7);
let cellCtx     = {};

// ── Constantes ──
const JOURS       = [‘Lun’,‘Mar’,‘Mer’,‘Jeu’,‘Ven’,‘Sam’,‘Dim’];
const CONTRAT_H   = {‘temps-plein’:38,‘4/5’:30.4,‘3/4’:28.5,‘mi-temps’:19,‘perso’:null};
const COLORS      = [’#2a5fc8’,’#1a7a4a’,’#c8622a’,’#7a3fc8’,’#c02a2a’,’#d4800a’,’#1a7a8a’,’#6a8a1a’,’#8a2a6a’,’#3a6a8a’];

// ── Règles légales par défaut ──
function defaultLegal(){return[
{id:‘l1’,nom:‘Repos minimum entre 2 prestations’,desc:‘Repos obligatoire entre la fin et le début d'une prestation’,type:‘min_repos’,value:11,unit:‘heures’,active:true},
{id:‘l2’,nom:‘Max jours consécutifs’,desc:‘Nombre maximum de jours de travail d'affilée’,type:‘max_consec’,value:6,unit:‘jours’,active:true},
{id:‘l3’,nom:‘Max heures par semaine’,desc:‘Plafond d'heures sur 7 jours glissants’,type:‘max_h_semaine’,value:50,unit:‘heures’,active:true},
{id:‘l4’,nom:‘Max nuits consécutives’,desc:‘Nuits de travail d'affilée maximum’,type:‘max_nuits_consec’,value:2,unit:‘nuits’,active:true},
{id:‘l5’,nom:‘Repos hebdo minimum’,desc:‘Jours de repos minimum par semaine’,type:‘min_repos_semaine’,value:2,unit:‘jours’,active:true},
];}

function defaultInternal(){return[
{id:‘i1’,nom:‘Max week-ends travaillés par mois’,desc:‘Pour l'équité entre éducateurs’,type:‘max_we_mois’,value:2,unit:‘WE’,active:true},
{id:‘i2’,nom:‘Repos après nuit (jours)’,desc:‘Jours obligatoires de repos après une nuit’,type:‘repos_apres_nuit’,value:1,unit:‘jours’,active:true},
{id:‘i3’,nom:‘Tolérance solde heures mensuel (±h)’,desc:‘Écart max acceptable sur le mois’,type:‘tol_heures’,value:15,unit:‘heures’,active:true},
{id:‘i4’,nom:‘Tolérance solde trimestriel (±h)’,desc:‘Écart max acceptable en fin de trimestre’,type:‘tol_trim’,value:6,unit:‘heures’,active:true},
];}

// ── Helpers dates ──
function dayStr(d){
return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function moisKey(yr,mo){
const d = new Date(yr, mo-1, 1);
return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function moisKeyDelta(moisStr, delta){
const [y,m] = moisStr.split(’-’).map(Number);
return moisKey(y, m + delta);
}
function getDays(y,m){
const d=new Date(y,m-1,1), r=[];
while(d.getMonth()===m-1){r.push(new Date(d));d.setDate(d.getDate()+1);}
return r;
}
function monthLabel(s){
const [y,m] = s.split(’-’).map(Number);
const l = new Date(y,m-1,1).toLocaleDateString(‘fr-BE’,{month:‘long’,year:‘numeric’});
return l.charAt(0).toUpperCase()+l.slice(1);
}
function getTargetH(e){
return e.contrat===‘perso’ ? (e.heuresPerso||38) : (CONTRAT_H[e.contrat]||38);
}
function getRule(type, def){
const all=[…reglesL,…reglesI,…reglesC].filter(r=>r.active);
const r=all.find(x=>x.type===type);
return r ? +r.value : def;
}
function sl(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── Absences ──
function isAbsent(educId, ds){
return absences.some(a => a.educId===educId && ds>=a.debut && ds<=a.fin);
}

// ── Jours fériés ──
function isFerie(ds){
return joursFeries.some(f => f.date===ds && f.active);
}

// ================================================================
// V20 — DÉTECTION MOIS DE CLÔTURE TRIMESTRIEL
// Trimestres : jan-mar / avr-jun / jul-sep / oct-déc
// Clôture = dernier mois du trimestre = mars(3), juin(6), sept(9), déc(12)
// ================================================================
function estMoisClotureTrimestre(moisStr){
const mo = +moisStr.split(’-’)[1];
return mo===3 || mo===6 || mo===9 || mo===12;
}

function estMoisDecembre(moisStr){
return +moisStr.split(’-’)[1] === 12;
}

// Retourne le numéro de trimestre (1-4) pour un mois donné
function numTrimestre(moisStr){
const mo = +moisStr.split(’-’)[1];
return Math.ceil(mo/3);
}

// Premier mois du trimestre courant
function debutTrimestre(moisStr){
const [yr,mo] = moisStr.split(’-’).map(Number);
const debutMo = (Math.ceil(mo/3)-1)*3+1;
return moisKey(yr, debutMo);
}

// ================================================================
// V20 — STOCKAGE ROTATION WE TOURNANTE
// Stocké dans localStorage sous ‘planeduc_v20_rotationWE’
// Structure : { “2026-05”: { lastWeekendNum: 2, derniereEquipe: [educId,…], weAttribues: { weNum: [educId,…] } } }
// ================================================================
function loadRotationWE(){
try{ return JSON.parse(localStorage.getItem(‘planeduc_v20_rotationWE’)||’{}’); }
catch(e){ return {}; }
}
function saveRotationWE(data){
try{ localStorage.setItem(‘planeduc_v20_rotationWE’, JSON.stringify(data)); }
catch(e){ console.warn(‘saveRotationWE:’, e); }
}

// Récupère l’état WE du mois précédent pour initialiser la rotation du mois courant
function getEtatWEMoisPrecedent(moisStr){
const [yr,mo] = moisStr.split(’-’).map(Number);
const prevKey = moisKey(yr, mo-1);
const rot = loadRotationWE();

// Si on a des données du mois précédent, les utiliser
if(rot[prevKey]){
return rot[prevKey];
}

// Sinon : analyser le planning du mois précédent s’il existe
const planPrev = horaire[prevKey];
if(!planPrev) return null;

const [py,pm] = prevKey.split(’-’).map(Number);
const joursPrev = getDays(py,pm);

// Trouver le dernier WE du mois précédent
const derniersDimanches = joursPrev.filter(d=>d.getDay()===0).sort((a,b)=>b-a);
if(!derniersDimanches.length) return null;

const dernierDim = derniersDimanches[0];
const dsLastDim  = dayStr(dernierDim);
const dsLastSam  = dayStr(new Date(dernierDim.getTime()-86400000));

// Qui a travaillé ce dernier WE ?
const idsLastWE = new Set();
[dsLastSam, dsLastDim].forEach(ds=>{
Object.entries(planPrev[ds]||{}).forEach(([pid,ids])=>{
if(pid.startsWith(’_’)||!Array.isArray(ids)) return;
ids.forEach(id=>idsLastWE.add(+id));
});
});

return {
derniereEquipe: […idsLastWE],
prevMoisKey: prevKey
};
}

// Sauvegarde l’état de rotation WE après génération d’un mois
function sauvegarderRotationWE(moisStr, etatWE){
const rot = loadRotationWE();
rot[moisStr] = etatWE;
saveRotationWE(rot);
}

// ================================================================
// V20 — STOCKAGE SOLDES TRIMESTRIELS
// Stocké sous ‘planeduc_v20_soldesTrim’
// Structure : { “2026-T1”: { educId: soldeH, … }, … }
// ================================================================
function loadSoldesTrim(){
try{ return JSON.parse(localStorage.getItem(‘planeduc_v20_soldesTrim’)||’{}’); }
catch(e){ return {}; }
}
function saveSoldesTrim(data){
try{ localStorage.setItem(‘planeduc_v20_soldesTrim’, JSON.stringify(data)); }
catch(e){ console.warn(‘saveSoldesTrim:’, e); }
}

function cleTrimestre(moisStr){
const [yr] = moisStr.split(’-’);
return `${yr}-T${numTrimestre(moisStr)}`;
}

// Calcule et sauvegarde le solde trimestriel réel après génération du mois de clôture
function calculerEtSauvegarderSoldeTrim(moisStr){
if(!estMoisClotureTrimestre(moisStr)) return;
const [yr,mo] = moisStr.split(’-’).map(Number);
const debutMo = (Math.ceil(mo/3)-1)*3+1;
const soldes  = {};
educs.forEach(e=>{
let hTrav=0, hCible=0;
for(let m=debutMo; m<=mo; m++){
const key = moisKey(yr,m);
const plan = horaire[key]; if(!plan) continue;
const [ky,km] = key.split(’-’).map(Number);
const jours = getDays(ky,km);
const joursOuv = jours.filter(d=>{
const dw=d.getDay(); return dw>=1&&dw<=5&&!isFerie(dayStr(d));
});
hCible += joursOuv.length * 7.6 * (getTargetH(e)/38);
jours.forEach(day=>{
const ds=dayStr(day);
if(isAbsent(e.id,ds)) return;
plages.forEach(p=>{
const ids=((plan[ds]||{})[p.id]||[]);
if(ids.map(x=>+x).includes(e.id)){
const [dh,dm]=p.debut.split(’:’).map(Number);
const [fh,fm]=p.fin.split(’:’).map(Number);
let h=(fh*60+fm)-(dh*60+dm); if(h<=0)h+=1440;
hTrav+=h/60;
}
});
});
}
soldes[e.id] = hTrav - hCible;
});
const soldesTrim = loadSoldesTrim();
soldesTrim[cleTrimestre(moisStr)] = soldes;
saveSoldesTrim(soldesTrim);
}

// Récupère le solde trimestriel accumulé jusqu’au trimestre précédent
function getSoldeTrimPrecedent(moisStr){
const [yr,mo] = moisStr.split(’-’).map(Number);
const trim = Math.ceil(mo/3);
if(trim===1) return {}; // Premier trimestre : pas d’historique
const clePrec = `${yr}-T${trim-1}`;
return (loadSoldesTrim()[clePrec]||{});
}

// ================================================================
// STATS ANNUELLES (inchangé, conservé de v19)
// ================================================================
function loadAnnualStats(){ try{return JSON.parse(localStorage.getItem(‘planeduc_v3_annual’)||’{}’);}catch(e){return {};} }
function updateAnnualStats(moisStr){
try{
const yr=moisStr.split(’-’)[0];
const stats=loadAnnualStats(); if(!stats[yr])stats[yr]={};
const tot={};
educs.forEach(e=>{tot[e.id]={h:0,nuits:0,we:0,feries:0,matin:0,aprem:0,soir:0,reunion:0,samNuit:0,dimNuit:0,samJour:0,dimJour:0,weBlocs:0,weCoupes:0};});
Object.keys(horaire).filter(k=>k.startsWith(yr)).forEach(mk=>{
const [ky,km]=mk.split(’-’).map(Number);
getDays(ky,km).forEach(day=>{
const ds=dayStr(day),dow=day.getDay(),weD=(dow===0||dow===6),feD=isFerie(ds);
Object.entries(horaire[mk][ds]||{}).forEach(([pid,ids])=>{
if(pid.startsWith(’_’)||!Array.isArray(ids)) return;
const p=plages.find(x=>x.id===+pid); if(!p) return;
const nuit=p.type===‘nuit’||p.debut>=‘22:00’||(p.fin<=‘07:00’&&p.fin>‘00:00’);
ids.forEach(eid=>{
const id=+eid; if(!tot[id]) return;
const [dh,dm]=p.debut.split(’:’).map(Number);
const [fh,fm]=p.fin.split(’:’).map(Number);
let h=(fh*60+fm)-(dh*60+dm); if(h<=0)h+=1440;
tot[id].h+=h/60;
if(nuit)    tot[id].nuits++;
if(weD)     tot[id].we++;
if(feD)     tot[id].feries++;
if(dow===6&&nuit)  tot[id].samNuit++;
if(dow===0&&nuit)  tot[id].dimNuit++;
if(dow===6&&!nuit) tot[id].samJour++;
if(dow===0&&!nuit) tot[id].dimJour++;
});
});
});
});
educs.forEach(e=>{stats[yr][e.id]=tot[e.id];});
localStorage.setItem(‘planeduc_v3_annual’,JSON.stringify(stats));
}catch(err){console.warn(‘updateAnnualStats:’,err);}
}

// ================================================================
// PATTERNS PERSISTANTS (inchangé)
// ================================================================
function loadPatterns(){ try{return JSON.parse(localStorage.getItem(‘planeduc_v3_patterns’)||’{}’);}catch(e){return {};} }
function savePatterns(p){ try{localStorage.setItem(‘planeduc_v3_patterns’,JSON.stringify(p));}catch(e){} }

function buildPatterns(moisStr){
const [yr,mo]=moisStr.split(’-’).map(Number);
const patterns=loadPatterns();
for(let i=1;i<=4;i++){
const key=moisKey(yr,mo-i); const plan=horaire[key]; if(!plan) continue;
const [ky,km]=key.split(’-’).map(Number);
getDays(ky,km).forEach(day=>{
const ds=dayStr(day),dow=day.getDay()===0?6:day.getDay()-1;
Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
if(pid.startsWith(’_’)||!Array.isArray(ids)) return;
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

// ================================================================
// VERROUILLAGES
// ================================================================
function getLockedSlots(moisStr){
const plan=horaire[moisStr]||{},locked={};
Object.entries(plan).forEach(([ds,slots])=>{
Object.entries(slots).forEach(([pid,val])=>{
if(pid.startsWith(’_’)||!Array.isArray(val)) return;
if(slots[’*lock*’+pid]===‘locked’){if(!locked[ds])locked[ds]={};locked[ds][pid]=val;}
});
});
return locked;
}
function toggleLock(ds,plageId){
const mo=ds.slice(0,7);
if(!horaire[mo]||!horaire[mo][ds]) return;
const lk=’*lock*’+plageId;
horaire[mo][ds][lk]=horaire[mo][ds][lk]===‘locked’?null:‘locked’;
save(); renderHoraire();
}

// ================================================================
// SAUVEGARDE / CHARGEMENT
// ================================================================
function save(){
try{
localStorage.setItem(‘planeduc_v3_config’, JSON.stringify({educs,plages,reglesL,reglesI,reglesC,absences,joursFeries}));
const moisList = Object.keys(horaire);
localStorage.setItem(‘planeduc_v3_mois’, JSON.stringify(moisList));
moisList.forEach(mois=>{
try{ localStorage.setItem(‘planeduc_v3_h_’+mois, JSON.stringify(horaire[mois])); }
catch(e){ console.warn(‘Impossible de sauvegarder’,mois,e); }
});
}catch(e){ console.error(‘Erreur sauvegarde:’,e); }
}

function load(){
try{
const cfg = JSON.parse(localStorage.getItem(‘planeduc_v3_config’)||’{}’);
if(cfg.educs)       educs       = cfg.educs;
if(cfg.plages)      plages      = cfg.plages;
if(cfg.reglesL)     reglesL     = cfg.reglesL;
if(cfg.reglesI)     reglesI     = cfg.reglesI;
if(cfg.reglesC)     reglesC     = cfg.reglesC;
if(cfg.absences)    absences    = cfg.absences;
if(cfg.joursFeries) joursFeries = cfg.joursFeries;

```
horaire = {};
const moisList = JSON.parse(localStorage.getItem('planeduc_v3_mois')||'[]');
moisList.forEach(mois=>{
  try{
    const data = localStorage.getItem('planeduc_v3_h_'+mois);
    if(data) horaire[mois] = JSON.parse(data);
  }catch(e){ console.warn('Impossible de charger',mois,e); }
});

// Compatibilité ancien format
const old = JSON.parse(localStorage.getItem('planeduc_v3')||'{}');
if(old.horaire && Object.keys(horaire).length===0){
  horaire = old.horaire;
  save();
}
console.log('✅ Chargé:',Object.keys(horaire).length,'mois:', Object.keys(horaire).join(', '));
```

}catch(e){ console.error(‘Erreur chargement:’,e); }
}

function resetAll(){
if(!confirm(‘⚠️ Supprimer TOUTES les données ?\nCette action est irréversible.’)) return;
[‘planeduc_v3_config’,‘planeduc_v3_mois’,‘planeduc_v20_rotationWE’,‘planeduc_v20_soldesTrim’].forEach(k=>localStorage.removeItem(k));
Object.keys(localStorage).filter(k=>k.startsWith(‘planeduc_v3_h_’)).forEach(k=>localStorage.removeItem(k));
localStorage.removeItem(‘planeduc_v3’);
location.reload();
}

function resetHoraires(){
if(!confirm(‘⚠️ Supprimer TOUS les horaires générés ?\n(Les éducateurs, plages et règles sont conservés)’)) return;
Object.keys(localStorage).filter(k=>k.startsWith(‘planeduc_v3_h_’)).forEach(k=>localStorage.removeItem(k));
localStorage.removeItem(‘planeduc_v3_mois’);
localStorage.removeItem(‘planeduc_v20_rotationWE’);
localStorage.removeItem(‘planeduc_v20_soldesTrim’);
horaire = {};
save();
location.reload();
}

// ── Export / Import JSON ──
function exportData(){
const blob = new Blob([JSON.stringify({educs,plages,reglesL,reglesI,reglesC,horaire,absences,joursFeries},null,2)],{type:‘application/json’});
const a = document.createElement(‘a’);
a.href = URL.createObjectURL(blob);
a.download = `planeduc_${new Date().toISOString().slice(0,10)}.json`;
a.click();
}

function importData(e){
const f = e.target.files[0]; if(!f) return;
const r = new FileReader();
r.onload = ev => {
try{
const d = JSON.parse(ev.target.result);
if(d.educs)       educs       = d.educs;
if(d.plages)      plages      = d.plages;
if(d.reglesL)     reglesL     = d.reglesL;
if(d.reglesI)     reglesI     = d.reglesI;
if(d.reglesC)     reglesC     = d.reglesC;
if(d.horaire)     horaire     = d.horaire;
if(d.absences)    absences    = d.absences;
if(d.joursFeries) joursFeries = d.joursFeries;
save(); renderAll(); renderRules(); renderFeries();
alert(‘✅ Importé avec succès !’);
}catch(err){ alert(‘❌ Fichier invalide.’); }
};
r.readAsText(f);
e.target.value = ‘’;
}
