import {realpathSync} from 'node:fs';
import {resolve,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
export function isOutsideCheckout(checkout:string,target:string):boolean {
 const rel=relative(resolve(checkout),resolve(target));return rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel);
}
export function privateDataRoot(value?:string):string {
 if(!value)throw Error('Existing private output directory argument required');
 const root=realpathSync(resolve(value));const checkout=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
 if(!isOutsideCheckout(checkout,root))throw Error('Private output must be outside checkout');return root;
}
