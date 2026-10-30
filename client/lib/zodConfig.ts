/**
 * Imported first by main.tsx, before any schema module is evaluated: zod's JIT probes
 * `new Function('')` when each object schema is created, which the production
 * Content-Security-Policy (`script-src 'self'`, no eval) blocks and reports as a violation.
 * Jitless parsing is plenty fast for our forms.
 */
import { z } from 'zod';

z.config({ jitless: true });
