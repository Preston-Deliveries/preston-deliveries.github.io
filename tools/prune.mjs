// Removes style rules that can never apply: they need a class or id that nothing in the app ever creates.
// A name counts as "in use" if it appears anywhere outside the styles (even inside another word), or if it is
// built from a prefix the code uses (like "pcz-" + postcode). So it only removes what is provably unused.
import fs from 'node:fs';
import postcss from 'postcss';
const [,,SRC,OUT]=process.argv;
const html=fs.readFileSync(SRC,'utf8');
const parts=[];let i=0;const re=/<(style|script)(\s[^>]*)?>/gi;let m;
while((m=re.exec(html))){const tag=m[1].toLowerCase(),st=m.index,oe=re.lastIndex;const c=html.indexOf('</'+tag,oe);if(c<0)break;const ce=html.indexOf('>',c)+1;
  parts.push({t:'raw',s:html.slice(i,st)});parts.push({t:tag,open:html.slice(st,oe),body:html.slice(oe,c),close:html.slice(c,ce)});i=ce;re.lastIndex=ce}
parts.push({t:'raw',s:html.slice(i)});
// everything that is not a stylesheet, plus CSS written inside scripts
const other=parts.filter(p=>p.t!=='style').map(p=>p.t==='raw'?p.s:p.open+p.body).join('\n');
const has=new Map();
const used=n=>{if(has.has(n))return has.get(n);let ok=other.includes(n);
  if(!ok){const k=n.match(/^(.*[-_])[^-_]+$/);if(k&&k[1].length>=2&&other.includes(k[1]))ok=true}
  if(!ok){const d=n.replace(/\d+$/,'');if(d!==n&&(d.length>=2?other.includes(d):["'"+d+"'",'"'+d+'"','`'+d+'${'].some(q=>other.includes(q))))ok=true}
  if(!ok){const k=n.match(/^([A-Za-z]{1,3})[A-Z0-9][\w-]*$/);if(k&&["'"+k[1]+"'",'"'+k[1]+'"','`'+k[1]+'${'].some(q=>other.includes(q)))ok=true}
  has.set(n,ok);return ok};
const strip=s=>{let out='',depth=0;for(let j=0;j<s.length;j++){const ch=s[j];
  if(depth===0&&s[j]===':'&&/^:(is|where|has|not|matches|-webkit-any|nth-[a-z-]+|host|host-context|lang|dir)\(/i.test(s.slice(j))){const p=s.indexOf('(',j);depth=1;j=p;continue}
  if(depth>0){if(ch==='(')depth++;else if(ch===')')depth--;continue}
  if(ch==='['){const e=s.indexOf(']',j);j=e<0?s.length:e;continue}
  if(ch==='"'||ch==="'"){const e=s.indexOf(ch,j+1);j=e<0?s.length:e;continue}
  out+=ch}return out};
const need=sel=>{const t=strip(sel);const n=[];for(const x of t.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g))n.push(x[2]);return n};
let rulesGone=0,selGone=0,bytesIn=0,bytesOut=0;const gone=new Set();
for(const p of parts.filter(p=>p.t==='style')){let root;try{root=postcss.parse(p.body)}catch(e){continue}
  bytesIn+=p.body.length;
  root.walkRules(r=>{if(r.parent&&r.parent.type==='atrule'&&/keyframes/i.test(r.parent.name))return;
    const list=r.selectors;const keep=list.filter(s=>need(s).every(used));
    if(keep.length===list.length)return;
    list.filter(s=>!keep.includes(s)).forEach(s=>{need(s).filter(x=>!used(x)).forEach(x=>gone.add(x))});
    selGone+=list.length-keep.length;
    if(!keep.length){r.remove();rulesGone++}else r.selectors=keep});
  root.walkAtRules(a=>{if(a.nodes&&!a.nodes.length)a.remove()});
  p.body=root.toString();bytesOut+=p.body.length}
fs.writeFileSync(OUT,parts.map(p=>p.t==='raw'?p.s:p.open+p.body+p.close).join(''));
console.log(JSON.stringify({rulesRemoved:rulesGone,selectorsRemoved:selGone,styleKB:[bytesIn>>10,bytesOut>>10],unusedNames:[...gone].slice(0,60)}));
