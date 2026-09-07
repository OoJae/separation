/**
 * The separation volumes.
 *
 * Two aircraft, each wearing a protection volume of 1.5 NM radius and 500 ft half-height. Those
 * numbers are chosen so the two volumes touch EXACTLY when the pair violates the standard this
 * project enforces: lateral < 3.0 NM and vertical < 1000 ft, together. Intersection on screen is
 * loss of separation, with no interpretation in between.
 *
 * Why this is drawn in three dimensions rather than as the plan view a real scope uses: across all
 * 380 recorded frames the two arms are laterally IDENTICAL — both reach 2.3511 NM at t+115 s, and
 * the x/y ranges match to the last digit. What differs is only the vertical: 400.67 ft in the arm
 * that loses separation, exactly 1000 ft in the arm the interlock corrected. A top-down scope
 * renders the catastrophe and the save as the same picture. The third axis is the only one on which
 * this story exists.
 *
 * Hand-rolled rather than WebGL because a radar display is a vector instrument. Stacked ellipses and
 * struts in phosphor read as an instrument; a shaded solid reads as a product render. It also means
 * no dependency, no CDN, and nothing to fail on someone else's network.
 */
const FT_PER_NM_VISUAL = 1 / 1000 * 1.5   // 1000 ft of altitude draws as 1.5 NM, so the volumes are flat
const VOL_R = 1.5                          // NM — half of the 3.0 NM lateral minimum
const VOL_H = 500 * FT_PER_NM_VISUAL       // half of the 1000 ft vertical minimum

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

export function createScene(canvas, arms) {
  const ctx = canvas.getContext("2d")
  const C = { void: css("--void"), rule: css("--rule"), ph: css("--phosphor"),
              ra: css("--ra"), chart: css("--chart"), dim: css("--dim") }
  let W = 0, H = 0, dpr = 1

  function size() {
    const r = canvas.getBoundingClientRect()
    dpr = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** World (x,y NM; z NM-equivalent) → screen, through a fixed oblique camera. */
  function makeCamera(pane, cx, cy, spanNm, yaw) {
    const pitch = 0.42                       // low enough that the vertical gap is always readable
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
    const scale = Math.min(pane.w, pane.h * 1.7) / spanNm
    return (x, y, z) => {
      const dx = x - cx, dy = y - cy
      const rx = dx * cosY - dy * sinY
      const ry = dx * sinY + dy * cosY
      return [
        pane.x + pane.w / 2 + rx * scale,
        pane.y + pane.h / 2 + (ry * cosP - z * sinP) * scale,
        ry * sinP + z * cosP,                // depth, for alpha only
      ]
    }
  }

  function ellipse(P, cx, cy, z, r, colour, alpha, dash) {
    ctx.beginPath()
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2
      const [sx, sy] = P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z)
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy)
    }
    ctx.strokeStyle = colour; ctx.globalAlpha = alpha; ctx.lineWidth = 1
    if (dash) ctx.setLineDash(dash)
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1
  }

  function volume(P, t, colour, hot) {
    const z = t.altFt * FT_PER_NM_VISUAL
    ellipse(P, t.x, t.y, z + VOL_H, VOL_R, colour, hot ? .95 : .5)
    ellipse(P, t.x, t.y, z - VOL_H, VOL_R, colour, hot ? .6 : .28)
    ctx.strokeStyle = colour; ctx.globalAlpha = hot ? .45 : .2; ctx.lineWidth = 1
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const [ax, ay] = P(t.x + Math.cos(a) * VOL_R, t.y + Math.sin(a) * VOL_R, z + VOL_H)
      const [bx, by] = P(t.x + Math.cos(a) * VOL_R, t.y + Math.sin(a) * VOL_R, z - VOL_H)
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    }
    // The drop line to the deck. Without it the altitude reads as position and the scene flattens.
    const [tx, ty] = P(t.x, t.y, z - VOL_H)
    const [gx, gy] = P(t.x, t.y, 0)
    ctx.globalAlpha = .22; ctx.setLineDash([2, 4])
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(gx, gy); ctx.stroke()
    ctx.setLineDash([]); ctx.globalAlpha = 1
    return [tx, ty, z]
  }

  function deck(P, cx, cy, spanNm) {
    ctx.strokeStyle = C.rule; ctx.globalAlpha = .8; ctx.lineWidth = 1
    for (let r = 5; r <= 25; r += 5) ellipse(P, 0, 0, 0, r, C.rule, .5)
    const n = Math.ceil(spanNm / 2)
    for (let i = -n; i <= n; i++) {
      const a = P(cx + i * 2, cy - spanNm, 0), b = P(cx + i * 2, cy + spanNm, 0)
      const c = P(cx - spanNm, cy + i * 2, 0), d = P(cx + spanNm, cy + i * 2, 0)
      ctx.globalAlpha = .35
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  function drawArm(arm, pane, tIndex, yaw, label) {
    const f = arm.frames[Math.max(0, Math.min(arm.frames.length - 1, Math.round(tIndex)))]
    if (!f) return
    const [a, b] = f.tracks
    const range = Math.hypot(a.x - b.x, a.y - b.y)
    const dz = Math.abs(a.altFt - b.altFt)
    const lost = range < 3 && dz < 1000

    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
    const spanNm = Math.max(9, range * 2.6)
    const P = makeCamera(pane, cx, cy, spanNm, yaw)

    ctx.save()
    ctx.beginPath(); ctx.rect(pane.x, pane.y, pane.w, pane.h); ctx.clip()
    deck(P, cx, cy, spanNm)

    // Trail: 60 s of where each has been. Enough to read the convergence, not enough to clutter.
    for (const cs of [a.callsign, b.callsign]) {
      ctx.beginPath(); let started = false
      for (let i = Math.max(0, tIndex - 60); i <= tIndex; i++) {
        const pf = arm.frames[Math.round(i)]; if (!pf) continue
        const tr = pf.tracks.find((x) => x.callsign === cs); if (!tr) continue
        const [sx, sy] = P(tr.x, tr.y, tr.altFt * FT_PER_NM_VISUAL)
        started ? ctx.lineTo(sx, sy) : (ctx.moveTo(sx, sy), started = true)
      }
      ctx.strokeStyle = C.ph; ctx.globalAlpha = .3; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1
    }

    const colour = lost ? C.ra : C.ph
    const pa = volume(P, a, colour, lost)
    const pb = volume(P, b, colour, lost)

    // The measured gap — the subject of the whole page.
    ctx.strokeStyle = lost ? C.ra : C.dim; ctx.globalAlpha = lost ? .9 : .55
    ctx.setLineDash(lost ? [] : [3, 4]); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke()
    ctx.setLineDash([]); ctx.globalAlpha = 1

    ctx.font = "11px " + css("--mono")
    ctx.textAlign = "center"
    ctx.fillStyle = lost ? C.ra : C.chart
    ctx.fillText(`${range.toFixed(2)} NM / ${Math.round(dz)} FT`,
      (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2 - 12)

    ctx.textAlign = "left"; ctx.fillStyle = C.dim
    for (const [tr, p] of [[a, pa], [b, pb]]) {
      ctx.fillStyle = C.chart; ctx.fillText(tr.callsign, p[0] + 10, p[1] - 2)
      ctx.fillStyle = C.dim;   ctx.fillText(`${Math.round(tr.altFt)} ft`, p[0] + 10, p[1] + 11)
    }

    if (label) {
      ctx.textAlign = "left"; ctx.font = "10px " + css("--mono")
      ctx.fillStyle = lost ? C.ra : C.dim
      ctx.fillText(label.toUpperCase(), pane.x + 14, pane.y + 20)
      if (lost) {
        ctx.fillStyle = C.ra
        ctx.fillText("SEPARATION LOST", pane.x + 14, pane.y + 36)
      }
    }
    ctx.restore()
    return lost
  }

  /** progress 0→1 across the pinned section. split is where the A/B opens. */
  function render(progress, yaw) {
    if (!W) size()
    ctx.fillStyle = C.void; ctx.fillRect(0, 0, W, H)
    const t = progress * (arms[0].frames.length - 1)
    const split = progress > .45
    const stacked = W < 720

    if (!split) {
      drawArm(arms[1], { x: 0, y: 0, w: W, h: H }, t, yaw, null)
      return { t, split }
    }
    const gap = 1
    const panes = stacked
      ? [{ x: 0, y: 0, w: W, h: H / 2 - gap }, { x: 0, y: H / 2 + gap, w: W, h: H / 2 - gap }]
      : [{ x: 0, y: 0, w: W / 2 - gap, h: H }, { x: W / 2 + gap, y: 0, w: W / 2 - gap, h: H }]
    ctx.strokeStyle = C.rule
    ctx.beginPath()
    if (stacked) { ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2) } else { ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H) }
    ctx.stroke()
    drawArm(arms[0], panes[0], t, yaw, arms[0].label)
    drawArm(arms[1], panes[1], t, yaw, arms[1].label)
    return { t, split }
  }

  return { render, size }
}
