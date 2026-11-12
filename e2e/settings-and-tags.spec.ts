import { expect, test } from './fixtures';

test('the colour theme changes as it is chosen', async ({ window }) => {
  await window.locator('.rail [data-view="Settings"]').click();
  await window
    .getByRole('button', { name: /Appearance/ })
    .first()
    .click();
  const html = window.locator('html');
  await window.getByRole('combobox', { name: 'theme' }).click();
  await window.getByRole('option', { name: 'Pearl' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await window.getByRole('combobox', { name: 'theme' }).click();
  await window.getByRole('option', { name: 'Navy' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('a tag added to a request filters the explorer', async ({ window }) => {
  await window.locator('[data-action=add-tag]').first().click();
  const field = window.locator('[data-tag-input]');
  await field.fill('smoke');
  await field.press('Enter');
  await expect(window.locator('[data-request-tags] [data-tag=smoke]')).toBeVisible();
  const chip = window.locator('[data-explorer-tags] [data-runner-tag=smoke]');
  await chip.click();
  await expect(chip).toHaveAttribute('data-state', 'include');
  // Only the tagged request is left in the explorer.
  await expect(window.locator('[data-request-row]')).toHaveCount(1);
  await window.locator('[data-explorer-tags] [data-action=clear-tag-filter]').click();
  await expect(chip).toHaveAttribute('data-state', 'off');
});
