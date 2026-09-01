import { AppWritesFencedError } from '../errors.ts';

const admissionLifetimeMs = 30 * 60 * 1000;

interface AdmissionRecord {
	readonly id: string;
}

async function acquireAdmission(
	database: D1Database
): Promise<AdmissionRecord> {
	const id = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + admissionLifetimeMs);
	const result = await database
		.prepare(
			`INSERT INTO d1_application_mutation_admission
				(id, fence_revision, expires_at, created_at)
			SELECT ?, revision, ?, ?
			FROM d1_application_mutation_fence
			WHERE id = 'application' AND state = 'open'`
		)
		.bind(id, expiresAt.toISOString(), now.toISOString())
		.run();

	if (result.meta.changes !== 1) {
		throw new AppWritesFencedError();
	}

	return { id };
}

async function releaseAdmission(
	database: D1Database,
	record: AdmissionRecord
): Promise<void> {
	await database
		.prepare('DELETE FROM d1_application_mutation_admission WHERE id = ?')
		.bind(record.id)
		.run();
}

/**
 * Holds one ordinary application-mutation admission while the operation runs.
 * The insert reads the open fence revision in the same D1 statement which
 * creates the admission row. A fence transition can therefore either close
 * before this operation starts or observe this row while it drains.
 */
export async function withAppMutationAdmission<T>(
	database: D1Database,
	operation: () => Promise<T>
): Promise<T> {
	const admission = await acquireAdmission(database);

	try {
		return await operation();
	} finally {
		await releaseAdmission(database, admission);
	}
}
