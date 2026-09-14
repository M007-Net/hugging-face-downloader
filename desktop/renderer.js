const api = window.downloader;
const state = { page:'new', status:null, catalog:null, link:'', loading:false, mode:'quant', bit:0, quant:'', model:'', vision:'', mtp:'', manual:new Set(), search:'', remember:true, job:null, update:null, dismissed:false };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = value => { if (!(Number(value) > 0)) return 'Unknown'; const n = Math.min(4, Math.floor(Math.log(value)/Math.log(1024))); return `${(value/1024**n).toFixed(n > 1 ? 2 : 0)} ${['B','KB','MB','GB','TB'][n]}`; };
const active = () => ['starting','downloading'].includes(state.job?.status);
const option = (value,text,current) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(text)}</option>`;
const explanations = {
  repo:['Start with a repository','A repository is the model’s folder on Hugging Face. Paste its link here and we’ll show the available files—nothing downloads yet.','Private or gated model? Add your read token in Settings.'],
  quant:['Find the right size','Quantization makes a model smaller. Lower bit levels usually use less memory, with a possible quality trade-off.','Start with a bit level, then choose an exact variant. The size shown is the download size, not the total memory needed to run it.'],
  companions:['Only the extras you need','Vision projectors add image support. MTP files can help compatible runtimes predict multiple tokens at a time.','These are optional, filename-detected candidates. Match them to the model and your runtime. Some models already include MTP.'],
  destination:['Keep your library organized','Each download gets an owner/repository folder. Split files and companion folders keep their original layout.','Choose your own location or the standard LM Studio folder. Your choice is remembered on this computer.'],
  downloads:['Pause now. Resume later.','Pause affects only downloads started in this desktop app. Partial files stay on disk and are reused when you resume.','You can also close the app after pausing. The last queue will be waiting when you open it again.'],
  settings:['Your setup, your choice','Preferences are saved locally. The desktop and terminal apps each keep their own settings.','A token entered here stays in memory for this session; it is never saved to the project or settings file.']
};
function help(key) { const h = explanations[key]; return `<aside class="help-column"><section class="help-card"><div class="help-kicker">A LITTLE GUIDANCE</div><h3 id="help-title">${h[0]}</h3><p id="help-body">${h[1]}</p><hr><p id="help-extra">${h[2]}</p></section><section class="glossary"><div class="tiny-label">GOOD TO KNOW</div><dl><dt>GGUF</dt><dd>A model format used by LM Studio and llama.cpp.</dd><dt>IQ3_XXS · Q4_K_M · Q8_0</dt><dd>Exact quantization variants. Options vary by repository.</dd><dt>Split files</dt><dd>One large model in several parts. We keep those parts together.</dd></dl></section></aside>`; }
function changeHelp(key) { if (!$('help-title')) return; const h = explanations[key]; $('help-title').textContent=h[0]; $('help-body').textContent=h[1]; $('help-extra').textContent=h[2]; }
function notify(message, good=false) { $('notice').textContent=message; $('notice').className=good?'success':'error'; $('notice').setAttribute('role',good?'status':'alert'); $('notice').setAttribute('aria-live',good?'polite':'assertive'); $('notice').hidden=!message; }
async function act(fn) { try { notify(''); await fn(); } catch(e) { notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,'')); } }
function chosen() {
  if (!state.catalog) return [];
  const files = state.mode === 'manual' ? state.catalog.files.filter(f => state.manual.has(f.path)) : (state.catalog.bundles.find(b => b.name === state.model)?.files || []);
  const extra = ['vision','mtp'].flatMap(k => state.catalog[k].find(b => b.name === state[k])?.files || []);
  return [...new Map([...files,...extra].map(f => [f.path,f])).values()];
}
function resetQuant() {
  const list = state.catalog.bundles.filter(b=>b.quant);
  const first = list.find(b=>b.quant===state.status.settings.quant) || list.find(b=>b.bits===4) || list[0];
  state.bit = first?.bits || 0; state.quant=first?.quant || ''; state.model=first?.name || '';
  state.mode=state.catalog.info.isFile || !list.length?'manual':'quant'; state.manual = new Set(state.catalog.info.isFile ? state.catalog.files.map(f=>f.path):[]);
  state.vision='';state.mtp=''; state.search='';
}
// Shown on every page once a newer release is found. Downloading is one click
// and installing is a separate one, because the installer is not code-signed.
function updateBanner() {
  const u = state.update;
  if (!u || !u.configured || state.dismissed) return '';
  const r = u.result;
  if (u.state === 'downloading') {
    const pct = r?.asset?.size ? Math.min(100, u.received / r.asset.size * 100) : 0;
    return `<div class="update-banner"><div><strong>Downloading version ${esc(r?.version)}</strong><small>${size(u.received)}${r?.asset?.size?' of '+size(r.asset.size):''} · verified against the published SHA-256 when it finishes.</small><div class="progress-track"><progress max="100" value="${pct}" aria-label="Update download progress"></progress></div></div></div>`;
  }
  if (u.state === 'ready') {
    return `<div class="update-banner ready"><div><strong>Version ${esc(r?.version)} is ready to install</strong><small>SHA-256 verified. The installer is not code-signed, so SmartScreen will still warn.</small></div><div class="links-row"><button class="primary" id="update-install">Install now</button><button id="update-reveal" class="subtle">Show the file</button></div></div>`;
  }
  if (!r || !r.available) return '';
  return `<div class="update-banner"><div><strong>Version ${esc(r.version)} is available</strong><small>You are on ${esc(u.currentVersion || state.status.version)}.${r.asset?'':' '+esc(r.reason || '')}</small></div><div class="links-row">${r.asset?'<button class="primary" id="update-download">Download update</button>':''}<button id="update-notes" class="subtle">Release notes</button><button id="update-dismiss" class="subtle">Not now</button></div></div>`;
}
function render() {
  if (!state.status) return;
  // A CSS class alone tells a screen reader nothing about which page is open.
  document.querySelectorAll('[data-page]').forEach(b=>{const on=b.dataset.page===state.page;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('breadcrumb').textContent={new:'New download',downloads:'Downloads',settings:'Settings'}[state.page];
  $('version').textContent='v'+state.status.version; $('engine-pill').textContent=state.status.aria?'● aria2 found':'Set up aria2'; $('engine-pill').classList.toggle('ready',!!state.status.aria);
  $('queue-badge').textContent=active()?'1':'';
  // Replacing #app destroys every node in it, so whatever had focus loses it and focus
  // falls back to <body>. Ticking five checkboxes meant tabbing from the top of the page
  // five times, and the file list scrolled back to the top each time. Remember where the
  // user was and put them back.
  const before=document.activeElement;
  const focusKey=before&&$('app')&&$('app').contains(before)?(before.id||(before.dataset&&before.dataset.file?'file:'+before.dataset.file:'')):'';
  const caret=before&&typeof before.selectionStart==='number'?[before.selectionStart,before.selectionEnd]:null;
  const scroll=document.querySelector('.file-list')?.scrollTop||0;
  $('app').innerHTML=updateBanner()+(state.page==='new'?newPage():state.page==='downloads'?downloadsPage():settingsPage());
  const list=document.querySelector('.file-list');
  if (list && scroll) list.scrollTop=scroll;
  if (focusKey) {
    const again=focusKey.startsWith('file:')
      ? $('app').querySelector(`[data-file="${CSS.escape(focusKey.slice(5))}"]`)
      : document.getElementById(focusKey);
    if (again) {
      again.focus({ preventScroll:true });
      if (caret && typeof again.setSelectionRange === 'function') {
        try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text input */ }
      }
    }
  }
}
function newPage() {
  const c=state.catalog; const selected=chosen(); const total=selected.reduce((n,f)=>n+f.size,0);
  return `<div class="heading"><div class="eyebrow">NEW DOWNLOAD</div><h1>Download a model from Hugging Face</h1><p>Review the repository files before anything is written to disk.</p></div><div class="layout"><div class="flow">
  <section class="card" data-help="repo"><div class="section-title"><h2><span class="step">1</span> Find your model</h2><span class="caption">Hugging Face</span></div><form id="repo-form"><label for="repo">Model link or repository name</label><div class="row field-note"><input id="repo" placeholder="huggingface.co/owner/model-GGUF" value="${esc(state.link)}" ${active()?'disabled':''}><button class="primary" type="submit" ${state.loading||active()?'disabled':''}>${state.loading?'Loading…':'Load model'}</button></div></form>${c?`<div class="repo-name">✓ ${esc(c.info.repo)} <span class="caption"> · ${esc(c.info.rev)} · ${c.files.length} files</span></div>${c.skipped?`<div class="hint">${c.skipped} file${c.skipped===1?'':'s'} in this repository cannot be saved with a Windows-safe name and ${c.skipped===1?'was':'were'} left out.</div>`:''}`:'<div class="hint">Repository links, folder links, and direct file links all work.</div>'}</section>
  ${active()?'<div class="busy-note">A download is running. Visit Downloads to follow its progress.</div>':''}
  ${c?`<section class="card" data-help="quant"><div class="section-title"><h2><span class="step">2</span> Choose what to download</h2></div><div class="segmented" role="group" aria-label="Selection mode"><button data-mode="quant" aria-pressed="${state.mode==='quant'}" class="${state.mode==='quant'?'selected':''}" ${!c.bundles.some(b=>b.quant)?'disabled':''}>Choose quantization</button><button data-mode="manual" aria-pressed="${state.mode==='manual'}" class="${state.mode==='manual'?'selected':''}">Choose specific files</button></div>${state.mode==='quant'?quantFields():manualFields()}</section>
  <section class="card" data-help="companions"><div class="section-title"><h2><span class="step">3</span> Optional companions</h2><span class="caption">Your choice</span></div>${companion('vision','Vision / images','Adds image support when your runtime supports this model.')}${companion('mtp','MTP / faster generation','Optional prediction helper for compatible runtimes.')}</section>
  <section class="card" data-help="destination"><div class="section-title"><h2><span class="step">4</span> Choose a home</h2></div><label>Download folder<input id="output" value="${esc(state.status.settings.outputDir)}" readonly></label><div class="links-row"><button id="browse" class="subtle">Browse folders</button><button id="lm" class="subtle">Use LM Studio folder</button></div><div class="hint">Files stay organized under ${esc(c.info.repo)}.</div></section>
  <section class="review"><div class="review-top"><div><strong>${size(total)}</strong><small>${selected.length} file${selected.length===1?'':'s'} selected · review below</small></div><button id="download" class="primary" ${!selected.length||active()||(!validSelection())?'disabled':''}>Download selected</button></div><details><summary>Review selected files</summary><div class="file-list">${selected.map(f=>`<div class="file-row"><span class="filename">${esc(f.path)}</span><span class="size">${size(f.size)}</span></div>`).join('')}</div></details></section>`:
  '<section class="empty"><div class="empty-symbol">↓</div><h2>No repository loaded</h2><p>Paste a Hugging Face repository, folder, or file link to inspect it.</p><div class="empty-steps"><span>Choose files</span><span>Review</span><span>Download</span></div></section>'}
  </div>${help(c?'quant':'repo')}</div>`;
}
function validSelection() {
  if (state.mode==='quant' && !state.catalog?.bundles.find(b=>b.name===state.model)?.complete) return false;
  return ['vision','mtp'].every(k=>!state[k] || state.catalog[k].find(b=>b.name===state[k])?.complete);
}
function quantFields() {
  const list=state.catalog.bundles.filter(b=>b.quant); const levels=[...new Set(list.map(b=>b.bits))].sort((a,b)=>a-b); const quants=[...new Set(list.filter(b=>b.bits===state.bit).map(b=>b.quant))].sort(); const models=list.filter(b=>b.quant===state.quant); const b=models.find(b=>b.name===state.model);
  return `<div class="field-row"><label>Bit level<select id="bit">${levels.map(n=>option(String(n),n+'-bit',String(state.bit))).join('')}</select></label><label>Exact quantization<select id="quant">${quants.map(q=>option(q,q+(q===state.status.settings.quant?' · your default':''),state.quant)).join('')}</select></label></div>${models.length>1?`<label class="model-choice">Model bundle<select id="model">${models.map(m=>option(m.name,m.name,state.model)).join('')}</select></label>`:''}<div class="choice-note"><span>${b?.complete?`✓ ${b.files.length>1?b.files.length+' split files, selected together':'One model file'}`:'Missing split files · choose another variant'}</span><b>${size(b?.size)}</b></div><label class="check field-gap"><input type="checkbox" id="remember" ${state.remember?'checked':''}>Remember this quantization for next time</label><p class="radio-caption">Only variants available in this repository are shown.</p>`;
}
function manualFields() { return `<input id="file-search" class="field-gap" aria-label="Filter files" placeholder="Filter by filename…" value="${esc(state.search)}"><div class="toolbar"><span id="manual-count">${state.manual.size} selected</span><div><button id="select-visible">Select visible</button> <button id="clear-files">Clear</button></div></div><div class="file-list" id="manual-list">${manualList()}</div>`; }
function manualList() { return state.catalog.files.filter(f=>f.path.toLowerCase().includes(state.search.toLowerCase())).map(f=>`<label class="file-row"><input type="checkbox" data-file="${esc(f.path)}" ${state.manual.has(f.path)?'checked':''}><span class="filename">${esc(f.path)}</span><span class="size">${size(f.size)}</span></label>`).join('') || '<p>No filenames match.</p>'; }
function companion(key,title,explanation) {
  const list=state.catalog[key];
  return `<div class="companion"><label class="check"><input type="checkbox" data-companion="${key}" ${state[key]?'checked':''} ${!list.length?'disabled':''}>${title}<span class="tag ${list.length?'':'neutral'}">${list.length?'FILENAME MATCH':'NOT FOUND'}</span></label><small>${list.length?explanation+' Compatibility is not verified.':'No separate file detected here. It may be embedded or hosted elsewhere.'}</small>${state[key]?`<select aria-label="${title} file" data-extra="${key}">${list.map(b=>option(b.name,`${b.name} · ${size(b.size)}${b.complete?'':' · missing parts'}`,state[key])).join('')}</select>`:''}</div>`;
}
function downloadsPage() {
  const j=state.job; const total=j?.files.reduce((n,f)=>n+f.size,0)||0; const done=j?.files.reduce((n,f)=>n+f.completed,0)||0; const speed=j?.files.reduce((n,f)=>n+f.speed,0)||0; const pct=total?Math.min(100,done/total*100):null; // null = no sizes reported, so a percentage would be a lie
  return `<div class="heading"><div class="eyebrow">DOWNLOADS</div><h1>${j?.status==='complete'?'Download complete':'Downloads'}</h1><p>Pause or resume downloads started by this app.</p></div><div class="layout"><div class="flow">${j?`<div class="stats"><div class="stat"><span>Progress</span><strong>${pct===null?size(done)+" downloaded":pct.toFixed(1)+"%"}</strong></div><div class="stat"><span>Download speed</span><strong>${size(speed)}/s</strong></div><div class="stat"><span>Completed files</span><strong>${j.files.filter(f=>f.status==='complete').length} / ${j.files.length}</strong></div></div><section class="card"><div class="section-title"><h2>${esc(j.info.repo)}</h2><span class="transfer-status">${esc(j.status)}</span></div>${j.error?`<div class="error">${esc(j.error)}</div>`:''}<div class="progress-track"><progress max="100" value="${pct}" aria-label="Overall download progress"></progress></div><small>${size(done)} of ${size(total)}</small><div class="links-row">${active()?'<button id="pause">Pause download</button>':j.status!=='complete'?'<button class="primary" id="resume">Resume / retry</button>':''}<button id="open-folder">Open download folder</button></div><p class="mono">${esc(j.destination)}</p>${j.files.map(f=>`<div class="transfer-file"><div class="row"><span>${esc(f.path)}</span><span class="transfer-status${f.status==='error'?' failed':''}">${esc(f.status)}</span></div><small>${size(f.completed)} / ${size(f.size)}${f.speed?' · '+size(f.speed)+'/s':''}</small>${f.error?`<small class="failed">${esc(f.error)}</small>`:''}</div>`).join('')}</section>`:'<section class="empty"><div class="empty-symbol">↓</div><h2>No downloads yet</h2><p>Start with a model link. You can review every file before downloading.</p><button class="primary field-gap" data-page="new">Find a model</button></section>'}</div>${help('downloads')}</div>`;
}
function updateSettings() {
  const u=state.update;
  if (!u || !u.configured) return `<p>This build has no update source configured. Whoever packaged it needs to set the <code>repository</code> field in <code>package.json</code> to their GitHub repository, as described in the README.</p><small class="field-note">You are running v${esc(state.status.version)}.</small>`;
  const r=u.result;
  const line = u.state==='checking' ? 'Checking GitHub for a newer release…'
    : u.state==='downloading' ? 'Downloading the update…'
    : u.state==='ready' ? `Version ${esc(r?.version)} is downloaded and SHA-256 verified.`
    : r?.available ? `Version ${esc(r.version)} is available.`
    : r ? 'You are running the latest published release.'
    : 'No update check has run yet.';
  return `<p>Update checks ask GitHub for this project's latest release. Nothing is downloaded or installed without a click, and a downloaded installer is discarded unless its SHA-256 matches the one published with the release.</p><div class="links-row"><button type="button" id="update-check" ${['checking','downloading'].includes(u.state)?'disabled':''}>Check for updates</button>${r?.releaseUrl?'<button type="button" id="update-notes" class="subtle">Release notes</button>':''}</div><small class="field-note">${line}${u.error?' '+esc(u.error):''}</small>`;
}
function settingsPage() {
  const s=state.status.settings;
  return `<div class="heading"><div class="eyebrow">SETTINGS</div><h1>Settings</h1><p>Configure the download folder, aria2, and Hugging Face access.</p></div><div class="layout"><form class="flow" id="settings-form"><section class="card" data-help="destination"><h2>Download location</h2><label class="field-gap">Default folder<input id="setting-output" value="${esc(s.outputDir)}"></label><div class="links-row"><button type="button" id="settings-browse">Browse folders</button><button type="button" id="settings-lm" class="subtle">Use LM Studio folder</button></div></section>
  <section class="card" data-help="settings"><h2>Download engine</h2><p>aria2 handles fast, resumable transfers in the background.</p><label class="field-gap">aria2 executable <span class="caption">(blank = detect automatically)</span><input id="setting-aria" value="${esc(s.aria2Path)}" placeholder="Auto-detect aria2c.exe"></label><div class="links-row"><button id="settings-aria" type="button">Choose executable</button><button id="aria-help" type="button" class="subtle">Get aria2</button></div><small class="field-note">${state.status.aria?'Detected: '+esc(state.status.aria):'Not installed? Get aria2, extract it, then choose aria2c.exe above. Or install with: winget install aria2.aria2'}</small><div class="field-row"><label>Connections per file<input type="number" min="1" max="16" id="setting-connections" value="${s.connections}"></label><label class="check"><input id="setting-ipv4" type="checkbox" checked disabled>IPv4 only <span class="tag">ENFORCED</span></label></div><small class="field-note">Hugging Face downloads always use IPv4. Try fewer connections if your network struggles.</small></section>
  <section class="card" data-help="settings"><h2>Hugging Face access</h2><p>Public models need no token. Private and gated models may need a read token and approved access.</p><label class="field-gap">Read token <span class="caption">(this session only)</span><input id="setting-token" type="password" autocomplete="off" placeholder="${state.status.tokenAvailable?'A token is already available · leave blank to keep it':'Optional Hugging Face token'}"></label><small class="field-note">We also detect your token from the environment or Hugging Face’s local token cache.${state.status.tokenError?' Token error: '+esc(state.status.tokenError):''}</small><label class="field-gap">Preferred quantization<input id="setting-quant" value="${esc(s.quant)}" placeholder="For example, IQ3_XXS"></label><small class="field-note">Used only when that exact variant is available.</small></section>
  <section class="card" data-help="settings"><h2>Updates</h2>${updateSettings()}</section><div class="setting-actions"><button class="primary" type="submit" ${active()?'disabled':''}>Save settings</button></div></form>${help('settings')}</div>`;
}
document.addEventListener('input',e=>{ if(e.target.id==='repo')state.link=e.target.value; if(e.target.id==='file-search'){state.search=e.target.value;$('manual-list').innerHTML=manualList();} });
document.addEventListener('focusin',e=>{const s=e.target.closest('[data-help]');if(s)changeHelp(s.dataset.help);});
document.addEventListener('mouseover',e=>{const s=e.target.closest('[data-help]');if(s)changeHelp(s.dataset.help);});
document.addEventListener('change',e=>act(async()=>{
  const t=e.target;
  if(t.id==='bit'){state.bit=Number(t.value);state.quant=state.catalog.bundles.find(b=>b.bits===state.bit).quant;state.model=state.catalog.bundles.find(b=>b.quant===state.quant).name;render();}
  if(t.id==='quant'){state.quant=t.value;state.model=state.catalog.bundles.find(b=>b.quant===state.quant).name;render();}
  if(t.id==='model'){state.model=t.value;render();}
  if(t.id==='remember')state.remember=t.checked;
  if(t.dataset.companion){state[t.dataset.companion]=t.checked?state.catalog[t.dataset.companion][0].name:'';render();changeHelp('companions');}
  if(t.dataset.extra){state[t.dataset.extra]=t.value;render();changeHelp('companions');}
  if(t.dataset.file){const key=t.dataset.file.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i,'');for(const f of state.catalog.files.filter(f=>f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i,'')===key)){if(t.checked)state.manual.add(f.path);else state.manual.delete(f.path);}render();}
}));
document.addEventListener('submit',e=>{e.preventDefault();act(async()=>{
  if(e.target.id==='repo-form'){state.link=$('repo').value;state.loading=true;state.catalog=null;render();try{state.catalog=await api.loadRepo(state.link);resetQuant();}finally{state.loading=false;render();}}
  if(e.target.id==='settings-form'){const v={outputDir:$('setting-output').value,aria2Path:$('setting-aria').value,connections:Number($('setting-connections').value),disableIPv6:true,quant:$('setting-quant').value.trim()};if($('setting-token').value)v.token=$('setting-token').value;state.status=await api.saveSettings(v);render();notify('Settings saved on this computer. IPv4-only mode is enforced.',true);}
});});
document.addEventListener('click',e=>{const t=e.target.closest('button');if(!t)return;act(async()=>{
  if(t.dataset.page){state.page=t.dataset.page;render();return;}
  if(t.dataset.mode){state.mode=t.dataset.mode;render();return;}
  if(t.id==='engine-pill'){state.page='settings';render();}
  if(t.id==='terminal')await api.openTerminal();
  if(['browse','lm'].includes(t.id)){const outputDir=t.id==='browse'?await api.chooseFolder():await api.lmFolder();if(outputDir){state.status=await api.saveSettings({outputDir});render();}}
  if(['settings-browse','settings-lm'].includes(t.id)){const folder=t.id==='settings-browse'?await api.chooseFolder():await api.lmFolder();if(folder)$('setting-output').value=folder;}
  if(t.id==='settings-aria'){const p=await api.chooseAria();if(p)$('setting-aria').value=p;}
  if(t.id==='aria-help')await api.ariaHelp();
  if(t.id==='clear-files'){state.manual.clear();render();}
  if(t.id==='select-visible'){const visible=state.catalog.files.filter(f=>f.path.toLowerCase().includes(state.search.toLowerCase()));for(const chosen of visible){const key=chosen.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i,'');for(const f of state.catalog.files.filter(f=>f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i,'')===key))state.manual.add(f.path);}render();}
  // Disabled synchronously, before the first await. A second click used to reach
  // saveSettings while the first click's download was already running, and came back as
  // "Pause the download before changing settings" - a settings error for a download that
  // had in fact started correctly.
  if(t.id==='download'){t.disabled=true;if(state.remember&&state.mode==='quant')state.status=await api.saveSettings({quant:state.quant});state.job=await api.start(chosen().map(f=>f.path));state.page='downloads';render();}
  if(t.id==='pause'){t.disabled=true;t.textContent='Pausing…';state.job=await api.pause();render();}
  if(t.id==='resume'){state.job=await api.resume();render();}
  if(t.id==='open-folder')await api.openFolder();
  if(t.id==='update-check'){state.dismissed=false;state.update=await api.checkUpdate();render();}
  if(t.id==='update-download'){t.disabled=true;state.update=await api.downloadUpdate();render();}
  if(t.id==='update-install')await api.installUpdate();
  if(t.id==='update-reveal')await api.revealUpdate();
  if(t.id==='update-notes')await api.openRelease();
  if(t.id==='update-dismiss'){state.dismissed=true;render();}
});});
api.onProgress(job=>{state.job=job;if(state.page==='downloads')render();else $('queue-badge').textContent=active()?'1':'';});
api.onUpdateState(value=>{state.update=value;if(state.status)render();});
act(async()=>{state.status=await api.status();state.job=state.status.job;state.update=state.status.update;render();});
