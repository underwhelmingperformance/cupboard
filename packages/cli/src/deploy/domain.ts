import { CliError } from '../errors.ts';

export type DomainProblem =
	| 'empty'
	| 'invalid-label'
	| 'not-fully-qualified'
	| 'scheme-or-path'
	| 'too-long';

export class InvalidDomainError extends CliError {
	constructor(
		public readonly domain: string,
		public readonly problem: DomainProblem
	) {
		super(`Invalid --domain ${domain}: ${domainProblemMessage(problem)}`);
		this.name = 'InvalidDomainError';
	}
}

const labelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function domainProblem(value: string): DomainProblem | undefined {
	if (value.length === 0) {
		return 'empty';
	}

	if (value.length > 253) {
		return 'too-long';
	}

	if (value.includes('://') || value.includes('/')) {
		return 'scheme-or-path';
	}

	const labels = value.split('.');

	if (labels.length < 2) {
		return 'not-fully-qualified';
	}

	if (labels.some((label) => !labelPattern.test(label))) {
		return 'invalid-label';
	}

	return undefined;
}

export function domainProblemMessage(problem: DomainProblem): string {
	switch (problem) {
		case 'empty': {
			return 'a domain cannot be empty';
		}
		case 'invalid-label': {
			return 'hostname labels must be letters, digits and inner hyphens';
		}
		case 'not-fully-qualified': {
			return 'use a fully qualified hostname (e.g. cache.example.com)';
		}
		case 'scheme-or-path': {
			return 'use a bare hostname, without a scheme or path';
		}
		case 'too-long': {
			return 'a domain must be at most 253 characters';
		}
	}
}

export function domainProblemText(value: string): string | undefined {
	const problem = domainProblem(value);

	return problem === undefined ? undefined : domainProblemMessage(problem);
}

export function checkDomainOption(value: string): string {
	const problem = domainProblem(value);

	if (problem !== undefined) {
		throw new InvalidDomainError(value, problem);
	}

	return value;
}
