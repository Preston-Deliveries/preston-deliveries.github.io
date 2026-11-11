// Build: src/index.html (readable) -> index.html (slim). Removes style rules that later identical rules override, then minifies styles and code.
import fs from 'node:fs';
import postcss from 'postcss';
import {minify} from 'terser';
const [,,SRC,OUT]=process.argv;
let html=fs.readFileSync(SRC,'utf8');
// Version stamp: every build sets VERSION to the real time it was built, Queensland time (UTC+10, no daylight saving): 1 + year month day hour minute.
// It is written back into src/index.html too, so the two files always match. Set NO_STAMP=1 to keep the version as it is.
if(!process.env.NO_STAMP){
  const q=new Date(Date.now()+10*3600e3),z=n=>String(n).padStart(2,'0');
  const stamp='1'+q.getUTCFullYear()+z(q.getUTCMonth()+1)+z(q.getUTCDate())+z(q.getUTCHours())+z(q.getUTCMinutes());
  if(!/const VERSION='\d+'/.test(html))throw new Error('No VERSION line found in '+SRC);
  html=html.replace(/const VERSION='\d+'/,"const VERSION='"+stamp+"'");
  fs.writeFileSync(SRC,html);
  console.log('Version '+stamp+' (Queensland time '+z(q.getUTCDate())+'/'+z(q.getUTCMonth()+1)+'/'+q.getUTCFullYear()+' '+z(q.getUTCHours())+':'+z(q.getUTCMinutes())+')');
}
// split into chunks: top level <style> and <script> blocks, leaving everything else alone
const parts=[];let i=0;
const re=/<(style|script)(\s[^>]*)?>/gi;let m;
while((m=re.exec(html))){
  const tag=m[1].toLowerCase(),start=m.index,openEnd=re.lastIndex;
  const close=html.indexOf('</'+tag,openEnd);if(close<0)break;
  const closeEnd=html.indexOf('>',close)+1;
  parts.push({t:'raw',s:html.slice(i,start)});
  parts.push({t:tag,open:html.slice(start,openEnd),body:html.slice(openEnd,close),close:html.slice(close,closeEnd)});
  i=closeEnd;re.lastIndex=closeEnd;
}
parts.push({t:'raw',s:html.slice(i)});
// ---- styles: find declarations overridden by a later rule with the same selector, same @media and same property
const styles=parts.filter(p=>p.t==='style');
const roots=styles.map(p=>{try{return postcss.parse(p.body)}catch(e){p.bad=1;return null}});
const ctxOf=n=>{const a=[];let q=n.parent;while(q&&q.type!=='root'){if(q.type==='atrule')a.unshift('@'+q.name+' '+q.params.replace(/\s+/g,' '));else return null;q=q.parent}return a.join('|')};
const norm=s=>s.replace(/\s+/g,' ').replace(/\s*([>+~,])\s*/g,'$1').trim();
const seen=new Map();let dead=0,total=0;
roots.forEach(r=>{if(!r)return;r.walkDecls(d=>{total++;const rule=d.parent;if(!rule||rule.type!=='rule')return;const c=ctxOf(rule);if(c===null)return;
  if(/^-|^--/.test(d.prop))return; // leave vendor props and custom properties alone
  const key=c+'§'+norm(rule.selector)+'§'+d.prop.toLowerCase();
  const prev=seen.get(key);
  if(prev&&prev.parent!==rule){ // only across different rules, never fallbacks inside one rule
    if(d.important||!prev.important){prev.__dead=1;seen.set(key,d)}else{d.__dead=1}
  }else if(!prev||prev.parent!==rule)seen.set(key,d);
})});
roots.forEach(r=>{if(!r)return;r.walkDecls(d=>{if(d.__dead){d.remove();dead++}});r.walkRules(x=>{if(!x.nodes||!x.nodes.length)x.remove()});r.walkAtRules(x=>{if(x.nodes&&!x.nodes.length)x.remove()})});
// minimal output: strip comments and spacing without changing any value
const tight=r=>{r.walkComments(c=>c.remove());r.walk(n=>{n.raws.before='';n.raws.after='';if(n.type==='decl'){n.raws.between=':';if(n.important)n.raws.important='!important'}if(n.type==='rule'){n.raws.between='';n.raws.semicolon=false;n.selector=n.selector.replace(/\s*\n\s*/g,' ').replace(/\s*,\s*/g,',')}if(n.type==='atrule'){n.raws.between='';n.raws.afterName=' ';n.raws.semicolon=false}});r.raws.after='';return r.toString()};
styles.forEach((p,k)=>{if(roots[k])p.body=tight(roots[k])});
// ---- scripts
const jsOpts={compress:{passes:2,toplevel:false,keep_fargs:true,unsafe:false},mangle:{toplevel:false},keep_classnames:true,format:{comments:false,inline_script:true}};
let jsIn=0,jsOut=0,skipped=0;
for(const p of parts.filter(p=>p.t==='script')){
  if(/\ssrc=/.test(p.open))continue;
  const type=(p.open.match(/type="([^"]+)"/)||[])[1]||'';
  if(type==='application/json'){try{p.body=JSON.stringify(JSON.parse(p.body)).replace(/<\//g,'<\\/')}catch(e){}continue}
  if(type&&!/^(text\/javascript|module|text\/x-mod)$/.test(type))continue;
  jsIn+=p.body.length;
  try{const r=await minify(p.body,{...jsOpts,module:type==='module'});if(r.code&&r.code.length<p.body.length)p.body=r.code;}catch(e){skipped++}
  jsOut+=p.body.length;
}
let out=parts.map(p=>p.t==='raw'?p.s:p.open+p.body+p.close).join('');
// keep the version marker the update check and the background worker look for
const ver=(html.match(/const VERSION='(\d+)'/)||[])[1];
if(ver&&!out.includes("const VERSION='"+ver+"'"))out=out.replace(/<\/head>/i,'<script type="text/plain" id="ver-mark">const VERSION=\''+ver+'\'</script></head>');
fs.writeFileSync(OUT,out);
console.log(JSON.stringify({styleBlocks:styles.length,badStyle:styles.filter(p=>p.bad).length,decls:total,deadRemoved:dead,jsKB:[jsIn>>10,jsOut>>10],jsSkipped:skipped,inKB:html.length>>10,outKB:out.length>>10}));
