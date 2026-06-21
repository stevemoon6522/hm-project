import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'v2', 'index.html'), 'utf8');

for (const forbidden of [
  "document.getElementById('pl-master-edit-modal')?.addEventListener('click'",
  "if (els.modal) els.modal.addEventListener('click'",
  "g('wiz-modal-overlay').addEventListener && g('wiz-modal-overlay').addEventListener('click'",
  "overlay.addEventListener('click', (e) => { if (e.target === overlay) rshCloseModal(); })",
  "els.rswModalOverlay.addEventListener('click'",
  "document.getElementById('cat-modal-overlay')?.addEventListener('click'",
  "b2bEl('b2b-catalog-edit-modal')?.addEventListener('click'",
  "b2bEl('b2b-catalog-bulk-modal')?.addEventListener('click'",
  "b2bEl('b2b-conflict-modal')?.addEventListener('click'",
  "document.getElementById('mr-ebay-modal-overlay')?.addEventListener('click'",
  "document.getElementById('mr-qoo10-modal-overlay')?.addEventListener('click'",
]) {
  assert(!html.includes(forbidden), `modal backdrop click close handler must not exist: ${forbidden}`);
}

assert.doesNotMatch(
  html,
  /if \((?:e|event)\.target\s*===\s*(?:this|overlay|els\.[A-Za-z0-9_]+|b2bEl\('[^']+'\))\)\s*[A-Za-z0-9_]*[Cc]lose[A-Za-z0-9_]*Modal\(/,
  'modal overlays must not close on backdrop target clicks',
);

for (const token of [
  "document.getElementById('pl-master-edit-close')?.addEventListener('click', closeProductMasterEditModal)",
  "document.getElementById('pl-master-edit-cancel')?.addEventListener('click', closeProductMasterEditModal)",
  'onclick="closeWizModal()"',
  "if (closeBtn1) closeBtn1.addEventListener('click', rshCloseModal)",
  "if (closeBtn2) closeBtn2.addEventListener('click', rshCloseModal)",
  "if (closeBtn) closeBtn.addEventListener('click', catCloseModal)",
  "if (cancelBtn) cancelBtn.addEventListener('click', catCloseModal)",
  "b2bEl('b2b-catalog-edit-close')?.addEventListener('click', b2bCloseCatalogEditModal)",
  "b2bEl('b2b-catalog-bulk-close')?.addEventListener('click', b2bCloseBulkEditModal)",
  "b2bEl('b2b-conflict-close')?.addEventListener('click', b2bCloseConflictModal)",
  "document.getElementById('mr-ebay-modal-close')?.addEventListener('click', mrCloseEbayModal)",
  "document.getElementById('mr-qoo10-modal-close')?.addEventListener('click', mrCloseQoo10Modal)",
]) {
  assert(html.includes(token), `explicit modal close control must remain wired: ${token}`);
}

console.log('v2 modal backdrop lock checks passed');
