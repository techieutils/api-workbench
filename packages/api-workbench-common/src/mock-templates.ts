import { ownValue } from './own';
import { dynamicValue, dynamicVariables } from './variables';

/**
 * Templates for mock response bodies: fake data like faker (`{{$randomFullName}}`), values from
 * the request (`{{params.id}}`, `{{query.page}}`, `{{headers.x-id}}`, `{{body.user.id}}`), and
 * repeated blocks for lists (`{{#repeat 3}}…{{/repeat}}`).
 */
export interface MockTemplateRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** The request body as text; `{{body.path}}` reads it as JSON. */
  body?: string;
}
export interface MockTemplateOptions {
  now?: Date;
  random?: () => number;
  uuid?: () => string;
}
export interface MockTemplateHelper {
  /** What to type, such as `{{$randomFullName}}`. */
  template: string;
  description: string;
  group: string;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];
const between = (min: number, max: number, random: () => number) =>
  Math.floor(random() * (max - min + 1)) + min;
const chars = (alphabet: string, length: number, random: () => number) =>
  Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');

const FIRST_NAMES = [
  'Alex',
  'Jordan',
  'Taylor',
  'Morgan',
  'Riley',
  'Casey',
  'Avery',
  'Quinn',
  'Sam',
  'Jamie',
  'Priya',
  'Mateo',
  'Amara',
  'Lena',
  'Kenji',
  'Noor',
];
const LAST_NAMES = [
  'Lee',
  'Patel',
  'Garcia',
  'Nguyen',
  'Kim',
  'Silva',
  'Okafor',
  'Novak',
  'Rossi',
  'Haddad',
  'Schmidt',
  'Tanaka',
  'Mensah',
  'Ivanova',
];
const COMPANY_WORDS = [
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Stark',
  'Wayne',
  'Hooli',
  'Vandelay',
  'Soylent',
  'Wonka',
  'Cyberdyne',
  'Tyrell',
];
const COMPANY_SUFFIXES = ['Inc', 'LLC', 'Group', 'Labs', 'Systems', 'Partners', 'Co'];
const JOB_TITLES = [
  'Software Engineer',
  'Product Manager',
  'Designer',
  'Data Analyst',
  'Support Specialist',
  'Account Executive',
  'Engineering Manager',
  'QA Engineer',
  'DevOps Engineer',
  'Technical Writer',
];
const STREETS = ['Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm', 'Lake', 'Hill', 'Park', 'River'];
const STREET_TYPES = ['Street', 'Avenue', 'Road', 'Lane', 'Drive', 'Way'];
const CITIES = [
  'Springfield',
  'Riverside',
  'Lisbon',
  'Osaka',
  'Austin',
  'Nairobi',
  'Toronto',
  'Berlin',
  'Melbourne',
  'Bogotá',
  'Pune',
  'Oslo',
];
const COUNTRIES: [string, string][] = [
  ['United States', 'US'],
  ['Portugal', 'PT'],
  ['Japan', 'JP'],
  ['Kenya', 'KE'],
  ['Canada', 'CA'],
  ['Germany', 'DE'],
  ['Australia', 'AU'],
  ['Colombia', 'CO'],
  ['India', 'IN'],
  ['Norway', 'NO'],
];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD', 'BRL'];
const COLORS = [
  'red',
  'green',
  'blue',
  'teal',
  'purple',
  'orange',
  'black',
  'white',
  'silver',
  'gold',
];
const ADJECTIVES = [
  'Ergonomic',
  'Rustic',
  'Sleek',
  'Smart',
  'Handcrafted',
  'Compact',
  'Durable',
  'Lightweight',
];
const MATERIALS = ['Steel', 'Wooden', 'Cotton', 'Granite', 'Bamboo', 'Leather', 'Glass', 'Rubber'];
const PRODUCTS = [
  'Chair',
  'Lamp',
  'Keyboard',
  'Backpack',
  'Bottle',
  'Watch',
  'Speaker',
  'Notebook',
];
const WORDS = [
  'alpha',
  'beacon',
  'canvas',
  'delta',
  'ember',
  'fable',
  'harbor',
  'island',
  'juniper',
  'kernel',
  'lumen',
  'meadow',
  'nimbus',
  'orbit',
  'prism',
  'quartz',
  'ripple',
  'summit',
  'tundra',
  'vertex',
  'willow',
  'zephyr',
];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'test.dev'];
const LOCALES = ['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'ja-JP', 'pt-BR', 'hi-IN'];
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const sentence = (random: () => number) => {
  const words = Array.from({ length: between(6, 12, random) }, () => pick(WORDS, random));
  return `${words.join(' ').replace(/^./, (first) => first.toUpperCase())}.`;
};
const daysFrom = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000);
const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Fake values by name. Each takes the words after the name as arguments, such as
 * `$randomInt 1 6` or `$pick small medium large`.
 */
const FAKERS: Record<
  string,
  {
    description: string;
    group: string;
    example?: string;
    make(args: string[], random: () => number, now: Date): string;
  }
> = {
  $randomInt: {
    description: 'Whole number; give a range such as 1 100',
    group: 'Numbers',
    example: '{{$randomInt 1 100}}',
    make: ([min, max], random) => {
      const low = Math.ceil(number(min, 0));
      const high = Math.floor(number(max, min === undefined ? 1000 : low + 1000));
      return String(between(Math.min(low, high), Math.max(low, high), random));
    },
  },
  $randomFloat: {
    description: 'Decimal; give a range and decimal places such as 1 10 2',
    group: 'Numbers',
    example: '{{$randomFloat 1 10 2}}',
    make: ([min, max, places], random) => {
      const low = number(min, 0);
      const high = number(max, min === undefined ? 1000 : low + 1000);
      return (low + random() * (high - low)).toFixed(Math.min(10, Math.max(0, number(places, 2))));
    },
  },
  $pick: {
    description: 'One of the words given, such as small medium large',
    group: 'Numbers',
    example: '{{$pick small medium large}}',
    make: (args, random) => (args.length ? pick(args, random) : ''),
  },
  $randomFullName: {
    description: 'First and last name',
    group: 'Person',
    make: (_, random) => `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)}`,
  },
  $randomJobTitle: {
    description: 'Job title',
    group: 'Person',
    make: (_, random) => pick(JOB_TITLES, random),
  },
  $randomPhoneNumber: {
    description: 'Phone number',
    group: 'Person',
    make: (_, random) =>
      `+1-${between(200, 989, random)}-${between(200, 999, random)}-${String(between(0, 9999, random)).padStart(4, '0')}`,
  },
  $randomPassword: {
    description: 'Password of 16 characters',
    group: 'Person',
    make: (_, random) =>
      chars('abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%', 16, random),
  },
  $randomCompanyName: {
    description: 'Company name',
    group: 'Business',
    make: (_, random) => `${pick(COMPANY_WORDS, random)} ${pick(COMPANY_SUFFIXES, random)}`,
  },
  $randomProductName: {
    description: 'Product name',
    group: 'Business',
    make: (_, random) =>
      `${pick(ADJECTIVES, random)} ${pick(MATERIALS, random)} ${pick(PRODUCTS, random)}`,
  },
  $randomPrice: {
    description: 'Price with two decimals; give a range such as 5 50',
    group: 'Business',
    example: '{{$randomPrice 5 50}}',
    make: ([min, max], random) => {
      const low = number(min, 1);
      const high = number(max, 1000);
      return (low + random() * (high - low)).toFixed(2);
    },
  },
  $randomCurrencyCode: {
    description: 'Currency code, such as EUR',
    group: 'Business',
    make: (_, random) => pick(CURRENCIES, random),
  },
  $randomStreetAddress: {
    description: 'Street address',
    group: 'Location',
    make: (_, random) =>
      `${between(1, 9999, random)} ${pick(STREETS, random)} ${pick(STREET_TYPES, random)}`,
  },
  $randomCity: {
    description: 'City',
    group: 'Location',
    make: (_, random) => pick(CITIES, random),
  },
  $randomCountry: {
    description: 'Country',
    group: 'Location',
    make: (_, random) => pick(COUNTRIES, random)[0],
  },
  $randomCountryCode: {
    description: 'Two-letter country code',
    group: 'Location',
    make: (_, random) => pick(COUNTRIES, random)[1],
  },
  $randomZipCode: {
    description: 'Five-digit postal code',
    group: 'Location',
    make: (_, random) => String(between(10000, 99999, random)),
  },
  $randomLatitude: {
    description: 'Latitude',
    group: 'Location',
    make: (_, random) => (random() * 180 - 90).toFixed(6),
  },
  $randomLongitude: {
    description: 'Longitude',
    group: 'Location',
    make: (_, random) => (random() * 360 - 180).toFixed(6),
  },
  $randomLocale: {
    description: 'Locale, such as fr-FR',
    group: 'Location',
    make: (_, random) => pick(LOCALES, random),
  },
  $randomUrl: {
    description: 'Web address',
    group: 'Internet',
    make: (_, random) => `https://${pick(DOMAINS, random)}/${pick(WORDS, random)}`,
  },
  $randomDomain: {
    description: 'Domain name',
    group: 'Internet',
    make: (_, random) => `${pick(WORDS, random)}.${pick(DOMAINS, random)}`,
  },
  $randomIPv6: {
    description: 'IPv6 address',
    group: 'Internet',
    make: (_, random) =>
      Array.from({ length: 8 }, () => chars('0123456789abcdef', 4, random)).join(':'),
  },
  $randomMac: {
    description: 'MAC address',
    group: 'Internet',
    make: (_, random) =>
      Array.from({ length: 6 }, () => chars('0123456789abcdef', 2, random)).join(':'),
  },
  $randomUserAgent: {
    description: 'Browser user agent',
    group: 'Internet',
    make: (_, random) => pick(USER_AGENTS, random),
  },
  $randomColor: {
    description: 'Colour name',
    group: 'Internet',
    make: (_, random) => pick(COLORS, random),
  },
  $randomHexColor: {
    description: 'Hex colour, such as #1a2b3c',
    group: 'Internet',
    make: (_, random) => `#${chars('0123456789abcdef', 6, random)}`,
  },
  $randomWord: { description: 'Word', group: 'Text', make: (_, random) => pick(WORDS, random) },
  $randomWords: {
    description: 'Words; give how many, such as 3',
    group: 'Text',
    example: '{{$randomWords 3}}',
    make: ([count], random) =>
      Array.from({ length: Math.min(100, Math.max(1, number(count, 3))) }, () =>
        pick(WORDS, random),
      ).join(' '),
  },
  $randomSentence: {
    description: 'Sentence',
    group: 'Text',
    make: (_, random) => sentence(random),
  },
  $randomParagraph: {
    description: 'Paragraph of a few sentences',
    group: 'Text',
    make: (_, random) =>
      Array.from({ length: between(3, 5, random) }, () => sentence(random)).join(' '),
  },
  $randomDatePast: {
    description: 'Date in the past year (ISO 8601)',
    group: 'Dates',
    make: (_, random, now) => daysFrom(now, -between(1, 365, random)).toISOString(),
  },
  $randomDateFuture: {
    description: 'Date in the next year (ISO 8601)',
    group: 'Dates',
    make: (_, random, now) => daysFrom(now, between(1, 365, random)).toISOString(),
  },
  $randomDateRecent: {
    description: 'Date in the past week (ISO 8601)',
    group: 'Dates',
    make: (_, random, now) => new Date(now.getTime() - random() * 7 * 86_400_000).toISOString(),
  },
};
const DYNAMIC_GROUPS: Record<string, string> = {
  $guid: 'Identifiers',
  $uuid: 'Identifiers',
  $randomHex: 'Identifiers',
  $randomAlphaNumeric: 'Identifiers',
  $timestamp: 'Dates',
  $timestampMs: 'Dates',
  $isoTimestamp: 'Dates',
  $isoDate: 'Dates',
  $randomInt: 'Numbers',
  $randomFloat: 'Numbers',
  $randomBoolean: 'Numbers',
  $randomEmail: 'Person',
  $randomUserName: 'Person',
  $randomFirstName: 'Person',
  $randomLastName: 'Person',
  $randomIP: 'Internet',
};

/** Every template a mock body can use, grouped, for menus and documentation. */
export const MOCK_TEMPLATE_HELPERS: MockTemplateHelper[] = [
  { template: '{{params.id}}', description: 'Path parameter, as in :id', group: 'Request' },
  { template: '{{query.page}}', description: 'Query parameter', group: 'Request' },
  { template: '{{headers.x-request-id}}', description: 'Request header', group: 'Request' },
  {
    template: '{{body.user.id}}',
    description: 'Value at a JSON path in the request body',
    group: 'Request',
  },
  ...dynamicVariables
    .filter((variable) => !FAKERS[variable.name])
    .map((variable) => ({
      template: `{{${variable.name}}}`,
      description: variable.description,
      group: DYNAMIC_GROUPS[variable.name] ?? 'Identifiers',
    })),
  ...Object.entries(FAKERS).map(([name, faker]) => ({
    template: faker.example ?? `{{${name}}}`,
    description: faker.description,
    group: faker.group,
  })),
  {
    template: '{{#repeat 3}}{"id": {{@index}}}{{/repeat}}',
    description:
      'Repeat a block, joined with commas, for lists; give a count or a range such as 2 5',
    group: 'Blocks',
  },
  { template: '{{@index}}', description: 'Position in a repeat, from 0', group: 'Blocks' },
];

/** A value at a JSON path such as `user.id`, `items[0].sku`, or `["odd key"]`. */
export function jsonPathValue(document: unknown, path: string): unknown {
  let value = document;
  for (const [, dotted, indexed, quoted] of path.matchAll(
    /\.?([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]/g,
  )) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[dotted ?? indexed ?? quoted];
  }
  return value;
}
/** The most a repeat block may repeat, and blocks nest, so a typo cannot exhaust memory. */
const REPEAT_LIMIT = 1000;
const OUTPUT_LIMIT = 5 * 1024 * 1024;

/**
 * A mock response body with its templates filled in. Unknown `{{$names}}` are left as written,
 * so a typo shows in the response; unknown request values become empty.
 */
export function renderMockTemplate(
  template: string,
  request: MockTemplateRequest,
  options: MockTemplateOptions = {},
): string {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  let parsedBody: unknown;
  let bodyParsed = false;
  const bodyValue = (path: string) => {
    if (!bodyParsed) {
      bodyParsed = true;
      try {
        parsedBody = JSON.parse(request.body ?? '');
      } catch {
        parsedBody = undefined;
      }
    }
    const value = path ? jsonPathValue(parsedBody, path) : (request.body ?? '');
    return value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  };
  const value = (expression: string, index: number | undefined): string | undefined => {
    const [name, ...args] = expression.trim().split(/\s+/);
    if (name === '@index') return index === undefined ? '' : String(index);
    const scope = /^(params|query|headers|body)\.(.*)$/.exec(name);
    if (scope) {
      const [, kind, key] = scope;
      if (kind === 'params') return ownValue(request.params, key) ?? '';
      if (kind === 'query') return request.query.get(key) ?? '';
      if (kind === 'body') return bodyValue(key);
      const header = ownValue(request.headers, key.toLowerCase());
      return Array.isArray(header) ? header.join(', ') : (header ?? '');
    }
    if (name === 'body') return bodyValue('');
    if (!name.startsWith('$')) return undefined;
    const faker = FAKERS[name];
    if (faker && (args.length || !dynamicVariables.some((variable) => variable.name === name)))
      return faker.make(args, random, now);
    return (
      dynamicValue(name, now, random, uuid) ?? (faker ? faker.make(args, random, now) : undefined)
    );
  };
  let size = 0;
  /** Fills in a piece of template, expanding repeat blocks (which may nest). */
  const render = (source: string, index: number | undefined, depth: number): string => {
    let output = '';
    let position = 0;
    const open = /\{\{#repeat(?:\s+(-?\d+)(?:\s+(-?\d+))?)?\s*\}\}/g;
    while (position < source.length) {
      open.lastIndex = position;
      const start = open.exec(source);
      const plain = source.slice(position, start ? start.index : source.length);
      output += plain.replace(
        /\{\{\s*([^{}]+?)\s*\}\}/g,
        (whole, expression: string) => value(expression, index) ?? whole,
      );
      if (!start) break;
      // Find the matching end, counting nested repeats.
      let level = 1;
      let cursor = start.index + start[0].length;
      const tags = /\{\{(#repeat\b[^}]*|\/repeat)\s*\}\}/g;
      let end: RegExpExecArray | null = null;
      tags.lastIndex = cursor;
      for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
        level += tag[1].startsWith('#') ? 1 : -1;
        if (!level) {
          end = tag;
          break;
        }
      }
      if (!end) {
        output += source.slice(start.index);
        break;
      }
      const inner = source.slice(cursor, end.index);
      const low = Number(start[1] ?? 1);
      const high = start[2] === undefined ? low : Number(start[2]);
      const count = Math.min(
        REPEAT_LIMIT,
        Math.max(0, between(Math.min(low, high), Math.max(low, high), random)),
      );
      const parts: string[] = [];
      for (let item = 0; item < count && depth < 10; item++) {
        const part = render(inner, item, depth + 1);
        size += part.length;
        if (size > OUTPUT_LIMIT) throw new Error('The template makes a body larger than 5 MB.');
        parts.push(part);
      }
      output += parts.join(',');
      cursor = end.index + end[0].length;
      position = cursor;
    }
    return output;
  };
  return render(template, undefined, 0);
}
