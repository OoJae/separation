import { createScene } from "./scene.js"

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

/* One reveal behaviour, fired once, near the viewport. Nothing loops. */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target) }
}, { rootMargin: "0px 0px -15% 0px" })
document.querySelectorAll(".rv").forEach((el, i) => {
  el.style.transitionDelay = `${Math.min(i, 6) * 0.06}s`
  io.observe(el)
})

const canvas = document.getElementById("scope")
if (canvas) {
  fetch("fixtures/ablation-ab.json")
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
    .then((data) => {
      const scene = createScene(canvas, data.arms)
      const wrap = document.querySelector(".scenewrap")
      const caption = document.getElementById("sceneCaption")
      const body = document.getElementById("sceneBody")
      const clock = document.getElementById("sceneClock")
      const lost = data.arms.find((a) => a.separationLost)

      let progress = reduced ? 0.62 : 0     // reduced motion opens on the divergence, already split
      let raf = 0

      const copy = (p, t) => {
        if (p < 0.45) {
          caption.textContent = "Each aircraft wears 3 nautical miles and a thousand feet."
          body.textContent = "The two shapes touch exactly when the standard is broken."
        } else if (t < (lost?.lostAtSec ?? 97.62)) {
          caption.textContent = "Same seed. Same integrator. Two architectures."
          body.textContent = "Laterally these are identical. Watch the vertical."
        } else {
          caption.textContent = "One of them just broke the standard."
          body.textContent = "Validate-at-commit never held both clearances at once, so it had nothing to compare."
        }
        clock.textContent = `t+${String(Math.round(t)).padStart(3, "0")} s`
      }

      const draw = () => {
        raf = 0
        // Yaw drifts with scroll rather than with time: the camera only moves when the reader does.
        const { t } = scene.render(progress, -0.5 + progress * 0.55)
        copy(progress, t)
      }
      const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }

      const onScroll = () => {
        const r = wrap.getBoundingClientRect()
        const span = r.height - innerHeight
        progress = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0.62
        schedule()
      }

      addEventListener("resize", () => { scene.size(); schedule() }, { passive: true })
      if (!reduced) addEventListener("scroll", onScroll, { passive: true })
      scene.size(); draw()
    })
    .catch(() => {
      canvas.closest(".scenepin").innerHTML =
        '<p class="wrap dim" style="padding-top:20vh">The scene needs <code>fixtures/ablation-ab.json</code>. ' +
        'Run <code>npm run record:ablation</code>, then serve over HTTP — browsers block fetch on file:// URLs.</p>'
    })
}
