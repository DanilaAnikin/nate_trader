import ts from "typescript";

/**
 * AST-based data-plane and module-edge detection for the reachability proof.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ten rounds of adversarial review found the same defect class every time: the
 * analyzer detected imports, table writes and tombstoned-routine references with
 * REGEXES OVER SOURCE TEXT. A regex cannot reliably tell a `.from(` in code from
 * one in a string or a comment, cannot pair a write held in a variable with its
 * `.from(...)`, cannot see a receiver ending in `!` or `]`, and has to count
 * specifiers to notice a dropped edge. Every one of those was a real miss.
 *
 * The TypeScript compiler answers all of them by construction: comments and
 * string literals are distinct node kinds this walk never descends into for a
 * call, an import is an ImportDeclaration whether or not another sits on the
 * same line, and a call chain is a tree, not a 300-character window. This module
 * is the single source of those judgements; reachability.mjs consumes it.
 *
 * The falsification suite (test/containment/reachability-mutants.sh) is the
 * contract: every mutation it plants must still be detected, and every green
 * control must still be clean.
 */

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
// Receivers whose `.from(...)` is ordinary library code, never a Supabase table
// select. `Array.from`, `Buffer.from`, `Date.from`-likes, collection builders.
const BUILTIN_FROM_RECEIVERS = new Set([
  "Array", "Buffer", "Object", "Date", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);

function scriptKind(fileName) {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.(mjs|cjs|js)$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
function parse(src, fileName) {
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind(fileName));
}
function walk(node, fn) {
  fn(node);
  node.forEachChild((c) => walk(c, fn));
}
function isLiteralArg(a) {
  return a && (ts.isStringLiteralLike(a));   // StringLiteral or NoSubstitutionTemplateLiteral
}
/** The member being accessed/called, and how. */
function member(expr) {
  if (ts.isPropertyAccessExpression(expr)) return { name: expr.name.text, computed: false, literalKey: true };
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    if (arg && ts.isStringLiteralLike(arg)) return { name: arg.text, computed: true, literalKey: true };
    return { name: null, computed: true, literalKey: false };
  }
  return null;
}
/** Unwrap `!`, `(...)`, `as T` so `svc!.from`, `(svc).from`, `svc as X` read
 *  through to their inner expression. */
function unwrap(e) {
  while (e && (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e))) e = e.expression;
  return e;
}
/** Does the receiver chain of a write-method call contain a `.from(...)` CALL
 *  on a non-builtin receiver? (Direct chain: `svc.from("t").delete()`.) */
function receiverChainHasFrom(expr) {
  let e = unwrap(expr);
  while (e) {
    if (ts.isCallExpression(e)) {
      const m = member(unwrap(e.expression));
      if (m && m.name === "from" && !isBuiltinFrom(unwrap(e.expression))) return true;
      e = unwrap(e.expression);
      // step past the call's own callee receiver too
      if (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) e = unwrap(e.expression);
      continue;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) { e = unwrap(e.expression); continue; }
    break;
  }
  return false;
}
function isBuiltinFrom(accessExpr) {
  // accessExpr is the `X.from` / `X["from"]` access; its receiver is .expression
  const recv = unwrap(accessExpr.expression);
  return recv && ts.isIdentifier(recv) && BUILTIN_FROM_RECEIVERS.has(recv.text);
}

/** Every static module specifier, and every dynamic import/require this file
 *  makes whose argument is not a string literal (an edge that could go
 *  anywhere). No counting: the set is exact. */
export function moduleEdges(src, fileName) {
  const sf = parse(src, fileName);
  const specifiers = [];
  const nonLiteralDynamic = [];
  walk(sf, (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specifiers.push(n.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) &&
               n.moduleReference.expression && ts.isStringLiteral(n.moduleReference.expression)) {
      specifiers.push(n.moduleReference.expression.text);
    } else if (ts.isCallExpression(n)) {
      const e = n.expression;
      const isDynImport = e.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(e) && e.text === "require";
      if (isDynImport || isRequire) {
        const arg = n.arguments[0];
        if (isLiteralArg(arg)) specifiers.push(arg.text);
        else nonLiteralDynamic.push((n.getText(sf) || "").replace(/\s+/g, " ").slice(0, 50));
      }
    }
  });
  return { specifiers, nonLiteralDynamic };
}

/** Does the file contain a string literal whose text is one of `routines`?
 *  Comments and identifiers are excluded by construction. */
export function namesForbiddenRoutine(src, fileName, routines) {
  const set = new Set(routines);
  const sf = parse(src, fileName);
  let hit = null;
  walk(sf, (n) => {
    if (hit) return;
    if (ts.isStringLiteralLike(n) && set.has(n.text)) hit = n.text;
  });
  return hit;   // the routine name, or null
}

/** Table-write and unclassifiable-data-plane findings for one module.
 *  Returns { writesTable, errors:[msg] } with messages compatible with the
 *  falsification suite's expected substrings. */
export function scanDataPlane(src, fileName, rel) {
  const sf = parse(src, fileName);
  const errors = [];
  let hasNonBuiltinFromCall = false;
  let hasWriteCall = false;

  // Names invoked as a call somewhere in the file: `NAME(...)`. A `.from`/`.rpc`
  // taken by reference or destructured is only unclassifiable if the binding is
  // actually CALLED later — `const a = params["from"]` that is merely read is an
  // ordinary record access, not a deferred data-plane call.
  const calledNames = new Set();
  walk(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (ts.isIdentifier(c)) calledNames.add(c.text);
    }
  });

  walk(sf, (n) => {
    // A property/element access to `.rpc` or `.from` that is NOT the callee of a
    // direct call: an alias, a `.bind`, a stored reference. Unclassifiable.
    if (ts.isPropertyAccessExpression(n) && (n.name.text === "rpc" || n.name.text === "from")) {
      const directlyCalled = n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n;
      if (!directlyCalled) {
        // `svc.rpc.bind(svc)` aliases it (further-accessed); `const tbl = svc.rpc`
        // binds it. Only unclassifiable if that alias/binding is actually called.
        const isFurtherAccessed = n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent));
        const boundName =
          n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null;
        const boundAndCalled = boundName !== null && calledNames.has(boundName);
        if (n.name.text === "rpc" && (isFurtherAccessed || boundAndCalled)) {
          errors.push(`${rel}: .rpc is not a direct call (alias/.bind/reference) — not a direct call, cannot be classified`);
        } else if (n.name.text === "from" && boundAndCalled) {
          errors.push(`${rel}: \`.from\` is taken by reference as \`${boundName}\` and called later — cannot be classified`);
        }
      }
    }

    if (!ts.isCallExpression(n)) return;
    const callee = unwrap(n.expression);

    // Reflect.get(x, y): a member this analyzer cannot read.
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Reflect" && callee.name.text === "get") {
      errors.push(`${rel}: Reflect.get(...) takes a member this analyzer cannot read — cannot be classified`);
    }

    const m = member(callee);
    if (!m) return;

    // A call through a computed, non-literal member: `svc[k](...)`, `svc["a"+"b"](...)`.
    if (m.computed && !m.literalKey) {
      errors.push(`${rel}: a call through a computed, non-literal member (${(n.getText(sf)||"").replace(/\s+/g," ").slice(0,40)}) — cannot be classified`);
    }

    // .rpc(...)
    if (m.name === "rpc") {
      if (m.computed && m.literalKey) {
        errors.push(`${rel}: computed access to the data-plane method rpc (${(callee.getText(sf)||"").slice(0,40)}) — cannot be classified`);
      }
      const a = n.arguments[0];
      if (!isLiteralArg(a)) {
        errors.push(`${rel}: .rpc() called with a non-literal name — cannot be classified`);
      }
    }

    // .from(...)
    if (m.name === "from") {
      const builtin = isBuiltinFrom(callee);
      if (!builtin) hasNonBuiltinFromCall = true;
    }

    // write method call
    if (m.name && WRITE_METHODS.has(m.name)) {
      hasWriteCall = true;
      // direct chain: `X.from("t").insert()` — if the .from arg is non-literal, name it
      if (receiverChainHasFrom(callee.expression)) {
        // find the from call to inspect its arg
        let e = unwrap(callee.expression);
        while (e) {
          if (ts.isCallExpression(e)) {
            const mm = member(unwrap(e.expression));
            if (mm && mm.name === "from" && !isBuiltinFrom(unwrap(e.expression))) {
              if (!isLiteralArg(e.arguments[0])) {
                errors.push(`${rel}: .from(<non-literal>) feeding .${m.name}() — the table-write rule needs a literal table name`);
              }
              break;
            }
            e = unwrap(e.expression);
            if (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) e = unwrap(e.expression);
            continue;
          }
          if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) { e = unwrap(e.expression); continue; }
          break;
        }
      }
    }

    // destructuring: `const { from } = x` / `const { rpc } = x`
    // handled below in the declaration walk
  });

  // destructured `from`/`rpc` whose binding is later called
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !n.name || !ts.isObjectBindingPattern(n.name)) return;
    for (const el of n.name.elements) {
      const prop = el.propertyName ? el.propertyName : el.name;
      const key = ts.isIdentifier(prop) ? prop.text : (ts.isStringLiteral(prop) ? prop.text : null);
      const boundName = ts.isIdentifier(el.name) ? el.name.text : null;
      if ((key === "from" || key === "rpc") && boundName && calledNames.has(boundName)) {
        errors.push(`${rel}: \`${key}\` is destructured — a later ${key}(...) call has no receiver this analyzer can read`);
      }
    }
  });

  // computed reference bound then called: `const later = svc["rpc"]; later(...)`
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !n.initializer || !n.name || !ts.isIdentifier(n.name)) return;
    const init = unwrap(n.initializer);
    const m = ts.isElementAccessExpression(init) ? member(init) : null;
    const boundName = ts.isIdentifier(n.name) ? n.name.text : null;
    // Only a COMPUTED (element-access) reference, only to a data-plane method,
    // and only when the binding is actually called later.
    if (m && (m.name === "rpc" || m.name === "from") && boundName && calledNames.has(boundName)) {
      errors.push(`${rel}: the data-plane method ${m.name} is taken by computed reference as \`${boundName}\` and called later — cannot be classified`);
    }
  });

  const writesTable = hasNonBuiltinFromCall && hasWriteCall;
  return { writesTable, errors };
}
