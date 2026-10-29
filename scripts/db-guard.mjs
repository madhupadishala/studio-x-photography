import {assertDevDatabase} from './db-guard-core.mjs';
try{const target=assertDevDatabase(process.env);console.log('Database target hostname: '+target.hostname+' (dev only)')}catch(error){console.error(error instanceof Error?error.message:'Database guard rejected target');process.exit(1)}
