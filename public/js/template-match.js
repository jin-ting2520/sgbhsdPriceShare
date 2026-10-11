/* 游戏截图数字模板匹配引擎（UMD，浏览器与 Node 测试共用）
   原理：卡片布局固定 → 裁剪数值行 → 按卡底色二值化 → 切分字形 → NCC 匹配数字模板
    不依赖 OCR，对金色艺术字数字极稳；商品名仍走 OCR（Tesseract） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof require === 'function' ? (function () { try { return require('canvas') } catch (e) { return null } })() : null)
  } else {
    root.TemplateMatch = factory(null)
  }
})(typeof self !== 'undefined' ? self : this, function (nodeCanvas) {
  'use strict'

  var DIGIT_CHARS = '0123456789.'
  var _templates = null
  var _templateSize = 64

  function createCanvas(w, h) {
    if (nodeCanvas) return nodeCanvas.createCanvas(w, h)
    var c = document.createElement('canvas')
    c.width = w; c.height = h
    return c
  }

  /* ---------- 数字模板渲染 ---------- */
  function buildTemplates(size) {
    size = size || _templateSize
    var th = Math.round(size * 1.3)
    var result = {}
    for (var ci = 0; ci < DIGIT_CHARS.length; ci++) {
      var ch = DIGIT_CHARS.charAt(ci)
      var canvas = createCanvas(size, th)
      var ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, th)
      ctx.fillStyle = '#000000'
      var fontSize = Math.round(size * 0.88)
      ctx.font = 'bold ' + fontSize + 'px Arial, "Helvetica Neue", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(ch, size / 2, Math.round(th * 0.52))
      var img = ctx.getImageData(0, 0, size, th)
      var n = size * th
      var gray = new Float32Array(n)
      for (var i = 0; i < n; i++) {
        gray[i] = 1 - img.data[i * 4] / 255
      }
      result[ch] = { data: gray, w: size, h: th }
    }
    return result
  }

  function getTemplates() {
    if (!_templates) _templates = buildTemplates(_templateSize)
    return _templates
  }

  /* ---------- 二值化：与卡底色距离 ---------- */
  function binarize(imageData, bgR, bgG, bgB, threshold) {
    var data = imageData.data, w = imageData.width, h = imageData.height
    var binary = new Uint8Array(w * h)
    threshold = threshold || 48
    for (var i = 0; i < w * h; i++) {
      var dr = data[i * 4] - bgR, dg = data[i * 4 + 1] - bgG, db = data[i * 4 + 2] - bgB
      binary[i] = (dr * dr + dg * dg + db * db) > threshold * threshold ? 1 : 0
    }
    return { data: binary, w: w, h: h }
  }

  /* ---------- 自动估计卡底色（取区域内最频繁颜色） ---------- */
  function estimateBg(imageData) {
    var data = imageData.data, w = imageData.width, h = imageData.height
    var buckets = {}
    var step = 3
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var i = (y * w + x) * 4
        var key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4)
        buckets[key] = (buckets[key] || 0) + 1
      }
    }
    var best = null, bestC = -1
    for (var k in buckets) {
      if (buckets[k] > bestC) { bestC = buckets[k]; best = k }
    }
    var parts = best.split(',')
    return { r: parseInt(parts[0]) * 16 + 8, g: parseInt(parts[1]) * 16 + 8, b: parseInt(parts[2]) * 16 + 8 }
  }

  /* ---------- Otsu 自适应阈值（灰度） ---------- */
  function otsuThreshold(imageData) {
    var data = imageData.data, w = imageData.width, h = imageData.height
    var hist = new Float64Array(256)
    var n = w * h
    for (var i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
      var gray = Math.round((r * 299 + g * 587 + b * 114) / 1000)
      hist[gray]++
    }
    var sum = 0
    for (var t = 0; t < 256; t++) sum += t * hist[t]
    var sumB = 0, wB = 0, maxVar = 0, threshold = 128
    for (var t2 = 0; t2 < 256; t2++) {
      wB += hist[t2]
      if (wB === 0) continue
      var wF = n - wB
      if (wF === 0) break
      sumB += t2 * hist[t2]
      var mB = sumB / wB
      var mF = (sum - sumB) / wF
      var varBetween = wB * wF * (mB - mF) * (mB - mF)
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t2 }
    }
    return threshold
  }

  /* ---------- 自适应阈值：底色灰度（众数）+ 偏移 ---------- */
  function adaptiveThreshold(imageData, offset) {
    var data = imageData.data, w = imageData.width, h = imageData.height
    var hist = new Float64Array(256)
    var n = w * h
    for (var i = 0; i < n; i++) {
      var gray = Math.round((data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000)
      hist[gray]++
    }
    // 众数 = 底色灰度
    var mode = 0, modeC = -1
    for (var t = 0; t < 256; t++) {
      if (hist[t] > modeC) { modeC = hist[t]; mode = t }
    }
    return mode + (offset != null ? offset : 45)
  }

  /* ---------- 灰度二值化（自适应或固定阈值） ----------
     mode: 'bright' 前景=亮于阈值（默认，金字/白数字） | 'dark' 暗于阈值 | 'both' 两端 */
  function binarizeGray(imageData, threshold, mode) {
    var data = imageData.data, w = imageData.width, h = imageData.height
    if (threshold == null) threshold = adaptiveThreshold(imageData)
    mode = mode || 'bright'
    var binary = new Uint8Array(w * h)
    for (var i = 0; i < w * h; i++) {
      var gray = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
      if (mode === 'bright') binary[i] = gray > threshold ? 1 : 0
      else if (mode === 'both') binary[i] = (gray < threshold - 40 || gray > threshold) ? 1 : 0
      else binary[i] = gray < threshold ? 1 : 0
    }
    return { data: binary, w: w, h: h, threshold: threshold }
  }

  /* ---------- 字形切分：列投影 + 带间隙合并 ---------- */
  function segmentGlyphs(binary, opts) {
    var data = binary.data, w = binary.w, h = binary.h
    opts = opts || {}
    var minGap = opts.minGap != null ? opts.minGap : Math.max(2, Math.floor(w * 0.008))
    var maxGap = opts.maxGap != null ? opts.maxGap : Math.max(3, Math.floor(w * 0.02))

    var colCount = new Int32Array(w)
    for (var x = 0; x < w; x++) {
      var c = 0
      for (var y = 0; y < h; y++) c += data[y * w + x]
      colCount[x] = c
    }

    var raw = []
    var start = -1, gap = 0
    for (var x2 = 0; x2 < w; x2++) {
      if (colCount[x2] > 0) {
        if (start < 0) start = x2
        gap = 0
      } else {
        if (start >= 0) {
          gap++
          if (gap > maxGap) {
            raw.push({ x0: start, x1: x2 - gap })
            start = -1; gap = 0
          }
        }
      }
    }
    if (start >= 0) raw.push({ x0: start, x1: w - 1 })

    // 合并过窄间隙（同一数字内笔画间隙）
    var merged = []
    for (var ri = 0; ri < raw.length; ri++) {
      var cur = raw[ri]
      if (merged.length > 0) {
        var prev = merged[merged.length - 1]
        var gapPx = cur.x0 - prev.x1 - 1
        if (gapPx <= minGap) { prev.x1 = cur.x1; continue }
      }
      merged.push({ x0: cur.x0, x1: cur.x1 })
    }

    // 计算每个段的 y 边界
    var segs = []
    for (var mi = 0; mi < merged.length; mi++) {
      var seg = merged[mi]
      var ymin = h, ymax = -1
      for (var yy = 0; yy < h; yy++) {
        for (var xx = seg.x0; xx <= seg.x1; xx++) {
          if (data[yy * w + xx]) {
            if (yy < ymin) ymin = yy
            if (yy > ymax) ymax = yy
            break
          }
        }
      }
      if (ymax < 0) continue
      seg.y0 = ymin; seg.y1 = ymax
      seg.w = seg.x1 - seg.x0 + 1
      seg.h = ymax - ymin + 1
      segs.push(seg)
    }
    return segs
  }

  /* ---------- 宽段拆分：找谷底切分多个数字 ---------- */
  function splitWideSegment(binary, seg) {
    var data = binary.data, w = binary.w, h = binary.h
    var colCount = new Int32Array(seg.w)
    for (var x = 0; x < seg.w; x++) {
      var c = 0
      for (var y = seg.y0; y <= seg.y1; y++) c += data[y * w + seg.x0 + x]
      colCount[x] = c
    }
    var minPartW = Math.max(3, Math.floor(seg.h * 0.25))
    var parts = []
    var start = 0
    for (var x2 = 1; x2 < seg.w - 1; x2++) {
      if (colCount[x2] <= 2 && colCount[x2] < colCount[x2 - 1] && colCount[x2] < colCount[x2 + 1]) {
        if (x2 - start >= minPartW) {
          parts.push({ x0: seg.x0 + start, x1: seg.x0 + x2 - 1 })
          start = x2 + 1
        }
      }
    }
    if (start < seg.w) parts.push({ x0: seg.x0 + start, x1: seg.x0 + seg.w - 1 })

    // 重算 y 边界
    var result = []
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi]
      var ymin = h, ymax = -1
      for (var yy2 = 0; yy2 < h; yy2++) {
        for (var xx2 = p.x0; xx2 <= p.x1; xx2++) {
          if (data[yy2 * w + xx2]) {
            if (yy2 < ymin) ymin = yy2
            if (yy2 > ymax) ymax = yy2
            break
          }
        }
      }
      if (ymax < 0) continue
      p.y0 = ymin; p.y1 = ymax
      p.w = p.x1 - p.x0 + 1
      p.h = ymax - ymin + 1
      if (p.w >= 2 && p.h >= 4) result.push(p)
    }
    return result
  }

  /* ---------- NCC 归一化互相关 ---------- */
  function ncc(tmpl, region) {
    var n = tmpl.w * tmpl.h
    var tMean = 0, rMean = 0
    for (var i = 0; i < n; i++) { tMean += tmpl.data[i]; rMean += region.data[i] }
    tMean /= n; rMean /= n
    var num = 0, tDen = 0, rDen = 0
    for (var i2 = 0; i2 < n; i2++) {
      var t = tmpl.data[i2] - tMean
      var r = region.data[i2] - rMean
      num += t * r; tDen += t * t; rDen += r * r
    }
    var denom = Math.sqrt(tDen) * Math.sqrt(rDen)
    return denom > 1e-8 ? num / denom : 0
  }

  /* ---------- 将字形区域缩放到模板尺寸 ---------- */
  function resizeToTemplate(binary, seg, tw, th) {
    var data = binary.data, w = binary.w, h = binary.h
    var out = new Float32Array(tw * th)
    for (var ty = 0; ty < th; ty++) {
      for (var tx = 0; tx < tw; tx++) {
        var sx = seg.x0 + Math.floor(tx * seg.w / tw)
        var sy = seg.y0 + Math.floor(ty * seg.h / th)
        out[ty * tw + tx] = (sx >= 0 && sx < w && sy >= 0 && sy < h && data[sy * w + sx]) ? 1 : 0
      }
    }
    return { data: out, w: tw, h: th }
  }

  /* ---------- 单字形匹配 ---------- */
  function matchGlyph(binary, seg, minScore) {
    var templates = getTemplates()
    var bestChar = null, bestScore = -1
    for (var ci = 0; ci < DIGIT_CHARS.length; ci++) {
      var ch = DIGIT_CHARS.charAt(ci)
      var tmpl = templates[ch]
      var region = resizeToTemplate(binary, seg, tmpl.w, tmpl.h)
      var score = ncc(tmpl, region)
      if (score > bestScore) { bestScore = score; bestChar = ch }
    }
    if (minScore != null && bestScore < minScore) return { char: '', score: bestScore }
    return { char: bestChar, score: bestScore }
  }

  /* ---------- 从数值行 ImageData 识别数字串 ---------- */
  function recognizeNumber(imageData, options) {
    options = options || {}
    var threshold = options.threshold != null ? options.threshold : null
    var mode = options.mode || 'bright'
    var minScore = options.minScore != null ? options.minScore : 0.25
    var minGlyphH = options.minGlyphH != null ? options.minGlyphH : Math.max(3, Math.floor(imageData.height * 0.2))
    var maxGlyphW = options.maxGlyphW != null ? options.maxGlyphW : Math.floor(imageData.width * 0.9)

    // 灰度二值化（数值行文字比底色亮）
    var binary = binarizeGray(imageData, threshold, mode)
    var segs = segmentGlyphs(binary)

    // 过滤噪声：太矮/太宽的段
    segs = segs.filter(function (s) { return s.h >= minGlyphH && s.w <= maxGlyphW && s.w >= 2 })

    // 宽段拆分
    var glyphs = []
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i]
      if (s.w > s.h * 1.15) {
        var parts = splitWideSegment(binary, s)
        if (parts.length > 1) { glyphs.push.apply(glyphs, parts); continue }
      }
      glyphs.push(s)
    }

    // 按 x 排序并匹配
    glyphs.sort(function (a, b) { return a.x0 - b.x0 })
    var text = ''
    var scores = []
    var details = []
    for (var gi = 0; gi < glyphs.length; gi++) {
      var m = matchGlyph(binary, glyphs[gi], minScore)
      if (m.char) {
        text += m.char
        scores.push(m.score)
        details.push({ char: m.char, score: m.score, x: glyphs[gi].x0 })
      }
    }
    var avg = scores.length ? scores.reduce(function (a, b) { return a + b }, 0) / scores.length : 0
    return { text: text, score: avg, glyphs: glyphs.length, details: details, threshold: binary.threshold }
  }

  /* ---------- 卡片检测：浅棕卡带 + 深棕分隔缝（数量可变） ---------- */
  function detectCards(imageData, options) {
    options = options || {}
    var data = imageData.data, w = imageData.width, h = imageData.height
    var bg = options.bg || estimateBg(imageData)
    var distTh = options.distTh || 85
    var rowRatio = options.rowRatio || 0.28

    // 按行统计「接近卡底色」占比
    var rows = new Uint8Array(h)
    var x0 = Math.floor(w * 0.15), x1 = Math.floor(w * 0.95)
    for (var y = 0; y < h; y++) {
      var match = 0, total = 0
      for (var x = x0; x < x1; x += 3) {
        var i = (y * w + x) * 4
        var dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b
        total++
        if (dr * dr + dg * dg + db * db < distTh * distTh) match++
      }
      rows[y] = (match / total) > rowRatio ? 1 : 0
    }

    // 连续卡带
    var raw = []
    var minH = Math.max(50, Math.floor(h * 0.05))
    var start = -1
    for (var y2 = 0; y2 < h; y2++) {
      if (rows[y2] && start < 0) start = y2
      else if (!rows[y2] && start >= 0) {
        if (y2 - start >= minH) raw.push({ top: start, bottom: y2 })
        start = -1
      }
    }
    if (start >= 0 && h - start >= minH) raw.push({ top: start, bottom: h })

    if (raw.length === 0) return { cards: [], bg: bg }

    // 合并近距带（卡内标签行文字导致的断裂）
    var mergeGap = options.mergeGap != null ? options.mergeGap : Math.max(25, Math.floor(h * 0.013))
    var cards = [raw[0]]
    for (var ri = 1; ri < raw.length; ri++) {
      var gap = raw[ri].top - cards[cards.length - 1].bottom
      if (gap <= mergeGap) cards[cards.length - 1].bottom = raw[ri].bottom
      else cards.push(raw[ri])
    }
    return { cards: cards, bg: bg }
  }

  /* ---------- 卡内裁剪：按相对比例 ---------- */
  function cropRelative(imageData, card, rx0, ry0, rx1, ry1) {
    var w = imageData.width
    var ch = card.bottom - card.top
    var x0 = Math.max(0, Math.floor(w * rx0))
    var x1 = Math.min(w, Math.ceil(w * rx1))
    var y0 = Math.max(0, card.top + Math.floor(ch * ry0))
    var y1 = Math.min(imageData.height, card.top + Math.ceil(ch * ry1))
    var cw = x1 - x0, chh = y1 - y0
    if (cw <= 0 || chh <= 0) return null
    var out = new ImageData(cw, chh)
    for (var y = 0; y < chh; y++) {
      for (var x = 0; x < cw; x++) {
        var si = ((y0 + y) * w + (x0 + x)) * 4
        var di = (y * cw + x) * 4
        out.data[di] = imageData.data[si]
        out.data[di + 1] = imageData.data[si + 1]
        out.data[di + 2] = imageData.data[si + 2]
        out.data[di + 3] = imageData.data[si + 3]
      }
    }
    return out
  }

  /* ---------- 识别整张截图的全部卡片价格 ---------- */
  function recognizeScreenshot(imageData, options) {
    options = options || {}
    var det = detectCards(imageData)
    var results = []
    for (var ci = 0; ci < det.cards.length; ci++) {
      var card = det.cards[ci]
      var cardH = card.bottom - card.top
      // 值行 y：rel 0.61~0.71
      var vy0 = 0.61, vy1 = 0.71

      // 按列裁三个区域独立识别（价格/成本/负重），避免整行切分失败
      // 基于游戏 UI：价格列 ~rel x 0.22-0.42，成本列 ~0.42-0.60，负重列 ~0.60-0.75
      var cols = [
        { name: 'price', rx0: 0.20, rx1: 0.42 },
        { name: 'cost', rx0: 0.42, rx1: 0.58 },
        { name: 'burden', rx0: 0.58, rx1: 0.75 }
      ]
      var values = {}
      var scoreSum = 0, scoreN = 0
      for (var ki = 0; ki < cols.length; ki++) {
        var col = cols[ki]
        var strip = cropRelative(imageData, card, col.rx0, vy0, col.rx1, vy1)
        if (!strip) { values[col.name] = ''; continue }
        var rec = recognizeNumber(strip, {
          threshold: options.threshold,
          mode: options.mode || 'bright',
          minScore: options.minScore != null ? options.minScore : 0.2,
          minGlyphH: Math.max(3, Math.floor(strip.height * 0.25))
        })
        values[col.name] = rec.text
        if (rec.score > 0) { scoreSum += rec.score; scoreN++ }
      }
      results.push({
        cardIndex: ci,
        cardTop: card.top,
        cardBottom: card.bottom,
        price: values.price,
        cost: values.cost,
        burden: values.burden,
        score: scoreN ? scoreSum / scoreN : 0
      })
    }
    return { cards: det.cards, results: results, bg: det.bg }
  }

  return {
    buildTemplates: buildTemplates,
    getTemplates: getTemplates,
    binarize: binarize,
    binarizeGray: binarizeGray,
    otsuThreshold: otsuThreshold,
    adaptiveThreshold: adaptiveThreshold,
    estimateBg: estimateBg,
    segmentGlyphs: segmentGlyphs,
    splitWideSegment: splitWideSegment,
    ncc: ncc,
    matchGlyph: matchGlyph,
    recognizeNumber: recognizeNumber,
    detectCards: detectCards,
    cropRelative: cropRelative,
    recognizeScreenshot: recognizeScreenshot
  }
})
