import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {parseStaticData} from './lib/staticData.js';
const destination=resolve(process.argv[3]!);
if(!relative(process.cwd(),destination).startsWith('..'))throw Error('Private output must be outside checkout');
writeFileSync(destination,JSON.stringify(parseStaticData(readFileSync(process.argv[2]!,'utf8'))));
