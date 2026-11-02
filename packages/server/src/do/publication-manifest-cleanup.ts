import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { publicationCleanupMarginMs } from '@cupboard/protocol/publication';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { sql } from 'drizzle-orm';

import { type SchemaDatabase } from './context.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

/** Tenant-local metadata maintenance. This is synchronous SQLite work only;
no portable content or private proof is a reachability seed. */
export class PublicationManifestCleanup {
	constructor(private readonly database: SchemaDatabase) {}

	private expireAdmission(now: IsoTimestamp, pageSize: number): void {
		const admission = this.database
			.all<{ id: string }>(
				sql`SELECT operation_id AS id FROM publication_manifest_admission INDEXED BY publication_manifest_admission_prune_idx WHERE prune_after <= ${now} ORDER BY prune_after, operation_id LIMIT 1`
			)
			.at(0);
		if (admission === undefined) {
			return;
		}
		const live = this.database
			.all(
				sql`SELECT 1 FROM publication_manifest_operation WHERE id = ${admission.id} LIMIT 1`
			)
			.at(0);
		if (live !== undefined) {
			return;
		}
		this.database.run(
			sql`DELETE FROM publication_manifest_operation_page WHERE operation_id = ${admission.id} AND page IN (SELECT page FROM publication_manifest_operation_page WHERE operation_id = ${admission.id} ORDER BY page LIMIT ${pageSize})`
		);
		if (
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_operation_page WHERE operation_id = ${admission.id} LIMIT 1`
				)
				.at(0) !== undefined
		) {
			return;
		}
		this.database.run(
			sql`DELETE FROM publication_manifest_work_hold WHERE operation_id = ${admission.id} AND publication_id IN (SELECT publication_id FROM publication_manifest_work_hold WHERE operation_id = ${admission.id} ORDER BY publication_id LIMIT ${pageSize})`
		);
		if (
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_work_hold WHERE operation_id = ${admission.id} LIMIT 1`
				)
				.at(0) !== undefined
		) {
			return;
		}
		this.database.run(
			sql`UPDATE garbage_collection_input SET inputs_changed = 1 WHERE cache_id = (SELECT cache_id FROM publication_manifest_admission WHERE operation_id = ${admission.id})`
		);
		this.database.run(
			sql`INSERT OR IGNORE INTO publication_manifest_retirement(materialisation_id) VALUES (${admission.id})`
		);
		this.database.run(
			sql`DELETE FROM publication_manifest_admission WHERE operation_id = ${admission.id}`
		);
	}

	private operationPruneBefore(now: IsoTimestamp): IsoTimestamp {
		// Unknown UUIDv7 requests tolerate a future clock. Retain the original
		// receipt through the existing cleanup margin (15min > 5min tolerance),
		// without moving expiresAt or permitting any recovery/retention work.
		return isoTimestamp(new Date(Date.parse(now) - publicationCleanupMarginMs));
	}

	private expireOperation(now: IsoTimestamp, pageSize: number): void {
		const operation = this.database
			.all<{ id: string; digest: string | null }>(
				sql`
			SELECT id, candidate_digest AS digest FROM publication_manifest_operation
			INDEXED BY publication_manifest_operation_expiry_idx
			WHERE expires_at <= ${this.operationPruneBefore(now)} ORDER BY expires_at, id LIMIT 1`
			)
			.at(0);
		if (operation === undefined) {
			return;
		}
		this.database
			.run(sql`UPDATE publication_manifest_operation SET state = 'expired'
			WHERE id = ${operation.id} AND state = 'pending'`);
		this.database.run(sql`DELETE FROM publication_manifest_operation_page
			WHERE operation_id = ${operation.id} AND page IN (
				SELECT page FROM publication_manifest_operation_page
				WHERE operation_id = ${operation.id} ORDER BY page LIMIT ${pageSize})`);
		if (
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_operation_page
				WHERE operation_id = ${operation.id} LIMIT 1`
				)
				.at(0) !== undefined
		) {
			return;
		}
		this.database
			.run(sql`INSERT OR IGNORE INTO publication_manifest_retirement(materialisation_id,digest)
			VALUES (${operation.id}, ${operation.digest})`);
		this.database.run(
			sql`UPDATE garbage_collection_input SET inputs_changed = 1 WHERE cache_id = (SELECT cache_id FROM publication_manifest_operation WHERE id = ${operation.id})`
		);
		this.database.run(
			sql`DELETE FROM publication_manifest_operation WHERE id = ${operation.id}`
		);
	}

	private retireMaterialisation(pageSize: number): void {
		const retired = this.database
			.all<{ id: string; digest: string | null }>(
				sql`
			SELECT materialisation_id AS id, digest FROM publication_manifest_retirement
			ORDER BY materialisation_id LIMIT 1`
			)
			.at(0);
		if (retired === undefined) {
			return;
		}
		const selected = this.database
			.all(
				sql`SELECT 1 FROM result_publication
			INDEXED BY result_publication_materialisation_idx
			WHERE materialisation_id = ${retired.id} LIMIT 1`
			)
			.at(0);
		const pending = this.database
			.all(
				sql`SELECT 1 FROM publication_manifest_operation
			WHERE id = ${retired.id} AND state = 'pending' LIMIT 1`
			)
			.at(0);
		if (selected !== undefined || pending !== undefined) {
			// The association/operation independently enqueues again when removed.
			this.removeRetirement(retired.id);
			return;
		}
		this.database.run(sql`DELETE FROM result_publication_member
			WHERE materialisation_id = ${retired.id} AND member_path IN (
				SELECT member_path FROM result_publication_member
				INDEXED BY result_publication_member_candidate_path_idx
				WHERE materialisation_id = ${retired.id} ORDER BY member_path LIMIT ${pageSize})`);
		if (
			this.database
				.all(
					sql`SELECT 1 FROM result_publication_member
				INDEXED BY result_publication_member_candidate_path_idx
				WHERE materialisation_id = ${retired.id} LIMIT 1`
				)
				.at(0) !== undefined
		) {
			return;
		}
		if (
			retired.digest !== null &&
			!this.retirePortable(retired.digest, pageSize)
		) {
			return;
		}
		this.removeRetirement(retired.id);
	}

	private retirePortable(digest: string, pageSize: number): boolean {
		const selected = this.database
			.all(
				sql`SELECT 1 FROM result_publication
			INDEXED BY result_publication_digest_idx WHERE digest = ${digest} LIMIT 1`
			)
			.at(0);
		const pending = this.database
			.all(
				sql`SELECT 1 FROM publication_manifest_operation
			INDEXED BY publication_manifest_operation_candidate_digest_idx
			WHERE candidate_digest = ${digest} AND state = 'pending' LIMIT 1`
			)
			.at(0);
		if (selected !== undefined || pending !== undefined) {
			return true;
		}
		this.database.run(sql`DELETE FROM publication_manifest_member
			WHERE digest = ${digest} AND ordinal IN (
				SELECT ordinal FROM publication_manifest_member WHERE digest = ${digest}
				ORDER BY ordinal LIMIT ${pageSize})`);
		if (
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_member WHERE digest = ${digest} LIMIT 1`
				)
				.at(0) !== undefined
		) {
			return false;
		}
		this.database.run(
			sql`DELETE FROM publication_manifest WHERE digest = ${digest}`
		);
		return true;
	}

	private removeRetirement(id: string): void {
		this.database.run(
			sql`DELETE FROM publication_manifest_retirement WHERE materialisation_id = ${id}`
		);
	}

	/**
	Indexed earliest metadata deadline; terminal receipts also expire.
	*/
	nextWake(): IsoTimestamp | undefined {
		const operation = this.database
			.all<{ at: IsoTimestamp }>(
				sql`SELECT expires_at AS at FROM publication_manifest_operation INDEXED BY publication_manifest_operation_expiry_idx ORDER BY expires_at, id LIMIT 1`
			)
			.at(0)?.at;
		const admission = this.database
			.all<{ at: IsoTimestamp }>(
				sql`SELECT prune_after AS at FROM publication_manifest_admission INDEXED BY publication_manifest_admission_prune_idx ORDER BY prune_after, operation_id LIMIT 1`
			)
			.at(0)?.at;
		const operationPruneAt =
			operation === undefined
				? undefined
				: isoTimestamp(
						new Date(Date.parse(operation) + publicationCleanupMarginMs)
					);
		return [operationPruneAt, admission]
			.filter((at) => at !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	/** Returns exact remaining work, for the existing GC alarm continuation.
	Failed receipts retain their fixed replay deadline too; the expiry index
	finds them without a catalogue-wide state scan. Each step removes at most
	one page from each child range, never a trigger-driven range cascade. */
	collect(now: IsoTimestamp, pageSize: number): boolean {
		const canDrainAvailability = !isRowBudgetExhausted();
		const availability = new PublicationManifestAvailabilityStore(
			this.database
		);
		if (
			canDrainAvailability &&
			(availability.nextIntent(false) !== undefined ||
				availability.nextLifecycleIntent() !== undefined)
		) {
			availability.drain();
			if (isRowBudgetExhausted()) {
				return this.hasWork(now);
			}
		}
		for (;;) {
			this.database.transaction(() => {
				this.expireOperation(now, pageSize);
				this.expireAdmission(now, pageSize);
				this.retireMaterialisation(pageSize);
			});
			const hasMore = this.hasWork(now);
			if (!hasMore || isRowBudgetExhausted()) {
				return hasMore;
			}
		}
	}

	/**
    Includes retirements enqueued by the reachability phase of this pass.
    */
	hasWork(now: IsoTimestamp): boolean {
		const availability = new PublicationManifestAvailabilityStore(
			this.database
		);
		return (
			availability.nextIntent(false) !== undefined ||
			availability.nextLifecycleIntent() !== undefined ||
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_admission INDEXED BY publication_manifest_admission_prune_idx WHERE prune_after <= ${now} LIMIT 1`
				)
				.at(0) !== undefined ||
			this.database
				.all(sql`SELECT 1 FROM publication_manifest_retirement LIMIT 1`)
				.at(0) !== undefined ||
			this.database
				.all(
					sql`SELECT 1 FROM publication_manifest_operation
				INDEXED BY publication_manifest_operation_expiry_idx
				WHERE expires_at <= ${this.operationPruneBefore(now)} LIMIT 1`
				)
				.at(0) !== undefined
		);
	}
}
