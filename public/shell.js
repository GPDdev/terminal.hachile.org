export const HELP = [
  ['ls [-la] [路径]', '列出文件和子目录'],
  ['cd [路径] / pwd', '切换或显示当前目录，~ 为 /sites，- 返回上一目录'],
  ['cat 文件… / less 文件', '读全文，less 分页显示'],
  ['tree [-L 层数] [路径]', '查看目录树'],
  ['find [目录] [-name 模式]', '按路径查找，支持 * 和 ?'],
  ['grep [-rinlF] 词 [路径…]', '匹配文本。-r 递归，-i 忽略大小写，-n 显示行号，-l 仅列文件'],
  ['search 关键词', '搜索所有挂载站点的正文、标题及链接，点结果可读原文'],
  ['head / tail [-n 行数] [文件]', '从开头或末尾取行，可接管道输入'],
  ['wc [-lwm] [文件]', '统计行数、词数或字符数'],
  ['links [文件或目录]', '列出页面链接和媒体，序号可传给 open'],
  ['open [路径] [链接序号]', '打开该页原站或指定链接'],
  ['sites / status [站点]', '查看站点、收录页数、索引状态和缺页原因'],
  ['history / clear / help', '查看当前会话历史、清屏或显示手册'],
];
const COMMANDS = ['ls','cd','pwd','cat','less','tree','find','grep','search','head','tail','wc','links','open','sites','status','history','clear','help','man','whoami','uname','echo'];
export const STATES = {ready:'已挂载', partial:'部分收录', cached:'上次快照', unavailable:'原站暂不可读', link:'原站入口'};
const out = (text = '') => ({text});
const fail = message => { throw new Error(message); };
const baseName = path => path.split('/').filter(Boolean).at(-1) || '/';
const parent = path => path.slice(0, path.lastIndexOf('/')) || '/';
const childPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const helpText = () => HELP.map(([cmd, about]) => cmd + '\n  ' + about).join('\n');
const plainDate = iso => iso ? iso.slice(0, 10) : '—';
const fileText = doc => [doc.title, doc.url, '', doc.text].filter(x => x !== undefined).join('\n');
function safeUrl(url) {
  let address;
  try { address = new URL(url); } catch { fail('无效地址'); }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) fail('不支持此链接');
  return address.href;
}

export class FileSystem {
  constructor(catalog, readVolume) {
    this.catalog = catalog;
    this.sites = new Map(catalog.sites.map(site => [site.id, site]));
    this.readVolume = readVolume;
    this.loaded = new Map();
    this.docs = new Map([['/README.md', {title:'Hachile Terminal', url:'https://terminal.hachile.org/', text:helpText(), links:[]}]]);
    this.docs.set('/sites/README.md', {title:'站群索引', url:'https://site.hachile.org/#directory',
      text:catalog.sites.map(s => this.status(s)).join('\n'), links:catalog.sites.map(s => [s.name,s.url])});
    this.dirs = new Set(['/', '/sites']);
    for (const site of catalog.sites) {
      const root = '/sites/' + site.id;
      this.dirs.add(root);
      this.docs.set(root + '/README.md', {title:site.name, url:site.url, text:[site.description, this.status(site), ...Object.entries(site.issues || {}).map(([key,v]) => key + '  ' + v)].join('\n'), links:[['原站', site.url]]});
    }
  }
  status(site) {
    return [site.id.padEnd(11), String(site.count).padStart(3) + ' 页', STATES[site.state], plainDate(site.updated), site.url].join('  ');
  }
  resolve(cwd, input = '.') {
    let path = input || '.';
    const first = path.split('/')[0];
    const host = first === 'www.hachile.org' ? 'hachile.org' : first;
    if (host.endsWith('.hachile.org') || host === 'hachile.org') {
      const site = this.catalog.sites.find(s => new URL(s.url).hostname === host);
      if (site) path = '/sites/' + site.id + path.slice(first.length);
    }
    if (path === '~' || path.startsWith('~/')) path = '/sites' + path.slice(1);
    const parts = (path.startsWith('/') ? path : cwd + '/' + path).split('/');
    const clean = [];
    for (const part of parts) {
      if (part === '..') clean.pop();
      else if (part && part !== '.') clean.push(part);
    }
    return '/' + clean.join('/');
  }
  async mount(id) {
    const site = this.sites.get(id);
    if (!site || !site.count) return;
    if (!this.loaded.has(id)) {
      const loading = this.readVolume(id).then(docs => {
        if (!Array.isArray(docs) || site.count !== docs.length) fail('索引版本不一致，请刷新页面');
        for (const doc of docs) {
          if (!doc.path || doc.path.split('/').some(part => !part || part === '.' || part === '..')) fail('无效索引路径');
          const path = '/sites/' + id + '/' + doc.path;
          this.docs.set(path, doc);
          let dir = parent(path);
          while (!this.dirs.has(dir)) {
            this.dirs.add(dir);
            dir = parent(dir);
          }
        }
      }).catch(err => { this.loaded.delete(id); throw err; });
      this.loaded.set(id, loading);
    }
    await this.loaded.get(id);
  }
  async prepare(path, recursive = false) {
    if ((path === '/' || path === '/sites') && recursive) {
      await Promise.all([...this.sites.keys()].map(id => this.mount(id)));
    } else if (path.startsWith('/sites/')) await this.mount(path.split('/')[2]);
  }
  async children(dir) {
    await this.prepare(dir);
    if (!this.dirs.has(dir)) fail('没有这个目录：' + dir);
    return [...this.dirs, ...this.docs.keys()].filter(path => path !== dir && parent(path) === dir)
      .sort((a,b) => Number(this.docs.has(a)) - Number(this.docs.has(b)) || a.localeCompare(b, 'en'));
  }
  async doc(path) {
    await this.prepare(path);
    if (this.dirs.has(path)) path = [childPath(path,'index.txt'), childPath(path,'README.md')].find(p => this.docs.has(p)) || path;
    const doc = this.docs.get(path);
    if (!doc) fail('没有可读文件：' + path + '（用 ls 查看目录）');
    return doc;
  }
  async below(path, directories = false) {
    await this.prepare(path, true);
    if (this.docs.has(path)) return [path];
    if (!this.dirs.has(path)) fail('路径不存在：' + path);
    const prefix = path === '/' ? '/' : path + '/';
    return [...(directories ? this.dirs : []), ...this.docs.keys()].filter(p => p === path || p.startsWith(prefix)).sort();
  }
}

export function parse(command) {
  const pipeline = [[]];
  let word = '', quote = '', escaped = false, started = false;
  function flush() {
    if (started) pipeline.at(-1).push(word);
    word = ''; started = false;
  }
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '|') { flush(); if (!pipeline.at(-1).length) fail('管道缺少命令'); pipeline.push([]); }
    else if (/\s/.test(char)) flush();
    else { word += char; started = true; }
  }
  if (escaped || quote) fail('引号或转义符尚未闭合');
  flush();
  if (pipeline.length > 1 && !pipeline.at(-1).length) fail('管道缺少命令');
  return pipeline;
}
function flags(args, allowed) {
  const opts = new Set(), rest = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') ended = true;
    else if (!ended && /^-.+/.test(arg)) {
      for (const opt of arg.slice(1)) {
        if (!allowed.includes(opt)) fail('不支持参数 -' + opt);
        opts.add(opt);
      }
    } else rest.push(arg);
  }
  return [opts, rest];
}
function numericOption(args, flag, initial) {
  const idx = args.indexOf(flag);
  if (idx < 0) return initial;
  if (!/^\d+$/.test(args[idx+1] || '')) fail(flag + ' 需要非负整数');
  return Number(args.splice(idx, 2)[1]);
}
const quoteArg = s => "'" + s.replaceAll("'", "'\\''") + "'";
export {quoteArg};

export class Shell {
  constructor(fs) { this.fs = fs; this.cwd = '/sites'; this.previous = this.cwd; this.history = []; }
  async run(line) {
    if (!line.trim()) return out();
    this.history.push(line);
    const commands = parse(line);
    let result;
    for (const [cmd, ...args] of commands) {
      if (commands.length > 1 && ['open','cd','clear'].includes(cmd)) fail(cmd + ' 需要单独执行');
      result = await this.execute(cmd, args, result?.text);
    }
    return result;
  }
  async execute(cmd, args, stdin) {
    const fs = this.fs, resolve = arg => fs.resolve(this.cwd, arg);
    const read = async paths => {
      if (!paths.length && stdin === undefined) fail('请指定文件，或通过管道传入文本');
      return paths.length ? (await Promise.all(paths.map(async p => fileText(await fs.doc(resolve(p)))))).join('\n') : stdin;
    };
    if (cmd === 'help' || cmd === 'man') return out(helpText() + '\n\n例：cat research/index.txt | grep 世界模型\n例：find /sites/blog -name "index.txt" | head -n 10');
    if (cmd === 'pwd') return out(this.cwd);
    if (cmd === 'whoami') return out('guest');
    if (cmd === 'uname') return out('Hachile Terminal (browser)');
    if (cmd === 'echo') return out(args.join(' '));
    if (cmd === 'history') return out(this.history.map((s,i) => (i+1) + '  ' + s).join('\n'));
    if (cmd === 'clear') return {...out(), clear:true};
    if (cmd === 'cd') {
      if (args.length > 1) fail('用法：cd [目录]');
      const target = args[0] === '-' ? this.previous : resolve(args[0] || '~');
      await fs.prepare(target);
      if (!fs.dirs.has(target)) fail('没有这个目录：' + target);
      this.previous = this.cwd; this.cwd = target;
      return out(args[0] === '-' ? target : '');
    }
    if (cmd === 'sites' || cmd === 'status') {
      if (!args.length) return out(fs.catalog.sites.map(s => fs.status(s)).join('\n'));
      const id = resolve(args[0]).split('/')[2];
      const site = fs.sites.get(args[0]) || fs.sites.get(id);
      if (!site) fail('未知站点：' + args[0]);
      return out(fileText(fs.docs.get('/sites/' + site.id + '/README.md')));
    }
    if (cmd === 'ls') {
      const [opts, paths] = flags(args, 'la1');
      if (paths.length > 1) fail('用法：ls [-la] [路径]');
      const path = resolve(paths[0]);
      await fs.prepare(path);
      const pathsOut = fs.docs.has(path) ? [path] : await fs.children(path);
      const items = pathsOut.map(p => ({path:p, dir:fs.dirs.has(p), label:baseName(p) + (fs.dirs.has(p) ? '/' : '')}));
      if (opts.has('a') && fs.dirs.has(path)) items.unshift({path,dir:true,label:'./'}, {path:parent(path),dir:true,label:'../'});
      if (opts.has('l')) return out(items.map(it => (it.dir ? 'dr-xr-xr-x' : '-r--r--r--') + '  ' + it.label).join('\n'));
      return {text:items.map(it=>it.label).join('\n'), items, vertical:opts.has('1')};
    }
    if (cmd === 'cat' || cmd === 'less') return {text:await read(args), paged:cmd === 'less'};
    if (cmd === 'links' || cmd === 'open') {
      const path = resolve(args[0] || '.');
      const doc = await fs.doc(path);
      if (cmd === 'links') return {text:doc.links.map(([k,v],i) => (i+1)+'. '+k+'  '+v).join('\n') || '此页没有附属链接。', links:doc.links};
      let target = doc.url;
      if (args.length > 2) fail('用法：open [路径] [链接序号]');
      if (args.length === 2) {
        if (!/^[1-9]\d*$/.test(args[1]) || !doc.links[Number(args[1])-1]) fail('链接序号不存在，请先用 links 查看');
        target = doc.links[Number(args[1])-1][1];
      }
      return {text:safeUrl(target), open:safeUrl(target)};
    }
    if (cmd === 'tree') {
      const depth = numericOption(args, '-L', 2);
      if (args.length > 1) fail('用法：tree [-L 层数] [目录]');
      const root = resolve(args[0]); const lines = [root];
      await fs.prepare(root);
      if (!fs.dirs.has(root)) fail('没有这个目录：' + root);
      async function walk(dir, prefix, remaining) {
        if (!remaining) return;
        const entries = await fs.children(dir);
        for (let i=0; i<entries.length; i++) {
          const entry = entries[i], last = i === entries.length-1, isDir = fs.dirs.has(entry);
          lines.push(prefix + (last ? '└── ' : '├── ') + baseName(entry) + (isDir ? '/' : ''));
          if (isDir) await walk(entry, prefix + (last ? '    ' : '│   '), remaining-1);
        }
      }
      await walk(root, '', depth);
      return out(lines.join('\n'));
    }
    if (cmd === 'find') {
      const dir = args[0] && args[0] !== '-name' ? args.shift() : '.';
      if (args.length && (args.length !== 2 || args[0] !== '-name')) fail('用法：find [目录] [-name 模式]');
      const pattern = Array.from(args[1] || '*', c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('');
      const rx = new RegExp('^' + pattern + '$', 'u');
      return out((await fs.below(resolve(dir), true)).filter(p => rx.test(baseName(p))).join('\n'));
    }
    if (cmd === 'grep' || cmd === 'search') {
      const [opts, values] = cmd === 'search' ? [new Set('ri'), [args.join(' '), '/sites']] : flags(args, 'riRnlF');
      const term = values.shift(); if (!term) fail('请提供搜索词');
      const clean = s => opts.has('i') ? s.toLowerCase() : s;
      const needle = clean(term), match = s => clean(s).includes(needle);
      if (stdin !== undefined && !values.length) {
        return out(stdin.split('\n').flatMap((line,i) => match(line) ? [(opts.has('n') ? (i+1)+':' : '')+line] : []).join('\n'));
      }
      if (!values.length && !(opts.has('r') || opts.has('R'))) fail('用法：grep 词 文件，或 grep -r 词 目录');
      const found = [], items = [];
      for (const arg of values.length ? values : ['.']) {
        const root = resolve(arg);
        await fs.prepare(root);
        if (fs.dirs.has(root) && !opts.has('r') && !opts.has('R')) fail('搜索目录请加 -r');
        const paths = await fs.below(root);
        for (const p of paths) {
          const doc = fs.docs.get(p);
          if (cmd === 'search') {
            if (p.endsWith('/README.md')) continue;
            const corpus = fileText(doc) + '\n' + doc.links.map(pair => pair.join(' ')).join('\n');
            const line = corpus.split('\n').find(match);
            if (!line) continue;
            const idx = clean(line).indexOf(needle);
            const excerpt = (idx > 35 ? '…' : '') + line.slice(Math.max(0,idx-35),idx+90);
            const label = doc.title + '  ' + p;
            found.push(label + '\n  ' + excerpt);
            items.push({path:p, label, excerpt});
          } else {
            const lines = fileText(doc).split('\n');
            for (let i=0; i<lines.length; i++) {
              if (!match(lines[i])) continue;
              if (opts.has('l')) {found.push(p); break;}
              const prefix = paths.length > 1 || values.length > 1 || fs.dirs.has(root) ? p + ':' : '';
              found.push(prefix + (opts.has('n') ? (i+1)+':' : '') + lines[i]);
            }
          }
        }
      }
      return {text:found.join('\n'), results:cmd === 'search' ? items : undefined, empty:found.length ? '' : '没有匹配结果。'};
    }
    if (cmd === 'head' || cmd === 'tail') {
      const n = numericOption(args, '-n', 10);
      const lines = (await read(args)).split('\n');
      return out((cmd === 'head' ? lines.slice(0,n) : n ? lines.slice(-n) : []).join('\n'));
    }
    if (cmd === 'wc') {
      const [opts, file] = flags(args, 'lwm');
      const text = await read(file);
      const counts = {l:text ? text.split('\n').length : 0, w:text.trim() ? text.trim().split(/\s+/).length : 0, m:[...text].length};
      return out(Object.entries(counts).filter(([k]) => !opts.size || opts.has(k)).map(([,v]) => v).join('  '));
    }
    fail('未识别命令 ' + cmd + '。输入 help 查看命令。');
  }
  async complete(line) {
    const segment = line.split('|').at(-1);
    const trimmed = segment.trimStart();
    const word = (trimmed.match(/(?:\\.|[^\s])+$/u) || [''])[0];
    const start = trimmed.slice(0, trimmed.length-word.length);
    if (!start.trim()) return {word, matches:COMMANDS.filter(c => c.startsWith(word)).map(c => c+' ')};
    const slash = word.lastIndexOf('/'), prefix = word.slice(0,slash+1), leaf=word.slice(slash+1).replaceAll('\\ ',' ');
    const dir = this.fs.resolve(this.cwd, prefix.replaceAll('\\ ',' ') || '.');
    const paths = await this.fs.children(dir);
    const directoriesOnly = start.trim() === 'cd';
    const matches = paths.filter(p => baseName(p).startsWith(leaf) && (!directoriesOnly || this.fs.dirs.has(p)))
      .map(p => prefix + baseName(p).replaceAll(' ','\\ ') + (this.fs.dirs.has(p) ? '/' : ' '));
    return {word, matches};
  }
}
