// End-to-end: US sanctions declarations, "How did you hear about us?" (LinkedIn), interview availability, contact
// preferences and "Otherwise, enter N/A" boxes, on replicas of the forms they were reported on.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE, isFirefox, launch, selectedText, text, value } from './harness.mjs';

let h;

before(async () => {
  h = await launch();
  await h.setProfile(PROFILE);
});

after(() => h.close());

const state = async (page) => JSON.parse(await text(page, '#state'));

test('Databricks on Greenhouse’s job board: sanctions multi-selects and a free-text "How did you hear"', async () => {
  const original = await h.profile();
  // A British student living in the US who never filled in "How did you hear about us?".
  await h.setProfile({ personal: { nationality: 'British' }, job: { referralSource: '' } });
  try {
    const page = await h.open('greenhouse-remix.html?databricks');
    await page.waitForSelector('#question_1013');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    assert.equal(s.heard, 'LinkedIn', 'a blank answer is LinkedIn');
    assert.deepEqual(s.sanctions, ['None of the above']);
    assert.deepEqual(s.sanctionsFollowUp, [
      'Not applicable (i.e., I selected “none of the above” for the prior question)',
    ]);
    assert.equal(s.source, 'Social Media (e.g., LinkedIn, Reddit, Discord, Facebook, X, Instagram)');
    assert.ok(!r.unmatched.some((label) => /sanction|heard/i.test(label)), JSON.stringify(r.unmatched));
    await page.close();

    // Without a nationality the declaration is left for you, and never goes to the AI.
    await h.setProfile({ personal: { nationality: '' } });
    const again = await h.open('greenhouse-remix.html?databricks');
    await again.waitForSelector('#question_1013');
    const r2 = await h.fill(again);
    const s2 = await state(again);
    assert.equal(s2.sanctions, null);
    assert.equal(s2.sanctionsFollowUp, null);
    assert.equal(r2.pending, r.pending, 'the two unanswered declarations are not among the AI’s questions');
    await again.close();
  } finally {
    await h.setProfile({ personal: original.personal, job: original.job });
  }
});

test('Pinpoint’s Singleselect and Multiselect: "How did you hear…?" and interview slots in react-select', async () => {
  const page = await h.open('pinpoint.html');
  await page.waitForSelector('#application_form_application_answers_attributes_12_text_answer');
  const r = await h.fill(page);
  assert.equal(r.error, undefined);
  const s = await state(page);
  const slots = JSON.parse(await text(page, '#slots'));
  assert.equal(s.application_form_application_answers_attributes_11_text_answer, 'Linkedin');
  // Monday 10–11 and Tuesday 2–3 fit weekdays 8am–8pm; Wednesday 6:30–9pm and Saturday don't.
  assert.deepEqual(s.application_form_application_answers_attributes_12_text_answer, slots.slice(0, 2));
  assert.deepEqual(r.unmatched, []);
  await page.close();
});

test('Teamtailor (Alloyed): "How did you hear about Alloyed?" and interview slots in menus of ticks', async () => {
  const original = await h.profile();
  // Free from noon: the afternoon slots fit, the mornings don't.
  await h.setProfile({ job: { referralSource: '' }, availability: { ...original.availability, from: '12:00' } });
  try {
    const page = await h.open('teamtailor.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    const s = await state(page);
    assert.equal(s['How did you hear about Alloyed?'], 'LinkedIn', 'LinkedIn alone, in a menu that takes several');
    const slots = await page.$$eval('#dropdown-12 [role="menuitemcheckbox"]', (items) =>
      items.map((i) => i.textContent.trim()),
    );
    const afternoons = slots.filter((t) => / - PM$/.test(t));
    assert.equal(afternoons.length, 7);
    assert.deepEqual(s['1st Stage Video Interview Availability (Multiple Choice)'], afternoons);
    assert.equal(
      await page.$eval('#dropdown-12', (m) => m.classList.contains('hidden')),
      true,
      'the menu is closed again',
    );
    assert.ok(!r.unmatched.some((label) => /availab|hear/i.test(label)), JSON.stringify(r.unmatched));
    // Filling again keeps them.
    const refill = await h.fill(page);
    assert.equal(refill.filled, 0, JSON.stringify(refill));
    await page.close();
  } finally {
    await h.setProfile({ job: original.job, availability: original.availability });
  }
});

test('SuccessFactors (Moody’s): communication preference, a personal relationship, "Otherwise, enter N/A"', async () => {
  const original = await h.profile();
  await h.setProfile({
    personal: { nationality: 'British' },
    compliance: { ...original.compliance, relatives: 'No' },
  });
  try {
    const page = await h.open('successfactors-questions.html');
    const r = await h.fill(page);
    assert.equal(r.error, undefined);
    assert.equal(await selectedText(page, '#q_comm'), 'Email');
    assert.equal(await selectedText(page, '#q_rel'), 'No');
    assert.equal(await value(page, '#q_rel_name'), 'N/A');
    assert.equal(await selectedText(page, '#q_source'), 'LinkedIn');
    assert.equal(await selectedText(page, '#q_sanctions'), 'No');
    assert.equal(await value(page, '#q_avail'), 'Weekdays, 8am–8pm');
    await page.close();
  } finally {
    await h.setProfile({ personal: original.personal, compliance: original.compliance });
  }
});

test(
  'settings: interview availability, contact preference and the LinkedIn default are shown and saved',
  { skip: isFirefox && 'uses Playwright page APIs' },
  async () => {
    const original = await h.profile();
    await h.setProfile({ job: { referralSource: '' } });
    const page = await h.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(h.extUrl('options/options.html#work'));
      const day = (d) => `input[name="availability.days-${d}"]`;
      await page.waitForSelector(day('mon'));
      const ticked = await page.$$eval('[name^="availability.days-"]', (boxes) => boxes.map((b) => b.checked));
      assert.deepEqual(ticked, [true, true, true, true, true, false, false], 'weekdays by default');
      assert.equal(await page.getAttribute('input[name="job.referralSource"]', 'placeholder'), 'LinkedIn');
      await page.uncheck(day('mon'));
      await page.check(day('sat'));
      await page.fill('input[name="availability.from"]', '09:30');
      await page.fill('textarea[name="availability.unavailable"]', '12–23 January 2027 (exams)');
      await page.click('#nav a[href="#personal"]');
      await page.selectOption('select[name="contact.preferredContact"]', 'Phone');
      await page.waitForSelector('#save-state.saved');
      await page.waitForTimeout(500);
      const p = await h.profile();
      assert.deepEqual(p.availability, {
        days: 'Tue, Wed, Thu, Fri, Sat',
        from: '09:30',
        to: '20:00',
        unavailable: '12–23 January 2027 (exams)',
      });
      assert.equal(p.contact.preferredContact, 'Phone');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      await h.setProfile({ availability: original.availability, contact: original.contact, job: original.job });
    }
  },
);
