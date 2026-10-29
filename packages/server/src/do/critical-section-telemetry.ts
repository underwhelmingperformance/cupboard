import { rootLogger } from '@cupboard/logger';

import type { withSpan } from '../observability/span.ts';

import {
	currentDeadlineSignal,
	remainingDeadlineMs,
	SectionSubrequests,
	withDeadlineBudget
} from './deadline.ts';
import { currentOperationCost } from './operation-cost.ts';

/**
What the over-budget record of one critical section needs: its label, budget
and entry time, and the bounded subrequests that it has started.
*/
class ObservedSection {
	private readonly enteredAt = Date.now();
	private isRecorded = false;
	readonly subrequests = new SectionSubrequests();

	constructor(
		readonly label: string,
		private readonly budgetMs: number
	) {}

	recordOverBudget(span: Span | undefined): void {
		if (this.isRecorded) {
			return;
		}

		this.isRecorded = true;
		const now = Date.now();
		const elapsedMs = now - this.enteredAt;
		const pendingSubrequests = this.subrequests.snapshot(now);

		span?.setAttribute('overBudget', true);
		span?.setAttribute('budgetMs', this.budgetMs);
		span?.setAttribute('elapsedMs', elapsedMs);
		span?.setAttribute(
			'pendingSubrequests',
			JSON.stringify(pendingSubrequests)
		);
		rootLogger().warn('critical section over budget', {
			label: this.label,
			budgetMs: this.budgetMs,
			elapsedMs,
			pendingSubrequests
		});
	}
}

export interface CriticalSectionObservation {
	readonly budgetMs: number;
	/**
	Opens the section's span. The Durable Object supplies it, because this
	module also loads in Node tests, where `cloudflare:workers` is not
	available. Without it, the section has no span.
	*/
	readonly withSpan: typeof withSpan | undefined;
}

/**
Runs one critical section's body within its budget and records the section,
so that the code that kept the input gate can be identified after a reset.

The runtime resets a Durable Object whose section runs for about 30 seconds,
and a reset section never finishes, so the section is recorded at entry and
at its budget. Entry opens a `critical-section` span, which the runtime
force-closes at a reset. When the section reaches its budget, a `critical
section over budget` warning lists the section's label, budget, elapsed time
and the bounded subrequests still pending, and the span records the same
facts. An enclosing deadline that ends before the budget writes no record.

The record is written when the section's deadline aborts, or when a bounded
subrequest times out at that deadline, whichever happens first.

The label is that of the innermost operation-cost scope: the dispatched
method or the metered pass that entered the section. Each section costs one
span, one async-local scope and one abort listener, plus one set entry for
each bounded subrequest that it starts. A section that finishes within its
budget writes no log record.
*/
export function observeCriticalSection<T>(
	body: () => Promise<T>,
	observation: CriticalSectionObservation
): Promise<T> {
	const { budgetMs } = observation;
	const enclosingMs = remainingDeadlineMs();
	const hasOwnBudget = enclosingMs === undefined || enclosingMs > budgetMs;
	const section = new ObservedSection(
		currentOperationCost()?.label ?? 'unscoped',
		budgetMs
	);
	const run = (span?: Span): Promise<T> => {
		const recordOverBudget = (): void => {
			section.recordOverBudget(span);
		};

		return withDeadlineBudget(budgetMs, async () => {
			const deadline = hasOwnBudget ? currentDeadlineSignal() : undefined;

			if (deadline !== undefined) {
				deadline.addEventListener('abort', recordOverBudget, { once: true });
				section.subrequests.watchDeadline(deadline, recordOverBudget);
			}

			try {
				return await section.subrequests.run(body);
			} finally {
				deadline?.removeEventListener('abort', recordOverBudget);
				section.subrequests.unwatchDeadline();
			}
		});
	};

	if (observation.withSpan === undefined) {
		return run();
	}

	return observation.withSpan(
		'critical-section',
		{ label: section.label },
		run
	);
}
