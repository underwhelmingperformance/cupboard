import journal from './meta/_journal.json';
import m0000 from './0000_young_frank_castle.sql';
import m0001 from './0001_overconfident_longshot.sql';
import m0002 from './0002_clumsy_glorian.sql';
import m0003 from './0003_living_rhino.sql';
import m0004 from './0004_pink_overlord.sql';
import m0005 from './0005_add_auth_key.sql';
import m0006 from './0006_drop_token.sql';
import m0007 from './0007_signing_key_set.sql';
import m0008 from './0008_named_caches.sql';
import m0009 from './0009_narinfo_deletion_cache.sql';
import m0010 from './0010_retention_policy.sql';
import m0011 from './0011_verification_cursor.sql';
import m0012 from './0012_pending_upload_cache.sql';
import m0013 from './0013_oidc_trust.sql';
import m0014 from './0014_pending_upload_verdict.sql';
import m0015 from './0015_blob_ref_generation.sql';
import m0016 from './0016_narinfo_drop_compressed.sql';
import m0017 from './0017_drop_orphan_blob_deletion.sql';
import m0018 from './0018_tenant_identity.sql';
import m0019 from './0019_wet_frank_castle.sql';
import m0020 from './0020_large_lorna_dane.sql';
import m0021 from './0021_refresh_tokens.sql';
import m0022 from './0022_maintenance_indexes.sql';
import m0023 from './0023_more_expiry_indexes.sql';
import m0024 from './0024_pending_upload_session.sql';
import m0025 from './0025_drop_pending_upload_expected_size.sql';
import m0026 from './0026_pending_upload_claimed_at.sql';
import m0027 from './0027_grace_policy.sql';
import m0028 from './0028_retention_grace.sql';
import m0029 from './0029_pending_upload_grace_decision.sql';
import m0030 from './0030_reuse_views.sql';
import m0031 from './0031_retention_root_expiry_index.sql';
import m0032 from './0032_careful_chameleon.sql';

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
		m0005,
		m0006,
		m0007,
		m0008,
		m0009,
		m0010,
		m0011,
		m0012,
		m0013,
		m0014,
		m0015,
		m0016,
		m0017,
		m0018,
		m0019,
		m0020,
		m0021,
		m0022,
		m0023,
		m0024,
		m0025,
		m0026,
		m0027,
		m0028,
		m0029,
		m0030,
		m0031,
		m0032
	}
};
