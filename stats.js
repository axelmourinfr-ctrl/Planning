// ============================================================
// stats.js — Soldes heures et statistiques prestations
// ============================================================

// ================================================================
// SOLDES HEURES
// ================================================================
function renderSoldes(){
  updateMonthLabels();
  const horizon = +document.getElementById('sol-horizon').value || 3;
  const el      = document.getElementById('sol-content');
  if(!educs.length){
    el.innerHTML = '<div class="empty"><div class="icon">⏱️</div><p>Aucun éducateur.</p></div>';
    return;
  }
  const [yr,mo] = currentMonth.split('-').map(Number);

  // Identifier les mois avec données
  const moisDispo = [];
  for(let i=0; i<horizon; i++){
    const key = moisKey(yr, mo-i);
    if(horaire[key] && Object.keys(horaire[key]).length>0){
      const [ky,km] = key.split('-').map(Number);
      moisDispo.push({key, yr:ky, mo:km});
    }
  }

  if(!moisDispo.length){
    el.innerHTML = '<div class="empty"><div class="icon">⏱️</div><p>Aucun horaire généré pour ce mois.<br>Allez dans "Générer" pour créer un horaire.</p></div>';
    return;
  }

  const cards = educs.map(e=>{
    let totalTrav   = 0;
    let targetTotal = 0;

    moisDispo.forEach(({key, yr:ky, mo:km})=>{
      const plan = horaire[key];
      // Cible réelle : jours ouvrables (lun-ven) hors fériés actifs × 7.6h × ratio
      const ratio = getTargetH(e) / 38;
      const joursOuvrables = getDays(ky,km).filter(day=>{
        const dow = day.getDay();
        if(dow < 1 || dow > 5) return false;
        if(isFerie(dayStr(day))) return false;
        return true;
      });
      targetTotal += joursOuvrables.length * 7.6 * ratio;

      getDays(ky,km).forEach(day=>{
        const ds = dayStr(day);
        if(isAbsent(e.id,ds)) return;
        plages.forEach(p=>{
          const ids = ((plan[ds]||{})[p.id]||[]);
          if(ids.map(x=>+x).includes(e.id)) totalTrav += p.dureeH;
        });
      });
    });
    const solde       = totalTrav - targetTotal;
    const tol         = getRule('tol_heures', 15);
    const ok          = Math.abs(solde) <= tol;
    const ratio       = Math.min(1.2, totalTrav / Math.max(1, targetTotal));
    const ini         = (e.prenom[0]+e.nom[0]).toUpperCase();
    return `<div class="balance-card">
      <div class="balance-top">
        <div class="avatar" style="background:${e.color||COLORS[0]};width:36px;height:36px;font-size:.8rem">${ini}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.88rem">${e.prenom} ${e.nom}</div>
          <div style="font-size:.72rem;color:var(--ink3)">${e.contrat} · cible ${targetTotal.toFixed(0)}h / ${moisDispo.length} mois</div>
        </div>
        <span class="badge ${ok?'b-green':solde>0?'b-orange':'b-red'}">${solde>=0?'+':''}${solde.toFixed(1)}h</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--ink3);margin-bottom:4px">
        <span>Travaillées: <strong>${totalTrav.toFixed(1)}h</strong></span>
        <span>Cible: <strong>${targetTotal.toFixed(0)}h</strong></span>
      </div>
      <div class="balance-bar"><div class="balance-fill" style="width:${Math.min(100,ratio*100).toFixed(0)}%;background:${ok?'var(--green)':solde>0?'var(--orange)':'var(--red)'}"></div></div>
    </div>`;
  }).join('');
  el.innerHTML = cards;
}

// ================================================================
// STATS PRESTATIONS
// ================================================================
function renderStats(){
  updateMonthLabels();
  const horizon = +document.getElementById('stats-horizon').value || 3;
  const el      = document.getElementById('stats-content');
  if(!educs.length || !plages.length){
    el.innerHTML = '<div class="empty"><div class="icon">📊</div><p>Configurez éducateurs et plages d\'abord.</p></div>';
    return;
  }
  const [yr,mo] = currentMonth.split('-').map(Number);

  // Initialiser stats
  const stats = {};
  educs.forEach(e=>{
    stats[e.id] = {totalH:0, we:0, ferie:0, nuits:0, plages:{}};
    plages.forEach(p=>{ stats[e.id].plages[p.id]=0; });
  });

  let moisTrouves = 0;
  for(let i=0; i<horizon; i++){
    const key  = moisKey(yr, mo-i);
    const plan = horaire[key];
    if(!plan || !Object.keys(plan).length) continue;
    moisTrouves++;
    const [ky,km] = key.split('-').map(Number);
    getDays(ky,km).forEach(day=>{
      const ds    = dayStr(day);
      const we    = day.getDay()===0 || day.getDay()===6;
      const ferie = isFerie(ds);
      Object.entries(plan[ds]||{}).forEach(([pid,ids])=>{
        if(pid==='_status') return;
        const p = plages.find(x=>x.id===+pid); if(!p) return;
        const nuit = p.type==='nuit' || p.debut>='22:00';
        ids.forEach(eid=>{
          const numEid = +eid;
          if(stats[numEid]===undefined) return;
          stats[numEid].totalH += p.dureeH;
          stats[numEid].plages[p.id] = (stats[numEid].plages[p.id]||0)+1;
          if(we)    stats[numEid].we++;
          if(ferie) stats[numEid].ferie++;
          if(nuit)  stats[numEid].nuits++;
        });
      });
    });
  }

  if(moisTrouves===0){
    el.innerHTML = '<div class="empty"><div class="icon">📊</div><p>Aucun horaire généré pour ce mois ou les mois précédents.</p></div>';
    return;
  }

  const avgH     = educs.reduce((s,e)=>s+stats[e.id].totalH,0) / Math.max(1,educs.length);
  const avgNuits = educs.reduce((s,e)=>s+stats[e.id].nuits,0)  / Math.max(1,educs.length);
  const avgWe    = educs.reduce((s,e)=>s+stats[e.id].we,0)     / Math.max(1,educs.length);
  const avgFerie = educs.reduce((s,e)=>s+stats[e.id].ferie,0)  / Math.max(1,educs.length);

  let html = `<div class="card"><div class="sch-wrap"><table style="border-collapse:collapse;width:100%;font-size:.78rem">
    <thead><tr>
      <th style="background:var(--ink);color:#fff;padding:10px 12px;text-align:left;min-width:140px">Éducateur</th>
      <th style="background:var(--ink);color:#fff;padding:10px 8px;text-align:center">Total H</th>
      <th style="background:var(--ink);color:#fff;padding:10px 8px;text-align:center">🌙 Nuits</th>
      <th style="background:var(--ink);color:#fff;padding:10px 8px;text-align:center">📅 WE</th>
      <th style="background:var(--ink);color:#fff;padding:10px 8px;text-align:center">🎉 Fériés</th>
      ${plages.map(p=>`<th style="background:${p.color};color:#fff;padding:10px 8px;text-align:center;font-size:.7rem;max-width:80px">${p.nom}</th>`).join('')}
    </tr></thead><tbody>`;

  educs.forEach((e,i)=>{
    const s     = stats[e.id];
    const diffH = s.totalH - avgH;
    const hColor = Math.abs(diffH)<5 ? 'var(--green)' : diffH>0 ? 'var(--orange)' : 'var(--red)';
    html += `<tr style="background:${i%2===0?'var(--surface)':'var(--surface2)'}">
      <td style="padding:8px 12px">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="avatar" style="background:${e.color};width:28px;height:28px;font-size:.68rem">${(e.prenom[0]+e.nom[0]).toUpperCase()}</div>
          <span style="font-weight:600">${e.prenom} ${e.nom}</span>
        </div>
      </td>
      <td style="padding:8px;text-align:center;font-weight:700;color:${hColor}">
        ${s.totalH.toFixed(1)}h
        <div style="font-size:.68rem;color:var(--ink3);font-weight:400">${diffH>=0?'+':''}${diffH.toFixed(1)}</div>
      </td>
      <td style="padding:8px;text-align:center;font-weight:600">${s.nuits}</td>
      <td style="padding:8px;text-align:center;font-weight:600">${s.we}</td>
      <td style="padding:8px;text-align:center;font-weight:600">${s.ferie}</td>
      ${plages.map(p=>{
        const cnt     = s.plages[p.id] || 0;
        const avgCnt  = educs.reduce((sum,ex)=>sum+(stats[ex.id]?.plages[p.id]||0),0) / Math.max(1,educs.length);
        const diff    = cnt - avgCnt;
        const bg      = Math.abs(diff)<0.5 ? '' : diff>0 ? 'rgba(212,128,10,.1)' : 'rgba(192,42,42,.07)';
        return `<td style="padding:8px;text-align:center;font-weight:600;background:${bg}">
          ${cnt}<div style="font-size:.65rem;color:var(--ink3);font-weight:400">${diff>=0?'+':''}${diff.toFixed(1)}</div>
        </td>`;
      }).join('')}
    </tr>`;
  });

  // Ligne moyennes
  html += `<tr style="background:var(--ink);color:#fff;font-weight:700">
    <td style="padding:8px 12px">Moyenne</td>
    <td style="padding:8px;text-align:center">${avgH.toFixed(1)}h</td>
    <td style="padding:8px;text-align:center">${avgNuits.toFixed(1)}</td>
    <td style="padding:8px;text-align:center">${avgWe.toFixed(1)}</td>
    <td style="padding:8px;text-align:center">${avgFerie.toFixed(1)}</td>
    ${plages.map(p=>{
      const avg = educs.reduce((s,e)=>s+(stats[e.id].plages[p.id]||0),0)/Math.max(1,educs.length);
      return `<td style="padding:8px;text-align:center">${avg.toFixed(1)}</td>`;
    }).join('')}
  </tr>`;

  html += '</tbody></table></div></div>';
  el.innerHTML = html;
}
