const CACHE='home-atelier-planner-v1';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];
const known=new Set(ASSETS.map(name=>new URL(name,self.registration.scope).href));
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('home-atelier-planner-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'||!known.has(req.url))return;
  e.respondWith((async()=>{
    try{
      const response=await fetch(req);
      if(response.ok){const cache=await caches.open(CACHE);await cache.put(req,response.clone());}
      return response;
    }catch{
      const cache=await caches.open(CACHE);
      return await cache.match(req)??(req.mode==='navigate'?await cache.match('./index.html'):null)??Response.error();
    }
  })());
});
