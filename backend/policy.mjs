export const DEALERSHIP = {
  address: '3490 Valley Blvd, San Gabriel, CA',
  hours: 'We open every day from 10 - 6pm.',
  warranty: 'We may offer an optional three-month dealership warranty for $700 covering the engine, transmission, and battery. Our sales manager can confirm whether it’s available for this vehicle and explain the coverage.',
  cashDiscount: 200,
  otdZip: '91731',
  otdTaxRate: 0.10,
  otdTitleFee: 50,
  otdRegistrationFee: 200,
  financeThreshold: 8000,
};

const roundMoney = value => Math.round(value * 100) / 100;
const money = value => Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 })
  : null;
const miles = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : null;
const dateLabel = value => {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null;
};

export function estimateOutTheDoor({ price, cashDiscount = 0, zip = DEALERSHIP.otdZip } = {}) {
  if (zip !== DEALERSHIP.otdZip || price === null || price === undefined || price === '' || !Number.isFinite(Number(price)) || Number(price) < 0) return null;
  const vehiclePrice = roundMoney(Number(price));
  const discount = roundMoney(Math.min(vehiclePrice, Math.max(0, Number(cashDiscount) || 0)));
  const discountedPrice = roundMoney(vehiclePrice - discount);
  const tax = roundMoney(discountedPrice * DEALERSHIP.otdTaxRate);
  const total = roundMoney(discountedPrice + tax + DEALERSHIP.otdTitleFee + DEALERSHIP.otdRegistrationFee);
  return {
    zip,
    vehicle_price: vehiclePrice,
    cash_discount: discount,
    discounted_price: discountedPrice,
    tax,
    title: DEALERSHIP.otdTitleFee,
    registration: DEALERSHIP.otdRegistrationFee,
    total,
    test_only: true,
    disclaimer: 'Test estimate only. Final rates and fees must be confirmed by sales.',
  };
}

function mileageReply(facts, testMode) {
  const notes = [];
  if (facts.mileage_conflict) {
    notes.push('Mileage records conflict or need verification.');
    return { text: 'The mileage records need verification; our team can check the odometer before your visit.', notes };
  }
  const source = facts.mileage_source?.trim();
  const reading = source?.toUpperCase() === 'CARFAX' ? 'The last mileage reported on CARFAX' : 'The mileage on record';
  if (testMode && facts.test_current_mileage !== null && facts.test_current_mileage !== undefined && Number.isFinite(Number(facts.test_current_mileage))) {
    const current = Number(facts.test_current_mileage);
    const parts = [`The current mileage on file is ${miles(current)} miles.`];
    if (facts.mileage !== null && facts.mileage !== undefined && Number.isFinite(Number(facts.mileage))) {
      const reported = dateLabel(facts.mileage_reported_at);
      parts.push(`${reading} was ${miles(facts.mileage)} miles${reported ? ` as of ${reported}` : ''}.`);
    }
    notes.push(`Test-only current mileage used (${miles(current)}). Recorded mileage remains ${facts.mileage !== null && facts.mileage !== undefined && Number.isFinite(Number(facts.mileage)) ? `${miles(facts.mileage)} miles${dateLabel(facts.mileage_reported_at) ? ` as of ${dateLabel(facts.mileage_reported_at)}` : ''}` : 'not available'}. Do not send this draft outside the test environment.`);
    notes.push('Staff must confirm the current odometer before a customer relies on it.');
    return { text: parts.join(' '), notes };
  }
  if (facts.mileage !== null && facts.mileage !== undefined && Number.isFinite(Number(facts.mileage))) {
    const reported = dateLabel(facts.mileage_reported_at);
    notes.push(`Mileage source: ${source || 'unknown'}${reported ? `; reading date ${reported}` : '; reading date not reported'}.`);
    notes.push('Staff must confirm the current odometer; the recorded mileage may have changed.');
    return {
      text: reported
        ? `${reading} was ${miles(facts.mileage)} miles as of ${reported}. Our team can confirm the current reading before your visit.`
        : `${reading} was ${miles(facts.mileage)} miles; the reading date is not reported. Our team can confirm the current reading before your visit.`,
      notes,
    };
  }
  notes.push('No verified mileage reading is on file.');
  return { text: 'I don’t have a verified current mileage reading; our team can check the odometer before your visit.', notes };
}

function availabilityReply(facts) {
  const status = facts.availability;
  if (status === 'available') return 'It is currently listed as available; our team can confirm before your visit.';
  if (status === 'sold') return 'It is currently marked as sold; our team can help you find a similar vehicle.';
  if (status === 'pending' || status === 'reserved') return `It is currently marked as ${status}; our team can confirm availability before your visit.`;
  return 'I’ll check availability for you before you make the trip.';
}

function accidentAndTitleReply(facts) {
  const parts = [];
  const notes = [];
  if (facts.report_available) {
    parts.push('I can have our team send you the CARFAX report on file.');
    if (facts.accident_count !== null && facts.accident_count !== undefined && Number.isFinite(Number(facts.accident_count))) {
      if (Number(facts.accident_count) === 0) {
        parts.push('The CARFAX report does not report any accidents.');
      } else {
        const summary = facts.accident_summary || `${miles(facts.accident_count)} reported accident/damage event${Number(facts.accident_count) === 1 ? '' : 's'}`;
        parts.push(`The CARFAX report shows: ${summary}.`);
      }
    } else {
      parts.push('Our team can review the accident history in the CARFAX report with you.');
      notes.push('Accident count is not structured; review the report before making a claim.');
    }
    notes.push('Accident history is based on the CARFAX report on file; do not claim independently verified history.');
  } else {
    parts.push('We don’t have a CARFAX report on file; our team can check the vehicle history.');
    notes.push('No CARFAX report on file; do not claim accident-free or clean-title status.');
  }
  if (facts.title_status) {
    if (/no title problems|no problem|clean/i.test(facts.title_status)) {
      parts.push(facts.report_available ? 'The CARFAX report shows no title problems.' : `Our title records show: ${facts.title_status}.`);
    } else parts.push(`The title record shows: ${facts.title_status}. Our team can review it with you.`);
  } else {
    parts.push('I can’t verify the title status from our records; our team can check it.');
  }
  notes.push('Title status is separate from accident history; review both before replying.');
  return { text: parts.join(' '), notes };
}

function financingReply(facts, question) {
  const price = facts.price_usd === null || facts.price_usd === undefined || facts.price_usd === '' ? null : Number(facts.price_usd);
  const downMatch = question.match(/\$?\s*([\d,]+)\s*(?:down|down payment)/i);
  const down = downMatch ? Number(downMatch[1].replaceAll(',', '')) : null;
  const notes = ['Do not promise approval, a specific APR, term, lease or monthly payment.'];
  if (!Number.isFinite(price)) return { text: 'Our sales team can review financing options with you; please visit so they can explain what may be available.', notes };
  if (price < DEALERSHIP.financeThreshold) {
    return { text: 'We generally recommend paying in full, but our sales team can review financing options with you.', notes };
  }
  return {
    text: `We offer financing. Please visit so our sales team can review ${down === null ? 'your down payment options' : `what ${money(down)} down could look like`} and, with your permission, check your credit. We may have options for buyers with low credit or no SSN, subject to lender requirements and approval.`,
    notes,
  };
}

function tradeInReply(question) {
  const trade = /\baccord\b/i.test(question) ? 'your Accord' : 'your vehicle';
  return `Yes, we take trade-ins. Please bring ${trade} to our dealership so we can take a look and give you an estimate.`;
}

function hybridBatteryReply(facts, question) {
  const notes = [];
  if (facts.inspection_conflict) {
    notes.push('Inspection and CARFAX records conflict; sales must review.');
    return { text: 'The inspection and CARFAX records conflict on the hybrid battery; our sales team should review this before we answer.', notes };
  }
  if (facts.hybrid_battery_status === 'inspected_good') {
    const text = ['Our mechanic recently inspected the hybrid battery and noted it was in good condition.'];
    if (/\breplaced\b/i.test(question)) text.push('I don’t see a battery replacement record; our team can confirm.');
    notes.push('Hybrid battery statement must be backed by the inspection record; verify before sending.');
    return { text: text.join(' '), notes };
  }
  if (facts.hybrid_battery_status === 'replaced') {
    notes.push('Replacement record required before making this claim.');
    return { text: 'Our records show the hybrid battery was replaced. Our team can review the service record with you.', notes };
  }
  if (facts.hybrid_battery_status === 'needs_attention') {
    notes.push('Hybrid battery needs attention; sales review required.');
    return { text: 'The hybrid battery needs attention; our sales team can review the details with you before a visit.', notes };
  }
  notes.push('No verified hybrid battery inspection or replacement record on file.');
  return { text: 'I don’t have a verified hybrid battery inspection or replacement record; our team can check it before you visit.', notes };
}

function smogAcReply(facts, asksSmog, asksAc) {
  const parts = [];
  const notes = [];
  if (facts.inspection_conflict) {
    return { text: 'The inspection records conflict. Our team will need to verify the inspection results before answering.',
      notes: ['Resolve the conflicting inspection records before making a claim.'] };
  }
  if (asksSmog) {
    if (facts.smog_status === 'passed') parts.push('The vehicle passed smog.');
    else if (facts.smog_status === 'not_passed') { parts.push('The smog check is not passed; our sales team can review it with you.'); notes.push('Smog not passed; sales review required.'); }
    else { parts.push('I don’t have a verified smog record; our team can confirm before you visit.'); notes.push('Smog status is not verified.'); }
    parts.push('If a $100 smog arrangement applies, our sales team can confirm what it covers before quoting it.');
    notes.push('Sales must confirm the $100 smog arrangement coverage before quoting.');
  }
  if (asksAc) {
    if (facts.ac_status === 'works') parts.push('The A/C blows cold.');
    else if (facts.ac_status === 'not_working') { parts.push('The A/C needs attention; our team can review it with you.'); notes.push('A/C issue recorded; sales review required.'); }
    else { parts.push('I don’t have a verified A/C record; our team can confirm it before you visit.'); notes.push('A/C status is not verified.'); }
  }
  return { text: parts.join(' '), notes };
}

function locationTestDriveReply(asksLocation, asksTestDrive, proposedTime) {
  const parts = [];
  if (asksLocation) parts.push(`We’re at ${DEALERSHIP.address}.`);
  if (asksTestDrive && proposedTime) parts.push(`I’ll ask our team to check ${proposedTime} and confirm the appointment with you.`);
  else if (asksTestDrive) parts.push('Let me know what time works for you, and our sales team can confirm the appointment.');
  parts.push(DEALERSHIP.hours);
  return parts.join(' ');
}

function bestPriceReply(cash) {
  const parts = ['There may be a little room on price. Come take a look at the car, and I’ll definitely give you my best price.'];
  if (cash) parts.push(`If you pay cash, we can offer ${money(DEALERSHIP.cashDiscount)} off. Anything beyond that would need sales approval.`);
  else parts.push('Any discount beyond the approved cash offer goes to our sales team.');
  return parts.join(' ');
}

const otdTopic = /out[- ]?the[- ]?door|\botd\b|total (?:price|cost)|after[- ]tax(?:es)?\b|\b(?:with|including|plus|before and after) (?:sales )?tax(?:es)?\b|\btax(?:es)? and fees\b|\bhow much (?:is|are|would) (?:the )?(?:sales )?tax(?:es)?\b|^\s*(?:sales )?tax(?:es)?[?.!\s]*$|estimated total|落地价/i;
const listedPriceTopic = /\bprice\b|\bhow much (?:is|for) (?:it|this|the car)\b|\b(?:what|how much) (?:does|would|will) (?:it|this(?: (?:car|vehicle))?|the (?:car|vehicle)) cost\b(?!\s+(?:to|per))|\bwhat(?:['’]s| is) the (?:asking\b|cost\b(?!\s+(?:of|to|for)))|\b(?:what|how much) are you asking(?:\s+for\s+(?:it|this|the car))?\s*(?:[?.!,]|$)|^\s*(?:asking|cost)\s*[?.!]*\s*$/i;
const visitTopic = /test[- ]?drive|come in|visit|appointment|试驾/i;
const slotPattern = /\b(?:(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tomorrow)(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)?\b|\b(?:at\s+\d{1,2}(?::\d{2})?(?:\s*[ap]m)?|\d{1,2}(?::\d{2})?\s*[ap]m)\b/i;

function cashPreference(text) {
  if (/\b(?:no|not|without|instead of|rather than|can't|cannot|won't|don['’]t)\s+(?:(?:be|pay|paying|use|using|have|in|with|any)\s+)*cash\b|不(?:付|用)?现金/i.test(text)) return false;
  if (/\bcash\s+(?:is(?:n['’]t| not)|won['’]t|is off)|\b(?:pay(?:ing)? by card|financ(?:e|ing))\s+(?:instead|rather)|不是现金|不用现金/i.test(text)) return false;
  if (/\bcash\b|现金/i.test(text)) return true;
  if (/\b(?:financing|finance it|pay by card)\b/i.test(text)) return false;
  return undefined;
}

function quoteZip(text) {
  return text.match(/\b(?:zip(?:\s*code)?\s*(?:is\s+|[:#]\s*)?|(?:for|in|to|otd))\s*(\d{5})\b/i)?.[1]
    ?? text.match(/^\s*(\d{5})(?:[?!.,\s]|$)/)?.[1];
}

function otdReply(facts, cash, zip) {
  if (zip !== DEALERSHIP.otdZip) return {
    text: `Our sales team will need to verify taxes and fees for ZIP ${zip} before quoting an out-the-door total.`,
    notes: [`No approved estimate for ZIP ${zip}.`],
  };
  const notes = ['Test-only estimate; this is not a binding quote. Sales must confirm final rates and fees.'];
  const price = facts.price_usd === null || facts.price_usd === undefined || facts.price_usd === '' ? null : Number(facts.price_usd);
  if (!Number.isFinite(price)) {
    return { text: 'I’ll have our sales team prepare an itemized out-the-door estimate for ZIP 91731; final rates and fees must be confirmed.', notes };
  }
  const estimate = estimateOutTheDoor({ price, cashDiscount: cash ? DEALERSHIP.cashDiscount : 0, zip });
  const lines = [
    `For ZIP ${estimate.zip}, this is a test estimate:`,
    `Vehicle price: ${money(estimate.vehicle_price)}`,
  ];
  if (estimate.cash_discount) lines.push(`Cash discount: -${money(estimate.cash_discount)}`, `Discounted vehicle price: ${money(estimate.discounted_price)}`);
  lines.push(
    `Estimated tax (10%): ${money(estimate.tax)}`,
    `Title: ${money(estimate.title)}`,
    `Registration: ${money(estimate.registration)}`,
    `Estimated out-the-door total: ${money(estimate.total)}`,
    'This is a test estimate only. Final rates and fees must be confirmed by our sales team.',
  );
  return { text: lines.join('\n'), notes, estimate };
}

export function policyReply({ vehicleFacts = {}, question = '', history = [], testMode = process.env.DEALER_AI_TEST_MODE === '1' } = {}) {
  const q = String(question || '').trim().toLowerCase();
  if (!q.trim()) return null;
  const facts = vehicleFacts || {};
  const draft = [];
  const notes = [];
  const intents = [];
  const adds = value => { if (value && !draft.includes(value)) draft.push(value); };
  const addNotes = values => { for (const note of values || []) if (note && !notes.includes(note)) notes.push(note); };

  const recent = history.slice(-8).toReversed();
  const buyers = recent.filter(turn => turn.direction === 'inbound').map(turn => turn.body);
  const followUp = /^(?:what about|how about|and\b|what if|instead\b|那)|^(?:if I (?:pay|use) cash|cash|现金)[?.!\s]*$/i.test(q) || /^\s*\d{5}\s*[?.!]?\s*$/.test(q);
  const previousTopic = recent.find(turn => otdTopic.test(turn.body) || listedPriceTopic.test(turn.body) || visitTopic.test(turn.body));
  const explicitCash = cashPreference(q);
  const cash = explicitCash ?? (followUp && buyers.map(cashPreference).find(value => value !== undefined)) ?? false;
  const zip = quoteZip(q) ?? ((followUp || otdTopic.test(q)) ? buyers.map(quoteZip).find(Boolean) : undefined) ?? DEALERSHIP.otdZip;
  const asksOtd = otdTopic.test(q) || /\b91731\b/.test(q) || (followUp && otdTopic.test(previousTopic?.body || ''));
  if (asksOtd) {
    intents.push('out_the_door');
    const result = otdReply(facts, cash, zip);
    adds(result.text); addNotes(result.notes);
  }
  const asksRegistration = /registration/i.test(q) && /(own|myself|handle|self)/i.test(q);
  const asksFinancing = /(financ|loan|credit|down payment|apr|monthly payment)/i.test(q);
  const asksTrade = /trade[- ]?in/i.test(q);
  const asksHybrid = /hybrid battery/i.test(q);
  const asksSmog = /smog/i.test(q);
  const asksAc = /(a\/c|air condition|air conditioning)/i.test(q);
  const asksWarranty = /warranty/i.test(q);
  const asksLocation = /(where|located|location|address)/i.test(q);
  const time = question.match(slotPattern)?.[0];
  const asksTestDrive = visitTopic.test(q) || (time && visitTopic.test(previousTopic?.body || ''));
  const proposedTime = time || (followUp && asksTestDrive ? buyers.map(text => text.match(slotPattern)?.[0]).find(Boolean) : null);
  const asksBestPrice = /\b(?:best price|negotiable|discounts?|deal)\b/i.test(q) || (cash && followUp && !asksOtd);
  if (!asksOtd && !asksBestPrice && listedPriceTopic.test(q)) {
    intents.push('listed_price');
    adds(Number.isFinite(facts.price_usd) ? `The listed price is ${money(facts.price_usd)} before taxes and fees.` : 'Our team will confirm the listed price.');
  }

  if (asksRegistration) {
    intents.push('registration');
    adds('Our dealership normally handles title and registration. I can ask my manager whether there’s any flexibility for your purchase.');
  }
  if (asksFinancing) {
    intents.push('financing');
    const result = financingReply(facts, q);
    adds(result.text); addNotes(result.notes);
  }
  if (asksTrade) {
    intents.push('trade_in');
    adds(tradeInReply(q));
  }
  if (asksHybrid) {
    intents.push('hybrid_battery');
    const result = hybridBatteryReply(facts, q);
    adds(result.text); addNotes(result.notes);
  }
  if (asksSmog || asksAc) {
    intents.push('smog_ac');
    const result = smogAcReply(facts, asksSmog, asksAc);
    adds(result.text); addNotes(result.notes);
  }
  if (asksWarranty) {
    intents.push('warranty');
    adds(DEALERSHIP.warranty);
    addNotes(['Sales manager must confirm warranty availability and coverage before it is promised.']);
  }
  if (asksTestDrive && facts.availability === 'sold') {
    intents.push('availability');
    adds(availabilityReply(facts));
    addNotes(['This vehicle is sold. Do not offer a test drive for it.']);
    if (asksLocation) adds(locationTestDriveReply(true, false));
  } else if (asksLocation || asksTestDrive) {
    intents.push('location_test_drive');
    adds(locationTestDriveReply(asksLocation, asksTestDrive, proposedTime));
    addNotes(['Sales must confirm the appointment time; do not mark a test drive as booked.']);
  }
  if (asksBestPrice && !asksOtd) {
    intents.push('best_price');
    adds(bestPriceReply(cash));
    if (cash && Number.isFinite(facts.price_usd)) {
      const quote = estimateOutTheDoor({ price: facts.price_usd, cashDiscount: DEALERSHIP.cashDiscount });
      adds(`The discounted vehicle price is ${money(quote.discounted_price)} before taxes and fees.`);
    }
    addNotes(['Only the approved $200 cash offer may be offered in a draft; anything beyond goes to sales.']);
  }

  const asksAvailability = /(still available|available|in stock|still have|still there)/i.test(q);
  if (asksAvailability) {
    intents.push('availability');
    adds(availabilityReply(facts));
    addNotes(['Staff must verify current availability before the customer travels.']);
  }

  const asksVin = /\bvin\b/i.test(q);
  const asksMiles = /(mile|miles|mileage|odometer)/i.test(q);
  if (asksVin || asksMiles) {
    intents.push('vin_mileage');
    if (asksVin) adds(facts.vin ? `The VIN on file is ${facts.vin}.` : 'I don’t have a VIN on file; our team can confirm it.');
    if (asksMiles) {
      const result = mileageReply(facts, testMode);
      adds(result.text); addNotes(result.notes);
    }
  }

  const asksHistory = /(carfax|accident|damage|title|history|clean title)/i.test(q);
  if (asksHistory) {
    intents.push('history_title');
    const result = accidentAndTitleReply(facts);
    adds(result.text); addNotes(result.notes);
  }

  if (!intents.length) return null;
  addNotes(['Review this draft before sending.']);
  return {
    draft: draft.join('\n\n').slice(0, 4000),
    verification_notes: notes,
    provider: 'policy',
    model: 'dealership-policy',
    intents,
  };
}
