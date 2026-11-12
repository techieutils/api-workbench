<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  SECRET_CAPTURE_NAME,
  captureCompletions,
  captureKind,
  checkCaptureSource,
  type CaptureKind,
} from '@techieutils/api-workbench-common/capture-completions';
import { captureTrace, type CaptureStepTrace } from '@techieutils/api-workbench-common/variables';
import type { HttpResponse } from '@techieutils/api-workbench-common/types';
import { toast } from '../../utils';
import MdiIcon from '../MdiIcon.vue';
import { closeSuggestions, openSuggestions, suggestions } from './cell-editing';

/**
 * A capture's source. The badge says what it reads; it is checked as it is typed (unknown sources
 * and transforms, invalid paths and expressions), with a fix for a likely slip; completions come
 * from the last response, grouped; and the preview shows what it captures, its type, and, for a
 * chain of transforms, the value after each step. Secret-looking values stay hidden until asked.
 */
const props = defineProps<{
  /** Unique per row. */
  id: string;
  index: number;
  value: string;
  /** The variable it saves into, for hiding a secret's preview. */
  name: string;
  response(): HttpResponse | undefined;
}>();
const emit = defineEmits<{ update: [value: string] }>();
const box = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const listOpen = computed(() => suggestions.cell === props.id);
const reveal = ref(false);
const stepsOpen = ref(false);

/** Each kind's badge: a short name and an icon. */
const KINDS: Record<CaptureKind, [string, MdiIconName]> = {
  'body-path': ['Body', 'code-json'],
  'json-path': ['JSON', 'code-json'],
  body: ['Body text', 'text'],
  header: ['Header', 'format-list-text'],
  cookie: ['Cookie', 'cookie-outline'],
  status: ['Status', 'pound-box-outline'],
  time: ['Time', 'timer-outline'],
  size: ['Size', 'numeric'],
  regex: ['Regex', 'regex'],
  between: ['Between', 'code-brackets'],
  html: ['HTML', 'language-html5'],
  form: ['Form', 'format-list-text'],
  timing: ['Timing', 'timer-outline'],
  certificate: ['TLS', 'certificate-outline'],
  error: ['Error', 'alert-circle-outline'],
  unknown: ['Source', 'help-circle-outline'],
};
const focused = ref(false);
/**
 * The check, except that while the field is being typed in and the source stops mid-way (after a
 * `.`, `[`, `|`, or a space), it is not flagged yet: it is unfinished, not wrong.
 */
const check = computed(() => {
  const result = checkCaptureSource(props.value);
  return focused.value && /[.[|\s]$/.test(props.value) ? { kind: result.kind } : result;
});
const kind = computed(() => KINDS[check.value.kind]);

function open(): void {
  const field = input.value;
  if (!field || !box.value) return;
  const text = field.value;
  const cursor = field.selectionStart ?? text.length;
  openSuggestions({
    cell: props.id,
    label: `Capture source suggestions for row ${props.index + 1}`,
    anchor: box.value,
    current: text,
    items: captureCompletions(text, props.response(), cursor).map((item) => ({
      ...item,
      // Each option shows what it reads; transforms share one icon.
      icon:
        item.group === 'Transforms'
          ? ('tune-variant' as MdiIconName)
          : KINDS[captureKind(item.value.split(' | ')[0])][1],
    })),
    choose(value) {
      closeSuggestions();
      emit('update', value);
      const end = value.length - (text.length - cursor);
      void nextTick(() => {
        field.value = value;
        field.focus();
        field.setSelectionRange(end, end);
        // A source that needs more (a path, a header name, a transform's argument) asks again.
        if (/[ .[/"]$/.test(value.slice(0, end))) open();
      });
    },
  });
}
function onInput(event: Event): void {
  emit('update', (event.target as HTMLInputElement).value);
  // A first character turns the empty last row into a real one, and the table grows; the list
  // closes on that scroll, so it opens once the layout has settled.
  requestAnimationFrame(() => requestAnimationFrame(open));
}
function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
    event.preventDefault();
    return open();
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!listOpen.value) open();
    if (!suggestions.items.length) return;
    suggestions.active =
      event.key === 'ArrowDown'
        ? (suggestions.active + 1) % suggestions.items.length
        : (suggestions.active <= 0 ? suggestions.items.length : suggestions.active) - 1;
    void nextTick(() =>
      document
        .getElementById(`kv-option-${suggestions.active}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  } else if (event.key === 'Enter' && listOpen.value && suggestions.active >= 0) {
    event.preventDefault();
    event.stopPropagation();
    suggestions.choose?.(suggestions.items[suggestions.active].value);
  } else if (event.key === 'Escape' && listOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    closeSuggestions();
  } else if (event.key === 'Tab') closeSuggestions();
}
function onBlur(): void {
  focused.value = false;
  if (listOpen.value) closeSuggestions();
}
function toggle(): void {
  input.value?.focus();
  if (listOpen.value) closeSuggestions();
  else open();
}
function applyFix(): void {
  const fix = check.value.fix;
  if (fix === undefined) return;
  emit('update', fix);
  void nextTick(() => input.value?.focus());
}

/** Each step as it ran on the last response, when the source is valid and there is one. */
const trace = computed((): CaptureStepTrace[] | undefined => {
  const source = props.value.trim();
  const response = props.response();
  if (!source || !response || check.value.problem) return undefined;
  return captureTrace(source, response);
});
const secret = computed(() => SECRET_CAPTURE_NAME.test(props.name));
const hidden = computed(() => secret.value && !reveal.value);
/** The outcome: a problem in the source, a miss on the response, or the value captured. */
const outcome = computed(() => {
  const source = props.value.trim();
  if (!source) return undefined;
  if (check.value.problem) return { tone: 'error' as const, text: check.value.problem };
  if (!props.response())
    return { tone: 'muted' as const, text: 'Send the request to preview the value' };
  if (/^error\b/.test(source))
    return { tone: 'muted' as const, text: 'Runs when the request fails; this response succeeded' };
  const steps = trace.value ?? [];
  const failed = steps.findIndex((step) => step.error);
  // A failure counts unless a later default replaced it.
  const recovered =
    failed >= 0 &&
    steps.slice(failed + 1).some((step) => step.step.startsWith('default') && !step.skipped);
  const last = steps.at(-1);
  if (!last || (failed >= 0 && !recovered))
    return {
      tone: 'warning' as const,
      text:
        steps.length > 1 && failed > 0
          ? `Step ${failed + 1} (${steps[failed].step}): ${steps[failed].error}`
          : (steps[failed]?.error ?? 'Nothing was captured'),
    };
  return { tone: 'ok' as const, text: last.value ?? '', type: last.type };
});
/** The value's kind, with its size for a list or text, for the badge beside it. */
const typeLabel = computed(() => {
  const current = outcome.value;
  if (current?.tone !== 'ok') return '';
  if (current.type === 'list')
    try {
      return `List of ${(JSON.parse(current.text) as unknown[]).length}`;
    } catch {
      return 'List';
    }
  return (
    {
      text: `Text · ${current.text.length}`,
      number: 'Number',
      boolean: 'Boolean',
      object: 'Object',
      null: 'Null',
    } as Record<string, string>
  )[current.type ?? 'text'];
});
const shown = (text: string) =>
  hidden.value
    ? `•••••• (${text.length} characters)`
    : text.length > 120
      ? `${text.slice(0, 119)}…`
      : text || '(empty)';
async function copyValue(): Promise<void> {
  const current = outcome.value;
  if (current?.tone !== 'ok') return;
  try {
    await navigator.clipboard.writeText(current.text);
    toast('Captured value copied', 'success');
  } catch {
    toast('Could not copy the value', 'error');
  }
}
</script>

<template>
  <div class="capture-source">
    <div
      ref="box"
      :class="['capture-source-box', 'has-suggestions', { 'is-invalid': check.problem }]"
    >
      <span
        v-if="value.trim()"
        class="capture-kind"
        :data-capture-kind="check.kind"
        :title="`Reads: ${kind[0]}`"
        ><MdiIcon :name="kind[1]" />{{ kind[0] }}</span
      ><input
        ref="input"
        placeholder="body.data.token or header.x-request-id"
        :aria-label="`Row ${index + 1} source`"
        :value="value"
        :data-row="index"
        data-type="captures"
        data-field="value"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        data-suggestions
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="listOpen"
        aria-controls="kv-suggestion-list"
        aria-haspopup="listbox"
        :aria-invalid="Boolean(check.problem)"
        :aria-describedby="outcome ? `${id}-preview` : undefined"
        :aria-activedescendant="
          listOpen && suggestions.active >= 0 ? `kv-option-${suggestions.active}` : undefined
        "
        @input="onInput"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="onBlur"
      /><button
        type="button"
        class="kv-suggestion-toggle"
        :aria-label="`Show source suggestions for row ${index + 1}`"
        tabindex="-1"
        @pointerdown.prevent
        @click="toggle"
      >
        <MdiIcon name="chevron-down" />
      </button>
    </div>
    <div
      v-if="outcome"
      :id="`${id}-preview`"
      :class="['capture-preview', `is-${outcome.tone}`]"
      :data-capture-preview="index"
      :role="outcome.tone === 'error' ? 'alert' : undefined"
    >
      <MdiIcon
        :name="
          outcome.tone === 'ok'
            ? 'arrow-right'
            : outcome.tone === 'error'
              ? 'close-circle-outline'
              : outcome.tone === 'warning'
                ? 'alert-outline'
                : 'information-outline'
        "
      /><span v-if="outcome.tone === 'ok' && typeLabel" class="capture-type" data-capture-type>{{
        typeLabel
      }}</span
      ><span
        class="capture-preview-text"
        :title="outcome.tone !== 'ok' || !hidden ? outcome.text : undefined"
        >{{ outcome.tone === 'ok' ? shown(outcome.text) : outcome.text }}</span
      >
      <span class="capture-preview-actions">
        <button
          v-if="check.fix !== undefined"
          type="button"
          class="text-button"
          data-capture-fix
          @click="applyFix"
        >
          {{ check.fixLabel }}
        </button>
        <template v-if="outcome.tone === 'ok'">
          <button
            v-if="secret"
            type="button"
            class="text-button"
            :aria-pressed="reveal"
            @click="reveal = !reveal"
          >
            {{ reveal ? 'Hide' : 'Show' }}
          </button>
          <button
            v-if="!hidden"
            type="button"
            class="text-button"
            :aria-label="`Copy the value captured by row ${index + 1}`"
            data-capture-copy
            @click="copyValue"
          >
            Copy
          </button>
        </template>
        <button
          v-if="trace && trace.length > 1"
          type="button"
          class="text-button"
          :aria-expanded="stepsOpen"
          :aria-controls="`${id}-steps`"
          data-capture-steps-toggle
          @click="stepsOpen = !stepsOpen"
        >
          {{ stepsOpen ? 'Hide steps' : `${trace.length} steps` }}
        </button>
      </span>
    </div>
    <ol
      v-if="stepsOpen && trace && trace.length > 1"
      :id="`${id}-steps`"
      class="capture-steps"
      aria-label="Each step’s value"
      data-capture-steps
    >
      <li
        v-for="(step, number) in trace"
        :key="number"
        :class="{ 'is-error': step.error, 'is-skipped': step.skipped }"
      >
        <span class="capture-step-number">{{ number + 1 }}</span
        ><code>{{ number ? `| ${step.step}` : step.step }}</code
        ><MdiIcon name="arrow-right" /><span class="capture-step-value">{{
          step.error ??
          (step.skipped
            ? 'Skipped'
            : `${step.type ? `${step.type} · ` : ''}${shown(step.value ?? '')}`)
        }}</span>
      </li>
    </ol>
  </div>
</template>
