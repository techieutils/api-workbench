<script setup lang="ts">
import { computed } from 'vue';
import { errorMessage, toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useProtocolsStore } from '../../stores/protocols';
import SourceEditor from '../SourceEditor.vue';
import UiButton from '../ui/UiButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
const protocols = useProtocolsStore();
const workspace = useWorkspaceStore();

/** The self-contained Protocol Buffers schema for a gRPC request, and method discovery. */
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const wrap = computed(() => workspace.settings().wordWrap);
const report = (operation: () => unknown) =>
  Promise.resolve()
    .then(operation)
    .catch((error) => toast(errorMessage(error), 'error'));

function setSchema(value: string): void {
  (request().grpc ||= { proto: '', method: '', tls: false }).proto = value;
  workspace.persist();
}
function discover(): void {
  void report(() => protocols.discoverProtoMethods());
}
function importFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void report(() => protocols.importProtoFile(file));
}
</script>

<template>
  <div class="protocol-schema-panel">
    <div class="protocol-config-toolbar">
      <span class="field-help">Self-contained Protocol Buffers schema</span>
      <ScrollRow class="protocol-schema-actions" frame-class="protocol-toolbar-frame" noun="tools">
        <label class="ui-button ui-button-secondary"
          >Import .proto<input
            id="grpc-proto-file"
            type="file"
            accept=".proto,text/plain"
            hidden
            @change="importFile"
        /></label>
        <UiButton
          label="Discover methods"
          icon="magnify"
          data-protocol-discover
          @click="discover"
        />
      </ScrollRow>
    </div>
    <!-- Kept for scripts and assistive tools that set the schema as plain text. -->
    <textarea
      id="grpc-proto"
      hidden
      aria-label="Protocol Buffers schema"
      :value="request().grpc?.proto || ''"
      @input="setSchema(($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <SourceEditor
      id="protocol-schema-editor"
      class="protocol-source-editor"
      :value="request().grpc?.proto || ''"
      language="protobuf"
      :wrap="wrap"
      label="Protocol Buffers schema editor"
      context-menu
      @change="setSchema"
    />
  </div>
</template>
