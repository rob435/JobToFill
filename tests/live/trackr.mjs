// Open programmes from Trackr's public tracker lists (api.the-trackr.com).

export const FORM_HOSTS = [
  'greenhouse',
  'grnh.se',
  'ashbyhq',
  'lever.co',
  'smartrecruiters',
  'workable',
  'pinpointhq',
  'teamtailor',
  'recruitee',
  'bamboohr',
  'breezy',
  'jobvite',
  'gem.com',
  'rippling',
  'personio',
  'apptrkr',
  'janestreet',
  'deshaw',
  'sig.com',
  'qube-rt',
  'hudsonrivertrading',
  'verition',
  'squarepoint',
  'brevanhoward',
  'revolut',
];

/** Open programmes on Trackr whose application is on a job board that can be read or filled. */
export async function trackrTargets({
  regions = ['UK', 'US'],
  industries = ['Finance', 'Tech', 'Law', 'Engineering'],
  hosts = FORM_HOSTS,
} = {}) {
  const types = [
    'summer-internships',
    'graduate-programmes',
    'off-cycle-internships',
    'spring-weeks',
    'placements',
    'vacation-schemes',
    'training-contracts',
  ];
  const now = new Date().toISOString();
  const out = [];
  for (const region of regions)
    for (const industry of industries)
      for (const type of types) {
        const url = `https://api.the-trackr.com/programmes?region=${region}&industry=${industry}&season=2027&type=${type}`;
        const json = await fetch(url, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        for (const p of (json && json.programmes) || []) {
          if (!p.url || (p.openingDate && p.openingDate > now) || (p.closingDate && p.closingDate < now)) continue;
          out.push({
            url: p.url,
            company: p.company && p.company.name,
            companyNotes: (p.company && p.company.description) || '',
            name: p.name,
            region,
            industry,
            type,
          });
        }
      }
  const seen = new Set();
  return out.filter((t) => {
    const key = t.url.replace(/[?#].*$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return hosts.some((h) => t.url.includes(h));
  });
}
