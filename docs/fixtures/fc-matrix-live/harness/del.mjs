import { M, deployFiles } from './lib.mjs';
const items = JSON.parse(process.argv[2]);
const d = deployFiles(M.sftkMdDestructiveFiles(items), 'delete-' + process.argv[3]);
console.log(d.ok ? 'ACCEPTED' : 'REFUSED'); for (const f of d.fails) console.log(' ', f); if (d.raw) console.log(d.raw);
