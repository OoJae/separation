import { MASTER_TICK_MS } from "../../domain/airspace/units"
import type { Clock, TimerHandle } from "../../support/ports"
import type { TickOutput, WorldEngine } from "./world-engine"

/**
 * WorldDriver — holds EXACTLY ONE Clock handle for the whole simulation.
 *
 * This is a determinism constraint, not a tidiness preference. 20 Hz is not a subharmonic of
 * 50 Hz, so three independent repeating VirtualClock timers would come due together every 100 ms,
 * and `VirtualClock.at` breaks ties by insertion sequence — which changes as timers re-register.
 * The firing order would then depend on scheduling history rather than on the model.
 *
 * One 10 ms master timer, phases gated by integer modulus, removes the question. The
 * "exactly one handle" claim is asserted by test, not just stated here.
 */
export class WorldDriver {
	private handle: TimerHandle | null = null
	private handlesEverTaken = 0

	constructor(
		private readonly engine: WorldEngine,
		private readonly clock: Clock,
		private readonly onTick: (output: TickOutput) => void,
	) {}

	start(): void {
		if (this.handle !== null) return
		this.schedule()
	}

	stop(): void {
		if (this.handle === null) return
		this.clock.cancel(this.handle)
		this.handle = null
	}

	/** How many timer handles this driver has ever taken. Must equal the number of ticks + 1. */
	handlesTaken(): number {
		return this.handlesEverTaken
	}

	isRunning(): boolean {
		return this.handle !== null
	}

	private schedule(): void {
		this.handlesEverTaken += 1
		this.handle = this.clock.after(MASTER_TICK_MS, () => {
			this.handle = null
			this.onTick(this.engine.step())
			// Re-arm only if we were not stopped from inside the callback.
			if (this.handle === null) this.schedule()
		})
	}
}
