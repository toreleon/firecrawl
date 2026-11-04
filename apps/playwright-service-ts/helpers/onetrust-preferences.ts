import type { Frame } from 'playwright';
import { Deadline, ScrapeFailure } from './scrape-control';

export type OneTrustPreferencesResult = {
  outcome: 'applied' | 'unresolved';
  phase: 'open' | 'categories' | 'save' | 'confirm';
  reason?:
    | 'unsupported_layout'
    | 'ambiguous_control'
    | 'operation_timeout'
    | 'unconfirmed';
  settingsOpened: boolean;
  categoriesFound: number;
  categoriesChanged: number;
  categoryActionsAttempted: number;
  categoryActionsCompleted: number;
  saveAttempted: boolean;
  saveCompleted: boolean;
  durationMs: number;
};

/** A native category opt-out for the standard non-TCF OneTrust preference UI. */
export const rejectOneTrustPreferences = async (
  frame: Frame,
  deadline: Deadline,
): Promise<OneTrustPreferencesResult> => {
  const started = Date.now();
  const result: OneTrustPreferencesResult = {
    outcome: 'unresolved',
    phase: 'open',
    settingsOpened: false,
    categoriesFound: 0,
    categoriesChanged: 0,
    categoryActionsAttempted: 0,
    categoryActionsCompleted: 0,
    saveAttempted: false,
    saveCompleted: false,
    durationMs: 0,
  };
  const budget = new Deadline(
    Math.min(5000, Math.max(1, deadline.remaining() - 300)),
  );
  const check = () => {
    if (deadline.remaining() <= 300)
      throw new ScrapeFailure(
        'SCRAPE_TIMEOUT',
        'Insufficient consent preference budget',
      );
    budget.remaining();
  };
  // Race only read-only requests. Their late results cannot dispatch actions.
  const read = async <T>(operation: Promise<T>): Promise<T> => {
    const value = await deadline.run(budget.run(operation));
    check();
    return value;
  };
  const nativeTimeout = () => {
    check();
    return Math.min(
      1000,
      budget.remaining(),
      Math.max(1, deadline.remaining() - 300),
    );
  };
  const panel = frame.locator('#onetrust-pc-sdk');
  const categories = panel.locator('input.category-switch-handler');
  const inspect = () =>
    categories.evaluateAll((inputs) =>
      inputs.map((element) => {
        const input = element as HTMLInputElement;
        const labels = Array.from(
          input
            .closest('#onetrust-pc-sdk')!
            .querySelectorAll('label.ot-switch'),
        ).filter((label) => (label as HTMLLabelElement).control === input);
        const rect = input.getBoundingClientRect();
        return {
          id: input.id,
          group: input.getAttribute('data-optanongroupid'),
          type: input.type,
          checked: input.checked,
          disabled: input.disabled,
          readOnly: input.readOnly,
          ariaDisabled: input.getAttribute('aria-disabled'),
          labels: labels.length,
          inputHasArea: rect.width > 0 && rect.height > 0,
        };
      }),
    );
  try {
    check();
    if ((await read(panel.count())) !== 1) {
      result.reason = 'unsupported_layout';
      return result;
    }
    if (!(await read(panel.isVisible()))) {
      let selector =
        '#onetrust-banner-sdk #onetrust-pc-btn-handler, #ot-sdk-btn.ot-sdk-show-settings, #ot-sdk-btn.optanon-show-settings';
      // This observed storefront uses its own native button instead of the
      // standard OneTrust opener. Do not generalize that selector to other sites.
      if (/(^|\.)canadagoose\.com$/.test(new URL(frame.url()).hostname))
        selector += ', button[data-cookie-settings][aria-haspopup="dialog"]';
      const opener = frame.locator(selector).filter({ visible: true });
      if ((await read(opener.count())) !== 1) {
        result.reason = 'ambiguous_control';
        return result;
      }
      await opener.click({ timeout: nativeTimeout() });
      result.settingsOpened = true;
      check();
      await panel.waitFor({ state: 'visible', timeout: nativeTimeout() });
    }
    result.phase = 'categories';
    const before = await read(inspect());
    result.categoriesFound = before.length;
    const ids = before.map((c) => c.id).sort();
    // Only the standard category layout is supported. In particular, never
    // interpret a close button or current defaults as nonessential rejection.
    const necessary = await read(
      panel
        .locator('.ot-cat-item[data-optanongroupid="C0001"] .ot-always-active')
        .count(),
    );
    if (
      necessary !== 1 ||
      before.length < 1 ||
      before.length > 16 ||
      new Set(ids).size !== ids.length ||
      before.some(
        (c) =>
          !/^ot-group-id-C\d{4}$/.test(c.id) ||
          c.group !== c.id.slice(12) ||
          c.group === 'C0001' ||
          c.type !== 'checkbox' ||
          c.disabled ||
          c.readOnly ||
          c.ariaDisabled === 'true' ||
          c.labels > 1 ||
          (!c.labels && !c.inputHasArea),
      )
    ) {
      result.reason = 'unsupported_layout';
      return result;
    }
    const save = panel.locator('button.save-preference-btn-handler');
    if ((await read(save.count())) !== 1 || !(await read(save.isVisible()))) {
      result.reason = 'ambiguous_control';
      return result;
    }
    const sameLayout = (current: Awaited<ReturnType<typeof inspect>>) =>
      current.length === before.length &&
      current
        .map((c) => c.id)
        .sort()
        .join('|') === ids.join('|') &&
      current.every(
        (c) =>
          before.some((old) => old.id === c.id && old.group === c.group) &&
          c.type === 'checkbox' &&
          !c.disabled &&
          !c.readOnly &&
          c.ariaDisabled !== 'true' &&
          c.labels <= 1 &&
          (c.labels === 1 || c.inputHasArea),
      );
    for (const category of before) {
      const current = await read(inspect());
      if (!sameLayout(current)) {
        result.reason = 'unsupported_layout';
        return result;
      }
      if (!current.find((c) => c.id === category.id)!.checked) continue;
      // OneTrust's standard CSS gives inputs zero area. Click their associated
      // visible label once and verify unchecked state; never force an input or
      // dispatch a synthetic event. Await the native operation's own timeout.
      result.categoryActionsAttempted++;
      if (current.find((c) => c.id === category.id)!.labels === 1)
        await panel
          .locator('label.ot-switch[for="' + category.id + '"]')
          .click({ timeout: nativeTimeout() });
      else
        await panel
          .locator('#' + category.id)
          .uncheck({ timeout: nativeTimeout() });
      result.categoryActionsCompleted++;
      check();
      const verified = await read(inspect());
      if (!sameLayout(verified)) {
        result.reason = 'unsupported_layout';
        return result;
      }
      if (verified.find((c) => c.id === category.id)!.checked) {
        result.reason = 'unconfirmed';
        return result;
      }
      result.categoriesChanged = before.filter(
        (old) =>
          old.checked && verified.some((c) => c.id === old.id && !c.checked),
      ).length;
    }
    const after = await read(inspect());
    if (
      !sameLayout(after) ||
      after.some((c) => c.checked) ||
      (await read(
        panel
          .locator(
            '.ot-cat-item[data-optanongroupid="C0001"] .ot-always-active',
          )
          .count(),
      )) !== 1
    ) {
      result.reason = 'unconfirmed';
      return result;
    }
    result.phase = 'save';
    result.saveAttempted = true;
    await save.click({ timeout: nativeTimeout() });
    result.saveCompleted = true;
    check();
    result.phase = 'confirm';
    await panel.waitFor({ state: 'hidden', timeout: nativeTimeout() });
    await frame
      .locator('#onetrust-banner-sdk')
      .waitFor({ state: 'hidden', timeout: nativeTimeout() });
    check();
    result.outcome = 'applied';
    return result;
  } catch (error) {
    deadline.remaining(); // Global expiry/cancellation remains terminal.
    if (
      !(
        (error instanceof ScrapeFailure && error.code === 'SCRAPE_TIMEOUT') ||
        (error instanceof Error && error.name === 'TimeoutError')
      )
    )
      throw error;
    result.reason = 'operation_timeout';
    return result;
  } finally {
    result.durationMs = Date.now() - started;
  }
};
