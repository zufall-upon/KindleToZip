import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { checkCaptureResume } from './capture-resume-flow.mjs';
const root = process.env.KTZ_REVIEW_BUNDLE;
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'artifacts/browsers');
process.env.KTZ_CONTROLLER_PATH = path.join(root, 'controller/ktz-g02-controller.exe');
const { startApplication } = await import(pathToFileURL(path.join(root, 'app/server.mjs')));
const { openControlWindow: open } = await import(pathToFileURL(path.join(root, 'app/control-window.mjs')));
const { withPublicDisclosures } = await import(pathToFileURL(path.join(root, 'poc/browser/public-ui-controls.mjs')));
const result = await checkCaptureResume({ startApplication, evidence: process.env.KTZ_REVIEW_EVIDENCE,
  openControlWindow: async (...args) => { const window = await open(...args); return { ...window, page: withPublicDisclosures(window.page) }; } });
await writeFile(path.join(process.env.KTZ_REVIEW_EVIDENCE, 'capture-resume-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
