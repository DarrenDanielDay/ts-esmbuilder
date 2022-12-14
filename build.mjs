#!/usr/bin/env node
/**
 * Copyright (C) 2022  DarrenDanielDay <Darren_Daniel_Day@hotmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
// @ts-check
import { existsSync } from "fs";
import { join, parse } from "path";
import rimraf from "rimraf";
import ts from "typescript";
import { promisify } from "util";
const message = "✨ Done in ";
console.time(message);
const cwd = process.cwd();
/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  throw new Error(message);
}
async function tsc() {
  /** @type {ts.ParseConfigFileHost} */
  // @ts-expect-error
  const host = ts.sys;
  //#region read tsconfig & compiler options
  const configFile = ts.findConfigFile(cwd, ts.sys.fileExists);
  if (!configFile) {
    return die("Cannot find tsconfig.json.");
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, host);
  if (!parsed) {
    return die("Invalid tsconfig file.");
  }
  //#endregion
  const { options, fileNames, projectReferences } = parsed;
  //#region AST utils
  /**
   * @template E
   * @param {Record<string, E>} obj
   * @returns {(e: Exclude<E, string>) => string}
   */
  const enumName = (obj) => {
    const mapping = Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
    return (kind) => mapping[kind];
  };
  const syntaxKindText = (() => {
    return enumName(ts.SyntaxKind);
  })();
  //#endregion

  //#region jsx utils
  const jsx = options.jsx ?? ts.JsxEmit.React;
  const hasJSXOutput = jsx === ts.JsxEmit.Preserve || jsx === ts.JsxEmit.ReactNative;
  (() => {
    if (jsx !== ts.JsxEmit.React) {
      console.warn(`compilerOptions.jsx: ${enumName(ts.JsxEmit)(jsx)}`);
    }
  })();
  /**
   * @param {string} ext extension
   */
  const ifJSX = (ext) => (hasJSXOutput ? [ext] : []);
  const jsxFactory = () =>
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier(options.reactNamespace ?? "React"),
      "createElement"
    );
  /**
   * Transform JSX element.
   * Currently only support "react".
   * @param {ts.JsxElement | ts.JsxSelfClosingElement} node jsx element node
   * @param {boolean} [pure]
   */
  const transformJSXElement = (node, pure) => {
    const element = ts.isJsxElement(node) ? node.openingElement : node;
    /** @type {readonly ts.JsxChild[]} */
    const children = ts.isJsxElement(node) ? node.children : [];
    /** @type {ts.ObjectLiteralElementLike[]} */
    const properties = element.attributes.properties.map((prop) => {
      if (ts.isJsxSpreadAttribute(prop)) {
        return ts.factory.createSpreadAssignment(prop.expression);
      }
      return ts.factory.createPropertyAssignment(prop.name, prop.initializer ?? ts.factory.createTrue());
    });
    const reactCreateElement = ts.factory.createCallExpression(jsxFactory(), undefined, [
      element.tagName,
      ts.factory.createObjectLiteralExpression(properties, true),
      ...transformJSXChildren(children, pure),
    ]);
    return pure ? wrapWithPureComment(reactCreateElement) : reactCreateElement;
  };
  /**
   * Transform JSX child element.
   * @param {ts.JsxChild} node jsx child node
   * @param {boolean} [pure]
   * @returns {ts.Expression[]}
   */
  const transformJSXChild = (node, pure) => {
    if (ts.isJsxText(node)) {
      return [ts.factory.createStringLiteral(node.text)];
    }
    if (ts.isJsxExpression(node)) {
      return node.expression ? [node.expression] : [];
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      return [transformJSXElement(node, pure)];
    }
    if (ts.isJsxFragment(node)) {
      return [transformJSXFragment(node, pure)];
    }
    // @ts-expect-error `never` type
    throw new Error(`Unknown JSX child type: ${syntaxKindText(node.kind)}`);
  };
  /**
   *
   * @param {readonly ts.JsxChild[]} children
   * @param {boolean} [pure]
   */
  const transformJSXChildren = (children, pure) => {
    const mappedChildren = children.flatMap((child) => transformJSXChild(child, pure));
    return mappedChildren.length ? mappedChildren : [ts.factory.createNull()];
  };
  /**
   * Transform JSX fragment
   * @param {ts.JsxFragment} node jsx fragment node
   * @param {boolean} [pure]
   */
  const transformJSXFragment = (node, pure) => {
    const createFragment = ts.factory.createCallExpression(jsxFactory(), [], transformJSXChildren(node.children, pure));
    return pure ? wrapWithPureComment(createFragment) : createFragment;
  };
  const pureComment = " @__PURE__ ";
  /**
   * Add ` @__PURE__ ` comment for node.
   * @template {ts.Node} T
   * @param {T} node
   */
  const wrapWithPureComment = (node) =>
    ts.addSyntheticLeadingComment(node, ts.SyntaxKind.MultiLineCommentTrivia, pureComment);
  //#endregion

  const compiler = ts.createCompilerHost(parsed.options);
  const program = ts.createProgram({
    rootNames: fileNames,
    options,
    projectReferences,
    host: compiler,
  });

  //#region custom transformer
  /** @type {ts.TransformerFactory<ts.SourceFile>} */
  const beforeFactory = (context) => {
    return (root) => {
      return ts.visitNode(root, function visit(node) {
        if (ts.isJsxElement(node)) {
          return transformJSXElement(node, true);
        }
        return ts.visitEachChild(node, visit, context);
      });
    };
  };
  /** @type {ts.TransformerFactory<ts.SourceFile>} */
  const afterFactory = (context) => {
    const keepExtensions = new Set([".js", ".cjs", ".mjs", ".jsx", ".json"]);
    return (root) => {
      const suffixes = [".ts", ...ifJSX(".tsx"), ".json", ".js", ...ifJSX(".jsx")];
      /**
       * @param {string} text
       */
      const replaceImportClauseText = (text) => {
        if (keepExtensions.has(parse(text).ext) || /^[^\.]/.test(text)) {
          return text;
        }
        for (const suffix of suffixes) {
          const possibleTarget = text + suffix;
          const possiblePath = join(parse(root.fileName).dir, possibleTarget);
          if (existsSync(possiblePath)) {
            return text + suffix.replace("t", "j");
          }
        }
        return text + ".js";
      };
      return ts.visitNode(root, function visit(node) {
        if (ts.isImportDeclaration(node)) {
          const { assertClause, importClause, modifiers, moduleSpecifier } = node;
          if (ts.isStringLiteral(moduleSpecifier)) {
            const { text } = moduleSpecifier;
            return ts.factory.createImportDeclaration(
              modifiers,
              importClause,
              ts.factory.createStringLiteral(replaceImportClauseText(text), false),
              assertClause
            );
          }
        }
        if (ts.isExportDeclaration(node)) {
          const { assertClause, exportClause, modifiers, moduleSpecifier, isTypeOnly } = node;
          if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
            const { text } = moduleSpecifier;
            return ts.factory.createExportDeclaration(
              modifiers,
              isTypeOnly,
              exportClause,
              ts.factory.createStringLiteral(replaceImportClauseText(text), false),
              assertClause
            );
          }
        }
        return ts.visitEachChild(node, visit, context);
      });
    };
  };
  //#endregion

  //#region preops: clean up
  const rm = promisify(rimraf);
  if (options.outDir) {
    await rm(options.outDir);
  }
  //#endregion

  //#region main
  const { diagnostics } = program.emit(undefined, undefined, undefined, undefined, {
    before: [beforeFactory],
    after: [afterFactory],
  });
  //#endregion

  //#region output diagnostics
  for (const diagnostic of diagnostics) {
    console.error(diagnostic.messageText);
  }
  //#endregion
}
await tsc();
console.timeEnd(message);
