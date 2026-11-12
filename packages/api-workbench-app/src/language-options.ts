import type { SelectOption } from './components/ui/UiSelect.vue';

/** An editor language as a select option, with its icon. */
export function languageOption(language: (typeof WorkbenchEditor.languages)[number]): SelectOption {
  return { value: language.id, label: language.label, icon: language.icon };
}

/** Auto detect and every editor language, for the language select boxes beside source editors. */
export function languageOptions(): SelectOption[] {
  return [
    { value: 'auto', label: 'Auto detect', icon: 'auto-fix' },
    ...WorkbenchEditor.languages.map(languageOption),
  ];
}
