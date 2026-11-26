window.nmsCharts = (() => {
  const num2 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const fmtClock = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' });
  const fmtDate = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar', day: '2-digit', month: '2-digit' });
  const fmtFull = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function formatBps(bps) {
    if (!Number.isFinite(bps) || bps < 0) return '—';
    if (bps >= 1e9) return num2.format(bps / 1e9) + ' Gbps';
    if (bps >= 1e6) {
      const mbps = bps / 1e6;
      return (mbps >= 100 ? num0.format(mbps) : mbps >= 10 ? num1.format(mbps) : num2.format(mbps)) + ' Mbps';
    }
    if (bps >= 1e3) return num1.format(bps / 1e3) + ' kbps';
    return num0.format(bps) + ' bps';
  }

  function formatMbps(mbps) {
    if (!Number.isFinite(mbps) || mbps < 0) return '—';
    return formatBps(mbps * 1e6);
  }

  function formatVolume(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes >= 1e12) return num2.format(bytes / 1e12) + ' TB';
    if (bytes >= 1e9) return num2.format(bytes / 1e9) + ' GB';
    if (bytes >= 1e6) return num1.format(bytes / 1e6) + ' MB';
    return num0.format(bytes / 1e3) + ' KB';
  }

  function niceAxisMax(maxVal) {
    if (!Number.isFinite(maxVal) || maxVal <= 0) return 10;
    const exp = Math.floor(Math.log10(maxVal));
    const base = Math.pow(10, exp);
    const frac = maxVal / base;
    let nice = 10;
    if (frac <= 1) nice = 1;
    else if (frac <= 1.2) nice = 1.2;
    else if (frac <= 1.5) nice = 1.5;
    else if (frac <= 2) nice = 2;
    else if (frac <= 2.5) nice = 2.5;
    else if (frac <= 3) nice = 3;
    else if (frac <= 4) nice = 4;
    else if (frac <= 5) nice = 5;
    else if (frac <= 6) nice = 6;
    else if (frac <= 8) nice = 8;
    return nice * base;
  }

  function niceStep(range, targetSteps = 4) {
    if (!Number.isFinite(range) || range <= 0) return 1;
    const raw = range / targetSteps;
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const frac = raw / base;
    const mult = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
    return mult * base;
  }

  function estimateVolumeBytes(points, keys, maxGapMs = 15 * 60000, defaultIntervalMs = 60000) {
    if (!points.length) return 0;
    let totalBytes = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let sumBps = 0;
      let hasVal = false;
      for (const k of keys) {
        if (Number.isFinite(p[k]) && p[k] >= 0) {
          sumBps += p[k];
          hasVal = true;
        }
      }
      if (!hasVal) continue;
      let dt = defaultIntervalMs;
      if (i > 0 && points[i].at > points[i - 1].at) {
        const diff = points[i].at - points[i - 1].at;
        if (diff <= maxGapMs) dt = diff;
      }
      totalBytes += (sumBps * (dt / 1000)) / 8;
    }
    return totalBytes;
  }

  function drawMonotonePath(ctx, pts) {
    if (!pts.length) return;
    if (pts.length === 1) {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2);
      return;
    }
    if (pts.length === 2) {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    const n = pts.length;
    const slopes = new Array(n).fill(0);
    const d = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      d[i] = dx > 0 ? (pts[i + 1].y - pts[i].y) / dx : 0;
    }
    slopes[0] = d[0];
    slopes[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) {
        slopes[i] = 0;
      } else {
        const dx1 = pts[i].x - pts[i - 1].x;
        const dx2 = pts[i + 1].x - pts[i].x;
        const w1 = 2 * dx2 + dx1;
        const w2 = dx2 + 2 * dx1;
        slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < n - 1; i++) {
      const dx = (pts[i + 1].x - pts[i].x) / 3;
      const cp1x = pts[i].x + dx;
      const cp1y = pts[i].y + slopes[i] * dx;
      const cp2x = pts[i + 1].x - dx;
      const cp2y = pts[i + 1].y - slopes[i + 1] * dx;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pts[i + 1].x, pts[i + 1].y);
    }
  }

  function hexToRgba(hex, alpha) {
    const clean = String(hex || '').replace('#', '');
    if (clean.length !== 6) return 'rgba(37,99,235,' + alpha + ')';
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function renderAreaChart(options) {
    const {
      title,
      subtitle = '',
      data = [],
      series = [],
      windowMs = 86400000,
      height = 232,
      rawBps = false,
      unit = 'Mbps',
      kpiMode = 'traffic',
      gapBreakMs = 720000,
    } = options;

    const section = el('section', null, 'chart-card');
    const head = el('div', null, 'chart-card-head');
    const titleWrap = el('div');
    titleWrap.append(el('h3', title));
    if (subtitle) titleWrap.append(el('p', subtitle, 'chart-sub'));

    const visibleKeys = new Set(series.map(s => s.key));
    const legend = el('div', null, 'chart-legend');

    const normalized = data.map(row => {
      const copy = { at: row.at };
      for (const s of series) {
        const raw = row[s.key];
        copy[s.key] = Number.isFinite(raw) ? (rawBps ? raw / 1e6 : raw) : null;
        copy[s.key + '_bps'] = Number.isFinite(raw) ? (rawBps ? raw : raw * 1e6) : null;
      }
      return copy;
    });

    const points = normalized.filter(row => series.some(s => Number.isFinite(row[s.key])));
    head.append(titleWrap, legend);
    section.append(head);

    if (!points.length) {
      section.append(el('p', 'Belum ada sampel untuk rentang waktu ini.', 'chart-empty'));
      return section;
    }

    const fmtVal = v => {
      if (!Number.isFinite(v)) return '—';
      if (unit === 'dBm') return num2.format(v) + ' dBm';
      return formatMbps(v);
    };

    // Build 4 KPI Cards
    const kpiGrid = el('div', null, 'chart-kpis');
    const addKpi = (label, val, sub, accentColor) => {
      const card = el('div', null, 'chart-kpi');
      if (accentColor) card.style.borderTopColor = accentColor;
      card.append(el('span', label, 'chart-kpi-label'), el('strong', val, 'chart-kpi-val'));
      if (sub) card.append(el('small', sub, 'chart-kpi-sub'));
      kpiGrid.append(card);
    };

    if (kpiMode === 'optical') {
      const s = series[0];
      const valid = points.filter(p => Number.isFinite(p[s.key]));
      const vals = valid.map(p => p[s.key]);
      const last = valid.at(-1);
      const best = vals.length ? Math.max(...vals) : null;
      let worstPt = valid[0];
      for (const p of valid) {
        if (p[s.key] < worstPt[s.key]) worstPt = p;
      }
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      const health = !last ? '' : last[s.key] <= -27 ? 'Kritis (<= -27 dBm)' : last[s.key] <= -25 ? 'Waspada (-25..-27 dBm)' : 'Normal';
      addKpi('Redaman Terakhir', fmtVal(last?.[s.key]), health, last?.[s.key] <= -27 ? '#dc2626' : '#2563eb');
      addKpi('Terbaik (Maks)', fmtVal(best), 'Sinyal terkuat', '#059669');
      addKpi('Terburuk (Min)', fmtVal(worstPt?.[s.key]), worstPt ? fmtClock.format(worstPt.at) + ' WITA' : '', '#d97706');
      addKpi('Rata-rata', fmtVal(avg), valid.length + ' sampel', '#64748b');
    } else {
      const latest = points.at(-1);
      const lastText = series.map(s => (s.short || s.label.split(' ')[0]) + ' ' + fmtVal(latest?.[s.key])).join(' · ');
      const totalLastMbps = series.reduce((acc, s) => acc + (Number.isFinite(latest?.[s.key]) ? latest[s.key] : 0), 0);

      let globalPeak = { val: -Infinity, at: null, label: '', color: '#2563eb' };
      const avgParts = [];
      for (const s of series) {
        const vals = points.filter(p => Number.isFinite(p[s.key]));
        const avgVal = vals.length ? vals.reduce((a, p) => a + p[s.key], 0) / vals.length : null;
        avgParts.push((s.short || s.label.split(' ')[0]) + ' ' + fmtVal(avgVal));
        for (const p of vals) {
          if (p[s.key] > globalPeak.val) {
            globalPeak = { val: p[s.key], at: p.at, label: s.short || s.label, color: s.color };
          }
        }
      }

      const bpsKeys = series.map(s => s.key + '_bps');
      const estBytes = estimateVolumeBytes(
        points,
        bpsKeys,
        Math.max(gapBreakMs, 15 * 60000),
        points.length > 1 && (points.at(-1).at - points[0].at) / points.length < 15000 ? 3000 : 60000
      );

      addKpi('Trafik Sekarang', fmtVal(totalLastMbps), lastText, '#2563eb');
      addKpi(
        'Puncak Tertinggi',
        fmtVal(globalPeak.val > -Infinity ? globalPeak.val : null),
        globalPeak.at ? globalPeak.label + ' · ' + fmtDate.format(globalPeak.at) + ' ' + fmtClock.format(globalPeak.at) + ' WITA' : '—',
        globalPeak.color
      );
      addKpi('Rata-rata', avgParts[0] || '—', avgParts[1] || (points.length + ' titik sampel'), '#0d9488');
      addKpi('Est. Pemakaian', formatVolume(estBytes), windowMs > 86400000 ? 'Rentang 7 hari' : windowMs === 3600000 ? '1 jam terakhir' : '24 jam terakhir', '#6366f1');
    }

    const wrap = el('div', null, 'chart-canvas-wrap');
    const canvas = el('canvas', null, 'chart-canvas');
    canvas.style.height = height + 'px';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Grafik interaktif ' + title);
    const tooltip = el('div', null, 'chart-tooltip');
    tooltip.hidden = true;
    wrap.append(canvas, tooltip);

    section.append(kpiGrid, wrap);

    let activeIdx = null;
    let layout = { width: 320, left: 56, right: 16, top: 24, bottom: height - 30, begin: 0, end: 1 };

    function computeScale() {
      const activeSeries = series.filter(s => visibleKeys.has(s.key));
      const useSeries = activeSeries.length ? activeSeries : series;
      let minVal = unit === 'dBm' ? Infinity : 0;
      let maxVal = unit === 'dBm' ? -Infinity : 0;
      for (const s of useSeries) {
        for (const p of points) {
          const v = p[s.key];
          if (!Number.isFinite(v)) continue;
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
      if (unit === 'dBm') {
        if (!Number.isFinite(minVal)) { minVal = -30; maxVal = -15; }
        minVal = Math.min(Math.floor(minVal - 1), -29);
        maxVal = Math.max(Math.ceil(maxVal + 1), -12);
        return { min: minVal, max: maxVal, step: niceStep(maxVal - minVal, 4) };
      }
      const niceMax = niceAxisMax(maxVal * 1.12 || 1);
      return { min: 0, max: niceMax, step: niceMax / 4 };
    }

    function draw() {
      const rectWidth = canvas.clientWidth || wrap.clientWidth || 320;
      const width = Math.max(260, rectWidth);
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.scale(scale, scale);

      const { min, max, step } = computeScale();
      const left = 56;
      const right = 16;
      const top = 26;
      const bottom = height - 28;
      const end = Math.max(Date.now(), points.at(-1).at);
      const begin = Math.max(end - windowMs, points[0].at - Math.min(windowMs * 0.03, 60000));
      layout = { width, left, right, top, bottom, begin, end };

      const xOf = at => left + ((at - begin) / Math.max(1, end - begin)) * (width - left - right);
      const yOf = val => bottom - ((val - min) / Math.max(1e-9, max - min)) * (bottom - top);

      // Clear
      ctx.clearRect(0, 0, width, height);

      // Optical threshold background zones
      if (unit === 'dBm') {
        const yTop = top;
        const yWarn = Math.max(top, Math.min(bottom, yOf(-25)));
        const yCrit = Math.max(top, Math.min(bottom, yOf(-27)));
        if (yWarn > yTop) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.06)';
          ctx.fillRect(left, yTop, width - left - right, yWarn - yTop);
        }
        if (yCrit > yWarn) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.07)';
          ctx.fillRect(left, yWarn, width - left - right, yCrit - yWarn);
        }
        if (bottom > yCrit) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
          ctx.fillRect(left, yCrit, width - left - right, bottom - yCrit);
        }
      }

      // Y-axis gridlines
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'right';
      const ticks = [];
      for (let v = min; v <= max + step * 0.001; v += step) ticks.push(v);
      for (const v of ticks) {
        const py = yOf(v);
        if (py < top - 4 || py > bottom + 4) continue;
        ctx.strokeStyle = v === 0 ? '#cbd5e1' : '#e5edf8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, py);
        ctx.lineTo(width - right, py);
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        const lbl = unit === 'dBm'
          ? num1.format(v)
          : max < 2 ? num2.format(v) : max < 20 ? num1.format(v) : num0.format(v);
        ctx.fillText(lbl, left - 8, py + 4);
      }

      // Y-axis unit tag
      ctx.textAlign = 'left';
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
      ctx.fillText(unit, 8, top - 8);

      // -27 dBm warning dashed line for optical
      if (unit === 'dBm' && -27 >= min && -27 <= max) {
        const py = yOf(-27);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.7)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(left, py);
        ctx.lineTo(width - right, py);
        ctx.stroke();
        ctx.fillStyle = '#dc2626';
        ctx.textAlign = 'right';
        ctx.fillText('Batas -27 dBm', width - right - 4, py - 5);
        ctx.restore();
      }

      // X-axis time ticks (5 evenly spaced)
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#64748b';
      const xSteps = width < 420 ? 3 : 4;
      for (let i = 0; i <= xSteps; i++) {
        const t = begin + ((end - begin) * i) / xSteps;
        const px = xOf(t);
        ctx.textAlign = i === 0 ? 'left' : i === xSteps ? 'right' : 'center';
        const label = end - begin > 86400000
          ? fmtDate.format(t) + ' ' + fmtClock.format(t)
          : fmtClock.format(t);
        ctx.fillText(label, px, height - 8);
      }

      // Draw each enabled series with monotone curves + soft gradient fill
      let peakPoint = null;
      const activeList = series.filter(s => visibleKeys.has(s.key));
      for (const s of activeList) {
        const segments = [];
        let seg = [];
        for (const p of points) {
          const val = p[s.key];
          if (!Number.isFinite(val)) {
            if (seg.length) { segments.push(seg); seg = []; }
            continue;
          }
          if (seg.length && p.at - seg.at(-1).at > gapBreakMs) {
            segments.push(seg);
            seg = [];
          }
          const pt = { x: xOf(p.at), y: yOf(val), at: p.at, val };
          seg.push(pt);
          if (!peakPoint || val > peakPoint.val) {
            peakPoint = { ...pt, color: s.color, label: s.short || s.label };
          }
        }
        if (seg.length) segments.push(seg);

        // Clip strictly to plot box
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top - 2, width - left - right, bottom - top + 4);
        ctx.clip();

        for (const segment of segments) {
          if (segment.length >= 2) {
            const grad = ctx.createLinearGradient(0, top, 0, bottom);
            grad.addColorStop(0, hexToRgba(s.color, 0.24));
            grad.addColorStop(1, hexToRgba(s.color, 0.01));
            ctx.beginPath();
            drawMonotonePath(ctx, segment);
            ctx.lineTo(segment.at(-1).x, bottom);
            ctx.lineTo(segment[0].x, bottom);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
          }

          ctx.beginPath();
          drawMonotonePath(ctx, segment);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2.2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke();
        }
        ctx.restore();
      }

      // Peak marker badge when user is not hovering
      if (peakPoint && activeIdx === null && unit !== 'dBm' && peakPoint.val > 0) {
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = peakPoint.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(peakPoint.x, peakPoint.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        const badge = '▲ Puncak ' + fmtVal(peakPoint.val) + ' · ' + fmtClock.format(peakPoint.at);
        ctx.font = '600 10.5px system-ui, -apple-system, sans-serif';
        const tw = ctx.measureText(badge).width + 12;
        const bx = Math.min(Math.max(peakPoint.x - tw / 2, left + 2), width - right - tw - 2);
        const by = Math.max(4, peakPoint.y - 24);
        ctx.fillStyle = 'rgba(20, 36, 66, 0.86)';
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, 18, 6);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(badge, bx + 6, by + 12.5);
        ctx.restore();
      }

      // Active crosshair & highlighted dots
      if (activeIdx != null && points[activeIdx]) {
        const pt = points[activeIdx];
        const cx = xOf(pt.at);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, top);
        ctx.lineTo(cx, bottom);
        ctx.stroke();
        ctx.restore();

        for (const s of activeList) {
          if (!Number.isFinite(pt[s.key])) continue;
          const cy = yOf(pt[s.key]);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    function updateTooltip(clientX) {
      const rect = canvas.getBoundingClientRect();
      const relX = clientX - rect.left;
      const plotW = Math.max(1, layout.width - layout.left - layout.right);
      const frac = Math.min(1, Math.max(0, (relX - layout.left) / plotW));
      const targetAt = layout.begin + frac * (layout.end - layout.begin);
      let closest = 0;
      for (let i = 1; i < points.length; i++) {
        if (Math.abs(points[i].at - targetAt) < Math.abs(points[closest].at - targetAt)) closest = i;
      }
      activeIdx = closest;
      const pt = points[closest];
      const rows = [el('div', fmtFull.format(pt.at) + ' WITA', 'chart-tt-time')];
      let sum = 0;
      let count = 0;
      for (const s of series) {
        if (!visibleKeys.has(s.key) || !Number.isFinite(pt[s.key])) continue;
        sum += pt[s.key];
        count += 1;
        const item = el('div', null, 'chart-tt-row');
        const dot = el('span', null, 'chart-tt-dot');
        dot.style.background = s.color;
        item.append(dot, el('span', s.label + ': '), el('strong', fmtVal(pt[s.key])));
        rows.push(item);
      }
      if (unit !== 'dBm' && count > 1) {
        const tot = el('div', null, 'chart-tt-row chart-tt-total');
        tot.append(el('span', 'Total gabungan: '), el('strong', fmtVal(sum)));
        rows.push(tot);
      }
      tooltip.replaceChildren(...rows);
      tooltip.hidden = false;

      const xPos = Math.min(Math.max(relX + 12, 8), Math.max(8, rect.width - tooltip.offsetWidth - 10));
      tooltip.style.left = xPos + 'px';
      tooltip.style.top = '8px';
      draw();
    }

    // Legend buttons
    for (const s of series) {
      const btn = el('button', null, 'chart-legend-pill');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'true');
      const dot = el('span', null, 'chart-legend-dot');
      dot.style.background = s.color;
      btn.append(dot, document.createTextNode(s.label));
      btn.addEventListener('click', () => {
        if (visibleKeys.has(s.key) && visibleKeys.size > 1) {
          visibleKeys.delete(s.key);
          btn.setAttribute('aria-pressed', 'false');
        } else {
          visibleKeys.add(s.key);
          btn.setAttribute('aria-pressed', 'true');
        }
        draw();
      });
      legend.append(btn);
    }

    canvas.addEventListener('pointermove', e => updateTooltip(e.clientX));
    canvas.addEventListener('pointerdown', e => updateTooltip(e.clientX));
    canvas.addEventListener('pointerleave', () => {
      activeIdx = null;
      tooltip.hidden = true;
      draw();
    });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(wrap);
    requestAnimationFrame(draw);
    return section;
  }

  function renderSparkline(canvas, sparkline) {
    if (!canvas || !Array.isArray(sparkline) || !sparkline.length) return;
    const width = Math.max(140, canvas.clientWidth || 200);
    const height = 52;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(scale, scale);

    let maxVal = 0;
    for (const p of sparkline) {
      if (Number.isFinite(p.rx) && p.rx > maxVal) maxVal = p.rx;
      if (Number.isFinite(p.tx) && p.tx > maxVal) maxVal = p.tx;
    }
    const ceiling = Math.max(maxVal * 1.15, 1e5);
    const padX = 2;
    const padY = 4;
    const span = Math.max(1, sparkline.length - 1);

    for (const [key, color] of [['rx', '#0d9488'], ['tx', '#2563eb']]) {
      const pts = [];
      for (let i = 0; i < sparkline.length; i++) {
        const val = sparkline[i][key];
        if (!Number.isFinite(val)) continue;
        pts.push({
          x: padX + (i / span) * (width - padX * 2),
          y: height - padY - (val / ceiling) * (height - padY * 2),
        });
      }
      if (!pts.length) continue;
      if (pts.length >= 2) {
        const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
        grad.addColorStop(0, hexToRgba(color, 0.22));
        grad.addColorStop(1, hexToRgba(color, 0.0));
        ctx.beginPath();
        drawMonotonePath(ctx, pts);
        ctx.lineTo(pts.at(-1).x, height);
        ctx.lineTo(pts[0].x, height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      drawMonotonePath(ctx, pts);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function createInterfaceGraphView({ api }) {
    const root = el('section', null, 'panel iface-view');
    const header = el('div', null, 'meta iface-meta');
    const titleRow = el('div', null, 'iface-head-row');
    const titleBox = el('div');
    const h2 = el('h2', 'Grafik Interface MikroTik');
    const sub = el('p', 'Pantau trafik harian (Mbps), puncak pemakaian, dan tren interface router secara realtime.');
    titleBox.append(h2, sub);
    const syncInfo = el('span', 'Memuat data interface…', 'iface-sync-badge');
    titleRow.append(titleBox, syncInfo);
    header.append(titleRow);

    const controls = el('div', null, 'iface-controls');
    const routerSelect = el('select');
    const routerLabel = el('label', 'Router MikroTik');
    routerLabel.append(routerSelect);

    const catSelect = el('select');
    catSelect.add(new Option('Interface Aktif Utama', 'main'));
    catSelect.add(new Option('Ethernet / SFP', 'ether'));
    catSelect.add(new Option('VLAN', 'vlan'));
    catSelect.add(new Option('Bridge & Tunnel', 'bridge_tunnel'));
    catSelect.add(new Option('Semua Interface', 'all'));
    catSelect.value = 'main';
    const catLabel = el('label', 'Kategori');
    catLabel.append(catSelect);

    const searchInput = el('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Cari nama interface… (mis. UP LINK, OLT, vlan333)';
    const searchLabel = el('label', 'Cari interface');
    searchLabel.append(searchInput);

    const rangeGroup = el('div', null, 'range-pills');
    const ranges = [
      ['live', 'Live 3 mnt'],
      ['hour', '1 Jam'],
      ['1', '24 Jam (Harian)'],
      ['7', '7 Hari'],
    ];
    let currentRange = '1';
    const rangeButtons = new Map();
    for (const [val, text] of ranges) {
      const btn = el('button', text, 'range-pill');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(val === currentRange));
      btn.addEventListener('click', () => {
        if (currentRange === val) return;
        currentRange = val;
        for (const [k, b] of rangeButtons) b.setAttribute('aria-pressed', String(k === val));
        void refreshAll(true);
      });
      rangeButtons.set(val, btn);
      rangeGroup.append(btn);
    }

    const refreshBtn = el('button', '⟳ Segarkan', 'restart-button');
    refreshBtn.type = 'button';
    refreshBtn.onclick = () => void refreshAll(true);

    controls.append(routerLabel, catLabel, searchLabel, rangeGroup, refreshBtn);

    const heroBox = el('div', null, 'iface-hero-box');
    const gridHead = el('div', null, 'iface-grid-head');
    gridHead.append(el('h3', 'Daftar Interface Router'), el('span', 'Klik kartu untuk fokus grafik', 'chart-sub'));
    const grid = el('div', null, 'iface-grid');

    root.append(header, controls, heroBox, gridHead, grid);

    let overviewData = { routers: [] };
    let selectedRouterId = '';
    let selectedIfaceName = '';
    let isVisible = false;
    let pollTimer = null;
    let loadingOverview = false;

    function matchesCategory(iface, cat) {
      if (cat === 'all') return true;
      if (cat === 'ether') return iface.type === 'ether';
      if (cat === 'vlan') return iface.type === 'vlan';
      if (cat === 'bridge_tunnel') return ['bridge', 'ovpn-out', 'wg', 'eoip', 'l2tp-out', 'sstp-out'].includes(iface.type);
      // 'main': running and not disabled
      return Boolean(iface.running && !iface.disabled);
    }

    function filteredInterfaces() {
      const q = searchInput.value.trim().toLowerCase();
      const cat = catSelect.value;
      const selectedR = routerSelect.value;
      const list = [];
      for (const r of overviewData.routers || []) {
        if (selectedR && r.id !== selectedR) continue;
        for (const iface of r.interfaces || []) {
          if (!matchesCategory(iface, cat)) continue;
          const hay = [iface.name, iface.comment, iface.type, r.name].filter(Boolean).join(' ').toLowerCase();
          if (q && !hay.includes(q)) continue;
          list.push(iface);
        }
      }
      // Sort running first, then busiest live/24h traffic descending
      list.sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        const scoreA = (a.rxBps ?? 0) + (a.txBps ?? 0) + ((a.summary?.maxRx ?? 0) + (a.summary?.maxTx ?? 0)) * 0.1;
        const scoreB = (b.rxBps ?? 0) + (b.txBps ?? 0) + ((b.summary?.maxRx ?? 0) + (b.summary?.maxTx ?? 0)) * 0.1;
        return scoreB - scoreA || a.name.localeCompare(b.name, 'id', { numeric: true });
      });
      return list;
    }

    function syncRouterDropdown() {
      const routers = overviewData.routers || [];
      const prev = routerSelect.value;
      const opts = [new Option('Semua Router (' + routers.length + ')', '')];
      for (const r of routers) {
        opts.push(new Option(r.name + (r.available ? '' : ' (Offline)'), r.id));
      }
      routerSelect.replaceChildren(...opts);
      if ([...routerSelect.options].some(o => o.value === prev)) routerSelect.value = prev;
    }

    function pickInitialSelection(list) {
      if (!list.length) {
        selectedRouterId = '';
        selectedIfaceName = '';
        return;
      }
      if (selectedRouterId && selectedIfaceName && list.some(i => i.routerId === selectedRouterId && i.name === selectedIfaceName)) {
        return;
      }
      const uplink = list.find(i => /up\s*link|wan|isp|ether1/i.test(i.name) && i.running);
      const chosen = uplink || list[0];
      selectedRouterId = chosen.routerId;
      selectedIfaceName = chosen.name;
    }

    function renderGrid(list) {
      if (!list.length) {
        grid.replaceChildren(el('p', 'Tidak ada interface yang cocok dengan filter saat ini.', 'chart-empty'));
        return;
      }
      const cards = list.map(iface => {
        const card = el('button', null, 'iface-card');
        card.type = 'button';
        const isSel = iface.routerId === selectedRouterId && iface.name === selectedIfaceName;
        card.setAttribute('aria-current', String(isSel));

        const top = el('div', null, 'iface-card-top');
        const nameBlock = el('div', null, 'iface-card-title');
        const dot = el('span', null, 'iface-dot ' + (iface.running ? 'up' : 'down'));
        nameBlock.append(dot, el('strong', iface.name));
        const badge = el('span', String(iface.type || 'iface').toUpperCase(), 'iface-type-badge');
        top.append(nameBlock, badge);

        const routerTag = el('div', iface.routerName + (iface.comment ? ' · ' + iface.comment : ''), 'iface-card-sub');

        const rates = el('div', null, 'iface-card-rates');
        const rxBox = el('div');
        rxBox.append(el('span', 'RX Masuk'), el('strong', formatBps(iface.rxBps)));
        const txBox = el('div');
        txBox.append(el('span', 'TX Keluar'), el('strong', formatBps(iface.txBps)));
        const peakVal = Math.max(iface.summary?.maxRx ?? 0, iface.summary?.maxTx ?? 0);
        const peakBox = el('div');
        peakBox.append(el('span', 'Puncak'), el('strong', peakVal > 0 ? formatBps(peakVal) : '—'));
        rates.append(rxBox, txBox, peakBox);

        const spark = el('canvas', null, 'iface-spark');
        card.append(top, routerTag, rates, spark);
        card.addEventListener('click', () => {
          selectedRouterId = iface.routerId;
          selectedIfaceName = iface.name;
          renderGrid(list);
          void loadFocusedHistory();
          if (window.innerWidth <= 900) heroBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        requestAnimationFrame(() => renderSparkline(spark, iface.summary?.sparkline || []));
        return card;
      });
      grid.replaceChildren(...cards);
    }

    async function loadFocusedHistory() {
      if (!selectedRouterId || !selectedIfaceName) {
        heroBox.replaceChildren(el('p', 'Pilih atau konfigurasikan router MikroTik untuk melihat grafik interface.', 'chart-empty'));
        return;
      }
      try {
        const payload = await api('/api/interfaces/history?' + new URLSearchParams({
          routerId: selectedRouterId,
          iface: selectedIfaceName,
          range: currentRange,
        }));
        const meta = payload.meta || {};
        const headerBar = el('div', null, 'iface-focus-meta');
        const leftMeta = el('div', null, 'iface-focus-badges');
        leftMeta.append(...[
          el('span', meta.routerName || selectedRouterId, 'iface-pill blue'),
          el('span', selectedIfaceName, 'iface-pill strong'),
          meta.type ? el('span', String(meta.type).toUpperCase(), 'iface-pill') : null,
          el('span', meta.running ? '● Aktif' : '● Terputus', 'iface-pill ' + (meta.running ? 'green' : 'rose')),
          meta.comment ? el('span', '# ' + meta.comment, 'iface-pill') : null,
        ].filter(Boolean));
        const countersText = (meta.rxGB != null || meta.txGB != null)
          ? 'Counter total router: RX ' + (meta.rxGB >= 1000 ? num2.format(meta.rxGB / 1000) + ' TB' : num2.format(meta.rxGB ?? 0) + ' GB') +
            ' · TX ' + (meta.txGB >= 1000 ? num2.format(meta.txGB / 1000) + ' TB' : num2.format(meta.txGB ?? 0) + ' GB')
          : '';
        headerBar.replaceChildren(...[...leftMeta.children].length ? [leftMeta] : []);
        if (countersText) headerBar.append(el('span', countersText, 'chart-sub'));

        const windowMap = { live: 180000, hour: 3600000, '1': 86400000, '7': 7 * 86400000 };
        const subMap = {
          live: 'Update otomatis tiap 3 detik (RX = masuk ke port · TX = keluar port)',
          hour: 'Sampel rata-rata per menit · 1 jam terakhir',
          '1': 'Sampel rata-rata per menit · 24 jam terakhir',
          '7': 'Agregasi per 10 menit · 7 hari terakhir',
        };
        const chartNode = renderAreaChart({
          title: selectedIfaceName + ' (' + (meta.routerName || selectedRouterId) + ')',
          subtitle: subMap[currentRange] || '',
          data: payload.points || [],
          series: [
            { key: 'rx', short: 'RX', label: 'RX · Masuk Port', color: '#0d9488' },
            { key: 'tx', short: 'TX', label: 'TX · Keluar Port', color: '#2563eb' },
          ],
          windowMs: windowMap[currentRange] || 86400000,
          height: 290,
          rawBps: true,
          unit: 'Mbps',
          kpiMode: 'traffic',
          gapBreakMs: currentRange === '7' ? 35 * 60000 : 12 * 60000,
        });

        heroBox.replaceChildren(headerBar, chartNode);
      } catch (err) {
        heroBox.replaceChildren(el('p', err.message || 'Gagal memuat riwayat interface.', 'chart-empty'));
      }
    }

    async function refreshAll(fetchOverview = true) {
      if (!isVisible) return;
      clearTimeout(pollTimer);
      try {
        if (fetchOverview && !loadingOverview) {
          loadingOverview = true;
          const daysParam = currentRange === 'live' ? '1' : currentRange;
          overviewData = await api('/api/interfaces?days=' + encodeURIComponent(daysParam));
          syncRouterDropdown();
          const list = filteredInterfaces();
          pickInitialSelection(list);
          renderGrid(list);
          syncInfo.textContent = overviewData.sampledAt
            ? 'Update ' + fmtFull.format(Date.parse(overviewData.sampledAt)) + ' WITA'
            : 'Menunggu polling MikroTik…';
          loadingOverview = false;
        }
        await loadFocusedHistory();
      } catch (err) {
        loadingOverview = false;
        syncInfo.textContent = err.message || 'Gagal memuat data MikroTik';
      }
      if (isVisible) {
        const delay = currentRange === 'live' ? 3000 : 15000;
        pollTimer = setTimeout(() => void refreshAll(true), delay);
      }
    }

    routerSelect.addEventListener('change', () => {
      const list = filteredInterfaces();
      pickInitialSelection(list);
      renderGrid(list);
      void loadFocusedHistory();
    });
    catSelect.addEventListener('change', () => {
      const list = filteredInterfaces();
      pickInitialSelection(list);
      renderGrid(list);
      void loadFocusedHistory();
    });
    searchInput.addEventListener('input', () => {
      const list = filteredInterfaces();
      renderGrid(list);
    });

    return {
      element: root,
      show() {
        isVisible = true;
        root.hidden = false;
        void refreshAll(true);
      },
      hide() {
        isVisible = false;
        root.hidden = true;
        clearTimeout(pollTimer);
      },
    };
  }

  return {
    formatBps,
    formatMbps,
    formatVolume,
    renderAreaChart,
    renderSparkline,
    createInterfaceGraphView,
  };
})();
