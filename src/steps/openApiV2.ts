import { Visitor } from '@babel/traverse';
import { loopWhile } from 'deasync';
import fs from 'fs';
import { last } from 'lodash';
import { OpenAPIV2 } from 'openapi-types';
import Path from 'path';
import requestOrg from 'request';
import { dereference } from 'swagger-parser';
import { promisify } from 'util';
import { sync as rimraf } from 'rimraf';
import { isURL } from 'validator';
import { Escapin } from '..';
import * as u from '../util';
import { SyntaxError } from '../error';
import { BaseState } from '../state';

const request = promisify(requestOrg);

export default function(escapin: Escapin) {
  console.log('openApiV2');
  for (const filename in escapin.states) {
    u.traverse(visitor, new OpenApiV2State(escapin.states[filename]));
  }
}

class OpenApiV2State extends BaseState {
  constructor(base?: BaseState) {
    super(base);
    this.apis = [];
  }

  public apis: Array<{ key: u.Identifier; spec: OpenAPIV2.Document }>;

  public key(path: u.NodePath): u.Identifier | undefined {
    const foundPath = u.find(path, path => {
      return (
        path.isMemberExpression() && this.apis.some(api => u.equals(path.node.object, api.key))
      );
    });
    return foundPath ? ((foundPath.node as u.MemberExpression).object as u.Identifier) : undefined;
  }
}

const visitor: Visitor<OpenApiV2State> = {
  ImportDeclaration(path, state) {
    if (path.node.specifiers.length !== 1) {
      return;
    }
    const firstSpecifier = path.node.specifiers[0];
    if (!u.isImportDefaultSpecifier(firstSpecifier)) {
      return;
    }

    try {
      const uri = path.node.source.value;
      const spec = getApiSpec(uri, state);
      if (spec === null) {
        path.skip();
        return;
      }

      if (!u.isOpenAPIV2Document(spec)) {
        throw new Error('This API specification does not conform to OAS V2');
      }

      const variable = firstSpecifier.local;
      if (variable) {
        state.apis.push({ key: variable, spec });
        state.addDependency('request');
      }
      path.remove();
    } catch (err) {
      throw new SyntaxError(err, path.node, state);
    }
  },
  MemberExpression(path, state) {
    // GET
    const key = state.key(path);
    if (key === undefined) {
      return;
    }

    const { options, target } = createRequestOptions('GET', key, path, state);

    modifySnippets('get', path, target, options);
    path.skip();
  },
  CallExpression(path, state) {
    // POST
    const callee = path.get('callee');
    const arg0 = path.node.arguments[0];
    const key = state.key(callee);
    if (key === undefined || u.isArgumentPlaceholder(arg0) || u.isJSXNamespacedName(arg0)) {
      return;
    }
    const { options, bodyParameter } = createRequestOptions('POST', key, callee, state);

    if (u.isSpreadElement(arg0)) {
      options.properties.unshift(arg0);
    } else {
      options.properties.unshift(u.objectProperty(u.identifier(bodyParameter), arg0));
    }

    modifySnippets('post', path, path, options);
    path.skip();
  },
  AssignmentExpression(path, state) {
    // PUT
    const left = path.get('left');
    const key = state.key(left);
    if (key === undefined) {
      return;
    }
    const { options, bodyParameter } = createRequestOptions('PUT', key, left, state);

    options.properties.unshift(
      u.objectProperty(
        u.identifier(bodyParameter),
        u.expression('JSON.stringify($BODY)', {
          $BODY: path.node.right,
        }),
      ),
    );

    modifySnippets('put', path, path, options);
    path.skip();
  },
  UnaryExpression(path, state) {
    // DELETE
    const argument = path.get('argument');
    const key = state.key(argument);
    if (key === undefined || path.node.operator !== 'delete') {
      return;
    }
    const { options } = createRequestOptions('DELETE', key, argument, state);

    const stmtPath = path.findParent(path => path.isStatement());
    stmtPath.replaceWith(
      u.statement('const { $RES, $BODY } = request($OPTIONS);', {
        $BODY: path.scope.generateUidIdentifier('body'),
        $OPTIONS: options,
        $RES: path.scope.generateUidIdentifier('res'),
      }),
    );
    path.skip();
  },
};

function getApiSpec(uri: string, state: OpenApiV2State) {
  let spec = null;
  let done = false;
  let cleanupNeeded = false;
  (async () => {
    try {
      let resolved;
      if (isURL(uri)) {
        const response = await request({
          headers: {},
          method: 'GET',
          uri,
        });
        resolved = Path.join(state.escapin.config.output_dir, encodeURIComponent(uri));
        fs.writeFileSync(resolved, response.body);
        cleanupNeeded = true;
      } else {
        resolved = state.resolvePath(uri);
        if (resolved === undefined) {
          throw new Error(`${uri} not found.`);
        } else if (!fs.existsSync(resolved)) {
          throw new Error(`${resolved} not found.`);
        }
      }
      spec = await dereference(resolved);
      if (cleanupNeeded) {
        rimraf(resolved);
      }
    } catch (err) {
      if (state.hasDependency(uri)) {
        console.log(`${uri} is a module.`);
      }
      const index = uri.lastIndexOf('/');
      const actualUri = index > 0 ? uri.substring(0, uri.lastIndexOf('/')) : uri;
      if (state.hasDependency(actualUri)) {
        console.log(`${actualUri} is a module.`);
      } else if (fs.existsSync(actualUri)) {
        console.log(`${actualUri} is a local module.`);
      } else {
        throw err;
      }
    } finally {
      done = true;
    }
  })();

  loopWhile(() => !done);

  return spec;
}

function isSecuritySchemeApiKey(
  security: OpenAPIV2.SecuritySchemeObject,
): security is OpenAPIV2.SecuritySchemeApiKey {
  return security.type === 'apiKey';
}

function isSecurityOAuth2(
  security: OpenAPIV2.SecuritySchemeObject,
): security is OpenAPIV2.SecuritySchemeOauth2 {
  return security.type === 'oauth2';
}

function isReferenceObject(
  param: OpenAPIV2.ReferenceObject | OpenAPIV2.Parameter,
): param is OpenAPIV2.ReferenceObject {
  return '$ref' in param;
}

function isBase64Encoded(str: string): boolean {
  return (
    str.match(/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/) !==
    null
  );
}

function createURI(apiSpec: OpenAPIV2.Document, path: string): string {
  const scheme =
    apiSpec.schemes && Array.isArray(apiSpec.schemes) && apiSpec.schemes.includes('https')
      ? 'https'
      : 'http';
  return `${scheme}://${apiSpec.host}${apiSpec.basePath}${path}`;
}

function getContentType(
  apiSpec: OpenAPIV2.Document,
  pathSpec: OpenAPIV2.OperationObject | undefined,
) {
  if (pathSpec && pathSpec.consumes && pathSpec.consumes.length > 0) {
    return pathSpec.consumes[0];
  } else if (apiSpec.consumes && apiSpec.consumes.length > 0) {
    return apiSpec.consumes[0];
  }
  return 'application/json';
}

function getBodyParameter(contentType: string): string {
  switch (contentType) {
    case 'multipart/form-data':
      return 'formData';
    case 'application/x-www-form-urlencoded':
      return 'form';
    case 'application/json':
    default:
      return 'body';
  }
}

function createRequestOptions(
  method: string,
  key: u.Identifier,
  nodePath: u.NodePath,
  state: OpenApiV2State,
): {
  options: u.ObjectExpression;
  bodyParameter: string;
  target: u.NodePath;
} {
  try {
    const api = state.apis.find(_api => u.equals(key, _api.key));
    if (api === undefined) {
      throw new Error(`api ${key} not found.`);
    }
    const apiSpec = api.spec;

    method = method.toLowerCase();

    const {
      uri,
      contentType,
      bodyParameter,
      params,
      target: targetCandidate,
      pathSpec,
    } = identifyTargetExpression(apiSpec, nodePath, method, key);

    const target = params !== undefined ? nodePath : targetCandidate;

    let options = u.objectExpression([
      u.objectProperty(u.identifier('uri'), u.parseExpression(`\`${uri}\``)),
      u.objectProperty(u.identifier('method'), u.stringLiteral(method)),
    ]);
    if (contentType) {
      options.properties.push(
        u.objectProperty(u.identifier('contentType'), u.stringLiteral(contentType)),
      );
    }

    let headers = u.objectExpression([]);
    let qs = u.objectExpression([]);

    if (params) {
      if (
        u.isObjectExpression(params) &&
        params.properties.every(prop => u.isObjectProperty(prop))
      ) {
        for (const property of params.properties) {
          if (!u.isObjectProperty(property)) {
            throw new Error('property is not an ObjectProperty.');
          }
          if (pathSpec.parameters === undefined) {
            throw new Error('pathSpec.parameters is not an array.');
          }
          const key = (property.key as u.Identifier).name;
          const param = pathSpec.parameters.find(
            param => !isReferenceObject(param) && param.name === key,
          );
          if (param && !isReferenceObject(param)) {
            switch (param.in) {
              case 'query':
                qs.properties.push(property);
                break;
              case 'header':
                headers.properties.push(property);
                break;
              case 'path':
              default:
                break;
            }
          }
        }
      } else {
        let paramsId;
        if (u.isIdentifier(params)) {
          paramsId = params;
        } else {
          paramsId = nodePath.scope.generateUidIdentifier('param');
          nodePath.insertBefore(
            u.statement('const $PARAM = $ORG;', {
              $ORG: params,
              $PARAM: paramsId,
            }),
          );
        }
        if (pathSpec.parameters) {
          for (const param of pathSpec.parameters) {
            if (isReferenceObject(param)) {
              continue;
            }
            const key = param.name;
            switch (param.in) {
              case 'query':
                qs.properties.push(
                  u.objectProperty(
                    u.identifier(key),
                    u.memberExpression(paramsId, u.identifier(key)),
                  ),
                );
                break;
              case 'header':
                headers.properties.push(
                  u.objectProperty(
                    u.identifier(key),
                    u.memberExpression(paramsId, u.identifier(key)),
                  ),
                );
                break;
              case 'path':
              default:
                break;
            }
          }
        }
      }
    }

    if (apiSpec.security && apiSpec.securityDefinitions) {
      for (const entry of apiSpec.security) {
        const key = Object.keys(entry)[0];
        if (state.escapin.config.credentials === undefined) {
          break;
        }
        const cred = state.escapin.config.credentials.find(that => that.api === apiSpec.info.title);
        if (cred === undefined) {
          break;
        }
        if (!(key in apiSpec.securityDefinitions)) {
          continue;
        }
        const value = cred[key];
        const security = apiSpec.securityDefinitions[key];
        if (security.type === 'basic') {
          const basicCred = `Basic ${
            isBase64Encoded(value) ? value : Buffer.from(value).toString('base64')
          }`;
          headers.properties.push(
            u.objectProperty(u.identifier('authorization'), u.stringLiteral(basicCred)),
          );
        } else if (isSecuritySchemeApiKey(security)) {
          const apiKeyProp = u.objectProperty(u.identifier(security.name), u.stringLiteral(value));
          if (security.in === 'header') {
            headers.properties.push(apiKeyProp);
          } else {
            qs.properties.push(apiKeyProp);
          }
        } else if (isSecurityOAuth2(security)) {
          // do nothing
        }
      }
    }
    if (bodyParameter === 'body') {
      options.properties.push(u.objectProperty(u.identifier('json'), u.booleanLiteral(true)));
    }
    if (headers.properties.length > 0) {
      options.properties.push(u.objectProperty(u.identifier('headers'), headers));
    }
    if (qs.properties.length > 0) {
      options.properties.push(u.objectProperty(u.identifier('qs'), qs));
    }
    return { options, bodyParameter, target };
  } catch (err) {
    throw new SyntaxError(err, nodePath.node, state);
  }
}

function identifyTargetExpression(
  apiSpec: OpenAPIV2.Document,
  nodePath: u.NodePath,
  method: string,
  key: u.Identifier,
): {
  uri: string;
  contentType: string | undefined;
  bodyParameter: string;
  params: u.Node | undefined;
  target: u.NodePath;
  pathSpec: OpenAPIV2.OperationObject;
} {
  let maxMatches = 0;
  let uri: string | undefined;
  let contentType: string | undefined;
  let bodyParameter: string | undefined;
  let params: u.Node | undefined;
  let target: u.NodePath | undefined;
  let pathSpec: OpenAPIV2.OperationObject | undefined;
  const pathParamPattern = /^\{.*\}$/;

  for (const path in apiSpec.paths) {
    let newPath = path;
    let matches = 0;
    let tokens = path.split(/\/|\./).reverse();
    tokens.pop();
    const lastToken = last(tokens);
    if (lastToken && lastToken.match(pathParamPattern)) {
      tokens.push(lastToken.substring(1, lastToken.length - 1));
    }
    let failed = false;
    let iter = nodePath;
    let tempTarget: u.NodePath | undefined = undefined;
    TOKEN_LOOP: for (const token of tokens) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { node } = iter;
        if (u.isMemberExpression(node)) {
          if (node.computed && token.match(pathParamPattern)) {
            if (u.isStringLiteral(node.property)) {
              newPath = newPath.replace(token, node.property.value);
            } else {
              newPath = newPath.replace(token, '${'.concat(u.generate(node.property)).concat('}'));
            }
            if (tempTarget === undefined) {
              tempTarget = iter;
            }
            matches += 1;
            iter = iter.get('object') as u.NodePath;
            break;
          } else if (!node.computed && token === node.property.name) {
            if (tempTarget === undefined) {
              tempTarget = iter;
            }
            matches += 1;
            iter = iter.get('object') as u.NodePath;
            break;
          } else if (iter === nodePath && node.computed) {
            params = node.property;
          }
          iter = iter.get('object') as u.NodePath;
          continue;
        }
        failed = true;
        break TOKEN_LOOP;
      }
    }
    if (!failed && !Array.isArray(iter) && u.equals(iter.node, key) && matches > maxMatches) {
      if (apiSpec.paths[path][method] === undefined) {
        continue;
      }
      pathSpec = apiSpec.paths[path][method];
      uri = createURI(apiSpec, newPath);
      contentType = getContentType(apiSpec, pathSpec);
      bodyParameter = getBodyParameter(contentType);
      target = tempTarget;
      maxMatches = matches;
    }
  }
  if (
    pathSpec === undefined ||
    uri === undefined ||
    bodyParameter === undefined ||
    target === undefined
  ) {
    throw new Error('This cannot be recognized as an API request');
  }

  return {
    uri,
    contentType,
    bodyParameter,
    params,
    target,
    pathSpec,
  };
}

function modifySnippets(
  method: string,
  path: u.NodePath,
  target: u.NodePath,
  options: u.ObjectExpression,
) {
  const variable = path.scope.generateUidIdentifier(method);

  const letSnippet = u.statements('const { $RES, $BODY } = request($OPTIONS); let $VAR = $BODY', {
    $BODY: path.scope.generateUidIdentifier('body'),
    $OPTIONS: options,
    $RES: path.scope.generateUidIdentifier('res'),
    $VAR: variable,
  });

  const assignmentSnippet = u.statements(
    'const { $RES, $BODY } = request($OPTIONS); $VAR = $BODY',
    {
      $BODY: path.scope.generateUidIdentifier('body'),
      $OPTIONS: options,
      $RES: path.scope.generateUidIdentifier('res'),
      $VAR: variable,
    },
  );

  const stmtPath = path.findParent(path => path.isStatement());
  if (stmtPath.isExpressionStatement() && u.equals(stmtPath.node.expression, target.node)) {
    stmtPath.replaceWith(letSnippet[0]);
  } else if (stmtPath.isWhileStatement()) {
    stmtPath.insertBefore(letSnippet);
    const block = stmtPath.node.body as u.BlockStatement;
    block.body = [...block.body, ...assignmentSnippet];
  } else if (stmtPath.isDoWhileStatement()) {
    stmtPath.insertBefore(u.statement('let $VAR;', { $VAR: variable }));
    const block = stmtPath.node.body as u.BlockStatement;
    block.body = [...block.body, ...assignmentSnippet];
  } else {
    stmtPath.insertBefore(letSnippet);
  }
  u.replace(stmtPath, target.node, variable);
}
