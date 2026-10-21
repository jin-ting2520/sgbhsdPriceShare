/* 三国冰河时代富甲天下跑商价格分享 Service Worker
   策略：静态资源缓存优先（刷新即更新），API 一律走网络。 */

const CACHE = 'sgbhsd-price-v6'

const PRECACHE = [
  '/',
  '/css/app.css',
  '/bundle/app.js',
  '/bundle/admin.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/vendor/vue/vue.esm-browser.prod.js',
  '/vendor/element-plus/index.full.min.mjs',
  '/vendor/element-plus/index.css',
  '/vendor/element-plus/locale/zh-cn.min.mjs',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // API 与带鉴权的请求永远走网络
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname === '/ws') return

  // 导航请求：首页缓存优先（离线可用）；其他页面（如 /admin）始终走网络，避免缓存串页
  if (req.mode === 'navigate') {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      event.respondWith(
        caches.match('/').then(hit =>
          hit ||
          fetch(req).catch(() => caches.match('/'))
        )
      )
    } else {
      event.respondWith(fetch(req).catch(() => Response.error()))
    }
    return
  }

  // 前端包始终网络优先，保证升级后立即生效；离线时回退缓存
  if (url.pathname.startsWith('/bundle/')) {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone()
          caches.open(CACHE).then(cache => cache.put(req, copy))
        }
        return res
      }).catch(() => caches.match(req))
    )
    return
  }

  // 其余静态资源：缓存优先，miss 时回源并写入缓存
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit
      return fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then(cache => cache.put(req, copy))
        }
        return res
      }).catch(() => hit)
    })
  )
})
