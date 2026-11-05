import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';

import { uploadDiagnostics } from '../diagnostics/upload.ts';

configureConnectionAttempts();

void uploadDiagnostics();
