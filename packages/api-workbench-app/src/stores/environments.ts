import { defineStore } from 'pinia';
import { reactive } from 'vue';

/** Variable names that usually hold secrets; their values are masked until revealed. */
export const SENSITIVE_VARIABLE = /secret|token|password|passwd|api[-_]?key|credential|private/i;

/** Masked environment values revealed on screen, by environment index and variable name. */
export const useEnvironmentsStore = defineStore('environments', () => {
  const revealed = reactive(new Set<string>());
  const revealKey = (environment: number, key: string) => `${environment}:${key}`;
  function toggleReveal(environment: number, key: string): void {
    const id = revealKey(environment, key);
    if (revealed.has(id)) revealed.delete(id);
    else revealed.add(id);
  }
  const isRevealed = (environment: number, key: string) =>
    revealed.has(revealKey(environment, key));
  return { revealed, toggleReveal, isRevealed };
});
