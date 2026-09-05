import { describe, expect, it } from "@rstest/core"
import { readFileSync } from "node:fs"
import { TraceWriter, type Trace } from "../../src/instrument/trace-writer"

const trace = JSON.parse(readFileSync("fixtures/trace.json", "utf8")) as Trace

/**
 * The viewer draws a picture; these assert the picture is TRUE.
 *
 * The in-flight strip's whole claim is that overlapping bars mean two agents were thinking at the
 * same time. That has to be a computed fact about the recorded run, not a rendering choice — so
 * the overlap is asserted here, from the same function the viewer calls, and the canvas is left to
 * be merely a canvas.
 */
describe("the recorded trace", () => {
	it("has world frames, so the scope has something real to draw", () => {
		expect(trace.meta.frames).toBeGreaterThan(300)
		expect(trace.frames[0]!.tracks.length).toBeGreaterThanOrEqual(2)
		for (const track of trace.frames[0]!.tracks) {
			expect(Number.isFinite(track.x)).toBe(true)
			expect(Number.isFinite(track.altFt)).toBe(true)
		}
	})

	it("TWO TURNS GENUINELY OVERLAP — the claim the strip makes", () => {
		const overlaps = TraceWriter.overlaps(trace)
		expect(overlaps.length).toBeGreaterThan(0)

		const pair = overlaps[0]!
		expect(pair.a.participant).not.toBe(pair.b.participant)
		expect(pair.ms).toBeGreaterThan(1_000)      // seconds of simultaneity, not a rounding artefact
		expect(Number.isFinite(pair.ms)).toBe(true) // never Infinity from an unclosed turn
	})

	it("never reports an infinite overlap, even if a turn never closed", () => {
		const unfinished: Trace = {
			...trace,
			turns: [
				{ participant: "A", turnId: "t1", openedMs: 0, closedMs: null, reason: null },
				{ participant: "B", turnId: "t2", openedMs: 10, closedMs: null, reason: null },
			],
			meta: { ...trace.meta, generatedAtTSim: 500 },
		}
		const overlaps = TraceWriter.overlaps(unfinished)
		expect(overlaps).toHaveLength(1)
		expect(overlaps[0]!.ms).toBe(490) // clipped to the end of the run
	})

	it("carries the money shot as an ordered narrative", () => {
		const kinds = trace.beats.map((b) => b.kind)
		expect(kinds).toContain("intent")
		expect(kinds).toContain("objection")
		expect(kinds).toContain("held")
		expect(kinds).toContain("narrowed")

		// The objection must land AFTER an intent was announced — that is the whole mechanism.
		expect(kinds.indexOf("objection")).toBeGreaterThan(kinds.indexOf("intent"))
		// And the narrowing must come after the objection that caused it.
		expect(kinds.lastIndexOf("narrowed")).toBeGreaterThan(kinds.indexOf("objection"))
	})

	it("records the objection with its reason, not just its occurrence", () => {
		const objection = trace.beats.find((b) => b.kind === "objection")!
		expect(objection.text).toContain("FLOW")
		expect(objection.text).toContain("APPROACH")
		expect(objection.text.length).toBeGreaterThan(30)
	})

	it("shows the aircraft actually converging, so the scope is not static", () => {
		const first = trace.frames[0]!.tracks
		const last = trace.frames.at(-1)!.tracks
		const rangeAt = (ts: typeof first) => Math.hypot(ts[0]!.x - ts[1]!.x, ts[0]!.y - ts[1]!.y)
		expect(rangeAt(last)).not.toBeCloseTo(rangeAt(first), 1)
	})
})
