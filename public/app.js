import {FileSystem, Shell, STATES, quoteArg} from './shell.js';

const el = id => document.getElementById(id);
const command = el('command'), transcript = el('transcript'), screen = el('screen');
let fs, shell, busy = false, historyPos = 0, draft = '', catalogVersion;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action, className) {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function scrollEnd() { screen.scrollTop = screen.scrollHeight; }
function clearScreen() { transcript.replaceChildren(); el('welcome')?.remove(); }
function prompt(path) {
  const tag = element('span');
  tag.append(element('span','guest@hachile','token'), document.createTextNode(':'), element('span', path,'prompt-path'), document.createTextNode('$ '));
  return tag;
}
function logCommand(line) {
  const record = element('div',undefined,'record');
  const echo = element('p',undefined,'echo');
  echo.append(prompt(shell.cwd), document.createTextNode(line));
  record.append(echo); transcript.append(record);
  return record;
}
function showChunks(area, rows, display, pageSize, label) {
  let index = 0;
  function show() {
    const stop = Math.min(index + pageSize, rows.length);
    display(rows.slice(index, stop)); index = stop;
    if (index < rows.length) {
      const more = button(label + '（剩余 ' + (rows.length-index) + '）', () => {
        more.remove();
        show();
      }, 'more');
      area.append(more);
    }
  }
  show();
}
function output(area, result) {
  if (result.clear) {clearScreen(); return;}
  if (result.open) {window.location.assign(result.open); return;}
  if (result.items) {
    const wrap = element('div',undefined,'dirlist');
    if (result.vertical) wrap.style.display = 'grid';
    for (const it of result.items) wrap.append(button(it.label, () => inspectPath(it.path,it.dir), it.dir ? 'dir' : 'file'));
    area.append(wrap); return;
  }
  if (result.links?.length) {
    const wrap = element('div',undefined,'link-list'); area.append(wrap);
    showChunks(wrap, result.links.map(([label,url],i) => ({label,url,idx:i+1})), rows => {
      for (const {label,url,idx} of rows) {
        let address;
        try {address = new URL(url);} catch {continue;}
        if (!['https:','http:'].includes(address.protocol)) continue;
        const a = element('a',idx + '. ' + label + '  ' + url);
        a.href = address.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; wrap.append(a);
      }
    },40,'更多链接');
    return;
  }
  if (result.results?.length) {
    showChunks(area, result.results, rows => {
      for (const row of rows) {
        const hit = element('div',undefined,'hit');
        hit.append(button(row.label, () => inspectPath(row.path,false),'output-link'),element('p',row.excerpt,'out'));
        area.append(hit);
      }
    },18,'更多匹配');
    return;
  }
  const content = result.text || result.empty;
  if (content) showChunks(area, content.split('\n'), rows => area.append(element('pre',rows.join('\n'),'out')), result.paged ? 22 : 120,'继续阅读');
}
function updatePath() {
  el('cwd').textContent = shell.cwd;
  el('cwd').title = shell.cwd;
  for (const node of el('volumes').querySelectorAll('button')) node.setAttribute('aria-current', String(node.dataset.id === shell.cwd.split('/')[2]));
}
function toggleMounts(visible) {
  el('mounts').classList.toggle('visible', visible);
  el('toggle-mounts').setAttribute('aria-expanded',String(visible));
}
async function execute(lines, focus = true) {
  if (!shell || busy) return;
  busy = true; el('run').disabled = true; command.setAttribute('aria-busy','true');
  toggleMounts(false);
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = logCommand(line);
    scrollEnd();
    try { output(record, await shell.run(line)); }
    catch (error) { record.append(element('p',error.message,'error')); break; }
    finally {
      updatePath();
      // Keep the beginning of a long result in view.
      if (record.isConnected) screen.scrollTop += Math.min(record.getBoundingClientRect().top-screen.getBoundingClientRect().top-10, Math.max(0,screen.scrollHeight-screen.clientHeight-screen.scrollTop));
    }
  }
  historyPos = shell.history.length; draft = '';
  busy = false; command.removeAttribute('aria-busy'); el('run').disabled = false;
  if (focus && matchMedia('(min-width:761px)').matches) command.focus({preventScroll:true});
}
function inspectPath(path, dir) { return execute(dir ? ['cd ' + quoteArg(path), 'ls'] : ['less ' + quoteArg(path)]); }
function listSites() {
  const query = el('filter').value.trim().toLowerCase();
  const list = el('volumes'); list.replaceChildren();
  for (const site of fs.catalog.sites) {
    if (![site.id,site.name,site.url].join(' ').toLowerCase().includes(query)) continue;
    const node = button('', () => inspectPath('/sites/' + site.id,true), 'volume');
    const icon = element('i',undefined,'folder'); icon.setAttribute('aria-hidden','true');
    node.dataset.id = site.id; node.title = site.name + ' / ' + site.description + ' (' + STATES[site.state] + ')';
    node.setAttribute('aria-label',site.name + '，' + site.count + ' 页，' + STATES[site.state]);
    node.append(icon,element('span',site.id),element('small',site.count || '—')); list.append(node);
  }
  if (!list.children.length) list.append(element('p','没有匹配的站点。','filter-empty'));
  updatePath();
}
async function getJson(url) {
  const response = await fetch(url, {cache:'no-cache'});
  if (!response.ok) throw new Error('读取索引失败（HTTP ' + response.status + '）。请重试。');
  return response.json();
}
async function start() {
  const catalog = await getJson('./data/catalog.json');
  if (catalog.schema !== 1 || !Array.isArray(catalog.sites)) throw new Error('站点索引格式无效');
  catalogVersion = encodeURIComponent(catalog.updated);
  fs = new FileSystem(catalog, id => getJson('./data/' + encodeURIComponent(id) + '.json?v=' + catalogVersion));
  shell = new Shell(fs);
  el('mount-count').textContent = String(catalog.sites.length);
  const count = catalog.sites.reduce((n,s)=>n+s.count,0);
  el('info').textContent = catalog.sites.length + ' 个入口 / ' + count + ' 份文档';
  el('info').title = '索引时间 ' + catalog.updated;
  listSites();
  command.disabled = false; el('run').disabled = false;
  await execute(['ls'], false); screen.scrollTop = 0;
  if (matchMedia('(min-width:761px) and (pointer:fine)').matches && document.activeElement === document.body) {
    command.focus({preventScroll:true});
  }
}
el('line').addEventListener('submit', e => {
  e.preventDefault();
  if (busy || !command.value.trim()) return;
  const value=command.value; command.value=''; void execute([value],false);
});
el('filter').addEventListener('input', () => { if (fs) listSites(); });
el('manual').addEventListener('click', () => execute(['help']));
el('wipe').addEventListener('click', () => execute(['clear']));
el('coverage').addEventListener('click', () => execute(['status']));
el('toggle-mounts').addEventListener('click', () => toggleMounts(!el('mounts').classList.contains('visible')));
document.querySelectorAll('[data-example]').forEach(node => node.addEventListener('click', () => execute([node.dataset.example])));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') toggleMounts(false);
});
command.addEventListener('keydown', async event => {
  if (event.isComposing || !shell || busy) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); clearScreen(); return; }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    if (historyPos === shell.history.length) draft = command.value;
    historyPos = Math.max(0,Math.min(shell.history.length,historyPos + (event.key === 'ArrowUp' ? -1 : 1)));
    command.value = shell.history[historyPos] ?? draft;
    command.setSelectionRange(command.value.length,command.value.length);
  }
  if (event.key === 'Tab' && !event.shiftKey && command.value.trim() && command.selectionStart === command.value.length) {
    event.preventDefault();
    const before = command.value;
    try {
      const {word,matches} = await shell.complete(before);
      if (!matches.length || command.value !== before) return;
      let common = matches[0];
      while (common && !matches.every(s=>s.startsWith(common))) common = common.slice(0,-1);
      if (common.length > word.length) command.value = before.slice(0,before.length-word.length) + common;
      if (matches.length > 1) {
        const record = logCommand(before);
        record.append(element('pre',matches.join('  '),'out')); scrollEnd();
      }
    } catch { /* Incomplete paths are editable. */ }
  }
});
start().catch(error => {
  el('info').textContent = '索引加载失败';
  transcript.append(element('p',error.message,'error'),button('重新载入', () => location.reload(),'more'));
});
