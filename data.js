// ============================================================
// data.js - État global, constantes, sauvegarde/chargement
// ============================================================

// ── État global ──
let educs       = [];   // liste des éducateurs
let plages      = [];   // plages horaires
let reglesL     = defaultLegal();
let reglesI     = defaultInternal();
let reglesC     = [];   // règles personnalisées
let horaire     = {};   // { “2026-05”: { “2026-05-01”: { plageId: [educId,…], _status:{} } } }
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
{id:‘l2’,nom:‘Max jours consécutifs’,desc:‘Nombre maximum de jours de travail d'affilée’,type:‘max_consec’,value:7,unit:‘jours’,active:true},
{id:‘l3’,nom:‘Max heures par semaine’,desc:‘Plafond d'heures sur 7 jours glissants’,type:‘max_h_semaine’,value:50,unit:‘heures’,active:true},
{id:‘l4’,nom:‘Max nuits consécutives’,desc:‘Nuits de travail d'affilée maximum’,type:‘max_nuits_consec’,value:5,unit:‘nuits’,active:true},
{id:‘l5’,nom:‘Repos hebdo minimum’,desc:‘Jours de repos minimum par semaine’,type:‘min_repos_semaine’,value:2,unit:‘jours’,active:true},
];}

function defaultInternal(){return[
{id:‘i1’,nom:‘Max week-ends travaillés par mois’,desc:‘Pour l'équité entre éducateurs’,type:‘max_we_mois’,value:2,unit:‘WE’,active:true},
{id:‘i2’,nom:‘Repos après nuit (jours)’,desc:‘Jours obligatoires de repos après une nuit’,type:‘repos_apres_nuit’,value:1,unit:‘jours’,active:true},
{id:‘i3’,nom:‘Tolérance solde heures (±h / 3 mois)’,desc:‘Écart max acceptable sur la période d'équité’,type:‘tol_heures’,value:15,unit:‘heures’,active:true},
];}

// ── Helpers dates (sans bug de fuseau horaire) ──
function dayStr(d){
return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function moisKey(yr,mo){
// Gère le débordement (ex: mo=0 → novembre de l’année précédente)
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

// ── Sauvegarde - chaque mois séparé pour éviter la limite 5MB ──
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

// Compatibilité ancien format tout-en-un
const old = JSON.parse(localStorage.getItem('planeduc_v3')||'{}');
if(old.horaire && Object.keys(horaire).length===0){
  horaire = old.horaire;
  save(); // migrer
}
console.log('✅ Chargé:',Object.keys(horaire).length,'mois:', Object.keys(horaire).join(', '));
```

}catch(e){ console.error(‘Erreur chargement:’,e); }
}

// ── Réinitialisation complète ──
function resetAll(){
if(!confirm(‘⚠️ Supprimer TOUTES les données (éducateurs, plages, horaires) ?\nCette action est irréversible.’)) return;
[‘planeduc_v3_config’,‘planeduc_v3_mois’].forEach(k=>localStorage.removeItem(k));
Object.keys(localStorage).filter(k=>k.startsWith(‘planeduc_v3_h_’)).forEach(k=>localStorage.removeItem(k));
localStorage.removeItem(‘planeduc_v3’);
location.reload();
}

// ── Réinitialisation des horaires seulement (garde éducs et plages) ──
function resetHoraires(){
if(!confirm(‘⚠️ Supprimer TOUS les horaires générés ?\n(Les éducateurs, plages et règles sont conservés)’)) return;
Object.keys(localStorage).filter(k=>k.startsWith(‘planeduc_v3_h_’)).forEach(k=>localStorage.removeItem(k));
localStorage.removeItem(‘planeduc_v3_mois’);
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
