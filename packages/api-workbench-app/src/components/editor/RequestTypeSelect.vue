<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import {
  METHOD_DESCRIPTIONS,
  methodIcon,
  requestMethodClass,
  requestProtocol,
  useProtocolsStore,
} from '../../stores/protocols';
import { useWorkspaceStore } from '../../stores/workspace';
import UiSelect from '../ui/UiSelect.vue';

/**
 * What a request is, first in the URL bar: an HTTP method (REST and GraphQL), listed under HTTP,
 * or a live protocol. Choosing a method makes the request HTTP with that method; choosing a
 * protocol moves it to the live protocol editor. The box shows the method or protocol in its colour.
 */
const workspace = useWorkspaceStore();
const protocols = useProtocolsStore();
// The request is mutated in place, so read it on every render rather than caching it.
const request = () => workspace.current();
const value = () =>
  requestProtocol(request()) === 'http' ? `http:${request().method}` : requestProtocol(request());
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
const LIVE: [RequestProtocol, string, MdiIconName, string][] = [
  ['websocket', 'WebSocket', 'swap-horizontal', 'Messages both ways'],
  ['sse', 'SSE', 'access-point', 'Server-sent events'],
  ['ndjson', 'NDJSON', 'format-list-text', 'Streamed JSON lines'],
  ['grpc', 'gRPC', 'api', 'Protocol Buffers calls'],
  ['socketio', 'Socket.IO', 'lightning-bolt-outline', 'Named events both ways'],
  ['mqtt', 'MQTT', 'access-point-network', 'Publish and subscribe to topics'],
];
/** A method of the request's own, such as one imported from a file, stays listed while it uses it. */
const methods = () =>
  METHODS.includes(request().method) || requestProtocol(request()) !== 'http'
    ? METHODS
    : [...METHODS, request().method];
const options = () =>
  withIcons(
    [
      ...methods().map((method) => ({
        value: `http:${method}`,
        label: method,
        description: METHOD_DESCRIPTIONS[method],
        group: 'HTTP · REST and GraphQL',
        icon: methodIcon(method),
        attrs: { 'data-method': method, 'data-http-method': method },
      })),
      ...LIVE.map(([protocol, label, icon, description]) => ({
        value: protocol,
        label,
        description,
        group: 'Live protocols',
        icon,
        attrs: { 'data-method': protocol.toUpperCase(), 'data-request-protocol': protocol },
      })),
    ],
    OPTION_ICONS.method,
    'web',
  );
async function select(event: Event): Promise<void> {
  const chosen = (event.target as HTMLSelectElement).value;
  try {
    if (!chosen.startsWith('http:')) {
      await protocols.selectRequestProtocol(chosen as RequestProtocol);
      return;
    }
    if (requestProtocol(request()) !== 'http') await protocols.selectRequestProtocol('http');
    request().method = chosen.slice('http:'.length);
    workspace.persist();
    render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
</script>

<template>
  <UiSelect
    id="request-protocol"
    class="method-select request-type-select"
    aria-label="Request method or protocol"
    :data-method="requestMethodClass(request())"
    :root-attrs="{
      'data-method': requestMethodClass(request()),
      'data-request-type': requestProtocol(request()),
    }"
    :value="value()"
    :searchable="false"
    :options="withIcons(options(), 'web')"
    @change="void select($event)"
  />
</template>
