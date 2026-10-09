/*
 * JobToFill — profile schema, field types, detection rules and value resolution, put together from its parts, which
 * load just before this file (in the order background.js lists them; scripts/check.mjs keeps every list the same):
 *   fields-values.js        the shapes an answer takes, "N/A" for what doesn't apply, the kinds of box
 *   fields-profile.js       a new profile, and the upgrade of an older one
 *   fields-personal.js      name, contact details, address, links, languages, cards and accounts
 *   fields-education.js     education and job entries, grades (never converted)
 *   fields-documents.js     which upload takes your CV, letter or transcript
 *   fields-availability.js  interview slots
 *   fields-work.js          right to work, visas, clearance, location, start dates, where you heard of the job
 *   fields-diversity.js     equal-opportunity and social-mobility monitoring
 *   fields-compliance.js    sanctions and export controls, conflicts of interest
 *   fields-rules.js         RULES, one ordered list (the first of equal scores wins), and autocomplete tokens
 * Each part adds its definitions to DEFS and shares what the others use on JTF.fieldParts.
 *
 * A "field type" (e.g. "name.first", "edu.school", "job.sponsorship") is what the
 * detector assigns to a form control. DEFS says where the value for each type
 * lives in the profile; RULES say how to recognise it from label text.
 * All rule regexes run against JTF.util.normalize()d text: lowercase, accents
 * stripped, punctuation collapsed to single spaces ("LinkedIn URL*" -> "linked in url").
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const {
    AUTOCOMPLETE,
    CHOICE,
    DEFAULT_KINDS,
    ETHNICITY_CHOICES,
    RULES,
    SANCTIONS_FOLLOW_UP,
    TEXTISH,
    TWO_SANCTIONED_PLACES,
    blankCustomAnswer,
    blankEducation,
    blankExperience,
    cardBrand,
    countriesAsked,
    createProfile,
    degreeClassOf,
    eduLevelOf,
    entryLevels,
    gradeHeld,
    isAcknowledgement,
    languagesNamed,
    leftEmpty,
    otherwiseVal,
    parseEthnicity,
    parseSlots,
    placeCountry,
    sanctionsApplies,
    slotFits,
    upgradeProfile,
    uploadAlso,
    uploadApplies,
    val,
    workCountries,
  } = P;
  const DEFS = P.DEFS;

  /** Types that only make sense on a job application; their presence switches on job context. */
  const JOB_TYPES =
    /^(edu\.|exp\.title|exp\.description|job\.|eeo\.|file\.|links\.(linkedin|github|portfolio)|coverLetter|skills|summary)/;

  /** Types whose value is a date and that may be split into month / year / day boxes. */
  const DATE_TYPES = new Set([
    'edu.start',
    'edu.end',
    'exp.start',
    'exp.end',
    'gen.start',
    'gen.end',
    'dob',
    'job.startDate',
    'job.fullTimeStart',
    'cc.exp',
  ]);

  // "If yes, please tell us more": only answered when the answer to the question before was yes.
  const FOLLOW_UP = /^if (yes|so|you (said|answered|selected|chose|checked|ticked) yes)\b/;

  /**
   * Does an "If yes, …" question take this answer? A yes always; a no only as the answer to a yes/no choice ("If
   * yes, will you require Appian to file a visa petition? Yes / No"), never as the details a box asks for.
   */
  function followUpAnswer(v, kind) {
    return !!v && (!!v.otherwise || v.canonical === 'yes' || (v.canonical === 'no' && CHOICE.includes(kind)));
  }

  /** Resolve a field type to a value object (or null when the profile has nothing for it). */
  function resolve(type, profile, ctx) {
    ctx = ctx || {};
    if (type === 'custom') return val(ctx.answer, { custom: true });
    const def = DEFS[type];
    if (!def || !profile) return null;
    try {
      const v = def.get(profile, ctx) || null;
      // "If yes, give their name. Otherwise, enter N/A" in a text box, after a No: "N/A".
      const instead = v && v.canonical === 'no' && !v.otherwise ? otherwiseVal(ctx) : null;
      if (instead) return instead;
      return v && FOLLOW_UP.test(ctx.question || '') && !followUpAnswer(v, ctx.kind) ? null : v;
    } catch (err) {
      return null;
    }
  }

  function labelOf(type) {
    return (DEFS[type] && DEFS[type].label) || type;
  }

  const fields = {
    createProfile,
    upgradeProfile,
    blankEducation,
    blankExperience,
    blankCustomAnswer,
    DEFS,
    RULES,
    AUTOCOMPLETE,
    JOB_TYPES,
    DATE_TYPES,
    KINDS: { TEXTISH, CHOICE, DEFAULT_KINDS },
    resolve,
    labelOf,
    workCountries,
    countriesAsked,
    followUpAnswer,
    eduLevelOf,
    entryLevels,
    degreeClassOf,
    uploadApplies,
    uploadAlso,
    gradeHeld,
    leftEmpty,
    placeCountry,
    languagesNamed,
    isAcknowledgement,
    parseEthnicity,
    sanctionsApplies,
    isSanctionsFollowUp: (question) => SANCTIONS_FOLLOW_UP.test(question || ''),
    TWO_SANCTIONED_PLACES,
    parseSlots,
    slotFits,
    ETHNICITY_CHOICES,
    cardBrand,
    val,
  };
  // What the parts call back for (when they run, all parts and this file have loaded).
  Object.assign(P, { resolve });
  JTF.fields = fields;
  if (typeof module === 'object' && module.exports) module.exports = fields;
})(typeof globalThis !== 'undefined' ? globalThis : this);
