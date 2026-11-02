(function(){
const snapDoc=(id)=>({id:id||'x',exists:false,data:()=>undefined,get:()=>undefined,ref:mk()});
const snapQ=()=>({empty:true,size:0,docs:[],forEach(){},docChanges:()=>[]});
function mk(){const f=function(){return mk()};return new Proxy(f,{get(t,p){
 if(p==='then')return undefined;
 if(p==='get')return ()=>Promise.resolve(Object.assign(snapQ(),snapDoc()));
 if(p==='onSnapshot')return (a,b)=>{const cb=typeof a==='function'?a:b;setTimeout(()=>{try{cb(Object.assign(snapQ(),snapDoc()))}catch(e){console.log('snap err',e.message)}},10);return ()=>{}};
 if(['set','update','delete','add','commit','enablePersistence','activate','settings'].includes(p))return ()=>Promise.resolve(mk());
 if(p===Symbol.toPrimitive)return ()=>'';
 if(p==='id')return 'x';
 return mk()},apply(){return mk()}})}
const user={uid:'u1',email:'jozza721@gmail.com',displayName:'Jonathan Simpson',emailVerified:true,getIdToken:()=>Promise.resolve('t'),getIdTokenResult:()=>Promise.resolve({claims:{}})};
const auth=new Proxy({},{get(t,p){
 if(p==='onAuthStateChanged'||p==='onIdTokenChanged')return cb=>{setTimeout(()=>cb(user),20);return()=>{}};
 if(p==='currentUser')return user;
 if(p==='then')return undefined;
 return ()=>Promise.resolve(mk())}});
const fsP=mk();
const fb={initializeApp(){return mk()},apps:[1],auth:Object.assign(()=>auth,{GoogleAuthProvider:function(){},Auth:{Persistence:{LOCAL:'local'}}}),firestore:Object.assign(()=>fsP,{FieldValue:mk(),Timestamp:mk(),FieldPath:mk()}),appCheck:Object.assign(()=>mk(),{ReCaptchaEnterpriseProvider:function(){}}),messaging:Object.assign(()=>mk(),{isSupported:()=>false})};
window.firebase=fb;})();
