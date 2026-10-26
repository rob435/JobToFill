'use strict';
// jobpage.test.js again, with addresses as a Firefox content script sees them. lib/jobpage.js runs in the page too
// (the job context Quick apply and the studio read), where a URL is the page's, seen through an Xray: its
// searchParams answer get(), has(), set() and delete(), but the iterators keys(), values() and entries() return have
// no Symbol.iterator. Quick apply on career2.successfactors.eu/portalcareer?_s.crb=… stopped at "qp.keys() is not
// iterable". Every address must read the same there.
const P = URLSearchParams.prototype;
for (const key of ['keys', 'values', 'entries', Symbol.iterator]) {
  const own = P[key];
  Object.defineProperty(P, key, {
    configurable: true,
    writable: true,
    value() {
      const it = own.call(this);
      return { next: () => it.next() };
    },
  });
}
require('./jobpage.test.js');
