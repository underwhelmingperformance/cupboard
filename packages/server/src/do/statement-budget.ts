/**
 * Tracks the remaining D1 statement allocation for one drain. Callers charge
 * each operation's worst-case cost before running it.
 *
 * A drain whose cost per unit of work is not fixed stops when the budget cannot
 * cover the next step. The work it left behind stays in its durable queue, so
 * the next invocation resumes with an allocation of its own.
 */
export class StatementBudget {
	private remaining: number;

	constructor(statements: number) {
		this.remaining = statements;
	}

	/**
	 * How many operations of `statementsEach` the budget still covers while
	 * keeping `keepBack` statements in reserve. Use it to limit a page of work to
	 * what this invocation can afford, and to keep back what the caller must
	 * still run after that page.
	 */
	operationsLeft(statementsEach: number, keepBack = 0): number {
		return Math.floor(Math.max(0, this.remaining - keepBack) / statementsEach);
	}

	/**
	 * Takes `statements` from the budget when it covers them, and reports
	 * whether it did. A charge the budget cannot cover leaves the balance
	 * unchanged, so the caller may charge a smaller step instead.
	 */
	take(statements: number): boolean {
		if (statements > this.remaining) {
			return false;
		}

		this.remaining -= statements;

		return true;
	}
}
