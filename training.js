(function () {
  'use strict';

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
  var KM_PER_MI = 1.609344;

  // ---------- small utilities ----------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function avg(xs) {
    xs = xs.filter(function (x) { return x != null && !isNaN(x); });
    return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null;
  }
  function sum(xs) { return xs.reduce(function (a, b) { return a + (b || 0); }, 0); }
  function last(arr) { return arr[arr.length - 1]; }
  function lastVal(rows, key) {
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i][key] != null) return rows[i][key];
    return null;
  }
  function pearson(xs, ys) {
    var p = [];
    xs.forEach(function (x, i) { if (x != null && ys[i] != null) p.push([x, ys[i]]); });
    if (p.length < 6) return null;
    var mx = avg(p.map(function (q) { return q[0]; })), my = avg(p.map(function (q) { return q[1]; }));
    var n = 0, dx = 0, dy = 0;
    p.forEach(function (q) { n += (q[0] - mx) * (q[1] - my); dx += Math.pow(q[0] - mx, 2); dy += Math.pow(q[1] - my, 2); });
    return dx && dy ? n / Math.sqrt(dx * dy) : null;
  }

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('tr:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('tr:' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('tr:' + k); } catch (e) {} }
  };

  function parseDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { var c = new Date(d); c.setDate(c.getDate() + n); return c; }
  function todayDate() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function shortDate(s) { var d = parseDate(s); return MON[d.getMonth()] + ' ' + d.getDate(); }
  function longDate(s) {
    var d = parseDate(s);
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ', ' +
      ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()] +
      ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function fmtClock(s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') : m + ':' + String(sec).padStart(2, '0');
  }
  function fmtHM(min) {
    if (min == null) return '—';
    min = Math.round(min);
    return Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm';
  }
  function parseClock(str) {
    if (!str) return null;
    var parts = String(str).trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    var s = 0;
    parts.forEach(function (p) { s = s * 60 + p; });
    return s > 0 ? s : null;
  }

  // ---------- state ----------

  var D = null;
  var state = {};
  var charts = [];

  function units() { return state.units; }
  function distVal(km) { return km == null ? null : units() === 'mi' ? km / KM_PER_MI : km; }
  function fmtDist(km, dp) {
    if (km == null) return '—';
    return distVal(km).toFixed(dp == null ? 1 : dp) + ' ' + units();
  }
  function paceVal(sPerKm) { return sPerKm == null ? null : units() === 'mi' ? sPerKm * KM_PER_MI : sPerKm; }
  function fmtPace(sPerKm, withUnit) {
    if (sPerKm == null) return '—';
    return fmtClock(paceVal(sPerKm)) + (withUnit === false ? '' : ' /' + units());
  }

  function goal() {
    var g = Object.assign({}, D.goal, store.get('goal', {}));
    g.distance_km = +g.distance_km || 42.195;
    return g;
  }
  function predictedFor(km) {
    var p = D.predictions;
    var table = [[5, p['5k']], [10, p['10k']], [21.0975, p.half], [42.195, p.marathon]];
    for (var i = 0; i < table.length; i++) if (Math.abs(table[i][0] - km) < 0.15 && table[i][1]) return table[i][1];
    if (!p.marathon) return null;
    return p.marathon * Math.pow(km / 42.195, 1.06);
  }
  function targetSeconds() { var g = goal(); return g.target_s || predictedFor(g.distance_km); }
  function daysToRace() { return daysBetween(todayDate(), parseDate(goal().date)); }
  function isMarathon() { return Math.abs(goal().distance_km - 42.195) < 0.5; }

  function rangeRows() {
    if (!state.range) return D.daily;
    var end = parseDate(last(D.daily).date);
    var start = isoDate(addDays(end, -state.range + 1));
    return D.daily.filter(function (r) { return r.date >= start; });
  }
  function rangeActs(all) {
    var rows = rangeRows();
    var start = rows.length ? rows[0].date : '0000';
    return D.activities.filter(function (a) { return a.date >= start && (all || a.is_run); });
  }

  // ---------- tooltip ----------

  var tt = $('#tt');
  function showTip(evt, html) {
    tt.innerHTML = html;
    tt.classList.add('show');
    var x = evt.clientX + 16, y = evt.clientY + 14;
    var r = tt.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 16;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
    tt.style.left = Math.max(8, x) + 'px';
    tt.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tt.classList.remove('show'); }
  function tipRow(color, name, value) {
    return '<div class="row"><span>' + (color ? '<i class="sw" style="background:' + color + '"></i>' : '') + esc(name) +
      '</span><span>' + value + '</span></div>';
  }

  // ---------- charts (hand-rolled SVG) ----------

  var NS = 'http://www.w3.org/2000/svg';

  function niceTicks(lo, hi, count) {
    var span = hi - lo || 1;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = span / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function barPath(x, yTop, w, h, r) {
    r = Math.min(r, w / 2, h);
    if (h <= 0) return '';
    return 'M' + x + ',' + (yTop + h) + 'V' + (yTop + r) + 'Q' + x + ',' + yTop + ' ' + (x + r) + ',' + yTop +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + yTop + ' ' + (x + w) + ',' + (yTop + r) + 'V' + (yTop + h) + 'Z';
  }

  function chart(el, cfg) {
    el.innerHTML = '';
    el.classList.add('chart');
    var series = cfg.series;
    var hasLegend = cfg.legend !== false && (series.length > 1 || cfg.band && cfg.band.label);
    if (hasLegend) {
      var lg = document.createElement('div');
      lg.className = 'legend';
      lg.innerHTML = series.map(function (s) {
        var cls = s.type === 'bar' || s.type === 'range' ? 'box' : s.dash ? 'dash' : '';
        return '<span><i class="' + cls + '" style="background:' + s.color + ';color:' + s.color + '"></i>' + esc(s.name) + '</span>';
      }).join('') + (cfg.band && cfg.band.label ? '<span><i class="box" style="background:rgba(242,240,234,0.18)"></i>' + esc(cfg.band.label) + '</span>' : '');
      el.appendChild(lg);
    }

    var W = Math.max(260, el.clientWidth), H = cfg.height || 220;
    var m = { t: 12, r: 14, b: 24, l: cfg.yWidth || 40 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = cfg.labels.length;
    var step = iw / Math.max(n, 1);
    var xc = function (i) { return m.l + step * (i + 0.5); };

    var vals = [], stacks = {}, hasBars = false;
    series.forEach(function (s) {
      if (s.type === 'bar') hasBars = true;
      if (s.type === 'range') {
        s.lo.concat(s.hi).forEach(function (v) { if (v != null) vals.push(v); });
      } else if (s.stack) {
        var arr = stacks[s.stack] || (stacks[s.stack] = new Array(n).fill(0));
        s.values.forEach(function (v, i) { arr[i] += v || 0; });
      } else {
        s.values.forEach(function (v) { if (v != null) vals.push(v); });
      }
    });
    Object.keys(stacks).forEach(function (k) { vals = vals.concat(stacks[k]); });
    if (cfg.band) cfg.band.lo.concat(cfg.band.hi).forEach(function (v) { if (v != null) vals.push(v); });
    (cfg.refs || []).forEach(function (r) { vals.push(r.y); });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hasBars) lo = Math.min(0, lo);
    var pad = (hi - lo || 1) * 0.08;
    if (cfg.yMin == null && !hasBars) lo -= pad;
    if (cfg.yMax == null) hi += pad;
    if (cfg.yMin != null) lo = cfg.yMin;
    if (cfg.yMax != null) hi = cfg.yMax;
    if (hi === lo) hi = lo + 1;
    var y = function (v) {
      var f = (v - lo) / (hi - lo);
      return cfg.invert ? m.t + f * ih : m.t + ih - f * ih;
    };
    var fmt = cfg.yFmt || function (v) { return Math.round(v); };

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    if (cfg.title) svg.setAttribute('aria-label', cfg.title);
    var out = '';

    var ticks = cfg.yStep ? (function () {
      var t = [], v = Math.ceil(lo / cfg.yStep) * cfg.yStep;
      for (; v <= hi; v += cfg.yStep) t.push(v);
      return t;
    })() : niceTicks(lo, hi, 4);
    ticks.forEach(function (t) {
      var yy = y(t);
      if (yy < m.t - 1 || yy > m.t + ih + 1) return;
      out += '<line class="grid-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yy + '" y2="' + yy + '"/>';
      out += '<text class="axis-label" x="' + (m.l - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(fmt(t)) + '</text>';
    });
    var every = Math.max(1, Math.ceil(n / (cfg.xTicks || Math.max(3, Math.floor(iw / 80)))));
    var xfmt = cfg.xFmt || function (l) { return l; };
    cfg.labels.forEach(function (l, i) {
      if (i % every && i !== n - 1) return;
      if (i === n - 1 && i % every && (n - 1) % every < every * 0.6) return;
      out += '<text class="axis-label" x="' + xc(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(xfmt(l, i)) + '</text>';
    });

    if (cfg.band) {
      var segs = [], cur = [];
      cfg.labels.forEach(function (_, i) {
        var a = cfg.band.lo[i], b = cfg.band.hi[i];
        if (a != null && b != null) cur.push(i); else if (cur.length) { segs.push(cur); cur = []; }
      });
      if (cur.length) segs.push(cur);
      segs.forEach(function (sg) {
        var top = sg.map(function (i) { return xc(i) + ',' + y(cfg.band.hi[i]); });
        var bot = sg.slice().reverse().map(function (i) { return xc(i) + ',' + y(cfg.band.lo[i]); });
        if (sg.length === 1) {
          var i0 = sg[0];
          out += '<rect class="band" x="' + (xc(i0) - step / 2) + '" width="' + step + '" y="' + y(cfg.band.hi[i0]) + '" height="' + Math.abs(y(cfg.band.lo[i0]) - y(cfg.band.hi[i0])) + '"/>';
        } else {
          out += '<polygon class="band" points="' + top.concat(bot).join(' ') + '"/>';
        }
      });
    }

    var bw = Math.max(2, Math.min(step * 0.64, cfg.barMax || 26));
    var base = {}, topIdx = {};
    series.forEach(function (s, si) {
      if (s.type === 'bar' && s.stack) s.values.forEach(function (v, i) { if (v) topIdx[s.stack + i] = si; });
    });
    series.forEach(function (s, si) {
      if (s.type === 'bar') {
        s.values.forEach(function (v, i) {
          if (!v) return;
          var b0 = s.stack ? (base[s.stack + i] || 0) : 0;
          var y1 = y(b0 + v), y0 = y(b0);
          var h = Math.max(0, y0 - y1);
          if (s.stack) {
            base[s.stack + i] = b0 + v;
            if (b0 > 0 && h > 3) { h -= 2; }
          }
          var rounded = !s.stack || topIdx[s.stack + i] === si;
          out += rounded
            ? '<path d="' + barPath(xc(i) - bw / 2, y1, bw, h, 4) + '" fill="' + s.color + '"' + (s.opacity ? ' opacity="' + s.opacity + '"' : '') + '/>'
            : '<rect x="' + (xc(i) - bw / 2) + '" y="' + y1 + '" width="' + bw + '" height="' + h + '" fill="' + s.color + '"/>';
        });
      } else if (s.type === 'range') {
        var rw = Math.max(3, Math.min(bw, 12));
        s.lo.forEach(function (a, i) {
          var b = s.hi[i];
          if (a == null || b == null) return;
          var top = Math.min(y(a), y(b)), h = Math.max(2, Math.abs(y(a) - y(b)));
          out += '<rect x="' + (xc(i) - rw / 2) + '" y="' + top + '" width="' + rw + '" height="' + h + '" rx="' + Math.min(4, rw / 2) + '" fill="' + s.color + '"/>';
        });
      }
    });

    (cfg.refs || []).forEach(function (r) {
      var yy = y(r.y);
      out += '<line class="ref-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yy + '" y2="' + yy + '"/>';
      if (r.label) out += '<text class="ref-label" x="' + (W - m.r) + '" y="' + (yy - 5) + '" text-anchor="end">' + esc(r.label) + '</text>';
    });

    series.forEach(function (s) {
      if (s.type === 'bar' || s.type === 'range') return;
      var d = '', pen = false;
      s.values.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + xc(i).toFixed(1) + ',' + y(v).toFixed(1);
        pen = true;
      });
      out += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' +
        (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
      if (s.dots) {
        s.values.forEach(function (v, i) {
          if (v != null) out += '<circle cx="' + xc(i) + '" cy="' + y(v) + '" r="2.6" fill="' + s.color + '" stroke="#0d0e0d" stroke-width="1.5"/>';
        });
      }
    });

    out += '<line class="crosshair" x1="0" x2="0" y1="' + m.t + '" y2="' + (m.t + ih) + '" visibility="hidden"/>';
    out += '<g class="hover-dots"></g>';
    out += '<rect class="hit" x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '" fill="transparent"/>';
    svg.innerHTML = out;
    el.appendChild(svg);

    var ch = svg.querySelector('.crosshair'), dots = svg.querySelector('.hover-dots'), hit = svg.querySelector('.hit');
    function onMove(evt) {
      var rect = svg.getBoundingClientRect();
      var px = (evt.clientX - rect.left) * (W / rect.width);
      var i = clamp(Math.floor((px - m.l) / step), 0, n - 1);
      ch.setAttribute('x1', xc(i));
      ch.setAttribute('x2', xc(i));
      ch.setAttribute('visibility', 'visible');
      var dh = '';
      series.forEach(function (s) {
        if (s.type === 'bar' || s.type === 'range') return;
        var v = s.values[i];
        if (v != null) dh += '<circle cx="' + xc(i) + '" cy="' + y(v) + '" r="4.5" fill="' + s.color + '" stroke="#0d0e0d" stroke-width="2"/>';
      });
      dots.innerHTML = dh;
      var html = cfg.tip ? cfg.tip(i) : '<div class="tt-h">' + esc(xfmt(cfg.labels[i], i)) + '</div>' + series.map(function (s) {
        var v = s.type === 'range' ? (s.lo[i] != null ? fmt(s.lo[i]) + '–' + fmt(s.hi[i]) : null) : s.values[i];
        if (v == null) return '';
        return tipRow(s.color, s.name, s.type === 'range' ? v : (s.fmt || fmt)(v));
      }).join('');
      showTip(evt, html);
    }
    function onLeave() { ch.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; hideTip(); }
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerdown', onMove);
    hit.addEventListener('pointerleave', onLeave);
    charts.push({ el: el, cfg: cfg, w: el.clientWidth, fn: chart });
  }

  function scatter(el, cfg) {
    el.innerHTML = '';
    el.classList.add('chart');
    var W = Math.max(260, el.clientWidth), H = cfg.height || 240;
    var m = { t: 12, r: 14, b: 34, l: 40 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xs = cfg.points.map(function (p) { return p.x; }), ys = cfg.points.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys.concat([cfg.yMin == null ? Infinity : cfg.yMin])), y1 = Math.max.apply(null, ys.concat([cfg.yMax == null ? -Infinity : cfg.yMax]));
    var px = (x1 - x0 || 1) * 0.06; x0 -= px; x1 += px;
    if (cfg.yMin == null) y0 -= (y1 - y0 || 1) * 0.06;
    if (cfg.yMax == null) y1 += (y1 - y0 || 1) * 0.06;
    var X = function (v) { return m.l + (v - x0) / (x1 - x0) * iw; };
    var Y = function (v) { return m.t + ih - (v - y0) / (y1 - y0) * ih; };
    var out = '';
    niceTicks(y0, y1, 4).forEach(function (t) {
      out += '<line class="grid-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/>' +
        '<text class="axis-label" x="' + (m.l - 8) + '" y="' + (Y(t) + 4) + '" text-anchor="end">' + esc((cfg.yFmt || Math.round)(t)) + '</text>';
    });
    niceTicks(x0, x1, 5).forEach(function (t) {
      out += '<text class="axis-label" x="' + X(t) + '" y="' + (H - 18) + '" text-anchor="middle">' + esc((cfg.xFmt || Math.round)(t)) + '</text>';
    });
    out += '<text class="axis-label" x="' + (m.l + iw / 2) + '" y="' + (H - 2) + '" text-anchor="middle" font-style="italic">' + esc(cfg.xLabel) + '</text>';
    // least-squares trend
    var mx = avg(xs), my = avg(ys), num = 0, den = 0;
    xs.forEach(function (x, i) { num += (x - mx) * (ys[i] - my); den += Math.pow(x - mx, 2); });
    if (den) {
      var b = num / den, a = my - b * mx;
      var xa = Math.min.apply(null, xs), xb = Math.max.apply(null, xs);
      out += '<line class="ref-line" x1="' + X(xa) + '" y1="' + Y(a + b * xa) + '" x2="' + X(xb) + '" y2="' + Y(a + b * xb) + '"/>';
    }
    cfg.points.forEach(function (p, i) {
      out += '<circle data-i="' + i + '" cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="4.5" fill="' + cfg.color + '" stroke="#0d0e0d" stroke-width="2"/>';
    });
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);
    svg.innerHTML = out;
    el.appendChild(svg);
    $all('circle', svg).forEach(function (c) {
      var p = cfg.points[+c.getAttribute('data-i')];
      c.style.cursor = 'default';
      c.addEventListener('pointerenter', function (e) { c.setAttribute('r', 6.5); showTip(e, cfg.tip(p)); });
      c.addEventListener('pointerleave', function () { c.setAttribute('r', 4.5); hideTip(); });
    });
    charts.push({ el: el, cfg: cfg, w: el.clientWidth, fn: scatter });
  }

  function spark(values, color) {
    var v = values.filter(function (x) { return x != null; });
    if (v.length < 2) return '';
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), span = hi - lo || 1;
    var d = '', pen = false, n = values.length;
    values.forEach(function (x, i) {
      if (x == null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + (i / (n - 1) * 100).toFixed(2) + ',' + (27 - (x - lo) / span * 24).toFixed(2);
      pen = true;
    });
    var lx = 100, ly = 27 - (v[v.length - 1] - lo) / span * 24;
    return '<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + color +
      '" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><circle cx="' + lx + '" cy="' + ly + '" r="2" fill="' + color + '"/></svg>';
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      charts.forEach(function (c) {
        if (c.el.isConnected && Math.abs(c.el.clientWidth - c.w) > 4) c.fn(c.el, c.cfg);
      });
      charts = charts.filter(function (c) { return c.el.isConnected; });
    }, 150);
  });

  // ---------- colors ----------

  var C = { s1: '#c98500', s2: '#3987e5', s3: '#d95926', s4: '#9085e9' };
  var ZONES = ['#7a4a22', '#a5622c', '#c9813a', '#e0a53a', '#f0cf86'];

  function levelOf(v, good, warn, higherIsBetter) {
    if (v == null) return 'info';
    if (higherIsBetter === false) return v <= good ? 'good' : v <= warn ? 'warn' : 'bad';
    return v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
  }
  function statusTag(level, text) { return '<span class="status ' + level + '">' + esc(text) + '</span>'; }
  function titleCase(s) { return s ? String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '—'; }

  // ---------- panel framework ----------

  var TABS = {};
  function panel(tab, id, title, span, build, opts) {
    (TABS[tab] = TABS[tab] || []).push({ id: id, title: title, span: span, build: build, opts: opts || {} });
  }

  function renderView() {
    charts = [];
    hideTip();
    var view = $('#view');
    var list = TABS[state.tab] || [];
    var mounts = [];
    var html = '<div class="grid">' + list.map(function (p) {
      if (state.hidden.indexOf(p.id) !== -1) return '';
      var built = p.build();
      if (!built) return '';
      if (built.mount) mounts.push(built.mount);
      var collapsed = state.collapsed.indexOf(p.id) !== -1;
      return '<section class="panel span-' + p.span + (p.opts.bare ? ' bare' : '') + (collapsed ? ' collapsed' : '') + '" data-panel="' + p.id + '">' +
        '<header class="panel-head"><h3>' + esc(p.title) + '</h3><div class="panel-tools">' + (built.tools || '') +
        '<button class="icon-btn collapse-btn" type="button" aria-label="Collapse panel" title="Collapse">&minus;</button></div></header>' +
        (built.sub ? '<p class="panel-sub">' + built.sub + '</p>' : '') +
        '<div class="panel-body">' + built.html + '</div></section>';
    }).join('') + '</div>';
    view.innerHTML = html;
    mounts.forEach(function (fn) { fn(); });
    $all('.collapse-btn', view).forEach(function (b) {
      b.addEventListener('click', function () {
        var sec = b.closest('.panel'), id = sec.getAttribute('data-panel');
        sec.classList.toggle('collapsed');
        var i = state.collapsed.indexOf(id);
        if (i === -1) state.collapsed.push(id); else state.collapsed.splice(i, 1);
        store.set('collapsed', state.collapsed);
        if (!sec.classList.contains('collapsed')) {
          charts.forEach(function (c) { if (sec.contains(c.el)) c.fn(c.el, c.cfg); });
        }
      });
    });
    requestAnimationFrame(function () {
      setTimeout(function () {
        $all('.bar-fill', view).forEach(function (b) { b.classList.add('filled'); });
        $all('.hbar-fill[data-w]', view).forEach(function (b) { b.style.width = b.getAttribute('data-w'); });
      }, 80);
    });
  }

  function seg(name, options, current) {
    return '<div class="seg" data-seg="' + name + '">' + options.map(function (o) {
      return '<button type="button" data-v="' + esc(o[0]) + '" aria-pressed="' + (String(o[0]) === String(current)) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function bindSeg(root, name, fn) {
    var s = root.querySelector('[data-seg="' + name + '"]');
    if (!s) return;
    $all('button', s).forEach(function (b) {
      b.addEventListener('click', function () {
        $all('button', s).forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        fn(b.getAttribute('data-v'));
      });
    });
  }
  function panelEl(id) { return $('[data-panel="' + id + '"]'); }

  // ---------- goal hero ----------

  function renderGoal() {
    var g = goal(), days = daysToRace(), t = targetSeconds(), pred = predictedFor(g.distance_km);
    var eyebrow = days > 0 ? 'Next race' : days === 0 ? 'Race day' : 'Last race';
    var cd = days > 1 ? days + '<small>days</small>' : days === 1 ? '1<small>day</small>' : days === 0 ? 'Today' : Math.abs(days) + '<small>days ago</small>';
    var distLabel = { '5': '5K', '10': '10K', '21.0975': 'Half marathon', '42.195': 'Marathon' }[String(g.distance_km)] || fmtDist(g.distance_km);
    $('#goal').innerHTML =
      '<div><p class="eyebrow">' + eyebrow + ' · ' + esc(distLabel) + '</p><h2 class="goal-name">' + esc(g.name) + '</h2>' +
      '<p class="goal-date">' + longDate(g.date) + '</p></div>' +
      '<div class="goal-stats">' +
      '<div class="goal-stat goal-countdown"><div class="v">' + cd + '</div><div class="k">Countdown</div></div>' +
      '<div class="goal-stat"><div class="v">' + fmtClock(t) + '</div><div class="k">' + (g.target_s ? 'Target' : 'Target · Garmin est.') + '</div></div>' +
      '<div class="goal-stat"><div class="v">' + fmtPace(t / g.distance_km, false) + '<small>/' + units() + '</small></div><div class="k">Goal pace</div></div>' +
      '<div class="goal-stat"><div class="v">' + fmtClock(pred) + '</div><div class="k">Garmin predicts</div></div>' +
      '</div>' +
      '<div class="goal-actions"><button class="tr-btn" type="button" id="editGoalBtn">Edit goal</button>' +
      '<button class="tr-btn" type="button" id="planBtn">Race plan &rarr;</button></div>' +
      '<form class="goal-form" id="goalForm" hidden>' +
      '<div class="field"><label for="gName">Race</label><input class="tr-input left" id="gName" value="' + esc(g.name) + '"></div>' +
      '<div class="field"><label for="gDate">Date</label><input class="tr-input left" id="gDate" type="date" value="' + esc(g.date) + '"></div>' +
      '<div class="field"><label for="gDist">Distance</label><select class="tr-input left" id="gDist">' +
      [['5', '5K'], ['10', '10K'], ['21.0975', 'Half marathon'], ['42.195', 'Marathon']].map(function (o) {
        return '<option value="' + o[0] + '"' + (Math.abs(+o[0] - g.distance_km) < 0.01 ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label for="gTime">Target (h:mm:ss)</label><input class="tr-input left" id="gTime" placeholder="Garmin estimate" value="' + (g.target_s ? fmtClock(g.target_s) : '') + '"></div>' +
      '<div class="form-row" style="margin:0"><button class="tr-btn primary" type="submit">Save</button><button class="tr-btn" type="button" id="goalReset">Reset</button></div>' +
      '</form>';
    $('#editGoalBtn').addEventListener('click', function () { $('#goalForm').hidden = !$('#goalForm').hidden; });
    $('#planBtn').addEventListener('click', function () { setTab('race'); });
    $('#goalForm').addEventListener('submit', function (e) {
      e.preventDefault();
      store.set('goal', {
        name: $('#gName').value.trim() || 'Next race',
        date: $('#gDate').value || D.goal.date,
        distance_km: +$('#gDist').value,
        target_s: parseClock($('#gTime').value)
      });
      renderAll();
    });
    $('#goalReset').addEventListener('click', function () { store.del('goal'); renderAll(); });
  }

  // ---------- OVERVIEW ----------

  panel('overview', 'ov-tiles', 'Today', 12, function () {
    var rows = rangeRows(), L = last(D.daily);
    function series(k) { return rows.map(function (r) { return r[k]; }); }
    var hrv7 = avg(D.daily.slice(-7).map(function (r) { return r.hrv; }));
    var sleep7 = avg(D.daily.slice(-7).map(function (r) { return r.sleep_min; }));
    var rhrBase = avg(D.daily.map(function (r) { return r.rhr; }));
    var readinessLevel = levelOf(L.readiness, 60, 30);
    var tiles = [
      { k: 'Training readiness', v: L.readiness == null ? '—' : L.readiness, unit: '/100', d: statusTag(readinessLevel, titleCase(L.readiness_level)), s: series('readiness'), c: C.s1 },
      { k: 'HRV last night', v: L.hrv == null ? '—' : L.hrv, unit: 'ms', d: '7-day ' + Math.round(hrv7) + ' · base ' + (L.hrv_base_low || '—') + '–' + (L.hrv_base_high || '—'), s: series('hrv'), c: C.s2 },
      { k: 'Resting HR', v: L.rhr == null ? '—' : L.rhr, unit: 'bpm', d: 'Average ' + Math.round(rhrBase) + ' bpm', s: series('rhr'), c: C.s3 },
      { k: 'Sleep last night', v: fmtHM(L.sleep_min), unit: '', d: 'Score ' + (L.sleep_score || '—') + ' · 7-day ' + fmtHM(sleep7), s: series('sleep_min'), c: C.s4 },
      { k: 'Body Battery', v: L.bb_high == null ? '—' : L.bb_high, unit: 'peak', d: '+' + (L.bb_charged || 0) + ' charged · −' + (L.bb_drained || 0) + ' drained', s: series('bb_high'), c: C.s1 },
      { k: 'VO₂ max', v: lastVal(D.daily, 'vo2max') == null ? '—' : lastVal(D.daily, 'vo2max').toFixed(1), unit: '', d: 'Fitness age ' + (D.athlete.fitness_age || '—'), s: series('vo2max'), c: C.s2 },
      { k: 'Training status', v: titleCase(L.status), unit: '', d: 'Load ' + (L.acute || '—') + ' acute · ' + (L.chronic || '—') + ' chronic', s: series('acute'), c: C.s3 },
      { k: 'Acute : chronic', v: L.acwr == null ? '—' : L.acwr.toFixed(1), unit: '', d: statusTag(L.acwr == null ? 'info' : L.acwr > 1.5 ? 'bad' : L.acwr > 1.3 ? 'warn' : 'good', titleCase(L.acwr_status || '')), s: series('acwr'), c: C.s4 }
    ];
    return {
      sub: 'Latest Garmin values, synced ' + esc(D.generated.replace('T', ' ')) + '. Sparklines cover the selected range.',
      html: '<div class="tiles">' + tiles.map(function (t) {
        var big = String(t.v).length > 8;
        return '<div class="tile"><div class="k">' + t.k + '</div><div class="v"' + (big ? ' style="font-size:1.35rem;padding:6px 0"' : '') + '>' + esc(t.v) +
          (t.unit ? '<small>' + t.unit + '</small>' : '') + '</div><div class="d">' + t.d + '</div>' + spark(t.s, t.c) + '</div>';
      }).join('') + '</div>'
    };
  }, { bare: true });

  function readinessScores() {
    var g = goal(), t = targetSeconds(), pred = predictedFor(g.distance_km);
    var out = [];
    var fit = g.target_s && pred ? clamp(Math.round(100 - Math.max(0, pred - g.target_s) / 60 * 5), 0, 100) : 88;
    out.push({
      name: 'Fitness', pct: fit,
      note: g.target_s
        ? 'Garmin predicts ' + fmtClock(pred) + ' against your ' + fmtClock(g.target_s) + ' target. Each minute the prediction is slower than target costs 5 points. VO₂ max climbed from ' + D.daily.find(function (r) { return r.vo2max; }).vo2max.toFixed(1) + ' to ' + lastVal(D.daily, 'vo2max').toFixed(1) + ' in this block.'
        : 'No target set, so this tracks Garmin\'s prediction of ' + fmtClock(pred) + '. VO₂ max climbed to ' + lastVal(D.daily, 'vo2max').toFixed(1) + ' through the block. Set a target time with “Edit goal” to score against it.'
    });
    var longs = D.activities.filter(function (a) { return a.is_run && a.dist_km >= 28; });
    var dec = avg(longs.map(function (a) { return a.decoupling_pct; }));
    var dur = clamp(Math.round(Math.min(longs.length, 3) / 3 * 70 + (dec == null ? 15 : clamp(30 - (dec - 3) * 4, 0, 30))), 0, 100);
    out.push({
      name: 'Durability', pct: dur,
      note: longs.length + ' run' + (longs.length === 1 ? '' : 's') + ' of 28 km+ (' + longs.map(function (a) { return shortDate(a.date) + ' ' + fmtDist(a.dist_km, 0); }).join(', ') + '). ' +
        (dec != null ? 'Average aerobic decoupling on them was ' + dec.toFixed(1) + '%; under 5% is ideal. Higher drift means pace fades for the same heart rate late in the run — the antidote on race day is a patient first 10 km.' : '')
    });
    var base = last(D.daily), mid = base.hrv_base_low && base.hrv_base_high ? (base.hrv_base_low + base.hrv_base_high) / 2 : avg(D.daily.map(function (r) { return r.hrv; }));
    var hrv7 = avg(D.daily.slice(-7).map(function (r) { return r.hrv; }));
    var rec = clamp(Math.round(hrv7 / mid * 100), 0, 100);
    out.push({ name: 'Recovery', pct: rec, note: '7-night HRV average ' + Math.round(hrv7) + ' ms vs the middle of your baseline (' + Math.round(mid) + ' ms). Status: ' + titleCase(base.hrv_status) + '. This should climb as the taper and extra sleep kick in.' });
    var s7 = avg(D.daily.slice(-7).map(function (r) { return r.sleep_min; }));
    out.push({ name: 'Sleep', pct: clamp(Math.round(s7 / 480 * 100), 0, 100), note: 'Averaging ' + fmtHM(s7) + ' over the last 7 nights against an 8-hour target. This is the weakest link — and the easiest one to fix before race day.' });
    var days = daysToRace();
    var peak = Math.max.apply(null, D.weekly.map(function (w) { return w.run_km; }));
    var last7 = sum(D.activities.filter(function (a) { return a.is_run && a.date > isoDate(addDays(todayDate(), -7)); }).map(function (a) { return a.dist_km; }));
    var ratio = last7 / peak;
    var taper = days > 21 ? null : clamp(Math.round(ratio <= 0.65 ? 100 : 100 - (ratio - 0.65) * 180), 0, 100);
    if (taper != null) out.push({ name: 'Taper', pct: taper, note: 'Last 7 days: ' + fmtDist(last7, 0) + ' against a peak week of ' + fmtDist(peak, 0) + ' (' + Math.round(ratio * 100) + '%). Race week should land around 30–45% of peak with a few short bursts at goal pace.' });
    return out;
  }

  panel('overview', 'ov-ready', 'Race readiness', 6, function () {
    var scores = readinessScores();
    return {
      sub: 'How ready you look for ' + esc(goal().name) + '. Click a bar for the reasoning behind the number.',
      html: '<div class="ready-list">' + scores.map(function (s, i) {
        return '<button class="ready-item" type="button" data-i="' + i + '"><div class="training-row"><span>' + s.name + '</span><span class="pct">' + s.pct + '%</span></div>' +
          '<div class="bar"><div class="bar-fill" style="--pct:' + s.pct + '%"></div></div></button>';
      }).join('') + '</div><div class="ready-note" id="readyNote"><span class="detail-hint">Click a bar above for notes.</span></div>',
      mount: function () {
        $all('.ready-item').forEach(function (b) {
          b.addEventListener('click', function () {
            $all('.ready-item').forEach(function (x) { x.classList.toggle('active', x === b); });
            $('#readyNote').textContent = scores[+b.getAttribute('data-i')].note;
          });
        });
      }
    };
  });

  panel('overview', 'ov-week', 'This week vs last', 6, function () {
    var end = parseDate(last(D.daily).date);
    function windowStats(fromBack, toBack) {
      var a = isoDate(addDays(end, -toBack + 1)), b = isoDate(addDays(end, -fromBack));
      var days = D.daily.filter(function (r) { return r.date >= a && r.date <= b; });
      var acts = D.activities.filter(function (x) { return x.date >= a && x.date <= b; });
      var runs = acts.filter(function (x) { return x.is_run; });
      return {
        dist: sum(runs.map(function (x) { return x.dist_km; })),
        time: sum(acts.map(function (x) { return x.moving_s || x.dur_s; })) / 60,
        runs: runs.length,
        load: sum(acts.map(function (x) { return x.load; })),
        sleep: avg(days.map(function (r) { return r.sleep_min; })),
        hrv: avg(days.map(function (r) { return r.hrv; })),
        rhr: avg(days.map(function (r) { return r.rhr; })),
        ready: avg(days.map(function (r) { return r.readiness; }))
      };
    }
    var a = windowStats(0, 7), b = windowStats(7, 14);
    var rows = [
      ['Running distance', fmtDist(a.dist), fmtDist(b.dist), a.dist - b.dist, null],
      ['Training time', fmtHM(a.time), fmtHM(b.time), a.time - b.time, null],
      ['Runs', a.runs, b.runs, a.runs - b.runs, null],
      ['Training load', Math.round(a.load), Math.round(b.load), a.load - b.load, null],
      ['Avg sleep', fmtHM(a.sleep), fmtHM(b.sleep), a.sleep - b.sleep, true],
      ['Avg HRV', Math.round(a.hrv) + ' ms', Math.round(b.hrv) + ' ms', a.hrv - b.hrv, true],
      ['Avg resting HR', Math.round(a.rhr) + ' bpm', Math.round(b.rhr) + ' bpm', a.rhr - b.rhr, false],
      ['Avg readiness', Math.round(a.ready), Math.round(b.ready), a.ready - b.ready, true]
    ];
    return {
      sub: 'Last 7 days against the 7 before them.',
      html: '<div class="table-wrap"><table><thead><tr><th></th><th class="num">Last 7 days</th><th class="num">Prior 7</th><th class="num">Change</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var d = r[3];
          var tiny = r[0].indexOf('distance') > -1 ? Math.abs(distVal(d)) < 0.05 : Math.abs(d) < 0.5;
          var lvl = r[4] == null || tiny ? '' : (d > 0) === r[4] ? 'good' : 'bad';
          var shown = tiny ? '—' : (d > 0 ? '▲ ' : '▼ ') + (r[0].indexOf('sleep') > -1 || r[0].indexOf('time') > -1 ? fmtHM(Math.abs(d)) : r[0].indexOf('distance') > -1 ? fmtDist(Math.abs(d)) : Math.round(Math.abs(d)));
          return '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td class="num muted">' + r[2] + '</td><td class="num">' +
            (lvl ? '<span class="status ' + lvl + '" style="font-size:.85rem;letter-spacing:0;text-transform:none">' + shown + '</span>' : '<span class="muted">' + shown + '</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
    };
  });

  panel('overview', 'ov-insights', 'What the data says', 12, function () {
    var label = { good: 'Good', warn: 'Watch', bad: 'Fix', info: 'Note' };
    return {
      sub: 'Generated from your data at each sync. Open one for the detail.',
      html: '<div class="accordion">' + D.insights.map(function (ins, i) {
        return '<div class="accordion-item' + (i === 0 ? ' open' : '') + '"><button class="accordion-head" type="button">' +
          statusTag(ins.level, ins.area + ' · ' + label[ins.level]) + '<span class="ins-title">' + esc(ins.title) + '</span><span class="chev">+</span></button>' +
          '<div class="accordion-body"><p>' + esc(ins.text) + '</p></div></div>';
      }).join('') + '</div>',
      mount: function () {
        $all('.accordion-head', panelEl('ov-insights')).forEach(function (h) {
          h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
        });
      }
    };
  });

  // ---------- RACE ----------

  function planDays() {
    var g = goal(), race = parseDate(g.date), w = D.athlete.weight_kg || 75;
    var t = targetSeconds(), mp = t / g.distance_km;
    var z2 = D.athlete.lt_zone_bounds[1];
    var unitLabel = units() === 'mi' ? 'mile' : 'km';
    var cl = Math.round(w * 8), ch = Math.round(w * 10);
    var plan;
    if (isMarathon()) {
      plan = [
        [-7, 'Easy 40–50 min', 'Conversational, heart rate under ' + z2 + ' bpm. If yesterday\'s long run left you flat, make it a rest day instead.'],
        [-6, 'Rest', 'Walk and mobility only. Lights out by 22:30 — banking sleep this week matters more than any workout.'],
        [-5, 'Sharpener: 8 km with 3 × 1 ' + unitLabel + ' at goal pace', 'Goal pace ' + fmtPace(mp) + ', 2 min easy jog between. It should feel controlled, not hard.'],
        [-4, 'Easy 30–40 min', 'Keep it boring. Start shifting meals toward carbohydrate; keep protein steady.'],
        [-3, 'Easy 25–30 min + 4 × 20 s strides', 'Strides at goal-pace effort or slightly quicker, full recovery between.'],
        [-2, 'Rest · carb-load day 1', cl + '–' + ch + ' g carbohydrate across the day (rice, pasta, bread, bagels, juice). Expo and bib pickup — keep standing time short. This is the most important night of sleep.'],
        [-1, 'Shakeout 15–20 min + 3 strides · carb-load day 2', 'Same carb target with low fibre and fat. Lay out kit, pin the bib, charge the watch, set two alarms. A poor night tonight is normal and won\'t hurt the race.'],
        [0, 'Race day — ' + g.name, 'Breakfast about 3 h before the start: ' + Math.round(w * 2) + '–' + Math.round(w * 3) + ' g carbohydrate. Gel 15 min before the gun. Run the first 5 km at ' + fmtPace(mp + 5) + ' or slower, then settle into ' + fmtPace(mp) + '.'],
        [1, 'Recovery', 'Walk, eat, sleep. No running for 3–5 days; easy jogging only after that. Expect HRV to dip for several days.']
      ];
    } else {
      plan = [
        [-6, 'Easy 30–40 min', 'Relaxed, heart rate under ' + z2 + ' bpm.'],
        [-5, 'Rest', 'Mobility and sleep.'],
        [-4, 'Sharpener: 6 × 2 min at goal pace', 'Goal pace ' + fmtPace(mp) + ', 90 s easy between.'],
        [-3, 'Easy 30 min', 'Keep it light.'],
        [-2, 'Easy 20–25 min + 4 strides', 'Strides at race effort, full recovery.'],
        [-1, 'Rest or 15 min shakeout', 'Normal meals with extra carbohydrate. Lay out kit, early night.'],
        [0, 'Race day — ' + g.name, 'Breakfast 2–3 h before. Warm up 10–15 min with strides. Settle into ' + fmtPace(mp) + '.'],
        [1, 'Recovery', 'Easy movement only for 1–3 days.']
      ];
    }
    return plan.map(function (p) {
      var d = addDays(race, p[0]);
      return { offset: p[0], date: isoDate(d), title: p[1], detail: p[2] };
    });
  }

  panel('race', 'race-plan', 'Race-week plan', 7, function () {
    var days = planDays(), today = isoDate(todayDate()), done = store.get('plan-done', {});
    var dtr = daysToRace();
    return {
      sub: (dtr > 7 ? 'Your taper starts on ' + shortDate(days[0].date) + '. Preview below; ' : '') +
        'Built from your goal pace, weight and threshold heart rate. Tick days off as you go — saved in this browser.',
      html: '<ul class="plan">' + days.map(function (d) {
        var dd = parseDate(d.date);
        var off = d.offset === 0 ? 'Race' : d.offset > 0 ? '+' + d.offset : d.offset;
        var key = goal().date + ':' + d.offset;
        return '<li class="' + (d.date === today ? 'is-today ' : '') + (d.offset === 0 ? 'is-race ' : '') + (done[key] ? 'done' : '') + '">' +
          '<input type="checkbox" data-key="' + esc(key) + '"' + (done[key] ? ' checked' : '') + ' aria-label="Mark ' + esc(d.title) + ' done">' +
          '<div class="plan-day">' + DOW[dd.getDay()] + ' ' + MON[dd.getMonth()] + ' ' + dd.getDate() + '<br>' + (d.date === today ? '<span class="amber">Today</span>' : 'Day ' + off) + '</div>' +
          '<div><div class="plan-title">' + esc(d.title) + '</div><div class="plan-detail">' + esc(d.detail) + '</div></div></li>';
      }).join('') + '</ul>',
      mount: function () {
        $all('.plan input').forEach(function (c) {
          c.addEventListener('change', function () {
            var all = store.get('plan-done', {});
            if (c.checked) all[c.getAttribute('data-key')] = true; else delete all[c.getAttribute('data-key')];
            store.set('plan-done', all);
            c.closest('li').classList.toggle('done', c.checked);
          });
        });
      }
    };
  });

  function checkpoints(km) {
    var pts = [5, 10, 15, 20, 21.0975, 25, 30, 35, 40].filter(function (x) { return x < km - 0.01; });
    pts.push(km);
    return pts;
  }

  panel('race', 'race-pace', 'Pacing', 5, function () {
    var g = goal(), t = targetSeconds();
    var strat = store.get('strategy', 'even');
    var lthr = D.athlete.lthr, ltp = D.athlete.lt_pace_s_km;
    var est = ltp && isMarathon() ? [ltp * 1.06 * 42.195, ltp * 1.10 * 42.195] : null;
    function splitTime(km) {
      var p = t / g.distance_km;
      if (strat === 'negative') {
        var h = g.distance_km / 2, p1 = p * 1.01, p2 = (t - h * p1) / h;
        return km <= h ? km * p1 : h * p1 + (km - h) * p2;
      }
      if (strat === 'patient') {
        var first = Math.min(5, g.distance_km), pf = p + 8, pr = (t - first * pf) / (g.distance_km - first);
        return km <= first ? km * pf : first * pf + (km - first) * pr;
      }
      return km * p;
    }
    var rows = checkpoints(g.distance_km).map(function (km, i, arr) {
      var prev = i ? arr[i - 1] : 0, tt2 = splitTime(km), seg2 = (tt2 - splitTime(prev)) / (km - prev);
      var lbl = Math.abs(km - 21.0975) < 0.01 ? 'Half' : km === g.distance_km ? 'Finish' : km + 'K';
      return '<tr><td>' + lbl + (units() === 'mi' ? ' <span class="muted">(' + (km / KM_PER_MI).toFixed(1) + ' mi)</span>' : '') + '</td><td class="num">' + fmtPace(seg2, false) + '</td><td class="num">' + fmtClock(tt2) + '</td></tr>';
    }).join('');
    var hr1 = Math.round(lthr * 0.9), hr2 = Math.round(lthr * 0.94);
    return {
      tools: seg('strategy', [['even', 'Even'], ['patient', 'Patient'], ['negative', 'Negative']], strat),
      sub: 'Target ' + fmtClock(t) + (g.target_s ? '' : ' (Garmin estimate — set your own with “Edit goal”)') + '. Patient = first 5 km 8 s/km slower, then even.',
      html: '<div class="kv">' +
        '<div><div class="k">Goal pace</div><div class="v">' + fmtPace(t / g.distance_km, false) + '<small> /' + units() + '</small></div></div>' +
        '<div><div class="k">Garmin predicts</div><div class="v">' + fmtClock(predictedFor(g.distance_km)) + '</div></div>' +
        (est ? '<div><div class="k">Threshold estimate</div><div class="v">' + fmtClock(est[0]).slice(0, -3) + '–' + fmtClock(est[1]).slice(0, -3) + '</div></div>' : '') +
        '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Split</th><th class="num">Pace /' + units() + '</th><th class="num">Clock</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<ul class="notes" style="margin-top:16px">' +
        '<li><b>First ' + (isMarathon() ? '10 km' : 'third') + ':</b> heart rate at or under ' + hr1 + ' bpm. If it\'s higher at goal pace, ease off — it\'s early.</li>' +
        '<li><b>Middle:</b> ' + hr1 + '–' + hr2 + ' bpm is your marathon-effort band (90–94% of your ' + lthr + ' bpm threshold).</li>' +
        '<li><b>Final ' + (isMarathon() ? '10 km' : 'third') + ':</b> let heart rate rise and run by feel.</li></ul>',
      mount: function () {
        bindSeg(panelEl('race-pace'), 'strategy', function (v) { store.set('strategy', v); renderView(); });
      }
    };
  });

  panel('race', 'race-fuel', 'Fuelling', 6, function () {
    var g = goal(), t = targetSeconds(), w = D.athlete.weight_kg || 75;
    var rate = +store.get('carbRate', 75), gel = +store.get('gelSize', 25);
    var interval = gel / rate * 60;
    var times = [];
    for (var m = interval; m < t / 60 - 10; m += interval) times.push(m);
    var pace = t / g.distance_km;
    return {
      tools: seg('carbRate', [[60, '60 g/h'], [75, '75'], [90, '90']], rate),
      sub: 'Carbohydrate per hour on course. 60 is the floor; 90 needs gut training you\'ve practised on long runs.',
      html: '<div class="kv">' +
        '<div><div class="k">Carb-load (2 days)</div><div class="v">' + Math.round(w * 8) + '–' + Math.round(w * 10) + '<small> g/day</small></div></div>' +
        '<div><div class="k">Breakfast (−3 h)</div><div class="v">' + Math.round(w * 2) + '–' + Math.round(w * 3) + '<small> g</small></div></div>' +
        '<div><div class="k">On course</div><div class="v">' + Math.round(rate * t / 3600) + '<small> g total</small></div></div>' +
        '<div><div class="k">' + gel + ' g gels</div><div class="v">' + (times.length + 1) + '<small> incl. pre-start</small></div></div>' +
        '</div>' +
        '<div class="form-row"><div class="field"><label for="gelSize">Gel size (g carbs)</label><input class="tr-input left" id="gelSize" type="number" min="15" max="60" value="' + gel + '" style="width:110px"></div></div>' +
        '<div class="table-wrap"><table><thead><tr><th>When</th><th class="num">Clock</th><th class="num">Approx. distance</th></tr></thead><tbody>' +
        '<tr><td>Before the start</td><td class="num">−0:15</td><td class="num muted">—</td></tr>' +
        times.map(function (mm, i) {
          return '<tr><td>Gel ' + (i + 1) + '</td><td class="num">' + fmtClock(mm * 60) + '</td><td class="num">' + fmtDist(mm * 60 / pace) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<ul class="notes" style="margin-top:14px"><li><b>Fluid:</b> 400–800 ml per hour depending on heat; drink to thirst at aid stations rather than skipping them.</li>' +
        '<li><b>Sodium:</b> 300–600 mg per hour, more if you\'re a salty sweater or it\'s warm.</li>' +
        '<li><b>Nothing new</b> on race day — use gels and drinks you\'ve already trained with.</li></ul>',
      mount: function () {
        var p = panelEl('race-fuel');
        bindSeg(p, 'carbRate', function (v) { store.set('carbRate', +v); renderView(); });
        $('#gelSize').addEventListener('change', function () { store.set('gelSize', clamp(+this.value || 25, 10, 80)); renderView(); });
      }
    };
  });

  panel('race', 'race-pred', 'Predictions & records', 6, function () {
    var p = D.predictions, g = goal();
    var pr = {};
    D.prs.forEach(function (r) { pr[r.label] = r; });
    var rows = [['5K', 5, p['5k'], pr['5 km']], ['10K', 10, p['10k'], pr['10 km']], ['Half', 21.0975, p.half, pr['Half marathon']], ['Marathon', 42.195, p.marathon, pr.Marathon]];
    return {
      sub: 'Garmin race predictor against your fastest recorded efforts in this data.',
      html: '<div class="table-wrap"><table><thead><tr><th>Distance</th><th class="num">Predicted</th><th class="num">Pace</th><th class="num">Best effort</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var hl = Math.abs(r[1] - g.distance_km) < 0.1;
          return '<tr' + (hl ? ' class="today"' : '') + '><td>' + (hl ? '<span class="amber">' + r[0] + '</span>' : r[0]) + '</td><td class="num">' + fmtClock(r[2]) +
            '</td><td class="num muted">' + fmtPace(r[2] / r[1]) + '</td><td class="num">' + (r[3] ? fmtClock(r[3].value) + ' <span class="muted">' + shortDate(r[3].date) + '</span>' : '<span class="muted">—</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<ul class="notes" style="margin-top:14px">' +
        D.prs.filter(function (r) { return r.label === '1 km' || r.label === '1 mile' || r.is_distance; }).map(function (r) {
          return '<li><b>' + r.label + ':</b> ' + (r.is_distance ? fmtDist(r.value / 1000) : fmtClock(r.value)) + ' <span class="muted">(' + shortDate(r.date) + ')</span></li>';
        }).join('') +
        '<li><b>Threshold:</b> ' + D.athlete.lthr + ' bpm at ' + fmtPace(D.athlete.lt_pace_s_km) + (D.athlete.ftp_w ? ' · running FTP ' + D.athlete.ftp_w + ' W' : '') + '</li></ul>'
    };
  });

  panel('race', 'race-notes', 'Course notes', 12, function () {
    var g = goal();
    var chicago = /chicago/i.test(g.name);
    var notes = chicago ? [
      ['Flat and fast', 'There is barely any elevation change, so even effort ≈ even pace. Your splits table is the plan.'],
      ['GPS in the Loop', 'Tall buildings downtown scramble GPS — your watch\'s pace and distance will drift (it usually reads long). Take a manual lap at each mile marker, or pace off the clock split at each marker instead of the watch\'s live pace.'],
      ['“Mount Roosevelt”', 'A short rise onto Roosevelt Road just before the finish. Pace will dip for a minute — expect it and don\'t chase it.'],
      ['Start logistics', 'Get into your corral early in Grant Park and bring a throwaway layer — October mornings by the lake are often cool. Go easy through the first crowded mile.'],
      ['Wind', 'Exposed stretches near the lake can be breezy. Tuck in behind a group at your pace when you can.']
    ] : [
      ['Know the course', 'Check the elevation profile and where aid stations are; adjust the splits table for hills.'],
      ['Start patiently', 'The first kilometres always feel easy. Bank nothing — bank energy.'],
      ['Pace by effort on hills', 'Hold heart rate and effort steady uphill and let pace come back on the descents.']
    ];
    return {
      sub: chicago ? 'Specific to Chicago.' : 'General notes — rename the goal to a known race for specifics.',
      html: '<ul class="notes">' + notes.map(function (n) { return '<li><b>' + n[0] + ':</b> ' + n[1] + '</li>'; }).join('') + '</ul>'
    };
  });

  // ---------- TRAINING ----------

  panel('training', 'tr-weekly', 'Weekly volume', 8, function () {
    return {
      sub: 'Running distance per week (Mon–Sun) with the longest run that week. Hover for time, load and runs.',
      html: '<div id="cWeekly"></div>',
      mount: function () {
        var W = D.weekly;
        chart($('#cWeekly'), {
          labels: W.map(function (w) { return w.week; }),
          xFmt: shortDate,
          yFmt: function (v) { return Math.round(v); },
          series: [
            { name: 'Weekly distance (' + units() + ')', type: 'bar', color: C.s1, values: W.map(function (w) { return distVal(w.run_km); }) },
            { name: 'Longest run (' + units() + ')', type: 'line', dots: true, color: C.s2, values: W.map(function (w) { return distVal(w.long_km); }) }
          ],
          tip: function (i) {
            var w = W[i];
            return '<div class="tt-h">Week of ' + shortDate(w.week) + '</div>' + tipRow(C.s1, 'Distance', fmtDist(w.run_km)) + tipRow(C.s2, 'Long run', fmtDist(w.long_km)) +
              tipRow(null, 'Runs', w.runs) + tipRow(null, 'Run time', fmtHM(w.run_s / 60)) + tipRow(null, 'Other training', fmtHM(w.other_s / 60)) + tipRow(null, 'Load', w.load);
          }
        });
      }
    };
  });

  panel('training', 'tr-balance', 'Load focus (4 weeks)', 4, function () {
    var L = last(D.daily);
    var rows = [['Low aerobic', 'easy base', L.load_low, L.load_low_target], ['High aerobic', 'tempo / threshold', L.load_high, L.load_high_target], ['Anaerobic', 'VO₂ / sprints', L.load_anaerobic, L.load_anaerobic_target]];
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r[2] || 0, r[3][1] || 0); })) * 1.08;
    return {
      sub: 'Garmin\'s 4-week training load by type. The dashed box is the target range. Feedback: ' + esc(titleCase(L.load_feedback)) + '.',
      html: '<div class="hbars">' + rows.map(function (r, i) {
        var lvl = r[2] < r[3][0] ? 'Below' : r[2] > r[3][1] ? 'Above' : 'In range';
        return '<div class="hbar-row" style="grid-template-columns:96px minmax(0,1fr) 54px"><div class="lbl">' + r[0] + '<small>' + r[1] + '</small></div><div class="hbar-track">' +
          '<div class="hbar-target" style="left:' + (r[3][0] / max * 100) + '%;width:' + ((r[3][1] - r[3][0]) / max * 100) + '%"></div>' +
          '<div class="hbar-fill" data-w="' + (r[2] / max * 100) + '%" style="width:0;background:' + [C.s2, C.s1, C.s3][i] + '"></div></div>' +
          '<div class="val">' + Math.round(r[2]) + '<br><small>' + lvl + '</small></div></div>';
      }).join('') + '</div>'
    };
  });

  panel('training', 'tr-load', 'Acute vs chronic load', 8, function () {
    return {
      sub: 'Acute (7-day) against chronic (4-week) training load. When acute sits well above chronic you\'re building; below it you\'re absorbing.',
      html: '<div id="cLoad"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cLoad'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate,
          series: [
            { name: 'Acute load', type: 'line', color: C.s1, values: rows.map(function (r) { return r.acute; }) },
            { name: 'Chronic load', type: 'line', color: C.s2, values: rows.map(function (r) { return r.chronic; }) }
          ],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">' + shortDate(r.date) + '</div>' + tipRow(C.s1, 'Acute', r.acute) + tipRow(C.s2, 'Chronic', r.chronic) +
              tipRow(null, 'Ratio', r.acwr == null ? '—' : r.acwr.toFixed(1)) + tipRow(null, 'Status', titleCase(r.status));
          }
        });
      }
    };
  });

  panel('training', 'tr-vo2', 'VO₂ max', 4, function () {
    return {
      sub: 'Garmin\'s running VO₂ max estimate.',
      html: '<div id="cVo2"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cVo2'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, xTicks: 3,
          yFmt: function (v) { return v.toFixed(1); },
          series: [{ name: 'VO₂ max', type: 'line', dots: true, color: C.s1, values: (function () {
            var lastV = null;
            return rows.map(function (r) { if (r.vo2max) lastV = r.vo2max; return lastV; });
          })() }]
        });
      }
    };
  });

  panel('training', 'tr-zones', 'Intensity by week', 8, function () {
    return {
      sub: 'Hours of running in each zone, using threshold-based zones (LTHR ' + D.athlete.lthr + ' bpm) from second-by-second heart rate.',
      html: '<div id="cZones"></div>',
      mount: function () {
        var W = D.weekly;
        chart($('#cZones'), {
          labels: W.map(function (w) { return w.week; }), xFmt: shortDate,
          yFmt: function (v) { return v.toFixed(v < 2 ? 1 : 0) + 'h'; },
          series: D.athlete.lt_zone_names.map(function (nm, z) {
            return { name: 'Z' + (z + 1) + ' ' + nm, type: 'bar', stack: 'z', color: ZONES[z], values: W.map(function (w) { return w.lt_zones_s[z] / 3600; }), fmt: function (v) { return fmtHM(v * 60); } };
          })
        });
      }
    };
  });

  panel('training', 'tr-zonekey', 'Zone distribution', 4, function () {
    var runs = rangeActs().filter(function (a) { return a.lt_zones_s; });
    var lt = [0, 1, 2, 3, 4].map(function (z) { return sum(runs.map(function (a) { return a.lt_zones_s[z]; })); });
    var gz = [0, 1, 2, 3, 4].map(function (z) { return sum(runs.map(function (a) { return a.garmin_zones_s[z]; })); });
    var lts = sum(lt) || 1, gs = sum(gz) || 1;
    var b = D.athlete.lt_zone_bounds, gb = D.athlete.garmin_zone_bounds;
    var ltB = ['< ' + b[0], b[0] + '–' + (b[1] - 1), b[1] + '–' + (b[2] - 1), b[2] + '–' + (b[3] - 1), b[3] + '+'];
    function bar(arr, total) {
      return '<div class="stackbar">' + arr.map(function (v, z) { return v ? '<div style="flex:' + v + ';background:' + ZONES[z] + '" title="Z' + (z + 1) + ' ' + Math.round(v / total * 100) + '%"></div>' : ''; }).join('') + '</div>';
    }
    return {
      sub: 'Same runs, two zone systems, over the selected range.',
      html: '<div class="eyebrow">Threshold zones (used here)</div>' + bar(lt, lts) +
        '<div class="eyebrow" style="margin-top:16px">Garmin default zones</div>' + bar(gz, gs) +
        '<div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Zone</th><th class="num">bpm</th><th class="num">Threshold</th><th class="num">Garmin</th></tr></thead><tbody>' +
        D.athlete.lt_zone_names.map(function (nm, z) {
          return '<tr><td><i class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + ZONES[z] + ';margin-right:7px"></i>Z' + (z + 1) + '</td><td class="num muted">' + ltB[z] +
            '</td><td class="num">' + Math.round(lt[z] / lts * 100) + '%</td><td class="num muted">' + Math.round(gz[z] / gs * 100) + '%</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (gb.length ? '<p class="panel-sub" style="margin:12px 0 0">Garmin\'s zones start at ' + gb.join(' / ') + ' bpm — set from max HR, so they label easy running as zone 3.</p>' : '')
    };
  });

  panel('training', 'tr-form', 'Running form', 12, function () {
    var runs = rangeActs().filter(function (a) { return a.dynamics; });
    function m(k) { return avg(runs.map(function (a) { return a.dynamics[k]; })); }
    var kv = [
      ['Cadence', Math.round(m('cadence_spm')), 'spm'], ['Ground contact', Math.round(m('stance_ms')), 'ms'], ['Vertical osc.', (m('vert_osc_mm') / 10).toFixed(1), 'cm'],
      ['Vertical ratio', m('vert_ratio').toFixed(1), '%'], ['Step length', m('step_m').toFixed(2), 'm'], ['Avg power', Math.round(m('power')), 'W']
    ];
    var metric = store.get('formMetric', 'cadence_spm');
    var names = { cadence_spm: 'Cadence (spm)', stance_ms: 'Ground contact (ms)', power: 'Power (W)', step_m: 'Step length (m)' };
    return {
      tools: seg('formMetric', [['cadence_spm', 'Cadence'], ['stance_ms', 'Contact'], ['step_m', 'Step'], ['power', 'Power']], metric),
      sub: 'Averages across runs in the selected range, from the watch\'s running dynamics. Chart shows each run.',
      html: '<div class="kv">' + kv.map(function (k) { return '<div><div class="k">' + k[0] + '</div><div class="v">' + k[1] + '<small> ' + k[2] + '</small></div></div>'; }).join('') + '</div><div id="cForm"></div>',
      mount: function () {
        bindSeg(panelEl('tr-form'), 'formMetric', function (v) { store.set('formMetric', v); renderView(); });
        chart($('#cForm'), {
          labels: runs.map(function (a) { return a.date; }), xFmt: shortDate, height: 180,
          yFmt: metric === 'step_m' ? function (v) { return v.toFixed(2); } : undefined,
          series: [{ name: names[metric], type: 'line', dots: true, color: C.s1, values: runs.map(function (a) { return a.dynamics[metric]; }) }],
          tip: function (i) {
            var a = runs[i];
            return '<div class="tt-h">' + shortDate(a.date) + ' · ' + fmtDist(a.dist_km) + '</div>' + tipRow(C.s1, names[metric], a.dynamics[metric]) + tipRow(null, 'Pace', fmtPace(a.pace_s_km));
          }
        });
      }
    };
  });

  // ---------- RECOVERY ----------

  panel('recovery', 'rc-hrv', 'Heart-rate variability', 12, function () {
    return {
      sub: 'Overnight HRV with your Garmin baseline (shaded) and the 7-day average. Higher and inside the band is better.',
      html: '<div id="cHrv"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cHrv'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, height: 240,
          band: { lo: rows.map(function (r) { return r.hrv_base_low; }), hi: rows.map(function (r) { return r.hrv_base_high; }), label: 'Baseline range' },
          series: [
            { name: 'Nightly HRV (ms)', type: 'line', dots: true, color: C.s2, values: rows.map(function (r) { return r.hrv; }) },
            { name: '7-day average', type: 'line', dash: true, color: C.s1, values: rows.map(function (r) { return r.hrv_weekly; }) }
          ],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">' + shortDate(r.date) + '</div>' + tipRow(C.s2, 'Nightly', (r.hrv || '—') + ' ms') + tipRow(C.s1, '7-day avg', (r.hrv_weekly || '—') + ' ms') +
              tipRow(null, 'Baseline', r.hrv_base_low ? r.hrv_base_low + '–' + r.hrv_base_high : '—') + tipRow(null, 'Status', titleCase(r.hrv_status)) + tipRow(null, 'Slept', fmtHM(r.sleep_min));
          }
        });
      }
    };
  });

  panel('recovery', 'rc-rhr', 'Resting heart rate', 6, function () {
    var base = avg(D.daily.map(function (r) { return r.rhr; }));
    return {
      sub: 'Morning resting HR. Spikes of 4+ bpm over your average (' + Math.round(base) + ') usually follow short sleep, stress or illness.',
      html: '<div id="cRhr"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cRhr'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate,
          refs: [{ y: base, label: 'avg ' + Math.round(base) }],
          series: [{ name: 'Resting HR (bpm)', type: 'line', dots: true, color: C.s3, values: rows.map(function (r) { return r.rhr; }) }]
        });
      }
    };
  });

  panel('recovery', 'rc-ready', 'Training readiness', 6, function () {
    return {
      sub: 'Garmin\'s 0–100 morning readiness, combining sleep, HRV, recovery time and load.',
      html: '<div id="cReady"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cReady'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, yMin: 0, yMax: 100,
          refs: [{ y: 50, label: 'moderate' }],
          series: [{ name: 'Readiness', type: 'bar', color: C.s1, values: rows.map(function (r) { return r.readiness; }) }],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">' + shortDate(r.date) + '</div>' + tipRow(C.s1, 'Readiness', r.readiness == null ? '—' : r.readiness) +
              tipRow(null, 'Level', titleCase(r.readiness_level)) + tipRow(null, 'Slept', fmtHM(r.sleep_min)) + tipRow(null, 'HRV', (r.hrv || '—') + ' ms');
          }
        });
      }
    };
  });

  panel('recovery', 'rc-bb', 'Body Battery', 6, function () {
    return {
      sub: 'Daily range from lowest to highest. A low peak means you started the day under-charged.',
      html: '<div id="cBb"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cBb'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, yMin: 0, yMax: 100,
          series: [{ name: 'Body Battery range', type: 'range', color: C.s2, lo: rows.map(function (r) { return r.bb_low; }), hi: rows.map(function (r) { return r.bb_high; }) }],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">' + shortDate(r.date) + '</div>' + tipRow(C.s2, 'High', r.bb_high) + tipRow(C.s2, 'Low', r.bb_low) +
              tipRow(null, 'Charged', '+' + (r.bb_charged || 0)) + tipRow(null, 'Drained', '−' + (r.bb_drained || 0));
          }
        });
      }
    };
  });

  panel('recovery', 'rc-stress', 'Stress', 6, function () {
    return {
      sub: 'Average all-day stress score (0–100) from heart-rate variability while you\'re not exercising.',
      html: '<div id="cStress"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cStress'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, yMin: 0,
          refs: [{ y: 25, label: 'low' }, { y: 50, label: 'medium' }],
          series: [{ name: 'Avg stress', type: 'line', dots: true, color: C.s3, values: rows.map(function (r) { return r.stress; }) }]
        });
      }
    };
  });

  panel('recovery', 'rc-scatter', 'Sleep → next-day readiness', 6, function () {
    var pts = D.daily.filter(function (r) { return r.sleep_min && r.readiness != null; }).map(function (r) {
      return { x: r.sleep_min / 60, y: r.readiness, r: r };
    });
    var r = pearson(pts.map(function (p) { return p.x; }), pts.map(function (p) { return p.y; }));
    return {
      sub: 'Each dot is a morning. Correlation r = ' + (r == null ? '—' : r.toFixed(2)) + ' — the dashed line is the trend.',
      html: '<div id="cScatter"></div>',
      mount: function () {
        scatter($('#cScatter'), {
          points: pts, color: C.s1, xLabel: 'Hours slept', yMin: 0, yMax: 100,
          xFmt: function (v) { return v.toFixed(0) + 'h'; },
          tip: function (p) { return '<div class="tt-h">' + shortDate(p.r.date) + '</div>' + tipRow(null, 'Slept', fmtHM(p.r.sleep_min)) + tipRow(C.s1, 'Readiness', p.y); }
        });
      }
    };
  });

  panel('recovery', 'rc-correl', 'What moves your recovery', 6, function () {
    var rows = D.daily;
    function lagged(key, toKey) {
      var xs = [], ys = [];
      rows.forEach(function (r, i) { if (i) { xs.push(rows[i - 1][key]); ys.push(r[toKey]); } });
      return pearson(xs, ys);
    }
    var dayLoad = {};
    D.activities.forEach(function (a) { dayLoad[a.date] = (dayLoad[a.date] || 0) + (a.load || 0); });
    var loads = rows.map(function (r) { return dayLoad[r.date] || 0; });
    function lagLoad(toKey) {
      var xs = [], ys = [];
      rows.forEach(function (r, i) { if (i) { xs.push(loads[i - 1]); ys.push(r[toKey]); } });
      return pearson(xs, ys);
    }
    var items = [
      ['Hours slept', 'Readiness', pearson(rows.map(function (r) { return r.sleep_min; }), rows.map(function (r) { return r.readiness; }))],
      ['Hours slept', 'HRV', pearson(rows.map(function (r) { return r.sleep_min; }), rows.map(function (r) { return r.hrv; }))],
      ['Hours slept', 'Resting HR', pearson(rows.map(function (r) { return r.sleep_min; }), rows.map(function (r) { return r.rhr; }))],
      ['Sleep score', 'Body Battery peak', pearson(rows.map(function (r) { return r.sleep_score; }), rows.map(function (r) { return r.bb_high; }))],
      ['Previous day\'s load', 'HRV', lagLoad('hrv')],
      ['Previous day\'s load', 'Readiness', lagLoad('readiness')],
      ['Previous day\'s stress', 'HRV', lagged('stress', 'hrv')]
    ];
    function word(r) {
      if (r == null) return 'not enough data';
      var a = Math.abs(r);
      return (a >= 0.5 ? 'strong' : a >= 0.3 ? 'moderate' : a >= 0.15 ? 'weak' : 'no clear') + (a >= 0.15 ? (r > 0 ? ' positive' : ' negative') : '') + ' link';
    }
    return {
      sub: 'Correlation across all ' + rows.length + ' days (−1 to +1). Small sample, so read these as hints, not proof.',
      html: '<div class="hbars">' + items.map(function (it) {
        var r = it[2] || 0;
        return '<div class="hbar-row"><div class="lbl">' + it[0] + '<small>→ ' + it[1] + '</small></div>' +
          '<div class="hbar-track"><div style="position:absolute;left:50%;top:-3px;bottom:-3px;border-left:1px solid rgba(242,240,234,.3)"></div>' +
          '<div class="hbar-fill" data-w="' + Math.abs(r) * 50 + '%" style="width:0;' + (r >= 0 ? 'left:50%' : 'left:auto;right:50%') + ';background:' + (r >= 0 ? C.s2 : C.s3) + '"></div></div>' +
          '<div class="val">' + (it[2] == null ? '—' : (r > 0 ? '+' : '') + r.toFixed(2)) + '<br><small>' + word(it[2]) + '</small></div></div>';
      }).join('') + '</div>'
    };
  });

  // ---------- SLEEP ----------

  function minsSinceEvening(hhmm) {
    if (!hhmm) return null;
    var p = hhmm.split(':'), m = +p[0] * 60 + +p[1];
    return m < 12 * 60 ? m + 24 * 60 - 18 * 60 : m - 18 * 60; // minutes after 18:00
  }
  function clockFromEvening(v) {
    var m = Math.round(v + 18 * 60) % (24 * 60);
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  panel('sleep', 'sl-tiles', 'Sleep summary', 12, function () {
    var rows = rangeRows().filter(function (r) { return r.sleep_min; });
    var beds = rows.map(function (r) { return minsSinceEvening(r.bedtime); }).filter(function (x) { return x != null; });
    var bedAvg = avg(beds), sd = beds.length > 1 ? Math.sqrt(avg(beds.map(function (b) { return Math.pow(b - bedAvg, 2); }))) : null;
    var tot = sum(rows.map(function (r) { return r.sleep_min; })) || 1;
    var deepP = sum(rows.map(function (r) { return r.deep_min; })) / tot * 100, remP = sum(rows.map(function (r) { return r.rem_min; })) / tot * 100;
    var debt = sum(rows.slice(-7).map(function (r) { return Math.max(0, 480 - r.sleep_min); }));
    var tiles = [
      ['Average sleep', fmtHM(avg(rows.map(function (r) { return r.sleep_min; }))), levelOf(avg(rows.map(function (r) { return r.sleep_min; })), 450, 390), 'target 8h'],
      ['Nights 7h+', rows.filter(function (r) { return r.sleep_min >= 420; }).length + ' / ' + rows.length, null, 'in range'],
      ['Average score', Math.round(avg(rows.map(function (r) { return r.sleep_score; }))), levelOf(avg(rows.map(function (r) { return r.sleep_score; })), 80, 60), 'Garmin sleep score'],
      ['7-day sleep debt', fmtHM(debt), levelOf(debt, 120, 360, false), 'vs 8h a night'],
      ['Average bedtime', bedAvg == null ? '—' : clockFromEvening(bedAvg), null, 'lights out'],
      ['Bedtime spread', sd == null ? '—' : '±' + Math.round(sd) + ' min', sd == null ? 'info' : levelOf(sd, 30, 60, false), 'night-to-night'],
      ['Deep sleep', Math.round(deepP) + '%', null, 'of time asleep'],
      ['REM sleep', Math.round(remP) + '%', null, 'of time asleep']
    ];
    return {
      sub: 'Over the selected range.',
      html: '<div class="tiles">' + tiles.map(function (t) {
        return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] + '</div><div class="d">' +
          (t[2] ? statusTag(t[2], t[3]) : esc(t[3])) + '</div></div>';
      }).join('') + '</div>'
    };
  }, { bare: true });

  panel('sleep', 'sl-duration', 'Sleep duration', 12, function () {
    return {
      sub: 'Hours asleep each night (dated by the morning you woke up). Dashed lines at 7 and 8 hours.',
      html: '<div id="cSleep"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cSleep'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, height: 230, yMin: 0,
          yFmt: function (v) { return v + 'h'; },
          refs: [{ y: 8, label: '8h' }, { y: 7, label: '7h' }],
          series: [{ name: 'Asleep', type: 'bar', color: C.s4, values: rows.map(function (r) { return r.sleep_min == null ? null : r.sleep_min / 60; }) }],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">' + shortDate(r.date) + '</div>' + tipRow(C.s4, 'Asleep', fmtHM(r.sleep_min)) + tipRow(null, 'Score', r.sleep_score || '—') +
              tipRow(null, 'Bed → wake', (r.bedtime || '—') + ' → ' + (r.waketime || '—')) + tipRow(null, 'Readiness', r.readiness == null ? '—' : r.readiness);
          }
        });
      }
    };
  });

  panel('sleep', 'sl-stages', 'Sleep stages', 8, function () {
    return {
      sub: 'Hours in each stage. Deep sleep drives physical recovery; REM supports learning and mood.',
      html: '<div id="cStages"></div>',
      mount: function () {
        var rows = rangeRows();
        var stages = [['Light', 'light_min', C.s1], ['Deep', 'deep_min', C.s2], ['REM', 'rem_min', C.s3], ['Awake', 'awake_min', C.s4]];
        chart($('#cStages'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, yMin: 0,
          yFmt: function (v) { return v + 'h'; },
          series: stages.map(function (s) {
            return { name: s[0], type: 'bar', stack: 'st', color: s[2], values: rows.map(function (r) { return r[s[1]] == null ? null : r[s[1]] / 60; }), fmt: function (v) { return fmtHM(v * 60); } };
          })
        });
      }
    };
  });

  panel('sleep', 'sl-score', 'Sleep score', 4, function () {
    return {
      sub: 'Garmin\'s 0–100 nightly score.',
      html: '<div id="cScore"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cScore'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, xTicks: 3, yMin: 0, yMax: 100,
          refs: [{ y: 80, label: 'good' }],
          series: [{ name: 'Score', type: 'line', dots: true, color: C.s4, values: rows.map(function (r) { return r.sleep_score; }) }]
        });
      }
    };
  });

  panel('sleep', 'sl-timing', 'Bedtime & wake time', 12, function () {
    return {
      sub: 'When you fell asleep and woke up. Consistent timing helps sleep quality as much as duration does.',
      html: '<div id="cTiming"></div>',
      mount: function () {
        var rows = rangeRows();
        chart($('#cTiming'), {
          labels: rows.map(function (r) { return r.date; }), xFmt: shortDate, height: 240, invert: true,
          yFmt: clockFromEvening, yWidth: 46, yStep: 120,
          series: [{ name: 'Asleep', type: 'range', color: C.s4, lo: rows.map(function (r) { return minsSinceEvening(r.bedtime); }), hi: rows.map(function (r) { return minsSinceEvening(r.waketime); }) }],
          tip: function (i) {
            var r = rows[i];
            return '<div class="tt-h">Night before ' + shortDate(r.date) + '</div>' + tipRow(C.s4, 'Fell asleep', r.bedtime || '—') + tipRow(C.s4, 'Woke', r.waketime || '—') + tipRow(null, 'Asleep', fmtHM(r.sleep_min));
          }
        });
      }
    };
  });

  // ---------- RUNS ----------

  panel('runs', 'runs-table', 'Activities', 12, function () {
    var filter = store.get('actFilter', 'runs');
    var sort = store.get('actSort', { k: 'start', d: -1 });
    var list = rangeActs(filter === 'all').slice();
    list.sort(function (a, b) {
      var x = a[sort.k], y = b[sort.k];
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * sort.d;
    });
    var sel = state.selectedRun;
    var cols = [['start', 'Date'], ['name', 'Activity'], ['dist_km', 'Distance', 1], ['moving_s', 'Time', 1], ['pace_s_km', 'Pace', 1], ['avg_hr', 'Avg HR', 1], ['load', 'Load', 1], ['aerobic_te', 'Aerobic TE', 1], ['decoupling_pct', 'Drift', 1]];
    var totals = { d: sum(list.filter(function (a) { return a.is_run; }).map(function (a) { return a.dist_km; })), t: sum(list.map(function (a) { return a.moving_s || a.dur_s; })) };
    return {
      tools: seg('actFilter', [['runs', 'Runs'], ['all', 'All']], filter),
      sub: list.length + ' activities · ' + fmtDist(totals.d) + ' running · ' + fmtHM(totals.t / 60) + ' total. Click a row for the full breakdown; click a header to sort.',
      html: '<div class="table-wrap"><table><thead><tr>' + cols.map(function (c) {
        return '<th class="sortable' + (c[2] ? ' num' : '') + (sort.k === c[0] ? ' sorted' : '') + '" data-k="' + c[0] + '">' + c[1] + (sort.k === c[0] ? (sort.d > 0 ? ' ↑' : ' ↓') : '') + '</th>';
      }).join('') + '</tr></thead><tbody>' + list.map(function (a) {
        return '<tr class="clickable' + (sel === a.id ? ' selected' : '') + '" data-id="' + a.id + '"><td>' + DOW[parseDate(a.date).getDay()] + ' ' + shortDate(a.date) +
          '</td><td style="white-space:normal;min-width:150px">' + esc(a.name) + (a.is_run ? '' : ' <span class="muted">· ' + esc(titleCase(a.type)) + '</span>') +
          '</td><td class="num">' + (a.dist_km ? fmtDist(a.dist_km, 2) : '—') + '</td><td class="num">' + fmtClock(a.moving_s || a.dur_s) +
          '</td><td class="num">' + fmtPace(a.pace_s_km, false) + '</td><td class="num">' + (a.avg_hr || '—') + '</td><td class="num">' + (a.load || '—') +
          '</td><td class="num">' + (a.aerobic_te == null ? '—' : a.aerobic_te.toFixed(1)) + '</td><td class="num">' + (a.decoupling_pct == null ? '<span class="muted">—</span>' : (a.decoupling_pct > 0 ? '+' : '') + a.decoupling_pct.toFixed(1) + '%') + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      mount: function () {
        var p = panelEl('runs-table');
        bindSeg(p, 'actFilter', function (v) { store.set('actFilter', v); renderView(); });
        $all('th.sortable', p).forEach(function (th) {
          th.addEventListener('click', function () {
            var k = th.getAttribute('data-k');
            store.set('actSort', { k: k, d: sort.k === k ? -sort.d : -1 });
            renderView();
          });
        });
        $all('tr.clickable', p).forEach(function (tr) {
          tr.addEventListener('click', function () {
            state.selectedRun = +tr.getAttribute('data-id');
            renderView();
            var d = panelEl('runs-detail');
            if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      }
    };
  });

  panel('runs', 'runs-detail', 'Run detail', 12, function () {
    var runs = D.activities.filter(function (a) { return a.is_run && a.series; });
    var a = D.activities.find(function (x) { return x.id === state.selectedRun; }) || last(runs);
    if (!a) return null;
    state.selectedRun = a.id;
    var metric = store.get('runMetric', 'pace');
    var zoneSys = store.get('runZones', 'lt');
    var dyn = a.dynamics || {};
    var kv = [
      ['Distance', fmtDist(a.dist_km, 2)], ['Moving time', fmtClock(a.moving_s)], ['Pace', fmtPace(a.pace_s_km)], ['Avg / max HR', (a.avg_hr || '—') + ' / ' + (a.max_hr || '—')],
      ['Training load', a.load || '—'], ['Training effect', (a.aerobic_te == null ? '—' : a.aerobic_te.toFixed(1)) + ' / ' + (a.anaerobic_te == null ? '—' : a.anaerobic_te.toFixed(1))],
      ['Aerobic drift', a.decoupling_pct == null ? '—' : (a.decoupling_pct > 0 ? '+' : '') + a.decoupling_pct.toFixed(1) + '%'], ['Elevation', '+' + (dyn.ascent || 0) + ' / −' + (dyn.descent || 0) + ' m'],
      ['Cadence', dyn.cadence_spm ? dyn.cadence_spm + ' spm' : '—'], ['Power / NP', dyn.power ? dyn.power + ' / ' + dyn.np + ' W' : '—'], ['Ground contact', dyn.stance_ms ? Math.round(dyn.stance_ms) + ' ms' : '—'], ['Calories', a.kcal || '—']
    ];
    var splits = (units() === 'mi' ? a.splits_mi : a.splits_km) || [];
    var zones = zoneSys === 'lt' ? a.lt_zones_s : a.garmin_zones_s;
    var ztot = sum(zones || []) || 1;
    return {
      tools: seg('runMetric', [['pace', 'Pace'], ['hr', 'HR'], ['pwr', 'Power'], ['alt', 'Elevation']], metric),
      sub: esc(a.name) + ' · ' + longDate(a.date) + ' · ' + esc((a.start || '').slice(11, 16)) + (a.te_label ? ' · ' + esc(titleCase(a.te_label)) : ''),
      html: '<div class="kv">' + kv.map(function (k) { return '<div><div class="k">' + k[0] + '</div><div class="v" style="font-size:1.15rem">' + k[1] + '</div></div>'; }).join('') + '</div>' +
        (a.series ? '<div id="cRun"></div>' : '<p class="muted">No second-by-second file for this activity.</p>') +
        '<div class="grid" style="margin-top:20px">' +
        '<div class="span-7"><div class="eyebrow">Splits per ' + (units() === 'mi' ? 'mile' : 'km') + '</div><div class="table-wrap"><table><thead><tr><th>#</th><th class="num">Pace</th><th class="num">HR</th><th class="num">Power</th><th class="num">Cadence</th><th class="num">Elev</th></tr></thead><tbody>' +
        splits.map(function (s, i) {
          return '<tr><td>' + (i + 1) + '</td><td class="num">' + fmtPace(s.pace, false) + '</td><td class="num">' + (s.hr || '—') + '</td><td class="num">' + (s.pwr || '—') + '</td><td class="num">' + (s.cad || '—') +
            '</td><td class="num muted">' + (s.elev == null ? '—' : (s.elev > 0 ? '+' : '') + s.elev + ' m') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' +
        '<div class="span-5"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><div class="eyebrow" style="margin:0">Time in zone</div>' +
        seg('runZones', [['lt', 'Threshold'], ['garmin', 'Garmin']], zoneSys) + '</div>' +
        (zones ? '<div class="hbars">' + zones.map(function (z, i) {
          return '<div class="hbar-row" style="grid-template-columns:70px minmax(0,1fr) 70px"><div class="lbl">Z' + (i + 1) + '</div><div class="hbar-track"><div class="hbar-fill" data-w="' + (z / ztot * 100) + '%" style="width:0;background:' + ZONES[i] + '"></div></div><div class="val">' + fmtClock(z) + '</div></div>';
        }).join('') + '</div>' : '<p class="muted">No zone data.</p>') + '</div></div>',
      mount: function () {
        var p = panelEl('runs-detail');
        bindSeg(p, 'runMetric', function (v) { store.set('runMetric', v); renderView(); });
        bindSeg(p, 'runZones', function (v) { store.set('runZones', v); renderView(); });
        if (!a.series) return;
        var S = a.series;
        var names = { pace: 'Pace (/' + units() + ')', hr: 'Heart rate (bpm)', pwr: 'Power (W)', alt: 'Elevation (m)' };
        var colors = { pace: C.s1, hr: C.s3, pwr: C.s2, alt: C.s4 };
        var vals = S[metric].map(function (v) {
          if (v == null) return null;
          if (metric === 'pace') { var pv = paceVal(v); return pv > paceVal(a.pace_s_km) * 1.8 ? null : pv; }
          return v;
        });
        chart($('#cRun'), {
          labels: S.d, height: 240, invert: metric === 'pace',
          xFmt: function (d) { return distVal(d).toFixed(1); },
          yFmt: metric === 'pace' ? function (v) { return fmtClock(v); } : undefined,
          yWidth: metric === 'pace' ? 46 : 40,
          series: [{ name: names[metric], type: 'line', color: colors[metric], values: vals }],
          tip: function (i) {
            return '<div class="tt-h">' + distVal(S.d[i]).toFixed(2) + ' ' + units() + ' · ' + fmtClock(S.t[i]) + '</div>' +
              tipRow(C.s1, 'Pace', S.pace[i] ? fmtPace(S.pace[i]) : '—') + tipRow(C.s3, 'HR', S.hr[i] || '—') + tipRow(C.s2, 'Power', S.pwr[i] ? S.pwr[i] + ' W' : '—') + tipRow(C.s4, 'Elevation', S.alt[i] == null ? '—' : S.alt[i] + ' m');
          }
        });
      }
    };
  });

  // ---------- shell: tabs, controls, customize ----------

  function setTab(t) {
    state.tab = t;
    store.set('tab', t);
    $all('.tab').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === t); });
    renderView();
    var tb = $('.toolbar');
    if (tb.getBoundingClientRect().top < 0) tb.scrollIntoView({ block: 'start' });
  }

  function syncControls() {
    $all('#rangeSeg button').forEach(function (b) { b.setAttribute('aria-pressed', +b.getAttribute('data-range') === state.range); });
    $all('#unitSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-units') === state.units); });
  }

  function renderAll() {
    renderGoal();
    syncControls();
    $all('.tab').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === state.tab); });
    renderView();
    var first = D.daily[0].date, lastD = last(D.daily).date;
    $('#footnote').textContent = 'Garmin data ' + shortDate(first) + ' – ' + shortDate(lastD) + ' · ' + D.daily.length + ' days · ' + D.activities.length +
      ' activities · last synced ' + D.generated.replace('T', ' ') + '. Not medical advice.';
    $('#lede').textContent = 'Training, recovery and sleep from my Garmin, read against ' + goal().name + '.';
    buildToggleList();
  }

  function buildToggleList() {
    var names = { overview: 'Overview', race: 'Race', training: 'Training', recovery: 'Recovery', sleep: 'Sleep', runs: 'Runs' };
    $('#toggleList').innerHTML = Object.keys(TABS).map(function (t) {
      return '<div class="group">' + names[t] + '</div>' + TABS[t].map(function (p) {
        return '<label class="switch"><span>' + esc(p.title) + '</span><input type="checkbox" data-id="' + p.id + '"' + (state.hidden.indexOf(p.id) === -1 ? ' checked' : '') + '></label>';
      }).join('');
    }).join('');
    $all('#toggleList input').forEach(function (c) {
      c.addEventListener('change', function () {
        var id = c.getAttribute('data-id'), i = state.hidden.indexOf(id);
        if (c.checked && i !== -1) state.hidden.splice(i, 1);
        if (!c.checked && i === -1) state.hidden.push(id);
        store.set('hidden', state.hidden);
        renderView();
      });
    });
  }

  var scrim = $('#scrim');
  function openDrawer(d) {
    $all('.drawer.open').forEach(function (x) { if (x !== d) closeDrawer(x); });
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    scrim.classList.add('open');
  }
  function closeDrawer(d) {
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    if (!$('.drawer.open')) scrim.classList.remove('open');
  }
  scrim.addEventListener('click', function () { $all('.drawer.open').forEach(closeDrawer); });
  $all('[data-close]').forEach(function (b) { b.addEventListener('click', function () { closeDrawer(b.closest('.drawer')); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $all('.drawer.open').forEach(closeDrawer); });

  $all('.tab').forEach(function (b) { b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); }); });
  $all('#rangeSeg button').forEach(function (b) {
    b.addEventListener('click', function () { state.range = +b.getAttribute('data-range'); store.set('range', state.range); syncControls(); renderView(); });
  });
  $all('#unitSeg button').forEach(function (b) {
    b.addEventListener('click', function () { state.units = b.getAttribute('data-units'); store.set('units', state.units); renderAll(); });
  });
  $('#customizeBtn').addEventListener('click', function () { openDrawer($('#customizeDrawer')); });
  $('#resetPanels').addEventListener('click', function () {
    state.hidden = []; state.collapsed = [];
    store.set('hidden', []); store.set('collapsed', []);
    buildToggleList(); renderView();
  });

  // ---------- unlock ----------

  function b64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  async function decrypt(blob, pass) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(blob.salt), iterations: blob.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  var blobPromise = null;
  function loadBlob() {
    if (!blobPromise) {
      blobPromise = fetch('data/training.enc.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('missing');
        return r.json();
      });
      blobPromise.catch(function () { blobPromise = null; });
    }
    return blobPromise;
  }

  async function unlock(pass, remember) {
    var err = $('#lockError'), btn = $('#unlockBtn');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      var blob = await loadBlob();
      D = await decrypt(blob, pass);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Unlock';
      err.textContent = e && e.message === 'missing' ? 'The data file is missing — run garmin/update.sh.' : 'That passcode didn\'t work.';
      store.del('pass');
      return false;
    }
    if (remember) store.set('pass', pass);
    state = {
      units: store.get('units', D.athlete.units || 'mi'),
      range: store.get('range', 30),
      tab: store.get('tab', 'overview'),
      hidden: store.get('hidden', []),
      collapsed: store.get('collapsed', []),
      selectedRun: null
    };
    if (!TABS[state.tab]) state.tab = 'overview';
    $('#lock').hidden = true;
    $('#app').hidden = false;
    $('#customizeBtn').hidden = false;
    $('#lockBtn').hidden = false;
    $('#coachFab').hidden = false;
    renderAll();
    return true;
  }

  $('#lockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var p = $('#passInput').value;
    if (p) unlock(p, $('#rememberInput').checked);
  });
  $('#lockBtn').addEventListener('click', function () {
    store.del('pass');
    D = null;
    location.reload();
  });

  var saved = store.get('pass', null);
  if (saved) {
    $('#rememberInput').checked = true;
    unlock(saved, true);
  }

  // ---------- coach ----------

  var chatEl = $('#chat'), input = $('#chatInput');
  var chatLog = store.get('chat', []);
  var busy = false;

  function md(text) {
    var lines = esc(text).split('\n'), html = '', list = null, para = [];
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
    }
    function flushPara() { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } }
    function flushList() { if (list) { html += '</' + list + '>'; list = null; } }
    lines.forEach(function (ln) {
      var t = ln.trim(), mm;
      if (!t) { flushPara(); flushList(); return; }
      if ((mm = t.match(/^#{1,4}\s+(.*)/))) { flushPara(); flushList(); html += '<h4>' + inline(mm[1]) + '</h4>'; return; }
      if ((mm = t.match(/^[-*•]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(mm[1]) + '</li>'; return; }
      if ((mm = t.match(/^\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(mm[1]) + '</li>'; return; }
      if (/^\|.*\|$/.test(t)) { flushList(); para.push(t.replace(/\|/g, ' · ').replace(/^ · | · $/g, '')); return; }
      flushList(); para.push(t);
    });
    flushPara(); flushList();
    return html;
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    return content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  }

  var STARTERS = [
    'Am I ready for Chicago? Be honest.',
    'What pace should I start at, and when should I push?',
    'How should I spend the next 7 days?',
    'Why is my HRV down, and what do I do about it?',
    'Build my race-day fuelling plan.',
    'Which of my long runs went best and why?'
  ];

  function renderChat() {
    if (!chatLog.length) {
      chatEl.innerHTML = '<div class="chat-empty"><p>Ask anything about your training, recovery, sleep or ' + esc(D ? goal().name : 'race') +
        '. The coach reads every number on this page.</p>' + (getKey() ? '' : '<p class="amber">Add your Anthropic API key in settings (⚙) to start.</p>') +
        '<div class="chips">' + STARTERS.map(function (s) { return '<button class="chip" type="button">' + esc(s) + '</button>'; }).join('') + '</div></div>';
      $all('.chip', chatEl).forEach(function (c) { c.addEventListener('click', function () { send(c.textContent); }); });
      return;
    }
    chatEl.innerHTML = chatLog.map(function (m) {
      return m.role === 'user' ? '<div class="msg user">' + esc(m.content) + '</div>' : '<div class="msg assistant">' + md(textOf(m.content)) + '</div>';
    }).join('');
    scrollChat();
  }
  function scrollChat() { var b = chatEl.parentElement; b.scrollTop = b.scrollHeight; }

  function getKey() { return store.get('apiKey', ''); }

  function buildContext() {
    var acts = D.activities.map(function (a) {
      var c = Object.assign({}, a);
      delete c.series;
      delete c.splits_mi;
      return c;
    });
    return JSON.stringify({ athlete: D.athlete, predictions: D.predictions, personal_records: D.prs, insights: D.insights, weekly: D.weekly, daily: D.daily, activities: acts });
  }

  function systemBlocks() {
    var g = goal();
    var stable =
      'You are the running coach and health analyst built into Enoch\'s personal training dashboard. You have his Garmin data below as JSON. ' +
      'Answer his questions about training, recovery, sleep, health and his race goal.\n\n' +
      'How to answer:\n' +
      '- Ground claims in his numbers and cite dates and values. If the data cannot answer something, say so plainly.\n' +
      '- Be specific: paces, heart rates, durations, bedtimes, grams.\n' +
      '- Answers appear in a narrow side panel: keep them to a few short paragraphs or a short list. No tables.\n' +
      '- For intensity, use the threshold-based zones (athlete.lthr, lt_zone_bounds, activities[].lt_zones_s). Garmin\'s default zones (garmin_zones_s) are max-HR based and overstate intensity for him.\n' +
      '- You are not a doctor. For chest pain, fainting, unusual breathlessness, signs of illness, or pain that changes how he runs, tell him to stop and see a professional.\n\n' +
      'Field notes: sleep fields are minutes; hrv is ms; acute/chronic/load are Garmin training load; pace_s_km is seconds per km; dist_km is km; ' +
      'lt_zones_s are seconds in threshold zones 1–5; decoupling_pct is aerobic decoupling (Pa:HR) between the two halves of a run; predictions are seconds; ' +
      'splits_km entries are per-km pace (s), HR, power, cadence (spm), elevation change (m). Daily rows are dated by the morning he woke up.\n\n' +
      'DATA:\n' + buildContext();
    var t = targetSeconds();
    var dynamic = 'Today is ' + isoDate(todayDate()) + '. Current goal: ' + g.name + ' on ' + g.date + ' (' + daysToRace() + ' days away), ' + g.distance_km +
      ' km, target ' + fmtClock(t) + (g.target_s ? '' : ' (Garmin prediction, no target set)') + '. He prefers ' + (units() === 'mi' ? 'miles and min/mile' : 'kilometres and min/km') + '.';
    return [{ type: 'text', text: stable }, { type: 'text', text: dynamic }];
  }

  var sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL);
      sdkPromise.catch(function () { sdkPromise = null; });
    }
    return sdkPromise;
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    var key = getKey();
    if (!key) {
      $('#coachSettings').hidden = false;
      $('#apiKeyInput').focus();
      return;
    }
    busy = true;
    $('#sendBtn').disabled = true;
    input.value = '';
    autosize();
    chatLog.push({ role: 'user', content: text });
    renderChat();
    var bubble = document.createElement('div');
    bubble.className = 'msg assistant';
    bubble.innerHTML = '<span class="typing"></span>';
    chatEl.appendChild(bubble);
    scrollChat();

    var mod;
    try {
      mod = await loadSdk();
      var Anthropic = mod.default;
      var client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      var stream = client.beta.messages.stream({
        model: store.get('model', 'claude-opus-5-5'),
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        system: systemBlocks(),
        messages: chatLog.map(function (m) { return { role: m.role, content: m.content }; })
      });
      var acc = '', queued = false;
      for await (var ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          acc += ev.delta.text;
          if (!queued) {
            queued = true;
            requestAnimationFrame(function () { queued = false; bubble.innerHTML = md(acc) + '<span class="typing"></span>'; scrollChat(); });
          }
        }
      }
      var final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        chatLog.pop();
        bubble.className = 'msg error';
        bubble.textContent = 'The model declined to answer that one. Try rephrasing.';
      } else {
        chatLog.push({ role: 'assistant', content: final.content });
        if (chatLog.length > 40) chatLog = chatLog.slice(-40);
        while (chatLog.length && chatLog[0].role !== 'user') chatLog.shift();
        store.set('chat', chatLog);
        bubble.innerHTML = md(textOf(final.content));
      }
    } catch (err) {
      chatLog.pop();
      bubble.className = 'msg error';
      var A = mod && mod.default;
      if (A && err instanceof A.AuthenticationError) bubble.textContent = 'Anthropic rejected the API key. Check it in settings (⚙).';
      else if (A && err instanceof A.RateLimitError) bubble.textContent = 'Rate limited by the API — wait a moment and try again.';
      else if (A && err instanceof A.APIConnectionError) bubble.textContent = 'Couldn\'t reach the Anthropic API. Check your connection.';
      else if (A && err instanceof A.APIError) bubble.textContent = 'API error ' + (err.status || '') + ': ' + (err.message || 'unknown');
      else bubble.textContent = 'Something went wrong: ' + (err && err.message || err);
      input.value = text;
      autosize();
    } finally {
      busy = false;
      $('#sendBtn').disabled = false;
      scrollChat();
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });

  $('#coachFab').addEventListener('click', function () {
    openDrawer($('#coachDrawer'));
    if (!getKey()) $('#coachSettings').hidden = false;
    renderChat();
    setTimeout(function () { (getKey() ? input : $('#apiKeyInput')).focus(); }, 300);
    loadSdk();
  });
  $('#coachSettingsBtn').addEventListener('click', function () { $('#coachSettings').hidden = !$('#coachSettings').hidden; });
  $('#modelSelect').value = store.get('model', 'claude-opus-5-5');
  $('#apiKeyInput').value = getKey() ? '••••••••••••' : '';
  $('#saveKeyBtn').addEventListener('click', function () {
    var v = $('#apiKeyInput').value.trim();
    if (v && v.indexOf('•') === -1) store.set('apiKey', v);
    store.set('model', $('#modelSelect').value);
    $('#apiKeyInput').value = getKey() ? '••••••••••••' : '';
    $('#coachSettings').hidden = true;
    renderChat();
    input.focus();
  });
  $('#forgetKeyBtn').addEventListener('click', function () { store.del('apiKey'); $('#apiKeyInput').value = ''; renderChat(); });
  $('#clearChatBtn').addEventListener('click', function () { chatLog = []; store.del('chat'); renderChat(); });
})();
