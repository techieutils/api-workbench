import { object } from './common';
import type { Obj } from './common';
/** Rehome file references into one document. Reads only the selected files. */
export function bundleSpecification(
  root: Obj,
  read: (base: string, reference: string) => { name: string; document: Obj },
  rootName: string,
  dependencies: Set<string>,
): Obj {
  const imported: Obj = {},
    targets = new Map<string, string>();
  const documents = new Map<string, Obj>([[rootName, root]]);
  const visit = (value: unknown, base: string, depth = 0): unknown => {
    if (depth > 100) throw new Error('Specification nesting exceeds 100 levels.');
    if (Array.isArray(value)) return value.map((v) => visit(v, base, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const node = object(value),
      result: Obj = {};
    for (const [key, child] of Object.entries(node))
      result[key] = key === '$ref' ? child : visit(child, base, depth + 1);
    if (typeof node.$ref !== 'string' || (base === rootName && node.$ref.startsWith('#')))
      return result;
    const [file, fragment = ''] = node.$ref.split('#');
    let targetName = base,
      document = documents.get(base)!;
    if (file) {
      const found = read(base, decodeURIComponent(file));
      targetName = found.name;
      document = found.document;
      documents.set(targetName, document);
      dependencies.add(targetName);
    }
    if (fragment && !fragment.startsWith('/'))
      throw new Error(`Unsupported reference fragment: ${node.$ref}`);
    const identity = targetName + '#' + fragment;
    let ref = targets.get(identity);
    if (!ref) {
      if (targets.size >= 1000)
        throw new Error('Specification exceeds 1,000 external reference targets.');
      const key = `reference${targets.size + 1}`;
      ref = `#/x-workbench-bundled/${key}`;
      targets.set(identity, ref);
      let target: unknown = document;
      for (const part of fragment.split('/').slice(1)) {
        const name = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, name))
          throw new Error(`Missing specification reference: ${node.$ref}`);
        target = (target as Obj)[name];
      }
      imported[key] = visit(target, targetName, depth + 1);
    }
    result.$ref = ref;
    return result;
  };
  const bundled = visit(root, rootName) as Obj;
  if (Object.keys(imported).length) bundled['x-workbench-bundled'] = imported;
  return bundled;
}
