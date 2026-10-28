// Presentation-only localization. Canonical Japanese text is retained separately
// from the DOM so switching language never changes a draft, approval or command.
import { translateCopy } from './messages.mjs';
const languages = ['ja', 'en', 'zh-CN'];
let language = 'ja';
try { language = localStorage.getItem('ktzLanguage') ?? 'ja'; } catch { /* Storage is optional. */ }
if (!languages.includes(language)) language = 'ja';
const originals = new WeakMap();
export function canonicalText(element) {
  return [...element.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? originals.get(node) ?? node.data : canonicalText(node)).join('');
}
export function translate(value) {
  return translateCopy(value, language);
}
export const currentLanguage = () => language;
export function installLanguageSelector() {
  const label = document.createElement('label');
  label.className = 'language-selector';
  label.textContent = '言語 / Language / 语言 ';
  const select = document.createElement('select');
  select.id = 'language'; select.setAttribute('aria-label', '言語 / Language / 语言');
  for (const [value, text] of [['ja', '日本語'], ['en', 'English'], ['zh-CN', '简体中文']]) select.add(new Option(text, value));
  select.value = language; label.append(select); document.querySelector('header').prepend(label);
  const attributes = new WeakMap();
  const excluded = node => node.parentElement?.closest('script, style, .language-selector, #preset, #presetName');
  function localizeText(node, changed = false) {
    if (excluded(node)) return;
    if (changed || !originals.has(node)) originals.set(node, node.data);
    const source = originals.get(node);
    // Paths and identifiers are opaque. Only translate the fixed line prefixes.
    if (node.parentElement?.closest('#exportResult, #jobPath, #connection, #issues')) {
      node.data = source.split('\n').map(line => {
        const separator = line.indexOf('：');
        const opaque = /^(保存先|中断復帰用フォルダ|接続先|不整合|孤立・未確定ファイル)/.test(line);
        if (separator < 0 || !opaque) return translate(line);
        const value = line.slice(separator + 1);
        return translate(line.slice(0, separator + 1)) + (value === 'なし' ? translate(value) : value);
      }).join('\n');
    } else node.data = translate(source);
  }
  function localizeAttributes(element, changed) {
    let source = attributes.get(element);
    if (!source) { source = {}; attributes.set(element, source); }
    for (const name of ['title', 'aria-label', 'aria-valuetext', 'placeholder', 'alt']) {
      if (!element.hasAttribute(name)) continue;
      if (!(name in source) || changed === name) source[name] = element.getAttribute(name);
      element.setAttribute(name, translate(source[name]));
    }
  }
  function visit(root) {
    if (root.nodeType === Node.TEXT_NODE) { localizeText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest('script, style, .language-selector')) return;
    localizeAttributes(root);
    for (const node of root.childNodes) visit(node);
  }
  const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'aria-valuetext', 'placeholder', 'alt'] };
  const observer = new MutationObserver(records => {
    observer.disconnect();
    const texts = new Set(), changedAttributes = new Map();
    for (const record of records) {
      if (record.type === 'characterData') texts.add(record.target);
      else if (record.type === 'attributes') {
        const names = changedAttributes.get(record.target) ?? new Set();
        names.add(record.attributeName); changedAttributes.set(record.target, names);
      }
      else for (const node of record.addedNodes) visit(node);
    }
    for (const node of texts) localizeText(node, true);
    for (const [element, names] of changedAttributes) {
      const source = attributes.get(element) ?? {};
      for (const name of names) source[name] = element.getAttribute(name);
      attributes.set(element, source); localizeAttributes(element);
    }
    observer.observe(document.documentElement, options);
  });
  const apply = () => {
    // Consume pending canonical writes before a user-triggered language change.
    for (const record of observer.takeRecords()) {
      if (record.type === 'characterData') originals.set(record.target, record.target.data);
      if (record.type === 'attributes') {
        const source = attributes.get(record.target) ?? {};
        source[record.attributeName] = record.target.getAttribute(record.attributeName);
        attributes.set(record.target, source);
      }
    }
    observer.disconnect();
    visit(document.documentElement);
    document.documentElement.lang = language;
    observer.observe(document.documentElement, options);
  };
  select.addEventListener('change', () => {
    language = select.value;
    try { localStorage.setItem('ktzLanguage', language); } catch { /* Optional persistence. */ }
    apply();
  });
  apply();
}
