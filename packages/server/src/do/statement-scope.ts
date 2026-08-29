import { AsyncLocalStorage } from 'node:async_hooks';

import {
	MissingStatementAllowanceError,
	StatementAllowanceExceededError
} from '../errors.ts';
import { d1StatementsPerInvocation } from '../http/http.ts';

/**
 * The remaining D1 statement allowance for one invocation, including any
 * amount reserved for work after the current body.
 */
class StatementAllowance {
	private remaining: number;
	private reserved = 0;

	constructor(statements: number) {
		this.remaining = statements;
	}

	get available(): number {
		return Math.max(0, this.remaining - this.reserved);
	}

	spend(statements: number, subject: string): void {
		if (statements > this.available) {
			throw new StatementAllowanceExceededError(
				subject,
				statements,
				this.available
			);
		}

		this.remaining -= statements;
	}

	hold(statements: number): void {
		this.reserved += statements;
	}

	releaseHold(statements: number): void {
		this.reserved -= statements;
	}
}

const allowanceScope = new AsyncLocalStorage<StatementAllowance>();

/**
 * Runs `body` under one invocation's D1 statement allowance.
 *
 * The D1 binding decrements this allowance before it executes each statement.
 * If a statement would exceed the allowance, the binding rejects it before
 * execution. Callers retain unfinished work in durable state for a later
 * invocation.
 *
 * A nested call reuses the enclosing allowance. Every dispatched method can
 * therefore open a scope without creating another allowance for the same
 * invocation.
 *
 * The body may be synchronous or asynchronous: async-local storage carries the
 * allowance into whatever the body awaits.
 */
export function withStatementAllowance<T>(
	body: () => T,
	statements: number = d1StatementsPerInvocation
): T {
	if (allowanceScope.getStore() !== undefined) {
		return body();
	}

	return allowanceScope.run(new StatementAllowance(statements), body);
}

/**
 * Reserves `statements` from the current allowance while `body` runs. The body
 * can spend the remainder. The reserved statements become available after the
 * body returns.
 *
 * Outside an allowance this runs `body` unchanged.
 */
export async function withHeldStatements<T>(
	statements: number,
	body: () => Promise<T>
): Promise<T> {
	const allowance = allowanceScope.getStore();

	if (allowance === undefined) {
		return body();
	}

	allowance.hold(statements);

	try {
		return await body();
	} finally {
		allowance.releaseHold(statements);
	}
}

/**
 * How many D1 statements the current invocation may still run.
 *
 * Every Durable Object dispatch opens an allowance. This function throws if a
 * caller invokes it outside the dispatch wrapper.
 */
export function statementsRemaining(): number {
	const allowance = allowanceScope.getStore();

	if (allowance === undefined) {
		throw new MissingStatementAllowanceError();
	}

	return allowance.available;
}

/**
 * How many operations of `statementsEach` fit in the current allowance after
 * reserving `keepBack` statements for later work.
 *
 * The result is a page limit. D1 calls consume the allowance when they run.
 */
export function affordableOperations(
	statementsEach: number,
	keepBack = 0
): number {
	return Math.floor(
		Math.max(0, statementsRemaining() - keepBack) / statementsEach
	);
}

/**
 * Decrements the current allowance by `statements`. If the remaining allowance
 * is smaller, the function rejects the complete amount. The D1 binding calls
 * this before executing a statement or batch.
 */
export function spendStatements(statements: number, subject: string): void {
	allowanceScope.getStore()?.spend(statements, subject);
}

/**
 * Whether the caller runs under an allowance that requires an exact statement
 * count before each D1 call.
 */
export function hasStatementAllowance(): boolean {
	return allowanceScope.getStore() !== undefined;
}

/**
 * Wraps every method on `prototype` so each dispatch enters the invocation's D1
 * allowance.
 *
 * A Durable Object applies this to its prototype once. The wrapper then covers
 * every method the runtime can dispatch, including requests, alarms, RPCs and
 * methods added later. Each dispatch therefore shares one allowance.
 *
 * A static initialiser wraps every method on the prototype once. A Proxy over
 * each instance would instead intercept every property read, which the commit
 * fan-out performs constantly, so the prototype is the cheaper place to put the
 * wrapper. A method that calls another method of the same object enters a
 * nested allowance, which reuses the enclosing one, so the invocation still has
 * exactly one.
 */
export function enterStatementAllowanceOnDispatch(prototype: object): void {
	for (const property of Object.getOwnPropertyNames(prototype)) {
		if (property === 'constructor') {
			continue;
		}

		const descriptor = Object.getOwnPropertyDescriptor(prototype, property);

		if (descriptor === undefined) {
			continue;
		}

		const method: unknown = descriptor.value;

		// Only function-valued data properties represent dispatched methods.
		if (typeof method !== 'function') {
			continue;
		}

		Object.defineProperty(prototype, property, {
			...descriptor,
			value: function (this: unknown, ...parameters: unknown[]): unknown {
				return withStatementAllowance((): unknown =>
					Reflect.apply(method, this, parameters)
				);
			}
		});
	}
}
