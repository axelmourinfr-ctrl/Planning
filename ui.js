// ============================================================
// ui.js - PlanEduc Pro V20
// Interface utilisateur : navigation, formulaires, modals
// Ajouts V20 :
//   - renderDiagnostic enrichi (equipes WE + pression trimestrielle)
//   - badge "Nuit Ven" sur les plages detectees
// ============================================================

// -- Initialisation --
window.onload = () => {
  const now = new Date();
  document.getElementById('gen-mois').value   = now.toISOString().slice(0,7);
  document.getElementById('fiche-mois').value  = now.toISOString().slice(0,7);
  document.getElementById('ferie-yr').value    = now.getFullYear();
  currentMonth = now.toISOString().slice(0,7);
  load();
  renderAll();
  renderRules();
  renderFeries();
  updateMonthLabels();
};

function renderAll(){
  renderEducGrid();
  renderPlageList();
  renderAbsList();
  renderAbsEduc();
  renderFicheEduc();
  document.getElementById('nb-educ').textContent   = educs.length;
  document.getElementById('nb-plages').textContent  = plages.length;
}

// -- Navigation principale --
function nav(el, page){
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('page-'+page).classList.add('active');
  if(page==='horaire')    renderHoraire();
  if(page==='fiche')      renderFiche();
  if(page==='soldes')     renderSoldes();
  if(page==='stats')      renderStats();
  if(page==='feries')     renderFeries();
  if(page==='absences')   renderAbsList();
  if(page==='diagnostic') renderDiagnostic();
}

// -- Onglets internes --
function itab(el, id){
  el.parentElement.querySelectorAll('.itab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  ['rl-legal','rl-intern','rl-custom'].forEach(i=>{
    const d=document.getElementById(i); if(d) d.style.display='none';
  });
  document.getElementById(id).style.display = '';
}

// -- Pills --
function togglePill(el){
  const cb = el.querySelector('input[type=checkbox]');
  if(!cb) return;
  cb.checked = !cb.checked;
  el.classList.toggle('on', cb.checked);
}
function pickColor(el){
  el.closest('.swatches').querySelectorAll('.swatch').forEach(s=>s.classList.remove('on'));
  el.classList.add('on');
  const hid = el.closest('.card, .modal').querySelector('input[type=hidden]');
  if(hid) hid.value = el.dataset.c;
}
function updateHField(){
  const v = document.getElementById('me-contrat').value;
  document.getElementById('me-h-field').style.display = v==='perso' ? '' : 'none';
}

// -- Modals --
function openModal(id, initFn){ if(initFn) initFn(); document.getElementById(id).style.display='flex'; }
function closeModal(id){ document.getElementById(id).style.display='none'; }
function bgClose(e, id){ if(e.target===e.currentTarget) closeModal(id); }
function showAlert(id, t, m){
  const ic = {ok:'✅',warn:'⚠️',err:'❌',info:'ℹ️'};
  document.getElementById(id).innerHTML = `<div class="alert a-${t}">${ic[t]} ${m}</div>`;
}

// ================================================================
// DIAGNOSTIC V20
// ================================================================
function renderDiagnostic(){
  const el=document.getElementById('page-diagnostic'); if(!el) return;

  let html='<div class="page-title">🔍 Diagnostic V20</div>';
  html+='<div class="page-sub">Structure des rotations WE, nuits vendredi, et detail des contraintes</div>';

  // -- Section 1 : Rotation WE ce mois --
  const rotData=loadRotationWE();
  const moisActuel=currentMonth;
  const rotMois=rotData[moisActuel];

  if(rotMois&&rotMois.weAttribues&&Object.keys(rotMois.weAttribues).length){
    html+=`<div class="card" style="margin-bottom:14px">
      <div class="card-hd">
        <div class="card-title">📅 Rotation WE -- ${monthLabel(moisActuel)}</div>
        <span class="badge b-blue">Equipes tournantes V20</span>
      </div>
      <div style="font-size:.78rem;color:var(--ink3);margin-bottom:12px">
        Les blocs WE ont ete composes avant generation. Sam+Dim = bloc atomique inseparable.
      </div>`;

    Object.entries(rotMois.weAttribues).sort(([a],[b])=>+a-+b).forEach(([wn,slots])=>{
      html+=`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="font-weight:700;font-size:.85rem;margin-bottom:8px">Weekend ${wn}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">`;
      Object.entries(slots).forEach(([pid,ids])=>{
        const p=plages.find(x=>x.id===+pid); if(!p) return;
        html+=`<div style="flex:1;min-width:160px;background:${p.color}18;border:1px solid ${p.color}44;border-radius:6px;padding:8px">
          <div style="font-size:.72rem;font-weight:700;color:${p.color};margin-bottom:4px">${p.nom}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">`;
        ids.forEach(id=>{
          const e=educs.find(x=>x.id===+id);
          if(!e) return;
          html+=`<span style="background:${e.color};color:#fff;border-radius:4px;padding:2px 7px;font-size:.72rem;font-weight:600">${e.prenom}</span>`;
        });
        if(!ids.length) html+=`<span style="color:var(--red);font-size:.72rem">⚠ Poste libre</span>`;
        html+=`</div></div>`;
      });
      html+=`</div></div>`;
    });

    // Equipe du dernier WE (continuite mois suivant)
    if(rotMois.derniereEquipe&&rotMois.derniereEquipe.length){
      html+=`<div class="alert a-info" style="margin-top:8px;font-size:.77rem">
        <strong>Continuite mois suivant :</strong> Ces educateurs seront en repos sur le 1er WE du mois prochain :
        ${rotMois.derniereEquipe.map(id=>{const e=educs.find(x=>x.id===+id);return e?`<strong>${e.prenom}</strong>`:''}).filter(Boolean).join(', ')}
      </div>`;
    }
    html+=`</div>`;
  }

  // -- Section 2 : Pression trimestrielle --
  const soldeTrimPrec=getSoldeTrimPrecedent(currentMonth);
  const estCloture=estMoisClotureTrimestre(currentMonth);
  const estDec=estMoisDecembre(currentMonth);
  const nTrim=numTrimestre(currentMonth);

  if(Object.keys(soldeTrimPrec).length||estCloture){
    html+=`<div class="card" style="margin-bottom:14px">
      <div class="card-hd">
        <div class="card-title">📊 Pression trimestrielle -- T${nTrim}</div>
        ${estCloture?'<span class="badge b-orange">⚠ Mois de cloture</span>':
          estDec?'<span class="badge b-red">🎯 Decembre -- Remise a zero</span>':
          '<span class="badge b-green">En cours</span>'}
      </div>`;

    if(estCloture){
      html+=`<div class="alert a-warn" style="margin-bottom:10px;font-size:.78rem">
        Ce mois est un mois de cloture trimestrielle. L'objectif est que chaque educateur termine entre <strong>-6h et +6h</strong> du solde trimestriel.
        La pression de generation est renforcee pour atteindre cet objectif.
      </div>`;
    }

    if(Object.keys(soldeTrimPrec).length){
      html+=`<div style="font-size:.78rem;color:var(--ink3);margin-bottom:8px">Soldes cumules du trimestre precedent :</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">`;
      educs.forEach(e=>{
        const s=soldeTrimPrec[e.id];
        if(s===undefined) return;
        const ok=Math.abs(s)<=6;
        html+=`<div style="background:var(--surface2);border:1.5px solid ${ok?'var(--green)':Math.abs(s)<=15?'var(--orange)':'var(--red)'};border-radius:8px;padding:8px 12px;text-align:center;min-width:100px">
          <div style="font-size:.72rem;font-weight:600">${e.prenom}</div>
          <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;color:${ok?'var(--green)':Math.abs(s)<=15?'var(--orange)':'var(--red)'}">${s>=0?'+':''}${s.toFixed(1)}h</div>
          <div style="font-size:.65rem;color:var(--ink3)">${ok?'✅ OK':Math.abs(s)<=15?'⚠ A corriger':'❌ Critique'}</div>
        </div>`;
      });
      html+=`</div>`;
    }
    html+=`</div>`;
  }

  // -- Section 3 : Trajectoire annuelle --
  // (affichee uniquement si un horaire a ete genere ce mois)
  if(horaire[currentMonth]&&Object.keys(horaire[currentMonth]).length){
    html+=`<div class="card" style="margin-bottom:14px">
      <div class="card-title" style="margin-bottom:12px">🎯 Trajectoire annuelle</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">`;
    const traj=calculerTrajectoireAnnuelle(currentMonth);
    educs.forEach(e=>{
      const t=traj[e.id]; if(!t) return;
      const zoneColor={normale:'var(--green)',attention:'var(--orange)',critique:'var(--orange)',danger:'var(--red)',surplus:'var(--blue)',ok_positif:'var(--green)'}[t.zone]||'var(--ink3)';
      html+=`<div style="background:var(--surface2);border:1.5px solid ${zoneColor};border-radius:8px;padding:8px 12px;min-width:130px">
        <div style="font-size:.72rem;font-weight:600">${e.prenom} ${e.nom}</div>
        <div style="font-size:.65rem;color:var(--ink3)">${e.contrat}</div>
        <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:.95rem;color:${zoneColor};margin-top:4px">${t.soldeAnnuel>=0?'+':''}${t.soldeAnnuel.toFixed(1)}h</div>
        <div style="font-size:.65rem;font-weight:700;color:${zoneColor};text-transform:uppercase;letter-spacing:.5px">${t.zone}</div>
        ${t.irrecuperable?'<div style="font-size:.62rem;color:var(--red);margin-top:2px">⚠ Irrecuperable</div>':''}
      </div>`;
    });
    html+=`</div></div>`;
  }

  // -- Section 4 : Detail contraintes generation --
  const diag=window._lastDiagnostic||[];
  if(diag.length){
    html+=`<div class="card">
      <div class="card-title" style="margin-bottom:12px">🔍 Detail contraintes -- derniere generation</div>`;
    diag.forEach(function(d){
      html+=`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-weight:700;font-size:.82rem">${d.ds} -- ${d.plage}</div>
          <span class="badge ${d.couverte?'b-green':'b-red'}">${d.couverte?'✅ Couverte':'⚠ Non couverte'}</span>
        </div>
        <div style="font-size:.76rem">`;
      d.details.forEach(function(r){
        html+=`<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--border)">
          <div class="avatar" style="background:${r.color};width:24px;height:24px;font-size:.6rem;flex-shrink:0">${r.ini}</div>
          <span style="font-weight:600;min-width:110px;font-size:.78rem">${r.nom}</span>
          <span style="color:${r.ok?'var(--green)':'var(--red)'};font-size:.76rem">${r.ok?'✅ Assigne':'❌ '+r.raison}</span>
        </div>`;
      });
      html+=`</div></div>`;
    });
    html+=`</div>`;
  } else if(!horaire[currentMonth]){
    html+=`<div class="empty"><div class="icon">🔍</div><p>Generez un horaire pour voir le diagnostic complet.</p></div>`;
  }

  el.innerHTML=html;
}

// ================================================================
// EDUCATEURS
// ================================================================
function renderDemandesForm(demandes){
  demandes = demandes || [];
  [1,2].forEach(i=>{
    const dem = demandes[i-1] || {};
    const jourSel   = document.getElementById(`me-dem-jour-${i}`);
    const typeSel   = document.getElementById(`me-dem-type-${i}`);
    const plagesGrp = document.getElementById(`me-dem-plages-${i}`);
    if(!jourSel || !typeSel || !plagesGrp) return;
    jourSel.value = (dem.jour !== undefined && dem.jour !== null) ? dem.jour : -1;
    typeSel.value = dem.type || 'eviter';
    plagesGrp.innerHTML = plages.map(p=>{
      const checked = (dem.plageIds||[]).includes(p.id);
      return `<label class="chk-pill ${checked?'on':''}" onclick="togglePill(this)">
        <input type="checkbox" class="dem-plage-${i}" value="${p.id}" ${checked?'checked':''}>${p.nom}
      </label>`;
    }).join('');
  });
}

function resetEducForm(){
  var g=function(id){return document.getElementById(id);};
  if(g('me-id'))      g('me-id').value='';
  if(g('me-title'))   g('me-title').textContent='Nouvel educateur';
  ['me-prenom','me-nom','me-notes'].forEach(function(id){var el=g(id);if(el)el.value='';});
  if(g('me-contrat')) g('me-contrat').value='temps-plein';
  if(g('me-heures'))  g('me-heures').value='';
  if(g('me-h-field')) g('me-h-field').style.display='none';
  const pEl=document.getElementById('me-pause'); if(pEl) pEl.checked=false;
  document.querySelectorAll('#me-jours-grp .chk-pill').forEach((p,i)=>{
    const cb = p.querySelector('input');
    cb.checked = [0,1,2,3,4].includes(i);
    p.classList.toggle('on', cb.checked);
  });
  renderPlageCheckboxes([],[]);
  setTimeout(()=>renderDemandesForm([]), 10);
}

function renderPlageCheckboxes(prefs, excls){
  const pEl = document.getElementById('me-prefs');
  const eEl = document.getElementById('me-excls');
  if(!plages.length){
    pEl.innerHTML = '<span style="font-size:.78rem;color:var(--ink3)">Definissez d\'abord des plages.</span>';
    eEl.innerHTML = '';
    return;
  }
  pEl.innerHTML = plages.map(p=>`
    <label class="chk-pill ${prefs.includes(p.id)?'on':''}" onclick="togglePill(this)">
      <input type="checkbox" class="ep" value="${p.id}" ${prefs.includes(p.id)?'checked':''}>${p.nom}
    </label>`).join('');
  eEl.innerHTML = plages.map(p=>`
    <label class="chk-pill ${excls.includes(p.id)?'on':''}" onclick="togglePill(this)" style="--accent:#c02a2a;--accent-l:#fdeaea">
      <input type="checkbox" class="ee" value="${p.id}" ${excls.includes(p.id)?'checked':''}>${p.nom}
    </label>`).join('');
}

function openEditEduc(id){
  const e = educs.find(x=>x.id===id); if(!e) return;
  document.getElementById('me-id').value = id;
  document.getElementById('me-title').textContent = `Modifier ${e.prenom} ${e.nom}`;
  document.getElementById('me-prenom').value = e.prenom;
  document.getElementById('me-nom').value = e.nom;
  document.getElementById('me-contrat').value = e.contrat;
  document.getElementById('me-heures').value = e.heuresPerso||'';
  document.getElementById('me-h-field').style.display = e.contrat==='perso' ? '' : 'none';
  const pauseEl = document.getElementById('me-pause');
  if(pauseEl) pauseEl.checked = e.acceptePause||false;
  document.getElementById('me-notes').value = e.notes||'';
  document.querySelectorAll('#me-jours-grp .chk-pill').forEach(p=>{
    const cb = p.querySelector('input');
    cb.checked = (e.jours||[]).includes(+cb.value);
    p.classList.toggle('on', cb.checked);
  });
  renderPlageCheckboxes(e.prefs||[], e.excls||[]);
  openModal('modal-educ', null);
  setTimeout(()=>renderDemandesForm(e.demandes||[]), 10);
}

function saveEduc(){
  const prenom = document.getElementById('me-prenom').value.trim();
  const nom    = document.getElementById('me-nom').value.trim();
  if(!prenom||!nom){ alert('Prenom et nom requis.'); return; }
  const jours      = [...document.querySelectorAll('#me-jours-grp input:checked')].map(c=>+c.value);
  const prefs      = [...document.querySelectorAll('.ep:checked')].map(c=>+c.value);
  const excls      = [...document.querySelectorAll('.ee:checked')].map(c=>+c.value);
  var g2=function(id){return document.getElementById(id);};
  const contrat     = g2('me-contrat') ? g2('me-contrat').value : 'temps-plein';
  const heuresPerso = g2('me-heures')  ? (+g2('me-heures').value || null) : null;
  const pauseEl2    = g2('me-pause');
  const acceptePause= pauseEl2 ? pauseEl2.checked : false;
  const notes       = g2('me-notes')   ? g2('me-notes').value.trim() : '';
  const editId      = g2('me-id')      ? (+g2('me-id').value || null) : null;

  const demandes = [];
  [1,2].forEach(function(i){
    var jourEl = document.getElementById('me-dem-jour-'+i);
    var typeEl = document.getElementById('me-dem-type-'+i);
    if(!jourEl || !typeEl) return;
    var jour = +jourEl.value;
    var type = typeEl.value;
    var plageIds = [...document.querySelectorAll('.dem-plage-'+i+':checked')].map(function(c){return +c.value;});
    if(!isNaN(jour) && jour !== -1 && plageIds.length > 0){
      demandes.push({jour:jour, type:type, plageIds:plageIds});
    }
  });

  if(editId){
    const idx = educs.findIndex(e=>e.id===editId);
    if(idx>=0) educs[idx] = {...educs[idx], prenom, nom, contrat, heuresPerso, acceptePause, jours, prefs, excls, notes, demandes};
  } else {
    educs.push({id:Date.now(), prenom, nom, contrat, heuresPerso, acceptePause, jours, prefs, excls, notes, demandes, color:COLORS[educs.length%COLORS.length]});
  }
  save(); renderAll(); closeModal('modal-educ');
}

function delEduc(id){
  if(!confirm('Supprimer cet educateur ?')) return;
  educs = educs.filter(e=>e.id!==id);
  save(); renderAll();
}

function renderEducGrid(){
  const g = document.getElementById('educ-grid');
  document.getElementById('nb-educ').textContent = educs.length;
  if(!educs.length){
    g.innerHTML = '<div class="empty"><div class="icon">👤</div><p>Aucun educateur.<br>Cliquez sur "+ Nouvel educateur".</p></div>';
    return;
  }
  g.innerHTML = educs.map(e=>{
    const ini   = (e.prenom[0]+e.nom[0]).toUpperCase();
    const hS    = e.contrat==='perso' ? (e.heuresPerso||'?')+'h/sem' : CONTRAT_H[e.contrat]+'h/sem';
    const jours = (e.jours||[]).map(j=>JOURS[j]).join(' ');
    const prefs = (e.prefs||[]).map(id=>{ const p=plages.find(x=>x.id===id); return p?`<span class="badge b-blue">${p.nom}</span>`:''; }).join('');
    const excls = (e.excls||[]).map(id=>{ const p=plages.find(x=>x.id===id); return p?`<span class="badge b-red">✗ ${p.nom}</span>`:''; }).join('');
    const demandesHtml = (e.demandes||[]).map(d=>{
      const plageNames = (d.plageIds||[]).map(id=>{ const p=plages.find(x=>x.id===id); return p?p.nom:''; }).filter(Boolean).join('+');
      const jourLabel = JOURS[d.jour] !== undefined ? JOURS[d.jour] : '';
      const icon = d.type==='prefere' ? '⭐' : '⚠️';
      const color = d.type==='prefere' ? 'b-green' : 'b-orange';
      return plageNames ? `<span class="badge ${color}">${icon} ${jourLabel} : ${plageNames}</span>` : '';
    }).join('');
    return `<div class="educ-card">
      <div class="educ-top">
        <div class="avatar" style="background:${e.color||COLORS[0]}">${ini}</div>
        <div style="flex:1;min-width:0">
          <div class="educ-name">${e.prenom} ${e.nom}</div>
          <div class="educ-sub">${e.contrat} - ${hS} - ${jours}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="btn btn-outline btn-sm" onclick="openEditEduc(${e.id})">✏️</button>
          <button class="btn btn-red btn-sm" onclick="delEduc(${e.id})">🗑️</button>
        </div>
      </div>
      <div class="educ-tags">${prefs}${excls}${demandesHtml}</div>
      ${e.notes?`<div style="font-size:.72rem;color:var(--ink3);margin-top:6px;font-style:italic">"${e.notes}"</div>`:''}
    </div>`;
  }).join('');
}

// ================================================================
// PLAGES HORAIRES
// ================================================================
function addPlage(){
  const nom = document.getElementById('p-nom').value.trim();
  if(!nom){ alert('Donnez un nom a la plage.'); return; }
  const debut = document.getElementById('p-debut').value;
  const fin   = document.getElementById('p-fin').value;
  if(!debut||!fin){ alert('Heures requises.'); return; }
  const jours = [...document.querySelectorAll('#p-jours-grp input:checked')].map(c=>+c.value);
  if(!jours.length){ alert('Selectionnez au moins un jour.'); return; }
  const min   = +document.getElementById('p-min').value || 1;
  const max   = +document.getElementById('p-max').value || min;
  const tous  = document.getElementById('p-tous').checked;
  const color = document.getElementById('p-color').value || '#2a5fc8';
  const type  = document.getElementById('p-type').value;
  const [dh,dm] = debut.split(':').map(Number);
  const [fh,fm] = fin.split(':').map(Number);
  let dureeMin = (fh*60+fm) - (dh*60+dm);
  if(dureeMin<=0) dureeMin += 1440;
  plages.push({id:Date.now(), nom, type, debut, fin, dureeH:dureeMin/60, jours, min, max, tous, color});
  save(); renderAll();
  document.getElementById('p-nom').value = '';
  document.querySelectorAll('#p-jours-grp .chk-pill').forEach(p=>{ p.querySelector('input').checked=false; p.classList.remove('on'); });
  document.getElementById('p-tous').checked = false;
  document.getElementById('p-tous-pill').classList.remove('on');
}

function delPlage(id){
  if(!confirm('Supprimer cette plage ?')) return;
  plages = plages.filter(p=>p.id!==id);
  save(); renderAll();
}

function renderPlageList(){
  const el = document.getElementById('plage-list');
  document.getElementById('nb-plages').textContent = plages.length;
  if(!plages.length){ el.innerHTML='<div class="empty"><div class="icon">🕐</div><p>Aucune plage.</p></div>'; return; }
  el.innerHTML = plages.map(p=>{
    const jours = p.jours.map(j=>JOURS[j]).join(', ');
    // Detection automatique nuit vendredi
    const isNuitVen = (p.type==='nuit'||p.debut>='22:00'||(p.fin<='07:00'&&p.fin>'00:00'))
      && !(p.type==='reunion'||(p.nom||'').toLowerCase().includes('reunion'))
      && (p.jours||[]).includes(4); // index 4 = vendredi dans notre convention
    return `<div class="plage-row">
      <div class="plage-dot" style="background:${p.color}"></div>
      <div class="plage-info">
        <div class="plage-name">
          ${p.nom}
          ${p.tous?'<span class="badge b-orange" style="font-size:.65rem">Tous requis</span>':''}
          ${isNuitVen?'<span class="badge b-purple" style="font-size:.65rem">🌙 Nuit Ven. -- rotation propre</span>':''}
        </div>
        <div class="plage-detail">${p.debut} -> ${p.fin} - ${p.dureeH.toFixed(1)}h - min ${p.min} educ - ${jours}</div>
      </div>
      <button class="btn btn-red btn-sm" onclick="delPlage(${p.id})">Suppr.</button>
    </div>`;
  }).join('');
}

// ================================================================
// REGLES
// ================================================================
function renderRules(){
  renderRuleList('rules-legal',  reglesL, 'legal');
  renderRuleList('rules-intern', reglesI, 'internal');
  renderRuleList('rules-custom', reglesC, 'custom');
}
function renderRuleList(elId, arr, cat){
  const el = document.getElementById(elId);
  if(!arr.length && cat==='custom'){
    el.innerHTML='<div class="empty"><div class="icon">✏️</div><p>Aucune regle personnalisee.</p></div>';
    return;
  }
  el.innerHTML = arr.map(r=>`<div class="rule-row">
    <span style="font-size:1.1rem">${r.active?'✅':'⬜'}</span>
    <div class="rule-info"><div class="rule-name">${r.nom}</div><div class="rule-desc">${r.desc}</div></div>
    <input type="number" value="${r.value}" min="0" max="200" style="width:65px" onchange="updateRule('${cat}','${r.id}',this.value)">
    <span style="font-size:.72rem;color:var(--ink3);width:40px">${r.unit}</span>
    <input type="checkbox" ${r.active?'checked':''} onchange="toggleRule('${cat}','${r.id}',this.checked)" style="width:16px;height:16px">
    ${cat==='custom'?`<button class="btn btn-red btn-sm" onclick="delRule('${r.id}')">✕</button>`:''}
  </div>`).join('');
}
function getArr(cat){ return cat==='legal'?reglesL : cat==='internal'?reglesI : reglesC; }
function updateRule(cat,id,v){ getArr(cat).find(r=>r.id===id).value=+v; save(); }
function toggleRule(cat,id,v){ getArr(cat).find(r=>r.id===id).active=v; save(); }
function delRule(id){ reglesC=reglesC.filter(r=>r.id!==id); save(); renderRules(); }
function saveRule(){
  const nom = document.getElementById('r-nom').value.trim();
  if(!nom){ alert('Nom requis'); return; }
  reglesC.push({id:'c'+Date.now(), nom, desc:document.getElementById('r-desc').value,
    type:document.getElementById('r-type').value, value:+document.getElementById('r-val').value, unit:'', active:true});
  save(); renderRules(); closeModal('modal-rule');
}

// ================================================================
// ABSENCES
// ================================================================
function renderAbsEduc(){
  const s = document.getElementById('abs-educ'); if(!s) return;
  s.innerHTML = '<option value="">-- Choisir --</option>' +
    educs.map(e=>`<option value="${e.id}">${e.prenom} ${e.nom}</option>`).join('');
}
function addAbsence(){
  const educId = +document.getElementById('abs-educ').value;
  const debut  = document.getElementById('abs-debut').value;
  const fin    = document.getElementById('abs-fin').value;
  const type   = document.getElementById('abs-type').value;
  const note   = document.getElementById('abs-note').value.trim();
  if(!educId||!debut||!fin){ alert('Completez tous les champs.'); return; }
  if(debut>fin){ alert('La date de debut doit etre avant la fin.'); return; }
  absences.push({id:Date.now(), educId, debut, fin, type, note});
  save(); renderAbsList();
}
function delAbsence(id){ absences=absences.filter(a=>a.id!==id); save(); renderAbsList(); }
function renderAbsList(){
  const el = document.getElementById('abs-list'); if(!el) return;
  const icons = {conge:'🌴',maladie:'🤒',recup:'🔄',formation:'📚',autre:'📌'};
  if(!absences.length){ el.innerHTML='<div class="empty"><div class="icon">✅</div><p>Aucune absence.</p></div>'; return; }
  el.innerHTML = absences.map(a=>{
    const e = educs.find(x=>x.id===a.educId);
    return `<div class="plage-row">
      <span style="font-size:1.1rem">${icons[a.type]||'📌'}</span>
      <div class="plage-info">
        <div class="plage-name">${e?e.prenom+' '+e.nom:'Inconnu'} - ${a.type}</div>
        <div class="plage-detail">${a.debut} -> ${a.fin}${a.note?' - '+a.note:''}</div>
      </div>
      <button class="btn btn-red btn-sm" onclick="delAbsence(${a.id})">Suppr.</button>
    </div>`;
  }).join('');
}

// ================================================================
// JOURS FERIES
// ================================================================
function feriesBelges(yr){
  const a=yr%19,b=Math.floor(yr/100),c=yr%100;
  const d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31);
  const day=((h+l-7*m+114)%31)+1;
  const paques=new Date(yr,month-1,day);
  const add=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
  const fmt=d=>`${yr}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return[
    {date:`${yr}-01-01`,nom:"Jour de l'an"},
    {date:fmt(add(paques,1)),nom:"Lundi de Paques"},
    {date:`${yr}-05-01`,nom:"Fete du Travail"},
    {date:fmt(add(paques,39)),nom:"Ascension"},
    {date:fmt(add(paques,50)),nom:"Lundi de Pentecote"},
    {date:`${yr}-07-21`,nom:"Fete Nationale"},
    {date:`${yr}-08-15`,nom:"Assomption"},
    {date:`${yr}-11-01`,nom:"Toussaint"},
    {date:`${yr}-11-11`,nom:"Armistice"},
    {date:`${yr}-12-25`,nom:"Noel"},
  ];
}
function renderFeries(){
  const yr = +document.getElementById('ferie-yr').value || new Date().getFullYear();
  const belges = feriesBelges(yr);
  const el = document.getElementById('ferie-list');
  el.innerHTML = belges.map(f=>{
    const existing = joursFeries.find(x=>x.date===f.date);
    const active   = existing ? existing.active : false;
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <input type="checkbox" ${active?'checked':''} onchange="toggleFerie('${f.date}','${f.nom}',this.checked)" style="width:16px;height:16px">
      <span style="font-size:.85rem;flex:1"><strong>${f.date}</strong> - ${f.nom}</span>
      <span class="badge ${active?'b-green':'b-orange'}">${active?'Actif':'Inactif'}</span>
    </div>`;
  }).join('');
  const customs = joursFeries.filter(f=>!belges.find(b=>b.date===f.date));
  if(customs.length){
    el.innerHTML += `<div style="margin-top:12px;font-size:.72rem;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:1px">Personnalises</div>`;
    el.innerHTML += customs.map(f=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:.85rem;flex:1"><strong>${f.date}</strong> - ${f.nom}</span>
      <button class="btn btn-red btn-sm" onclick="delFerie('${f.date}')">Suppr.</button>
    </div>`).join('');
  }
}
function toggleFerie(date,nom,active){
  const idx = joursFeries.findIndex(f=>f.date===date);
  if(idx>=0) joursFeries[idx].active=active;
  else joursFeries.push({date,nom,active});
  save(); renderFeries();
}
function addFerie(){
  const date = document.getElementById('ferie-date').value;
  const nom  = document.getElementById('ferie-nom').value.trim() || 'Ferie';
  if(!date) return;
  if(!joursFeries.find(f=>f.date===date)) joursFeries.push({date,nom,active:true});
  save(); renderFeries();
  document.getElementById('ferie-date').value = '';
  document.getElementById('ferie-nom').value  = '';
}
function delFerie(date){ joursFeries=joursFeries.filter(f=>f.date!==date); save(); renderFeries(); }
function addAllFeries(){
  const yr = +document.getElementById('ferie-yr').value || new Date().getFullYear();
  feriesBelges(yr).forEach(f=>{
    const idx = joursFeries.findIndex(x=>x.date===f.date);
    if(idx>=0) joursFeries[idx].active=true;
    else joursFeries.push({...f,active:true});
  });
  save(); renderFeries();
}
function clearFeries(){ joursFeries.forEach(f=>f.active=false); save(); renderFeries(); }
