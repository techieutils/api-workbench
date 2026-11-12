<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { vChecked } from '../../directives/checked';
import { render } from '../../shell';
import { useWorkspaceStore } from '../../stores/workspace';
import * as cookies from '@techieutils/api-workbench-common/cookies';
import { useCookiesStore } from '../../stores/cookies';
import MdiIcon from '../MdiIcon.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { toast } from '../../utils';

/** The workspace cookie jar: on/off, cookies grouped by domain, editing, and adding by hand. */
const store = useCookiesStore();
const workspace = useWorkspaceStore();
const ui = store.ui;
// These read the workspace store's state, so renders track the jar.
const jar = () => store.jar();
const enabled = () => store.enabled();
/** Every domain in the jar with its unexpired cookie count, for the domain filter. */
const domainCounts = computed(() => {
  const now = Date.now();
  const counts = new Map<string, number>();
  for (const cookie of jar())
    if (!cookies.isExpired(cookie, now))
      counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
});
const totalCount = computed(() => domainCounts.value.reduce((sum, [, count]) => sum + count, 0));
/** The chosen domain, or '' for all; a domain whose cookies are gone shows all again. */
const domainFilter = computed(() =>
  domainCounts.value.some(([domain]) => domain === ui.domain) ? ui.domain : '',
);
const visible = computed(() => {
  const now = Date.now();
  const query = ui.filter.trim().toLowerCase();
  return jar().filter(
    (cookie) =>
      !cookies.isExpired(cookie, now) &&
      (!domainFilter.value || cookie.domain === domainFilter.value) &&
      (!query || `${cookie.domain} ${cookie.name} ${cookie.path}`.toLowerCase().includes(query)),
  );
});
const domains = computed(() =>
  [...new Set(visible.value.map((cookie) => cookie.domain))].sort().map((domain) => ({
    domain,
    rows: visible.value.filter((cookie) => cookie.domain === domain),
  })),
);
function flags(cookie: StoredCookie): { label: string; tone: UITone; icon: MdiIconName }[] {
  return [
    ...(cookie.hostOnly
      ? []
      : [{ label: 'Subdomains', tone: 'neutral' as const, icon: 'file-tree-outline' as const }]),
    ...(cookie.secure
      ? [{ label: 'Secure', tone: 'success' as const, icon: 'lock-outline' as const }]
      : []),
    ...(cookie.httpOnly
      ? [{ label: 'HttpOnly', tone: 'neutral' as const, icon: 'eye-off-outline' as const }]
      : []),
    ...(cookie.sameSite
      ? [
          {
            label: `SameSite=${cookie.sameSite}`,
            tone: 'neutral' as const,
            icon: 'shield-outline' as const,
          },
        ]
      : []),
  ];
}
/** Session cookies end with the app session; dated ones show a calendar, or a struck one once past. */
const expiryIcon = (cookie: StoredCookie): MdiIconName =>
  cookie.expires === undefined
    ? 'timer-sand'
    : cookie.expires <= Date.now()
      ? 'calendar-remove'
      : 'calendar-clock';

function setEnabled(event: Event): void {
  store.setJar(jar(), (event.target as HTMLInputElement).checked);
  workspace.persist();
  render();
}
function setValue(cookie: StoredCookie, event: Event): void {
  cookie.value = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function remove(cookie: StoredCookie): void {
  store.setJar(jar().filter((item) => item !== cookie));
  workspace.persist();
  render();
}
// A cookie's context menu: edit or copy its value, copy it as a Cookie header, or delete it.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<{ cookie: StoredCookie; domain: string }>();
const menuItems = computed<MenuItem[]>(() => [
  { id: 'edit', label: 'Edit value', icon: 'pencil-outline' },
  { id: 'copy', label: 'Copy value', icon: 'content-copy' },
  { id: 'header', label: 'Copy as Cookie header', icon: 'format-header-pound' },
  { id: 'delete', label: 'Delete cookie', icon: 'delete-outline', danger: true, separated: true },
  {
    id: 'domain',
    label: `Clear cookies for ${menuFor.value?.domain ?? 'this domain'}`,
    icon: 'delete-outline',
    danger: true,
  },
]);
async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`, 'success');
  } catch {
    toast(`The ${label.toLowerCase()} could not be copied`, 'error');
  }
}
function onMenuSelect(command: string): void {
  const target = menuFor.value;
  if (!target) return;
  const { cookie, domain } = target;
  if (command === 'edit') {
    const input = document.querySelector<HTMLInputElement>(
      `[data-cookie-value="${jar().indexOf(cookie)}"]`,
    );
    input?.focus();
    input?.select();
  } else if (command === 'copy') void copy(cookie.value, 'Cookie value');
  else if (command === 'header')
    void copy(`Cookie: ${cookie.name}=${cookie.value}`, 'Cookie header');
  else if (command === 'delete') remove(cookie);
  else if (command === 'domain') void store.clear(domain);
}
function startAdding(): void {
  ui.adding = true;
  ui.error = '';
  void nextTick(() =>
    document.querySelector<HTMLInputElement>('#cookie-add-form [name=domain]')?.focus(),
  );
}
function add(event: Event): void {
  const data = new FormData(event.target as HTMLFormElement);
  const field = (name: string) => String(data.get(name) || '').trim();
  const domain = field('domain')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const header = `${field('name')}=${field('value')}; Path=${field('path') || '/'}${data.get('secure') ? '; Secure' : ''}`;
  if (!domain || !cookies.parseSetCookie(header, `https://${domain}/`)) {
    ui.error = 'Enter a valid domain and cookie name.';
    return;
  }
  store.setJar(cookies.storeCookies(jar(), [{ url: `https://${domain}/`, header }]));
  ui.adding = false;
  ui.error = '';
  workspace.persist();
  render();
}
</script>

<template>
  <section class="panel">
    <PageHeader
      eyebrow="WORKSPACE / STATE"
      guide="cookies"
      title="Cookies"
      :description="`${visible.length} cookie${visible.length === 1 ? '' : 's'} across ${domains.length} domain${domains.length === 1 ? '' : 's'} · stored in this workspace on this device.`"
    >
      <UiButton
        label="Add cookie"
        icon="plus"
        data-cookie-add
        :disabled="ui.adding"
        @click="startAdding"
      /><UiButton
        label="Clear all"
        icon="delete-outline"
        variant="danger"
        data-cookie-clear-all
        :disabled="!jar().length"
        @click="store.clear()"
      />
    </PageHeader>
    <div class="overview-card cookie-jar">
      <div class="cookie-toolbar">
        <label class="toggle-row"
          ><label class="toggle"
            ><input
              id="cookie-jar-enabled"
              v-checked="enabled()"
              role="switch"
              type="checkbox"
              aria-describedby="cookie-jar-description"
              @change="setEnabled" /><span></span></label
          ><span
            ><strong>Use cookie jar</strong
            ><small id="cookie-jar-description">{{
              enabled()
                ? 'Responses store cookies; requests send matching cookies, including across same-origin redirects.'
                : 'Cookies are neither stored nor sent. Saved cookies are kept.'
            }}</small></span
          ></label
        >
        <label class="cookie-filter"
          ><MdiIcon name="magnify" /><input
            id="cookie-filter"
            v-model="ui.filter"
            type="search"
            placeholder="Filter by domain or name"
            aria-label="Filter cookies"
            autocomplete="off"
        /></label>
      </div>
      <ScrollRow
        v-if="domainCounts.length > 1"
        class="segmented-control cookie-domain-filter"
        frame-class="cookie-domain-filter-frame"
        role="group"
        aria-label="Filter by domain"
        noun="domains"
      >
        <button
          type="button"
          data-cookie-domain-filter=""
          :aria-pressed="!domainFilter"
          :class="{ selected: !domainFilter }"
          @click="ui.domain = ''"
        >
          All<span class="history-count">{{ totalCount }}</span>
        </button>
        <button
          v-for="[domain, count] in domainCounts"
          :key="domain"
          type="button"
          :data-cookie-domain-filter="domain"
          :aria-pressed="domainFilter === domain"
          :class="{ selected: domainFilter === domain }"
          @click="ui.domain = domain"
        >
          {{ domain }}<span class="history-count">{{ count }}</span>
        </button>
      </ScrollRow>
      <form v-if="ui.adding" id="cookie-add-form" class="cookie-add-form" @submit.prevent="add">
        <label class="form-field"
          ><span>Domain</span
          ><input
            class="field-input"
            name="domain"
            required
            placeholder="api.example.com"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <label class="form-field"
          ><span>Name</span
          ><input
            class="field-input"
            name="name"
            required
            placeholder="session"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <label class="form-field"
          ><span>Value</span
          ><input
            class="field-input"
            name="value"
            placeholder="value"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <label class="form-field"
          ><span>Path</span
          ><input class="field-input" name="path" value="/" autocomplete="off" spellcheck="false"
        /></label>
        <label class="cookie-add-check"><input type="checkbox" name="secure" /> Secure</label>
        <div class="cookie-add-actions">
          <UiButton
            label="Cancel"
            variant="ghost"
            data-cookie-add-cancel
            @click="ui.adding = false"
          /><UiButton label="Add cookie" icon="plus" variant="primary" type="submit" />
        </div>
        <p v-if="ui.error" class="form-error" role="alert">{{ ui.error }}</p>
      </form>
      <section
        v-for="{ domain, rows } in domains"
        :key="domain"
        class="cookie-domain"
        :aria-label="`Cookies for ${domain}`"
      >
        <header>
          <span
            ><MdiIcon name="cookie-outline" /><strong>{{ domain }}</strong
            ><UiBadge :label="String(rows.length)" /></span
          ><UiButton
            label="Clear domain"
            icon="delete-outline"
            variant="ghost"
            :data-cookie-clear-domain="domain"
            @click="store.clear(domain)"
          />
        </header>
        <table class="cookie-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col">Path</th>
              <th scope="col">Expires</th>
              <th scope="col">Flags</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="cookie in rows"
              :key="`${cookie.name};${cookie.path}`"
              :data-cookie-row="jar().indexOf(cookie)"
              @contextmenu="openMenu($event, { cookie, domain })"
              @keydown="onRowKeydown($event, { cookie, domain })"
            >
              <th scope="row">
                <span class="cookie-name"
                  ><MdiIcon name="cookie-outline" /><code>{{ cookie.name }}</code></span
                >
              </th>
              <td>
                <input
                  class="cookie-value"
                  :value="cookie.value"
                  :data-cookie-value="jar().indexOf(cookie)"
                  :aria-label="`Value of ${cookie.name}`"
                  spellcheck="false"
                  @change="setValue(cookie, $event)"
                />
              </td>
              <td>
                <code>{{ cookie.path }}</code>
              </td>
              <td class="cookie-expiry">
                <MdiIcon :name="expiryIcon(cookie)" />{{ store.expiry(cookie) }}
              </td>
              <td class="cookie-flags">
                <UiBadge v-for="flag in flags(cookie)" :key="flag.label" v-bind="flag" />
              </td>
              <td>
                <UiIconButton
                  :label="`Delete cookie ${cookie.name}`"
                  icon="close"
                  :data-cookie-delete="jar().indexOf(cookie)"
                  @click="remove(cookie)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <ContextMenu
        ref="contextMenu"
        label="Cookie actions"
        :items="menuItems"
        data-cookie-menu
        @select="onMenuSelect"
      />
      <UiEmptyState
        v-if="!domains.length"
        icon="cookie-outline"
        :title="ui.filter.trim() ? 'No cookies match this filter' : 'The cookie jar is empty'"
        :description="
          ui.filter.trim()
            ? 'Try a different domain or cookie name.'
            : 'Cookies set by responses are stored here and sent with later requests to matching domains.'
        "
      />
      <div class="info-callout">
        <MdiIcon name="shield-key-outline" /><span
          >Cookies are stored as plain text in the local workspace file and are excluded from
          exports. A Cookie header you add to a request overrides jar cookies with the same
          name.</span
        >
      </div>
    </div>
  </section>
</template>
