// Legacy focused callers still exercise the optional individual actions. Reveal
// their actual disclosure controls with public clicks, never DOM state injection.
// Normal-flow assertions use the same page and leave disclosures closed.
export function withPublicDisclosures(page) {
  const wrapLocator = locator => new Proxy(locator, {
    get(target, key) {
      if (['click', 'waitFor', 'fill', 'selectOption', 'check', 'uncheck'].includes(key)) return async (...args) => {
        if (key !== 'waitFor' || args[0]?.state === 'visible') {
          const section = target.locator('xpath=ancestor::section[@data-stage]');
          if (await section.count() && await section.evaluate(element => element.hidden)) {
            const stage = await section.getAttribute('data-stage');
            const tools = page.locator('#stageTools');
            if (!await tools.evaluate(element => element.open)) await tools.locator(':scope > summary').click();
            await page.locator(`[data-stage-target="${stage}"]`).click();
          }
          const ancestors = target.locator('xpath=ancestor::details');
          const summary = await target.evaluate(element => element.tagName === 'SUMMARY');
          const count = await ancestors.count() - (summary ? 1 : 0);
          for (let index = count - 1; index >= 0; index--) {
            const details = ancestors.nth(index);
            if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
          }
        }
        return target[key](...args);
      };
      if (['locator', 'first', 'last', 'nth', 'filter', 'getByRole', 'getByText', 'getByLabel'].includes(key)) {
        return (...args) => wrapLocator(target[key](...args));
      }
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  return new Proxy(page, {
    get(target, key) {
      if (['locator', 'getByRole', 'getByText', 'getByLabel'].includes(key)) return (...args) => wrapLocator(target[key](...args));
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
}
