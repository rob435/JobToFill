/*
 * JobToFill — field rules: how each control is recognised. RULES is one ordered list, and its order matters (the first
 * of equal scores wins); AUTOCOMPLETE maps autocomplete tokens to types. One of the parts lib/fields.js puts together
 * (loaded before it, in the order background.js lists them).
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});
  const U = JTF.util;
  const P = (JTF.fieldParts = JTF.fieldParts || {});
  const {
    AUTOFILL_UPLOAD,
    CHOICE,
    CV_NAMED,
    DAY_MONTH,
    INTERVIEW_SLOTS,
    LETTER_NAMED,
    LONG_TEXT,
    MONTH_RE,
    TEXTISH,
    TRANSCRIPT_NAMED,
    TWO_SANCTIONED_PLACES,
    YEAR_ASKED,
    hasHonorificOptions,
    hasYesNoOptions,
    qualsOf,
    subjectsNamed,
  } = P;

  // prettier-ignore
  const NAME_NOT = new RegExp([
    'first', 'last', 'middle', 'sur ?name', 'family', 'given', 'company', 'school', 'employer', 'business', 'organi',
    'user ?name', 'file', 'card', 'account', 'domain', 'reference', 'referr', 'referee', 'manager', 'supervisor',
    'emergency', '\\bpet\\b', 'street', 'city', 'place', 'country', 'state', 'recruiter', 'event', 'project', 'team',
    'nick', 'preferred', 'universit', 'college', 'institution', '\\bjob\\b', 'position', '\\brole\\b', 'product', 'course',
    'degree', 'program', 'display', 'screen', 'host', 'server', 'maiden', 'father', 'mother', 'parent', 'spouse',
    'guardian', '\\bkin\\b', 'contact person', 'signature', 'holder', 'bank', 'club', 'award', 'certif', 'hiring',
    'interviewer', 'employee', 'department', 'title', 'legal entity', 'brand', 'campaign', 'store', 'pronounc',
    'pronunciation', 'phonetic', 'module', 'chinese', 'native', 'local language', 'characters', 'script', 'kanji',
    'katakana', 'cyrillic',
  ].join('|'));

  const R = (type, re, opts) => Object.assign({ type, re }, opts || {});

  const CONSENT =
    /acknowledg|\b(answer|applicant|candidate|application) certification\b|\b(allow|permit|authori[sz]e) (us|[a-z]+) to (process|store|hold|use|retain) (your|my) (personal )?(data|information|details)\b|\bcertification of (answers|application|accuracy)\b|\bi (have )?(read|reviewed|understood)\b|\bi (hereby )?(confirm|agree|accept|consent|certify|attest|declare|understand)\b|\bconsent\b|privacy (notice|policy|statement)|notice at collection|data (protection|privacy|processing) (notice|policy|statement)|terms (and |& )?conditions|terms of (use|service)|\bgdpr\b|candidate (privacy|data) (notice|policy)|confidentiality (agreement|undertaking|notice|statement)|non ?disclosure (agreement|undertaking)|maintain (the )?(strict )?confidentiality|\b(the )?information (that )?i (have )?(provided|given|supplied|submitted|entered) (is|are|was) (true|accurate|correct|complete)\b/;
  const OPT_IN =
    /marketing|newsletter|promotion|(applicant|candidate|talent) (database|pool)|\bsms\b|text messages?|whats ?app|job alerts?|talent (community|network|pool)|future (opportunit|roles?|jobs?|vacanc|positions?|openings?)|other (roles|positions|opportunities|openings)|keep (me|my)|contact me|subscribe|\bupdates\b|share my (data|information|details) with|\bnews (and |& )?(events|updates)\b|\b(job|vacancy|posting) (posting )?notifications?\b/;

  const NEGATED = /\b(not|don t|do not|does not|decline|disagree|refuse|withdraw|object)\b/;

  /** One statement of an acknowledgement checklist: "I consent to…", never "I do not consent" or an opt-in. */
  function isAcknowledgement(text) {
    const t = U.normalize(text);
    return CONSENT.test(t) && !OPT_IN.test(t) && !NEGATED.test(t);
  }

  /** "US Dollar ($) / Euro (€)" or "Hourly / Monthly / Yearly": the units next to a salary, not the amount. */
  function looksLikeMoneyUnits(options) {
    const opts = (options || []).filter((o) => !JTF.matcher.isPlaceholder(U.normalize(o.text)));
    if (opts.length < 2) return false;
    const unit = (t) =>
      (!/\d/.test(t) &&
        /[$€£¥₹]|\b(dollars?|euros?|pounds?|yen|rupees?|francs?|usd|eur|gbp|chf|currency)\b/i.test(t)) ||
      /^(per )?(hour|hourly|day|daily|week|weekly|month|monthly|year|yearly|annual|annually|annum)$/i.test(t.trim());
    return opts.filter((o) => unit(o.text)).length / opts.length >= 0.6;
  }

  // Expiry dates of passports, visas and licences are not card expiry dates.
  const NOT_ID_DOCUMENT = /passport|visa|permit|licen[cs]e|certif|document|\bid\b/;

  // The whole number, its code included: "Mobile number (inc. country code)", "Telephone number (with international
  // dialling code)", "Phone number, including country and area code", "Mobile (incl. dialling code)", "Mobile phone
  // number (country code + number)", "Phone number (country code first)", "Mobile Number (+CountryCode)" (the matcher
  // reads that plus as a word), "…start with a + and then the country code".
  const WHOLE_NUMBER =
    /\b(start|begin)s? with\b|\b(inc|incl|including|include|with|plus|then|followed by) (the |your |a |an )?((country|international|dial(l)?ing|calling|area|and) )*code\b|\bcountry code (first|(and|plus|then|followed by) (your |the )?((phone|mobile|telephone) )?number)\b/;
  // Not the number: a code box ("Phone country", "Phone area code", "Enter the code sent to your mobile") unless the
  // code goes in with the number, an extension, fax, someone else's phone or a texting opt-in.
  const PHONE_NOT = new RegExp(
    `^(?!.*(${WHOLE_NUMBER.source})).*((?<!\\b(inc|incl|including|include|with|plus|then|the|your|a|by) )\\bcountry\\b|(?<!\\bcountry )\\bcode\\b)|` +
      /type|\bext\b|extension|fax|device|prefix|emergency|referr|reference|manager|supervisor|employer|company|business|organi[sz]ation|\bsms\b|text messag|consent/
        .source,
  );
  // "Alternative phone number", "Secondary phone", "WhatsApp number (if different)", "Landline": another number than
  // your mobile, which already goes in the form's main phone box. Left empty ("Phone (mobile or landline)" isn't).
  const OTHER_PHONE =
    /\b(alternat(e|ive)|alt|secondary|second|additional|other|another|backup|2nd) (phone|mobile|telephone|tel|cell|contact|number)\b|\bif (it is |its )?different\b|(?<!\b(mobile|cell|cellular) or )\bland ?line\b(?! or (mobile|cell))/;

  // Someone else's address ("Referrer's email", "Emergency contact email", Teamtailor's "Email address without domain":
  // a colleague's work address) or a second one of yours: never yours, even in a type="email" box.
  const OTHERS_EMAIL =
    /\b(referr\w*|referee|recruiter|manager|supervisor|emergency|friend|colleague|parent|guardian)\b.{0,40}\be ?mail\b|\be ?mail\b.{0,30}\bof (your |the |a )?(referr\w*|referee|recruiter|manager|supervisor|emergency contact|friend|colleague|parent|guardian)\b|\b(alternate|alternative|secondary|additional|backup|second) e ?mail\b|\bwithout (the |a |your )?domain\b/;

  // Order matters only for ties: put specific rules (and long questions that
  // mention other keywords, like "authorized to work in the country…") first.
  const RULES = [
    // Documents
    // "Please attach your cover letter and resume in a single combined document" takes the CV, and so does an upload
    // that names the CV with other documents ("Resume/CV/Transcripts", "CV and cover letter"): see uploadAlso.
    R('file.coverLetter', LETTER_NAMED, { kinds: ['file'], not: CV_NAMED }),
    R('file.transcript', TRANSCRIPT_NAMED, {
      kinds: ['file'],
      not: /\bcover ?letter\b/,
      // "Resume/CV/Transcripts" over Workday's "(transcripts are required for all US applications)" is the CV's.
      notAny: CV_NAMED,
    }),
    R('file.resume', /resume|\bcv\b|curriculum|lebenslauf|attach|upload|document|\bfile\b/, {
      kinds: ['file'],
      // "Autofill from resume" / "Apply with resume" read the file and rewrite the form: not the resume upload.
      // Nor Personio's "Other ( Optional )" or "Employment reference ( Optional )".
      not: /photo|picture|image|avatar|headshot|^(?!.*\b(resume|cv)\b).*(\b(portfolio|cover)\b|transcript)|certificat|passport|\bid\b|writing sample|^(upload )?(other|others|misc\w*|any other)( optional)?$|\b(employment |character |job )?references?\b|\b(other|additional|supporting|further) (\w+ )?(documents?|files?|attachments?|materials?)\b|auto ?fill|automatically fill|apply with (your )?(resume|cv)|pre ?fill|parse/,
      // An "Attach" button whose id or group says "cover letter" is not the resume upload.
      // So is a "Portfolio" upload, unless it also asks for the CV ("Resume / portfolio").
      // So is a code sample or a programming exercise ("If you would like to share a file of your code sample…",
      // "Write a program in C++ … Attach the file").
      notAny:
        /^(?!.*\b(resume|cv|curriculum)\b).*(cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation|\b(portfolio|work samples?)\b|\b(other|additional|supporting|further) (\w+ )?(documents?|files?|attachments?|materials?)\b|\bcode samples?\b|\bsamples? of (your )?code\b|\bwrite a (program|function|script)\b|\b(coding|programming) (exercise|task|assignment|challenge|test|question)\b|\bsource code\b|transcript)|writing sample|headshot|photo|passport/,
      // …unless what it says names the CV too: "Resume/CV/Transcripts" above a "(transcripts are required…)" note.
      unlessAny: CV_NAMED,
      // A CV reader that fills the form in ("AUTOFILL FOR SPEED, save time by uploading your cv" on CharlieHR, whose
      // file box is named "user_cv") is never the upload, whatever its name says.
      test: (desc) =>
        !['label', 'question', 'aria', 'nearby'].some((k) =>
          AUTOFILL_UPLOAD.test(U.normalize((desc.signals || {})[k])),
        ),
    }),

    // Passwords. "Passcode" and "One-time password" are the emailed code, not your password.
    R(
      'otp',
      /\b(one ?time|verification|confirmation|access|auth\w*|e ?mail(ed)?|sms|login|sign ?in) (pass ?)?(code|pin|passcode|password)\b|\bpass ?code\b|\botp\b|\b\d digit (code|pin)\b|\benter (the |your )?(code|pin)\b/,
      {
        kinds: ['text', 'tel', 'number', 'password'],
        not: /promo|coupon|discount|voucher|gift|referral|invit|postal|zip|area code|country|card|cvv|cvc|tax/,
      },
    ),
    R(
      'account.passwordConfirm',
      /confirm|re ?enter|re ?type|repeat|again|verify|verification|password ?(2|two)|pass ?2|wiederholen|confirmation/,
      { kinds: ['password'] },
    ),
    R('account.password', /pass|pwd|kennwort|contrase|mot de passe|\bpin\b|secret/, { kinds: ['password'] }),

    // Payment cards
    R(
      'cc.name',
      /card ?holder|name on (the |your )?card|(card|cc) ?(owner|name)|name (as it )?(appears )?on (your )?card|karteninhaber|titular de la tarjeta|nom du titulaire/,
      { not: /green card|permanent resident/ },
    ),
    R(
      'cc.exp',
      /(exp|expir\w*|valid|card|cc)\b.*\b(month|mm)\b|\b(month|mm)\b.*\b(exp|expir\w*)\b|\b(cc|card)month\b/,
      { part: 'month', not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.exp',
      /(exp|expir\w*|valid|card|cc)\b.*\b(year|yy|yyyy)\b|\b(year|yy|yyyy)\b.*\b(exp|expir\w*)\b|\b(cc|card)year\b/,
      { part: 'year', not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.exp',
      /expir|\bexp ?date|\bexp\b|valid (thru|through|until)|\bmm ?yy\b|gueltig|gultig|ablaufdatum|vencimiento|date d expiration|scadenza/,
      { not: NOT_ID_DOCUMENT },
    ),
    R(
      'cc.cvc',
      /\b(cvv2?|cvc2?|csc|cvn|cvd|ccv)\b|security ?code|card ?(security|verification) ?(code|number|value)?|card code|verification (number|value)|\bcid\b/,
      { not: /postal|zip|promo|coupon|gift|discount/ },
    ),
    R(
      'cc.number',
      /(card|cc|kreditkarten|tarjeta|carte) ?(number|no|num|nummer|numero)|credit ?card|debit ?card|card ?#|\bccnum|\bcard$/,
      // An identity card (HKID), student or membership card is not a payment card.
      {
        not: /type|name|holder|expir|exp date|cvv|cvc|security|zip|postal|brand|phone|gift|identity|\bid\b|hkid|national|passport|student|membership|loyalty|library|insurance|health/,
      },
    ),
    R('cc.type', /card ?(type|brand|network)|type of card/, { kinds: CHOICE }),

    // Screening questions (long sentences that mention other keywords)
    // US sanctions and export controls: "Are you a citizen or resident of Cuba, Iran, North Korea, Syria, or the Crimea
    // region…?", "…ordinarily resident in a comprehensively sanctioned country or region?", "…a national of any country
    // subject to US embargo (E:1/E:2 countries)?". Never your nationality, a citizenship or a refugee question.
    R(
      'compliance.sanctions',
      new RegExp(
        `\\b(sanction(s|ed)?|embargo(ed|es)?)\\b.*\\b(countr(y|ies)|regions?|territor(y|ies)|jurisdictions?|citizen\\w*|nationals?|nationality|residen\\w*|located|live|living|lived|based|ordinarily)\\b|\\b(countr(y|ies)|regions?|territor(y|ies)|jurisdictions?|citizen\\w*|nationals?|nationality|residen\\w*|located|ordinarily)\\b.*\\b(sanction(s|ed)?|embargo(ed|es)?)\\b|\\bsanctions (and|&) export controls?\\b|\\bexport controls? (and|&) sanctions\\b|\\bofac\\b|\\bcountry group e ?[12]\\b|\\be 1 (and |or )?e 2\\b|${TWO_SANCTIONED_PLACES.source}`,
      ),
      {
        kinds: CHOICE,
        // Not where you'd work or have been ("Are you willing to travel to Cuba or Iran?"), nor an ethnicity, nor a
        // list of US visas ("…sponsorship would include F-1 OPT, H-1B, … E-1/E-2, and E-3": treaty visas, not E:1/E:2).
        not: /\b(disciplinary|regulatory|professional|criminal)\b|\bsponsor\w*|\bvisas?\b|\bh ?1 ?b\b|\bimmigration\b|\bconsent\b|\b(willing|happy|open|prepared) to\b|\btravel\w*|\bvisit\w*|\bdo(ing)? business\b|\bethnic\w*|\brace\b|\bheritage\b|\bancestr\w*|\bdescent\b|\blanguages?\b/,
        // A lone box is a statement about you ("I am not a citizen or resident of…") or its "None of the above",
        // never an acknowledgement that mentions sanctions.
        test: (desc, hit) =>
          desc.kind !== 'checkbox' ||
          /\b(citizen\w*|nationals?|nationality|residen\w*|located|live|living)\b/.test(hit) ||
          TWO_SANCTIONED_PLACES.test(hit) ||
          /^(none|not applicable)\b|\bnone of\b/.test(U.normalize(((desc.options || [])[0] || {}).text)),
      },
    ),
    // "This role requires SC clearance…", "Are you eligible to obtain / willing to undergo a security clearance?"
    R(
      'job.clearanceEligible',
      /\b(eligib\w*|able|willing|prepared|happy|agree)\b.*\b(obtain|hold|undergo|apply for|get|gain|be granted|achieve|pass|go through|complete)\b.*\b(clearance|vetting)\b|\b(clearance|vetting)\b.*\b(eligib\w*|willing|able to obtain)\b|\b(requires?|required|subject to|need to (obtain|pass|hold))\b.*\b(security )?(clearance|vetting)\b/,
      // "…impacted if you are intending to travel… Are you intending to travel outside of the UK for 6 months or
      // more?" asks about your plans.
      { kinds: CHOICE.concat(['text']), not: /\b(intend\w*|plan\w*|going) to (travel|live|move|spend|stay)\b/ },
    ),
    // "Do you currently hold an active security clearance?", "Clearance level".
    R(
      'job.clearance',
      /\b(do|does|have|are) you (currently )?(hold|have|possess|been granted)\b.*\bclearance\b|\bclearance (level|status|held)\b|\b(current|active|existing) (security )?clearance\b|\bwhat (level of |type of )?(security )?clearance\b|^(security )?clearance$|\bnational security vetting\b/,
      { not: /\b(eligib|willing|prepared|obtain|undergo)/ },
    ),
    R(
      'job.authorized',
      /without (the )?(need for |requiring |needing |requirement of |any )?(employer |visa |company |immigration )?sponsor/,
    ),
    R(
      'job.sponsorship',
      /sponsor|visa (status|support|required|transfer|requirement)|\bh ?1 ?b\b|immigration (support|sponsorship|assistance)|require (a )?(work )?visa|\b(require|need)\b.{0,30}\b(work )?authori[sz]ation\b/,
      {
        not: /adjustments?\b|accommodat|\bvisitor visa\b|\bvisa to (enter|visit|travel)\b/,
        // "Do you have the right to work in the region? … Sponsorship is not available" and "This position does not
        // support visa sponsorship. Do you currently have the right to work in the UK?" ask for your right to work.
        test: (desc, hit) =>
          !/(^|\b(sponsor\w*|capacity|basis|available|offered|provided|possible) )(do|are) you (currently )?(have|hold|legally|lawfully)? ?(the )?(legal |permanent |full )?(right to work|authori[sz]ed|eligible|permitted|entitled)\b/.test(
            hit,
          ),
      },
    ),
    R(
      'job.authorized',
      /\b(authori[sz]ed|eligible|entitled|permitted|allowed) to (lawfully |legally )?work|work (authori[sz]ation|permit|eligibility)|employment (authori[sz]ation|eligibility)|eligib(le|ility) (for|to) (employment|work)|authori[sz]ation to work|rights? to work|legal rights? to|legally (work|employed)|\bimmigration status\b/,
      // "Will you in the future require authorization to work in the US?" asks whether you need sponsoring; "Will you
      // rely on a UK Graduate Route visa for your right to work…?" whether you hold a visa.
      {
        not: /\b(require|need)\b.{0,30}\b(work )?authori[sz]ation\b|\brely on (a |an |the |any )?(\w+ ){0,3}visa\b|\b(type|kind|basis|form|category) of (your )?(right to work|work authori[sz]ation|immigration status)\b/,
      },
    ),
    // "Are you able to work in the UK?" is about permission; "able to work on-site 5 days a week" is not.
    // Nor "…you will be able to work as of 22 February 2027 on a full-time basis…", which asks when you can start.
    R('job.authorized', /\bable to (lawfully |legally )?work\b/, {
      not: /\bon ?site\b|in (the |our )?office|in person|days (a|per) week|\bcommute|\bhybrid\b|\bshifts?\b|weekends?|overtime|consecutive|full ?time for|\bable to work (as of|from|starting|by|on) /,
    }),
    // "Do you hold a valid UK visa?" (never "a visa that allows you to work…", which asks for your right to work).
    // IK Partners' "What type of right to work in the UK do you hold?" [Citizenship/Nationality/… | … Visa | …].
    R(
      'job.rightType',
      /\b(type|kind|basis|form|category) of (your )?(right to work|work authori[sz]ation|immigration status)\b/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
      },
    ),
    // Capgemini's "Do you hold dual nationality?", Cambridge Consultants' "…any other (dual) nationality or citizenships?".
    R(
      'personal.dualNationality',
      /\bdual (nationality|nationalities|citizenship)\b|\b(any |an )?(other|another|second|additional|multiple) (\(dual\) |dual )?(nationalit(y|ies)|citizenships?)\b|\bcitizenship (of|for|in) (any )?other countr/,
      { kinds: CHOICE.concat(LONG_TEXT) },
    ),
    R(
      'job.visa',
      /^(do|does) you (currently )?(hold|have|possess)( a| an| any)?( valid| current| active)? (\w+ ){0,2}visas?\b|^(will|would|do) you (need to )?rely on (a |an |any )?(\w+ ){0,3}visas?\b/,
      {
        kinds: CHOICE,
        not: /\bsponsor|\bor\b.*\b(citizen|right to work|settled|indefinite|permanent|passport|residen)|\bif (yes|so)\b|\b(type|expir\w*|number)\b|\b(allows?|permits?|entitles?|lets) you to\b|(?<!\bright to )\bwork (in|for)\b/,
      },
    ),
    // "Are you able to commute into our London office?", "Do you live within commuting distance of our London office?"
    R(
      'location.commute',
      /\b(able|willing|happy|prepared) to commute\b|\bcommut\w* distance\b|\bcommutable\b|\b(can|could) you commute\b|\bcommute (in ?to|to) (our|the)\b/,
      { kinds: CHOICE.concat(['text']), not: /relocat/ },
    ),
    // "Are you located in London?", "Are you based in the UK?", "Are you currently living in the UK?"
    R(
      'location.in',
      /^(are|is) you (currently |presently |now )?(located|based|living|residing|resident|situated) (in|within|near|around|close to) |^do you (currently |presently )?(live|reside) (in|within|near|close to) /,
      {
        kinds: CHOICE.concat(['text']),
        not: /relocat|commut|willing/,
        test: (desc, hit) => JTF.geo.placesNamed(hit).length > 0,
      },
    ),
    // "Willing to work in London?", "Would you be willing to be based in our London office?", and "…onsite at our
    // Chicago office 5 days a week?" (job.onsite leaves offices somewhere in particular to this).
    R(
      'job.workIn',
      /\b(willing|happy|open|prepared) to (work|working|be based|be located|live|be)\b.*\b(in|at|from|out of|near)\b/,
      {
        kinds: CHOICE.concat(['text']),
        not: /relocat|commut|\bremote(ly)?\b/,
        test: (desc, hit) => JTF.geo.placesNamed(hit).length > 0,
      },
    ),
    R(
      'job.locations',
      /\b(first|second|top|1st|2nd) (choice|preference) (of )?(office|location|city)|\b(first|top) choice (office )?locations?\b|\blocations?\b.*\b(interested|prefer|willing|open to|relocat|consider|like to work|want to work)|\b(preferred|desired|target|ideal) (work |office |job |internship |role )?(locations?|offices?|cities)|\bwhich (other )?(offices?|locations?|cities)\b|\b(office|location|city) preferences?\b|where would you (like|prefer|want) to (work|be based)|\brelocat\w* (where|which (cities|locations|offices))\b|^where\b.*\brelocat/,
      // "…willing to relocate to one of the following locations New York… Please confirm" [Yes / No] is about relocating;
      // Netcraft's "Please confirm the length of role you're looking for and your preferred location" asks more.
      {
        not: /\b(length|duration) of (the )?(role|internship|placement|contract)\b/,
        test: (desc) => !hasYesNoOptions(desc),
      },
    ),
    R('job.relocate', /relocat/, { not: /adjustments?\b|accommodat/ }),
    R(
      'job.over18',
      /\b(18|eighteen)\b.*\b(years|older|age)\b|\b(at least|over|above|older than) (the age of )?(18|eighteen)\b|legal (working )?age|age of majority/,
    ),
    R(
      'job.referralSource',
      /how did you (first )?(hear|find|learn|come across|discover|get to know|connect with)|where did you (first )?(hear|find|learn|see|discover|come across)|hear(d)? about (us|this|the)|learn(ed)? about (us|this|the)|source of (application|referral|hire|candidate)|referral source|^source$|how were you referred|found (us|this|the job)|\b(become|became) aware of (us|this|the)\b/,
    ),
    R(
      'job.referralEvent',
      /\b(university|campus|careers?|recruitment|graduate) (events?|fairs?|societ(y|ies)|presentations?)\b/,
      // Maven's "Please select which event you attended or select 'N/A' if you did not attend" asks what you went to,
      // which your profile doesn't say.
      { kinds: CHOICE, not: /\battend(ed)?\b/ },
    ),
    R(
      'job.referred',
      /^(were|have) you (been )?referred\b|^did (a |an |any )?(current |existing )?(\w+ ){0,3}(employee|member of staff|staff member|colleague) refer you\b/,
      { kinds: CHOICE },
    ),
    R(
      'job.referrer',
      /\b(name|names|details|team)\b.{0,40}\breferr(er|al)s?\b|\breferred (to us |to you )?by\b.{0,80}\b(name|names)\b|\breferr(er|al) s? (name|full name)\b|\b(name|names) of (the )?(person|people|employee|colleague)s? who referred you\b/,
      { kinds: LONG_TEXT },
    ),
    // The list that follows "How did you first hear about BNY?" (Job Board → "Please select the specific source").
    R(
      'job.referralSource',
      /\b(specific|exact|detailed) source\b|\bsource (details?|name|specifics)\b|\bspecify (the |your )?source\b|\bwhich (job board|job site|jobs? website|social (media|network)( platform| site)?)\b/,
      { kinds: CHOICE },
    ),
    R(
      'job.salary',
      /salary|salari(al|ale|ales|o)\b|\bgehalt|\bpretentions?\b|\bstipendio\b|\bretribuzione\b|compensation|pay (expectation|range|requirement)|desired (pay|rate|wage)|expected (pay|wage|rate|ctc)|\b(current|present|desired) ctc\b|^ctc$|remuneration|\bwage\b|rate expectation|hourly rate|base pay/,
      {
        // The currency and pay-period pickers next to the amount ("salaryCurrency", "Desired Salary Type").
        not: /currenc|\bperiod\b|frequency|\b(salary|pay) (type|basis|unit)\b/,
        test: (desc) => !looksLikeMoneyUnits(desc.options),
      },
    ),
    R(
      'job.nonCompete',
      /non ?compete|non ?solicit|restrictive (covenant|agreement|clause)|garden leave|\bagreements? with (any )?(prior|previous|former|current|past) employers?\b|\b(may |might |could |that )?restrict (your|my) ability to (work|join)\b/,
    ),
    R(
      'job.noticePeriod',
      /notice ?period|notice (required|do you need)|how much notice|weeks notice|kundigungsfrist|\bpreavis\b|\bpreavviso\b/,
    ),
    R(
      'job.otherOffers',
      /\b(other|competing|outstanding|existing|pending) (job |internship |employment )?offers?\b|\boffers? (from|at|with) (other|another|any other) (firms?|compan|employers?|organi)|\boffers? (and|or|&) deadlines?|\bdeadlines? (we|that we) should\b|\bany (other )?(offers|deadlines)\b|\bexploding offer|\b(upcoming|pending|current|any) (offer )?deadlines?\b|\boffer deadlines?\b|\bdecision (deadlines?|timelines?)\b|\brecruiting timelines?\b|\btimelines? (we|that we) should\b|\baccepted an? (\w+ ){0,3}offer\b|\b(holding|hold) any (\w+ )?offers?\b|\b(other )?(processes|interviews) (and |or )?(offers|timelines)\b/,
      // Nominal's "Do you have any pending offers or deadlines we should know about? If so, what companies and dates?"
      // in one box takes your answer; a box of its own that starts "If so…" is the follow-up.
      { not: /^if (yes|so)\b|^(which|what) (firm|company)\b/ },
    ),
    // "Have you applied to Marshall Wace before?"
    R(
      'compliance.previouslyApplied',
      /\b(previously|ever|already) applied\b|\bapplied (to|for|with|at)\b.{0,60}\b(before|previously|in the past|last year|this year)\b|\bhave you applied (to|for|with)\b|\b(have|did) you (ever |previously )?(been )?interview(ed)? (with|at|for)\b(?!.*\b(affiliates?|portfolio|subsidiar\w*|group compan\w*)\b)/,
      // "If yes, when?" after it is its follow-up; "Have you ever applied… before? If yes, please list dates and
      // position." in one box is the question.
      { kinds: CHOICE.concat(LONG_TEXT), not: /^if (yes|so)\b|\bwhen and\b/ },
    ),
    // "Do you require any reasonable adjustments to participate in the recruitment process?"
    R(
      'job.adjustments',
      /\breasonable adjustments?\b|^(do|will|would) you (require|need|have) any (special|additional|access) (requirements?|arrangements?|needs)\b|\b(require|need|request)\b.{0,40}\b(adjustments?|accommodations?|support|(special|additional|access) (requirements?|arrangements?|needs|assistance))\b.{0,60}\b(recruitment|application|interview|assessment|selection|hiring)\b|\badjustments? (to|during|in|for) (the |our )?(recruitment|application|interview|assessment|selection)|\b(additional|special|access) (requirements?|needs)\b.{0,80}\b(interview|assessment|recruitment)\b/,
      {
        // A text box asking it as a yes/no question ("Do you require any special requirements if you are invited to
        // attend an interview?" on Phenom) takes the answer too; one asking what they are is left for you.
        kinds: CHOICE.concat(LONG_TEXT),
        test: (desc, text) =>
          CHOICE.includes(desc.kind) ||
          /^(do|does|will|would|are|is|have|has) (you|there)\b|\b(are|is) there\b|\b(do|will|would) you (require|need)\b/.test(
            text,
          ),
        not: /essential functions|housing|^if (yes|so)\b|^please (provide|give|tell|state|describe|list)/,
      },
    ),
    // "Are you willing to work in the office 5 days a week?" (where it is is the AI's to weigh up)
    R(
      'job.onsite',
      /\b(\d|two|three|four|five) days (a|per|each) week\b|\bfully in ?person\b|\bin (the )?office (full ?time|every day|daily)\b|\b(willing|able|happy|comfortable|open) to (work|be) (on ?site|onsite|in (the |our )?office|in person)\b|\bhybrid (work(ing)? )?(model|policy|arrangement)\b/,
      // An office somewhere in particular ("at our Jupiter, FL office", "onsite in San Francisco") depends on where
      // you live: left for the AI, which weighs it against your location and relocation answer.
      {
        kinds: CHOICE,
        not: /\bcommut|\bremote(ly)? only\b|\b(at|in) (our|the) (?!office\b|offices\b)[a-z]+( [a-z]+){0,2} (office|offices|headquarters|hq|campus|location)\b|\bon ?site (in|at) (?!(the|our) office\b)[a-z]/,
      },
    ),
    // Interview slots (see INTERVIEW_SLOTS), never an essay box or a working pattern ("Which days are you available to
    // work?").
    R('job.availability', INTERVIEW_SLOTS, {
      kinds: CHOICE.concat(LONG_TEXT),
      not: /\b(available|availability|dates?|start)\b.{0,20}\b(to|for) (the |this |our )?(work|start|begin|commence|join|intern(ship)?|placement|programme|program|employment|role|position)\b|\bshifts?\b|\bper week\b|\bhours per\b/,
    }),
    // "Approximately when do you expect to begin full time employment?" (Jane Street, of a student).
    R(
      'job.fullTimeStart',
      /\b(expect|plan|intend|anticipate|hope|looking|likely) to (begin|start|commence|enter|seek)\b.{0,30}\b(full ?time|permanent|graduate) (employment|work|job|role|position)s?\b|\b(begin|start|commence)\w* (full ?time|permanent) (employment|work)\b/,
      { kinds: CHOICE.concat(TEXTISH) },
    ),
    // "Do you require a visitor visa to enter the UK for your interviews?": a visit, not work sponsorship.
    R(
      'job.visitorVisa',
      /\bvisitor visa\b|\b(visa|eta|electronic travel authori[sz]ation) to (enter|visit|travel to)\b/,
      { kinds: CHOICE },
    ),
    R(
      'job.startDate',
      /when (can|could|would) you (like to |be able to )?(start|begin|join)|when (are|will) you (be )?(able|available) to (start|begin|join)|available (start|to start|to begin|from)|\bavailability\b|earliest (possible )?(start|date)|date (you are )?available|(desired|preferred) start|expected start|join(ing)? date|how soon|start (date|dates) (for|of) (the|this|your) (internship|placement|programme|program|role|position|job)|\bdate (that )?you (could|can|would|will) (start|begin|join)\b|\b(ready|available) for (full ?time )?(employment|work)\b|\beintritt\w*|\bdisponibilit[ea]\b|\bdate de debut\b|\b(will|would|could|can) (you )?be (able|available) to (start|begin|commence|join)\b|\b(what|which) date\b.*\bavailab|\bwhen (are|will|would) you (be )?available\b|\b(best|ideal|preferred|desired|earliest|possible|likely|proposed) start (date|time)\b|\b(free|ready|able) to (start|begin|commence|join)\b|\bwhen (are|do|would|will) you (aiming|planning|hoping|looking|intending|expecting|want|like) to (start|begin|join)\b|\bable to work (as of|from|starting( on| from)?|by) |\bable to work on (the )?\d/,
      { not: INTERVIEW_SLOTS },
    ),
    // "The internship runs from 1 July to 30 September 2027. Can you confirm that you are available…?"
    R(
      'job.startDate',
      new RegExp(`\\bfrom (\\d{1,2}(st|nd|rd|th)? )?(${MONTH_RE})\\b.*\\b(to|until|till|through)\\b.*\\bavailab`),
      { not: INTERVIEW_SLOTS },
    ),
    // "I confirm that the listed dates are suitable for me; 14th June – 22nd August": dates to check your start date
    // against (availableAnswer), not an acknowledgement. Without dates it stays one.
    R('job.startDate', /\bdates?\b.*\b(suits?|suitable|convenient|work for (me|you))\b/, {
      kinds: CHOICE,
      not: INTERVIEW_SLOTS,
      test: (desc, text) => DAY_MONTH.test(text) || /\b(19|20)\d{2}\b/.test(text),
    }),
    R(
      'job.yearsExperience',
      /years (of )?(relevant |professional |total |work |industry )?experience|how many years|experience in years|total experience|\byrs\b/,
    ),
    R(
      'job.currentCompany',
      /\b(current|present|most recent|latest) (job |role |position )(company|employer|organi[sz]ation)\b|current (company|employer|organi[sz]ation|workplace)|\b(which|what) (company|firm|organi[sz]ation|employer)\b.*\b(do you|you) (currently )?work (for|at)\b|present (company|employer)|most recent (company|employer)|^org$|latest employer|\b(employer|company|organi[sz]ation) (or (employer|company|organi[sz]ation) )?of your (most recent|current|latest)\b/,
    ),
    R(
      'job.currentTitle',
      /current (job )?(title|position|role|designation|occupation)|present (title|position|role)|most recent (job )?(title|position|role)|^headline$|professional headline|\b(title|position) of your (most recent|current|latest)\b/,
      // Pharus' "Most Recent Role Company" asks for the company.
      { not: /\b(role|position|job) (company|employer|organi[sz]ation)\b/ },
    ),

    // Acknowledgements ("I have read the privacy notice", "Acknowledge/Confirm"), never marketing opt-ins
    // A dropdown or Yes/No question can be an acknowledgement too ("…take a look at our privacy notice and confirm").
    // "I confirm that I will graduate in 2027" is a question about your date, answered from it, and so is "I confirm
    // that the listed dates are suitable for me; 14th June – 22nd August" (your start date).
    // A group of statements to tick ("you consent to our Applicant Privacy Statement" + "…to background checks")
    // too. Never an opt-in, even when only the name says "consent" (Ashby's SMS "communicationConsent").
    R('consent', CONSENT, {
      kinds: ['checkbox', 'checkboxes', 'select', 'combo', 'combobox', 'radio'],
      not: OPT_IN,
      notAny: OPT_IN,
      yieldsTo: ['edu.end', 'job.startDate'],
    }),
    R(
      'contact.other',
      /^(fax|pager|telex)( (number|no))?$|^(alternate|alternative|secondary|additional|backup|second|other) (e ?mail|email address|phone|phone number|telephone|mobile)( number)?$/,
      { kinds: TEXTISH },
    ),
    R('exp.supervisor', /^(supervisor|line manager|manager|reporting manager)( s)?( name| full name)?$/, {
      kinds: TEXTISH,
    }),
    R('edu.minor', /^minor( subject| field| area| concentration)?( of study)?$|^(your )?minor (subject|field|area)\b/),
    // Opt-ins ("Yes, Arma Partners can add me to the talent pool…", "Would you like to receive job alerts from us?",
    // "Sms Consent", "Do you agree to be contacted via WhatsApp?"): recognised, and left for you.
    R('optIn', OPT_IN, {
      kinds: ['checkbox', 'checkboxes', 'select', 'combo', 'combobox', 'radio'],
      test: (desc, text) =>
        /\b(agree|consent|allow|permit|can|may|happy|receive|opt in|sign (me )?up|subscribe|add me|contact(ed)? me|retain|like to (be|join|hear))\b/.test(
          text,
        ),
    }),
    // "I'm not a robot" as a plain <input type="checkbox">. A CAPTCHA widget's own box (role="checkbox" inside
    // reCAPTCHA's frame) is never one: those are left for you.
    R(
      'human',
      /\b(i m |i am )?not a (ro ?bot|bot)\b|\bi am (a )?human\b|\b(confirm|verify|prove) (that )?(you are|you re|i am|i m) (a )?human\b|\bhuman verification\b/,
      { kinds: ['checkbox'], test: (desc) => desc.inputType === 'checkbox' },
    ),

    // Conflicts of interest: government officials / PEPs (you, your family), relatives here, worked here before.
    // EEO notices ("Government officials engaged in enforcing laws…") are not questions.
    R(
      'compliance.government',
      /\bgovernment (official|employee|position|role|connection|body|agency|department|entity|minister)s?\b|\bgovernment (or regulatory )?authorit(y|ies)\b|\bpublic (official|office|servant)s?\b|\bpolitically exposed|\bpeps?\b|\bstate ?owned (entit|enterprise|compan|business)|\bforeign (government )?official|\bcivil servant|\binvolved (in|with) (the )?(government|politics)\b|\b(public|political|government) (office|position|appointment)s?\b|\bpublic (function|trust|role|post)s?\b|\bprominent public\b|\bsenior political figure/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /\bengaged in enforcing\b|\benforcing (the )?laws?\b|\bequal (employment|opportunity)\b|\bfederal contractor|\bgovernment (contracts?|contractors?|funding|grants?)\b|\bvisa\b|\bsponsor/,
      },
    ),
    // Not about the company's auditors ("…employed by Ernst & Young, that engages in audit work?").
    R(
      'compliance.relatives',
      /\b(related to|relatives?|family members?|immediate family|spouse|domestic partner|close (personal )?relationship)\b.*\b(work|works|working|worked|employ|employed|employee|employees|staff)\b|\b(know|related to) any ?one (who )?(currently )?(works?|working|employed|at)\b|\b(personal|family|romantic|intimate|close) relationships? with\b.*\b(employees?|employed|staff|work\w*|current|affiliates?|subsidiar\w*|colleagues?)\b|\b(employees?|staff)\b.*\b(with whom )?you have (a |an |any )?(personal|family|romantic|close) relationship\b|\b(connected|connections?) (to|with) (any )?(current |existing )?(employees?|staff)\b/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /government|public official|politically|referr|refer you|emergency|\b(ernst|ey|deloitte|pwc|pricewaterhouse\w*|kpmg|auditors?|audit)\b/,
      },
    ),
    // SpaceX's "SpaceX & SpaceXAI Employment History" [I have never worked for SpaceX… | I am a former … employee…].
    R('compliance.previouslyEmployed', /\bemployment history\b/, {
      kinds: CHOICE,
      test: (desc) =>
        (desc.options || []).some((o) =>
          /\b(never|formerly) worked\b|\b(former|current) \w* ?employee\b/i.test(o.text),
        ),
    }),
    R(
      'compliance.previouslyEmployed',
      /^(do|are) you (currently |presently )?(work|working|employed) (for|by|at|with) (us|our (company|firm|group|organi[sz]ation|business))\b|\b(previously|ever|before) (completed|done|undertaken|had) (an? )?(internship|placement|work placement|work experience)\b.*\b(at|with|for)\b|\b(previously|ever|formerly|before|in the past) (been )?(worked|employed|work|been employed|interned)\b.*\b(for|at|by|with)\b|\b(current or former|former|ex) (employee|staff member|intern)\b|\bhave you (ever )?worked (for|at|with) (us|our)\b|\bworked (for|at) [a-z ]+ (before|previously|in the past)\b|\bbeen employed (by|at|with) [a-z ]+ (before|previously|in the past)\b/,
      {
        kinds: CHOICE.concat(LONG_TEXT),
        not: /\bapplied\b|\binterview|\brelated|famil|relative|\bin (finance|banking|consulting|the industry|a similar)|\b(ernst|ey|deloitte|pwc|pricewaterhouse\w*|kpmg|auditors?|audit)\b/,
      },
    ),
    // "Have you ever been convicted of a criminal offence?", "Do you have any unspent convictions?". Never a check you'd
    // agree to or undergo.
    R(
      'compliance.criminal',
      /\b(convicted|convictions?|criminal (record|offen[cs]es?|history|charges?|proceedings?|cases?)|unspent|(pleaded|pled) (guilty|no contest)|nolo contendere|felon(y|ies)|misdemeanou?rs?)\b/,
      {
        kinds: CHOICE,
        not: /\b(consent|willing|agree|authori[sz]e|undergo|happy to|prepared to|able to pass|background (check|screen)\w*|dbs check)\b/,
      },
    ),
    // "…any administrative or regulatory charges pending against you; been fined, or had a license revoked…", "Have you
    // ever been suspended or barred … by the Public Company Accounting Oversight Board?"
    R(
      'compliance.regulatory',
      /\b(regulatory|disciplinary|administrative|enforcement) (actions?|charges?|proceedings?|investigations?|sanctions?|history|matters?|complaints?|orders?|measures?)\b|\b(suspended|barred|expelled|censured|debarred|disqualified|struck off)\b.*\b(regulat\w*|oversight|authorit(y|ies)|exchanges?|finra|sec|fca|pra|pcaob|nfa|cftc|licen[cs]es?|registrations?|membership|professional body|association|issuer|entity)\b|\blicen[cs]es?\b.{0,40}\b(revoked|suspended|denied|withdrawn)\b|\b(revoked|suspended|denied|withdrawn|refused)\b.{0,40}\blicen[cs]es?\b|\bsubject to (an? |any )?(order|judge?ment|decree|sanction)s?\b.*\b(banking|securities|investment|financial|insurance|commodit\w*)\b|\bfined\b.*\b(regulat\w*|authorit\w*|exchange|finra|fca)\b/,
      { kinds: CHOICE, not: /\b(willing|happy to|prepared to|able to|consent|agree)\b|\bdriv(ing|er s?)\b/ },
    ),

    // Voluntary self-identification
    // Sexual orientation, gender identity vs sex at birth, LGBTQ+, religion, neurodiversity.
    R('eeo.sexualOrientation', /\bsexual orientation\b|\bsexuality\b|\borientation\b/, { kinds: CHOICE }),
    R(
      'eeo.genderIdentitySame',
      /\b(same as|match(es)?|differ\w* from)\b.*\b(sex|gender)\b.*\b(registered|assigned|recorded) at birth\b|\b(registered|assigned) at birth\b|\bidentify as trans(gender)?\b|\bare you trans(gender)?\b|\btrans (history|experience)\b/,
      { kinds: CHOICE },
    ),
    R('eeo.lgbt', /\blgbt|\blgbq|\bidentify as (part of the )?(queer|lgb)/, { kinds: CHOICE }),
    // Northern Ireland's equality monitoring ("…we are legally obliged to gather community data and gender…").
    R('eeo.community', /\bcommunity background\b|\b(roman catholic|protestant) community\b/, { kinds: CHOICE }),
    R('eeo.religion', /\breligio|\bfaith\b|\bbelief\b/, { kinds: CHOICE }),
    R(
      'eeo.neurodivergent',
      /\bneuro ?(divergen|diverse|diversity|atypical)|\bneurodivergent\b|\bdyslexi|\badhd\b|\bautis|\bdyspraxi/,
      // "Do you have a disability or long-term health condition including … neurodiversity?" is the disability one.
      { kinds: CHOICE, not: /\bdisabilit|long ?term (health )?condition|\bimpairment/ },
    ),
    R('eeo.hispanic', /hispanic|latin[oax]\b/, { kinds: CHOICE }),
    R('eeo.race', /\brace\b|ethnic/, { kinds: CHOICE }),
    // IK Partners' "How would you describe your ethnic origin?" in a text box: your answer, as you gave it.
    R('eeo.race', /\bethnic(ity| origin| background| group)\b/, {
      kinds: LONG_TEXT,
      test: (desc, text) => /^(how would you describe|what is|please (state|describe|tell us))\b|^ethnic/.test(text),
    }),
    // Not a date a veteran gives (Oracle's "Veteran First Civilian Start Date" in Day / Month / Year lists, where "No"
    // would pick November).
    R('eeo.veteran', /veteran|military (service|status)|armed forces|served in the/, {
      kinds: CHOICE,
      not: /\bdates?\b|\bwhen\b/,
    }),
    R('eeo.disability', /disabilit|disabled|handicap|impairment/, { kinds: CHOICE, not: /adjustments?\b|accommodat/ }),
    // "Would you consider yourself having any type of impairment? If yes, please describe." in a text box: Yes or No
    // (what it is, you describe).
    R('eeo.disability', /disabilit|disabled|impairment/, {
      kinds: LONG_TEXT,
      not: /adjustments?\b|accommodat/,
      test: (desc, text) => /^(do|would|are|have|is)\b/.test(text),
    }),
    R('eeo.gender', /\bgender\b|\bsex\b|geschlecht|\bgenre\b|\bsexo\b/, {
      not: /orientation|transgender|same as|(registered|assigned) at birth|\bpronouns?\b/,
    }),
    // UK social-mobility monitoring
    // "Were you eligible for free school meals?", "…receive FSM", pupil premium, the US free or reduced-price lunch.
    R(
      'eeo.freeSchoolMeals',
      /free school (meals?|lunch(es)?)|\bfsm\b|pupil premium|free (or|and|\/) reduced( price| cost)? (school )?(lunch|meals?)|reduced (price )?(school )?lunch/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.incomeSupport',
      /\bincome support\b|\bmeans tested (benefits?|support)\b|\b(household|family|parents?) (received?|claimed?|on) (state )?benefits\b/,
      { kinds: CHOICE },
    ),
    R('eeo.postcodeAt14', /\bpost ?code\b.*\b(14|fourteen)\b|\b(14|fourteen)\b.*\bpost ?code\b/, { kinds: TEXTISH }),
    R(
      'eeo.careLeaver',
      /\bcare leaver\b|\bin the care of (a |the )?(local authority|council|social services|state)\b|\b(been|grew up|lived|were you|spent time|time) in (local authority |foster |residential |social )?care\b|\blooked after (child|young person|by (a|the) local authority)|\bfoster(ed)? care\b|\blocal authority care\b|\bin the care system\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.carer',
      /\b(young |unpaid |primary |family )?carer\b|\bcaring responsibilit|\bcare for (a|an|someone) (family member|relative|friend|disabled|ill|elderly)|\blook after (a|an|someone) (family member|relative|disabled|ill|elderly)/,
      { kinds: CHOICE },
    ),
    // A refugee diversity question, never the refugee / asylee lines of a work-authorisation list.
    R(
      'eeo.refugee',
      /\b(are|were) you (a |an )?(refugee|asylum seeker)|\brefugee (or|and|\/) asylum|\basylum seeker\b|\brefugee (status|background|experience)\b|\bcame to the uk as a refugee\b/,
      {
        kinds: CHOICE,
        not: /\bu ?s ?c\b|\b115[78]\b|\basylee\b|work authori|employment eligib|eligib\w* to work|lawful(ly)? permanent|green card|export|\bvisa\b|citizen/,
      },
    ),
    R(
      'eeo.bursary',
      /\bbursar(y|ies)\b|\bmaintenance (grant|loan)s?\b|\bmeans ?tested (grant|support|bursary|funding|financial)|\bfinancial (support|aid) (from|at) (your )?universit/,
      { kinds: CHOICE, not: /independent|fee paying|private school|school type|type of school|\bschool you\b/ },
    ),
    R(
      'eeo.schoolType',
      /\b(type|kind) of school\b|\bschool type\b|\bschool did you (mainly )?attend\b|\bstate (school|run|funded)\b.*\b(independent|private|fee)|\bfee paying\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.parentsDegree',
      /\bparents?\b.*\b(universit|degree|higher education|college|qualification)|\bguardians?\b.*\b(universit|degree|higher education|qualification)|\bfirst (person |member |one )?(in|of) (your|my) (immediate )?family\b.*\b(universit|college|higher education|degree)|\b(universit|college|higher education)\w*\b.*\bfirst (person |member |one )?(in|of) (your|my) (immediate )?family\b|\bfirst generation (student|university|college)|\b(qualifications?|degree|universit\w*|education)\b.*\b(parents?|guardians?)\b/,
      { kinds: CHOICE },
    ),
    R(
      'eeo.parentOccupation',
      /\b(main|highest) (household )?(income )?earner\b|\bhousehold earner\b|\boccupation of your (main )?(parent|household)|\bparents?\b.*\b(occupation|job)\b|\b(aged?|when you were) (about )?14\b/,
      { kinds: CHOICE },
    ),
    R('eeo.socioEconomic', /\bsocio ?economic\b|\bsocial (class|background)\b|\bworking class\b/, { kinds: CHOICE }),
    R(
      'eeo.organisations',
      /\b(participated|taken part|took part|been (involved|a member|part)|member of|involved (in|with)|affiliated)\b.*\b(following|these|any of the)\b.*\b(organi[sz]ations?|associations?|networks?)\b|\b(which|any) of (the following|these) (organi[sz]ations?|associations?|networks?)\b.*\b(participated|taken part|took part|involved|member|affiliated)\b/,
      { kinds: CHOICE },
    ),
    R('pronouns', /\bpronouns?\b/), // not "how your name is pronounced"
    R(
      'dob',
      /birth ?(date|day)|date of birth|\bdob\b|\bbday\b|birthday|geburtsdatum|fecha de nacimiento|date de naissance|data di nascita/,
      { not: /place|city|country|town/ },
    ),
    R(
      'age',
      /^(your |current )?age\b(?! of)|\bwhat is your (current )?age\b|\bhow old are you\b|\bage (range|group|bracket|band)\b/,
      {
        not: /\b(18|eighteen|16|21)\b|\bover\b|at least|older|minimum|legal/,
      },
    ),

    // Links (before names and websites)
    R('links.linkedin', /linked ?in/),
    R('links.github', /git ?hub/),
    R('links.twitter', /twitter|\bx com\b|\bx (handle|profile|username)\b/),
    R('links.portfolio', /portfolio|dribbble|behance|work samples?/, {
      not: /portfolio (compan|firms?|businesses|manag|construct|optimi|investment)/,
    }),
    R(
      'links.website',
      /web ?site|web ?page|personal (site|page|url|link|blog)|home ?page|\bblog\b|\burls?\b|\blinks?\b|online (profile|presence)|other (website|link|url|profile)/,
      {
        not: /linked ?in|git ?hub|twitter|company|employer|referr/,
      },
    ),

    // Education
    R(
      'edu.level',
      /highest (level of )?(completed |finished |attained )?(education|degree|qualification|academic)|education(al)? (level|attainment|background|qualification)|level of (education|study|degree)/,
      {
        not: /fields? of study|\bsubjects?\b|\bmajors?\b|\bdisciplines?\b|\bparents?\b|guardian|mother|father|\bqualifications\b.*\b(including|with)\b.*\b(grades?|results?|dates?)\b/,
      },
    ),
    R(
      'edu.end',
      /\bgraduat(ion|ed|e|ing)\b|expected graduation|completion (date|year)|year of (graduation|completion|passing)|class of|passing year|(?<!\b(school|academic|study|class) )year (graduated|completed)|\b(course|degree|studies|programme|program) (finish|end|complete)s?\b|\b(finish|finishing|complete|completing|end|ending) (your |my |the |this )?(most recent |latest |current )?(university |college |undergraduate |current |academic )?(course|degree|studies|programme|program|qualification)\b|\bend (date |year )?of (your |the )?(course|degree|studies)\b|\bleav(e|ing) (academia|university|full time education)\b|\b(finish|finished|complete|completed|leave|left) (high school|secondary school|secondary education|sixth form|(your )?a levels?)\b/,
      {
        // "undergraduate" no longer matches (\b), so "graduation year (undergraduate degrees…)" is still a date.
        // "Graduate Engineer / Summer Internship" is a job for graduates, not a date. "What year did you graduate from
        // high school?" is your school's date (eduLevelOf), "Do you expect to graduate with honours?" about the class.
        not: /^(did|have) you|^are you (a |an )?(recent |new |high school |college |university )?(graduate|grad|undergrad)s?\b|\b(after|before|once) (completing|finishing)\b|\binterested in\b|\bopportunit|post ?grad|\bgraduate (degree|school|program|student)|\bgraduate (engineer|analyst|scheme|role|position|job|programme|trainee|consultant|developer|intake|associate|internship)s?\b|\bgpa\b|\bgrades?\b|\bwith (first class )?(honou?rs|distinction|merit|a (first|2 ?1|2 ?2))\b/,
      },
    ),
    // "What year did you begin your undergraduate (e.g. Bachelor's) degree?", "When did you start your studies?".
    R(
      'edu.start',
      /\b(year|date|when)\b.*\b(did|do|will) you (begin|start|commence|enrol+|enter)\b.*\b(degree|studies|course|program(me)?|universit\w*|college|undergrad\w*|bachelor\w*|master\w*|ph ?d|doctora\w*)\b|\b(began|started|commenced) (your )?(\w+ )?(degree|studies|course|program(me)?)\b/,
      { not: /\b(job|employment|work|internship|placement|role|position)\b/ },
    ),
    // DN Capital's "Please state your higher educational qualifications, including (current) grade and starting and
    // (expected) graduating date": every degree with its grade and dates.
    R(
      'edu.summary',
      /\b(state|list|give|provide|detail|enter|summari[sz]e)\b.{0,30}\b(qualifications|degrees)\b.*\b(grades?|results?|classifications?|dates?|graduat\w*)\b/,
      { kinds: LONG_TEXT },
    ),
    // "Did you complete UK A-levels? Yes or No. If yes, please provide your A-Level subjects…" (Eastdil).
    R(
      'edu.qualification',
      /^(did|do|have) you (\w+ )?(complete|completed|take|taken|sit|sat|study|studied|have|hold|achieve|achieved|do|done) (any |the |your )?(uk |english |scottish |irish )?(a levels?|as levels?|(advanced )?highers|ib|international baccalaureate|gcses?|btecs?|leaving cert\w*|abitur)\b/,
      { kinds: CHOICE },
    ),
    // "If you didn't complete UK A-levels, please provide your equivalent high school qualification and results".
    R(
      'edu.equivalent',
      /\bif you (did not|didn t|have not|haven t|do not|don t) (\w+ )?(complete|completed|take|taken|sit|sat|study|studied|have|hold|achieve|achieved|do|done) (any |the |your )?(uk |english |scottish |irish )?(a levels?|as levels?|(advanced )?highers|ib|international baccalaureate|gcses?|btecs?|leaving cert\w*|abitur)\b.*\bequivalent\b/,
      { kinds: LONG_TEXT },
    ),
    R(
      'edu.majorIn',
      /^(are|were|is|do|did) (you|your)\b.*\b(majors?|majoring|degree|studying|pursuing|disciplines?|subjects?|fields?)\b/,
      { kinds: CHOICE, test: (desc, text) => subjectsNamed(text).length > 0 },
    ),
    R(
      'edu.attended',
      /\b(currently|ever) (or have you (ever )?)?attended (a )?(university|college|higher education)\b|\b(studying|studied) for,? or (have you )?(completed|obtained|achieved)\b/,
      { kinds: CHOICE },
    ),
    R(
      'edu.inCountry',
      /^(are|were|did|have) you\b.*\b(studying|studied|study|completed|complete|obtained|obtaining)\b.{0,50}\b(degree|studies|course|qualification)\b.{0,15}\bin (the )?[a-z]/,
      { kinds: CHOICE, test: (desc, text) => JTF.geo.placesNamed(text).some((pl) => pl.type !== 'metro') },
    ),
    // AAB's "Secondary/Academy School Dates Attended", "University Dates Attended": the entry's dates in one box. Not
    // the two boxes of a range picker under the same label (Ant Design's "Start date" and "End date").
    R(
      'edu.dates',
      /\bdates? (attended|of (attendance|study|studies))\b|\b(period|dates) of study\b|\battendance dates\b/,
      {
        kinds: TEXTISH,
        test: (desc) =>
          !/^(start|end|from|to|begin|finish)( date)?$/.test(
            U.normalize((desc.signals || {}).placeholder || desc.placeholderRaw || ''),
          ),
      },
    ),
    R(
      'edu.completed',
      /^have you (already |now )?graduated\b|\b(have|has) you (already |now )?(completed|finished|graduated from) (your |all your )(\w+ )?(studies|degree|course|university|education|programme|program)\b|\bconfirm (that )?you have (already )?(completed|finished|graduated)\b|\b(degree|qualification|studies|course)\b.{0,20}\b(completed|complete|achieved|awarded|finished) or (still )?(predicted|expected|ongoing|in progress|pending)\b/,
      { kinds: CHOICE },
    ),
    R(
      'edu.enrolled',
      /\benrol+(ment|ed) status\b|\b(are|were) you (currently )?(enrol+ed|a (current )?student)\b|\bcurrent(ly)? (enrol+ed|study status|student status)\b|\b(study|student) status\b|^(are|were) you (currently |presently |now )?(a |an )?(current |full ?time )?(undergrad\w*|post ?grad\w*|graduate|masters?|phd|doctoral) student\b|^(are|were) you (currently |presently |now )?(studying|pursuing|undertaking|doing|completing|enrol+ed (in|on))( or (studying|completing|undertaking|pursuing))? (for )?(a |an |towards a )?(course of study at )?(\w+ ){0,3}(degree|m ?sc|m ?a|mba|ph ?d|masters?|bachelor\w*|post ?grad\w*|undergrad\w*|qualification|degree level)\b/,
      {
        kinds: CHOICE.concat(['textarea']),
        // "Are you currently an undergraduate student?" is about your level; "…expected graduation" is a date.
        not: /(?<!\bpost )\bgraduat(?!e students?\b)|\byear\b|\bdegree subject\b|\bmajor\b|\b(which|what|name of (the|your)) (university|school|college|institution)\b/,
      },
    ),
    R('edu.year', YEAR_ASKED, { kinds: CHOICE, not: /graduat|\b(19|20)\d{2}\b|\bnext\b|\bwill be\b/ }),
    R(
      'edu.year',
      /\bdegree status\b|\bstatus of (your )?degree\b|\b(school|academic|study|class) year (you will have )?(completed|finished) by\b|\b(current |academic )?year of (study|studies|university|uni|college|degree|course|your (degree|course|studies|programme|program))\b|\b(what|which) year (of (your )?(study|studies|university|uni|degree|course|programme|program) )?are you (currently )?in\b|\bstudy year\b|\bcurrent year\b.*\b(study|studies|university|degree|course)\b|\byear in (school|university|college)\b|\bclass standing\b|\bacademic standing\b/,
      {
        // "If you are in your first year of studies and yet to receive your results, please type 'N/A'" asks for results.
        not: /graduat|\bstart(?!s? of (summer|spring|autumn|fall|winter))|\bbegan|\bbegin(?!ning of (summer|spring|autumn|fall|winter))|\b(?<!year )complet|\b(?<!year )finish|\bentry|\bentered|high school|secondary|a levels?\b|gcse|\bresults?\b|\bgrades?\b|\bmarks\b/,
      },
    ),
    // "Which university are you enrolled in, or from which institution did you receive your most recent degree?"
    R(
      'edu.school',
      /^(which|what) (university|school|college|institution)\b|\b(confirm|tell us|select|choose|state|indicate) (which|what) (university|school|college|institution)\b|^name of (the |your )?(university|college)\b|^educator$|^educational (establishment|institution|provider)$/,
      {
        not: /\b(university|college) degree\b|\b(university|college|school) (course|programme|program|subject)s?\b|\bschool (type|diploma|grades?|did you attend)\b|type of school|\bgraduat\w* (year|date)|\byear\b|\bgpa\b|\bcity\b|\bcountry\b|\blocation\b/,
      },
    ),
    // "University Course" is what you study there, not the university.
    R(
      'edu.school',
      /\bschool\b|universit|college|institut(e|ion)|alma mater|academy|hochschule|\becole\b|universidad/,
      {
        not: /high school (diploma|graduate|completion)|degree|major|minor|gpa|\byear\b|\bdates?\b|\bstart|\bend\b|(?<!\b(under|post ?))graduat|\blocation\b|\bcity\b|(?<!\b(please|kindly) )\bstate\b|country|^(did|have|has|are|do|does|were|was|will|would|can|is) you\b|e ?mail|address|transcript|meals|type of school|school type|kind of school|fee paying|state school|grammar school|grading|\bscale\b|\bcourses?\b|\bevents?\b|\bfairs?\b|\bsociet(y|ies)\b/,
      },
    ),
    // "State/City/Region of School", "School Location", "City of university": where that school is.
    R(
      'edu.location',
      /\b(city|town|state|region|location|province|county|place)\b.*\b(school|universit\w*|college|institution|campus)\b|\b(school|universit\w*|college|institution|campus) (city|town|state|region|location|province|county)\b/,
      {
        kinds: TEXTISH.concat(CHOICE),
        not: /\bcountry\b|type of school|\bschool type\b|state (school|run|funded)|grammar|fee paying|independent|private|\b(14|fourteen|aged?)\b|post ?code|\bzip\b|^(are|do|did|have|were|was) you\b/,
      },
    ),
    // "Country of School", "Institution country", "Country where you obtained your degree"; "Country of Employer".
    R(
      'edu.country',
      /\bcountr(y|ies)\b.*\b(school|universit\w*|college|institution|campus|studies|studied|degree)\b|\b(school|universit\w*|college|institution|campus)\b.*\bcountr(y|ies)\b/,
      {
        not: /\b(want|wish|like|prefer\w*|plan|intend|interested)\b|citizen|nationalit|\bbirth\b|residen|\blive\b|\bwork\b|\bvisa\b|authori|\bphone\b|\bcode\b|which countries/,
      },
    ),
    R(
      'exp.country',
      /\bcountr(y|ies)\b.*\b(employer|company|organi[sz]ation|employment|workplace)\b|\b(employer|company|organi[sz]ation|employment|workplace)\b.*\bcountr(y|ies)\b/,
      {
        not: /\b(want|wish|like|prefer\w*|plan|intend|interested|seek\w*|looking|desired|apply\w*)\b|citizen|nationalit|\bbirth\b|residen|\blive\b|\bvisa\b|authori|\bphone\b|\bcode\b|which countries|headquarter|\bhq\b|\bthis (role|position|job)\b/,
      },
    ),
    // "Expected/Achieved Degree Classification", "Predicted degree class", "Degree result", "Final degree grade (or
    // predicted)": your class, never the degree. A-level grades, UCAS points and "role classification" are not, and
    // "Overall Result (GPA)" (Workday) asks for the GPA.
    R(
      'edu.classification',
      /\bclassification\b|\bclass of (your |the )?degree\b|\bdegree class\b|\bhonou?rs (class|classification|level|grade)\b|\bclass of honou?rs\b|\b(predicted|expected|achieved|anticipated|projected|final|actual|overall)( or (predicted|expected|achieved))? (degree )?(class(es)?|grades?|results?|outcomes?|honou?rs)\b|\bdegree (grade|result|outcome)s?\b|^honou?rs$/,
      {
        not: /\b(role|job|position|security|visa|employment|worker|tax|data|risk|occupation\w*|industry|product)\b classification|a levels?|\bas levels?\b|gcses?|ucas|highers|\bib\b|baccalaureat|btec|leaving cert|school|sixth form|\bmodules?\b|\bgpa\b|\bcgpa\b|grade point|^(do|are|have|will|did|would|can) you\b/,
      },
    ),
    // "What degree are you currently pursuing?" asks for a degree; "Are you pursuing a degree?" is yes/no.
    R(
      'edu.degree',
      /\b(what|which) (type of |kind of )?degree\b|\b(what|which) (\w+ ){1,5}degree (qualification|type|have you|did you|will you|are you)\b|\b(type|kind|name) of (the |your )?degree\b|\bdegree (type|name|title|program(me)?)\b|\bdegree (are you|you are|you re|will you be) (currently )?(pursuing|studying|completing|enrolled|working|seeking|undertaking|earning|obtaining)/,
      {
        not: /major|field|subject|discipline|categor|\bstatus\b|\byear\b|\bmonth\b|\bdate\b|minimum|equivalent|\bclass\b|classification|\bgrades?\b|\bresults?\b/,
        test: (desc) => !hasYesNoOptions(desc),
      },
    ),
    R('edu.degree', /\bdegree\b|qualification|diploma|\baward\b/, {
      not: /major|field|subject|discipline|categor|\byear\b|\bdate\b|level of|highest|degree of|\bdid you|have you|do you|are you|minimum|equivalent|\bclass\b|classification|\bgpa\b|\bgrades?\b|\bscore\b|\bresults?\b|\boutcome\b/,
      test: (desc) => !hasYesNoOptions(desc),
    }),
    R(
      'edu.field',
      /\bcategor(y|ies)\b.*\b(degree|course|studies|subject)\b|fields? of study|\bmajors?\b|\bdisciplines?\b|concentration|area of study|speciali[sz]ation|course of study|program(me)? of study|\bsubjects?\b|study (field|area)|^(your |main |academic )?field$|\bfield (studied|of expertise)\b|course name/,
      {
        not: /minor|\b(secondary|second|additional|double|joint|other) (major|field|subject|discipline)|\bdid\b|field (sales|service|work|engineer|marketing|operations)|form ?field|field ?(set|label|wrapper|group|container|row|section|input)|\bsubjects? to\b|export control/,
      },
    ),
    // "University Course", "Course", "Course title", "Course studied", "Name of course", "Programme name": what you
    // study. Not its dates, code, grade or provider, a list of courses or modules, or "the course of the internship".
    R(
      'edu.field',
      /\bcourse\b|\b(programme|program) (name|title)\b|\bname of (the |your )?(degree )?(programme|program)\b/,
      {
        not: /\bcourses\b|(?<!\b(name|title) )\bof course\b|\bthe course of\b|relevant|\bmodules?\b|\b(code|provider|leader|tutor|director|fees?|dates?|start\w*|end|ends|ending|finish\w*|complet\w*|graduat\w*|years?|months?|duration|length|type|mode|level|load|credits?|grades?|results?|marks?|score|classification|gpa|location|city|country|work)\b|full ?time|part ?time|\bappl(y|ying|ied)\b|\binterested\b|preference|\bjob\b|\brole\b|internship|placement|scheme|training|\bonline\b|certif/,
      },
    ),
    // "Do you have a 2:1 or above (or equivalent)?", "Minimum 2:1 required — do you meet this?", "Do you expect to
    // graduate with honours?" [Yes / No]: about your class, never the class itself.
    R(
      'edu.classAtLeast',
      /\b2 (1|i|2|ii)\b|\b(upper|lower) second\b|\bfirst class\b|\b(predicted|achieve|achieved|expect) (a )?(first|1st)\b(?! (year|degree|time))|\bwith (first class )?honou?rs\b/,
      { kinds: CHOICE, test: (desc, text) => hasYesNoOptions(desc) && !qualsOf(text).length },
    ),
    // Isio's "…achieved an Maths A-Level grade B or higher… Please confirm if you have obtained this.", "Do you have
    // AAB or above at A-level?" [Yes / No]: a bar on your school grades.
    R(
      'edu.classAtLeast',
      /\b(grades? )?[a-e]( ?[a-e]){0,4} or (higher|above|better)\b|\b(at least|minimum( of)?) (an? |grades? )?[a-e]( ?[a-e]){0,4}\b(?! ?levels?\b)/,
      { kinds: CHOICE, test: (desc, text) => hasYesNoOptions(desc) && qualsOf(text).length > 0 },
    ),
    // "GPA Scale", "Please specify the grading scale used by your current school", "the maximum possible score/GPA".
    R(
      'edu.gpaScale',
      /\b(gpa|grading|grade|marking) (scale|system)\b|\bscale (used|of your gpa)\b|\b(which|what) scale\b|\b(maximum|max|highest) possible (score|gpa|grade)\b/,
      // "What is your cumulative GPA on the scale used by your local school/university?" asks for the GPA.
      { not: /\bon an? \d|\bout of\b|\bnormali[sz]ed\b|\bon (the|a|your) (\w+ )?scale\b/ },
    ),
    R(
      'edu.gpa',
      /\bgpa\b|grade point|\bcgpa\b|cumulative (grade|average)|grade average|\bgrades?\b/,
      // "Number of GCSEs at grade 9-7" is a count, not your grade.
      {
        not: /test score|credit score|maximum|max possible|highest possible|grading scale|(?<!\bon (the|a|your) )scale used|\bgpa scale\b|\bnumber of\b|\bhow many\b/,
      },
    ),
    // "A-level results", "Highers / Advanced Highers results": a school entry's grades.
    R(
      'edu.gpa',
      /\b(a ?levels?|as levels?|(advanced )?highers|international baccalaureate|ib diploma|i?gcses?|btecs?|leaving cert\w*|abitur)\b.*\bresults?\b/,
      { not: /\bnumber of\b|\bhow many\b|\bucas\b|\bpoints\b/ },
    ),

    // Names
    R('name.prefix', /salutation|honorific|\bprefix\b|anrede|civilit|\btitle\b/, {
      // "Title (e.g. Mr, Mrs, Ms)" in a text box too.
      test: (desc, text) =>
        hasHonorificOptions(desc) || /salutation|honorific|prefix|anrede|civilit|\b(mr|mrs|ms|miss|mx)\b/.test(text),
    }),
    R(
      'name.preferred',
      /\bpreferred (first |given |full |legal |short )?(name|forename)|\bpref(erred)? name|nick ?name|\bgoes by\b|\bgo by\b|\bknown as\b|\bchosen (first |full )?name|\bname you (go by|prefer|are known by|use|would (like|prefer)|like to (be called|go by))|\b(what|how) (should|do|can|may) (we|i) call you|\bcall you\b|\b(display|screen|short|common|informal|alias) name\b|\balias\b|\benglish (first |given |full )?name\b|\bspitzname|\brufname|\bbevorzugter (vor)?name|\bnom (d usage|usuel)|\bprenom usuel|\bsurnom\b|\bapodo\b|\bnombre (preferido|social)|\bsoprannome\b|\bnome (preferito|social)/,
      {
        // "Legal First Name (if different from preferred name)" asks for the legal one.
        not: /user ?name|company|employer|school|business|card|organi|contact|\breferences?\b|\breferr|emergency|manager|screen ?name ?(on|in)|\bdifferent (from|to|than) (your |the )?pref(erred)? name\b/,
      },
    ),
    R(
      'name.first',
      /\bfirst ?name|\bgiven ?names?\b|\bforenames?\b|\bfname\b|\bfirst$|^first\b(?! (time|choice|language|line|day|week|month|year|job))|\bvorname|\bprenom|\bnombre\b|\bnome\b/,
      {
        // "Prénom et nom" / "Vor- und Nachname" / "Nombre y apellidos" is the whole name; "Phone number (country code
        // first)" is a phone number.
        not: /last|sur ?name|family|middle|company|school|business|card|preferred|nick|employer|organi|user|father|mother|spouse|emergency|reference|referr|manager|contact person|\bnom\b|nachname|apellido|cognome|\b(phone|mobile|telephone|number|code)\b/,
      },
    ),
    R('name.middle', /\bmiddle ?(name|initial)s?\b|\bmname\b|^mi$|\bmiddle$|second (given )?name|segundo nombre/, {
      not: /last|family/,
    }),
    R(
      'name.last',
      /\blast ?name|\bsur ?names?\b|\bfamily ?names?\b|\blname\b|\blast$|^last\b(?! (time|day|week|month|year|job|employer|position|company))|\bnachname|\bapellidos?\b|\bnom de famille|\bcognome\b|^nom$/,
      {
        not: /first|company|school|card|preferred|employer|father|mother|spouse|emergency|reference|referr|manager|maiden|previous|former|other|\bvor(name)? (und|&) nachname|\bnombre y apellido|\bprenom (et|&) nom\b|\bnom (et|&) prenom|\bnome (e|&) cognome/,
      },
    ),
    R('name.full', /\b(first|given) (name )?(and|&|\/) (last|sur|family) ?names?\b|\bfull legal name\b/),
    R(
      'name.full',
      /\bfull ?name|\byour name\b|\blegal name\b|\bname\b|\bnom complet|\bnombre completo|\bvoller name|\bvor(name)? (und|&) nachname|\bnombre y apellido|\bprenom (et|&) nom\b|\bnom (et|&) prenom|\bnome (e|&) cognome/,
      {
        not: NAME_NOT,
        // Teamtailor's "Email address without domain" (placeholder "name") is an address, not a name.
        notAny: /\be ?mails?\b/,
        yieldsTo: ['name.first', 'name.last', 'name.middle', 'name.preferred'],
      },
    ),

    // Contact
    // "What is your communication preference?", "Preferred method of contact", "How would you like us to contact you?"
    // (a choice of Email / Phone / Text message, never an SMS opt-in).
    R(
      'contact.preference',
      /\bcommunication preferences?\b|\bpreferred (method|means|mode|way|form|channel) of (contact|communication|correspondence)\b|\bpreferred (contact|communication) (method|channel|preference|type)?\b|\b(contact|communication) (preference|method|channel)s?\b|\bhow (would|do|should|can|may) (you like|you prefer|we) (us |to be )?(to )?(best )?(contact|reach|communicate with|get in touch with) you\b|\bbest way to (contact|reach) you\b/,
      {
        kinds: CHOICE,
        not: /marketing|newsletter|promotion|job alerts?|talent (community|network|pool)|subscribe|opt ?in|consent|emergency|\breferee|\breferences?\b|\bnumber\b|\baddress\b/,
      },
    ),
    // "Your primary college/university/school email", "Student email address": not your personal one.
    R(
      'email.school',
      /\b(school|universit\w*|college|student|academic|institution(al)?|\.edu)\b.{0,30}\be ?mail\b|\be ?mail\b.{0,20}\b(at|from|of|with) (your )?(school|universit\w*|college|institution)\b/,
      {
        kinds: ['email', 'text'],
        not: /referr|reference|recruiter|career(s)? (service|office|advis)|advis[eo]r|tutor|professor|lecturer|supervisor|\bcontact\b/,
      },
    ),
    // Not someone else's, nor a second address of yours ("Alternate Email": the same one again says nothing).
    R('email', /e ?mail|courriel|correo|\bmail\b/, {
      not: /referr|reference|recruiter|manager|supervisor|emergency|friend|hiring|newsletter|marketing|subscribe|\b(alternate|alternative|secondary|additional|backup|second) e ?mail\b|\bwithout (the |a |your )?domain\b/,
      notAny: OTHERS_EMAIL,
    }),
    R(
      'account.username',
      /user ?(name|id)|\blogin\b|log in (id|name)|sign in (id|name)|\buid\b|account (name|id)|member (id|name)|benutzername/,
      {
        not: /e ?mail|twitter|git ?hub|linked ?in|instagram|telegram|skype|discord|slack|handle/,
      },
    ),
    R('phone.type', /phone ?(device )?type|type of (phone|number)|device type|phone ?kind|number type/, {
      kinds: CHOICE,
    }),
    R(
      'phone.countryCode',
      // SuccessFactors: "Country/Region Code:" next to "Phone Number:".
      /country ?(phone )?(calling )?code|\bcountr(y|ies) (or |and )?(region|territory) (phone |calling |dial(l)?(ing)? )?code\b|dial(l)?(ing)? ?code|calling ?code|phone.*country|country.*phone|\bisd\b|(phone|tel|mobile) ?prefix|country ?prefix|international code|\bindicatif\b|\b(lander)?vorwahl\b|\bprefijo\b|\bprefisso\b/,
      // "Mobile number (inc. country code)" is the whole number (WHOLE_NUMBER).
      { not: WHOLE_NUMBER },
    ),
    R(
      'phone',
      /phone|mobile|\bmobil(nummer|telefon)?\b|\bcell\b|cellular|telephone|\btel\b|contact (number|no)|telefon|telefono|\bportable\b|\bhandy\b|whats ?app|\bmob\b/,
      { not: PHONE_NOT, notAny: OTHER_PHONE, yieldsTo: ['phone.countryCode', 'phone.type'] },
    ),

    // Address
    R(
      'address.line2',
      /address ?(line)? ?(2|two|ii)\b|\baddr(ess)? ?2\b|street ?(address)? ?2|\bapt\b|apartment|\bsuite\b|\bunit\b|\bbuilding\b|\bfloor\b|\bflat\b|address ?(complement|additional|cont)|complemento|adresszusatz/,
      {
        not: /line ?(1|one)|business unit/,
        kinds: TEXTISH,
        // "Which Building Services modules have you completed?" is not a flat number; "a full suite of services" is
        // not a suite.
        test: (desc, hit) => {
          const words = hit.split(' ').length;
          return (
            /\baddress\b|\baddr\b/.test(hit) ||
            words <= 5 ||
            (words <= 8 && /\bapt\b|apartment|suite|complement/.test(hit))
          );
        },
      },
    ),
    R(
      'address.line1',
      /address ?(line)? ?(1|one|i)\b|\baddr(ess)? ?1\b|\bstreet\b|\baddress\b|\baddr\b|strasse|straße|hausnummer|direccion|\badresse\b|indirizzo|\bmorada\b|house ?(number|name|no)/,
      {
        not: /e ?mail|\bip\b|\bweb\b|\burl\b|line ?(2|two|3|three)|\bcity\b|\bstate\b|zip|postal|country|same as|wallet|mac address|crypto/,
        kinds: TEXTISH,
        yieldsTo: ['address.line2', 'address.city', 'address.postalCode', 'exp.location'],
      },
    ),
    R(
      'location',
      /\blocation\b|city ?(and|&)? ?(state|country)|where are you (currently )?(based|located|living)|current (city|location|residence)|based in|place of residence|city of residence|where do you live|^residence$|\bwhere (will|would) you (live|be living|reside|be based) (during|while|for)\b/,
      {
        not: /preferred|desired|willing|relocat|office|prefer|which location|work location|job location|interested|position location|hope|want|open to|employer|company|organi[sz]ation/,
      },
    ),
    R(
      'address.city',
      /\bcity\b|\btown\b|\bsuburb\b|\blocality\b|\bort\b|\bstadt\b|\bciudad\b|\bville\b|\bcitta\b|municipality|\bwohnort\b|address level 2/,
      { not: /\bstate\b|zip|postal|birth|employer|company|organi[sz]ation/ },
    ),
    R(
      'address.state',
      /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b|\bterritory\b|prefecture|bundesland|\bestado\b|\bprovincia\b|address level 1/,
      {
        // "State (If N/A, Select Other)" is the box; "State if you have…" asks you to say something. "Country/Region of
        // Residence" and "Country / Territory" are countries (Workday's "countryRegion" id is not).
        not: /united states|marital|\b(please|you|to) state\b|\bstate (your|which|whether|if(?! (n ?a|not applicable|applicable)\b)|why|how|what|the|any)\b|(?<!\bsection )\bcountr(y|ies) (or |and )?(region|territory|area)\b|\b(region|territory) (or |and )?countr(y|ies)\b/,
        yieldsTo: ['exp.location'], // "Employer Location (City, State, Zip)"
      },
    ),
    R(
      'address.postalCode',
      /\bzip\b|zip ?code|\bzipcode|postal|post ?code|postcode|\bpin ?code\b|\bplz\b|postleitzahl|codigo postal|code postal|\bcap\b|\bcep\b/,
      // Not where you work: Oracle's "Northern Ireland Workplace Postcode for SPBP due to miscarriage".
      {
        yieldsTo: ['exp.location'],
        not: /\bworkplace\b|\b(work|employer s?|company|office|branch) (post ?code|postcode|zip|postal)\b/,
      },
    ),
    R('citizen', /^(are|is) you (a |an )?(\w+ ){0,3}(citizen|national)s?\b/, {
      kinds: ['select', 'radio', 'combo', 'combobox'],
      not: /\b(dual|other|another|any other|former|previous)\b/,
    }),
    // "Do you hold British citizenship?", "Do you have a UK passport?" (never a list of sanctioned countries).
    R(
      'citizen',
      /^(do|does) you (currently )?(hold|have|possess)( a| an)?( valid| current)? (\w+ ){0,2}(citizenship|nationality|passport)\b/,
      {
        kinds: ['select', 'radio', 'combo', 'combobox'],
        not: /\b(dual|other|another|any other|former|previous|second)\b|\b(any|one) of the following\b|\bcuba\b|\biran\b|\bnorth korea\b|\bsyria\b|\bcrimea\b|\bsanction/,
      },
    ),
    R(
      'nationality',
      /nationality|citizenship|citizen of|country of (citizenship|nationality)|staatsangehorigkeit|nacionalidad|\bnationalite\b|\bnazionalita\b/,
      { not: /other (countr|nationalit|citizenship)|\bdual\b|previous|\bformer|second (nationality|citizenship)/ },
    ),
    // "This position requires access to… U.S. export controls…" over "A United States citizen or national / Green Card
    // holder / refugee / asylee / None of the above": which kind of US person you are, from your nationality.
    R('nationality', /\bexport controls?\b|\bus persons?\b|\bitar\b/, {
      kinds: CHOICE,
      test: (desc) =>
        (desc.options || []).some((o) => /\b(citizen|national|green card|permanent resid\w*)\b/i.test(o.text || '')),
    }),
    R('address.country', /\bcountr(y|ies)\b|\bnation\b|\bland\b|\bpais\b|\bpays\b/, {
      not: /code|phone|dial|calling|(?<!\bcountr(y|ies) (or |and )?)\bregion\b|citizen|nationality|birth|issu|passport|origin|visa|other than|which countries|\btax\b/,
    }),

    // Work experience (gen.* become edu.* / exp.* from the surrounding section)
    R(
      'exp.current',
      /currently (work|employed|working)|current(ly)? (job|role|position|employer)|i (currently )?work here|\bpresent\b|still (work|employed)|\bongoing\b|current$/,
      { kinds: ['checkbox'] },
    ),
    // "Is this your current employer?" (Yes/No) inside a work-history entry.
    R(
      'exp.current',
      /\b(is|was) this (your|my) current (employer|job|position|role|company)\b|\bdo you (still|currently) work here\b/,
      {
        kinds: CHOICE,
      },
    ),
    R(
      'exp.start',
      /\b(employment|job|work|position|role) (start|from|begin)(ning)? (date|month|year)\b|\bdate (of )?(employment|hire) (start|began)/,
      { not: /preferred|desired|earliest|availab|expected|when (can|could|would)/ },
    ),
    R('exp.end', /\b(employment|job|work|position|role) (end|to|finish|leaving) (date|month|year)\b/),
    R(
      'exp.location',
      /\b(employer|company|organi[sz]ation)( s)? (location|city|address)\b|\blocation of (the )?(employer|company)\b/,
    ),
    R(
      'gen.start',
      /^(start|from|begin|started|since)( date| month| year)?( (or )?(actual|expected|anticipated)( or (actual|expected|anticipated))?)?$|\bstart ?date\b|\bstart (month|year)\b|\bdate (from|started|joined|of joining)\b|\bfrom (date|month|year)\b|\bstarted\b|\bbegin date\b|\bdate from\b/,
      {
        // "From (Actual)" (Workday) is an entry's date; "Expected start date" is when you could start the job. Oracle's
        // "Veteran First Civilian Start Date" is a veteran's own.
        not: /when (can|could|would) you|availab|earliest|desired|preferred|^expected|\bexpected (start|to start|from)\b|can you start|internship|placement|programme|program\b|\bveteran|\bmilitary\b|\bcivilian\b|\barmed forces\b|\bdischarge/,
      },
    ),
    R(
      'gen.end',
      /^(end|to|until|finish|till)( date| month| year)?( (or )?(actual|expected|anticipated)( or (actual|expected|anticipated))?)?$|\bend ?date\b|\bend (month|year)\b|\bdate (to|left|ended|of leaving)\b|\bto (date|month|year)\b|\bended\b|\bfinish date\b|\bdate to\b|\bleaving date\b/,
      {
        not: /open ended|\b(percentage|average|marks?|grades?|score|results?|gpa|total|overall)\b|\bveteran|\bmilitary\b|\bcivilian\b|\barmed forces\b|\bdischarge/,
      },
    ),
    R(
      'exp.company',
      /\bcompany\b|employer|organi[sz]ation|\bfirm\b|business name|workplace|unternehmen|\bempresa\b|entreprise/,
      {
        not: /current|present|most recent|size|industry|website|\btype\b|e ?mail|phone|address|why|how|referr|recruit|agency|\burl\b|linked ?in|do you|have you|are you|did you|related|know anyone|anyone at|family|relative|this company|our company|the company|interest|^if (yes|so|you)\b|deadlines?|\boffers?\b|post ?code|postal|\bzip\b/,
      },
    ),
    R(
      'exp.title',
      /job ?title|\btitle\b|\bposition\b|\brole\b|designation|occupation|job name|berufsbezeichnung|\bpuesto\b|\bposte\b|job ?function/,
      {
        not: /appl(y|ied|ying)|current|present|most recent|interest|desired|preferred|seeking|looking|\blevel\b|\btype\b|salary|why|how|which|what|referr|for this|\bopen\b|vacancy|\bdo you\b|have you|are you|did you|\bcourse\b|book|song|thesis|project|paper|publication|prefix|salutation|honorific|description|summary|responsibilit|duties|\b(this|the) (position|role) (requires|involves|is|will|may)\b|export control|\bmodules?\b|\b(mr|mrs|ms|miss|mx)\b/,
        // "Module title" (id "mod_title_1"), "Dissertation title": not a job.
        notAny: /\bmodules?\b|\bdissertation\b|\bthesis\b/,
        test: (desc) => !hasHonorificOptions(desc),
      },
    ),
    R(
      'gen.description',
      /description|responsibilit|\bduties\b|achievement|accomplishment|what did you do|role summary|key (tasks|work)/,
      { kinds: LONG_TEXT },
    ),

    // Long-form text
    R('coverLetter', /cover ?letter|motivation(al)? letter|letter of motivation|anschreiben|lettre de motivation/, {
      kinds: LONG_TEXT,
    }),
    R(
      'summary',
      /\bsummary\b|about (you|yourself|me)\b|tell (us|me) (a (little|bit) )?about yourself|introduce yourself|\bbio\b|biography|personal statement|professional (profile|summary)|career (objective|summary)|\bobjective\b/,
      {
        // "Tell us something about yourself that we can't find on your resume" wants something new.
        not: /linked ?in|url|link|git|photo|picture|image|\bname\b|role summary|job summary|(not|can t|cannot|won t|isn t|wouldn t) (\w+ ){0,3}(on|in|from) (your |the )?(cv|resume)|\bbeyond (your |the )?(cv|resume)/,
        kinds: LONG_TEXT,
      },
    ),
    R(
      'skills',
      /\b(programming|coding|scripting|computer|software) languages?\b|\b(languages?|technologies|tools|frameworks) (and|or|&) (frameworks|tools|technologies|libraries)\b|\bwhich (of the following )?(technologies|tools|frameworks|programming)|\b(programming|coding) (experience|skills|knowledge) (with|in) (any of )?the following\b/,
      // "Which languages do you use?" wants the list; "your favourite language" wants one answer.
      {
        not: /\brate your|years|favou?rite|\bbest\b|primary|\bmain\b|strongest|\bmost\b|preferred|\blevel\b|how (proficient|experienced|comfortable|much|long)/,
      },
    ),
    // Not "Please disclose whether AI tools were used…" or "…which teams may be the best fit based on your skill set
    // … anything else you'd like to note".
    // Nor an essay that mentions them ("Describe a product you built… the tech stack used", "What unique skills would
    // you bring?") or a kind of them the list doesn't say ("What are some AI specific technologies…?"): the AI's.
    R('skills', /\bskills?\b|technologies|tech(nical)? stack|competenc|expertise|\btools\b|proficienc(y|ies)/, {
      not: /\bwhy\b|\bgood fit\b|\bhope to (develop|gain|learn|build)\b|\bwords? (minimum|maximum|limit|max)\b|language|\bdo you\b|have you|rate your|years|\blevel\b|how (proficient|experienced|comfortable|much|long)|\bwhether\b|\bdisclose\b|\bai tools\b|\banything else\b|\bfeel free\b|\bbest fit\b|^(describe|tell (us|me)|explain|share|walk us through|give (us )?an example)\b|\bwould you bring\b|\bunique\b|\byou (built|developed|created|designed|made)\b|\b(ai|ml|machine learning|cloud|web|mobile|front ?end|back ?end|devops|security)( specific)? (technologies|tools|skills)\b/,
    }),
    R(
      'languages',
      /languages? (spoken|you speak|proficienc|known|fluency)|which languages?\b|spoken languages|^languages?$|language skill|languages do you speak|\blanguages?\b.*\b(fluent|fluency|speak|proficient)\b|\bfluent in\b|\b(additional|other|foreign) languages?\b|\b(do|can) you speak\b|\bspeak (\w+ )?(at a |to a )?(fluent|native|business|professional)\b|\b(able to|can you) (fluently )?speak\b|\bfluently speak\b|\b(first|primary|native|main|mother) (language|tongue)\b/,
      { not: /programming|coding|scripting|computer|software/ },
    ),
  ];

  // Standard HTML autocomplete tokens -> [type, part].
  // prettier-ignore
  const AUTOCOMPLETE = {
    name: ['name.full'], 'honorific-prefix': ['name.prefix'], 'given-name': ['name.first'],
    'additional-name': ['name.middle'], 'family-name': ['name.last'], nickname: ['name.preferred'],
    email: ['email'], username: ['account.username'],
    'new-password': ['account.password'], 'current-password': ['account.password'],
    'organization-title': ['job.currentTitle'], organization: ['exp.company'],
    'street-address': ['address.street'], 'address-line1': ['address.line1'], 'address-line2': ['address.line2'],
    'address-level2': ['address.city'], 'address-level1': ['address.state'],
    country: ['address.country'], 'country-name': ['address.country'], 'postal-code': ['address.postalCode'],
    'cc-name': ['cc.name'], 'cc-number': ['cc.number'], 'cc-exp': ['cc.exp'],
    'cc-exp-month': ['cc.exp', 'month'], 'cc-exp-year': ['cc.exp', 'year'], 'cc-csc': ['cc.cvc'], 'cc-type': ['cc.type'],
    bday: ['dob'], 'bday-day': ['dob', 'day'], 'bday-month': ['dob', 'month'], 'bday-year': ['dob', 'year'],
    sex: ['eeo.gender'], url: ['links.website'],
    tel: ['phone'], 'tel-national': ['phone.national'], 'tel-country-code': ['phone.countryCode'],
  };

  Object.assign(P, { AUTOCOMPLETE, RULES, isAcknowledgement });
})(typeof globalThis !== 'undefined' ? globalThis : this);
