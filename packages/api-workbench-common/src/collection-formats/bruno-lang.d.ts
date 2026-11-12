declare module '@usebruno/lang/v2/src/bruToJson' {
  const parse: (input: string) => Record<string, unknown>;
  export = parse;
}
declare module '@usebruno/lang/v2/src/jsonToBru' {
  const serialize: (input: Record<string, unknown>) => string;
  export = serialize;
}
declare module '@usebruno/lang/v2/src/envToJson' {
  const parse: (input: string) => Record<string, unknown>;
  export = parse;
}
declare module '@usebruno/lang/v2/src/jsonToEnv' {
  const serialize: (input: Record<string, unknown>) => string;
  export = serialize;
}
declare module '@usebruno/lang/v2/src/collectionBruToJson' {
  const parse: (input: string) => Record<string, unknown>;
  export = parse;
}
