(function(){
const SEED=()=>window.__SEED||{};
const snapDoc=(id,data)=>({id:id||'x',exists:data!==undefined,data:()=>data===undefined?undefined:JSON.parse(JSON.stringify(data)),get:k=>data&&data[k],ref:mk()});
const colSnap=name=>{const c=SEED()[name]||{};const docs=Object.entries(c).map(([id,v])=>snapDoc(id,v));return {empty:!docs.length,size:docs.length,docs,forEach:f=>docs.forEach(f),docChanges:()=>docs.map(d=>({type:'added',doc:d}))}};
const snapQ=()=>({empty:true,size:0,docs:[],forEach(){},docChanges:()=>[]});
function mk(path){const f=function(){return mk(path)};return new Proxy(f,{get(t,p){
 if(p==='then')return undefined;
 if(p==='collection')return n=>mk({col:n});if(p==='doc')return n=>{if(path&&path.col&&n!==undefined)return mk({col:path.col,doc:n});const s=String(n||'').split('/');return s.length>=2?mk({col:s[0],doc:s[1]}):mk(path)};
 if(p==='get')return ()=>Promise.resolve(path&&path.doc!==undefined?snapDoc(path.doc,(SEED()[path.col]||{})[path.doc]):path&&path.col?colSnap(path.col):Object.assign(snapQ(),snapDoc()));
 if(p==='onSnapshot')return (a,b)=>{const cb=typeof a==='function'?a:b;setTimeout(()=>{try{cb(path&&path.doc!==undefined?snapDoc(path.doc,(SEED()[path.col]||{})[path.doc]):path&&path.col?colSnap(path.col):Object.assign(snapQ(),snapDoc()))}catch(e){console.log('snap err',e.message)}},10);return ()=>{}};
 if(['where','orderBy','limit','startAt','startAfter','endAt','endBefore','limitToLast'].includes(p))return ()=>mk(path);
 if(['set','update','delete','add','commit','enablePersistence','activate','settings'].includes(p))return ()=>Promise.resolve(mk());
 if(p===Symbol.toPrimitive)return ()=>'';
 if(p==='id')return 'x';
 return mk(path)},apply(){return mk(path)}})}
const user={uid:'u1',email:'jozza721@gmail.com',displayName:'Jonathan Simpson',emailVerified:true,getIdToken:()=>Promise.resolve('t'),getIdTokenResult:()=>Promise.resolve({claims:{}})};
const auth=new Proxy({},{get(t,p){
 if(p==='onAuthStateChanged'||p==='onIdTokenChanged')return cb=>{setTimeout(()=>cb(user),20);return()=>{}};
 if(p==='currentUser')return user;
 if(p==='then')return undefined;
 return ()=>Promise.resolve(mk())}});
const fsP=mk();
const fb={initializeApp(){return mk()},apps:[1],auth:Object.assign(()=>auth,{GoogleAuthProvider:function(){},Auth:{Persistence:{LOCAL:'local'}}}),firestore:Object.assign(()=>fsP,{FieldValue:mk(),Timestamp:mk(),FieldPath:mk()}),appCheck:Object.assign(()=>mk(),{ReCaptchaEnterpriseProvider:function(){}}),messaging:Object.assign(()=>mk(),{isSupported:()=>false})};
window.firebase=fb;})();
