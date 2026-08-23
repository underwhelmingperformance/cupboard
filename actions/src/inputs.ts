import { appendFile } from 'node:fs/promises';

import { MissingInputError } from './errors.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export function parseLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function requireEnvironment(
	environment: Environment,
	name: string
): string {
	const value = environment[name];

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
