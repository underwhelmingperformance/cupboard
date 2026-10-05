import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

export async function writeBuildInfo(
	outputPath: string,
	version: string
): Promise<void> {
	const source = `export const buildVersion = ${JSON.stringify(version)};\n`;
	try {
		if ((await readFile(outputPath, 'utf8')) === source) {
			return;
		}
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			throw error;
		}
	}
	const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, source);
		await rename(temporaryPath, outputPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
