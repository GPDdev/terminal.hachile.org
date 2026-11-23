import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FileSystem, Shell, parse} from '../public/shell.js';

const read = name => readFile(new URL('../public/data/'+name+'.json',import.meta.url),'utf8').then(JSON.parse);
const catalog = await read('catalog');
// A source may legitimately retire an article during a scheduled refresh.
// Keep command behavior tests independent of the current contents of remote sites.
const fixtures = {
  blog:['index.txt','posts/notes/index.txt'],
  gallery:['index.txt','images/example.png.txt'],
  ghc:['index.txt','entry/about/index.txt'],
  home:['index.txt'],
  research:['index.txt','projects/lithium-dendrite/index.txt'],
  sky:['index.txt','m/en/index.txt'],
};
function terminal() {
  const sites = Object.entries(fixtures).map(([id,files])=>({id,name:id,url:'https://'+id+'.hachile.org/',count:files.length,state:'ready'}));
  const readFixture = async id => fixtures[id].map(path=>({
    path,title:id,url:'https://'+id+'.hachile.org/'+(path==='entry/about/index.txt'?'#/entry/about':''),
    text:'English map\n具身智能与机器人\n世界模型',links:[['Original','https://hachile.org/'],['Index','https://site.hachile.org/']],
  }));
  return new Shell(new FileSystem({sites},readFixture));
}

test('every published mount has valid relative paths, provenance and navigable sources',async () => {
  assert.equal(new Set(catalog.sites.map(s=>s.id)).size,catalog.sites.length);
  for (const id of ['portal','site','blog','home','research','gallery','news','terminal','ghc']) assert.ok(catalog.sites.some(s=>s.id===id));
  for (const site of catalog.sites) {
    assert.match(site.id,/^[a-z0-9-]+$/);
    const docs=await read(site.id);
    assert.equal(docs.length,site.count,site.id);
    assert.equal(docs.length,new Set(docs.map(p=>p.path)).size,site.id);
    if (site.state==='ready') assert.ok(docs.some(p=>p.path==='index.txt'),site.id);
    for (const doc of docs) {
      assert.ok(doc.title && typeof doc.text==='string');
      assert.ok(doc.path.split('/').every(s=>s && s!=='.' && s!=='..'));
      for (const url of [doc.url,...doc.links.map(l=>l[1])]) {
        assert.match(new URL(url).protocol,/^https?:$/);
      }
    }
  }
});
test('read bodies, multilingual pages, hash routes, project records and gallery media',async () => {
  const sh=terminal();
  assert.match((await sh.run('cat research/index.txt')).text,/具身智能|数字孪生/);
  assert.match((await sh.run('ls blog/posts')).text,/notes\//);
  assert.ok((await sh.run('find /sites/ghc/entry -name index.txt')).text.includes('/entry/'));
  assert.match((await sh.run('open ghc/entry/about')).open,/#\/entry\/about$/);
  assert.ok((await sh.run('links gallery')).links.length>1);
  assert.match((await sh.run('ls gallery/images')).text,/\S/);
  assert.match((await sh.run('ls research/projects')).text,/lithium-dendrite/);
  assert.match((await sh.run('cat sky/m/en/index.txt')).text,/English|map|Pegasus/i);
  assert.equal((await sh.run('open blog.hachile.org')).open,'https://blog.hachile.org/');
});
test('paths, history, directory clicks, tab completion and composable commands',async () => {
  const sh=terminal();
  assert.equal((await sh.run('pwd')).text,'/sites');
  await sh.run('cd blog'); await sh.run('cd posts'); await sh.run('cd -');
  assert.equal(sh.cwd,'/sites/blog');
  await sh.run('cd ../../../../'); assert.equal(sh.cwd,'/');
  await sh.run('cd ~'); assert.equal(sh.cwd,'/sites');
  assert.equal((await sh.complete('cd resea')).matches[0],'research/');
  assert.equal((await sh.run('echo "hello | linux" | grep -i HELLO | wc -l')).text,'1');
  assert.equal((await sh.run('echo hi | tail -n 0 | wc -l')).text,'0');
  assert.ok((await sh.run('history')).text.includes('cd posts'));
  assert.ok((await sh.run('tree -L 1 /sites')).text.includes('research/'));
  assert.ok((await sh.run('grep -ril 世界模型 research')).text.includes('index.txt'));
  const matches=await sh.run('search 世界模型');
  assert.ok(matches.results.some(item=>item.path.startsWith('/sites/')));
  assert.ok((await sh.run('search 世界模型 | head -n 1')).text.length);
  assert.deepEqual(parse("echo 'foo bar' | grep bar"),[['echo','foo bar'],['grep','bar']]);
});
test('read-only interpreter returns useful errors without interpreting host code',async () => {
  const sh=terminal();
  for (const line of ['x-unknown', 'cat missing', 'cd /etc', 'echo "unfinished', 'pwd |', 'cd blog | cat',
                      'open javascript:noop', 'open gallery 999999', 'grep hello /sites', 'ls -q']) {
    await assert.rejects(sh.run(line),undefined,line);
  }
  assert.equal((await sh.run('pwd')).text,'/sites');
  assert.equal((await sh.run('echo "<b>test</b>"')).text,'<b>test</b>');
  assert.ok((await sh.run('help')).text.includes('links'));
});
test('a transient volume error can be retried',async () => {
  let count=0;
  const fs = new FileSystem(catalog, id => ++count===1 ? Promise.reject(new Error('offline')) : read(id));
  await assert.rejects(fs.doc('/sites/home/index.txt'),/offline/);
  assert.ok((await fs.doc('/sites/home/index.txt')).text);
});
