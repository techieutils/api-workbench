import { ownValue } from './own';
import { untrustedRegExp } from './regex-safety';
import type { MockPathParam, MockRule, MockValidation, MockValidationProblem } from './types';
import { describeMockRule, mockRulePasses, type MockRequestDetails } from './mocks';
import { FORMATS, isObject, typeOf, validateJsonSchema, type Schema } from './json-schema';
export { validateJsonSchema } from './json-schema';

// Request validation for mock routes: required values, and a JSON Schema for the body.

/** Why a validation schema cannot be used, or undefined when it can (or there is none). */
export function mockSchemaProblem(schema: string | undefined): string | undefined {
  if (!schema?.trim()) return undefined;
  try {
    const parsed = JSON.parse(schema) as unknown;
    return isObject(parsed) ? undefined : 'The schema must be a JSON object.';
  } catch (error) {
    return `The schema is not valid JSON: ${(error as Error).message}`;
  }
}

/** A failed check, as a requirement: "query parameter limit must be present". */
const requirement = (rule: MockRule) => describeMockRule(rule, 'must');
const enabledChecks = (validation: MockValidation) =>
  validation.checks.filter(
    (check) => check.enabled && (check.name.trim() || check.target === 'body'),
  );

/**
 * Every reason a request fails a route's validation: checks that do not pass, then a body that is
 * not JSON or does not satisfy the schema. Empty when validation is off or the request passes.
 */
export function validateMockRequest(
  validation: MockValidation | undefined,
  request: MockRequestDetails,
  params: Record<string, string> = {},
  pathParams?: readonly MockPathParam[],
  /** The route's own rules, whose query parameters count as known for `strictQuery`. */
  routeRules?: readonly MockRule[],
): MockValidationProblem[] {
  if (!validation?.enabled) return [];
  const problems: MockValidationProblem[] = validatePathParams(pathParams, params);
  const header = (name: string) => {
    const value = ownValue(request.headers, name);
    return Array.isArray(value) ? value.join(', ') : (value ?? '');
  };
  const contentType = header('content-type').split(';')[0].trim().toLowerCase();
  const allowed = allowedContentTypes(validation);
  if (
    request.body &&
    allowed.length &&
    !allowed.some((type) => contentTypeMatches(type, contentType))
  )
    problems.push({
      in: 'header',
      name: 'Content-Type',
      message: contentType
        ? `header Content-Type must be ${allowed.join(' or ')}, not ${contentType}`
        : `header Content-Type must be ${allowed.join(' or ')}`,
    });
  if (validation.maxBodyBytes !== undefined) {
    // The server reads only the first megabyte of a body; the declared length covers the rest.
    const declared = Number(header('content-length'));
    const size = Math.max(
      new TextEncoder().encode(request.body).length,
      Number.isFinite(declared) ? declared : 0,
    );
    if (size > validation.maxBodyBytes)
      problems.push({
        in: 'body',
        name: '',
        message: `body must be at most ${validation.maxBodyBytes} bytes, not ${size}`,
      });
  }
  if (validation.strictQuery) {
    const known = new Set(
      [...validation.checks, ...(routeRules ?? [])]
        .filter((rule) => rule.enabled && rule.target === 'query')
        .map((rule) => rule.name.trim()),
    );
    for (const name of new Set(request.query.keys()))
      if (!known.has(name))
        problems.push({ in: 'query', name, message: `query parameter ${name} is not allowed` });
  }
  problems.push(
    ...enabledChecks(validation)
      .filter((check) => !mockRulePasses(check, request, params))
      .map((check) => ({ in: check.target, name: check.name.trim(), message: requirement(check) })),
  );
  if (validation.schema?.trim() && !mockSchemaProblem(validation.schema)) {
    const schema = JSON.parse(validation.schema) as Schema;
    let body: unknown;
    // A form body is checked as an object of its fields, typed as the schema says.
    const form = /^application\/x-www-form-urlencoded$/.test(contentType);
    try {
      body = !request.body.trim()
        ? undefined
        : form
          ? formObject(request.body, schema)
          : JSON.parse(request.body);
    } catch {
      problems.push({ in: 'body', name: '', message: 'body must be valid JSON' });
      return problems;
    }
    if (body === undefined) problems.push({ in: 'body', name: '', message: 'body is required' });
    else
      for (const problem of validateJsonSchema(body, schema))
        problems.push({
          in: 'body',
          name: problem.path,
          message: `body${problem.path ? ` ${problem.path}` : ''} ${problem.message}`,
        });
  }
  return problems;
}

/** The content types a route accepts, lower case, without parameters. */
export const allowedContentTypes = (validation: Pick<MockValidation, 'contentTypes'>) =>
  (validation.contentTypes ?? '')
    .split(',')
    .map((type) => type.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
/** Whether a content type is allowed by one entry: exact, a family such as text/*, any, or a +json suffix. */
function contentTypeMatches(allowed: string, actual: string): boolean {
  if (allowed === '*/*' || allowed === actual) return true;
  if (allowed.endsWith('/*')) return actual.startsWith(allowed.slice(0, -1));
  // application/json also accepts application/problem+json and other +json types.
  const [type, subtype] = allowed.split('/');
  return Boolean(subtype) && actual.startsWith(`${type}/`) && actual.endsWith(`+${subtype}`);
}
/** A form body as an object, each field typed as the schema's property says. */
function formObject(body: string, schema: Schema): Record<string, unknown> {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const result: Record<string, unknown> = {};
  for (const [name, raw] of new URLSearchParams(body)) {
    const property = isObject(properties[name]) ? properties[name] : {};
    const type = String(property.type ?? '');
    const value =
      (type === 'integer' || type === 'number') && raw.trim() && Number.isFinite(Number(raw))
        ? Number(raw)
        : type === 'boolean' && (raw === 'true' || raw === 'false')
          ? raw === 'true'
          : raw;
    if (type === 'array') ((result[name] as unknown[] | undefined) ??= []).push(raw);
    else result[name] = value;
  }
  return result;
}

/** The answer's body when validation fails: the route's template, or a JSON report. */
export function validationFailureBody(
  validation: MockValidation,
  problems: MockValidationProblem[],
): string {
  const list = JSON.stringify(problems);
  if (validation.body?.trim()) return validation.body.replace(/\{\{\s*problems\s*\}\}/g, list);
  return JSON.stringify({ error: 'Request validation failed', problems }, null, 2);
}

/** A short line on what a route's validation checks, for the editor and the log. */
export function describeValidation(
  validation: MockValidation | undefined,
  pathParams?: readonly MockPathParam[],
): string {
  if (!validation?.enabled) return 'Off: every matched request is answered';
  const checks = enabledChecks(validation).length;
  const typed = (pathParams ?? []).filter(constrainsPathParam).length;
  const parts = [
    ...(typed ? [`${typed} path parameter${typed === 1 ? '' : 's'}`] : []),
    ...(checks ? [`${checks} check${checks === 1 ? '' : 's'}`] : []),
    ...(validation.schema?.trim() ? ['a body schema'] : []),
    ...(allowedContentTypes(validation).length ? ['the content type'] : []),
    ...(validation.maxBodyBytes !== undefined ? ['the body size'] : []),
    ...(validation.strictQuery ? ['unknown query parameters'] : []),
  ];
  return parts.length
    ? `${parts.join(' and ')}; failures get ${validation.status}`
    : 'On, but there is nothing to check yet';
}

/** Validation as a route first gets it: on, with nothing to check yet, answering failures with 422. */
export const newMockValidation = (): MockValidation => ({
  enabled: true,
  checks: [],
  status: 422,
});

/**
 * A JSON Schema describing a sample value: its types, every property it has as required, and
 * an array's items from its first one. A starting point to loosen by hand.
 */
export function inferJsonSchema(value: unknown, depth = 0): Schema {
  const type = typeOf(value);
  if (depth > 16) return {};
  if (type === 'object') {
    const entries = Object.entries(value as Schema);
    return {
      type: 'object',
      required: entries.map(([name]) => name),
      properties: Object.fromEntries(
        entries.map(([name, item]) => [name, inferJsonSchema(item, depth + 1)]),
      ),
    };
  }
  if (type === 'array') {
    const items = value as unknown[];
    return {
      type: 'array',
      ...(items.length ? { items: inferJsonSchema(items[0], depth + 1) } : {}),
    };
  }
  return { type };
}

const PATH_PARAM_CHECKS: Record<string, [RegExp, string]> = {
  integer: [/^-?\d+$/, 'must be an integer'],
  number: [/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/, 'must be a number'],
  boolean: [/^(true|false)$/, 'must be true or false'],
  uuid: [FORMATS.uuid, 'must be a UUID'],
  date: [FORMATS.date, 'must be a date (YYYY-MM-DD)'],
};
/** The allowed values of an `enum` path parameter, trimmed and without empty ones. */
export const pathParamValues = (param: MockPathParam) =>
  (param.values ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
/** Whether a path parameter constrains its value at all. */
export const constrainsPathParam = (param: MockPathParam) =>
  Boolean(param.type && (!['enum', 'pattern'].includes(param.type) || param.values?.trim()));
/** Why a path parameter's setup cannot be used, such as a pattern that is not a regular expression. */
export function pathParamSetupProblem(param: MockPathParam): string | undefined {
  if (param.type === 'pattern' && param.values?.trim()) {
    try {
      untrustedRegExp(param.values, 'u');
    } catch (error) {
      const message = (error as Error).message;
      return / is not allowed: /.test(message)
        ? `The pattern for ${param.name} cannot be used: ${message}`
        : `The pattern for ${param.name} is not a regular expression: ${message}`;
    }
  }
  if (param.type === 'enum' && !pathParamValues(param).length)
    return `List the values ${param.name} may take, separated by commas.`;
  return undefined;
}
/** What is wrong with a path parameter's value, or undefined when it fits. */
export function pathParamProblem(param: MockPathParam, value: string): string | undefined {
  if (!constrainsPathParam(param)) return undefined;
  const subject = `path parameter ${param.name}`;
  if (param.type === 'enum') {
    const values = pathParamValues(param);
    return values.includes(value) ? undefined : `${subject} must be one of ${values.join(', ')}`;
  }
  if (param.type === 'pattern') {
    try {
      return untrustedRegExp(param.values!, 'u').test(value)
        ? undefined
        : `${subject} must match /${param.values}/`;
    } catch {
      return undefined;
    }
  }
  const [pattern, message] = PATH_PARAM_CHECKS[param.type!] ?? [];
  return pattern && !pattern.test(value) ? `${subject} ${message}` : undefined;
}
/** Problems with a request's path parameters, against the route's parameter types. */
export function validatePathParams(
  pathParams: readonly MockPathParam[] | undefined,
  params: Record<string, string>,
): MockValidationProblem[] {
  return (pathParams ?? []).flatMap((param) => {
    const value = ownValue(params, param.name);
    if (value === undefined) return [];
    const message = pathParamProblem(param, value);
    return message ? [{ in: 'param' as const, name: param.name, message }] : [];
  });
}
