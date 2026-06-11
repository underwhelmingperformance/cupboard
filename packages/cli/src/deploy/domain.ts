import { CliError } from '../errors.ts';

export class InvalidDomainError extends CliError {
	constructor(
		public readonly domain: string,
		reason: string
	) {
		super(`Invalid --domain ${domain}: ${reason}`);
		this.name = 'InvalidDomainError';
	}
}

const labelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Why `value` cannot be a custom domain, or undefined when it can. The same
 * verdict drives the `--domain` flag check and the interactive prompt's inline
 * validation, so both paths agree.
 */
export function domainProblem(value: string): string | undefined {
	if (value.length === 0) {
		return 'a domain cannot be empty';
	}

	if (value.length > 253) {
		return 'a domain must be at most 253 characters';
	}

	if (value.includes('://') || value.includes('/')) {
		return 'use a bare hostname, without a scheme or path';
	}

	const labels = value.split('.');

	if (labels.length < 2) {
		return 'use a fully qualified hostname (e.g. cache.example.com)';
	}

	if (!labels.every((label) => labelPattern.test(label))) {
		return 'hostname labels must be letters, digits and inner hyphens';
	}

	return undefined;
}

/** Validates a `--domain` flag value, throwing the typed error when invalid. */
export function checkDomainOption(value: string): string {
	const problem = domainProblem(value);

	if (problem !== undefined) {
		throw new InvalidDomainError(value, problem);
	}

	return value;
}
