/*
 * JobToFill — field rules, compliance: US sanctions and export-control statements, and the conflicts of interest and
 * history banks ask about. One of the parts lib/fields.js puts together (loaded before it, in the order background.js
 * lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const { detailsIfYes, simple, val, yesWithDetails } = P;

  // Places named in sanctions statements; two in one sentence make it one ("…of Cuba, Iran, North Korea, or Syria").
  const SANCTIONED_PLACE =
    '(cuban?|iran(ian)?|north korean?|syrian?|crimean?|donetsk|lu[hg]ansk|zapor[io]z?h\\w*|kherson|sevastopol)';
  const TWO_SANCTIONED_PLACES = new RegExp(`\\b${SANCTIONED_PLACE}\\b.*\\b${SANCTIONED_PLACE}\\b`);
  // "If you selected a response to the prior question other than "none of the above," please confirm…"
  const SANCTIONS_FOLLOW_UP =
    /\bother than (the )?none of (the above|these|them)\b|\b(if|where) (you|any) (selected|ticked|chose|checked|answered|picked)\b(?! (yes|no)\b).*\b(prior|previous|above|preceding|first) question\b/;
  const CITIZEN_WORDS = /\b(citizen\w*|nationals?|nationality|passports?)\b/;
  const PERMANENT_RESIDENT = /\bpermanent(ly)? residen\w*|\bgreen card\b/;
  const RESIDENT_WORDS = /\b(residen\w*|reside|resided|residing|live|lives|lived|living|located|based|domiciled)\b/;
  // "…a comprehensively sanctioned country", "subject to US embargo (E:1/E:2 countries)": the usual list.
  const ANY_SANCTIONED = /\bsanction\w*|\bembargo\w*|\bofac\b|\be [12]\b|\bcountry group e\b/;
  // The US as the authority ("U.S. sanctions", "subject to US embargo"), not a place you could be from.
  const SANCTIONING =
    /\b(u ?s( a)?|united states( of america)?|american)( government| treasury| department of \w+)? (sanction\w*|embargo\w*|export\w*|laws?|regulations?|government|treasury|department|ofac|trade)\b/g;

  const or3 = (list) => (list.includes(true) ? true : list.includes(null) ? null : false);
  const and3 = (a, b) => (a === false || b === false ? false : a === true && b === true ? true : null);

  /** What sanctions statements are judged by: your nationalities, where you live (and its region), relocation. */
  function sanctionFacts(p) {
    const nations = JTF.geo.nationalities(p.personal.nationality).map((row) => row[0]);
    const home = JTF.geo.findCountry(p.address.country);
    const area = [p.address.state, p.address.city].filter((s) => !U.isBlank(s)).join(' ');
    return {
      nations: nations.length ? nations : null,
      home: home ? home[0] : null,
      // The occupied regions of Ukraine your region or city names; null when the address doesn't say.
      regions: area ? JTF.geo.occupiedRegions(area) : null,
      relocate: JTF.matcher ? JTF.matcher.canonicalOf(p.job.relocate) : null,
    };
  }

  /** Nothing a sanctions list could ask about applies to you: "none of the above" even with its statements unseen. */
  function sanctionsClear(f) {
    const watch = JTF.geo.SANCTIONS_WATCH;
    if (!f.nations || !f.home || f.nations.some((c) => watch.has(c)) || watch.has(f.home)) return false;
    if (f.regions && f.regions.length) return false;
    return f.home !== 'UA' || f.regions != null;
  }

  /**
   * Is a sanctions statement true of you? "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria" from
   * your nationalities; "Ordinarily a resident of … the Crimea, Donetsk… regions of Ukraine" from your country and
   * region; "…of Russia or Belarus and not willing to relocate" from your relocation answer too. A question that
   * names no place ("…a comprehensively sanctioned country?") means the usual ones. true / false; null when your
   * profile can't tell; undefined when it isn't such a statement ("None of the above").
   */
  function sanctionsApplies(text, f) {
    const all = U.normalize(text);
    let t = ' ' + all.replace(SANCTIONING, ' ') + ' ';
    // "…and not willing to relocate for a Databricks role" is a condition, not a denial.
    let relocation = null;
    t = t.replace(/\b(and |but )?(not |un)(willing|able|prepared|open) to relocate\b.*$/, () => {
      relocation = 'no';
      return ' ';
    });
    t = t.replace(/\b(and |but )?(willing|able|prepared|open) to relocate\b.*$/, () => {
      relocation = relocation || 'yes';
      return ' ';
    });
    // "Individual granted citizenship in a country other than Cuba, Iran…": any other one.
    const other = t.match(/\bother than\b(.*)$/);
    const head = other ? t.slice(0, other.index) : t;
    const scope = other ? other[1] : t;
    const regions = JTF.geo.occupiedRegions(scope);
    // Countries or their people ("Cuban, Iranian… nationality").
    let countries = JTF.geo.nationalitiesNamed(scope);
    // "North Korea" isn't South Korea (alias "Korea"); "the Crimea… regions of Ukraine" isn't all of Ukraine.
    if (countries.includes('KP') && !/\bsouth korea/.test(scope)) countries = countries.filter((c) => c !== 'KR');
    if (regions.length) countries = countries.filter((c) => c !== 'UA');
    if (!countries.length && !regions.length) {
      if (other || !ANY_SANCTIONED.test(all)) return undefined;
      countries = JTF.geo.SANCTIONED;
      regions.push(...JTF.geo.OCCUPIED.map(([name]) => name));
    }
    // "Have you ever lived in…?" asks about the past, which the profile doesn't know.
    const past = /\b(ever|previously|formerly|in the past|lived|resided)\b/.test(head);
    const lives = () => {
      if (other) return null;
      if (f.home && countries.includes(f.home)) return true;
      if (regions.length && f.regions && f.regions.some((r) => regions.includes(r))) return true;
      if (past || !f.home || (f.home === 'UA' && regions.length && f.regions == null)) return null;
      return false;
    };
    const citizen = () => {
      if (!f.nations) return null;
      return other ? f.nations.some((c) => !countries.includes(c)) : f.nations.some((c) => countries.includes(c));
    };
    const tests = [];
    const isCitizen = CITIZEN_WORDS.test(head);
    const isPermanent = PERMANENT_RESIDENT.test(head);
    const isResident = RESIDENT_WORDS.test(head.replace(PERMANENT_RESIDENT, ' '));
    if (isCitizen || (!isPermanent && !isResident)) tests.push(citizen());
    if (isResident || (!isCitizen && !isPermanent)) tests.push(lives());
    // A permanent residency elsewhere than you live is unlikely; where you live it can't be told.
    if (isPermanent) tests.push(citizen() || (lives() === false ? false : null));
    // "Are you, or is any member of your family, a national of…?": your family's isn't known.
    if (/\b(family|relatives?|parents?|spouse|household)\b/.test(head)) tests.push(null);
    let result = or3(tests);
    if (relocation) result = and3(result, f.relocate === relocation ? true : f.relocate ? false : null);
    if (/\b(not|never|neither|nor)\b/.test(head)) result = result == null ? null : !result;
    return result;
  }

  // What each type of field is filled with.
  Object.assign((P.DEFS = P.DEFS || {}), {
    // "Have you applied to us before?"; "Have you interviewed with Jane Street before?" is No when you never applied.
    'compliance.previouslyApplied': {
      label: 'Applied here before',
      path: 'compliance.previouslyApplied',
      get(p, ctx) {
        const v = val(p.compliance.previouslyApplied);
        if (v && /\binterview/.test(ctx.question || '')) return v.canonical === 'no' ? v : null;
        return v;
      },
    },
    // "Please confirm whether any of the below applies to you… U.S. sanctions and export controls": each statement
    // true of you (sanctionsApplies), else "None of the above"; its follow-up "Not applicable (I selected none of the
    // above)". Yes / No versions ("Are you a citizen or resident of Cuba, Iran…?") are answered the same way. Left for
    // you whenever your profile can't tell (no nationality, a region of Ukraine, Russia and relocating unknown).
    'compliance.sanctions': {
      label: 'Sanctions / export-control declaration',
      get(p, ctx) {
        const facts = sanctionFacts(p);
        if (!facts.nations && !facts.home) return null;
        const q = ctx.question || '';
        const followUp = SANCTIONS_FOLLOW_UP.test(q);
        const asked = followUp ? undefined : sanctionsApplies(q, facts);
        const answer = asked === true ? 'Yes' : asked === false ? 'No' : null;
        const clear = sanctionsClear(facts);
        return val(answer || (clear ? 'None of the above' : 'It depends'), {
          kind: 'sanctions',
          facts,
          followUp,
          clear,
          answer,
          many: true,
          canonical: answer ? answer.toLowerCase() : null,
        });
      },
    },

    'compliance.previouslyEmployed': {
      label: 'Worked here before',
      path: 'compliance.previouslyEmployed',
      get(p, ctx) {
        const v = val(p.compliance.previouslyEmployed);
        // FDM's "Do you currently work for us?": someone who worked here before may not now, so only a No answers it.
        const now = /^(do|are) you (currently |presently )?(work|working|employed)\b/.test(ctx.question || '');
        return v && now && v.canonical !== 'no' ? null : v;
      },
    },
    'compliance.relatives': {
      label: 'Relatives working here',
      path: 'compliance.relatives',
      get: (p, ctx) => yesWithDetails(p.compliance.relatives, p.compliance.relativesDetails, ctx),
    },
    'compliance.relativesDetails': {
      label: 'Relatives working here: details',
      path: 'compliance.relativesDetails',
      get: (p, ctx) => detailsIfYes(p.compliance.relatives, p.compliance.relativesDetails, ctx),
    },
    // "Are you, or is any immediate family member, a current or former government official…?", "Are you a
    // politically exposed person?", "Were your parents involved in government?": you, your family, or both.
    'compliance.government': {
      label: 'Government official / PEP',
      get(p, ctx) {
        const q = ctx.question || '';
        const family =
          /\b(related to|family|relatives?|parents?|spouse|partner|siblings?|child(ren)?|household|close associates?)\b/.test(
            q,
          );
        // "You, any member of your household, or any business partner…": a statement about you and them.
        const self =
          !family ||
          (/^you\b|\b(you or|you and|yourself|are you (a|an|currently|now|ever|or)|have you (ever )?(been|held|worked)|were you)\b/.test(
            q,
          ) &&
            !/\bare you related\b/.test(q));
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const answers = [
          self && canon(p.compliance.governmentOfficial),
          family && canon(p.compliance.familyGovernmentOfficial),
        ].filter((x) => x !== false);
        let answer = null;
        if (answers.includes('yes')) answer = 'Yes';
        else if (answers.length && answers.every((x) => x === 'no')) answer = 'No';
        if (!answer) return null;
        return answer === 'Yes' ? yesWithDetails('Yes', p.compliance.governmentDetails, ctx) : val('No');
      },
    },
    'compliance.governmentDetails': {
      label: 'Government official / PEP: details',
      path: 'compliance.governmentDetails',
      get(p, ctx) {
        const canon = (t) => (JTF.matcher ? JTF.matcher.canonicalOf(t) : null);
        const answers = [p.compliance.governmentOfficial, p.compliance.familyGovernmentOfficial].map(canon);
        const answer = answers.includes('yes') ? 'Yes' : answers.every((x) => x === 'no') ? 'No' : '';
        return detailsIfYes(answer, p.compliance.governmentDetails, ctx);
      },
    },

    'compliance.criminal': simple('Criminal convictions', 'compliance.criminal'),
    'compliance.regulatory': simple('Regulatory or disciplinary action', 'compliance.regulatory'),
    // "Do any of the following apply to you?" over statements ("You are currently serving as a Government Official…",
    // "…subject to post-employment restrictions…") and "None of these apply to me": each statement is answered as the
    // Yes / No question it is (matcher.declarationList), "None…" only when every one is a No. Left for you when your
    // profile can't tell one of them.
    'compliance.declarations': {
      label: 'Declarations (government, relatives, regulatory)',
      get(p, ctx) {
        const list = JTF.matcher ? JTF.matcher.declarationList(ctx.options) : null;
        if (!list) return null;
        const yes = [];
        for (const st of list.statements) {
          const v = P.resolve(st.type, p, {
            ...ctx,
            question: U.normalize(st.text),
            kind: 'radio',
            options: [{ text: 'Yes' }, { text: 'No' }],
          });
          const answer = v && v.canonical;
          if (answer === 'yes') yes.push(st.text);
          else if (answer !== 'no') return null;
        }
        const items = yes.length ? yes : [list.none.text];
        return val(items.join('; '), { kind: 'list', items, candidates: items, canonical: null });
      },
    },
  });

  Object.assign(P, { SANCTIONS_FOLLOW_UP, TWO_SANCTIONED_PLACES, sanctionsApplies });
})(typeof globalThis !== 'undefined' ? globalThis : this);
