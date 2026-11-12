<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import {
  elementCaptures,
  pageCaptures,
  selectionCapture,
  type PreviewCapture,
} from '../../composables/preview-capture';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import {
  bodyKind,
  effectiveType,
  PREVIEW_BYTE_LIMIT,
} from '@techieutils/api-workbench-common/response-body';
import { hexDump as formatHexDump } from '@techieutils/api-workbench-common/body-views';
import type { HttpResponse } from '@techieutils/api-workbench-common/types';
import { confirmAction } from '../../confirm';
import { renderMarkdown } from '../../markdown';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';

/**
 * Pretty previews of non-text response bodies: images, PDFs, audio, video, fonts, rendered HTML
 * and Markdown, and a byte view of other binary data. Media plays from a blob URL of the original
 * bytes; HTML renders in a sandbox with no scripts, and the app's content policy blocks remote loads.
 * Markdown renders into the page itself so it takes the app's styles; see markdown.ts.
 */
const props = defineProps<{
  response: HttpResponse;
  /** HTML and Markdown previews offer to capture an element or the selection (see below). */
  capture?: boolean;
  /** The request captures go to, which then opens (History); the current one otherwise. */
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled items (a deleted request). */
  captureUnavailable?: string;
}>();

const contentType = () => props.response.headers['content-type'];
function decode(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}
const bytes = computed(() =>
  props.response.bodyBase64 ? decode(props.response.bodyBase64) : undefined,
);
const kind = computed(() => bodyKind(contentType(), bytes.value?.subarray(0, 16)));
const type = computed(() => effectiveType(contentType(), bytes.value?.subarray(0, 16)));
const size = computed(() => {
  const value = props.response.size;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
});

// One blob URL per body, released when the body changes or the preview closes.
const url = ref<string>();
watch(
  bytes,
  (value) => {
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = value ? URL.createObjectURL(new Blob([value], { type: type.value })) : undefined;
  },
  { immediate: true },
);
onBeforeUnmount(() => url.value && URL.revokeObjectURL(url.value));

// Images: natural size once loaded, and fit-to-width or actual size.
const dimensions = ref('');
const actualSize = ref(false);
function onImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement;
  dimensions.value = `${image.naturalWidth} × ${image.naturalHeight}`;
}

// Fonts: loaded under a private family name from the bytes, never from a URL.
const fontFamily = ref('');
const fontError = ref('');
let loadedFont: FontFace | undefined;
watch(
  [bytes, kind],
  async ([value, current]) => {
    if (loadedFont) document.fonts.delete(loadedFont);
    loadedFont = undefined;
    fontFamily.value = '';
    fontError.value = '';
    if (current !== 'font' || !value) return;
    try {
      const family = `response-font-${Math.random().toString(36).slice(2, 8)}`;
      const face = new FontFace(family, value.slice().buffer);
      await face.load();
      document.fonts.add(face);
      loadedFont = face;
      fontFamily.value = family;
    } catch {
      fontError.value = 'This font could not be loaded.';
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => loadedFont && document.fonts.delete(loadedFont));

/** The first 256 bytes as a hex dump with an ASCII column. */
const hexDump = computed(() => (bytes.value ? formatHexDump(bytes.value.subarray(0, 256)) : ''));
/** The HTML without scripts: the sandbox would block them anyway, and log each one. */
const renderedHtml = computed(() =>
  props.response.body
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, ''),
);
const renderedMarkdown = computed(() =>
  kind.value === 'markdown' ? renderMarkdown(props.response.body) : '',
);
/**
 * A link in rendered Markdown opens in the system browser once the person confirms its address;
 * the app's window itself never navigates.
 */
async function onMarkdownClick(event: MouseEvent): Promise<void> {
  const link = (event.target as Element).closest('a');
  if (!link) return;
  event.preventDefault();
  const url = link.getAttribute('href');
  if (!url || !window.workbench?.openExternal) return;
  const confirmed = await confirmAction({
    title: url.startsWith('mailto:')
      ? 'Open this address in your mail app?'
      : 'Open this link in your browser?',
    message: url,
    confirmLabel: 'Open link',
  });
  if (confirmed) await window.workbench.openExternal(url);
}
const tooLarge = computed(
  () => !props.response.bodyBase64 && props.response.size > PREVIEW_BYTE_LIMIT,
);
// Capture: right-click an element of the HTML page, or selected text in either preview.
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();
const htmlFrame = ref<HTMLIFrameElement>();
/** What the menu offers: text to copy, and the captures for what was right-clicked. */
const offer = ref<{
  copy: string;
  element: PreviewCapture[];
  page: PreviewCapture[];
  selection?: PreviewCapture | { reason: string };
}>();
const { menu } = useContextMenu<never>();
function openMenu(anchor: HTMLElement, at: { x: number; y: number }): void {
  void nextTick(() => menu.value?.openFor(anchor, at));
}
/** The HTML page's menu: its document is the frame's own, so events arrive from inside it. */
function onFrameLoad(): void {
  const frame = htmlFrame.value;
  const document = frame?.contentDocument;
  if (!props.capture || !frame || !document) return;
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const element = event.target instanceof document.defaultView!.Element ? event.target : null;
    const selected = document.getSelection()?.toString() ?? '';
    offer.value = {
      copy: selected || (element?.textContent ?? '').trim(),
      element:
        element && element !== document.body && element !== document.documentElement
          ? elementCaptures(element)
          : [],
      page: pageCaptures(document),
      ...(selected ? { selection: selectionCapture(selected, props.response.body) } : {}),
    };
    // The pointer is relative to the frame; the menu opens relative to the window.
    const box = frame.getBoundingClientRect();
    openMenu(frame, { x: box.left + event.clientX, y: box.top + event.clientY });
  });
}
/** The Markdown preview's menu: the selection, found in the raw Markdown. */
function onMarkdownMenu(event: MouseEvent): void {
  if (!props.capture) return;
  event.preventDefault();
  const selected = window.getSelection()?.toString() ?? '';
  offer.value = {
    copy: selected,
    element: [],
    page: [],
    selection: selectionCapture(selected, props.response.body),
  };
  openMenu(event.currentTarget as HTMLElement, { x: event.clientX, y: event.clientY });
}
const menuItems = computed<MenuItem[]>(() => {
  const current = offer.value;
  if (!current) return [];
  const disabled = Boolean(props.captureUnavailable);
  const group = (captures: PreviewCapture[], heading: string, prefix: string): MenuItem[] =>
    captures.map((capture, index) => ({
      id: `${prefix}-${index}`,
      label: capture.label,
      icon: 'variable' as const,
      disabled,
      ...(index === 0 ? { heading } : {}),
    }));
  const selection = current.selection;
  return [
    { id: 'copy', label: 'Copy', icon: 'content-copy', disabled: !current.copy },
    ...(selection
      ? [
          'reason' in selection
            ? {
                id: 'selection',
                label: `Capture the selection · ${selection.reason}`,
                icon: 'variable' as const,
                disabled: true,
                heading: 'Capture into a variable',
              }
            : {
                id: 'selection',
                label: selection.label,
                icon: 'variable' as const,
                disabled,
                heading: 'Capture into a variable',
              },
        ]
      : []),
    ...group(current.element, selection ? 'This element' : 'Capture this element', 'element'),
    ...group(current.page, 'Capture from the page', 'page'),
  ];
});
async function onMenuSelect(command: string): Promise<void> {
  const current = offer.value;
  if (!current) return;
  const [kind, index] = command.split('-');
  const capture =
    command === 'selection'
      ? current.selection && !('reason' in current.selection)
        ? current.selection
        : undefined
      : kind === 'element'
        ? current.element[Number(index)]
        : kind === 'page'
          ? current.page[Number(index)]
          : undefined;
  if (capture) {
    const request = props.requestId
      ? workspace.state.requests.find((item) => item.id === props.requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((row) => row.key.trim());
    tests.addCapture(
      captureVariableName(undefined, taken, capture.name),
      capture.source,
      capture.label.split(' · ')[0].toLowerCase(),
      props.requestId,
    );
    return;
  }
  if (command !== 'copy') return;
  try {
    await navigator.clipboard.writeText(current.copy);
    toast('Copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
const labels: Record<string, string> = {
  image: 'Image',
  pdf: 'PDF document',
  audio: 'Audio',
  video: 'Video',
  font: 'Font',
  html: 'HTML page',
  markdown: 'Markdown',
  binary: 'Binary data',
};
</script>

<template>
  <div class="response-preview" :data-preview-kind="kind">
    <div class="response-preview-bar">
      <MdiIcon
        :name="
          kind === 'image'
            ? 'image-outline'
            : kind === 'pdf'
              ? 'file-pdf-box'
              : kind === 'html'
                ? 'web'
                : kind === 'markdown'
                  ? 'language-markdown-outline'
                  : kind === 'audio' || kind === 'video'
                    ? 'play-circle-outline'
                    : kind === 'font'
                      ? 'format-font'
                      : 'file-outline'
        "
      />
      <strong>{{ labels[kind] ?? 'Body' }}</strong>
      <code>{{ type }}</code>
      <span>{{ size }}</span>
      <span v-if="kind === 'image' && dimensions">{{ dimensions }}</span>
      <span class="response-preview-spacer"></span>
      <UiButton
        v-if="kind === 'image'"
        :label="actualSize ? 'Fit' : 'Actual size'"
        :icon="actualSize ? 'fit-to-page-outline' : 'magnify-plus-outline'"
        variant="ghost"
        data-preview-zoom
        @click="actualSize = !actualSize"
      />
    </div>

    <div v-if="kind === 'html'" class="response-preview-stage html">
      <!-- Never allow-scripts, so the page cannot run code. With capture, allow-same-origin lets the
      app read the page's elements and selection for the menu; the app's content policy still
      blocks remote loads and navigation. -->
      <iframe
        ref="htmlFrame"
        :sandbox="capture ? 'allow-same-origin' : ''"
        :srcdoc="renderedHtml"
        title="Rendered HTML response"
        data-html-preview
        referrerpolicy="no-referrer"
        @load="onFrameLoad"
      ></iframe>
      <p class="response-preview-note">
        <MdiIcon name="shield-lock-outline" />Scripts, styles, and remote content are blocked in
        this preview.
      </p>
    </div>
    <div v-else-if="kind === 'markdown'" class="response-preview-stage markdown">
      <!-- renderMarkdown escapes embedded HTML and drops unsafe links, so this is safe to insert. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <article
        class="markdown-preview"
        data-markdown-preview
        @click="onMarkdownClick"
        @contextmenu="onMarkdownMenu"
        v-html="renderedMarkdown"
      ></article>
    </div>
    <div v-else-if="!url" class="response-preview-stage message">
      <MdiIcon name="file-outline" />
      <p>
        {{
          tooLarge
            ? 'This body is larger than 25 MB, so it is not kept for preview. Download it, or use Raw.'
            : 'The original bytes are not available for this response. Send the request again to preview it.'
        }}
      </p>
    </div>
    <div
      v-else-if="kind === 'image'"
      :class="['response-preview-stage', 'image', { actual: actualSize }]"
    >
      <img :src="url" :alt="`Response image (${type})`" data-image-preview @load="onImageLoad" />
    </div>
    <div v-else-if="kind === 'pdf'" class="response-preview-stage pdf">
      <iframe :src="url" title="PDF response" data-pdf-preview></iframe>
    </div>
    <div v-else-if="kind === 'audio'" class="response-preview-stage media">
      <audio :src="url" controls preload="metadata" data-audio-preview></audio>
    </div>
    <div v-else-if="kind === 'video'" class="response-preview-stage media">
      <video :src="url" controls preload="metadata" data-video-preview></video>
    </div>
    <div v-else-if="kind === 'font'" class="response-preview-stage font" data-font-preview>
      <p v-if="fontError" class="form-error">{{ fontError }}</p>
      <template v-else-if="fontFamily">
        <p :style="{ fontFamily }" class="font-sample large">
          Sphinx of black quartz, judge my vow.
        </p>
        <p :style="{ fontFamily }" class="font-sample">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>
        <p :style="{ fontFamily }" class="font-sample">abcdefghijklmnopqrstuvwxyz 0123456789</p>
        <p :style="{ fontFamily }" class="font-sample small">
          The quick brown fox jumps over the lazy dog. !@#$%^&amp;*()[]{}
        </p>
      </template>
    </div>
    <div v-else class="response-preview-stage binary">
      <p>
        Binary data that cannot be shown here. Download it to open it in another app, or switch to
        Raw. The first {{ Math.min(256, bytes?.length ?? 0) }} bytes:
      </p>
      <pre data-hex-preview>{{ hexDump }}</pre>
    </div>
    <!-- After the views: placed among their v-if branches, it would split the chain. -->
    <ContextMenu
      v-if="capture"
      ref="menu"
      label="Preview actions"
      :items="menuItems"
      data-preview-menu
      @select="onMenuSelect"
    />
  </div>
</template>
