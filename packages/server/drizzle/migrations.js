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
		m0011
	}
};
