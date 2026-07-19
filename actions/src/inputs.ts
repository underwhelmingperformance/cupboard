import { appendFile } from 'node:fs/promises';

import { InvalidInputError, MissingInputError } from './errors.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export function parseLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

type InputFallback = string | (() => string);

export function input(
	environment: Environment,
	name: string,
	fallback: InputFallback = ''
): string {
	const prefixedName = 'INPUT_' + name;
	const value = (environment[prefixedName] ?? environment[name] ?? '').trim();

	if (value !== '') {
		return value;
	}

	return typeof fallback === 'function' ? fallback() : fallback;
}

export function isInputEnabled(
	environment: Environment,
	name: string,
	isEnabledByDefault: boolean
): boolean {
	const value = input(
		environment,
		name,
		isEnabledByDefault ? 'true' : 'false'
	).toLowerCase();

	if (value === 'true') {
		return true;
	}

	if (value === 'false') {
		return false;
	}

	throw new InvalidInputError(
		name.toLowerCase().replaceAll('_', '-'),
		`${name.toLowerCase().replaceAll('_', '-')} must be true or false`
	);
}

export function requireInput(value: string | undefined, name: string): string {
	if (value === undefined || value === '') {
		throw new MissingInputError(name);
	}

	return value;
}

export async function appendEnvironmentFile(
	filePath: string | undefined,
	value: string
): Promise<void> {
	if (filePath === undefined || filePath === '') {
		return;
	}

	await appendFile(filePath, value);
}

export async function setOutput(
	environment: Environment,
	name: string,
	value: string
): Promise<void> {
	await appendEnvironmentFile(environment.GITHUB_OUTPUT, `${name}=${value}\n`);
}
