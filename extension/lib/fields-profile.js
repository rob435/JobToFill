/*
 * JobToFill — field rules, the profile: a new profile's shape and the upgrade of one saved by an older version. One of
 * the parts lib/fields.js puts together (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});

  function blankEducation() {
    return {
      school: '',
      degree: '',
      field: '',
      gpa: '',
      // UK degree class, expected or achieved: "2:1", "First"; "Distinction" or "Merit" for a master's.
      classification: '',
      location: '',
      startDate: '',
      endDate: '',
    };
  }

  function blankExperience() {
    return { company: '', title: '', location: '', startDate: '', endDate: '', current: false, description: '' };
  }

  function blankCustomAnswer() {
    return { id: U.uid(), question: '', answer: '' };
  }

  function createProfile(name) {
    return {
      id: U.uid(),
      name: name || 'My profile',
      personal: {
        prefix: '',
        firstName: '',
        middleName: '',
        lastName: '',
        preferredName: '',
        pronouns: '',
        dob: '',
        nationality: '',
      },
      contact: {
        email: '',
        // A university or school address, for "Your primary college/university/school email".
        schoolEmail: '',
        phoneCountryCode: '',
        phone: '',
        phoneType: 'Mobile',
        preferredContact: 'Email',
      },
      address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '', organization: '' },
      links: { linkedin: '', github: '', portfolio: '', website: '', twitter: '' },
      job: {
        yearsExperience: '',
        authorized: '',
        sponsorship: '',
        relocate: '',
        over18: '',
        salary: '',
        noticePeriod: '',
        nonCompete: '',
        startDate: '',
        // A blank one counts as LinkedIn too (see DEFS['job.referralSource']).
        referralSource: 'LinkedIn',
        locations: '',
        otherOffers: '',
        // Countries you have the right to work in (blank: your nationality, and where you live if authorised).
        workCountries: '',
        // Happy to work in the office / on site full time; need adjustments in the recruitment process.
        onsite: '',
        adjustments: '',
        // Security clearance (defence / engineering): the level you hold, and whether you could get one.
        clearance: '',
        clearanceEligible: '',
      },
      eeo: {
        gender: '',
        race: '',
        hispanic: '',
        veteran: '',
        disability: '',
        sexualOrientation: '',
        genderIdentitySame: '',
        religion: '',
        neurodivergent: '',
        // UK social-mobility monitoring
        schoolType: '',
        freeSchoolMeals: '',
        parentsDegree: '',
        parentOccupation: '',
        postcodeAt14: '',
        careLeaver: '',
        carer: '',
        refugee: '',
        bursary: '',
      },
      // Conflicts of interest (banks and law firms ask these)
      compliance: {
        previouslyEmployed: '',
        previouslyApplied: '',
        relatives: '',
        relativesDetails: '',
        governmentOfficial: '',
        familyGovernmentOfficial: '',
        governmentDetails: '',
        // Declarations: a criminal conviction; regulatory or disciplinary action (fined, suspended, barred, a licence
        // revoked, charges pending)
        criminal: '',
        regulatory: '',
      },
      // Interview and assessment slots you can do: weekdays, hours, and dates you can't ("12–23 January 2027").
      availability: { days: 'Mon, Tue, Wed, Thu, Fri', from: '08:00', to: '20:00', unavailable: '' },
      education: [blankEducation()],
      experience: [blankExperience()],
      skills: '',
      languages: '',
      summary: '',
      coverLetter: '',
      customAnswers: [],
    };
  }

  /** Bring a stored profile up to the current schema without touching user data. */
  function upgradeProfile(profile) {
    const template = createProfile();
    delete template.id;
    delete template.name;
    const p = U.mergeDefaults(profile || {}, template);
    if (!p.id) p.id = U.uid();
    if (!p.name) p.name = 'My profile';
    p.education = (Array.isArray(p.education) ? p.education : []).map((e) => U.mergeDefaults(e, blankEducation()));
    p.experience = (Array.isArray(p.experience) ? p.experience : []).map((e) => U.mergeDefaults(e, blankExperience()));
    p.customAnswers = (Array.isArray(p.customAnswers) ? p.customAnswers : []).map((a) =>
      U.mergeDefaults(a, blankCustomAnswer()),
    );
    return p;
  }

  Object.assign(P, { blankCustomAnswer, blankEducation, blankExperience, createProfile, upgradeProfile });
})(typeof globalThis !== 'undefined' ? globalThis : this);
