/*
 * JobToFill — country and region data used to match <select> options such as
 * "US" / "USA" / "United States of America" or "CA" / "California".
 */
(function (root) {
  'use strict';
  const JTF = (root.JTF = root.JTF || {});

  // [ISO 3166-1 alpha-2, alpha-3, English name, ...aliases]
  // prettier-ignore
  const COUNTRIES = [
    ['AF', 'AFG', 'Afghanistan'], ['AX', 'ALA', 'Åland Islands', 'Aland Islands'], ['AL', 'ALB', 'Albania'],
    ['DZ', 'DZA', 'Algeria'], ['AS', 'ASM', 'American Samoa'], ['AD', 'AND', 'Andorra'], ['AO', 'AGO', 'Angola'],
    ['AI', 'AIA', 'Anguilla'], ['AQ', 'ATA', 'Antarctica'], ['AG', 'ATG', 'Antigua and Barbuda'],
    ['AR', 'ARG', 'Argentina'], ['AM', 'ARM', 'Armenia'], ['AW', 'ABW', 'Aruba'], ['AU', 'AUS', 'Australia'],
    ['AT', 'AUT', 'Austria', 'Österreich'], ['AZ', 'AZE', 'Azerbaijan'], ['BS', 'BHS', 'Bahamas', 'The Bahamas'],
    ['BH', 'BHR', 'Bahrain'], ['BD', 'BGD', 'Bangladesh'], ['BB', 'BRB', 'Barbados'], ['BY', 'BLR', 'Belarus'],
    ['BE', 'BEL', 'Belgium'], ['BZ', 'BLZ', 'Belize'], ['BJ', 'BEN', 'Benin'], ['BM', 'BMU', 'Bermuda'],
    ['BT', 'BTN', 'Bhutan'], ['BO', 'BOL', 'Bolivia', 'Bolivia, Plurinational State of'],
    ['BQ', 'BES', 'Bonaire, Sint Eustatius and Saba', 'Caribbean Netherlands'],
    ['BA', 'BIH', 'Bosnia and Herzegovina'], ['BW', 'BWA', 'Botswana'], ['BV', 'BVT', 'Bouvet Island'],
    ['BR', 'BRA', 'Brazil', 'Brasil'], ['IO', 'IOT', 'British Indian Ocean Territory'],
    ['BN', 'BRN', 'Brunei', 'Brunei Darussalam'], ['BG', 'BGR', 'Bulgaria'], ['BF', 'BFA', 'Burkina Faso'],
    ['BI', 'BDI', 'Burundi'], ['CV', 'CPV', 'Cabo Verde', 'Cape Verde'], ['KH', 'KHM', 'Cambodia'],
    ['CM', 'CMR', 'Cameroon'], ['CA', 'CAN', 'Canada'], ['KY', 'CYM', 'Cayman Islands'],
    ['CF', 'CAF', 'Central African Republic'], ['TD', 'TCD', 'Chad'], ['CL', 'CHL', 'Chile'],
    ['CN', 'CHN', 'China', "People's Republic of China", 'PRC'], ['CX', 'CXR', 'Christmas Island'],
    ['CC', 'CCK', 'Cocos (Keeling) Islands'], ['CO', 'COL', 'Colombia'], ['KM', 'COM', 'Comoros'],
    ['CG', 'COG', 'Congo', 'Republic of the Congo', 'Congo-Brazzaville'],
    ['CD', 'COD', 'Democratic Republic of the Congo', 'Congo, Democratic Republic of the', 'DR Congo', 'DRC', 'Congo-Kinshasa'],
    ['CK', 'COK', 'Cook Islands'], ['CR', 'CRI', 'Costa Rica'], ['CI', 'CIV', "Côte d'Ivoire", 'Ivory Coast', "Cote d'Ivoire"],
    ['HR', 'HRV', 'Croatia'], ['CU', 'CUB', 'Cuba'], ['CW', 'CUW', 'Curaçao', 'Curacao'], ['CY', 'CYP', 'Cyprus'],
    ['CZ', 'CZE', 'Czechia', 'Czech Republic'], ['DK', 'DNK', 'Denmark'], ['DJ', 'DJI', 'Djibouti'],
    ['DM', 'DMA', 'Dominica'], ['DO', 'DOM', 'Dominican Republic'], ['EC', 'ECU', 'Ecuador'], ['EG', 'EGY', 'Egypt'],
    ['SV', 'SLV', 'El Salvador'], ['GQ', 'GNQ', 'Equatorial Guinea'], ['ER', 'ERI', 'Eritrea'],
    ['EE', 'EST', 'Estonia'], ['SZ', 'SWZ', 'Eswatini', 'Swaziland'], ['ET', 'ETH', 'Ethiopia'],
    ['FK', 'FLK', 'Falkland Islands', 'Falkland Islands (Malvinas)'], ['FO', 'FRO', 'Faroe Islands'], ['FJ', 'FJI', 'Fiji'],
    ['FI', 'FIN', 'Finland'], ['FR', 'FRA', 'France'], ['GF', 'GUF', 'French Guiana'], ['PF', 'PYF', 'French Polynesia'],
    ['TF', 'ATF', 'French Southern Territories'], ['GA', 'GAB', 'Gabon'], ['GM', 'GMB', 'Gambia', 'The Gambia'],
    ['GE', 'GEO', 'Georgia'], ['DE', 'DEU', 'Germany', 'Deutschland'], ['GH', 'GHA', 'Ghana'], ['GI', 'GIB', 'Gibraltar'],
    ['GR', 'GRC', 'Greece'], ['GL', 'GRL', 'Greenland'], ['GD', 'GRD', 'Grenada'], ['GP', 'GLP', 'Guadeloupe'],
    ['GU', 'GUM', 'Guam'], ['GT', 'GTM', 'Guatemala'], ['GG', 'GGY', 'Guernsey'], ['GN', 'GIN', 'Guinea'],
    ['GW', 'GNB', 'Guinea-Bissau'], ['GY', 'GUY', 'Guyana'], ['HT', 'HTI', 'Haiti'],
    ['HM', 'HMD', 'Heard Island and McDonald Islands'], ['VA', 'VAT', 'Holy See', 'Vatican City'],
    ['HN', 'HND', 'Honduras'], ['HK', 'HKG', 'Hong Kong'], ['HU', 'HUN', 'Hungary'], ['IS', 'ISL', 'Iceland'],
    ['IN', 'IND', 'India'], ['ID', 'IDN', 'Indonesia'], ['IR', 'IRN', 'Iran', 'Iran, Islamic Republic of'],
    ['IQ', 'IRQ', 'Iraq'], ['IE', 'IRL', 'Ireland', 'Republic of Ireland'], ['IM', 'IMN', 'Isle of Man'],
    ['IL', 'ISR', 'Israel'], ['IT', 'ITA', 'Italy', 'Italia'], ['JM', 'JAM', 'Jamaica'], ['JP', 'JPN', 'Japan'],
    ['JE', 'JEY', 'Jersey'], ['JO', 'JOR', 'Jordan'], ['KZ', 'KAZ', 'Kazakhstan'], ['KE', 'KEN', 'Kenya'],
    ['KI', 'KIR', 'Kiribati'], ['KP', 'PRK', 'North Korea', "Korea, Democratic People's Republic of"],
    ['KR', 'KOR', 'South Korea', 'Korea, Republic of', 'Republic of Korea', 'Korea'], ['KW', 'KWT', 'Kuwait'],
    ['KG', 'KGZ', 'Kyrgyzstan'], ['LA', 'LAO', 'Laos', "Lao People's Democratic Republic"], ['LV', 'LVA', 'Latvia'],
    ['LB', 'LBN', 'Lebanon'], ['LS', 'LSO', 'Lesotho'], ['LR', 'LBR', 'Liberia'], ['LY', 'LBY', 'Libya'],
    ['LI', 'LIE', 'Liechtenstein'], ['LT', 'LTU', 'Lithuania'], ['LU', 'LUX', 'Luxembourg'], ['MO', 'MAC', 'Macao', 'Macau'],
    ['MG', 'MDG', 'Madagascar'], ['MW', 'MWI', 'Malawi'], ['MY', 'MYS', 'Malaysia'], ['MV', 'MDV', 'Maldives'],
    ['ML', 'MLI', 'Mali'], ['MT', 'MLT', 'Malta'], ['MH', 'MHL', 'Marshall Islands'], ['MQ', 'MTQ', 'Martinique'],
    ['MR', 'MRT', 'Mauritania'], ['MU', 'MUS', 'Mauritius'], ['YT', 'MYT', 'Mayotte'], ['MX', 'MEX', 'Mexico', 'México'],
    ['FM', 'FSM', 'Micronesia', 'Micronesia, Federated States of'], ['MD', 'MDA', 'Moldova', 'Moldova, Republic of'],
    ['MC', 'MCO', 'Monaco'], ['MN', 'MNG', 'Mongolia'], ['ME', 'MNE', 'Montenegro'], ['MS', 'MSR', 'Montserrat'],
    ['MA', 'MAR', 'Morocco'], ['MZ', 'MOZ', 'Mozambique'], ['MM', 'MMR', 'Myanmar', 'Burma'], ['NA', 'NAM', 'Namibia'],
    ['NR', 'NRU', 'Nauru'], ['NP', 'NPL', 'Nepal'], ['NL', 'NLD', 'Netherlands', 'The Netherlands', 'Holland'],
    ['NC', 'NCL', 'New Caledonia'], ['NZ', 'NZL', 'New Zealand'], ['NI', 'NIC', 'Nicaragua'], ['NE', 'NER', 'Niger'],
    ['NG', 'NGA', 'Nigeria'], ['NU', 'NIU', 'Niue'], ['NF', 'NFK', 'Norfolk Island'], ['MK', 'MKD', 'North Macedonia', 'Macedonia'],
    ['MP', 'MNP', 'Northern Mariana Islands'], ['NO', 'NOR', 'Norway'], ['OM', 'OMN', 'Oman'], ['PK', 'PAK', 'Pakistan'],
    ['PW', 'PLW', 'Palau'], ['PS', 'PSE', 'Palestine', 'State of Palestine'], ['PA', 'PAN', 'Panama'],
    ['PG', 'PNG', 'Papua New Guinea'], ['PY', 'PRY', 'Paraguay'], ['PE', 'PER', 'Peru'], ['PH', 'PHL', 'Philippines'],
    ['PN', 'PCN', 'Pitcairn'], ['PL', 'POL', 'Poland', 'Polska'], ['PT', 'PRT', 'Portugal'], ['PR', 'PRI', 'Puerto Rico'],
    ['QA', 'QAT', 'Qatar'], ['RE', 'REU', 'Réunion', 'Reunion'], ['RO', 'ROU', 'Romania'],
    ['RU', 'RUS', 'Russia', 'Russian Federation'], ['RW', 'RWA', 'Rwanda'], ['BL', 'BLM', 'Saint Barthélemy'],
    ['SH', 'SHN', 'Saint Helena, Ascension and Tristan da Cunha', 'Saint Helena'], ['KN', 'KNA', 'Saint Kitts and Nevis'],
    ['LC', 'LCA', 'Saint Lucia'], ['MF', 'MAF', 'Saint Martin'], ['PM', 'SPM', 'Saint Pierre and Miquelon'],
    ['VC', 'VCT', 'Saint Vincent and the Grenadines'], ['WS', 'WSM', 'Samoa'], ['SM', 'SMR', 'San Marino'],
    ['ST', 'STP', 'Sao Tome and Principe'], ['SA', 'SAU', 'Saudi Arabia'], ['SN', 'SEN', 'Senegal'], ['RS', 'SRB', 'Serbia'],
    ['SC', 'SYC', 'Seychelles'], ['SL', 'SLE', 'Sierra Leone'], ['SG', 'SGP', 'Singapore'], ['SX', 'SXM', 'Sint Maarten'],
    ['SK', 'SVK', 'Slovakia'], ['SI', 'SVN', 'Slovenia'], ['SB', 'SLB', 'Solomon Islands'], ['SO', 'SOM', 'Somalia'],
    ['ZA', 'ZAF', 'South Africa'], ['GS', 'SGS', 'South Georgia and the South Sandwich Islands'], ['SS', 'SSD', 'South Sudan'],
    ['ES', 'ESP', 'Spain', 'España'], ['LK', 'LKA', 'Sri Lanka'], ['SD', 'SDN', 'Sudan'], ['SR', 'SUR', 'Suriname'],
    ['SJ', 'SJM', 'Svalbard and Jan Mayen'], ['SE', 'SWE', 'Sweden'], ['CH', 'CHE', 'Switzerland', 'Schweiz', 'Suisse'],
    ['SY', 'SYR', 'Syria', 'Syrian Arab Republic'], ['TW', 'TWN', 'Taiwan'], ['TJ', 'TJK', 'Tajikistan'],
    ['TZ', 'TZA', 'Tanzania', 'Tanzania, United Republic of'], ['TH', 'THA', 'Thailand'], ['TL', 'TLS', 'Timor-Leste', 'East Timor'],
    ['TG', 'TGO', 'Togo'], ['TK', 'TKL', 'Tokelau'], ['TO', 'TON', 'Tonga'], ['TT', 'TTO', 'Trinidad and Tobago'],
    ['TN', 'TUN', 'Tunisia'], ['TR', 'TUR', 'Turkey', 'Türkiye', 'Turkiye'], ['TM', 'TKM', 'Turkmenistan'],
    ['TC', 'TCA', 'Turks and Caicos Islands'], ['TV', 'TUV', 'Tuvalu'], ['UG', 'UGA', 'Uganda'], ['UA', 'UKR', 'Ukraine'],
    ['AE', 'ARE', 'United Arab Emirates', 'UAE'],
    ['GB', 'GBR', 'United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland',
      'United Kingdom of Great Britain and Northern Ireland'],
    ['US', 'USA', 'United States', 'United States of America', 'U.S.', 'U.S.A.', 'America'],
    ['UM', 'UMI', 'United States Minor Outlying Islands'], ['UY', 'URY', 'Uruguay'], ['UZ', 'UZB', 'Uzbekistan'],
    ['VU', 'VUT', 'Vanuatu'], ['VE', 'VEN', 'Venezuela', 'Venezuela, Bolivarian Republic of'], ['VN', 'VNM', 'Vietnam', 'Viet Nam'],
    ['VG', 'VGB', 'British Virgin Islands', 'Virgin Islands, British'], ['VI', 'VIR', 'U.S. Virgin Islands', 'Virgin Islands, U.S.'],
    ['WF', 'WLF', 'Wallis and Futuna'], ['EH', 'ESH', 'Western Sahara'], ['YE', 'YEM', 'Yemen'], ['ZM', 'ZMB', 'Zambia'],
    ['ZW', 'ZWE', 'Zimbabwe'], ['XK', 'XKX', 'Kosovo'],
  ];

  // [code, name, ...aliases] keyed by ISO alpha-2 country code.
  // prettier-ignore
  const REGIONS = {
    US: [
      ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
      ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia', 'Washington DC', 'Washington D.C.'],
      ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'],
      ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
      ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
      ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
      ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
      ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
      ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
      ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['PR', 'Puerto Rico'],
      ['GU', 'Guam'], ['VI', 'U.S. Virgin Islands', 'Virgin Islands'], ['AS', 'American Samoa'],
      ['MP', 'Northern Mariana Islands'], ['AA', 'Armed Forces Americas'], ['AE', 'Armed Forces Europe'],
      ['AP', 'Armed Forces Pacific'],
    ],
    CA: [
      ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
      ['NL', 'Newfoundland and Labrador', 'Newfoundland'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
      ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec', 'Québec'],
      ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
    ],
    AU: [
      ['ACT', 'Australian Capital Territory'], ['NSW', 'New South Wales'], ['NT', 'Northern Territory'],
      ['QLD', 'Queensland'], ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['VIC', 'Victoria'], ['WA', 'Western Australia'],
    ],
  };

  // Nationalities, so "British" finds the United Kingdom in a list of countries.
  const DEMONYMS =
    'GB:British,English,Scottish,Welsh,Northern Irish;US:American;IE:Irish;FR:French;DE:German;ES:Spanish;IT:Italian;' +
    'PT:Portuguese;NL:Dutch;BE:Belgian;CH:Swiss;AT:Austrian;SE:Swedish;NO:Norwegian;DK:Danish;FI:Finnish;IS:Icelandic;' +
    'PL:Polish;CZ:Czech;SK:Slovak;HU:Hungarian;RO:Romanian;BG:Bulgarian;GR:Greek;CY:Cypriot;MT:Maltese;HR:Croatian;' +
    'SI:Slovenian;RS:Serbian;AL:Albanian;UA:Ukrainian;RU:Russian;LT:Lithuanian;LV:Latvian;EE:Estonian;LU:Luxembourgish;' +
    'TR:Turkish;IL:Israeli;LB:Lebanese;JO:Jordanian;SA:Saudi,Saudi Arabian;AE:Emirati;QA:Qatari;EG:Egyptian;MA:Moroccan;' +
    'NG:Nigerian;GH:Ghanaian;KE:Kenyan;ZA:South African;ET:Ethiopian;UG:Ugandan;ZW:Zimbabwean;IN:Indian;PK:Pakistani;' +
    'BD:Bangladeshi;LK:Sri Lankan;NP:Nepalese,Nepali;CN:Chinese;HK:Hongkonger;TW:Taiwanese;JP:Japanese;' +
    'KR:South Korean,Korean;SG:Singaporean;MY:Malaysian;ID:Indonesian;TH:Thai;VN:Vietnamese;PH:Filipino;' +
    'AU:Australian;NZ:New Zealander;CA:Canadian;MX:Mexican;BR:Brazilian;AR:Argentine,Argentinian;CL:Chilean;' +
    'CO:Colombian;PE:Peruvian;IR:Iranian;GE:Georgian;AM:Armenian;JM:Jamaican';

  const norm = (s) => JTF.util.normalize(s);

  let countryIndex = null;
  function index() {
    if (countryIndex) return countryIndex;
    countryIndex = new Map();
    for (const row of COUNTRIES) {
      for (const key of row) countryIndex.set(norm(key), row);
    }
    const byCode = new Map(COUNTRIES.map((row) => [row[0], row]));
    for (const entry of DEMONYMS.split(';')) {
      const [code, names] = entry.split(':');
      for (const name of names.split(','))
        if (!countryIndex.has(norm(name))) countryIndex.set(norm(name), byCode.get(code));
    }
    return countryIndex;
  }

  function demonyms(iso2) {
    const entry = DEMONYMS.split(';').find((e) => e.startsWith(iso2 + ':'));
    return entry ? entry.slice(3).split(',') : [];
  }

  /** Look up a country by code, name or alias. Returns the data row or null. */
  function findCountry(value) {
    if (!value) return null;
    return index().get(norm(value)) || null;
  }

  /** All the ways a <select> might spell the given country, best first. */
  function countryCandidates(value) {
    const row = findCountry(value);
    if (!row) return value ? [String(value)] : [];
    const [iso2, iso3, name, ...aliases] = row;
    const out = [String(value), name, ...aliases, iso2, iso3];
    return [...new Set(out)];
  }

  function findRegion(value, country) {
    if (!value) return null;
    const key = norm(value);
    const row = findCountry(country);
    const tables = row && REGIONS[row[0]] ? [REGIONS[row[0]]] : Object.values(REGIONS);
    for (const table of tables) {
      for (const region of table) {
        if (region.some((r) => norm(r) === key)) return region;
      }
    }
    return null;
  }

  function regionCandidates(value, country) {
    const region = findRegion(value, country);
    if (!region) return value ? [String(value)] : [];
    const [code, name, ...aliases] = region;
    return [...new Set([String(value), name, ...aliases, code])];
  }

  // EU and EEA members (plus Switzerland): "EU / EEA citizen", "European citizen".
  const EUROPEAN = new Set(
    'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH'.split(' '),
  );

  /** The words a list of citizenship options may use for a nationality: names, demonyms, "EU". */
  function citizenWords(value) {
    const row = findCountry(value);
    if (!row) return [];
    const words = [...countryCandidates(value), ...demonyms(row[0])];
    if (EUROPEAN.has(row[0])) words.push('EU', 'EEA', 'European', 'European Union');
    return [...new Set(words.map(norm).filter(Boolean))];
  }

  let nameIndex = null;
  /** Country names and aliases a sentence can name (not codes or demonyms, which read as ordinary words). */
  function names() {
    if (nameIndex) return nameIndex;
    nameIndex = [];
    for (const row of COUNTRIES)
      for (const key of row.slice(2)) {
        const n = norm(key);
        if (n.length >= 4) nameIndex.push([' ' + n + ' ', row[0]]);
      }
    // "UK", "U.S.", "USA", "the US" (never "us" on its own), "the EU", "EEA".
    nameIndex.push(
      [' uk ', 'GB'],
      [' u k ', 'GB'],
      [' usa ', 'US'],
      [' u s ', 'US'],
      [' u s a ', 'US'],
      [' the us ', 'US'],
      // "US work authorization", "US citizen", "US-based": the country, not the pronoun.
      ...[
        'work',
        'employment',
        'visa',
        'citizen',
        'citizenship',
        'based',
        'person',
        'green card',
        'passport',
        'national',
        'permanent',
      ].map((w) => [` us ${w}`, 'US']),
      [' eu ', 'EU'],
      [' eea ', 'EU'],
      [' european union ', 'EU'],
      [' european economic area ', 'EU'],
    );
    return nameIndex;
  }

  /**
   * The countries a question names ("…authorized to work in the United States?", "in the UK", "anywhere in the EU"),
   * as ISO codes ('EU' for the EU / EEA). "New Jersey" or "New Mexico" are places in the US, not other countries.
   */
  function countriesNamed(text) {
    const t = ' ' + norm(text) + ' ';
    const out = [];
    for (const [key, code] of names()) {
      const at = t.indexOf(key);
      if (at < 0 || out.includes(code)) continue;
      if (/ new $/.test(t.slice(Math.max(0, at - 4), at + 1))) continue;
      out.push(code);
    }
    return out;
  }

  /** The countries a sentence names by name or nationality: "Are you a British citizen?", "Do you hold US citizenship?" */
  function nationalitiesNamed(text) {
    const t = ' ' + norm(text) + ' ';
    const out = new Set(countriesNamed(text));
    for (const entry of DEMONYMS.split(';')) {
      const [code, names] = entry.split(':');
      if (names.split(',').some((n) => t.includes(' ' + norm(n) + ' '))) out.add(code);
    }
    return [...out];
  }

  // Visas and immigration words that name their country ("H-1B", "Skilled Worker visa", "Blue Card"); "TN" alone
  // only as a whole option.
  const VISA_WORDS = [
    [
      'US',
      /\bh ?1 ?b\d?\b|\bh ?4\b|\b(stem )?opt\b(?! (in|out)\b)|\bcpt\b|\b[fjlo] ?1\b|\be ?3\b|\btn (visa|status)\b|^tn$|\bgreen card\b|\buscis\b|\bead\b|\bi ?9\b|\be ?verify\b|\blawful permanent resident\b/,
    ],
    [
      'GB',
      /\bskilled worker\b|\btier ?[245]\b|\bgraduate (route|visa)\b|\bhigh potential individual\b|\bbrp\b|\bbiometric residence permit\b|\bshare code\b|\b(pre )?settled status\b|\bindefinite leave to remain\b|\bilt?r\b|\beu settlement scheme\b|\bukvi\b|\bcertificate of sponsorship\b|\bglobal talent visa\b|\byouth mobility\b/,
    ],
    ['EU', /\bblue card\b/],
    ['IE', /\bstamp (1g|4)\b|\bcritical skills (employment )?permit\b/],
    ['CA', /\bpgwp\b|\blmia\b/],
    ['AU', /\bsubclass \d{3}\b|\btss visa\b/],
    ['SG', /\bemployment pass\b|\bs pass\b|\bentrepass\b/],
  ];

  /** The countries a sentence's visa words imply: "(e.g. H-1B, OPT)" is about the US, "Tier 4" about the UK. */
  function visaCountries(text) {
    const t = norm(text);
    return VISA_WORDS.filter(([, re]) => re.test(t)).map(([code]) => code);
  }

  // Cities employers name ("our London office", "New York, NY"), each with the places around it within a daily
  // commute: [ISO country, region (UK nation, US state…), city, ...the rest of its metro area].
  // prettier-ignore
  const METROS = [
    ['GB', 'England', 'London', 'Greater London', 'City of London', 'Canary Wharf', 'Westminster', 'Croydon', 'Camden',
      'Islington', 'Hackney', 'Southwark', 'Lambeth', 'Wandsworth', 'Stratford', 'Wimbledon', 'Ealing', 'Harrow', 'Barnet',
      'Bromley', 'Hammersmith', 'Kensington', 'Shoreditch', 'Richmond upon Thames', 'Kingston upon Thames'],
    ['GB', 'England', 'Manchester', 'Greater Manchester', 'Salford', 'Stockport', 'Trafford', 'Oldham', 'Bolton'],
    ['GB', 'England', 'Birmingham', 'Solihull', 'Wolverhampton'], ['GB', 'England', 'Leeds', 'Bradford', 'Wakefield'],
    ['GB', 'England', 'Bristol', 'Bath'], ['GB', 'England', 'Newcastle', 'Newcastle upon Tyne', 'Gateshead'],
    ['GB', 'England', 'Liverpool'], ['GB', 'England', 'Sheffield'], ['GB', 'England', 'Nottingham'],
    ['GB', 'England', 'Leicester'], ['GB', 'England', 'Coventry'], ['GB', 'England', 'Cambridge'],
    ['GB', 'England', 'Oxford'], ['GB', 'England', 'Reading'], ['GB', 'England', 'Cheltenham', 'Gloucester'],
    ['GB', 'England', 'Southampton'], ['GB', 'England', 'Brighton'], ['GB', 'England', 'Milton Keynes'],
    ['GB', 'England', 'York'], ['GB', 'Scotland', 'Glasgow', 'Paisley', 'East Kilbride', 'Clydebank'],
    ['GB', 'Scotland', 'Edinburgh', 'Leith'], ['GB', 'Scotland', 'Aberdeen'], ['GB', 'Scotland', 'Dundee'],
    ['GB', 'Wales', 'Cardiff'], ['GB', 'Wales', 'Swansea'], ['GB', 'Northern Ireland', 'Belfast'],
    ['US', 'NY', 'New York', 'New York City', 'NYC', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island',
      'Jersey City', 'Hoboken', 'Newark', 'Stamford', 'Greenwich', 'Rowayton', 'Norwalk', 'White Plains', 'Westchester',
      'Long Island'],
    ['US', 'IL', 'Chicago', 'Evanston'],
    ['US', 'CA', 'San Francisco', 'SF', 'the Bay Area', 'SF Bay Area', 'San Francisco Bay Area', 'Silicon Valley', 'Oakland',
      'Berkeley', 'San Jose', 'Palo Alto', 'Mountain View', 'Menlo Park', 'Sunnyvale', 'Redwood City', 'San Mateo',
      'Cupertino', 'Santa Clara'],
    ['US', 'CA', 'Los Angeles', 'LA', 'Santa Monica', 'Pasadena', 'Culver City', 'El Segundo', 'Torrance', 'Hawthorne',
      'Long Beach', 'Burbank', 'Playa Vista'],
    ['US', 'MA', 'Boston', 'Cambridge', 'Somerville', 'Waltham'], ['US', 'WA', 'Seattle', 'Bellevue', 'Redmond', 'Kirkland'],
    ['US', 'TX', 'Austin'], ['US', 'TX', 'Houston'], ['US', 'TX', 'Dallas', 'Fort Worth', 'Plano', 'Irving'],
    ['US', 'FL', 'Miami', 'Miami Beach', 'Fort Lauderdale'], ['US', 'FL', 'Jupiter', 'West Palm Beach', 'Palm Beach'],
    ['US', 'DC', 'Washington DC', 'Washington D.C.', 'Arlington', 'Alexandria', 'Bethesda', 'McLean', 'Reston'],
    ['US', 'PA', 'Philadelphia'], ['US', 'PA', 'Pittsburgh'], ['US', 'GA', 'Atlanta'], ['US', 'CO', 'Denver', 'Boulder'],
    ['US', 'UT', 'Salt Lake City'], ['US', 'MN', 'Minneapolis', 'Saint Paul', 'St Paul'], ['US', 'NC', 'Charlotte'],
    ['US', 'NC', 'Raleigh', 'Durham', 'Chapel Hill'], ['US', 'AZ', 'Phoenix', 'Scottsdale', 'Tempe'],
    ['US', 'CA', 'San Diego'], ['US', 'NJ', 'Princeton'], ['US', 'MI', 'Detroit'], ['US', 'MD', 'Baltimore'],
    ['US', 'TN', 'Nashville'], ['US', 'OH', 'Columbus'], ['US', 'MO', 'St Louis', 'Saint Louis'],
    ['IE', '', 'Dublin'], ['IE', '', 'Cork'], ['FR', '', 'Paris', 'La Défense'], ['NL', '', 'Amsterdam'],
    ['DE', '', 'Berlin'], ['DE', '', 'Frankfurt', 'Frankfurt am Main'], ['DE', '', 'Munich', 'München'],
    ['DE', '', 'Hamburg'], ['CH', '', 'Zurich', 'Zürich'], ['CH', '', 'Geneva', 'Genève'], ['ES', '', 'Madrid'],
    ['ES', '', 'Barcelona'], ['IT', '', 'Milan', 'Milano'], ['IT', '', 'Rome'], ['SE', '', 'Stockholm'],
    ['DK', '', 'Copenhagen'], ['BE', '', 'Brussels'], ['PL', '', 'Warsaw'], ['AT', '', 'Vienna'], ['PT', '', 'Lisbon'],
    ['NO', '', 'Oslo'], ['FI', '', 'Helsinki'], ['CZ', '', 'Prague'], ['JP', '', 'Tokyo'], ['KR', '', 'Seoul'],
    ['CN', '', 'Shanghai'], ['CN', '', 'Beijing'], ['CN', '', 'Shenzhen'], ['AU', 'NSW', 'Sydney'],
    ['AU', 'VIC', 'Melbourne'], ['CA', 'ON', 'Toronto'], ['CA', 'QC', 'Montreal', 'Montréal'], ['CA', 'BC', 'Vancouver'],
    ['IN', '', 'Bangalore', 'Bengaluru'], ['IN', '', 'Mumbai'], ['IN', '', 'Hyderabad'], ['IN', '', 'Gurgaon', 'Gurugram'],
    ['IN', '', 'New Delhi', 'Delhi'], ['AE', '', 'Dubai'], ['AE', '', 'Abu Dhabi'], ['IL', '', 'Tel Aviv'],
    ['BR', '', 'São Paulo'],
  ];
  const UK_NATIONS = ['England', 'Scotland', 'Wales', 'Northern Ireland'];

  let placeIndex = null;
  /** [name, [place…]] for every city, metro area and region a sentence can name, longest name first. */
  function places() {
    if (placeIndex) return placeIndex;
    const byName = new Map();
    const add = (name, place) => byName.set(norm(name), [...(byName.get(norm(name)) || []), place]);
    for (const [country, region, ...names] of METROS)
      for (const n of names) add(n, { type: 'metro', country, region, metro: norm(names[0]) });
    for (const n of UK_NATIONS) add(n, { type: 'region', country: 'GB', region: n });
    for (const [country, table] of Object.entries(REGIONS))
      for (const [code, name] of table)
        if (!/^Armed Forces/.test(name)) add(name, { type: 'region', country, region: code });
    placeIndex = [...byName].sort((a, b) => b[0].length - a[0].length);
    return placeIndex;
  }

  /**
   * The places a sentence names, as { type: metro | region | country, country, region, metro }: "our London office"
   * (London's metro area), "based in Scotland" (a UK nation), "anywhere in the UK"; "Cambridge" both Cambridges. A
   * longer name wins: "New York" is never York, nor "Northern Ireland" Ireland.
   */
  function placesNamed(text) {
    let t = ' ' + norm(text) + ' ';
    const out = [];
    for (const [key, list] of places()) {
      if (!t.includes(' ' + key + ' ')) continue;
      out.push(...list);
      // Every time it's named: "New York, New York" is never York.
      for (let at = t.indexOf(' ' + key + ' '); at >= 0; at = t.indexOf(' ' + key + ' '))
        t = t.slice(0, at + 1) + ' '.repeat(key.length) + t.slice(at + 1 + key.length);
    }
    for (const country of countriesNamed(t)) out.push({ type: 'country', country });
    return out;
  }

  /** The countries a job's location names: "New York, NY" and "Remote - US" the US, "London" the UK. */
  function countriesIn(location) {
    const named = placesNamed(location);
    const out = new Set(named.map((p) => p.country));
    for (const part of String(location || '').split(/[,;/|()\n]|\s[-–—]\s/)) {
      const s = part.trim();
      const state = /^[A-Z]{2}$/.test(s) && REGIONS.US.some((r) => r[0] === s && !/^Armed Forces/.test(r[1]));
      const row = /^[A-Z]{2,3}$/.test(s) ? findCountry(s) : null;
      // "Chicago, IL" and "Indianapolis, IN" are US states; "Berlin, DE" and "Mumbai, IN" are countries.
      if (state && (out.has('US') || !row || !named.length)) out.add('US');
      else if (row) out.add(row[0]);
    }
    return [...out];
  }

  /** Where a profile's address is: { country, region, metro } (ISO code, UK nation or state code, metro area). */
  function whereIs(address) {
    const a = address || {};
    const row = findCountry(a.country);
    let country = row ? row[0] : '';
    const city = norm(a.city);
    // "Croydon" is in London's metro area; "Greenwich" in the UK is not the one in Connecticut.
    const fits = (p) => p.type === 'metro' && (!country || p.country === country);
    const named = city ? places().find(([key]) => key === city) : null;
    const metro = (named && named[1].find(fits)) || (city && placesNamed(a.city).find(fits)) || null;
    if (!country && metro) country = metro.country;
    const state = findRegion(a.state, a.country);
    const nation = UK_NATIONS.find((n) => norm(n) === norm(a.state));
    let region = metro ? metro.region : '';
    if (country === 'GB' && nation) region = nation;
    else if (state && REGIONS[country] && REGIONS[country].includes(state)) region = state[0];
    return { country, region, metro: metro ? metro.metro : '' };
  }

  /**
   * Is someone at `home` (whereIs) in `place` (placesNamed)? true, false, or null when it can't be told (a town that
   * isn't listed might still be in London's metro area; a UK address without a nation might be in Scotland).
   */
  function within(place, home) {
    if (!home || !home.country) return null;
    if (place.country === 'EU') return EUROPEAN.has(home.country);
    if (place.country !== home.country) return false;
    if (place.type === 'country') return true;
    if (place.type === 'region') return home.region ? home.region === place.region : null;
    return home.metro ? home.metro === place.metro : null;
  }

  /**
   * Where someone with the right to work in `countries` (ISO codes) may work: the EU / EEA and Switzerland's free
   * movement, and the UK and Ireland's Common Travel Area.
   */
  function workRights(countries) {
    const out = new Set();
    for (const c of countries || []) {
      out.add(c);
      if (EUROPEAN.has(c)) {
        for (const e of EUROPEAN) out.add(e);
        out.add('EU');
      }
      if (c === 'GB') out.add('IE');
      if (c === 'IE') out.add('GB');
    }
    return out;
  }

  const geo = {
    COUNTRIES,
    countriesNamed,
    nationalitiesNamed,
    visaCountries,
    placesNamed,
    countriesIn,
    whereIs,
    within,
    workRights,
    REGIONS,
    findCountry,
    countryCandidates,
    demonyms,
    citizenWords,
    findRegion,
    regionCandidates,
  };
  JTF.geo = geo;
  if (typeof module === 'object' && module.exports) module.exports = geo;
})(typeof globalThis !== 'undefined' ? globalThis : this);
