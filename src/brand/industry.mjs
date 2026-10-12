// What field a brand is in (dentistry, health, carpet cleaning, education ...), worked out from the words it uses about itself, and what that means for the
// rules Claude must check. Detection is plain keyword counting, never a guess dressed up as fact: it names the words it found, says how sure it is, and the
// owner can always type their own field. The owner can also write the rules that apply ("Australian health advertising rules", "no medical claims"); Claude
// is told to look up and follow the rules for this field where the business operates, and to say so when it cannot confirm one.

/** id, label, words that point to it (matched as whole words or word starts), and whether advertising in this field is commonly rule-bound. */
export const INDUSTRIES = [
  { id: 'dentistry', label: 'Dentistry', regulated: true, words: ['dentist', 'dentists', 'dental', 'orthodontic', 'orthodontist', 'invisalign', 'implants', 'hygienist', 'teeth', 'tooth', 'smile', 'oral health', 'periodontal', 'veneers'] },
  { id: 'health', label: 'Health and medical', regulated: true, words: ['clinic', 'medical', 'doctor', 'gp', 'physio', 'physiotherapy', 'chiropractor', 'chiropractic', 'osteopath', 'podiatrist', 'psychologist', 'counselling', 'therapy', 'patients', 'allied health', 'optometrist', 'dietitian', 'naturopath', 'acupuncture', 'wellbeing', 'health'] },
  { id: 'beauty', label: 'Beauty and aesthetics', regulated: true, words: ['beauty', 'salon', 'skin', 'skincare', 'facial', 'cosmetic injectables', 'anti-wrinkle', 'laser', 'lashes', 'brows', 'nails', 'hair', 'barber', 'spa', 'massage', 'makeup'] },
  { id: 'fitness', label: 'Fitness and sport', regulated: false, words: ['gym', 'fitness', 'personal trainer', 'pilates', 'yoga', 'crossfit', 'training', 'workout', 'sport', 'athlete', 'club', 'coaching'] },
  { id: 'food', label: 'Food and hospitality', regulated: false, words: ['cafe', 'café', 'coffee', 'restaurant', 'bakery', 'menu', 'chef', 'catering', 'bar', 'brewery', 'pub', 'kitchen', 'dining', 'takeaway', 'brunch', 'pizza'] },
  { id: 'cleaning', label: 'Cleaning services', regulated: false, words: ['cleaning', 'cleaner', 'cleaners', 'carpet cleaning', 'carpet', 'upholstery', 'steam clean', 'pressure washing', 'window cleaning', 'pest control', 'end of lease', 'janitorial', 'stain'] },
  { id: 'trades', label: 'Trades and building', regulated: false, words: ['plumber', 'plumbing', 'electrician', 'electrical', 'builder', 'building', 'renovation', 'carpenter', 'roofing', 'landscaping', 'painter', 'concreting', 'handyman', 'air conditioning', 'hvac', 'construction'] },
  { id: 'education', label: 'Education and training', regulated: false, words: ['school', 'students', 'student', 'teacher', 'teaching', 'tutoring', 'tutor', 'university', 'college', 'course', 'courses', 'learning', 'education', 'curriculum', 'enrol', 'enrolment', 'kindergarten', 'childcare', 'academy', 'workshop'] },
  { id: 'real-estate', label: 'Real estate', regulated: true, words: ['real estate', 'property', 'properties', 'agent', 'auction', 'listing', 'rental', 'tenant', 'landlord', 'house for sale', 'open for inspection', 'conveyancing'] },
  { id: 'legal', label: 'Legal services', regulated: true, words: ['lawyer', 'lawyers', 'solicitor', 'barrister', 'legal', 'law firm', 'litigation', 'conveyancer', 'family law', 'estate planning', 'wills'] },
  { id: 'finance', label: 'Finance and accounting', regulated: true, words: ['accountant', 'accounting', 'bookkeeping', 'tax', 'mortgage', 'broker', 'financial adviser', 'financial planning', 'superannuation', 'insurance', 'loan', 'loans', 'invest', 'investment', 'wealth'] },
  { id: 'retail', label: 'Retail and e-commerce', regulated: false, words: ['shop', 'store', 'shopping', 'cart', 'checkout', 'free shipping', 'collection', 'boutique', 'products', 'online store', 'new arrivals', 'gift'] },
  { id: 'automotive', label: 'Automotive', regulated: false, words: ['car', 'cars', 'mechanic', 'automotive', 'dealership', 'tyres', 'panel beating', 'roadworthy', 'servicing', 'motorbike', 'vehicle'] },
  { id: 'events', label: 'Events and entertainment', regulated: false, words: ['event', 'events', 'festival', 'airshow', 'concert', 'tickets', 'venue', 'expo', 'conference', 'wedding venue', 'lan', 'tournament', 'volunteers'] },
  { id: 'weddings', label: 'Weddings and photography', regulated: false, words: ['wedding', 'weddings', 'photographer', 'photography', 'videographer', 'videography', 'bridal', 'elopement', 'portrait', 'celebrant'] },
  { id: 'creative', label: 'Creative and marketing', regulated: false, words: ['marketing', 'agency', 'branding', 'design', 'designer', 'social media', 'creative', 'studio', 'content', 'advertising', 'web design', 'video production'] },
  { id: 'technology', label: 'Technology and software', regulated: false, words: ['software', 'app', 'saas', 'platform', 'api', 'developer', 'cloud', 'cybersecurity', 'it support', 'technology', 'startup', 'ai'] },
  { id: 'nonprofit', label: 'Charity and community', regulated: false, words: ['charity', 'nonprofit', 'not-for-profit', 'donate', 'donation', 'volunteer', 'community group', 'fundraising', 'foundation', 'council'] },
  { id: 'pets', label: 'Pets and animals', regulated: true, words: ['vet', 'veterinary', 'veterinarian', 'pet', 'pets', 'dog', 'dogs', 'cat', 'grooming', 'animal', 'kennel', 'puppy'] },
  { id: 'travel', label: 'Travel and tourism', regulated: false, words: ['travel', 'tours', 'tour', 'holiday', 'accommodation', 'resort', 'hotel', 'tourism', 'bookings', 'getaway', 'cruise'] },
];

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = new Map(INDUSTRIES.flatMap((i) => i.words.map((w) => [w, new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'giu')])));

/**
 * @param {Array<{ text: string, weight?: number }>} sources  pieces of the brand's own words, each with how much it counts (a title counts more than body text)
 * @returns {{ best: null | { id: string, label: string, regulated: boolean, evidence: string[], score: number }, alternatives: Array<{ id: string, label: string, score: number }>, confidence: 'high' | 'medium' | 'low' | 'none' }}
 */
export function detectIndustry(sources) {
  const scored = INDUSTRIES.map((ind) => {
    let score = 0;
    const found = new Map();
    for (const { text, weight = 1 } of sources) {
      const t = String(text ?? '').slice(0, 40_000);
      if (!t.trim()) continue;
      for (const w of ind.words) {
        const re = wordRe.get(w);
        re.lastIndex = 0;
        const n = (t.match(re) ?? []).length;
        if (!n) continue;
        // a word counts for its first two mentions only, so a field is decided by how many different telling words appear, not by one word repeated; a phrase is a stronger sign
        const per = (w.includes(' ') ? 3 : 1) * weight;
        score += per * Math.min(n, 2);
        found.set(w, (found.get(w) ?? 0) + n);
      }
    }
    return { ind, score, evidence: [...found].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { best: null, alternatives: [], confidence: 'none' };
  const [top, second] = scored;
  const gap = second ? top.score / second.score : Infinity;
  const confidence = top.score >= 12 && gap >= 1.6 ? 'high' : top.score >= 5 && gap >= 1.2 ? 'medium' : 'low';
  return {
    best: { id: top.ind.id, label: top.ind.label, regulated: top.ind.regulated, evidence: top.evidence, score: Math.round(top.score) },
    alternatives: scored.slice(1, 4).map((x) => ({ id: x.ind.id, label: x.ind.label, score: Math.round(x.score) })),
    confidence,
  };
}

/** The known industry for an id (or null), so a custom label is kept as the owner typed it. */
export const industryById = (id) => INDUSTRIES.find((i) => i.id === id) ?? null;

/** Make an owner's input into the brand's `industry` object (or null to clear it). */
export function cleanIndustry(input) {
  if (input === null) return null;
  const label = String(input?.label ?? '').trim().slice(0, 80);
  const rules = String(input?.rules ?? '').trim().slice(0, 1200);
  if (!label && !rules) return null;
  const known = INDUSTRIES.find((i) => i.id === input?.id) ?? INDUSTRIES.find((i) => i.label.toLowerCase() === label.toLowerCase()) ?? null;
  const out = { ...(known ? { id: known.id } : {}), label: label || known?.label || 'Other' };
  const regulated = typeof input?.regulated === 'boolean' ? input.regulated : known?.regulated;
  if (typeof regulated === 'boolean') out.regulated = regulated;
  if (rules) out.rules = rules;
  return out;
}

/** The sentence(s) that tell Claude what field this is and to check its rules, for prompts. Empty when no field is set. */
export function industryRules(brand) {
  const ind = brand?.industry;
  if (!ind?.label) return [];
  const lines = [`This brand is in the field of: ${ind.label}.${ind.regulated ? ' Advertising in this field is commonly rule-bound.' : ''}`];
  if (ind.rules) lines.push(`The owner says these rules apply: ${ind.rules}`);
  lines.push(`Before you plan or write anything, work out the advertising and content rules that apply to ${ind.label.toLowerCase()} where the business operates (use its address and timezone in facts.json and brand.json to know the country and state), and follow them. Write the rules you are relying on at the top of your notes. If you cannot confirm a rule, say so and ask the owner; never assume one exists or does not.`);
  return lines;
}
