/**
 * A hard cap on live inference calls per run.
 *
 * Past the cap it REFUSES — and the refusal is a value, never a throw. A throwing runner would
 * surface as an unhandled rejection (API-NOTES #5) and kill the process mid-demo, which is a
 * worse outcome than an over-budget call. The caller decides what a refusal means; the guard just
 * makes sure the bill has a ceiling the user set.
 */
export type BudgetVerdict =
	| { readonly ok: true; readonly remaining: number }
	| { readonly ok: false; readonly reason: "budget-exhausted"; readonly cap: number; readonly spent: number }

export class BudgetGuard {
	private spent = 0

	constructor(private readonly cap: number) {}

	/** Ask before spending. Never consumes on refusal. */
	authorize(): BudgetVerdict {
		if (this.spent >= this.cap) {
			return { ok: false, reason: "budget-exhausted", cap: this.cap, spent: this.spent }
		}
		this.spent += 1
		return { ok: true, remaining: this.cap - this.spent }
	}

	used(): number {
		return this.spent
	}

	remaining(): number {
		return Math.max(0, this.cap - this.spent)
	}
}
