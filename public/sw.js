/* SGBHSD 物价共享平台 Service Worker
   策略：静态资源缓存优先（刷新即更新），API 一律走网络。 */

const CACHE = 'sgbhsd-price-v1'

const PRECACHE = [
  '/',
  '/css/app.css',
  '/js/app.js',
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

  // 导航请求：缓存优先，后台刷新（保证离线可用 + 上线即更新）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then(hit =>
        hit ||
        fetch(req).catch(() => caches.match('/'))
      )
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
