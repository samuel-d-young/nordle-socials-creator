// What field a brand is in: found from the words it uses about itself (and said plainly when that is unclear), typed by the owner when they know better,
// kept in brand.json, and handed to Claude as "check the rules of this field where the business operates".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDUSTRIES, cleanIndustry, detectIndustry, industryRules } from '../src/brand/industry.mjs';
import { applyGuide, newBrand, toGuide } from '../src/brand/guide.mjs';
import { scanBrand } from '../src/brand/scan.mjs';
import { isRegulated } from '../src/calendar/plan.mjs';
import { contentRules } from '../src/calendar/prompts.mjs';
import { closeBrowser } from './helpers.mjs';
import { studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const words = (text, weight = 1) => [{ text, weight }];

test('detectIndustry: dentistry, carpet cleaning, education, a cafe and an airshow are told apart, with the words that decided it', () => {
  const cases = [
    ['Dentistry', 'Our dentists offer family dental care, Invisalign, implants and hygienist visits. Book your check-up.'],
    ['Cleaning services', 'Professional carpet cleaning, upholstery cleaning and stain removal. Steam clean for end of lease.'],
    ['Education and training', 'A primary school for students from prep to year 6. Our teachers follow the curriculum. Enrol now.'],
    ['Food and hospitality', 'A neighbourhood cafe serving coffee, brunch and fresh bakery items. See the menu.'],
    ['Events and entertainment', 'The annual airshow and aviation event, with tickets, a festival atmosphere and volunteers.'],
    ['Legal services', 'Our lawyers and solicitors handle family law, wills and estate planning.'],
  ];
  for (const [label, text] of cases) {
    const r = detectIndustry(words(text));
    assert.equal(r.best?.label, label, `${label}: got ${r.best?.label} (${JSON.stringify(r.alternatives)})`);
    assert.ok(r.best.evidence.length >= 2, 'it names the words it found');
  }
  assert.equal(detectIndustry(words('Hello and welcome.')).best, null, 'nothing to go on, nothing claimed');
  assert.equal(detectIndustry(words('Hello and welcome.')).confidence, 'none');
});

test('a title counts for more than the body, and one repeated word cannot decide it alone', () => {
  const r = detectIndustry([{ text: 'Harbour Dental', weight: 3 }, { text: 'shop shop shop shop shop shop shop shop shop shop shop shop', weight: 1 }, { text: 'Come in and see our dentist', weight: 1 }]);
  assert.equal(r.best.id, 'dentistry');
});

test('regulated fields are flagged; cleanIndustry keeps what the owner typed and fills in what it knows', () => {
  assert.equal(cleanIndustry({ label: 'dentistry' }).regulated, true);
  assert.equal(cleanIndustry({ label: 'dentistry' }).id, 'dentistry');
  assert.deepEqual(cleanIndustry({ label: 'Carpet cleaning', rules: 'no health claims' }), { label: 'Carpet cleaning', rules: 'no health claims' });
  assert.deepEqual(cleanIndustry({ label: 'Dentistry', regulated: false }), { id: 'dentistry', label: 'Dentistry', regulated: false });
  assert.equal(cleanIndustry({ label: '', rules: '' }), null);
  assert.equal(cleanIndustry(null), null);
});

test('scanBrand: the field is detected from a bio and captions, named as the owner says when they type it, and left open when unclear', async () => {
  const dental = await scanBrand({ name: 'Harbour Smiles', bio: 'Family dentists. Implants, orthodontics and hygienist care.', captions: 'Meet our dentist! #dental #smile' });
  assert.equal(dental.draft.industry.id, 'dentistry');
  assert.equal(dental.draft.industry.regulated, true);
  assert.ok(dental.found.some((t) => /dentistry business/.test(t)));
  assert.ok(Array.isArray(dental.industry.alternatives));
  const typed = await scanBrand({ name: 'Sparkle', industry: 'Carpet cleaning', bio: 'We love a clean floor.' });
  assert.equal(typed.draft.industry.label, 'Carpet cleaning');
  assert.ok(typed.found.some((t) => /Field: Carpet cleaning \(as you said\)/.test(t)));
  const unclear = await scanBrand({ name: 'Zed', bio: 'We do things.' });
  assert.equal(unclear.draft.industry, undefined);
  assert.ok(unclear.problems.some((t) => /Could not tell what field/.test(t)));
});

test('the field is saved in brand.json, read back in the guide, and cleared by sending null', () => {
  const brand = newBrand('b', { name: 'B', industry: { label: 'Dentistry', rules: 'AHPRA: no testimonials' } });
  assert.equal(brand.industry.id, 'dentistry');
  assert.equal(brand.industry.rules, 'AHPRA: no testimonials');
  assert.equal(toGuide(brand).industry.label, 'Dentistry');
  assert.equal(toGuide(brand).industry.regulated, true);
  const changed = applyGuide(brand, { industry: { label: 'Education and training' } });
  assert.equal(changed.industry.id, 'education');
  assert.equal(applyGuide(changed, { industry: null }).industry, undefined);
  assert.equal(applyGuide(brand, {}).industry.label, 'Dentistry', 'leaving it out changes nothing');
});

test('Claude is told the field and to check its rules where the business operates; a health field counts as regulated', () => {
  const brand = newBrand('b', { name: 'B', industry: { label: 'Carpet cleaning', rules: 'no health claims' } });
  const lines = industryRules(brand);
  assert.match(lines[0], /field of: Carpet cleaning/);
  assert.match(lines.join('\n'), /The owner says these rules apply: no health claims/);
  assert.match(lines.join('\n'), /where the business operates/);
  assert.match(lines.join('\n'), /say so and ask the owner/);
  assert.deepEqual(industryRules(newBrand('c', { name: 'C' })), [], 'no field, no extra lines');
  const rules = contentRules({ regulated: false, scope: 'plan', facts: null, brand });
  assert.match(rules[0], /Carpet cleaning/);
  assert.equal(isRegulated(newBrand('d', { name: 'Plain Co', industry: { label: 'Dentistry' } }), {}), true);
  assert.equal(isRegulated(newBrand('e', { name: 'Plain Co', industry: { label: 'Carpet cleaning' } }), {}), false);
});

test('the field suggestions the wizard offers are the same labels the server knows', () => {
  const client = readFileSync(join(import.meta.dirname, '..', 'app', 'studio-brand.js'), 'utf8');
  const listed = JSON.parse(`[${/const INDUSTRY_IDEAS = \[(.*?)\];/.exec(client)[1].replace(/'/g, '"')}]`);
  assert.deepEqual(listed, INDUSTRIES.map((i) => i.label));
});

test('Add a brand: say the field before looking, see it chosen in the guide, add rules, and it is kept with the brand', async () => {
  await studioPage(async ({ page, open, work }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Sparkle Carpet Care');
    await page.locator('[data-act="wz-next"]').click();
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true);
    await page.fill('[data-field="wz-industry"]', 'Carpet cleaning');
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'naming the field is something to look at');
    await page.fill('[data-field="wz-bio"]', 'Steam cleaning for carpets and upholstery across Melbourne.');
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    assert.match(await page.locator('.wz-found').innerText(), /Field: Carpet cleaning \(as you said\)/);
    await page.locator('[data-act="wz-next"]').click();
    await page.waitForSelector('.bg-edit');
    assert.equal(await page.inputValue('[data-field="bg-industry"]'), 'Carpet cleaning');
    await page.fill('[data-field="bg-rules"]', 'No health claims about allergies.');
    await page.locator('[data-act="wz-create"]').click();
    await page.waitForSelector('.wz-nexts');
    const brand = JSON.parse(readFileSync(join(work, 'projects', 'sparkle-carpet-care', 'brand.json'), 'utf8'));
    assert.equal(brand.industry.label, 'Carpet cleaning');
    assert.equal(brand.industry.rules, 'No health claims about allergies.');
  });
});
