import ts from 'typescript';
// Read literals from source files without running code, imports, getters or calls.
export function parseStaticData(source:string):unknown{
 const file=ts.createSourceFile('input.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const literal=(node:ts.Expression):unknown=>{
  if(ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node))return literal(node.expression);
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  if(ts.isNumericLiteral(node))return Number(node.text);
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(node.operand))return -Number(node.operand.text);
  if(ts.isArrayLiteralExpression(node))return node.elements.map(e=>literal(e as ts.Expression));
  if(ts.isObjectLiteralExpression(node)){
   const value:Record<string,unknown>=Object.create(null);
   for(const p of node.properties){
    if(!ts.isPropertyAssignment(p)||!p.name||ts.isComputedPropertyName(p.name))throw Error('Executable or computed object member rejected');
    if(!ts.isIdentifier(p.name)&&!ts.isStringLiteral(p.name)&&!ts.isNumericLiteral(p.name))throw Error('Invalid property');
    if(['__proto__','constructor','prototype'].includes(p.name.text))throw Error('Unsafe property');
    if(Object.hasOwn(value,p.name.text))throw Error('Duplicate static key');
    value[p.name.text]=literal(p.initializer);
   }
   return value;
  }
  throw Error('Non-literal source requires manual review');
 };
 for(const statement of file.statements){
  if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations)if(d.initializer)return literal(d.initializer);
  if(ts.isExportAssignment(statement))return literal(statement.expression);
 }
 throw Error('No static data found');
}
