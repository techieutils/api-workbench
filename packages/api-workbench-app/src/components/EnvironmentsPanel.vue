<script setup lang="ts">
import type { Environment } from '@techieutils/api-workbench-common/types';
import { computed, nextTick } from 'vue';
import { render } from '../shell';
import { action } from '../actions';
import { toast } from '../utils';
import { SENSITIVE_VARIABLE } from '../stores/environments';
import { useWorkspaceStore } from '../stores/workspace';
import type { MenuItem } from './ActionMenu.vue';
import ContextMenu from './ContextMenu.vue';
import ScrollRow from './ui/ScrollRow.vue';
import { useContextMenu } from '../composables/context-menu';
import MdiIcon from './MdiIcon.vue';
import KeyValueTable from './table/KeyValueTable.vue';
import PageHeader from './ui/PageHeader.vue';
import UiBadge from './ui/UiBadge.vue';
import UiButton from './ui/UiButton.vue';

/** Environments and their variables; the selected one is active for every request. */
const workspace = useWorkspaceStore();
// Environments are edited in place, so read them on every render rather than caching them.
const active = () => workspace.state.environments[workspace.state.environment];
const named = (environment: Environment) =>
  environment.variables.filter((variable) => variable.key).length;
const masked = () =>
  active().variables.filter((variable) => SENSITIVE_VARIABLE.test(variable.key)).length;

function select(index: number): void {
  workspace.state.environment = index;
  workspace.persist();
  render();
}
function rename(event: Event): void {
  active().name = (event.target as HTMLInputElement).value.trim() || 'Unnamed environment';
  workspace.persist();
}
function duplicate(): void {
  const source = active();
  workspace.state.environments.push({
    name: `${source.name} copy`.slice(0, 60),
    variables: structuredClone(source.variables),
  });
  workspace.state.environment = workspace.state.environments.length - 1;
  workspace.persist();
  render();
  toast(`Duplicated ${source.name}`, 'success');
}
// A row's context menu: right-click, Shift+F10, or the context menu key. Its actions work on the
// row's environment, selecting it first where the editor's own buttons act on the selected one.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<number>();
const menuItems = computed<MenuItem[]>(() => [
  {
    id: 'activate',
    label: 'Make active',
    icon: 'check-circle-outline',
    disabled: menuFor.value === workspace.state.environment,
  },
  { id: 'rename', label: 'Rename', icon: 'pencil-outline' },
  { id: 'duplicate', label: 'Duplicate', icon: 'content-copy' },
  {
    id: 'delete',
    label: 'Delete',
    icon: 'delete-outline',
    danger: true,
    separated: true,
    disabled: workspace.state.environments.length < 2,
  },
]);
function onMenuSelect(command: string): void {
  const index = menuFor.value;
  if (index === undefined || !workspace.state.environments[index]) return;
  if (index !== workspace.state.environment) select(index);
  if (command === 'rename')
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('#environment-name');
      input?.focus();
      input?.select();
    });
  else if (command === 'duplicate') duplicate();
  else if (command === 'delete') void action('delete-env');
}
function addVariable(): void {
  active().variables.push({ enabled: true, key: '', value: '' });
  workspace.persist();
  render();
}
</script>

<template>
  <section class="panel">
    <PageHeader
      eyebrow="WORKSPACE / CONFIGURATION"
      guide="environments"
      title="Environments"
      description="One collection. Every stage of development."
    >
      <UiButton label="New environment" icon="plus" variant="primary" @click="action('new-env')" />
    </PageHeader>
    <div class="environments-layout">
      <nav class="environment-list" aria-label="Environments">
        <span class="eyebrow">ENVIRONMENTS · {{ workspace.state.environments.length }}</span>
        <ScrollRow class="environment-items" noun="environments">
          <button
            v-for="(environment, index) in workspace.state.environments"
            :key="index"
            type="button"
            :class="['environment-item', { 'is-active': index === workspace.state.environment }]"
            :data-env-select="index"
            :aria-pressed="index === workspace.state.environment"
            @click="select(index)"
            @contextmenu="openMenu($event, index)"
            @keydown="onRowKeydown($event, index)"
          >
            <MdiIcon
              :name="index === workspace.state.environment ? 'layers' : 'layers-outline'"
              class="environment-item-icon"
            /><span class="environment-item-copy"
              ><strong>{{ environment.name }}</strong
              ><small
                >{{ named(environment) }} variable{{ named(environment) === 1 ? '' : 's' }}</small
              ></span
            ><UiBadge v-if="index === workspace.state.environment" label="Active" tone="success" />
          </button>
        </ScrollRow>
        <p class="field-help">The selected environment is active for every request.</p>
        <ContextMenu
          ref="contextMenu"
          label="Environment actions"
          :items="menuItems"
          data-environment-menu
          @select="onMenuSelect"
        />
      </nav>
      <div class="overview-card environment-editor">
        <div class="environment-editor-heading">
          <label class="form-field mb-0 flex-1"
            ><span>Display name</span
            ><input
              id="environment-name"
              class="field-input"
              :value="active().name"
              maxlength="60"
              aria-label="Environment name"
              @input="rename"
          /></label>
          <UiButton
            label="Duplicate"
            icon="content-copy"
            data-env-duplicate
            class="self-end"
            @click="duplicate"
          /><UiButton
            label="Delete"
            icon="delete-outline"
            variant="danger"
            data-action="delete-env"
            :disabled="workspace.state.environments.length < 2"
            class="self-end"
            @click="action('delete-env')"
          />
        </div>
        <div class="table-label">
          <div>
            <strong>Variables</strong
            ><span
              >{{ active().variables.length }} configured{{
                masked() ? ` · ${masked()} masked` : ''
              }}
              · use <code v-text="'{{name}}'"></code> in any request field</span
            >
          </div>
          <UiButton label="Add variable" icon="plus" variant="ghost" @click="addVariable" />
        </div>
        <!-- Keyed by environment, so switching never carries a draft row across. -->
        <KeyValueTable
          :key="workspace.state.environment"
          type="variables"
          :rows="() => active().variables"
        />
        <div class="info-callout">
          <MdiIcon name="shield-key-outline" /><span
            >Environment values are stored locally as plain text. Names containing secret, token,
            password, or key are masked on screen. Keep long-lived secrets in the encrypted
            credential vault.</span
          >
        </div>
      </div>
    </div>
  </section>
</template>
