import { Visitor } from '@babel/traverse';
import { Escapin } from '..';
import * as u from '../util';

export default function(escapin: Escapin) {
  console.log('normalize');
  for (const filename in escapin.states) {
    u.traverse(visitor, escapin.states[filename]);
  }
}

const visitor: Visitor = {
  VariableDeclaration(path) {
    const { kind, declarations } = path.node;
    if (declarations.length === 1) {
      return;
    }
    const snippet = [];
    for (const decl of declarations) {
      snippet.push(u.variableDeclaration(kind, [decl]));
    }
    path.replaceWithMultiple(snippet);
  },
  IfStatement(path) {
    const { node } = path;
    const { consequent, alternate } = node;
    if (!u.isBlockStatement(consequent)) {
      node.consequent = u.blockStatement([consequent]);
    }
    if (alternate !== null && !u.isBlockStatement(alternate)) {
      node.alternate = u.blockStatement([alternate]);
    }
  },
  Loop(path) {
    const { node } = path;
    const { body } = node;
    if (!u.isBlockStatement(body)) {
      node.body = u.blockStatement([body]);
    }
  },
  ArrowFunctionExpression(path) {
    const { node } = path;
    const { body } = node;
    if (!u.isBlockStatement(body)) {
      node.body = u.blockStatement([u.returnStatement(body)]);
    }
  },
};
