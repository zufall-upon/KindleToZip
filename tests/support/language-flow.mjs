import assert from 'node:assert/strict';

// Called by the ordinary UI runner and by the hash-bound packaged companion.
// All interactions target the owned app's public controls, never official Kindle.
export async function checkLanguageFlow(page, screenshot) {
  const result = [];
  const draft = 'M:\\匿名画像\\原本 右ページ.zip';
  await page.locator('[data-stage-target="export"]').first().click();
  await page.locator('#destination').fill(draft);
  const before = await page.locator('#counts').textContent();
  for (const [language, next, unknown, title, cancel, remaining] of [
    ['en', 'Confirm / Next', 'Percentage unknown', 'Reset captured images?', 'Cancel', 'Remaining unknown'],
    ['zh-CN', '确定／下一步', '百分比未确定', '重置已获取的图像？', '取消', '剩余未知'],
    ['ja', '決定・次へ', '割合未確定', '取得画像をリセットしますか？', 'キャンセル', '残り不明'],
  ]) {
    await page.locator('#language').selectOption(language);
    await page.waitForFunction(lang => document.documentElement.lang === lang, language);
    assert.equal(await page.locator('#decisionButton').textContent(), next);
    assert.equal(await page.locator('#destination').inputValue(), draft);
    assert.ok(await page.locator('#decisionButton').isVisible());
    await page.locator('#cancelBackButton').click();
    await page.locator('#resetDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#resetTitle').textContent(), title);
    assert.equal(await page.locator('#resetCancel').textContent(), cancel);
    assert.equal(await page.locator('#operationPercent').textContent(), unknown);
    assert.ok((await page.locator('#operationDetail').textContent()).includes(remaining));
    assert.equal(await page.locator('#operationBar').getAttribute('aria-valuenow'), null);
    if (language !== 'ja') {
      const leftovers = await page.evaluate(language => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const found = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.parentElement.closest('script, style, .language-selector, #preset, #presetName, #jobPath, #connection, #issues')) continue;
          if ((language === 'en' ? /[ぁ-んァ-ヶ\u3400-\u9fff]/ : /[ぁ-んァ-ヶ]/).test(node.data)) found.push(node.data.trim());
        }
        return found.filter(Boolean);
      }, language);
      assert.deepEqual(leftovers, [], `${language}: untranslated UI copy`);
    }
    await screenshot?.(`language-${language}-reset.png`);
    await page.locator('#resetCancel').click();
    await page.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
    assert.equal(await page.locator('#destination').inputValue(), draft);
    result.push({ language, next, resetTitle: title, unknownProgress: true, draftPreserved: true });
  }
  assert.equal(await page.locator('#counts').textContent(), before);
  return result;
}
