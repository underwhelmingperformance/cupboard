class TestWorkerBudgetError extends Error {
	constructor(value: string) {
		super(
			`CUPBOARD_TEST_WORKERS must be a positive safe integer; received ${JSON.stringify(value)}`
		);
		this.name = 'TestWorkerBudgetError';
	}
}

export function resolveTestWorkerBudget(value: string | undefined): number {
	if (value === undefined) {
		return 4;
	}

	const budget = Number(value);
	if (!/^\d+$/u.test(value) || !Number.isSafeInteger(budget) || budget < 1) {
		throw new TestWorkerBudgetError(value);
	}

	return budget;
}
