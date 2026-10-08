// Client-side SQL transport for administrators using the Supabase connector.
// The only write targets are lexical tables; all data values remain JSON literals.
export const LEXICAL_TABLES=["lexical_morphemes","lexical_lexemes","lexical_senses","lexical_forms","lexical_relations"] as const;
export const GRAPH_TABLES=["lexical_etymons","lexical_etymological_links","lexical_sense_relations","lexical_usage_patterns","lexical_lexeme_morphemes"] as const;
export type LexicalTable=typeof LEXICAL_TABLES[number] | typeof GRAPH_TABLES[number];
export type DictionaryTable="lexical_dictionary_entries";
const literal=(s: string)=>`'${s.replaceAll("'","''")}'`;
export function lexicalInsertSql(table: LexicalTable | DictionaryTable,rows: Record<string,any>[]): string {
  if(!(table==="lexical_dictionary_entries" || ([...LEXICAL_TABLES,...GRAPH_TABLES] as readonly string[]).includes(table))||!rows.length)throw new Error("Invalid lexical batch");
  const columns=Object.keys(rows[0]!),pk=columns[0]!;
  if(columns.some(c=>!/^\w+$/.test(c)))throw new Error("Unsafe lexical column");
  const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b),common:Record<string,any>={},prov:Record<string,any>={};
  for(const col of columns)if(col!==pk&&col!=="provenance"&&rows.every(r=>same(r[col],rows[0]![col])))common[col]=rows[0]![col];
  if(columns.includes("provenance"))for(const [key,value] of Object.entries(rows[0]!.provenance))if(rows.every(r=>same(r.provenance[key],value)))prov[key]=value;
  const variable=columns.filter(c=>!(c in common));
  const packed=rows.map(row=>variable.map(col=>col==="provenance"?Object.fromEntries(Object.entries(row.provenance).filter(([k])=>!(k in prov))):row[col]));
  const fields=variable.flatMap((col,i)=>[literal(col),col==="provenance"?`${literal(JSON.stringify(prov))}::jsonb || (r->${i})`:`r->${i}`]).join(",");
  return `insert into public.${table} (${columns.join(",")}) select ${columns.map(c=>`t.${c}`).join(",")} from jsonb_array_elements(${literal(JSON.stringify(packed))}::jsonb) r cross join lateral jsonb_populate_record(null::public.${table},${literal(JSON.stringify(common))}::jsonb || jsonb_build_object(${fields})) t on conflict (${pk}) do update set ${columns.filter(c=>c!==pk).map(c=>`${c}=excluded.${c}`).join(",")};`;
}
